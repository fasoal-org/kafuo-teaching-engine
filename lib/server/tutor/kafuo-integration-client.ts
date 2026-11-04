/**
 * OpenMAIC → Kafuo integration client (Kafuo R1 contracts §2; plan §8.6, P5).
 *
 * Four signed calls under `KAFUO_INTEGRATION_BASE_URL` (the router prefix,
 * e.g. `https://api.kafuo.example/api/v2/integrations/teaching-engine`):
 * `POST /meters/reserve`, `POST /meters/finalize`, `POST /grounding/search` and
 * `POST /learner-access/check` (ET-16 c, G2: learner grant re-validation).
 * W6 adds `POST /quiz-questions` and `POST /quiz-grades` (bank quiz Scenes).
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

/**
 * The shared HMAC secret (`TEACHING_ENGINE_WEBHOOK_SECRET`), trimmed; '' when
 * unset. One secret signs both directions: this client's calls to Kafuo and
 * Kafuo's signed calls to the TE (`kafuo-request-signature.ts`).
 */
export function integrationSecret(): string {
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

/**
 * Help scope (contracts §2.2): `learningItemId` + `learningItemType` name the
 * pinned version's learning item (W2-C3, ET-34); Kafuo resolves its lesson (or
 * SECTION), re-checks access on every turn (ET-16 c) and keys the Help counter
 * `lesson:{lessonId}` / `item:{learningItemId}`. `lessonId` is the deprecated
 * alias that has always carried the same learning item id.
 */
export type MeterScope =
  | { conversationId: string }
  | {
      helpSessionId: string;
      lessonId: string | null;
      learningItemId?: string | null;
      learningItemType?: string | null;
    };

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

/**
 * Kafuo's refusal reasons (contracts §2.2). `account_inactive` is an inactive,
 * suspended or deleted account (SR-36); `feature_not_in_package` is a Package
 * without the turn's feature (ET-17). W2-C3 adds the
 * operational-control refusals
 * (`feature_disabled`, `not_in_rollout`; a kill switch is
 * `temporarily_unavailable`) and the lesson-gate codes a Help turn gets when the
 * student lost access to the lesson after the grant was minted (ET-16 c):
 * `lesson_not_acquired`, `paid_ended_lesson_locked`, `lesson_on_hold`,
 * `learning_item_not_acquired`, `academic_unavailable`, `tenant_catalog_missing`,
 * and (G2) `learning_item_on_hold` for a held SECTION.
 * The turn answers every one except `temporarily_unavailable` (retryable
 * `METER_UNAVAILABLE`) and `account_inactive` (403) as `ALLOWANCE_EXHAUSTED` with
 * `details.reason`, which the app maps to its denial sheet. Any other reason
 * parses as `temporarily_unavailable`.
 */
export type MeterRefusalReason =
  | 'help_allowance_exhausted'
  | 'tutor_allowance_exhausted'
  | 'feature_not_in_package'
  | 'account_inactive'
  | 'temporarily_unavailable'
  | 'feature_disabled'
  | 'not_in_rollout'
  | 'lesson_not_acquired'
  | 'paid_ended_lesson_locked'
  | 'lesson_on_hold'
  | 'learning_item_not_acquired'
  | 'learning_item_on_hold'
  | 'academic_unavailable'
  | 'tenant_catalog_missing';

const METER_REFUSAL_REASONS: ReadonlySet<string> = new Set<MeterRefusalReason>([
  'help_allowance_exhausted',
  'tutor_allowance_exhausted',
  'feature_not_in_package',
  'account_inactive',
  'temporarily_unavailable',
  'feature_disabled',
  'not_in_rollout',
  'lesson_not_acquired',
  'paid_ended_lesson_locked',
  'lesson_on_hold',
  'learning_item_not_acquired',
  'learning_item_on_hold',
  'academic_unavailable',
  'tenant_catalog_missing',
]);

/**
 * `reservationId: null` is the ungated answer (ET-04): Kafuo is not the meter
 * authority (legacy / shadow / dev), nothing was reserved, and the turn sends
 * no finalize.
 */
export type MeterReserveDecision =
  | {
      allowed: true;
      reservationId: string | null;
      replay: boolean;
      status: MeterAllowanceStatus | null;
    }
  | {
      allowed: false;
      reason: MeterRefusalReason;
      window: string | null;
      resetAt: string | null;
      replay: boolean;
    };

export type MeterFinalizeRequest = FinalizePayload;

export type MeterFinalizeResult = { status: 'delivered' | 'conflict' | 'not_found' };

/**
 * `POST /learner-access/check` (contracts §2.4, ET-16 c, G2): may the student
 * behind a learner grant still open its learning item? `learningItemType` is
 * informational; Kafuo resolves the item itself.
 */
export interface LearnerAccessCheckRequest {
  tenantId: string;
  studentRef: string;
  learningItemId: string;
  learningItemType: string | null;
}

/** `reason` is Kafuo's lesson-gate code (the meter refusal vocabulary). */
export type LearnerAccessCheckResult = { allowed: true } | { allowed: false; reason: string };

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

/**
 * W6 one question source (status doc "W6 contract" item 3):
 * `POST /quiz-questions` and `POST /quiz-grades`. The scope comes from the TE
 * grant only. `studentRef` is sent for a learner grant (the session's pinned
 * approval); without it (admin preview) Kafuo reads the current approved set.
 */
export interface BankQuizScope {
  tenantId: string;
  learningItemId: string;
  versionId: string;
  sceneId: string;
  studentRef?: string;
}

export type BankQuizQuestionType =
  | 'single_choice'
  | 'true_false'
  | 'multiple_answer'
  | 'short_answer';

const BANK_QUIZ_QUESTION_TYPES: ReadonlySet<string> = new Set<BankQuizQuestionType>([
  'single_choice',
  'true_false',
  'multiple_answer',
  'short_answer',
]);

export interface BankQuizAsset {
  url: string;
  alt: string | null;
}

/** The learner-safe projection: never a key, a model answer or a rubric. */
export interface BankQuizQuestion {
  id: string;
  questionType: BankQuizQuestionType;
  text: string;
  choices: { id: string; text: string }[];
  assets: BankQuizAsset[];
  points: number;
}

export type BankQuizQuestionsStatus = 'ready' | 'pending_approval' | 'not_bank';

export interface BankQuizQuestionsResult {
  status: BankQuizQuestionsStatus;
  questions: BankQuizQuestion[];
}

/** Answer per `bank:` id: a choice id, a list of choice ids, or the typed text. */
export type BankQuizAnswer = string | string[];

export interface BankQuizGradeResult {
  questionId: string;
  status: string;
  earned: number;
  possible: number;
  correctAnswer: string[] | null;
  explanation: string | null;
}

export interface BankQuizGradesResult {
  results: BankQuizGradeResult[];
  earned: number;
  possible: number;
  pendingPossible: number;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Allowlist projection of one bank question; anything else Kafuo sends is dropped. */
function bankQuizQuestionOf(raw: unknown): BankQuizQuestion | null {
  if (!isRecord(raw)) return null;
  const { id, question_type: questionType, text } = raw;
  if (typeof id !== 'string' || !id.startsWith('bank:')) return null;
  if (typeof questionType !== 'string' || !BANK_QUIZ_QUESTION_TYPES.has(questionType)) return null;
  if (typeof text !== 'string' || text === '') return null;
  const choices: { id: string; text: string }[] = [];
  for (const choice of Array.isArray(raw.choices) ? raw.choices : []) {
    if (isRecord(choice) && typeof choice.id === 'string' && typeof choice.text === 'string') {
      choices.push({ id: choice.id, text: choice.text });
    }
  }
  const assets: BankQuizAsset[] = [];
  for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
    if (!isRecord(asset)) continue;
    const url = typeof asset.url === 'string' ? asset.url : null;
    if (!url || !/^(https:\/\/|\/)/.test(url)) continue;
    assets.push({ url, alt: typeof asset.alt === 'string' ? asset.alt : null });
  }
  return {
    id,
    questionType: questionType as BankQuizQuestionType,
    text,
    choices,
    assets,
    points: Math.max(0, finiteNumber(raw.points, 1)),
  };
}

function bankQuizBody(scope: BankQuizScope): Record<string, unknown> {
  return {
    tenantId: scope.tenantId,
    learningItemId: scope.learningItemId,
    versionId: scope.versionId,
    sceneId: scope.sceneId,
    ...(scope.studentRef ? { studentRef: scope.studentRef } : {}),
  };
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

  /**
   * `POST /meters/reserve` (contracts §2.2). An explicit `reservationId: null`
   * on an allowed answer is the ungated case (ET-04); a missing key or any
   * other non-string, non-number id is `malformed_response`.
   */
  async reserve(request: MeterReserveRequest): Promise<MeterReserveDecision> {
    const { status, body } = await this.post('/meters/reserve', request);
    if (status === 200 && isRecord(body) && typeof body.allowed === 'boolean') {
      if (body.allowed) {
        const reservationId = body.reservationId;
        if (
          reservationId !== null &&
          typeof reservationId !== 'string' &&
          typeof reservationId !== 'number'
        ) {
          throw new KafuoIntegrationError(
            'Kafuo reserve answered allowed without a reservationId',
            status,
            'malformed_response',
          );
        }
        const rawStatus = body.status;
        return {
          allowed: true,
          reservationId: reservationId === null ? null : String(reservationId),
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
          typeof reason === 'string' && METER_REFUSAL_REASONS.has(reason)
            ? (reason as MeterRefusalReason)
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

  /**
   * `POST /learner-access/check` (contracts §2.4). `200 {allowed, reason}` is the
   * answer; a refusal without a usable reason reads as `temporarily_unavailable`
   * (the caller fails closed, retryable). `404 student_ref_unknown` and any other
   * 4xx throw `KafuoIntegrationError`; a 5xx or a transport failure throws
   * `KafuoUnreachableError`.
   */
  async checkLearnerAccess(request: LearnerAccessCheckRequest): Promise<LearnerAccessCheckResult> {
    const { status, body } = await this.post('/learner-access/check', request);
    if (status === 200 && isRecord(body) && typeof body.allowed === 'boolean') {
      if (body.allowed) return { allowed: true };
      const reason = body.reason;
      return {
        allowed: false,
        reason: typeof reason === 'string' && reason !== '' ? reason : 'temporarily_unavailable',
      };
    }
    throw new KafuoIntegrationError(
      `Kafuo learner access check refused with HTTP ${status}`,
      status,
      errorCodeOf(body),
    );
  }

  /**
   * `POST /quiz-questions` (W6 contract item 3): a bank quiz Scene's approved
   * questions, keys stripped. An unknown `status` reads as `not_bank` (the
   * Scene's own questions are shown). Any 4xx throws `KafuoIntegrationError`.
   */
  async quizQuestions(scope: BankQuizScope): Promise<BankQuizQuestionsResult> {
    const { status, body } = await this.post('/quiz-questions', bankQuizBody(scope));
    if (status === 200 && isRecord(body) && typeof body.status === 'string') {
      const answer: BankQuizQuestionsStatus =
        body.status === 'ready' || body.status === 'pending_approval' ? body.status : 'not_bank';
      const questions =
        answer === 'ready' && Array.isArray(body.questions)
          ? body.questions
              .map(bankQuizQuestionOf)
              .filter((question): question is BankQuizQuestion => question !== null)
          : [];
      return { status: answer, questions };
    }
    throw new KafuoIntegrationError(
      `Kafuo quiz questions refused with HTTP ${status}`,
      status,
      errorCodeOf(body),
    );
  }

  /**
   * `POST /quiz-grades` (W6 contract items 2–3): Kafuo grades `bank:` answers.
   * `503 teaching_answer_grading_unavailable` surfaces as `KafuoUnreachableError`
   * (every 5xx does); any 4xx throws `KafuoIntegrationError`.
   */
  async quizGrades(
    scope: BankQuizScope,
    answers: Record<string, BankQuizAnswer>,
  ): Promise<BankQuizGradesResult> {
    const { status, body } = await this.post('/quiz-grades', { ...bankQuizBody(scope), answers });
    if (status === 200 && isRecord(body) && Array.isArray(body.results)) {
      const results: BankQuizGradeResult[] = [];
      for (const raw of body.results) {
        if (!isRecord(raw) || typeof raw.question_id !== 'string' || typeof raw.status !== 'string')
          continue;
        const correct = raw.correct_answer;
        results.push({
          questionId: raw.question_id,
          status: raw.status,
          earned: finiteNumber(raw.earned, 0),
          possible: finiteNumber(raw.possible, 0),
          correctAnswer: Array.isArray(correct)
            ? correct.filter((value): value is string => typeof value === 'string')
            : null,
          explanation: typeof raw.explanation === 'string' ? raw.explanation : null,
        });
      }
      return {
        results,
        earned: finiteNumber(body.earned, 0),
        possible: finiteNumber(body.possible, 0),
        pendingPossible: finiteNumber(body.pending_possible, 0),
      };
    }
    throw new KafuoIntegrationError(
      `Kafuo quiz grades refused with HTTP ${status}`,
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
        if (
          !isRecord(unit) ||
          typeof unit.contentUnitId !== 'string' ||
          typeof unit.text !== 'string'
        ) {
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
            ? {
                lessonId: match.lessonId,
                lessonTitle: match.lessonTitle,
                confidence: match.confidence,
              }
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
