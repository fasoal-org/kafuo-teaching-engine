/**
 * Restart-safe webhook delivery (plan §4.4.3).
 *
 * `deliverPendingWebhooks` claims due rows under a lease, signs each delivery
 * `v1=<hmac-sha256(secret, "<timestamp>.<raw body>")>` with a DEDICATED
 * webhook secret, and moves the row to delivered / retry-with-backoff /
 * terminal-failed. Ordering per aggregate is preserved by refusing to deliver
 * an event while an older pending row exists for the same aggregate.
 *
 * `startWebhookDeliverySchedule` installs the boot scan + interval sweep
 * (Symbol.for-memoized, unref'd, running-guarded) and joins the process
 * shutdown chain. The sweep also reclaims stale generation attempts and
 * enqueues their `generation_failed` events. This is NOT the Module 8 Durable
 * Agent Runtime: reliability comes from the durable rows + sweep, with a
 * known worst-case delivery latency of one sweep interval after a crash.
 */
import { createHmac } from 'node:crypto';

import {
  claimPendingWebhookDeliveries,
  markWebhookDelivered,
  markWebhookRetry,
  markWebhookTerminalFailed,
  reclaimStaleAttempts,
  type WebhookDeliveryRow,
} from '@/lib/persistence/teaching-package';
import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { createLogger } from '@/lib/logger';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import type { TeachingPackageAggregateKey } from '@/lib/types/teaching-package';

const log = createLogger('TeachingPackageWebhooks');

export const WEBHOOK_EVENT_HEADERS = {
  eventId: 'X-Teaching-Engine-Event-Id',
  timestamp: 'X-Teaching-Engine-Timestamp',
  signature: 'X-Teaching-Engine-Signature',
} as const;

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_BATCH = 20;

function numericEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function webhookRetryLimit(): number {
  return numericEnv('TEACHING_ENGINE_WEBHOOK_MAX_RETRIES', DEFAULT_MAX_RETRIES);
}

export function webhookBaseUrl(): string {
  return (process.env.TEACHING_ENGINE_WEBHOOK_URL ?? '').trim();
}

function webhookSecret(): string {
  return (process.env.TEACHING_ENGINE_WEBHOOK_SECRET ?? '').trim();
}

/** The exact signature input: `<timestamp>.<raw body bytes>`. */
export function webhookSignatureInput(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function signWebhookDelivery(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(webhookSignatureInput(timestamp, rawBody)).digest('hex')}`;
}

function backoffMs(attempt: number): number {
  const base = numericEnv('TEACHING_ENGINE_WEBHOOK_BASE_DELAY_MS', DEFAULT_BASE_DELAY_MS);
  const max = numericEnv('TEACHING_ENGINE_WEBHOOK_MAX_DELAY_MS', 5 * 60 * 1000);
  return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
}

/** One bounded delivery pass. Returns the number of rows handled. */
export async function deliverPendingWebhooks(options: {
  workerId: string;
  batch?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam: run against a caller-provided pool instead of the provider. */
  pool?: ConnectableQueryable;
}): Promise<number> {
  const url = webhookBaseUrl();
  const secret = webhookSecret();
  if (!url || !secret) return 0;

  const pool =
    options.pool ?? (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const leaseUntil = now() + numericEnv('TEACHING_ENGINE_WEBHOOK_LEASE_MS', DEFAULT_LEASE_MS);

  const rows = await claimPendingWebhookDeliveries(pool, {
    workerId: options.workerId,
    batch: options.batch ?? DEFAULT_BATCH,
    leaseUntil,
    now: now(),
  });

  let handled = 0;
  for (const row of rows) {
    handled += 1;
    const payload = row.payload as Record<string, unknown>;
    const rawBody = JSON.stringify({
      id: row.id,
      type: row.event_type,
      occurredAt: new Date(Number(row.occurred_at)).toISOString(),
      sequence: Number(row.sequence),
      tenantContext: { tenantId: row.tenant_id },
      learningItem: { type: row.learning_item_type, id: row.learning_item_id },
      data: payload,
    });
    const timestamp = String(Math.floor(now() / 1000));
    const signature = signWebhookDelivery(secret, timestamp, rawBody);
    const maxRetries = webhookRetryLimit();
    const attempts = Number(row.attempts) + 1;

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_EVENT_HEADERS.eventId]: row.id,
          [WEBHOOK_EVENT_HEADERS.timestamp]: timestamp,
          [WEBHOOK_EVENT_HEADERS.signature]: signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(numericEnv('TEACHING_ENGINE_WEBHOOK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)),
      });
      if (response.ok) {
        await markWebhookDelivered(pool, row.id, now());
        continue;
      }
      // Contract/auth failures never retry; server/load failures back off.
      const retryableStatus = response.status >= 500 || response.status === 429;
      if (!retryableStatus || attempts >= maxRetries) {
        await markWebhookTerminalFailed(pool, row.id, {
          lastStatus: response.status,
          lastError: `receiver answered HTTP ${response.status}`,
          now: now(),
        });
        log.error(
          `webhook delivery ${row.id} terminally failed (HTTP ${response.status}) after ${attempts} attempt(s)`,
        );
        continue;
      }
      await markWebhookRetry(pool, row.id, {
        nextAttemptAt: now() + backoffMs(attempts),
        lastStatus: response.status,
        lastError: `receiver answered HTTP ${response.status}`,
        now: now(),
      });
    } catch (error) {
      // Network error / timeout — retryable within the policy.
      if (attempts >= maxRetries) {
        await markWebhookTerminalFailed(pool, row.id, {
          lastStatus: null,
          lastError: describeErrorSafely(error).name,
          now: now(),
        });
        log.error(
          `webhook delivery ${row.id} terminally failed after ${attempts} attempt(s)`,
        );
        continue;
      }
      await markWebhookRetry(pool, row.id, {
        nextAttemptAt: now() + backoffMs(attempts),
        lastStatus: null,
        lastError: describeErrorSafely(error).name,
        now: now(),
      });
    }
  }
  return handled;
}

/**
 * The periodic sweep: reclaim stale generation attempts (enqueuing their
 * `generation_failed` events with `ATTEMPT_RECLAIMED_STALE`), then deliver.
 */
export async function sweepWebhooksAndStaleAttempts(options?: {
  workerId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam: run against a caller-provided pool instead of the provider. */
  pool?: ConnectableQueryable;
}): Promise<void> {
  const workerId = options?.workerId ?? `sweep-${process.pid}`;
  const pool =
    options?.pool ??
    (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
  const staleBefore = Date.now() - attemptStaleMs();
  const reclaimed = await reclaimStaleAttempts(pool, null, staleBefore);
  for (const attempt of reclaimed) {
    // Reclaimed attempts were mid-flight; nothing about them is resumable.
    // Emit the failure event so Kafuo's projection stops waiting.
    const aggregate: TeachingPackageAggregateKey = {
      tenantId: attempt.tenantId,
      learningItem: attempt.learningItem,
    };
    await enqueueWebhookEvent(
      pool as never,
      aggregate,
      'teaching_package.generation_failed',
      () => ({
        requestId: attempt.requestId ?? '',
        attempt: {
          id: attempt.id,
          kind: attempt.kind,
          status: 'failed',
          versionId: attempt.versionId,
          producedStageId: attempt.producedStageId,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt ?? Date.now(),
          generationRuns: attempt.generationRuns,
        },
        error: {
          code: 'ATTEMPT_RECLAIMED_STALE',
          message: 'the generation attempt was reclaimed after its runner became stale',
          retryable: true,
        },
        ...(attempt.versionId
          ? {}
          : {}),
      }),
    ).catch((error) => {
      log.error(
        `failed to enqueue generation_failed for reclaimed attempt ${attempt.id}:`,
        describeErrorSafely(error),
      );
    });
  }
  if (reclaimed.length > 0) {
    log.warn(`reclaimed ${reclaimed.length} stale generation attempt(s) via sweep`);
  }
  await deliverPendingWebhooks({
    workerId,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.pool ? { pool: options.pool } : {}),
  }).catch((error) => {
    log.error('webhook sweep delivery failed:', describeErrorSafely(error));
  });
}

function attemptStaleMs(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_ATTEMPT_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

const SCHEDULE_SYMBOL = Symbol.for('openmaic.teaching-package.webhook-schedule');

interface WebhookScheduleHandle {
  stop(): Promise<void>;
}

/**
 * Boot scan + interval sweep, memoized per process (plan §4.4.3).
 *
 * `undefined` when the Teaching Package API is not configured, exactly as
 * `startAssetCollectorSchedule` answers without a database. The gate is the same
 * `isTeachingPackageApiConfigured()` every `app/api/teaching-packages/**` route
 * already keys on, so a deployment whose Teaching Package API answers 404 no
 * longer runs a sweep for it.
 *
 * Without the gate the sweep fired every 30 s in development and called
 * `getServerPersistenceProvider(process.env.DATABASE_URL ?? '')`. An empty
 * connection string is not an error to `pg` — it falls back to the OS
 * username/database, so every pass produced a fresh SQLSTATE `3D000`
 * ("database does not exist"). Returning before the timer is installed is what
 * keeps the disabled case from touching PostgreSQL at all; checking inside the
 * sweep would still have opened a pool.
 *
 * This is a startup gate only: `deliverPendingWebhooks` and
 * `sweepWebhooksAndStaleAttempts` are unchanged and remain callable directly
 * (the webhook suite drives them with its own pool), so delivery, retry and
 * stale-attempt reclamation behavior is untouched.
 */
export function startWebhookDeliverySchedule(): WebhookScheduleHandle | undefined {
  if (!isTeachingPackageApiConfigured()) return undefined;

  const registry = globalThis as Record<symbol, WebhookScheduleHandle | undefined>;
  const existing = registry[SCHEDULE_SYMBOL];
  if (existing) return existing;

  let running = false;
  let stopped = false;
  const interval = numericEnv('TEACHING_ENGINE_WEBHOOK_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS);
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void sweepWebhooksAndStaleAttempts()
      .catch((error) => {
        log.error('webhook schedule sweep failed:', describeErrorSafely(error));
      })
      .finally(() => {
        running = false;
      });
  }, interval);
  timer.unref?.();

  // Immediate boot scan: anything pending from a previous process is delivered
  // without waiting for the first interval.
  void sweepWebhooksAndStaleAttempts().catch((error) => {
    log.error('webhook boot sweep failed:', describeErrorSafely(error));
  });

  const handle: WebhookScheduleHandle = {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
    },
  };
  registry[SCHEDULE_SYMBOL] = handle;
  return handle;
}
