/**
 * Scene Learning Objective updates (plan §9): Kafuo's way to attach objective
 * references to a package's scenes without Editor changes. The version must be
 * editable (draft|rejected); writes go through the owner-bound store's putScene
 * per scene, so the stage guard and the write-boundary validator both apply.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { readVersion } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { SceneLearningObjectiveRef } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

export interface SceneObjectiveAssignment {
  sceneId: string;
  /** Replaces the scene's objectives outright; an empty array clears them. */
  learningObjectives: SceneLearningObjectiveRef[];
}

export interface ValidatedObjectiveAssignment {
  sceneId: string;
  learningObjectives: SceneLearningObjectiveRef[];
}

/** Validate one assignment; stamps `capturedAt` when the caller omitted it. */
export function normalizeAssignment(
  assignment: { sceneId: unknown; learningObjectives: unknown },
  now: number,
): ValidatedObjectiveAssignment {
  if (typeof assignment.sceneId !== 'string' || assignment.sceneId.trim() === '') {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'assignments[].sceneId must be a non-empty string',
    );
  }
  if (!Array.isArray(assignment.learningObjectives)) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'assignments[].learningObjectives must be an array',
    );
  }
  const learningObjectives = assignment.learningObjectives.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!record) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `assignments[].learningObjectives[${index}] must be an object`,
      );
    }
    if (typeof record.objectiveRef !== 'string' || record.objectiveRef.trim() === '') {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `assignments[].learningObjectives[${index}].objectiveRef must be a non-empty string`,
      );
    }
    const snapshot =
      record.snapshot && typeof record.snapshot === 'object'
        ? (record.snapshot as Record<string, unknown>)
        : null;
    if (!snapshot || typeof snapshot.statement !== 'string' || snapshot.statement.trim() === '') {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `assignments[].learningObjectives[${index}].snapshot.statement must be a non-empty string`,
      );
    }
    return {
      objectiveRef: record.objectiveRef,
      snapshot: {
        statement: snapshot.statement,
        ...(typeof snapshot.label === 'string' ? { label: snapshot.label } : {}),
        ...(typeof snapshot.context === 'string' ? { context: snapshot.context } : {}),
      },
      capturedAt: typeof record.capturedAt === 'number' ? record.capturedAt : now,
    };
  });
  return { sceneId: assignment.sceneId, learningObjectives };
}

/** Replace the objectives on the listed scenes of one package version. */
export async function setSceneLearningObjectives(
  pool: ConnectableQueryable,
  versionId: string,
  assignments: ValidatedObjectiveAssignment[],
): Promise<{ updatedSceneIds: string[] }> {
  if (assignments.length === 0) {
    throw new TeachingPackageError('INVALID_REQUEST', 'assignments must not be empty');
  }

  const version = await readVersion(pool, versionId);
  if (!version) {
    throw new TeachingPackageError('NOT_FOUND', `teaching package ${versionId} not found`);
  }
  if (version.status !== 'draft' && version.status !== 'rejected') {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      `scene objectives can be set only on a draft or rejected version, not ${version.status}`,
    );
  }

  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the version’s stage is not live');
  }

  const updatedSceneIds: string[] = [];
  for (const assignment of assignments) {
    const scene = document.scenes.find((candidate) => candidate.id === assignment.sceneId);
    if (!scene) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `scene ${assignment.sceneId} does not exist on this version’s stage`,
        { sceneId: assignment.sceneId },
      );
    }
    const updated: AppScene = {
      ...scene,
      // Empty array = "no objectives" (a present, empty annotation).
      learningObjectives: [...assignment.learningObjectives],
    };
    await store.putScene(document.stage.id, updated);
    updatedSceneIds.push(assignment.sceneId);
  }
  return { updatedSceneIds };
}
