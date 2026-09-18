/**
 * Durable reviewer confirmation of per-Scene alignment (Module 2 W15 —
 * teaching-skills plan §P Step 16 · §K · §F · BR-TS-032/038 ·
 * FR-TS-037/044/045/071 · VAL-TS-010 · AC-TS-032).
 *
 * The reviewer confirmation is an alignment BASELINE whose origin is
 * `'reviewer-confirmation'` — the same shape generation stamps, so Submit has
 * one thing to check. It binds the Scene's CURRENT assignment, classification
 * and material fingerprint, plus who confirmed and when; identity and state
 * only, no chain-of-thought and no rationale (BR-TS-032, FR-TS-037).
 *
 * Validity is RECOMPUTED AT READ, never trusted: a confirmation survives
 * exactly until a later material edit, Skill change or classification change
 * makes the Scene stop matching it — invalidation is by construction, with no
 * flag any write path could forget to clear. `sceneRev` is deliberately not in
 * the binding (a metadata-only edit must not undo a confirmation, FR-TS-043);
 * it still guards the WRITE through putScene's optimistic concurrency.
 *
 * This is also the resolution mechanism for the uncertain-classification case
 * (a Scene marked non-instructional that is pedagogically active): the
 * reviewer confirms the corrected state through this same route — one
 * mechanism, no second system.
 *
 * Persistence owner: package Scene/Stage lifecycle data (an AppScene field),
 * so the baseline travels with a same-model clone, is governed by the shared
 * editability guard, and freezes with approved content. No lock is needed: a
 * stale baseline is inert rather than dangerous.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { readVersion } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { readTeachingSkillsGovernanceForVersion } from '@/lib/server/teaching-package/exact-flow';
import { buildSceneAlignmentBaseline } from '@/lib/server/teaching-package/alignment';
import { TEACHING_PACKAGE_EDITABLE_STATUSES } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

export interface SceneAlignmentConfirmation {
  sceneId: string;
}

/** Shape-level validation of one confirmation entry; throws INVALID_REQUEST. */
export function normalizeConfirmation(confirmation: {
  sceneId: unknown;
}): SceneAlignmentConfirmation {
  if (typeof confirmation.sceneId !== 'string' || confirmation.sceneId.trim() === '') {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'confirmations[].sceneId must be a non-empty string',
    );
  }
  return { sceneId: confirmation.sceneId };
}

/**
 * Record reviewer confirmations for the listed scenes of one package version.
 * Each confirmation baselines the Scene's CURRENT state; a rejected request
 * writes nothing (every scene is resolved and validated before the first
 * putScene).
 */
export async function confirmSceneAlignments(
  pool: ConnectableQueryable,
  versionId: string,
  scope: { tenantId: string; actorRef: string },
  confirmations: SceneAlignmentConfirmation[],
  now: number = Date.now(),
): Promise<{ confirmedSceneIds: string[] }> {
  if (confirmations.length === 0) {
    throw new TeachingPackageError('INVALID_REQUEST', 'confirmations must not be empty');
  }
  if (typeof scope.tenantId !== 'string' || scope.tenantId.trim() === '') {
    throw new TeachingPackageError(
      'TENANT_REQUIRED',
      'tenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof scope.actorRef !== 'string' || scope.actorRef.trim() === '') {
    throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a non-empty string');
  }

  const version = await readVersion(pool, versionId, { tenantId: scope.tenantId });
  if (!version) {
    throw new TeachingPackageError('NOT_FOUND', `teaching package ${versionId} not found`);
  }
  // Confirmation is a Stage-resident write: the shared editability guard, the
  // same predicate every Module 2 mutation route uses (plan §L).
  if (!TEACHING_PACKAGE_EDITABLE_STATUSES.includes(version.status)) {
    throw new TeachingPackageError(
      'INVALID_TRANSITION',
      `scene alignment can be confirmed only on a ${TEACHING_PACKAGE_EDITABLE_STATUSES.join(' or ')} version, not ${version.status}`,
    );
  }

  // Governance first (§M): confirming Skill alignment is meaningless without a
  // governed lineage — refused BEFORE any Skill code, never a Skill error for
  // a legacy package.
  const governance = await readTeachingSkillsGovernanceForVersion(pool, version.id);
  if (!governance?.contract) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'scene alignment can be confirmed only on a Teaching Skills-governed version; this version has no governance lineage',
      { versionId: version.id },
    );
  }

  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the version’s stage is not live');
  }

  // Resolve every target scene and refuse anything unconfirmable BEFORE the
  // first write — no partial confirmation state.
  const targets: AppScene[] = [];
  for (const confirmation of confirmations) {
    const scene = document.scenes.find((candidate) => candidate.id === confirmation.sceneId);
    if (!scene) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `scene ${confirmation.sceneId} does not exist on this version’s stage`,
        { sceneId: confirmation.sceneId },
      );
    }
    if (!scene.teachingSkills) {
      // A confirmation binds an assignment + classification. A governed Scene
      // without the carrier has nothing pedagogical to confirm — the submit
      // gate's structural checks own that failure; confirming here would
      // launder it.
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `scene ${confirmation.sceneId} carries no Teaching Skills assignment to confirm`,
        { sceneId: confirmation.sceneId },
      );
    }
    const classification = scene.teachingSkills.classification;
    if (classification !== 'instructional' && classification !== 'non-instructional') {
      // Mirrors the missing-carrier refusal above: a baseline binds a
      // classification the Scene ACTUALLY carries. Confirming an unclassified
      // Scene would write a baseline it can never match — `aligned` would stay
      // false after a successful confirmation. Refused before the first
      // putScene, so nothing is written for any target in the request.
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `scene ${confirmation.sceneId} carries no instructional classification to confirm`,
        { sceneId: confirmation.sceneId },
      );
    }
    targets.push(scene);
  }

  const confirmedSceneIds: string[] = [];
  for (const scene of targets) {
    const baseline = buildSceneAlignmentBaseline(scene, {
      origin: 'reviewer-confirmation',
      actorRef: scope.actorRef,
      now,
    });
    if (!baseline) {
      // Unreachable behind the classification guard in the resolution loop.
      // Kept explicit — never a non-null assertion — so the compiler forces
      // every future caller of the constructor to confront the unclassified
      // shape rather than re-fabricating a classification.
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `scene ${scene.id} carries no instructional classification to confirm`,
        { sceneId: scene.id },
      );
    }
    const updated: AppScene = {
      ...scene,
      alignmentBaseline: baseline,
    };
    await store.putScene(document.stage.id, updated);
    confirmedSceneIds.push(scene.id);
  }
  return { confirmedSceneIds };
}
