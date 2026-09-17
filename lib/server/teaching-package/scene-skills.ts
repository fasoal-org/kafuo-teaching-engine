/**
 * Scene Teaching Skills mutation (Module 2 W14 — teaching-skills plan §P
 * Step 15 · §J · §K · BR-TS-035 · FR-TS-039/040/041/054/070 · VAL-TS-016/023 ·
 * AC-TS-015).
 *
 * The policy-constrained Primary/Supporting/classification change for
 * `draft`/`rejected` versions, shaped exactly on `scene-objectives.ts`:
 *
 * ```text
 * Skill change → keep Scene content → NO silent regeneration
 *              → confirmation invalidated (by construction, not by a flag)
 *              → validation required before Submit
 * ```
 *
 * Because the alignment baseline (W15) binds to the assignment, a Skill switch
 * invalidates it BY CONSTRUCTION — the derivation simply stops matching; no
 * invalidation flag exists to forget to set. Content, Actions, title and flow
 * identity (`teachingStage`) are never touched: a Skill change may not alter
 * flow identity or authoritative order (FR-TS-041), and the write is a single
 * `putScene` per scene, so a rejected selection leaves NO partial assignment
 * (FR-TS-054, AC-TS-009) — everything is validated before the first write.
 *
 * Editability routes through the SHARED exported guard constant
 * (`TEACHING_PACKAGE_EDITABLE_STATUSES`), never a hand-rolled inline predicate
 * (plan §L: a ninth divergent copy would silently weaken Module 1).
 *
 * Validation INVOKEs the existing W10/W12 validators over the proposed
 * post-change selection set — it reimplements none of their rules. A LEGACY
 * version (no Teaching Skills governance) is refused before any Skill code can
 * surface: legacy packages never produce Skill errors (§M).
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { readVersion } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  readFlowForVersion,
  readTeachingSkillsGovernanceForVersion,
} from '@/lib/server/teaching-package/exact-flow';
import {
  validateOutlineSkillSelections,
  type OutlineSkillSelectionShape,
} from '@/lib/server/teaching-package/skill-policy';
import {
  validateSceneClassifications,
  validateSkillAssignmentStructure,
} from '@/lib/server/teaching-package/skill-validators';
import { toTeachingPackageError } from '@/lib/server/teaching-package/skill-validators';
import {
  TEACHING_PACKAGE_EDITABLE_STATUSES,
  type SceneTeachingSkills,
  type TeachingSkillRef,
} from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

export interface SceneSkillAssignment {
  sceneId: string;
  /** Replaces the scene's Teaching Skills carrier outright. */
  teachingSkills: SceneTeachingSkills;
}

export interface ValidatedSkillAssignment {
  sceneId: string;
  teachingSkills: SceneTeachingSkills;
}

/** Shape-level validation of one assignment's payload; throws INVALID_REQUEST. */
export function normalizeSkillAssignment(assignment: {
  sceneId: unknown;
  teachingSkills: unknown;
}): ValidatedSkillAssignment {
  if (typeof assignment.sceneId !== 'string' || assignment.sceneId.trim() === '') {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'assignments[].sceneId must be a non-empty string',
    );
  }
  const record =
    assignment.teachingSkills && typeof assignment.teachingSkills === 'object'
      ? (assignment.teachingSkills as Record<string, unknown>)
      : null;
  if (!record) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'assignments[].teachingSkills must be an object',
    );
  }
  const ref = (value: unknown, where: string): TeachingSkillRef => {
    const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    if (
      !entry ||
      typeof entry.skillId !== 'string' ||
      entry.skillId.trim() === '' ||
      typeof entry.version !== 'string' ||
      entry.version.trim() === ''
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `${where} must be an exact { skillId, version } reference`,
      );
    }
    return { skillId: entry.skillId, version: entry.version };
  };
  const teachingSkills: SceneTeachingSkills = {};
  if (record.primary !== undefined) {
    teachingSkills.primary = ref(record.primary, 'teachingSkills.primary');
  }
  if (record.supporting !== undefined) {
    if (!Array.isArray(record.supporting)) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'teachingSkills.supporting must be an array when present',
      );
    }
    teachingSkills.supporting = record.supporting.map((entry, index) =>
      ref(entry, `teachingSkills.supporting[${index}]`),
    );
  }
  if (record.classification !== undefined) {
    if (
      record.classification !== 'instructional' &&
      record.classification !== 'non-instructional'
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'teachingSkills.classification must be "instructional" | "non-instructional" when present',
      );
    }
    teachingSkills.classification = record.classification;
  }
  return { sceneId: assignment.sceneId, teachingSkills };
}

/**
 * Replace the Teaching Skills carrier on the listed scenes of one package
 * version, within policy. All assignments are validated against the version's
 * authoritative flow policy BEFORE the first write, so a rejection leaves no
 * partial state anywhere.
 */
export async function setSceneTeachingSkills(
  pool: ConnectableQueryable,
  versionId: string,
  scope: { tenantId: string },
  assignments: ValidatedSkillAssignment[],
): Promise<{ updatedSceneIds: string[] }> {
  if (assignments.length === 0) {
    throw new TeachingPackageError('INVALID_REQUEST', 'assignments must not be empty');
  }
  if (typeof scope.tenantId !== 'string' || scope.tenantId.trim() === '') {
    throw new TeachingPackageError(
      'TENANT_REQUIRED',
      'tenantContext.tenantId must be a non-empty string',
    );
  }

  const version = await readVersion(pool, versionId, scope);
  if (!version) {
    throw new TeachingPackageError('NOT_FOUND', `teaching package ${versionId} not found`);
  }
  // The shared guard constant — the same predicate the whole module owns (§L).
  if (!TEACHING_PACKAGE_EDITABLE_STATUSES.includes(version.status)) {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      `scene teaching skills can be changed only on a ${TEACHING_PACKAGE_EDITABLE_STATUSES.join(' or ')} version, not ${version.status}`,
    );
  }

  // Governance first (§M): a legacy version has no policy to select within, so
  // the operation does not exist for it — refused BEFORE any Skill code, with
  // a non-Skill error. Legacy packages never produce Skill errors.
  const governance = await readTeachingSkillsGovernanceForVersion(pool, version.id);
  if (!governance?.contract) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'teaching package scene Skill assignments can be changed only on a Teaching Skills-governed version; this version has no governance lineage',
      { versionId: version.id },
    );
  }
  const flow = await readFlowForVersion(pool, version.id);
  if (!flow || flow.length === 0) {
    // Governed without a resolvable flow is fail-closed by contract (the parse
    // seam refuses such a request), so reaching here means corrupt lineage.
    throw new TeachingPackageError(
      'SKILL_POLICY_REQUIRED',
      'the governed version records no Teaching Model Flow to validate a Skill change against',
    );
  }

  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the version’s stage is not live');
  }

  // Build the proposed post-change selection set over the SCENES — the carrier
  // that persists, that the editor edits, and that the submit gate validates.
  const updatedById = new Map(assignments.map((assignment) => [assignment.sceneId, assignment]));
  const proposed: OutlineSkillSelectionShape[] = document.scenes.map((scene) => {
    const assignment = updatedById.get(scene.id);
    if (!assignment) return scene;
    // ONLY the teachingSkills carrier moves. Content, actions, title, order and
    // teachingStage (flow identity, FR-TS-041) are carried over byte-identical.
    return { ...scene, teachingSkills: assignment.teachingSkills };
  });

  // Every listed scene must exist — an unknown id refuses the whole request.
  for (const assignment of assignments) {
    if (!document.scenes.some((scene) => scene.id === assignment.sceneId)) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `scene ${assignment.sceneId} does not exist on this version’s stage`,
        { sceneId: assignment.sceneId },
      );
    }
  }

  // Policy validation — INVOKED, never re-implemented. The W10 validator
  // enforces exact-version resolution, the position's permitted (allowed)
  // boundary, and required scope/role over the post-change set; the W12
  // validators enforce assignment structure (exactly one Primary when
  // instructional, no selections when non-instructional, canonical-ID
  // duplicates, explicit restrictions) and classification structure.
  try {
    validateOutlineSkillSelections(proposed, flow);
    const structure = validateSkillAssignmentStructure(proposed, flow);
    if (structure) throw toTeachingPackageError(structure);
    const classification = validateSceneClassifications(proposed);
    if (classification) throw toTeachingPackageError(classification);
  } catch (error) {
    // Attach the failed assignment's scene scope where the validators could not
    // know it (flow-level failures) — no partial state was written.
    if (error instanceof TeachingPackageError) {
      const base =
        error.details && typeof error.details === 'object'
          ? { ...(error.details as Record<string, unknown>) }
          : {};
      if (!Array.isArray(base.offendingSceneIds) || base.offendingSceneIds.length === 0) {
        base.offendingSceneIds = assignments.map((assignment) => assignment.sceneId);
      }
      throw new TeachingPackageError(error.code, error.message, base);
    }
    throw error;
  }

  // Single putScene per scene — the ONLY write, and nothing precedes it that
  // could leave a half-applied assignment (FR-TS-054).
  const updatedSceneIds: string[] = [];
  for (const assignment of assignments) {
    const scene = document.scenes.find((candidate) => candidate.id === assignment.sceneId)!;
    const updated: AppScene = { ...scene, teachingSkills: assignment.teachingSkills };
    await store.putScene(document.stage.id, updated);
    updatedSceneIds.push(assignment.sceneId);
  }
  return { updatedSceneIds };
}
