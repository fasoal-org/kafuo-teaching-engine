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
  releaseStageRetention,
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
import { readFlowForVersion, validateExactTeachingFlow } from '@/lib/server/teaching-package/exact-flow';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import { randomBytes } from 'node:crypto';
import type {
  GenerationAttempt,
  ReviewEventType,
  TeachingPackageAggregateKey,
  TeachingPackageStatus,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

const ACTOR_REF_MAX_LENGTH = 256;
const COMMENT_MAX_LENGTH = 4000;
const REASON_MAX_LENGTH = 4000;

export interface LifecycleCommandContext {
  versionId: string;
  /**
   * Caller's effective tenant (plan §4.1.2): every read/write below is scoped
   * by it, and a version of another tenant behaves exactly like an absent one
   * (non-enumerating NOT_FOUND).
   */
  tenantId: string;
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

function itemLockKey(aggregate: TeachingPackageAggregateKey): string {
  return `teaching-package:${aggregate.tenantId}:${aggregate.learningItem.type}:${aggregate.learningItem.id}`;
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
  if (typeof command.tenantId !== 'string' || command.tenantId.trim() === '') {
    throw new TeachingPackageError(
      'TENANT_REQUIRED',
      'tenantContext.tenantId must be a non-empty string',
    );
  }
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    // The advisory lock key needs the Learning Item, which only the row knows;
    // this plain read takes no lock, and every decision below re-reads FOR
    // UPDATE after the advisory lock is held. The tenant scope makes a
    // cross-tenant id behave exactly like an absent one.
    const current = await readVersion(tx, command.versionId, { tenantId: command.tenantId });
    if (!current) {
      throw new TeachingPackageError(
        'NOT_FOUND',
        `teaching package ${command.versionId} not found`,
      );
    }
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      itemLockKey({ tenantId: current.tenantId, learningItem: current.learningItem }),
    ]);

    const locked = await readVersionForUpdate(tx, command.versionId, {
      tenantId: command.tenantId,
    });
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

/** Emit `teaching_package.status_changed` inside the transition transaction. */
async function emitStatusChanged(
  tx: import('@openmaic/storage/document/pg').Queryable,
  version: TeachingPackageVersion,
  previousStatus: TeachingPackageStatus | null,
  actorRef: string,
  now: number,
): Promise<void> {
  if (previousStatus === null) return; // created/successor_created are not status transitions
  await enqueueWebhookEvent(
    tx,
    { tenantId: version.tenantId, learningItem: version.learningItem },
    'teaching_package.status_changed',
    () => ({
      version: {
        id: version.id,
        version: version.version,
        previousStatus,
        status: version.status,
        currentStageId: version.currentStageId,
        teachingModel: version.teachingModel,
        updatedAt: version.updatedAt || now,
      },
      actorRef,
    }),
  );
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

/**
 * What the pre-submit exact-flow gate proved, and the Stage identity it proved
 * it against. `flow === null` means the version records no Kafuo Teaching Model
 * Flow (a legacy version), so the gate does not apply.
 */
interface PreparedSubmitValidation {
  flow: readonly unknown[] | null;
  stageId: string;
  /** Stage revision the validated document was read at. */
  rev: number;
}

/**
 * Prove the exact flow OUTSIDE any transaction, then report the Stage identity
 * and revision the proof belongs to.
 *
 * WHY OUTSIDE (the PostgreSQL deadlock this replaced): the owner-bound document
 * store opens its own transaction on its own pool connection, and a read there
 * takes `stage_meta ... FOR SHARE` (owner-bound-document-store.ts). Calling it
 * from inside the lifecycle transaction — which already holds `FOR UPDATE` on
 * that same `stage_meta` row via `lockStageMetaLive` — made the second
 * connection wait on a lock the first would only release once the second
 * returned. The holder sat `idle in transaction` (`wait_event Client/ClientRead`,
 * no blocking pid) awaiting a promise, so it was never a database deadlock and
 * PostgreSQL's detector could not break it: the request hung until the client
 * timed out. On a cold provider the second connection blocks even harder, on
 * `ensureStageMetaSchema`'s `ALTER TABLE stage_meta` (ACCESS EXCLUSIVE), which
 * then queues every later `stage_meta` reader behind it.
 *
 * PGlite hid this because its pool hands every caller one connection, making
 * both statements the same transaction.
 *
 * `createSuccessor` already used this shape (store work before the transaction);
 * this is the same restructuring applied to submit.
 */
async function prepareSubmitValidation(
  pool: ConnectableQueryable,
  versionId: string,
  tenantId: string,
): Promise<PreparedSubmitValidation | null> {
  const version = await readVersion(pool, versionId, { tenantId });
  // Absent/cross-tenant: let the locked transaction raise the one NOT_FOUND.
  if (!version) return null;
  // Not submittable by this (unlocked, advisory) read: skip the document load and let
  // the locked transaction raise the authoritative refusal. This keeps the ERROR
  // PRECEDENCE the command had before the gate moved out: an approved/superseded/
  // discarded version answers `409 INVALID_TRANSITION` from the status check, not
  // `422 STAGE_NOT_LIVE` from a tombstoned stage it was never going to submit. If this
  // read is stale the other way (says approved, the locked row says draft), the
  // absent proof is treated as drift and re-proved under the lock.
  if (version.status !== 'draft' && version.status !== 'rejected') return null;
  const flow = await readFlowForVersion(pool, version.id);
  if (!flow || flow.length === 0) {
    return { flow: null, stageId: version.currentStageId, rev: -1 };
  }
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the version’s stage is not live');
  }
  const outlineRecord = document.outline as
    | { outlines?: Array<{ id: string; teachingStage?: { key: string; flowIndex: number } }> }
    | undefined;
  const check = validateExactTeachingFlow(document.scenes, flow, outlineRecord?.outlines);
  if (!check.valid) {
    throw new TeachingPackageError(
      'TEACHING_MODEL_FLOW_MISMATCH',
      `the scene sequence does not cover the exact Teaching Model Flow (${check.violation.reason})`,
      { offendingSceneIds: check.violation.offendingSceneIds },
    );
  }
  // The revision the proof is tied to. Read through the same store so the read
  // stays owner-scoped; the transaction re-reads it and refuses a mismatch.
  const manifest = await store.readFreshnessManifest(version.currentStageId);
  return { flow, stageId: version.currentStageId, rev: manifest?.rev ?? 0 };
}

/**
 * Outcome of one submit attempt. `drifted` is returned, never thrown: a sentinel
 * thrown from inside the command body would have to survive
 * `nodePostgresTransaction`'s catch/rethrow to be recognised by identity, and that
 * helper's `await client.query('ROLLBACK')` can itself throw and replace the value —
 * which would turn a routine "the Editor saved while this was validating" into a
 * non-Error escaping to the route layer as a 500. A return value cannot be lost.
 */
type SubmitAttempt =
  | { drifted: true }
  | { drifted: false; version: TeachingPackageVersion };

/** Submit for review: draft|rejected → in_review; captures the stage revision. */
export async function submitForReview(
  pool: ConnectableQueryable,
  command: LifecycleCommandContext,
): Promise<TeachingPackageVersion> {
  // The exact-flow proof is taken before the aggregate lock, so it can go stale
  // if the Stage is written in between. The transaction below refuses a stale
  // proof rather than submitting an experience it never validated; one retry
  // re-proves it, so a concurrent Editor save costs a retry, not a failure.
  const MAX_VALIDATION_ATTEMPTS = 2;
  for (let attempt = 1; ; attempt += 1) {
    const prepared = await prepareSubmitValidation(pool, command.versionId, command.tenantId);
    const outcome = await runLifecycleCommand<SubmitAttempt>(
      pool,
      command,
      async (tx, locked, actorRef, now) => {
        if (locked.status !== 'draft' && locked.status !== 'rejected') {
          throw invalidTransition(locked.status, 'submit for review');
        }
        await lockStageMetaLive(tx, locked.currentStageId);
        // Authoritative re-reads, all on `tx` — nothing below takes a second
        // connection while this transaction holds the aggregate lock.
        const flow = await readFlowForVersion(tx, locked.id);
        const manifest = await readStageFreshnessManifest(locked.currentStageId, tx);
        const currentRev = manifest?.rev ?? 0;
        if (flow && flow.length > 0) {
          // Pre-submit exact-flow gate (plan §4.3.9): a version generated under
          // a Kafuo Teaching Model Flow may enter review only with a scene
          // sequence that still covers the flow exactly — manual
          // add/delete/reorder cannot violate the sequence. Legacy versions
          // with no recorded flow skip the gate.
          const proofHolds =
            prepared !== null &&
            prepared.flow !== null &&
            prepared.stageId === locked.currentStageId &&
            prepared.rev === currentRev;
          // Returned, not thrown: see `SubmitAttempt`. The transaction commits
          // having changed nothing, and the caller re-proves the flow.
          if (!proofHolds) return { drifted: true };
        }
        const updated = await updateVersionStatus(tx, locked.id, {
          status: 'in_review',
          submittedAt: now,
          // The revision just verified against the validated document, so
          // `approve`'s STAGE_CHANGED_SINCE_SUBMISSION re-check compares
          // against the experience the gate actually inspected.
          submittedStageRev: currentRev,
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
        await emitStatusChanged(tx, updated!, locked.status, actorRef, now);
        return { drifted: false, version: updated! };
      },
    );

    if (!outcome.drifted) return outcome.version;
    if (attempt >= MAX_VALIDATION_ATTEMPTS) {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the stage kept changing while the submission was being validated; submit again',
      );
    }
    // Re-prove the flow against the Stage as it now stands.
  }
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
    await emitStatusChanged(tx, updated!, locked.status, actorRef, now);
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
    await emitStatusChanged(tx, updated!, locked.status, actorRef, now);
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

    const predecessor = await readApprovedVersion(tx, {
      tenantId: locked.tenantId,
      learningItem: locked.learningItem,
    });
    if (predecessor && predecessor.id !== locked.id) {
      const lockedPredecessor = await readVersionForUpdate(tx, predecessor.id, {
        tenantId: locked.tenantId,
      });
      try {
        const updatedPredecessor = await updateVersionStatus(tx, lockedPredecessor!.id, {
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
        await emitStatusChanged(tx, updatedPredecessor!, 'approved', actorRef, now);
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
      await emitStatusChanged(tx, updated!, 'in_review', actorRef, now);
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
    await emitStatusChanged(tx, updated!, locked.status, actorRef, now);
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
  command: { versionId: string; tenantId: string; actorRef: string; comment?: string },
): Promise<TeachingPackageVersion> {
  const actorRef = assertActorRef(command.actorRef);
  assertComment(command.comment);
  if (typeof command.tenantId !== 'string' || command.tenantId.trim() === '') {
    throw new TeachingPackageError(
      'TENANT_REQUIRED',
      'tenantContext.tenantId must be a non-empty string',
    );
  }

  const source = await readVersion(pool, command.versionId, { tenantId: command.tenantId });
  if (!source) {
    throw new TeachingPackageError('NOT_FOUND', `teaching package ${command.versionId} not found`);
  }
  if (source.status !== 'approved') {
    throw invalidTransition(source.status, 'create a successor from');
  }
  const sourceAggregate: TeachingPackageAggregateKey = {
    tenantId: source.tenantId,
    learningItem: source.learningItem,
  };
  const active = await readActiveVersion(pool, sourceAggregate);
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
        itemLockKey(sourceAggregate),
      ]);
      const lockedSource = await readVersionForUpdate(tx, command.versionId, {
        tenantId: command.tenantId,
      });
      if (!lockedSource || lockedSource.status !== 'approved') {
        throw new TeachingPackageError(
          'INVALID_TRANSITION',
          'the source version is no longer approved',
        );
      }
      const racedActive = await readActiveVersion(tx, sourceAggregate);
      if (racedActive) {
        throw new TeachingPackageError(
          'ACTIVE_SUCCESSOR_EXISTS',
          'another successor became active while this one was being created',
          { activeVersionId: racedActive.id },
        );
      }
      const versionNumber = await nextVersionNumber(tx, sourceAggregate);
      const now = Date.now();
      try {
        const created = await insertVersion(tx, {
          id: `tpv-${randomBytes(9).toString('base64url')}`,
          aggregate: sourceAggregate,
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
  const aggregate: TeachingPackageAggregateKey = {
    tenantId: attempt.tenantId,
    learningItem: attempt.learningItem,
  };
  const active = await readActiveVersion(tx, aggregate);
  const next = await nextVersionNumber(tx, aggregate);
  if (active || next !== 1) {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      'an active version appeared while the initial attempt was running',
    );
  }
  const created = await insertVersion(tx, {
    id: `tpv-${randomBytes(9).toString('base64url')}`,
    aggregate,
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
 * (§5, internal): same version id, same version number (BR-051), and the
 * previous Stage is RETIRED.
 *
 * ## One version, one live Stage
 *
 * A draft version has exactly one live Stage. Regeneration replaces it: the
 * version keeps its identity and moves onto the new Stage, and the Stage it
 * came from is soft-deleted in the SAME transaction as the relink, so no
 * moment exists in which the version's old Stage is still readable,
 * previewable or editable. An earlier revision kept it as a guard-locked
 * "displaced" Stage; that left two live Stages per version and is what this
 * replaces.
 *
 * The soft delete is the repository's canonical one — `tombstoneStageMeta`,
 * exactly what `OwnerBoundDocumentStore.deleteDocument` performs. Scenes need
 * no separate cascade: the store's ownership fence refuses every non-delete
 * operation on a tombstoned Stage, and its read path maps that refusal to
 * `null`, so `loadDocument` and `getScene` both stop answering for the old
 * Stage and its scenes together.
 *
 * `releaseStageRetention` is what lets the tombstone stand: the stage guard
 * protects any Stage an attempt row still retains, so the retention claim is
 * lifted first. The attempt rows themselves are kept, `stage_id` and
 * `produced_stage_id` included — lineage and audit history are not rewritten,
 * they simply stop conferring liveness.
 *
 * Status: regeneration always yields an editable `draft`. A `rejected` version
 * that regenerates successfully returns to `draft`, and the `stage_replaced`
 * event records that transition in its own `fromStatus`/`toStatus` — no new
 * event type, so the event vocabulary and its CHECK constraint are unchanged.
 *
 * Returns the retired Stage id so the caller can remove its media directory
 * AFTER the commit. That deletion is deliberately not part of this
 * transaction: a filesystem removal inside a transaction that later rolls back
 * would destroy the media of a Stage that is still live.
 */
export async function replaceStageAfterRegeneration(
  tx: Queryable,
  input: {
    attempt: GenerationAttempt;
    version: TeachingPackageVersion;
    stageId: string;
    now: number;
  },
): Promise<{ previousStageId: string; retiredStageId: string | null }> {
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
  if (version.status === 'rejected') {
    await updateVersionStatus(tx, version.id, { status: 'draft', now });
  }
  if (version.currentAttemptId) {
    await markAttemptDisplaced(tx, version.currentAttemptId, now);
  }
  // Defensive: a regeneration that somehow produced the Stage the version is
  // already on must not tombstone the Stage it just linked. Nothing in the
  // current flow can reach this (the runner reserves a fresh Stage id), which
  // is precisely why it is cheap to refuse rather than to reason about.
  const retiredStageId = previousStageId === stageId ? null : previousStageId;
  if (retiredStageId) {
    await releaseStageRetention(tx, retiredStageId, now);
    await tombstoneStageMeta(tx, retiredStageId);
  }
  await appendEvent(tx, {
    versionId: version.id,
    eventType: 'stage_replaced',
    fromStatus: version.status,
    toStatus: 'draft',
    actorRef: attempt.requestedByActorRef,
    data: { previousStageId, newStageId: stageId, attemptId: attempt.id },
    createdAt: now,
  });
  return { previousStageId, retiredStageId };
}

// Re-exported for the generation module's completion transaction, which runs
// in the same lock order.
export { lockStageMetaLiveSorted, itemLockKey, assertActorRef };
