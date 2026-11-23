/**
 * Delete a DUPLICATE slide (Kafuo Agent API wave E3, plan §1.5 and §8 E3).
 *
 * The editor deletes a slide through the generic document store; there is no
 * teaching-package op with a guard. This one refuses unless every rule holds,
 * before anything is written:
 *
 * - the package is editable (`draft` | `rejected`) and nothing generates on it;
 * - `keepSceneId` is another live scene of the same type (slide or a generated
 *   quiz; a question-bank quiz is never deleted here);
 * - it is a duplicate (`SCENE_NOT_DUPLICATE` otherwise): the deleted slide cites
 *   at least one lesson part, both slides are in the same teaching stage (their
 *   own `teachingStage`, else their outline entry's), and the kept slide cites
 *   every part the deleted one cites;
 * - no lesson part covered before is uncovered after (`PART_WOULD_BE_UNTAUGHT`,
 *   `computeContentUnitCoverage` before and after);
 * - the lesson still follows its Teaching Model Flow when it did before
 *   (`INSERTION_FLOW_INVALID` reused: the same exact-flow check).
 *
 * The write is the owner-bound `deleteScene` under two scene-revision fences
 * (the deleted and the kept scene must be exactly as checked), a re-check of
 * the running regenerations and insertions under the same `stage_meta` lock,
 * and the stage guard, whose `scene_changed: deleted` webhook names the agent
 * actor. With a key, the delete's record (`teaching_package_agent_ops`) is
 * written in the same transaction, so a retry after an unknown outcome is
 * answered "done" with the backup. The backup is the deleted slide in the agent
 * read's form (spec §5.5), never the raw scene. `dryRun` runs every check and
 * writes nothing.
 */
import { DocumentVersionError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type {
  AppDocument,
  AppDocumentOutline,
  AppStage,
} from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import {
  agentOpDigest,
  readAgentOpRecord,
  recordDeleteInTransaction,
} from '@/lib/server/teaching-package/agent-op-records';
import {
  projectAgentScenes,
  type AgentScene,
} from '@/lib/server/teaching-package/agent-read/scenes';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import {
  citedContentUnitIds,
  computeContentUnitCoverage,
  type UnitCoverage,
} from '@/lib/server/teaching-package/content-unit-coverage';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { validateExactTeachingFlow } from '@/lib/server/teaching-package/exact-flow';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  revisionPreconditionFence,
  type RevisionPreconditionState,
} from '@/lib/server/teaching-package/revision-precondition-fence';
import { readInsertionContext } from '@/lib/server/teaching-package/scene-insertion';
import { listRunningSceneInsertions } from '@/lib/server/teaching-package/scene-insertion-store';
import {
  listRunningSceneRegenerations,
  readLiveScene,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import { TEACHING_PACKAGE_EDITABLE_STATUSES } from '@/lib/types/teaching-package';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

export interface DuplicateDeleteRequest {
  sceneId: string;
  keepSceneId: string;
  reason: string;
  /** `agent:<user id>`: named by the `scene_changed: deleted` webhook. */
  actorRef: string;
  dryRun: boolean;
  /** The Backend's engine key: the delete's keyed record (a retry answers "done"). */
  idempotencyKey?: string;
}

export interface DuplicateDeletePlanInput {
  sceneId: string;
  keepSceneId: string;
  scenes: readonly AppScene[];
  outline: AppDocumentOutline | null;
  units: Parameters<typeof computeContentUnitCoverage>[0];
  gaps?: Parameters<typeof computeContentUnitCoverage>[3];
  flow: readonly TeachingFlowEntry[] | null;
}

export interface DuplicateDeletePlan {
  scene: AppScene;
  keep: AppScene;
  /** The lesson parts the deleted scene cited (all also cited by the kept one). */
  citedUnitIds: string[];
}

function refuse(
  code: ConstructorParameters<typeof TeachingPackageError>[0],
  message: string,
  details?: unknown,
) {
  return new TeachingPackageError(code, message, details);
}

/** The scene's teaching stage key: its own, else its outline entry's; `null` without one. */
export function teachingStageKey(
  scene: Pick<AppScene, 'teachingStage' | 'outlineId'>,
  outline: AppDocumentOutline | null,
): string | null {
  if (scene.teachingStage?.key) return scene.teachingStage.key;
  const entry = outline?.outlines?.find((candidate) => candidate.id === scene.outlineId) as
    | { teachingStage?: { key?: unknown } }
    | undefined;
  return typeof entry?.teachingStage?.key === 'string' ? entry.teachingStage.key : null;
}

function coveredIds(coverage: readonly UnitCoverage[]): Set<string> {
  return new Set(coverage.filter((unit) => unit.covered).map((unit) => unit.id));
}

/** Every rule on the live document, pure. Throws the refusal; returns what would be deleted. */
export function planDuplicateDelete(input: DuplicateDeletePlanInput): DuplicateDeletePlan {
  const { sceneId, keepSceneId, scenes, outline } = input;
  if (sceneId === keepSceneId) {
    throw refuse('INVALID_REQUEST', 'keepSceneId must be another slide than the one deleted', {
      field: 'keepSceneId',
      rule: 'format',
    });
  }
  const scene = scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw refuse('SCENE_NOT_FOUND', 'the slide to delete was not found');
  const keep = scenes.find((candidate) => candidate.id === keepSceneId);
  if (!keep) {
    throw refuse('SCENE_NOT_FOUND', 'the slide to keep was not found', { sceneId: keepSceneId });
  }
  if (scene.type !== 'slide' && scene.type !== 'quiz') {
    throw refuse('SCENE_NOT_DUPLICATE', `a ${scene.type} scene is never deleted as a duplicate`, {
      reason: 'scene_type',
    });
  }
  if (isBankQuizScene(scene) || isBankQuizScene(keep)) {
    throw refuse('SCENE_NOT_DUPLICATE', 'a question-bank quiz is never deleted as a duplicate', {
      reason: 'bank_quiz',
    });
  }
  if (keep.type !== scene.type) {
    throw refuse('SCENE_NOT_DUPLICATE', 'the kept scene is not of the same type', {
      reason: 'type_mismatch',
      sceneType: scene.type,
      keepType: keep.type,
    });
  }
  const record = (outline ?? undefined) as Parameters<typeof citedContentUnitIds>[1];
  const cited = citedContentUnitIds(scene, record);
  if (cited.length === 0) {
    // Nothing tells the two slides apart from two different slides: never a duplicate.
    throw refuse(
      'SCENE_NOT_DUPLICATE',
      'the slide cites no lesson part, so it is not a duplicate',
      {
        reason: 'cites_no_part',
      },
    );
  }
  const stageOfDeleted = teachingStageKey(scene, outline);
  const stageOfKept = teachingStageKey(keep, outline);
  if (stageOfDeleted !== stageOfKept) {
    throw refuse('SCENE_NOT_DUPLICATE', 'the kept slide is in another teaching stage', {
      reason: 'stage_mismatch',
      teachingStage: stageOfDeleted,
      keepTeachingStage: stageOfKept,
    });
  }
  const keptCited = new Set(citedContentUnitIds(keep, record));
  const missing = cited.filter((unitId) => !keptCited.has(unitId));
  if (missing.length > 0) {
    throw refuse(
      'SCENE_NOT_DUPLICATE',
      'the kept slide does not teach every lesson part the deleted slide teaches',
      { reason: 'parts_not_on_kept_slide', unitIds: missing },
    );
  }
  const after = scenes.filter((candidate) => candidate.id !== sceneId);
  const before = coveredIds(computeContentUnitCoverage(input.units, scenes, record, input.gaps));
  const still = coveredIds(computeContentUnitCoverage(input.units, after, record, input.gaps));
  const untaught = [...before].filter((unitId) => !still.has(unitId));
  if (untaught.length > 0) {
    throw refuse(
      'PART_WOULD_BE_UNTAUGHT',
      'deleting this slide would leave a lesson part with no slide',
      { unitIds: untaught },
    );
  }
  if (input.flow && input.flow.length > 0) {
    const outlines = outline?.outlines;
    const was = validateExactTeachingFlow(scenes, input.flow, outlines);
    const now = validateExactTeachingFlow(after, input.flow, outlines);
    if (was.valid && !now.valid) {
      throw refuse(
        'INSERTION_FLOW_INVALID',
        `the lesson would not follow its Teaching Model Flow (${now.violation.reason})`,
        { reason: now.violation.reason, offendingSceneIds: now.violation.offendingSceneIds },
      );
    }
  }
  return { scene, keep, citedUnitIds: cited };
}

export interface DuplicateDeleteGrant {
  tenantId: string;
  versionId: string;
  stageId: string;
}

export interface DuplicateDeleteResult {
  dryRun: boolean;
  deleted: boolean;
  /** A retry answered from the keyed record of a delete that already landed. */
  replayed: boolean;
  sceneId: string;
  keepSceneId: string;
  /** The deleted slide as it was, in the agent read's slide form (the backup). */
  backup: AgentScene | null;
}

/** What the keyed record binds a key to: the same key with another body is refused. */
export function duplicateDeleteDigest(
  request: Pick<DuplicateDeleteRequest, 'sceneId' | 'keepSceneId' | 'reason'>,
) {
  return agentOpDigest({
    sceneId: request.sceneId,
    keepSceneId: request.keepSceneId,
    reason: request.reason.trim(),
  });
}

/**
 * A delete that already landed under this key (its record is written in the delete's
 * own transaction): answered as done, with the stored backup, before any other check.
 */
export async function replayDuplicateDelete(
  pool: ConnectableQueryable,
  versionId: string,
  idempotencyKey: string,
  request: Pick<DuplicateDeleteRequest, 'sceneId' | 'keepSceneId' | 'reason'>,
): Promise<DuplicateDeleteResult | null> {
  const record = await readAgentOpRecord(pool as unknown as Queryable, {
    versionId,
    op: 'delete',
    idempotencyKey,
  });
  if (!record) return null;
  if (record.requestDigest !== duplicateDeleteDigest(request)) {
    throw refuse(
      'IDEMPOTENCY_KEY_REUSED',
      'this idempotency key was already used for a different request',
    );
  }
  const result = record.result ?? {};
  return {
    dryRun: false,
    deleted: true,
    replayed: true,
    sceneId: record.sceneId,
    keepSceneId: String(result.keepSceneId ?? request.keepSceneId),
    backup: (result.backup as AgentScene | undefined) ?? null,
  };
}

/** The slide as the agent read shows it (spec §5.5), from the document it was deleted from. */
function projectBackup(
  context: Awaited<ReturnType<typeof readInsertionContext>>,
  document: AppDocument,
  sceneId: string,
): AgentScene | null {
  const projection = projectAgentScenes({
    version: context.version,
    revision: 0,
    scenes: document.scenes,
    outline: (document.outline ?? null) as AppDocumentOutline | null,
    stage: document.stage,
    flow: context.flow,
    governed: context.governed,
  });
  return projection.scenes.find((scene) => scene.scene_id === sceneId) ?? null;
}

export interface DuplicateDeleteDeps {
  pool: ConnectableQueryable;
  now?: () => number;
  /** Test seams. */
  readContext?: typeof readInsertionContext;
  loadDocument?: (pool: ConnectableQueryable, stageId: string) => Promise<AppDocument | null>;
  deleteScene?: typeof deleteSceneAtRevs;
}

function documentStore(
  pool: ConnectableQueryable,
  mutationFence?: ReturnType<typeof teachingPackageStageGuardFence>,
) {
  return withPlainJsonDocumentWrites(
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as unknown as TransactionSource,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      ...(mutationFence ? { mutationFence } : {}),
    }),
  );
}

async function loadStageDocument(
  pool: ConnectableQueryable,
  stageId: string,
): Promise<AppDocument | null> {
  return (await documentStore(pool).loadDocument(stageId)) as AppDocument | null;
}

/**
 * The owner-bound delete, fenced on the exact revisions of the deleted and the
 * kept scene, with the stage guard (editable only) naming `actorRef`.
 */
export interface DeleteRecordInput {
  tenantId: string;
  versionId: string;
  idempotencyKey: string;
  requestDigest: string;
  result: Record<string, unknown>;
  now: number;
}

export async function deleteSceneAtRevs(
  pool: ConnectableQueryable,
  target: { stageId: string; sceneId: string; keepSceneId: string; revs: Record<string, number> },
  actorRef: string,
  /** The keyed record, written in the delete's own transaction (absent: no key). */
  record?: DeleteRecordInput,
  now: () => number = Date.now,
): Promise<void> {
  const deleted: RevisionPreconditionState = {};
  const kept: RevisionPreconditionState = {};
  let busy = false;
  let recorded = false;
  const deletedFence = revisionPreconditionFence(
    { kind: 'scene', stageId: target.stageId, sceneId: target.sceneId, method: 'DELETE' },
    { [target.sceneId]: target.revs[target.sceneId]! },
    deleted,
  );
  const keptFence = revisionPreconditionFence(
    { kind: 'scene', stageId: target.stageId, sceneId: target.keepSceneId, method: 'PUT' },
    { [target.keepSceneId]: target.revs[target.keepSceneId]! },
    kept,
  );
  const guard = teachingPackageStageGuardFence(undefined, { sceneEvents: { actorRef } });
  const store = documentStore(pool, async (queryable, operation, phase) => {
    // The precondition fences take `stage_meta FOR UPDATE` first, so the running-row
    // check below is serialized with a regeneration's or an insertion's start.
    await deletedFence(queryable, operation, phase);
    await keptFence(queryable, operation, phase);
    const write = operation.stageId === target.stageId && operation.mode !== 'read';
    if (phase === 'before' && write) {
      const at = now();
      const regenerations = await listRunningSceneRegenerations(queryable, target.stageId, at);
      const insertions = await listRunningSceneInsertions(queryable, target.stageId, at);
      if (regenerations.length > 0 || insertions.length > 0) {
        busy = true;
        throw new Error('a slide generation started on this stage');
      }
    }
    await guard(queryable, operation, phase);
    if (phase === 'after' && write && record && !recorded) {
      await recordDeleteInTransaction(queryable, { ...record, sceneId: target.sceneId });
      recorded = true;
    }
  });
  try {
    await store.deleteScene(target.stageId, target.sceneId);
  } catch (error) {
    if (busy) {
      throw new TeachingPackageError(
        'STAGE_GENERATION_IN_PROGRESS',
        'a slide is being generated on this lesson; try again when it finishes',
      );
    }
    const refusal = deleted.refusal ?? kept.refusal;
    if (refusal) {
      throw new TeachingPackageError('SCENE_REVISION_CONFLICT', refusal.message, {
        scenes: refusal.scenes,
      });
    }
    if (error instanceof DocumentVersionError && error.kind === 'not-current') {
      throw new TeachingPackageError(
        'DOCUMENT_NOT_CURRENT',
        'the stored stage is on an older document version; nothing was written',
      );
    }
    throw error;
  }
}

/** Check, then (unless a dry run) delete the duplicate. Throws every refusal. */
export async function deleteDuplicateScene(
  grant: DuplicateDeleteGrant,
  request: DuplicateDeleteRequest,
  deps: DuplicateDeleteDeps,
): Promise<DuplicateDeleteResult> {
  const { pool } = deps;
  const clock = deps.now ?? Date.now;
  if (request.reason.trim().length < 5) {
    throw refuse('INVALID_REQUEST', 'reason needs at least 5 characters', {
      field: 'reason',
      rule: 'min',
      limit: 5,
    });
  }
  const context = await (deps.readContext ?? readInsertionContext)(pool, grant);
  if (!TEACHING_PACKAGE_EDITABLE_STATUSES.includes(context.version.status)) {
    throw refuse(
      'STAGE_LOCKED',
      `the teaching package is ${context.version.status}; only draft or rejected packages can be edited`,
    );
  }
  const now = clock();
  const regenerations = await listRunningSceneRegenerations(pool, grant.stageId, now);
  const insertions = await listRunningSceneInsertions(pool, grant.stageId, now);
  if (regenerations.length > 0 || insertions.length > 0) {
    throw refuse(
      'STAGE_GENERATION_IN_PROGRESS',
      'a slide is being generated on this lesson; try again when it finishes',
    );
  }
  // The revisions are read BEFORE the document: the delete is fenced on them, so
  // a change to either slide after this read refuses the write.
  const live = await readLiveScene(pool, grant.stageId, request.sceneId);
  if (!live) throw refuse('SCENE_NOT_FOUND', 'the slide to delete was not found');
  const liveKeep = await readLiveScene(pool, grant.stageId, request.keepSceneId);
  if (!liveKeep) {
    throw refuse('SCENE_NOT_FOUND', 'the slide to keep was not found', {
      sceneId: request.keepSceneId,
    });
  }
  const document = await (deps.loadDocument ?? loadStageDocument)(pool, grant.stageId);
  if (!document) throw refuse('STAGE_NOT_LIVE', 'the package stage is not live');
  const plan = planDuplicateDelete({
    sceneId: request.sceneId,
    keepSceneId: request.keepSceneId,
    scenes: document.scenes,
    outline: (document.outline ?? null) as AppDocumentOutline | null,
    units: context.units,
    gaps: context.gaps,
    flow: context.flow,
  });
  const result = {
    sceneId: plan.scene.id,
    keepSceneId: plan.keep.id,
    backup: projectBackup(context, document, plan.scene.id),
  };
  if (request.dryRun) return { dryRun: true, deleted: false, replayed: false, ...result };

  await (deps.deleteScene ?? deleteSceneAtRevs)(
    pool,
    {
      stageId: grant.stageId,
      sceneId: plan.scene.id,
      keepSceneId: plan.keep.id,
      revs: { [plan.scene.id]: live.rev, [plan.keep.id]: liveKeep.rev },
    },
    request.actorRef,
    request.idempotencyKey
      ? {
          tenantId: grant.tenantId,
          versionId: grant.versionId,
          idempotencyKey: request.idempotencyKey,
          requestDigest: duplicateDeleteDigest(request),
          result: {
            keepSceneId: plan.keep.id,
            reason: request.reason.trim(),
            actorRef: request.actorRef,
            backup: result.backup,
          },
          now: clock(),
        }
      : undefined,
    clock,
  );
  return { dryRun: false, deleted: true, replayed: false, ...result };
}
