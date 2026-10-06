/**
 * The scene outline of an APPROVED (or pinned, now SUPERSEDED) Teaching Package
 * version, for Kafuo's guided teaching runner.
 *
 * Kafuo teaches a lesson one scene at a time inside its own runner (resume, checks,
 * remediation, completion stay Kafuo-owned). To do that it must know which scenes
 * exist, in what order, and which flow position each one fills. This module answers
 * exactly that and nothing else:
 *
 * - **Approved or superseded only**, tenant- and item-scoped, no "latest" fallback --
 *   the caller names the exact version its readiness verdict or a published item pinned.
 *   A superseded version is answered because Kafuo keeps serving a published item the
 *   version it was published with after a newer one is approved (the same statuses a
 *   learner handoff opens, `LEARNER_HANDOFF_STATUSES`). Draft, in-review, rejected and
 *   discarded versions never answer.
 * - **Structure, not content.** Ids, order, type, flow position, content role, title
 *   and whether narration exists. The learner renders the scene itself from the Stage
 *   document it receives through the learner handoff, where quiz answer keys are
 *   already stripped; nothing here could leak an answer.
 * - **Kafuo maps scenes to outcomes.** A scene's `teachingStage.flowIndex` indexes the
 *   retained expanded flow; which positions belong to which objective depends on the
 *   flow's stage scopes, which Kafuo owns. The retained objective order and flow stage
 *   keys are returned so the caller can expand its own flow and prove it reproduces
 *   this package's before trusting any mapping.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { readRetainedVersionContext, readVersion } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { LEARNER_HANDOFF_STATUSES } from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { AppScene } from '@/lib/types/stage';
import type { LearningItemRef, TeachingModelLineage } from '@/lib/types/teaching-package';

export interface OutlineScene {
  sceneId: string;
  order: number;
  type: string;
  title: string;
  /** `teachingStage.key`; null for a scene outside the Kafuo flow. */
  stageKey: string | null;
  /** `teachingStage.flowIndex`; null for a scene outside the Kafuo flow. */
  flowIndex: number | null;
  /** Slide `contentRole`; null for non-slide scenes or an unannotated slide. */
  contentRole: string | null;
  hasNarration: boolean;
}

export interface ApprovedOutlineResult {
  versionId: string;
  stageId: string;
  teachingModel: TeachingModelLineage;
  /** Retained objective refs, in the order the package was generated for. */
  objectiveRefs: string[];
  /** Retained expanded flow, stage keys only, in flow-index order. */
  flowStages: string[];
  scenes: OutlineScene[];
}

export interface ApprovedOutlineRequest {
  versionId: string;
  tenantId: string;
  learningItem: LearningItemRef;
}

function hasSpeech(scene: AppScene): boolean {
  const actions = (scene as { actions?: Array<{ type?: string }> }).actions ?? [];
  return actions.some((action) => action.type === 'speech');
}

/** Pure projection; exported for tests. Scenes come back sorted by `order`. */
export function projectOutlineScenes(scenes: AppScene[]): OutlineScene[] {
  return [...scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene) => {
      const content = (scene as { content?: { type?: string; contentRole?: unknown } }).content;
      const stage = scene.teachingStage;
      return {
        sceneId: scene.id,
        order: scene.order,
        type: String(content?.type ?? (scene as { type?: string }).type ?? 'unknown'),
        title: scene.title ?? '',
        stageKey: stage?.key ?? null,
        flowIndex: stage?.flowIndex ?? null,
        contentRole:
          content?.type === 'slide' && typeof content.contentRole === 'string'
            ? content.contentRole
            : null,
        hasNarration: hasSpeech(scene),
      };
    });
}

/** Read the version's outline. Tenant- and item-scoped; approved or superseded only. */
export async function readApprovedOutline(
  pool: Queryable,
  request: ApprovedOutlineRequest,
): Promise<ApprovedOutlineResult> {
  const version = await readVersion(pool, request.versionId, { tenantId: request.tenantId });
  if (
    !version ||
    version.learningItem.type !== request.learningItem.type ||
    version.learningItem.id !== request.learningItem.id
  ) {
    throw new TeachingPackageError(
      'NOT_FOUND',
      `teaching package ${request.versionId} not found for this learning item`,
    );
  }
  if (!(LEARNER_HANDOFF_STATUSES as readonly string[]).includes(version.status)) {
    throw new TeachingPackageError(
      'TEACHING_PACKAGE_NOT_APPROVED',
      `the scene outline is read only from an approved or superseded teaching package, not ${version.status}`,
    );
  }
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the approved version’s stage is not live');
  }
  const context = await readRetainedVersionContext(pool, version.id, {
    tenantId: request.tenantId,
  });
  return {
    versionId: version.id,
    stageId: version.currentStageId,
    teachingModel: version.teachingModel,
    objectiveRefs: (context?.inputSnapshot.learningObjectives ?? []).map(
      (entry) => entry.objectiveRef,
    ),
    flowStages: (context?.inputSnapshot.teachingFlow ?? []).map((entry) => entry.stage),
    scenes: projectOutlineScenes(document.scenes as AppScene[]),
  };
}
