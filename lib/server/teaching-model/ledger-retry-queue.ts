/**
 * Bounded in-memory retry for failed ledger completion writes (Kafuo R1 plan
 * §7.7 step 3, §9.4).
 *
 * There is deliberately NO durable outbox for the ledger: the only durable
 * store an OpenMAIC instance may rely on is its Postgres database, and an
 * outbox table there fails exactly when the ledger update fails. What is left
 * is a bounded, explicitly non-durable retry: every 5 s, for at most 15 min,
 * at most 10,000 entries, drained once on SIGTERM. A process exit loses the
 * queue — the sweeper's `started → incomplete` marking is the recovery path,
 * and a late completion from this queue may still land (`late_completion`).
 *
 * Global state is memoized under a `Symbol.for` key so the instrumentation
 * bundle and the request bundle share one queue (the drain on shutdown must
 * see the entries the request handlers enqueued).
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('LedgerRetryQueue');

export const LEDGER_RETRY_INTERVAL_MS = 5_000;
export const LEDGER_RETRY_HORIZON_MS = 15 * 60 * 1000;
export const LEDGER_RETRY_MAX_ENTRIES = 10_000;

export interface LedgerRetryEntry {
  attemptId: string;
  /** Re-runs the completion write; resolves on success, rejects to stay queued. */
  run: () => Promise<void>;
  enqueuedAt: number;
  attempts: number;
  lastError?: string;
}

interface QueueState {
  entries: Map<string, LedgerRetryEntry>;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  onLateCompletion?: (attemptId: string) => void;
}

const QUEUE_KEY = Symbol.for('openmaic.teaching-model.ledger-retry-queue');

function state(): QueueState {
  const registry = globalThis as Record<symbol, QueueState | undefined>;
  return (registry[QUEUE_KEY] ??= { entries: new Map(), timer: null, ticking: false });
}

function ensureTimer(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => void tickLedgerRetryQueue(), LEDGER_RETRY_INTERVAL_MS);
  s.timer.unref?.();
}

function stopTimerIfIdle(): void {
  const s = state();
  if (s.entries.size === 0 && s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

/**
 * Queue a failed completion write. Returns `false` (and logs at error level)
 * when the queue is full: the row stays `started` and the sweeper will label
 * it `incomplete` — the honest outcome, never a silent drop.
 */
export function enqueueLedgerCompletion(
  attemptId: string,
  run: () => Promise<void>,
  options: { now?: number } = {},
): boolean {
  const s = state();
  const existing = s.entries.get(attemptId);
  if (existing) {
    // A second failure for the same row replaces the closure (it carries the
    // freshest completion payload) but keeps the original horizon.
    existing.run = run;
    return true;
  }
  if (s.entries.size >= LEDGER_RETRY_MAX_ENTRIES) {
    log.error(
      `ledger retry queue full (${LEDGER_RETRY_MAX_ENTRIES}); completion for attempt ${attemptId} not queued — the sweeper will mark it incomplete`,
    );
    return false;
  }
  s.entries.set(attemptId, { attemptId, run, enqueuedAt: options.now ?? Date.now(), attempts: 0 });
  ensureTimer();
  return true;
}

/** One pass: retry every entry once; drop entries past the horizon. */
export async function tickLedgerRetryQueue(now: number = Date.now()): Promise<{
  succeeded: string[];
  failed: string[];
  expired: string[];
}> {
  const s = state();
  const result = { succeeded: [] as string[], failed: [] as string[], expired: [] as string[] };
  if (s.ticking) return result;
  s.ticking = true;
  try {
    for (const entry of [...s.entries.values()]) {
      if (now - entry.enqueuedAt > LEDGER_RETRY_HORIZON_MS) {
        s.entries.delete(entry.attemptId);
        result.expired.push(entry.attemptId);
        log.error(
          `ledger completion for attempt ${entry.attemptId} abandoned after ${entry.attempts} retries (15 min horizon); the row stays for the sweeper`,
        );
        continue;
      }
      entry.attempts += 1;
      try {
        await entry.run();
        s.entries.delete(entry.attemptId);
        result.succeeded.push(entry.attemptId);
        s.onLateCompletion?.(entry.attemptId);
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        result.failed.push(entry.attemptId);
      }
    }
  } finally {
    s.ticking = false;
    stopTimerIfIdle();
  }
  return result;
}

/**
 * SIGTERM drain: attempt every queued entry exactly once, within the caller's
 * grace period. Entries that still fail are logged and dropped — the process
 * is exiting and the sweeper owns them from here.
 */
export async function drainOnShutdown(now: number = Date.now()): Promise<{
  attempted: number;
  succeeded: number;
}> {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  const attempted = s.entries.size;
  if (attempted === 0) return { attempted: 0, succeeded: 0 };
  // Bypass the ticking guard: a tick in flight would otherwise make the drain
  // a no-op right when it matters.
  s.ticking = false;
  const outcome = await tickLedgerRetryQueue(now);
  const remaining = s.entries.size;
  if (remaining > 0) {
    log.error(
      `ledger retry queue drained on shutdown with ${remaining} completion(s) still failing; the sweeper will label them incomplete`,
    );
    s.entries.clear();
  }
  return { attempted, succeeded: outcome.succeeded.length };
}

export function ledgerRetryQueueSize(): number {
  return state().entries.size;
}

/** Test/reporting seam: observe successful late writes (e.g. to log `late_completion`). */
export function onLedgerLateCompletion(handler: ((attemptId: string) => void) | undefined): void {
  state().onLateCompletion = handler;
}

/** Test seam: forget everything, stop the timer. */
export function resetLedgerRetryQueueForTests(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.ticking = false;
  s.entries.clear();
  s.onLateCompletion = undefined;
}
