/**
 * Ledger accounting sweeper (Kafuo R1 plan §7.7 step 4, §9.4).
 *
 * Runs in EVERY instance: boot pass + every 60 s, plus a 30 s worker
 * heartbeat. It marks `started` rows `incomplete` once they can no longer be
 * completed:
 *  - `process_exit_before_completion` — the row's worker has not heartbeated
 *    within the last 90 s (its in-memory retry queue died with it);
 *  - `completion_write_lost` — the row is older than the incomplete deadline
 *    (2 × the 120 s route `maxDuration` + the 15 min retry horizon = 19 min).
 * Both updates are status-guarded and idempotent, so concurrent sweepers need
 * no lease and an external scheduler calling `POST /api/internal/sweep` is
 * equivalent to the timer.
 *
 * Same schedule shape as `webhook-delivery.ts`: `Symbol.for`-memoized handle,
 * unref'd timers, a running guard, and a `stop()` that joins the shutdown
 * chain. Nothing here touches the local filesystem (tests/lint-no-local-state).
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import {
  countStartedRowsOlderThan,
  heartbeatWorker,
  markIncompleteAttempts,
  pruneStaleWorkers,
} from '@/lib/persistence/teaching-model-attempts';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { getRetentionSweeps } from '@/lib/server/teaching-model/sweep-registry';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';

const log = createLogger('AccountingSweeper');

/** Route `maxDuration` for the conversational SSE and help-turn routes (contracts §3.4/§5). */
export const ROUTE_MAX_DURATION_S = 120;
/** 2 × maxDuration + the 15 min in-memory retry horizon. */
export const INCOMPLETE_DEADLINE_S = 2 * ROUTE_MAX_DURATION_S + 15 * 60;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_S = 90;
export const SWEEP_INTERVAL_MS = 60_000;
/** Forget worker rows silent for a day (they are only consulted while rows are `started`). */
const WORKER_RETENTION_S = 24 * 60 * 60;

export interface AccountingSweeperStatus {
  /** Epoch ms of the last completed sweep in this process; null before the first. */
  lastLedgerSweepAt: number | null;
  lastMarked: number;
}

const STATUS_KEY = Symbol.for('openmaic.teaching-model.accounting-sweeper-status');

/** Module-level status the health route reads (shared across bundles). */
export function accountingSweeperStatus(): AccountingSweeperStatus {
  const registry = globalThis as Record<symbol, AccountingSweeperStatus | undefined>;
  return (registry[STATUS_KEY] ??= { lastLedgerSweepAt: null, lastMarked: 0 });
}

/** Test seam: the status is process-global, so suites reset it between cases. */
export function resetAccountingSweeperStatusForTests(): void {
  const status = accountingSweeperStatus();
  status.lastLedgerSweepAt = null;
  status.lastMarked = 0;
}

export interface SweepOptions {
  /** Test seam: a caller-provided pool instead of the provider. */
  pool?: ConnectableQueryable;
  /** Epoch ms clock. */
  now?: () => number;
  workerId?: string;
}

async function poolFor(options?: SweepOptions): Promise<ConnectableQueryable> {
  if (options?.pool) return options.pool;
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool as unknown as ConnectableQueryable;
}

/** Heartbeat this worker; safe to call from the sweep and from the 30 s timer. */
export async function heartbeatOnce(options?: SweepOptions): Promise<void> {
  const pool = await poolFor(options);
  const nowS = (options?.now ?? Date.now)() / 1000;
  await heartbeatWorker(pool, options?.workerId ?? currentWorkerId(), nowS);
}

/**
 * One full pass: heartbeat, mark, prune. Exported for the internal sweep
 * route and for tests; the timer calls exactly this.
 */
export async function runAccountingSweepOnce(options?: SweepOptions): Promise<{ marked: number }> {
  const pool = await poolFor(options);
  const now = options?.now ?? Date.now;
  const workerId = options?.workerId ?? currentWorkerId();
  const nowS = now() / 1000;
  await heartbeatWorker(pool, workerId, nowS);
  const result = await markIncompleteAttempts(pool, {
    now: nowS,
    deadlineS: INCOMPLETE_DEADLINE_S,
    heartbeatStaleS: HEARTBEAT_STALE_S,
  });
  for (const id of result.processExit) {
    log.warn(
      JSON.stringify({
        event: 'teaching_model.accounting_marked_incomplete',
        attemptId: id,
        reason: 'process_exit_before_completion',
        workerId,
      }),
    );
  }
  for (const id of result.completionWriteLost) {
    log.warn(
      JSON.stringify({
        event: 'teaching_model.accounting_marked_incomplete',
        attemptId: id,
        reason: 'completion_write_lost',
        workerId,
      }),
    );
  }
  await pruneStaleWorkers(pool, { now: nowS, olderThanS: WORKER_RETENTION_S });
  // Registered retention passes (P6: legacy_help_turns 7-day delete). Each is
  // isolated: one failing pass never blocks the accounting marks above.
  for (const [name, sweep] of getRetentionSweeps()) {
    try {
      const deleted = await sweep(pool, nowS);
      if (deleted > 0) log.info(JSON.stringify({ event: 'sweeper.retention', name, deleted }));
    } catch (error) {
      log.error(`retention sweep ${name} failed:`, describeErrorSafely(error));
    }
  }
  const status = accountingSweeperStatus();
  status.lastLedgerSweepAt = now();
  status.lastMarked = result.marked;
  log.info(
    JSON.stringify({ event: 'sweeper.run', kind: 'ledger', workerId, marked: result.marked }),
  );
  return { marked: result.marked };
}

/** Health: `started` rows the sweeper should already have labelled. */
export async function countStartedRowsPastDeadline(options?: SweepOptions): Promise<number> {
  const pool = await poolFor(options);
  const nowS = (options?.now ?? Date.now)() / 1000;
  return countStartedRowsOlderThan(pool, nowS - INCOMPLETE_DEADLINE_S);
}

const SCHEDULE_KEY = Symbol.for('openmaic.teaching-model.accounting-sweeper');

export interface AccountingSweeperHandle {
  stop(): Promise<void>;
}

/**
 * Boot pass + 60 s sweep + 30 s heartbeat, memoized per process. `undefined`
 * when the Teaching Package API is not configured — the same gate as the
 * webhook schedule, for the same reason: without it the timer would open a
 * pool against an empty connection string every minute.
 */
export function startAccountingSweeper(): AccountingSweeperHandle | undefined {
  if (!isTeachingPackageApiConfigured()) return undefined;

  const registry = globalThis as Record<symbol, AccountingSweeperHandle | undefined>;
  const existing = registry[SCHEDULE_KEY];
  if (existing) return existing;

  let running = false;
  let stopped = false;
  const sweep = () => {
    if (running || stopped) return;
    running = true;
    void runAccountingSweepOnce()
      .catch((error) => {
        log.error('accounting sweep failed:', describeErrorSafely(error));
      })
      .finally(() => {
        running = false;
      });
  };
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    void heartbeatOnce().catch((error) => {
      log.error('worker heartbeat failed:', describeErrorSafely(error));
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Boot pass: a replaced instance's orphaned rows are labelled without
  // waiting for the first interval.
  sweep();

  const handle: AccountingSweeperHandle = {
    stop: async () => {
      stopped = true;
      clearInterval(sweepTimer);
      clearInterval(heartbeatTimer);
      registry[SCHEDULE_KEY] = undefined;
    },
  };
  registry[SCHEDULE_KEY] = handle;
  return handle;
}
