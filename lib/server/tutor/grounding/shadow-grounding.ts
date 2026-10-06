/**
 * Shadow comparison (discovery-first plan P6): with `TUTOR_GROUNDING_SOURCE=shadow`
 * the existing `kafuo_http` path SERVES the turn, and on a sampled retrieve turn
 * the direct path runs concurrently in the background. The comparison (unit and
 * item ids, outcomes, counts and timings — never text, titles or vectors) is
 * logged as `tutor.grounding_shadow` and merged into that turn's
 * `tutor_turn_groundings.resolution` (`shadow` + `shadowComparison`) once the
 * turn has committed.
 *
 * It never affects the student's turn:
 *  - nothing in the turn awaits it; its reader calls use their own clock;
 *  - it writes no snapshot, association or clarification;
 *  - a scope refusal, a busy pool, a thrown error or a timeout on the direct
 *    side is RECORDED, never thrown (the HTTP path alone decides the turn);
 *  - the audit merge runs after the completion transaction commits
 *    (`signalShadowTurnCommitted` from the post-commit hook), on its own
 *    statement, and only for the attempt that launched it.
 *
 * `resolution.shadow` is a status string: `not_available` (no reader wired),
 * `not_sampled`, `pending` (written with the turn) and then `compared`
 * (with `shadowComparison`). Leakage (a direct unit outside the student's
 * scope) cannot be proven from here; the operator query in the backend
 * `chat_grounding` README joins the recorded unit ids against Kafuo scope.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';

import { RetrievalClock, retrieveDirect, type RetrievalTimings } from './direct-grounding';
import type { DirectGroundingDeps, GroundingReaderScope } from './kafuo-grounding-reader';

const log = createLogger('TutorGroundingShadow');

/** How long a finished comparison waits for its turn to commit (a turn can stream ~2 min). */
export const SHADOW_COMMIT_WAIT_MS = 180_000;

export type ShadowStatus = 'not_available' | 'not_sampled' | 'pending';

export interface HttpShadowSide {
  outcome: 'retrieved' | 'insufficient' | 'refused';
  reason: string | null;
  unitIds: string[];
  /** The HTTP `lessonId` of each unit, aligned with `unitIds` (null when Kafuo sent none). */
  unitLessonIds: Array<string | null>;
  lessonIds: string[];
  ms: number;
}

export interface DirectShadowSide {
  outcome: 'retrieved' | 'clarify' | 'insufficient' | 'refused' | 'error';
  reason: string | null;
  resolutionOutcome: string | null;
  candidateItemIds: string[];
  itemIds: string[];
  unitIds: string[];
  /** The learning item of each unit, aligned with `unitIds`. */
  unitItemIds: string[];
  embeddingModel: string | null;
  timings: RetrievalTimings | null;
  ms: number;
}

export interface ShadowComparison {
  sampleRate: number;
  http: HttpShadowSide;
  direct: DirectShadowSide;
  overlap: {
    units: { both: number; httpOnly: number; directOnly: number; jaccard: number | null };
    /**
     * Item agreement through the shared units. The two id spaces differ (HTTP:
     * lesson ids; direct: learning-item ids), so they are paired, not
     * intersected; an exact item ↔ lesson check is a Kafuo-side join on
     * `learning_items.lesson_id`.
     */
    items: {
      directItems: number;
      httpLessons: number;
      directItemsWithSharedUnits: number;
      httpLessonsWithSharedUnits: number;
      /** Distinct `[httpLessonId, directItemId]` pairs of the shared units. */
      pairs: Array<[string | null, string]>;
    };
    /** Both sides grounded the turn, or neither did. */
    groundedAgrees: boolean;
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The direct retrieval for this question, as ids/outcomes/timings only. Never throws. */
export async function runDirectShadow(
  direct: DirectGroundingDeps,
  scope: GroundingReaderScope,
  text: string,
): Promise<DirectShadowSide> {
  const startedAt = performance.now();
  const clock = new RetrievalClock();
  const base = {
    reason: null,
    resolutionOutcome: null,
    candidateItemIds: [] as string[],
    itemIds: [] as string[],
    unitIds: [] as string[],
    unitItemIds: [] as string[],
    embeddingModel: null,
  };
  try {
    const result = await retrieveDirect(direct, scope, { text }, clock);
    const resolution = result.resolution as {
      outcome?: unknown;
      candidates?: Array<{ itemId?: unknown }>;
    };
    const common = {
      ...base,
      resolutionOutcome: typeof resolution.outcome === 'string' ? resolution.outcome : null,
      candidateItemIds: (resolution.candidates ?? [])
        .map((candidate) => candidate.itemId)
        .filter((id): id is string => typeof id === 'string'),
      timings: clock.snapshot(),
      ms: round(performance.now() - startedAt),
    };
    if (result.kind === 'retrieved') {
      return {
        ...common,
        outcome: 'retrieved',
        itemIds: result.items.map((item) => item.itemId),
        unitIds: result.units.map((unit) => unit.contentUnitId),
        unitItemIds: result.units.map((unit) => unit.learningItemId),
        embeddingModel: result.embedding.model,
      };
    }
    if (result.kind === 'clarify') {
      return { ...common, outcome: 'clarify', reason: 'clarification' };
    }
    return {
      ...common,
      outcome: 'insufficient',
      reason: result.reason,
      embeddingModel: result.embedding?.model ?? null,
    };
  } catch (error) {
    // `accessLost` (D-18) on the direct side: recorded, never refuses the turn.
    const code = (error as { code?: unknown } | null)?.code;
    const refused = code === 'SUBJECT_NO_LONGER_AVAILABLE';
    return {
      ...base,
      outcome: refused ? 'refused' : 'error',
      reason: refused ? 'scope_refused' : 'error',
      timings: clock.snapshot(),
      ms: round(performance.now() - startedAt),
    };
  }
}

export function compareShadow(
  sampleRate: number,
  http: HttpShadowSide,
  direct: DirectShadowSide,
): ShadowComparison {
  const httpUnits = new Set(http.unitIds);
  const directUnits = new Set(direct.unitIds);
  const shared = [...directUnits].filter((id) => httpUnits.has(id));
  const both = shared.length;
  const union = httpUnits.size + directUnits.size - both;
  const httpLessonOf = new Map(
    http.unitIds.map((id, index) => [id, http.unitLessonIds[index] ?? null]),
  );
  const directItemOf = new Map(direct.unitIds.map((id, index) => [id, direct.unitItemIds[index]!]));
  const pairs = new Map<string, [string | null, string]>();
  for (const id of shared) {
    const pair: [string | null, string] = [httpLessonOf.get(id) ?? null, directItemOf.get(id)!];
    pairs.set(JSON.stringify(pair), pair);
  }
  const sharedItems = new Set(shared.map((id) => directItemOf.get(id)!));
  const sharedLessons = new Set(
    shared.map((id) => httpLessonOf.get(id)).filter((id): id is string => typeof id === 'string'),
  );
  return {
    sampleRate,
    http,
    direct,
    overlap: {
      units: {
        both,
        httpOnly: httpUnits.size - both,
        directOnly: directUnits.size - both,
        jaccard: union === 0 ? null : round(both / union),
      },
      items: {
        directItems: new Set(direct.itemIds).size,
        httpLessons: new Set(http.lessonIds).size,
        directItemsWithSharedUnits: sharedItems.size,
        httpLessonsWithSharedUnits: sharedLessons.size,
        pairs: [...pairs.values()],
      },
      groundedAgrees: (http.outcome === 'retrieved') === (direct.outcome === 'retrieved'),
    },
  };
}

/** Merge into the launching attempt's audit row only (a retry rewrites the row). */
export async function recordShadowComparison(
  q: Queryable,
  turnId: string,
  turnAttempt: number,
  status: 'compared',
  comparison: ShadowComparison | null,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE tutor_turn_groundings
        SET resolution = COALESCE(resolution, '{}'::jsonb)
              || jsonb_build_object('shadow', $3::text, 'shadowComparison', $4::jsonb)
      WHERE turn_id = $1
        AND COALESCE((assessment->>'turnAttempt')::int, 1) = $2
      RETURNING turn_id`,
    [turnId, turnAttempt, status, comparison ? JSON.stringify(comparison) : null],
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Commit signal: the shadow job waits for its turn's completion transaction
// ---------------------------------------------------------------------------

const PENDING_KEY = Symbol.for('openmaic.tutor.grounding-shadow-pending');

function pending(): Map<string, () => void> {
  const registry = globalThis as Record<symbol, Map<string, () => void> | undefined>;
  return (registry[PENDING_KEY] ??= new Map());
}

function pendingKey(turnId: string, turnAttempt: number): string {
  return `${turnId}#${turnAttempt}`;
}

/** Called after the turn's completion transaction committed (any outcome). */
export function signalShadowTurnCommitted(turnId: string, turnAttempt: number): void {
  const key = pendingKey(turnId, turnAttempt);
  const resolve = pending().get(key);
  if (resolve) {
    pending().delete(key);
    resolve();
  }
}

/** Number of comparisons waiting for their turn to commit (tests, health). */
export function pendingShadowCount(): number {
  return pending().size;
}

function waitForCommit(turnId: string, turnAttempt: number, timeoutMs: number) {
  const key = pendingKey(turnId, turnAttempt);
  let settle: (committed: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  // Both closures run only after `timer` is set below.
  pending().set(key, () => {
    clearTimeout(timer);
    settle(true);
  });
  const cancel = () => {
    if (pending().get(key)) pending().delete(key);
    clearTimeout(timer);
    settle(false);
  };
  const timer = setTimeout(cancel, timeoutMs);
  timer.unref?.();
  return { promise, cancel };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export interface ShadowLaunch {
  direct: DirectGroundingDeps;
  scope: GroundingReaderScope;
  text: string;
  turnId: string;
  turnAttempt: number;
  sampleRate: number;
  pool: Queryable;
  commitWaitMs?: number;
}

export interface ShadowRun {
  /** Settle the HTTP side (the served result) once it is known. */
  settleHttp(side: HttpShadowSide): void;
  /** The background job (for the caller's background registry); never rejects. */
  done: Promise<void>;
}

/**
 * Starts the direct path NOW (concurrently with the HTTP call) and returns at
 * once. The job finishes on its own: compare → log → wait for the commit →
 * merge into the audit row.
 */
export function launchGroundingShadow(input: ShadowLaunch): ShadowRun {
  const waitMs = input.commitWaitMs ?? SHADOW_COMMIT_WAIT_MS;
  let settleHttp: (side: HttpShadowSide) => void = () => undefined;
  const httpSide = new Promise<HttpShadowSide>((resolve) => {
    settleHttp = resolve;
  });
  const commit = waitForCommit(input.turnId, input.turnAttempt, waitMs);
  const directSide = runDirectShadow(input.direct, input.scope, input.text);
  // Never wait forever: an HTTP side that is never settled (an unexpected
  // throw before it) ends the job at the same deadline as the commit wait.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), waitMs);
    deadlineTimer.unref?.();
  });

  const done = (async () => {
    try {
      const sides = await Promise.race([Promise.all([httpSide, directSide]), deadline]);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (sides === null) {
        commit.cancel();
        return;
      }
      const [http, direct] = sides;
      const comparison = compareShadow(input.sampleRate, http, direct);
      log.info(
        JSON.stringify({
          event: 'tutor.grounding_shadow',
          turnId: input.turnId,
          turnAttempt: input.turnAttempt,
          http: {
            outcome: http.outcome,
            reason: http.reason,
            units: http.unitIds.length,
            ms: http.ms,
          },
          direct: {
            outcome: direct.outcome,
            reason: direct.reason,
            resolution: direct.resolutionOutcome,
            units: direct.unitIds.length,
            items: direct.itemIds,
            ms: direct.ms,
            poolWaitMs: direct.timings?.poolWaitMs ?? null,
          },
          overlap: comparison.overlap,
        }),
      );
      if (http.outcome === 'refused') {
        // The turn itself was refused (D-18): no audit row will be written.
        commit.cancel();
        return;
      }
      if (!(await commit.promise)) return;
      await recordShadowComparison(
        input.pool,
        input.turnId,
        input.turnAttempt,
        'compared',
        comparison,
      );
    } catch (error) {
      commit.cancel();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      log.warn(
        JSON.stringify({
          event: 'tutor.grounding_shadow_failed',
          turnId: input.turnId,
          error: error instanceof Error ? error.name : 'error',
        }),
      );
    }
  })();
  return { settleHttp, done };
}
