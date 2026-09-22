/**
 * OpenMAIC → Kafuo integration client (Kafuo R1 contracts §2; plan §8.6, P5).
 *
 * Three signed calls under `KAFUO_INTEGRATION_BASE_URL` (the router prefix,
 * e.g. `https://api.kafuo.example/api/v2/integrations/teaching-engine`):
 * `POST /meters/reserve`, `POST /meters/finalize`, `POST /grounding/search`.
 *
 * Auth is the webhook scheme in the other direction — the SAME secret
 * (`TEACHING_ENGINE_WEBHOOK_SECRET` = Kafuo `teaching_engine_webhook_secret`)
 * and the SAME headers, `X-Teaching-Engine-Signature: v1=<hex hmac-sha256(secret,
 * "<timestamp>.<raw body>")>` and `X-Teaching-Engine-Timestamp: <unix seconds>`,
 * so `signWebhookDelivery` is reused rather than re-implemented; Kafuo verifies
 * both with one dependency (`verify_teaching_engine_signature`).
 *
 * Failure vocabulary the callers key on:
 *  - `KafuoUnreachableError` — network error, timeout, or a 5xx: the turn path
 *    answers `METER_UNAVAILABLE` (no model call is made, §8.6), the outbox
 *    sweeper backs off. Retryable.
 *  - `KafuoIntegrationError` — a definitive 4xx (`student_ref_unknown`,
 *    `offering_not_permitted`, a contract refusal): not retryable unchanged.
 *  - `finalize` never throws for `409`/`404`: those are outcomes the outbox
 *    records (`conflict` / `terminal_failed`), not transport failures.
 *
 * The `fetch` implementation is injectable so tests assert the exact bytes
 * signed and answer canned statuses without a network.
 */
import {
  signWebhookDelivery,
  WEBHOOK_EVENT_HEADERS,
} from '@/lib/server/teaching-package/webhook-delivery';
import type { FinalizePayload } from '@/lib/persistence/meter-finalize-outbox';

export const DEFAULT_KAFUO_INTEGRATION_TIMEOUT_MS = 10_000;

/** `KAFUO_INTEGRATION_BASE_URL`, trimmed, without a trailing slash; '' when unset. */
export function kafuoIntegrationBaseUrl(): string {
  return (process.env.KAFUO_INTEGRATION_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

export function kafuoIntegrationTimeoutMs(): number {
  const raw = Number(process.env.KAFUO_INTEGRATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_KAFUO_INTEGRATION_TIMEOUT_MS;
}

function integrationSecret(): string {
  return (process.env.TEACHING_ENGINE_WEBHOOK_SECRET ?? '').trim();
}

/** Both the base URL and the shared secret are set. */
export function isKafuoIntegrationConfigured(): boolean {
  return kafuoIntegrationBaseUrl() !== '' && integrationSecret() !== '';
}

// ---------------------------------------------------------------------------
// Wire shapes (contracts §2)
// ---------------------------------------------------------------------------

export type MeterCapability = 'free_chat' | 'help';

export type MeterScope =
  | { conversationId: string }
  | { helpSessionId: string; lessonId: string | null };

export interface MeterReserveRequest {
  tenantId: string;
  studentRef: string;
  capability: MeterCapability;
  meterScope: MeterScope;
  turnId: string;
  turnAttempt: number;
  clientMessageId: string;
}

export interface MeterAllowanceStatus {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export type MeterRefusalReason =
  | 'help_allowance_exhausted'
  | 'tutor_allowance_exhausted'
  | 'feature_not_in_package'
  | 'temporarily_unavailable';

export type MeterReserveDecision =
  | { allowed: true; reservationId: string; replay: boolean; status: MeterAllowanceStatus | null }
  | {
      allowed: false;
      reason: MeterRefusalReason;
      window: string | null;
      resetAt: string | null;
      replay: boolean;
    };

export type MeterFinalizeRequest = FinalizePayload;

export type MeterFinalizeResult = { status: 'delivered' | 'conflict' | 'not_found' };

export interface GroundingSearchRequest {
  tenantId: string;
  studentRef: string;
  subjectOfferingId: string;
  query: string;
  maxChars: number;
  preferredContentUnitIds?: string[];
}

export interface GroundingUnit {
  contentUnitId: string;
  lessonId: string;
  lessonTitle: string;
  unitTitle: string;
  text: string;
  charLength: number;
  score: number;
}

export interface GroundingSearchResponse {
  units: GroundingUnit[];
  lessonMatch: { lessonId: string; lessonTitle: string; confidence: number } | null;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Transport-level failure (network, timeout, 5xx): retryable. */
export class KafuoUnreachableError extends Error {
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(message: string, options: { status?: number | null; cause?: unknown } = {}) {
    super(message);
    this.name = 'KafuoUnreachableError';
    this.status = options.status ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** A definitive refusal from Kafuo (4xx with an error envelope): not retryable unchanged. */
export class KafuoIntegrationError extends Error {
  readonly status: number;
  /** Kafuo's `error.code` when the body carried one (`student_ref_unknown`, …). */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'KafuoIntegrationError';
    this.status = status;
    this.code = code;
  }
}

export function isKafuoUnreachableError(error: unknown): error is KafuoUnreachableError {
  return (
    error instanceof KafuoUnreachableError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'KafuoUnreachableError')
  );
}

/** A client-side configuration gap (no base URL / secret): surfaced as unreachable. */
function notConfigured(): KafuoUnreachableError {
  return new KafuoUnreachableError(
    'Kafuo integration is not configured (KAFUO_INTEGRATION_BASE_URL / TEACHING_ENGINE_WEBHOOK_SECRET)',
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface KafuoIntegrationClientOptions {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Epoch ms clock (tests pin the signed timestamp). */
  now?: () => number;
}

interface RawResponse {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

export class KafuoIntegrationClient {
  private readonly options: KafuoIntegrationClientOptions;

  constructor(options: KafuoIntegrationClientOptions = {}) {
    this.options = options;
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? kafuoIntegrationBaseUrl()).replace(/\/+$/, '');
  }

  private secret(): string {
    return this.options.secret ?? integrationSecret();
  }

  /**
   * One signed POST. Throws `KafuoUnreachableError` on any transport failure
   * or 5xx; returns the status and parsed body (or `null`) otherwise, so each
   * call maps its own 2xx/4xx vocabulary.
   */
  private async post(path: string, body: unknown): Promise<RawResponse> {
    const base = this.baseUrl();
    const secret = this.secret();
    if (!base || !secret) throw notConfigured();
    const rawBody = JSON.stringify(body);
    const nowMs = (this.options.now ?? Date.now)();
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = signWebhookDelivery(secret, timestamp, rawBody);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? kafuoIntegrationTimeoutMs();

    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [WEBHOOK_EVENT_HEADERS.timestamp]: timestamp,
          [WEBHOOK_EVENT_HEADERS.signature]: signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new KafuoUnreachableError(`Kafuo ${path} unreachable (${name})`, { cause: error });
    }
    if (response.status >= 500) {
      throw new KafuoUnreachableError(`Kafuo ${path} answered HTTP ${response.status}`, {
        status: response.status,
      });
    }
    let parsed: unknown = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
    }
    return { status: response.status, body: parsed };
  }

  /** `POST /meters/reserve` (contracts §2.2). */
  async reserve(request: MeterReserveRequest): Promise<MeterReserveDecision> {
    const { status, body } = await this.post('/meters/reserve', request);
    if (status === 200 && isRecord(body) && typeof body.allowed === 'boolean') {
      if (body.allowed) {
        const reservationId = body.reservationId;
        if (typeof reservationId !== 'string' && typeof reservationId !== 'number') {
          throw new KafuoIntegrationError(
            'Kafuo reserve answered allowed without a reservationId',
            status,
            'malformed_response',
          );
        }
        const rawStatus = body.status;
        return {
          allowed: true,
          reservationId: String(reservationId),
          replay: body.replay === true,
          status:
            isRecord(rawStatus) &&
            typeof rawStatus.limit === 'number' &&
            typeof rawStatus.used === 'number' &&
            typeof rawStatus.remaining === 'number' &&
            typeof rawStatus.resetAt === 'string'
              ? {
                  limit: rawStatus.limit,
                  used: rawStatus.used,
                  remaining: rawStatus.remaining,
                  resetAt: rawStatus.resetAt,
                }
              : null,
        };
      }
      const reason = body.reason;
      return {
        allowed: false,
        reason:
          reason === 'help_allowance_exhausted' ||
          reason === 'tutor_allowance_exhausted' ||
          reason === 'feature_not_in_package' ||
          reason === 'temporarily_unavailable'
            ? reason
            : 'temporarily_unavailable',
        window: typeof body.window === 'string' ? body.window : null,
        resetAt: typeof body.resetAt === 'string' ? body.resetAt : null,
        replay: body.replay === true,
      };
    }
    throw new KafuoIntegrationError(
      `Kafuo reserve refused with HTTP ${status}`,
      status,
      errorCodeOf(body),
    );
  }

  /**
   * `POST /meters/finalize` (contracts §2.3). `204` (including an identical
   * repeat) → `delivered`; `409 finalize_conflict` → `conflict`; `404` →
   * `not_found`. Any other 4xx is a contract failure and throws.
   */
  async finalize(request: MeterFinalizeRequest): Promise<MeterFinalizeResult> {
    const { status, body } = await this.post('/meters/finalize', request);
    if (status === 204 || status === 200) return { status: 'delivered' };
    if (status === 409) return { status: 'conflict' };
    if (status === 404) return { status: 'not_found' };
    throw new KafuoIntegrationError(
      `Kafuo finalize refused with HTTP ${status}`,
      status,
      errorCodeOf(body),
    );
  }

  /** `POST /grounding/search` (contracts §2.1). */
  async groundingSearch(request: GroundingSearchRequest): Promise<GroundingSearchResponse> {
    const { status, body } = await this.post('/grounding/search', request);
    if (status === 200 && isRecord(body) && Array.isArray(body.units)) {
      const units: GroundingUnit[] = [];
      for (const unit of body.units) {
        if (!isRecord(unit) || typeof unit.contentUnitId !== 'string' || typeof unit.text !== 'string') {
          continue;
        }
        units.push({
          contentUnitId: unit.contentUnitId,
          lessonId: typeof unit.lessonId === 'string' ? unit.lessonId : '',
          lessonTitle: typeof unit.lessonTitle === 'string' ? unit.lessonTitle : '',
          unitTitle: typeof unit.unitTitle === 'string' ? unit.unitTitle : '',
          text: unit.text,
          charLength: typeof unit.charLength === 'number' ? unit.charLength : unit.text.length,
          score: typeof unit.score === 'number' ? unit.score : 0,
        });
      }
      const match = body.lessonMatch;
      return {
        units,
        lessonMatch:
          isRecord(match) &&
          typeof match.lessonId === 'string' &&
          typeof match.lessonTitle === 'string' &&
          typeof match.confidence === 'number'
            ? { lessonId: match.lessonId, lessonTitle: match.lessonTitle, confidence: match.confidence }
            : null,
        truncated: body.truncated === true,
      };
    }
    throw new KafuoIntegrationError(
      `Kafuo grounding search refused with HTTP ${status}`,
      status,
      errorCodeOf(body),
    );
  }
}

const CLIENT_KEY = Symbol.for('openmaic.tutor.kafuo-integration-client');

/** The process-wide client (env-configured); tests construct their own. */
export function getKafuoIntegrationClient(): KafuoIntegrationClient {
  const registry = globalThis as Record<symbol, KafuoIntegrationClient | undefined>;
  return (registry[CLIENT_KEY] ??= new KafuoIntegrationClient());
}
