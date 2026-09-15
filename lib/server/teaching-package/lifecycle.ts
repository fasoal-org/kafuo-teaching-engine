/**
 * Teaching Package lifecycle service (plan §5). One exported entry point per
 * command; every command runs one `nodePostgresTransaction(pool)` that takes
 * the locks in the fixed order, validates against the locked row, mutates,
 * and appends the review event(s) INSIDE the same transaction, so state and
 * history can never diverge.
 *
 * LOCK ORDER INVARIANT (§15, mandatory):
 *   pg_advisory_xact_lock(item) → stage_meta(stage ids ascending) FOR UPDATE
 *   → teaching_package_versions(version ids) FOR UPDATE → writes → events.
 * The stage guard reads versions FOR SHARE while holding stage_meta; it never
 * takes the advisory lock, so both orders are `stage_meta → versions` and no
 * lock cycle exists.
 *
 * Routes never contain transition logic; they parse and call one command.
 */
import { readStageFreshnessManifest } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  appendReviewEvent,
  insertVersion,
  markAttemptDisplaced,
  nextVersionNumber,
  readActiveVersion,
  readApprovedVersion,
  readVersion,
  readVersionForUpdate,
  relinkVersionStage,
  updateVersionStatus,
} from '@/lib/persistence/teaching-package';
import { tombstoneStageMeta } from '@/lib/persistence/stage-meta';
import { isPgUniqueViolation, TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { cloneStageForSuccessor } from '@/lib/server/teaching-package/stage-clone';
import { randomBytes } from 'node:crypto';
import type {
  GenerationAttempt,
  LearningItemRef,
  ReviewEventType,
  TeachingPackageStatus,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

const ACTOR_REF_MAX_LENGTH = 256;
const COMMENT_MAX_LENGTH = 4000;
const REASON_MAX_LENGTH = 4000;

export interface LifecycleCommandContext {
  versionId: string;
  actorRef: string;
  /** When supplied, must equal the locked row's status (409 STALE_STATE). */
  expectedStatus?: TeachingPackageStatus;
  comment?: string;
}

function assertActorRef(actorRef: string): string {
  const trimmed = actorRef?.trim();
  if (!trimmed) {
    throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a non-empty string');
  }
  if (trimmed.length > ACTOR_REF_MAX_LENGTH) {
    throw new TeachingPackageError(
      'ACTOR_REQUIRED',
      `actorRef must be at most ${ACTOR_REF_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

function assertComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  if (comment.length > COMMENT_MAX_LENGTH) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      `comment must be at most ${COMMENT_MAX_LENGTH} characters`,
    );
  }
  return comment;
}

function itemLockKey(item: LearningItemRef): string {
  return `teaching-package:${item.type}:${item.id}`;
}

interface StageMetaLockRow extends Record<string, unknown> {
  owner_id: string;
  deleted_at: Date | string | null;
}

/** Lock one Stage's meta row and require it live (deleted_at IS NULL). */
async function lockStageMetaLive(tx: Queryable, stageId: string): Promise<void> {
  const result = await tx.query<StageMetaLockRow>(
    `SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 FOR UPDATE`,
    [stageId],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at !== null) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', `stage ${stageId} is not live`);
  }
}

/** Lock several Stages' meta rows in ascending id order (fixed lock order). */
async function lockStageMetaLiveSorted(tx: Queryable, stageIds: string[]): Promise<void> {
  for (const stageId of [...stageIds].sort()) {
    await lockStageMetaLive(tx, stageId);
  }
}

function invalidTransition(from: TeachingPackageStatus, to: string): TeachingPackageError {
  return new TeachingPackageError('INVALID_TRANSITION', `cannot ${to} from status "${from}"`, {
    from,
  });
}

/**
 * Shared command runner: actor validation, transaction, advisory item lock,
 * expectedStatus check, then the command body against the locked row.
 */
async function runLifecycleCommand<T>(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext,
  body: (
    tx: Queryable,
    locked: TeachingPackageVersion,
    actorRef: string,
    now: number,
  ) => Promise<T>,
): Promise<T> {
  const actorRef = assertActorRef(command.actorRef);
  assertComment(command.comment);
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    // The advisory lock key needs the Learning Item, which only the row knows;
    // this plain read takes no lock, and every decision below re-reads FOR
    // UPDATE after the advisory lock is held.
    const current = await readVersion(tx, command.versionId);
    if (!current) {
      throw new TeachingPackageError(
        'NOT_FOUND',
        `teaching package ${command.versionId} not found`,
      );
    }
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      itemLockKey(current.learningItem),
    ]);

    const locked = await readVersionForUpdate(tx, command.versionId);
    if (!locked) {
      throw new TeachingPackageError(
        'NOT_FOUND',
        `teaching package ${command.versionId} not found`,
      );
    }
    if (command.expectedStatus !== undefined && command.expectedStatus !== locked.status) {
      throw new TeachingPackageError(
        'STALE_STATE',
        `expected status "${command.expectedStatus}" but the version is "${locked.status}"`,
        { currentStatus: locked.status },
      );
    }
    return body(tx, locked, actorRef, Date.now());
  });
}

function appendEvent(
  tx: Queryable,
  event: {
    versionId: string;
    eventType: ReviewEventType;
    fromStatus: TeachingPackageStatus | null;
    toStatus: TeachingPackageStatus;
    actorRef: string;
    reason?: string | null;
    comment?: string | null;
    relatedVersionId?: string | null;
    data?: Record<string, unknown> | null;
    createdAt: number;
  },
): Promise<unknown> {
  return appendReviewEvent(tx, event);
}

/** Submit for review: draft|rejected → in_review; captures the stage revision. */
export async function submitForReview(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext,
): Promise<TeachingPackageVersion> {
  return runLifecycleCommand(pool, command, async (tx, locked, actorRef, now) => {
    if (locked.status !== 'draft' && locked.status !== 'rejected') {
      throw invalidTransition(locked.status, 'submit for review');
    }
    await lockStageMetaLive(tx, locked.currentStageId);
    const manifest = await readStageFreshnessManifest(locked.currentStageId, tx);
    const updated = await updateVersionStatus(tx, locked.id, {
      status: 'in_review',
      submittedAt: now,
      submittedStageRev: manifest?.rev ?? 0,
      now,
    });
    await appendEvent(tx, {
      versionId: locked.id,
      eventType: locked.status === 'draft' ? 'submitted_for_review' : 'resubmitted',
      fromStatus: locked.status,
      toStatus: 'in_review',
      actorRef,
      comment: command.comment ?? null,
      createdAt: now,
    });
    return updated!;
  });
}

/** Start a manual review edit: in_review → draft; clears the captured revision. */
export async function startReviewEdit(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext,
): Promise<TeachingPackageVersion> {
  return runLifecycleCommand(pool, command, async (tx, locked, actorRef, now) => {
    if (locked.status !== 'in_review') {
      throw invalidTransition(locked.status, 'start a review edit');
    }
    const updated = await updateVersionStatus(tx, locked.id, {
      status: 'draft',
      submittedStageRev: null,
      now,
    });
    await appendEvent(tx, {
      versionId: locked.id,
      eventType: 'review_edit_started',
      fromStatus: locked.status,
      toStatus: 'draft',
      actorRef,
      comment: command.comment ?? null,
      createdAt: now,
    });
    return updated!;
  });
}

/** Reject: in_review → rejected. A meaningful reason is mandatory (BR-035). */
export async function reject(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext & { reason: string },
): Promise<TeachingPackageVersion> {
  const reason = command.reason?.trim() ?? '';
  if (reason.length === 0) {
    throw new TeachingPackageError(
      'REASON_REQUIRED',
      'a rejection requires a non-empty reason (1..4000 characters)',
    );
  }
  if (reason.length > REASON_MAX_LENGTH) {
    throw new TeachingPackageError(
      'REASON_REQUIRED',
      `a rejection reason must be at most ${REASON_MAX_LENGTH} characters`,
    );
  }
  return runLifecycleCommand(pool, command, async (tx, locked, actorRef, now) => {
    if (locked.status !== 'in_review') {
      throw invalidTransition(locked.status, 'reject');
    }
    const updated = await updateVersionStatus(tx, locked.id, {
      status: 'rejected',
      now,
    });
    await appendEvent(tx, {
      versionId: locked.id,
      eventType: 'rejected',
      fromStatus: locked.status,
      toStatus: 'rejected',
      actorRef,
      reason,
      comment: command.comment ?? null,
      createdAt: now,
    });
    return updated!;
  });
}

/**
 * Approve: in_review → approved, atomically superseding the item's previous
 * approved version (BR-047). Demote first, then promote; both updates and both
 * events are one transaction. The submitted experience must be unchanged since
 * submission (revision re-check), and a single-approved index violation maps
 * to APPROVAL_CONFLICT.
 */
export async function approve(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext,
): Promise<TeachingPackageVersion> {
  return runLifecycleCommand(pool, command, async (tx, locked, actorRef, now) => {
    if (locked.status !== 'in_review') {
      throw invalidTransition(locked.status, 'approve');
    }
    await lockStageMetaLive(tx, locked.currentStageId);
    if (locked.submittedStageRev === null) {
      throw new TeachingPackageError(
        'STAGE_CHANGED_SINCE_SUBMISSION',
        'the version has no captured submission revision',
      );
    }
    const manifest = await readStageFreshnessManifest(locked.currentStageId, tx);
    const currentRev = manifest?.rev ?? 0;
    if (currentRev !== locked.submittedStageRev) {
      throw new TeachingPackageError(
        'STAGE_CHANGED_SINCE_SUBMISSION',
        'the stage changed after submission; submit the current experience for review again',
        { submittedStageRev: locked.submittedStageRev, currentRev },
      );
    }

    const predecessor = await readApprovedVersion(tx, locked.learningItem);
    if (predecessor && predecessor.id !== locked.id) {
      const lockedPredecessor = await readVersionForUpdate(tx, predecessor.id);
      try {
        await updateVersionStatus(tx, lockedPredecessor!.id, {
          status: 'superseded',
          supersededAt: now,
          supersededByVersionId: locked.id,
          now,
        });
        await appendEvent(tx, {
          versionId: lockedPredecessor!.id,
          eventType: 'superseded',
          fromStatus: 'approved',
          toStatus: 'superseded',
          actorRef,
          relatedVersionId: locked.id,
          createdAt: now,
        });
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          throw new TeachingPackageError(
            'APPROVAL_CONFLICT',
            'another version is already approved for this learning item',
          );
        }
        throw error;
      }
    }

    try {
      const updated = await updateVersionStatus(tx, locked.id, {
        status: 'approved',
        approvedAt: now,
        now,
      });
      await appendEvent(tx, {
        versionId: locked.id,
        eventType: 'approved',
        fromStatus: 'in_review',
        toStatus: 'approved',
        actorRef,
        comment: command.comment ?? null,
        relatedVersionId: predecessor && predecessor.id !== locked.id ? predecessor.id : null,
        createdAt: now,
      });
      return updated!;
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new TeachingPackageError(
          'APPROVAL_CONFLICT',
          'another version is already approved for this learning item',
        );
      }
      throw error;
    }
  });
}

/**
 * Discard a never-approved successor: draft|rejected (with a predecessor) →
 * discarded (terminal). An in_review successor must first start an edit or be
 * rejected; v1, approved, superseded, and discarded versions are refused.
 */
export async function discardSuccessor(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext,
): Promise<TeachingPackageVersion> {
  return runLifecycleCommand(pool, command, async (tx, locked, actorRef, now) => {
    if (locked.status === 'in_review') {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        'an in_review successor must start an edit or be rejected before it can be discarded',
      );
    }
    if (
      locked.status === 'approved' ||
      locked.status === 'superseded' ||
      locked.status === 'discarded'
    ) {
      throw invalidTransition(locked.status, 'discard');
    }
    if (locked.predecessorVersionId === null) {
      throw new TeachingPackageError(
        'NOT_A_SUCCESSOR',
        'only a never-approved successor may be discarded; version 1 has no predecessor',
      );
    }
    const updated = await updateVersionStatus(tx, locked.id, {
      status: 'discarded',
      discardedAt: now,
      now,
    });
    await appendEvent(tx, {
      versionId: locked.id,
      eventType: 'discarded',
      fromStatus: locked.status,
      toStatus: 'discarded',
      actorRef,
      comment: command.comment ?? null,
      createdAt: now,
    });
    return updated!;
  });
}

/**
 * Create a draft successor from an approved version (§5/§7): clone the
 * approved Stage server-side first, then insert the new version row in one
 * lifecycle transaction. The clone commits atomically on its own; if the
 * version transaction then fails, compensation tombstones the orphan clone
 * (it is unreferenced, so the guard allows it) and the error is rethrown —
 * no Stage-less or Stage-dangling version can exist.
 */
export async function createSuccessor(
  pool: ConnectableQueryable,
  command: { versionId: string; actorRef: string; comment?: string },
): Promise<TeachingPackageVersion> {
  const actorRef = assertActorRef(command.actorRef);
  assertComment(command.comment);

  const source = await readVersion(pool, command.versionId);
  if (!source) {
    throw new TeachingPackageError('NOT_FOUND', `teaching package ${command.versionId} not found`);
  }
  if (source.status !== 'approved') {
    throw invalidTransition(source.status, 'create a successor from');
  }
  const active = await readActiveVersion(pool, source.learningItem);
  if (active) {
    throw new TeachingPackageError(
      'ACTIVE_SUCCESSOR_EXISTS',
      `learning item ${source.learningItem.type}:${source.learningItem.id} already has an active successor (version ${active.version})`,
      { activeVersionId: active.id },
    );
  }

  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const { stageId } = await cloneStageForSuccessor(store, source.currentStageId, {
    producerRef: source.id,
  });

  const withTransaction = nodePostgresTransaction(pool);
  try {
    return await withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        itemLockKey(source.learningItem),
      ]);
      const lockedSource = await readVersionForUpdate(tx, command.versionId);
      if (!lockedSource || lockedSource.status !== 'approved') {
        throw new TeachingPackageError(
          'INVALID_TRANSITION',
          'the source version is no longer approved',
        );
      }
      const racedActive = await readActiveVersion(tx, lockedSource.learningItem);
      if (racedActive) {
        throw new TeachingPackageError(
          'ACTIVE_SUCCESSOR_EXISTS',
          'another successor became active while this one was being created',
          { activeVersionId: racedActive.id },
        );
      }
      const versionNumber = await nextVersionNumber(tx, lockedSource.learningItem);
      const now = Date.now();
      try {
        const created = await insertVersion(tx, {
          id: `tpv-${randomBytes(9).toString('base64url')}`,
          learningItem: lockedSource.learningItem,
          version: versionNumber,
          status: 'draft',
          currentStageId: stageId,
          currentAttemptId: null,
          teachingModel: lockedSource.teachingModel,
          predecessorVersionId: lockedSource.id,
          now,
        });
        await appendEvent(tx, {
          versionId: created.id,
          eventType: 'successor_created',
          fromStatus: null,
          toStatus: 'draft',
          actorRef,
          comment: command.comment ?? null,
          relatedVersionId: lockedSource.id,
          data: {
            clonedFromVersionId: lockedSource.id,
            sourceStageId: lockedSource.currentStageId,
            stageId,
          },
          createdAt: now,
        });
        return created;
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          throw new TeachingPackageError(
            'ACTIVE_SUCCESSOR_EXISTS',
            'another successor won the race for this learning item',
          );
        }
        throw error;
      }
    });
  } catch (error) {
    // Compensation: the clone is committed but unreferenced; make it invisible
    // to all product reads (resolveStageAccess treats tombstoned as absent).
    await tombstoneStageMeta(pool as Queryable, stageId).catch(() => {});
    throw error;
  }
}

/**
 * Create version 1 for a Learning Item from a completed initial attempt
 * (§5, internal): called by the generation completion transaction, which
 * already holds the item advisory lock and the Stage's `stage_meta FOR UPDATE`
 * (live, service-owner). The Stage save committed before this runs.
 */
export async function createInitialVersion(
  tx: Queryable,
  input: {
    attempt: GenerationAttempt;
    stageId: string;
    now: number;
  },
): Promise<TeachingPackageVersion> {
  const { attempt, stageId, now } = input;
  const active = await readActiveVersion(tx, attempt.learningItem);
  const next = await nextVersionNumber(tx, attempt.learningItem);
  if (active || next !== 1) {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      'an active version appeared while the initial attempt was running',
    );
  }
  const created = await insertVersion(tx, {
    id: `tpv-${randomBytes(9).toString('base64url')}`,
    learningItem: attempt.learningItem,
    version: 1,
    status: 'draft',
    currentStageId: stageId,
    currentAttemptId: attempt.id,
    teachingModel: attempt.teachingModel,
    now,
  });
  await appendEvent(tx, {
    versionId: created.id,
    eventType: 'created',
    fromStatus: null,
    toStatus: 'draft',
    actorRef: attempt.requestedByActorRef,
    data: { attemptId: attempt.id, stageId },
    createdAt: now,
  });
  return created;
}

/**
 * Relink a draft/rejected version onto a completed regeneration's new Stage
 * (§5, internal): same status, same version number (BR-051); the previous
 * Stage is retained as a displaced reference and the previous attempt is
 * marked displaced in the same transaction.
 */
export async function replaceStageAfterRegeneration(
  tx: Queryable,
  input: {
    attempt: GenerationAttempt;
    version: TeachingPackageVersion;
    stageId: string;
    now: number;
  },
): Promise<void> {
  const { attempt, version, stageId, now } = input;
  if (version.status !== 'draft' && version.status !== 'rejected') {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      `the version moved to ${version.status} while the regeneration was running`,
    );
  }
  const previousStageId = version.currentStageId;
  await relinkVersionStage(tx, version.id, {
    stageId,
    attemptId: attempt.id,
    teachingModel: attempt.teachingModel,
    now,
  });
  if (version.currentAttemptId) {
    await markAttemptDisplaced(tx, version.currentAttemptId, now);
  }
  await appendEvent(tx, {
    versionId: version.id,
    eventType: 'stage_replaced',
    fromStatus: version.status,
    toStatus: version.status,
    actorRef: attempt.requestedByActorRef,
    data: { previousStageId, newStageId: stageId, attemptId: attempt.id },
    createdAt: now,
  });
}

// Re-exported for the generation module's completion transaction, which runs
// in the same lock order.
export { lockStageMetaLiveSorted, itemLockKey, assertActorRef };
