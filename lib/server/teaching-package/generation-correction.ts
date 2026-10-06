/**
 * The admin-correction lifecycle of a generation attempt
 * (slide-classification-admin-correction-plan §3):
 *
 *   running ──pause──▶ awaiting_admin_correction ──resume──▶ queued ──▶ running …
 *                              │  ▲ edit (revision CAS)
 *                              └──abandon──▶ failed (ADMIN_CORRECTION_ABANDONED)
 *
 * Every transition runs under the learning item's advisory lock with the
 * attempt and checkpoint rows locked, and is a compare-and-set on the attempt
 * status (and, for edits and resumes, the checkpoint revision). So:
 *
 * - a pause can never overwrite an attempt that was reclaimed or finished;
 * - two administrators can never silently overwrite each other's edits;
 * - two concurrent resumes of one revision start exactly ONE worker — the
 *   loser of the race (or a replay) gets the attempt back with `resumed: false`;
 * - the in-flight unique index counts the paused status, so no second attempt
 *   for the item can be admitted while one waits for a person.
 *
 * A paused candidate is never bound: binding still requires `running`.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  applyCheckpointEdit,
  markCheckpointAbandoned,
  markCheckpointResumed,
  readCheckpoint,
  readCheckpointForUpdate,
  upsertCheckpointForPause,
} from '@/lib/persistence/generation-checkpoint';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
import {
  markAttemptAbandoned,
  markAttemptAwaitingCorrection,
  readAttempt,
  readAttemptById,
  readAttemptForUpdate,
  requeueAttemptForResume,
} from '@/lib/persistence/teaching-package';
import { removeStageMediaDir } from '@/lib/server/classroom-storage';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { assertActorRef, itemLockKey } from '@/lib/server/teaching-package/lifecycle';
import {
  applyCorrectionOperations,
  buildCorrectionView,
  diagnoseCandidateOutlines,
  diagnosisContextFromCheckpoint,
  type CorrectionCandidate,
  type CorrectionOperation,
  type CorrectionView,
} from '@/lib/server/teaching-package/outline-correction';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import type {
  GenerationAttempt,
  GenerationCheckpoint,
  GenerationCheckpointSourceRefs,
  LearningItemRef,
  TeachingFlowEntry,
  TeachingPackageAggregateKey,
} from '@/lib/types/teaching-package';

/** The actor recorded for a pause the runner makes on its own. */
export const RUNNER_ACTOR_REF = 'system:generation-runner';
const REASON_MAX_LENGTH = 500;

const aggregateOf = (attempt: GenerationAttempt): TeachingPackageAggregateKey => ({
  tenantId: attempt.tenantId,
  learningItem: attempt.learningItem,
});

/** sha256 of the authoritative flow, pinned on the checkpoint. */
export function flowDigestOf(flow: readonly TeachingFlowEntry[]): string {
  return createHash('sha256').update(JSON.stringify(flow), 'utf8').digest('hex');
}

const flowOf = (attempt: GenerationAttempt): TeachingFlowEntry[] =>
  attempt.inputSnapshot.teachingFlow ?? [];

const isGoverned = (attempt: GenerationAttempt): boolean => attempt.teachingSkillsContract !== null;

async function lockAttempt(
  tx: Queryable,
  attemptId: string,
  scope: { tenantId: string },
): Promise<GenerationAttempt> {
  const peek = await readAttempt(tx, attemptId, scope);
  if (!peek)
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    itemLockKey(aggregateOf(peek)),
  ]);
  const locked = await readAttemptForUpdate(tx, attemptId, scope);
  if (!locked)
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  return locked;
}

function notAwaiting(attempt: GenerationAttempt, checkpoint: GenerationCheckpoint | null): never {
  throw new TeachingPackageError(
    'CORRECTION_NOT_AWAITING',
    `generation attempt ${attempt.id} is not awaiting admin correction (status ${attempt.status})`,
    {
      attemptStatus: attempt.status,
      ...(checkpoint ? { checkpointState: checkpoint.state, revision: checkpoint.revision } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Pause (runner)
// ---------------------------------------------------------------------------

/**
 * Persist the checkpoint and move `running → awaiting_admin_correction` in ONE
 * transaction with the `generation_awaiting_correction` webhook. Returns
 * `paused: false` — and writes nothing — when the attempt is no longer
 * `running` (reclaimed or finished elsewhere).
 */
export async function pauseAttemptForCorrection(
  pool: ConnectableQueryable,
  attemptId: string,
  candidate: CorrectionCandidate,
  sourceRefs: GenerationCheckpointSourceRefs,
): Promise<{ paused: boolean; checkpoint?: GenerationCheckpoint }> {
  const attempt = await readAttemptById(pool, attemptId);
  if (!attempt) return { paused: false };
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const locked = await lockAttempt(tx, attemptId, { tenantId: attempt.tenantId });
    if (locked.status !== 'running') return { paused: false };
    const now = Date.now();
    const checkpoint = await upsertCheckpointForPause(tx, {
      attemptId,
      tenantId: locked.tenantId,
      phase: candidate.phase,
      outlines: candidate.outlines,
      courseTitle: candidate.courseTitle,
      languageDirective: candidate.languageDirective,
      diagnostics: candidate.diagnostics,
      repairs: candidate.repairs,
      sourceRefs,
      reservedStageId: candidate.reservedStageId ?? null,
      pendingOutlineIds: candidate.pendingOutlineIds ?? null,
      actorRef: RUNNER_ACTOR_REF,
      now,
    });
    const paused = await markAttemptAwaitingCorrection(tx, attemptId, {
      step: candidate.phase === 'outline' ? 'generating_outlines' : 'generating_scenes',
      progress: candidate.phase === 'outline' ? 30 : 90,
      message: `Needs admin correction: ${candidate.diagnostics.length} issue(s)`,
      scenesGenerated: 0,
      totalScenes: candidate.outlines.length,
    });
    if (!paused) return { paused: false };
    await enqueueWebhookEvent(
      tx,
      aggregateOf(paused),
      'teaching_package.generation_awaiting_correction',
      () => ({
        requestId: paused.requestId ?? '',
        attempt: {
          id: paused.id,
          kind: paused.kind,
          status: 'awaiting_admin_correction',
          versionId: paused.versionId,
          startedAt: paused.startedAt,
          pausedAt: now,
          generationRuns: paused.generationRuns,
        },
        correction: {
          phase: checkpoint.phase,
          revision: checkpoint.revision,
          blockingIssueCount: checkpoint.diagnostics.length,
        },
      }),
    );
    return { paused: true, checkpoint };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The administrator's view of a paused (or previously paused) attempt. */
export async function getGenerationCorrection(
  pool: Queryable,
  attemptId: string,
  scope: { tenantId: string },
): Promise<CorrectionView> {
  const attempt = await readAttempt(pool, attemptId, scope);
  if (!attempt)
    throw new TeachingPackageError('NOT_FOUND', `generation attempt ${attemptId} not found`);
  const checkpoint = await readCheckpoint(pool, attemptId, scope);
  if (!checkpoint) notAwaiting(attempt, null);
  return buildCorrectionView(attempt, checkpoint, flowOf(attempt));
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface EditCorrectionCommand {
  tenantId: string;
  actorRef: string;
  expectedRevision: number;
  operations: CorrectionOperation[];
}

/**
 * Apply an administrator's operations to the paused candidate, revalidate it
 * with the run's own diagnosis, and store it as the next revision.
 */
export async function editGenerationCorrection(
  pool: ConnectableQueryable,
  attemptId: string,
  command: EditCorrectionCommand,
): Promise<CorrectionView> {
  const actorRef = assertActorRef(command.actorRef);
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId, { tenantId: command.tenantId });
    const checkpoint = await readCheckpointForUpdate(tx, attemptId, { tenantId: command.tenantId });
    if (
      !checkpoint ||
      checkpoint.state !== 'awaiting' ||
      attempt.status !== 'awaiting_admin_correction'
    ) {
      notAwaiting(attempt, checkpoint);
    }
    if (checkpoint.revision !== command.expectedRevision) {
      throw new TeachingPackageError(
        'STALE_STATE',
        `the correction was edited since revision ${command.expectedRevision}; reload it`,
        { currentRevision: checkpoint.revision },
      );
    }
    const flow = flowOf(attempt);
    const edited = applyCorrectionOperations(checkpoint.outlines, command.operations, {
      phase: checkpoint.phase,
      flow,
      sourceRefs: checkpoint.sourceRefs,
      pendingOutlineIds: checkpoint.pendingOutlineIds,
    });
    const diagnosis = diagnoseCandidateOutlines(
      edited,
      diagnosisContextFromCheckpoint(checkpoint, flow, isGoverned(attempt)),
    );
    const now = Date.now();
    const updated = await applyCheckpointEdit(tx, attemptId, {
      tenantId: command.tenantId,
      expectedRevision: command.expectedRevision,
      outlines: diagnosis.outlines,
      diagnostics: diagnosis.blocking,
      repairs: [...checkpoint.repairs, ...diagnosis.repairs],
      logEntry: {
        event: 'edited',
        actorRef,
        at: now,
        operations: command.operations,
        blockingCount: diagnosis.blocking.length,
      },
      now,
    });
    if (!updated) {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the correction changed concurrently; reload it',
      );
    }
    return buildCorrectionView(attempt, updated, flow);
  });
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export interface ResumeCorrectionCommand {
  tenantId: string;
  actorRef: string;
  expectedRevision: number;
  /** Canonical digest of the re-sent request (fresh retrieval URLs, same semantics). */
  requestDigest: string;
  learningItem: LearningItemRef;
}

/**
 * `awaiting_admin_correction → queued` for the SAME attempt, after proving the
 * re-sent request is the attempt's own (canonical digest), the revision is the
 * one the administrator validated, and the candidate has no open issue. A
 * replay of an already-resumed revision returns the attempt with
 * `resumed: false` and must not start a worker.
 */
export async function resumeGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  command: ResumeCorrectionCommand,
): Promise<{ attempt: GenerationAttempt; resumed: boolean }> {
  const actorRef = assertActorRef(command.actorRef);
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId, { tenantId: command.tenantId });
    if (
      attempt.learningItem.type !== command.learningItem.type ||
      attempt.learningItem.id !== command.learningItem.id
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'the resume request names a different learning item than the attempt',
      );
    }
    const checkpoint = await readCheckpointForUpdate(tx, attemptId, { tenantId: command.tenantId });
    if (!checkpoint) notAwaiting(attempt, null);
    if (checkpoint.state === 'resumed' && checkpoint.resumedRevision === command.expectedRevision) {
      return { attempt, resumed: false };
    }
    if (checkpoint.state !== 'awaiting' || attempt.status !== 'awaiting_admin_correction') {
      notAwaiting(attempt, checkpoint);
    }
    if (checkpoint.revision !== command.expectedRevision) {
      throw new TeachingPackageError(
        'STALE_STATE',
        `the correction is at revision ${checkpoint.revision}, not ${command.expectedRevision}`,
        { currentRevision: checkpoint.revision },
      );
    }
    if (attempt.requestDigest === null || attempt.requestDigest !== command.requestDigest) {
      throw new TeachingPackageError(
        'CORRECTION_REQUEST_MISMATCH',
        'the re-sent generation request is not the request this attempt was started with',
      );
    }
    // Revalidate at the boundary — never trust stored diagnostics alone.
    const flow = flowOf(attempt);
    const diagnosis = diagnoseCandidateOutlines(
      checkpoint.outlines,
      diagnosisContextFromCheckpoint(checkpoint, flow, isGoverned(attempt)),
    );
    if (diagnosis.blocking.length > 0) {
      throw new TeachingPackageError(
        'CORRECTION_INCOMPLETE',
        `${diagnosis.blocking.length} issue(s) still need correction before this attempt can resume`,
        { blockingIssues: diagnosis.blocking.slice(0, 20) },
      );
    }
    const now = Date.now();
    const marked = await markCheckpointResumed(tx, attemptId, {
      tenantId: command.tenantId,
      revision: checkpoint.revision,
      actorRef,
      now,
    });
    const requeued = marked
      ? await requeueAttemptForResume(tx, attemptId, now, {
          step: checkpoint.phase === 'outline' ? 'generating_outlines' : 'generating_scenes',
          progress: checkpoint.phase === 'outline' ? 30 : 90,
          message: 'Resuming after admin correction',
          scenesGenerated: 0,
          totalScenes: checkpoint.outlines.length,
        })
      : null;
    if (!requeued) {
      throw new TeachingPackageError('STALE_STATE', 'the attempt changed concurrently; reload it');
    }
    return { attempt: requeued, resumed: true };
  });
}

// ---------------------------------------------------------------------------
// Abandon
// ---------------------------------------------------------------------------

export interface AbandonCorrectionCommand {
  tenantId: string;
  actorRef: string;
  reason: string;
}

/**
 * Give up a paused candidate: the attempt fails with the retryable
 * `ADMIN_CORRECTION_ABANDONED` (so a new generation can be requested), a
 * retained Stage is compensated after the commit, and the failure webhook is
 * emitted. Idempotent on an already-abandoned attempt.
 */
export async function abandonGenerationAttempt(
  pool: ConnectableQueryable,
  attemptId: string,
  command: AbandonCorrectionCommand,
): Promise<{ attempt: GenerationAttempt; abandoned: boolean }> {
  const actorRef = assertActorRef(command.actorRef);
  const reason = command.reason?.trim() ?? '';
  if (!reason) {
    throw new TeachingPackageError(
      'REASON_REQUIRED',
      'a reason is required to abandon a correction',
    );
  }
  if (reason.length > REASON_MAX_LENGTH) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      `reason must be at most ${REASON_MAX_LENGTH} characters`,
    );
  }
  const withTransaction = nodePostgresTransaction(pool);
  const outcome = await withTransaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId, { tenantId: command.tenantId });
    if (attempt.status === 'failed' && attempt.errorCode === 'ADMIN_CORRECTION_ABANDONED') {
      return { attempt, abandoned: false, stageId: null as string | null };
    }
    const checkpoint = await readCheckpointForUpdate(tx, attemptId, { tenantId: command.tenantId });
    if (
      !checkpoint ||
      checkpoint.state !== 'awaiting' ||
      attempt.status !== 'awaiting_admin_correction'
    ) {
      notAwaiting(attempt, checkpoint);
    }
    const now = Date.now();
    await markCheckpointAbandoned(tx, attemptId, {
      tenantId: command.tenantId,
      actorRef,
      reason,
      now,
    });
    const failed = await markAttemptAbandoned(tx, attemptId, {
      message: `abandoned by an administrator: ${reason}`,
      code: 'ADMIN_CORRECTION_ABANDONED',
      now,
    });
    if (!failed) throw new TeachingPackageError('STALE_STATE', 'the attempt changed concurrently');
    await enqueueWebhookEvent(
      tx,
      aggregateOf(failed),
      'teaching_package.generation_failed',
      () => ({
        requestId: failed.requestId ?? '',
        attempt: {
          id: failed.id,
          kind: failed.kind,
          status: 'failed',
          versionId: failed.versionId,
          producedStageId: failed.producedStageId,
          startedAt: failed.startedAt,
          completedAt: now,
          generationRuns: failed.generationRuns,
        },
        error: {
          code: 'ADMIN_CORRECTION_ABANDONED',
          message: `abandoned by an administrator: ${reason}`.slice(0, 500),
          retryable: true,
        },
      }),
    );
    return { attempt: failed, abandoned: true, stageId: checkpoint.reservedStageId };
  });
  // Irreversible filesystem work only after the commit: the retained Stage was
  // never bound, so the guard allows its tombstone.
  if (outcome.abandoned && outcome.stageId) {
    await tombstoneStageMeta(pool as Queryable, outcome.stageId).catch(() => {});
    await removeStageMediaDir(outcome.stageId).catch(() => {});
  }
  return { attempt: outcome.attempt, abandoned: outcome.abandoned };
}
