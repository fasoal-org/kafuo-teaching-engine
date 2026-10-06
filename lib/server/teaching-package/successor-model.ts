/**
 * Successor Teaching Model identity checks (Module 2 W13 — teaching-skills plan
 * §P Step 13 · §L · §M correction 2 · FR-TS-047/048/049/050/072 · VAL-TS-024 ·
 * AC-TS-018/019/033).
 *
 * Teaching Model identity is the `(key, version)` PAIR, never version alone:
 * both `teaching_package_versions` and `teaching_package_generation_attempts`
 * carry `teaching_model_key` and `teaching_model_version` as first-class NOT
 * NULL columns, so every comparison here is a SQL-column pair comparison — no
 * JSONB parsing, and a changed *key* is never invisible (§L).
 *
 * Read-and-compare only. No reassignment seam is built — it already exists
 * (`replaceStageAfterRegeneration` → `relinkVersionStage`), and the
 * model-change ⟹ Stage-replacement invariant (§B.12) means those columns have
 * exactly two writers. `createSuccessor` and `relinkVersionStage` are NOT
 * touched by this module or its callers.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { sceneMaterialFingerprint } from '@/lib/server/teaching-package/alignment';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingModelLineage } from '@/lib/types/teaching-package';

/** The three successor cases of §L, distinguished by the `(key, version)` pair. */
export type SuccessorTeachingModelCase = 'same-pair' | 'changed-version' | 'changed-key';

/**
 * Which successor case a version is, given its declared Teaching Model and its
 * predecessor's:
 *
 * | Case           | pair                        | Scenes                        |
 * | same-pair      | equal                       | cloned, lineage preserved     |
 * | changed-version| key equal, version differs  | replaced by regeneration      |
 * | changed-key    | key differs                 | replaced; flow shape re-built |
 */
export function resolveSuccessorTeachingModelCase(
  current: TeachingModelLineage,
  predecessor: TeachingModelLineage,
): SuccessorTeachingModelCase {
  if (current.key === predecessor.key) {
    return current.version === predecessor.version ? 'same-pair' : 'changed-version';
  }
  return 'changed-key';
}

/**
 * The Teaching Model of the attempt whose snapshot produced the version's
 * current Stage lineage — the SAME predecessor walk `readFlowForVersion` uses
 * (`current_attempt_id`, else `predecessor_version_id`), reading the attempts
 * table's first-class columns. `null` when no generated attempt is reachable
 * (a tier-A pre-Kafuo chain).
 */
export async function readProducingAttemptTeachingModel(
  tx: Queryable,
  versionId: string,
): Promise<TeachingModelLineage | null> {
  const visited = new Set<string>();
  let currentId: string | null = versionId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const versionResult = await tx.query<Record<string, unknown>>(
      `SELECT current_attempt_id, predecessor_version_id
         FROM teaching_package_versions
        WHERE id = $1`,
      [currentId],
    );
    const row = versionResult.rows[0] as
      | { current_attempt_id: string | null; predecessor_version_id: string | null }
      | undefined;
    if (!row) return null;
    if (row.current_attempt_id) {
      const attemptResult = await tx.query<Record<string, unknown>>(
        `SELECT teaching_model_key, teaching_model_version
           FROM teaching_package_generation_attempts
          WHERE id = $1`,
        [row.current_attempt_id],
      );
      const attempt = attemptResult.rows[0] as
        | { teaching_model_key: string; teaching_model_version: string }
        | undefined;
      if (!attempt) return null;
      return { key: attempt.teaching_model_key, version: attempt.teaching_model_version };
    }
    currentId = row.predecessor_version_id;
  }
  return null;
}

/** A version whose declared model no longer matches its producing attempt's. */
export interface TeachingModelLineageDrift {
  declared: TeachingModelLineage;
  producing: TeachingModelLineage;
}

/**
 * The defensive Submit check's comparison (§L): a Scene's Skill lineage was
 * produced under the PRODUCING attempt's `(key, version)`; if the version row
 * now declares a different pair, every inherited Skill assignment was validated
 * against a different model's policy and must revalidate. Defence against a
 * future path that breaks the model-change ⟹ Stage-replacement invariant — not
 * against a current one. `null` when the pair is intact (or no attempt is
 * reachable, which is the tier-A legacy chain the check never applies to).
 */
export function teachingModelLineageDrift(
  declared: TeachingModelLineage,
  producing: TeachingModelLineage | null,
): TeachingModelLineageDrift | null {
  if (!producing) return null;
  if (declared.key === producing.key && declared.version === producing.version) return null;
  return { declared, producing };
}

/** Result of comparing a successor's Scenes against its predecessor's. */
export interface SuccessorMaterialComparison {
  /** Successor Scenes whose R-6 material fingerprint differs from the same-id predecessor Scene. */
  editedSceneIds: string[];
  /** Successor Scenes with no same-id predecessor Scene (insertions are material). */
  addedSceneIds: string[];
  /** Predecessor Scenes deleted from the successor (deletions are material). */
  removedSceneIds: string[];
}

/** True when nothing pedagogically material changed — a clone-only successor. */
export function isCloneOnlySuccessor(comparison: SuccessorMaterialComparison): boolean {
  return (
    comparison.editedSceneIds.length === 0 &&
    comparison.addedSceneIds.length === 0 &&
    comparison.removedSceneIds.length === 0
  );
}

/**
 * Compare a successor's Scenes against its predecessor's over the CLOSED R-6
 * material boundary (§M correction 2): `content · actions · title ·
 * description`. `order`, `outlineId`, `stageId` and `updatedAt` differences are
 * invisible here — a reorder stays governed by exact-flow, never by this check
 * — and the clone's own `stageId`/`updatedAt` re-stamps never count as edits.
 *
 * A materially edited legacy-derived successor is NOT submit-ready (FR-TS-049,
 * §28.6): it cannot bypass current Teaching Skills validation merely because
 * its predecessor was legacy, and since a legacy chain has no authoritative
 * Teaching Model + Flow + Skill Policy to validate against, the only supported
 * path is regeneration under governance. The historical predecessor is never
 * rewritten — this function only reads.
 */
export function compareSuccessorMaterialScenes(
  successorScenes: readonly AppScene[],
  predecessorScenes: readonly AppScene[],
): SuccessorMaterialComparison {
  const predecessorById = new Map(predecessorScenes.map((scene) => [scene.id, scene]));
  const successorIds = new Set(successorScenes.map((scene) => scene.id));
  const editedSceneIds: string[] = [];
  const addedSceneIds: string[] = [];
  for (const scene of successorScenes) {
    const predecessorScene = predecessorById.get(scene.id);
    if (!predecessorScene) {
      addedSceneIds.push(scene.id);
      continue;
    }
    if (sceneMaterialFingerprint(scene) !== sceneMaterialFingerprint(predecessorScene)) {
      editedSceneIds.push(scene.id);
    }
  }
  const removedSceneIds = predecessorScenes
    .filter((scene) => !successorIds.has(scene.id))
    .map((scene) => scene.id);
  return { editedSceneIds, addedSceneIds, removedSceneIds };
}
