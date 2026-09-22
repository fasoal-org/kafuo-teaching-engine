/**
 * Meter finalize outbox sweeper (Kafuo R1 plan §8.6, §9.4; contracts §0 M3).
 *
 * Two entry points over the same delivery step:
 *  - `deliverFinalizeInline(pool, reservationId)` — the post-commit best-effort
 *    delivery the turn path calls right after `done` (commit → `done` →
 *    inline finalize, one ordering everywhere). It claims THAT row under the
 *    lease, delivers, marks. If the claim fails (a sweeper already has it),
 *    or delivery fails, the row simply stays `pending` for the sweeper.
 *  - `runMeterOutboxSweepOnce()` — boot pass + every 30 s in every instance,
 *    and `POST /api/internal/sweep` through the sweep registry: claim due rows
 *    (60 s lease keyed by `hostname:pid:bootNonce`), deliver each, then the
 *    retention delete. Two live sweepers split a backlog (`SKIP LOCKED`); a
 *    replaced instance's rows are picked up by whichever sweeps next.
 *
 * Outcomes per row: `204` → `delivered`; `409` → `conflict` (never retried,
 * `meter.late_delivery_report`); `404` → `terminal_failed` (Kafuo does not
 * know the reservation; nothing to retry); unreachable/5xx/timeout → back
 * off (`meter.finalize_deferred`) unless the row is older than
 * `MERGE_RESERVATION_STALE_SECONDS` (3600 — Kafuo's own sweeper has released
 * the reservation by then), in which case that attempt was its last and it
 * becomes `terminal_failed` (`meter.finalize_terminal_failed`).
 *
 * Same schedule shape as the accounting sweeper: `Symbol.for`-memoized
 * handle, unref'd timer, running guard, gated on the Teaching Package API,
 * `stop()` in the shutdown chain — which also releases this worker's leases
 * so a successor does not wait out the lease. Never logs prompt or student
 * text; never touches the filesystem (tests/lint-no-local-state).
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import {
  claimDueFinalizes,
  claimFinalizeById,
  deleteExpiredFinalizes,
  markFinalizeConflict,
  markFinalizeDelivered,
  markFinalizeRetry,
  markFinalizeTerminalFailed,
  readOutboxStatus,
  releaseLeases,
  type MeterFinalizeOutboxRow,
} from '@/lib/persistence/meter-finalize-outbox';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { markMessagesMeterFinalized } from '@/lib/persistence/tutor-runtime';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import {
  registerMeterOutboxSweeper,
  type MeterOutboxHealth,
  type MeterSweepResult,
} from '@/lib/server/teaching-model/sweep-registry';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import {
  getKafuoIntegrationClient,
  isKafuoUnreachableError,
  type KafuoIntegrationClient,
} from '@/lib/server/tutor/kafuo-integration-client';

const log = createLogger('MeterOutboxSweeper');

/** Kafuo `entitlements_reservation_stale_seconds`: past this age, one last try. */
export const MERGE_RESERVATION_STALE_SECONDS = 3600;
export const METER_SWEEP_INTERVAL_MS = 30_000;
export const METER_LEASE_SECONDS = 60;
export const METER_SWEEP_BATCH = 50;

export interface MeterOutboxSweeperStatus {
  /** Epoch ms of the last completed sweep in this process; null before the first. */
  lastMeterSweepAt: number | null;
  lastClaimed: number;
  lastDelivered: number;
}

const STATUS_KEY = Symbol.for('openmaic.teaching-model.meter-outbox-sweeper-status');

/** Module-level status the health route reads (shared across bundles). */
export function meterOutboxSweeperStatus(): MeterOutboxSweeperStatus {
  const registry = globalThis as Record<symbol, MeterOutboxSweeperStatus | undefined>;
  return (registry[STATUS_KEY] ??= { lastMeterSweepAt: null, lastClaimed: 0, lastDelivered: 0 });
}

/** Test seam: the status is process-global, so suites reset it between cases. */
export function resetMeterOutboxSweeperStatusForTests(): void {
  const status = meterOutboxSweeperStatus();
  status.lastMeterSweepAt = null;
  status.lastClaimed = 0;
  status.lastDelivered = 0;
}

export interface MeterSweepOptions {
  /** Test seam: a caller-provided pool instead of the provider. */
  pool?: ConnectableQueryable;
  /** Epoch ms clock. */
  now?: () => number;
  workerId?: string;
  client?: KafuoIntegrationClient;
  batch?: number;
  /** Override the stale window (tests). */
  staleSeconds?: number;
}

async function poolFor(options?: MeterSweepOptions): Promise<ConnectableQueryable> {
  if (options?.pool) return options.pool;
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool as unknown as ConnectableQueryable;
}

export type DeliveryOutcome = 'delivered' | 'conflict' | 'terminal_failed' | 'deferred';

/**
 * Deliver one CLAIMED row and record the outcome. Every branch ends in a
 * guarded UPDATE (`WHERE status = 'pending'`), so a second worker whose lease
 * expired mid-flight and that comes back late finds its update a no-op.
 */
async function deliverClaimedRow(
  pool: ConnectableQueryable,
  row: MeterFinalizeOutboxRow,
  context: { client: KafuoIntegrationClient; nowS: number; workerId: string; staleSeconds: number },
): Promise<DeliveryOutcome> {
  const { client, nowS, workerId } = context;
  const ageS = nowS - Number(row.created_at);
  const lastChance = ageS >= context.staleSeconds;
  const base = { reservationId: row.reservation_id, turnId: row.turn_id, workerId };
  try {
    const result = await client.finalize(row.payload);
    if (result.status === 'delivered') {
      await markFinalizeDelivered(pool, row.reservation_id, nowS);
      // Informational flag on the message rows; the outbox row is the record.
      await markMessagesMeterFinalized(pool, row.reservation_id).catch((error) => {
        log.warn(
          JSON.stringify({
            event: 'meter.message_flag_failed',
            ...base,
            error: describeErrorSafely(error).name,
          }),
        );
      });
      return 'delivered';
    }
    if (result.status === 'conflict') {
      await markFinalizeConflict(pool, row.reservation_id, { now: nowS });
      log.warn(
        JSON.stringify({ event: 'meter.late_delivery_report', ...base, outcome: row.outcome, ageS }),
      );
      return 'conflict';
    }
    // not_found: Kafuo never knew (or no longer knows) the reservation.
    await markFinalizeTerminalFailed(pool, row.reservation_id, {
      now: nowS,
      lastStatus: 404,
      lastError: 'reservation unknown to Kafuo',
    });
    log.error(
      JSON.stringify({ event: 'meter.finalize_terminal_failed', ...base, reason: 'not_found', ageS }),
    );
    return 'terminal_failed';
  } catch (error) {
    const described = describeErrorSafely(error);
    const status = isKafuoUnreachableError(error) ? error.status : null;
    if (lastChance || !isKafuoUnreachableError(error)) {
      // Past the stale window (or a contract failure that will not heal by
      // retrying): this was the last attempt.
      await markFinalizeTerminalFailed(pool, row.reservation_id, {
        now: nowS,
        lastStatus: status,
        lastError: described.name,
      });
      log.error(
        JSON.stringify({
          event: 'meter.finalize_terminal_failed',
          ...base,
          reason: lastChance ? 'stale' : 'contract',
          ageS,
          attempts: Number(row.attempts) + 1,
          error: described.name,
        }),
      );
      return 'terminal_failed';
    }
    const nextAttemptAt = await markFinalizeRetry(pool, row.reservation_id, {
      now: nowS,
      lastStatus: status,
      lastError: described.name,
    });
    log.warn(
      JSON.stringify({
        event: 'meter.finalize_deferred',
        ...base,
        attempts: Number(row.attempts) + 1,
        nextAttemptAt,
        error: described.name,
      }),
    );
    return 'deferred';
  }
}

/**
 * Post-commit inline delivery for one reservation (§8.6 "Enqueue"). Returns
 * `'not_claimed'` when the row is no longer pending or a sweeper holds it —
 * both mean someone else owns delivery; the caller never retries here.
 */
export async function deliverFinalizeInline(
  pool: ConnectableQueryable,
  reservationId: string,
  options?: Omit<MeterSweepOptions, 'pool' | 'batch'>,
): Promise<DeliveryOutcome | 'not_claimed'> {
  const now = options?.now ?? Date.now;
  const nowS = now() / 1000;
  const workerId = options?.workerId ?? currentWorkerId();
  const row = await claimFinalizeById(pool, reservationId, {
    workerId,
    leaseUntil: nowS + METER_LEASE_SECONDS,
    now: nowS,
  });
  if (!row) return 'not_claimed';
  return deliverClaimedRow(pool, row, {
    client: options?.client ?? getKafuoIntegrationClient(),
    nowS,
    workerId,
    staleSeconds: options?.staleSeconds ?? MERGE_RESERVATION_STALE_SECONDS,
  });
}

/**
 * One full pass: claim due rows, deliver each, retention delete. Exported for
 * the internal sweep route (via the registry) and for tests; the timer calls
 * exactly this.
 */
export async function runMeterOutboxSweepOnce(options?: MeterSweepOptions): Promise<MeterSweepResult> {
  const pool = await poolFor(options);
  const now = options?.now ?? Date.now;
  const workerId = options?.workerId ?? currentWorkerId();
  const client = options?.client ?? getKafuoIntegrationClient();
  const staleSeconds = options?.staleSeconds ?? MERGE_RESERVATION_STALE_SECONDS;
  const nowS = now() / 1000;

  const rows = await claimDueFinalizes(pool, {
    workerId,
    batch: options?.batch ?? METER_SWEEP_BATCH,
    leaseUntil: nowS + METER_LEASE_SECONDS,
    now: nowS,
  });
  let delivered = 0;
  let marked = 0;
  for (const row of rows) {
    const outcome = await deliverClaimedRow(pool, row, { client, nowS, workerId, staleSeconds });
    if (outcome === 'delivered') delivered += 1;
    if (outcome !== 'deferred') marked += 1;
  }
  const { deleted } = await deleteExpiredFinalizes(pool, nowS);

  const status = meterOutboxSweeperStatus();
  status.lastMeterSweepAt = now();
  status.lastClaimed = rows.length;
  status.lastDelivered = delivered;
  log.info(
    JSON.stringify({
      event: 'sweeper.run',
      kind: 'meter',
      workerId,
      claimed: rows.length,
      delivered,
      marked,
      deleted,
    }),
  );
  return { claimed: rows.length, delivered };
}

/** Health block (plan §9.1): last sweep time plus the outbox's pending shape. */
export async function readMeterOutboxHealth(options?: MeterSweepOptions): Promise<MeterOutboxHealth> {
  const pool = await poolFor(options);
  const nowS = (options?.now ?? Date.now)() / 1000;
  const outbox = await readOutboxStatus(pool, nowS);
  return {
    lastMeterSweepAt: meterOutboxSweeperStatus().lastMeterSweepAt,
    pendingFinalizes: outbox.pendingFinalizes,
    oldestPendingFinalizeAgeS: outbox.oldestPendingFinalizeAgeS,
  };
}

const SCHEDULE_KEY = Symbol.for('openmaic.teaching-model.meter-outbox-sweeper');

export interface MeterOutboxSweeperHandle {
  stop(): Promise<void>;
}

/**
 * Boot pass + 30 s sweep, memoized per process; registers the sweep + health
 * hooks in the sweep registry so `/api/internal/sweep` and `/api/health` see
 * them. `undefined` when the Teaching Package API is not configured — the
 * same gate as the other schedules, for the same reason (no pool against an
 * empty connection string).
 */
export function startMeterOutboxSweeper(): MeterOutboxSweeperHandle | undefined {
  if (!isTeachingPackageApiConfigured()) return undefined;

  const registry = globalThis as Record<symbol, MeterOutboxSweeperHandle | undefined>;
  const existing = registry[SCHEDULE_KEY];
  if (existing) return existing;

  registerMeterOutboxSweeper({
    runMeterOutboxSweepOnce: () => runMeterOutboxSweepOnce(),
    readMeterOutboxHealth: () => readMeterOutboxHealth(),
  });

  let running: Promise<unknown> | null = null;
  let stopped = false;
  const sweep = () => {
    if (running || stopped) return;
    running = runMeterOutboxSweepOnce()
      .catch((error) => {
        log.error('meter outbox sweep failed:', describeErrorSafely(error));
      })
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(sweep, METER_SWEEP_INTERVAL_MS);
  timer.unref?.();

  // Boot pass: a replaced instance's pending rows are delivered without
  // waiting for the first interval.
  sweep();

  const handle: MeterOutboxSweeperHandle = {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Let an in-flight pass finish its guarded updates, then hand back any
      // lease it still holds so a successor picks the rows up immediately.
      if (running) await running;
      try {
        const pool = await poolFor();
        const released = await releaseLeases(pool, currentWorkerId());
        if (released > 0) {
          log.info(
            JSON.stringify({ event: 'meter.leases_released', workerId: currentWorkerId(), released }),
          );
        }
      } catch (error) {
        log.error('meter outbox lease release failed:', describeErrorSafely(error));
      }
      registerMeterOutboxSweeper(undefined);
      registry[SCHEDULE_KEY] = undefined;
    },
  };
  registry[SCHEDULE_KEY] = handle;
  return handle;
}
