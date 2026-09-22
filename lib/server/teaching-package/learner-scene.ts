/**
 * The Scene a learner grant may read for Stage Help (Kafuo R1 plan §4.3
 * rule 5, §8.3, P7): the grant's PINNED version (tenant-scoped, `approved |
 * superseded`, its current Stage is the granted one) → the Stage document
 * through the teaching-package owner → the Scene by id. Every miss is a
 * non-enumerating 404; a version a learner may no longer open is
 * `INVALID_TRANSITION` (the same rule the learner handoff applies).
 *
 * This is the only place the tutor runtime reaches a Stage document: the
 * teaching-package owner and its document store stay inside this surface
 * (`tests/teaching-package/cross-module-action-boundaries`).
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { AppDocument } from '@/lib/document-store/persistence-types';
import { readVersion } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import {
  LEARNER_HANDOFF_STATUSES,
  type VerifiedEditorGrant,
} from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { renderSceneText } from '@/lib/server/teaching-package/question-generation';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageVersion } from '@/lib/types/teaching-package';

export interface LearnerSceneDeps {
  pool: Queryable;
  /** Test seam; defaults to the owner-scoped teaching-package document store. */
  loadStageDocument?: (stageId: string) => Promise<AppDocument | null>;
}

export interface LearnerSceneInput {
  versionId: string;
  stageId: string;
  sceneId: string;
}

export interface LearnerScene {
  version: TeachingPackageVersion;
  document: AppDocument;
  scene: AppScene;
  sceneTitle: string;
  /** The Scene's visible text (`renderSceneText`), for grounding and scope. */
  sceneText: string;
}

function notFound(): TeachingPackageError {
  return new TeachingPackageError('NOT_FOUND', 'no Help anchor for this version and stage');
}

async function loadDocument(deps: LearnerSceneDeps, stageId: string): Promise<AppDocument | null> {
  if (deps.loadStageDocument) return deps.loadStageDocument(stageId);
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  return store.loadDocument(stageId);
}

/**
 * Read the Scene for a verified learner grant. The caller has already
 * matched `input` against the grant's pinned pair; this re-checks it against
 * the stored version (tenant, current Stage) and the learner statuses.
 */
export async function readLearnerScene(
  deps: LearnerSceneDeps,
  grant: Pick<VerifiedEditorGrant, 'tenantId' | 'versionId' | 'stageId'>,
  input: LearnerSceneInput,
): Promise<LearnerScene> {
  if (grant.versionId !== input.versionId || grant.stageId !== input.stageId) throw notFound();
  const version = await readVersion(deps.pool, input.versionId, { tenantId: grant.tenantId });
  if (!version || version.currentStageId !== input.stageId) throw notFound();
  if (!(LEARNER_HANDOFF_STATUSES as readonly string[]).includes(version.status)) {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      `Help requires an approved or superseded version, not ${version.status}`,
    );
  }
  const document = await loadDocument(deps, input.stageId);
  if (!document) throw notFound();
  const scene = (document.scenes as AppScene[]).find((entry) => entry.id === input.sceneId);
  if (!scene) throw notFound();
  return {
    version,
    document,
    scene,
    sceneTitle: typeof scene.title === 'string' ? scene.title : '',
    sceneText: renderSceneText(scene),
  };
}
