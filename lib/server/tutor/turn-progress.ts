/**
 * Liveness of in-flight conversational turns (TE-1 / D5,
 * free-chat-ios-run-fix-plan §5).
 *
 * Before this, a `generating` turn whose instance died held its conversation
 * for the full 120 s TURN_IN_PROGRESS window, and the student's retry waited
 * it out. Now:
 *
 * - when a turn's stream opens, the runner calls `startTurnProgress`, which
 *   writes `progress_at` and bumps it every ~10 s until the turn ends (the
 *   timer is unref'd and cleared when the stream settles). At admission a
 *   `generating` turn with no progress for `TURN_PROGRESS_STALE_S` is stale;
 * - every running attempt is kept in a process-wide registry keyed by message
 *   id and tagged with the worker id, so on SIGTERM `markInFlightTurnsStale`
 *   marks THIS worker's in-flight attempts `failed` / `TURN_STALE` and a
 *   retry on another instance starts at once. Bounded by a timeout; never
 *   throws (a down database only logs).
 *
 * `Symbol.for` registry like the other runtime registries: the route bundle
 * and the instrumentation bundle see the same map. Nothing here logs prompt
 * or student text.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import {
  markHelpMessageProgress,
  markHelpMessagesStale,
  markMessageProgress,
  markMessagesStale,
  type InFlightAttempt,
} from '@/lib/persistence/tutor-runtime';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';

const log = createLogger('TutorTurnProgress');

/** How often a running turn refreshes `progress_at`. */
export const TURN_PROGRESS_INTERVAL_MS = 10_000;
/** A `generating` turn with no progress for this long is stale at admission. */
export const TURN_PROGRESS_STALE_S = 30;
/** Upper bound on the SIGTERM marking, so shutdown is never held up by the database. */
export const SHUTDOWN_STALE_MARK_TIMEOUT_MS = 2_000;

export type TurnProgressKind = 'conversation' | 'help_session';

interface InFlightTurn {
  messageId: string;
  kind: TurnProgressKind;
  turnAttempt: number;
  workerId: string;
  pool: Queryable;
  stop: () => void;
}

export interface TurnProgressHandle {
  /** Settles once the first `progress_at` write was attempted. Never rejects. */
  ready: Promise<void>;
  /** Clears the timer and leaves the registry. Idempotent. */
  stop: () => void;
}

const REGISTRY_KEY = Symbol.for('openmaic.tutor.in-flight-turns');

function registry(): Map<string, InFlightTurn> {
  const store = globalThis as Record<symbol, Map<string, InFlightTurn> | undefined>;
  return (store[REGISTRY_KEY] ??= new Map());
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Message ids of the attempts currently running in this process (tests, health). */
export function inFlightTurnIds(): string[] {
  return [...registry().keys()];
}

/**
 * Start the liveness mark of one attempt: write `progress_at` now, then every
 * `intervalMs` while the row is still `generating` under this attempt.
 */
export function startTurnProgress(input: {
  pool: Queryable;
  kind: TurnProgressKind;
  messageId: string;
  turnAttempt: number;
  workerId: string;
  /** Epoch ms clock. */
  now: () => number;
  intervalMs?: number;
}): TurnProgressHandle {
  const intervalMs = input.intervalMs ?? TURN_PROGRESS_INTERVAL_MS;
  const write = input.kind === 'conversation' ? markMessageProgress : markHelpMessageProgress;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let writing = false;

  const entry: InFlightTurn = {
    messageId: input.messageId,
    kind: input.kind,
    turnAttempt: input.turnAttempt,
    workerId: input.workerId,
    pool: input.pool,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (registry().get(input.messageId) === entry) registry().delete(input.messageId);
    },
  };

  const mark = async (): Promise<void> => {
    if (writing || stopped) return;
    writing = true;
    try {
      const still = await write(input.pool, input.messageId, {
        turnAttempt: input.turnAttempt,
        now: input.now() / 1000,
      });
      // Finished, failed or taken over: nothing left to keep alive.
      if (!still) entry.stop();
    } catch (error) {
      log.warn(
        JSON.stringify({
          event: 'tutor.turn_progress_failed',
          messageId: input.messageId,
          error: errorName(error),
        }),
      );
    } finally {
      writing = false;
    }
  };

  registry().set(input.messageId, entry);
  const ready = mark();
  if (intervalMs > 0) {
    timer = setInterval(() => void mark(), intervalMs);
    timer.unref?.();
  }
  return { ready, stop: entry.stop };
}

/**
 * SIGTERM: mark this worker's in-flight attempts `failed` / `TURN_STALE`.
 * Stops their progress timers first. Resolves within `timeoutMs` whatever the
 * database does and never throws; `marked` counts rows actually changed
 * (an attempt that already finished or was taken over is left alone).
 */
export async function markInFlightTurnsStale(
  options: { workerId?: string; now?: () => number; timeoutMs?: number } = {},
): Promise<{ marked: number; timedOut: boolean }> {
  const workerId = options.workerId ?? currentWorkerId();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_STALE_MARK_TIMEOUT_MS;
  const mine = [...registry().values()].filter((entry) => entry.workerId === workerId);
  if (mine.length === 0) return { marked: 0, timedOut: false };
  for (const entry of mine) entry.stop();

  const groups = new Map<Queryable, Map<TurnProgressKind, InFlightAttempt[]>>();
  for (const entry of mine) {
    const byKind = groups.get(entry.pool) ?? new Map<TurnProgressKind, InFlightAttempt[]>();
    groups.set(entry.pool, byKind);
    const attempts = byKind.get(entry.kind) ?? [];
    byKind.set(entry.kind, attempts);
    attempts.push({ id: entry.messageId, turnAttempt: entry.turnAttempt });
  }

  let marked = 0;
  const work = (async () => {
    for (const [pool, byKind] of groups) {
      for (const [kind, attempts] of byKind) {
        try {
          const markStale = kind === 'conversation' ? markMessagesStale : markHelpMessagesStale;
          marked += (await markStale(pool, attempts, { now: now() / 1000 })).length;
        } catch (error) {
          log.warn(
            JSON.stringify({
              event: 'tutor.turn_stale_mark_failed',
              kind,
              attempts: attempts.length,
              error: errorName(error),
            }),
          );
        }
      }
    }
  })();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(true), timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  log.info(
    JSON.stringify({
      event: 'tutor.turns_marked_stale_on_shutdown',
      inFlight: mine.length,
      marked,
      timedOut,
    }),
  );
  return { marked, timedOut };
}
