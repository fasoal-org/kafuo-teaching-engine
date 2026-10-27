/**
 * Whole-stage Skill validation for a reviewer-generated slide (reviewer-
 * generated-slide plan §10.8, V2-1). The input set is ALWAYS Scenes — the
 * carrier that persists and that submit validates (F51) — never the outline
 * record, whose `teachingSkills` are generation-time history: every live Scene
 * exactly as stored (including Skills a reviewer changed later, and Scenes
 * with no outline entry) plus the new Scene's selection carrier (planning and
 * the re-ask) or the real candidate Scene (T2).
 *
 * The validators are the submit gate's deterministic checks in their order,
 * plus the Skill edit route's allowed-set check. First failure wins; its
 * scope decides the remedy: naming the new Scene → the planner can fix it
 * (re-ask); naming only existing Scenes, or flow-level → INSERTION_SKILLS_INVALID.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  validateOutlineSkillSelections,
  type OutlineSkillSelectionShape,
} from '@/lib/server/teaching-package/skill-policy';
import {
  validateFlowPolicySatisfiability,
  validateFlowSkillPolicies,
  validateRequiredSkillSatisfaction,
  validateSceneClassifications,
  validateSkillAssignmentStructure,
  validateSkillReferencesResolve,
  type SkillValidatorFailure,
} from '@/lib/server/teaching-package/skill-validators';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

export interface InsertionSkillFailure {
  code: TeachingPackageError['code'];
  message: string;
  details: { offendingSceneIds: string[]; [key: string]: unknown };
  /** `new`: names the new Scene; `existing`: only other Scenes; `flow`: no Scene scope. */
  scope: 'new' | 'existing' | 'flow';
}

/** The set `S`: live Scenes unchanged, plus the new Scene's carrier. */
export function insertionSkillValidationSet(
  liveScenes: readonly AppScene[],
  carrier: OutlineSkillSelectionShape,
): OutlineSkillSelectionShape[] {
  return [...liveScenes.filter((scene) => scene.id !== carrier.id).map(selectionShapeOf), carrier];
}

/** A Scene's selection shape — its id, stage and CURRENT `teachingSkills`, as stored. */
export function selectionShapeOf(scene: AppScene): OutlineSkillSelectionShape {
  return {
    id: scene.id,
    ...(scene.teachingStage ? { teachingStage: scene.teachingStage } : {}),
    ...(scene.teachingSkills ? { teachingSkills: scene.teachingSkills } : {}),
  };
}

function classify(
  failure: { code: TeachingPackageError['code']; message: string; details?: unknown },
  newSceneId: string | null,
  flowLevel: boolean,
): InsertionSkillFailure {
  const raw =
    failure.details && typeof failure.details === 'object'
      ? (failure.details as Record<string, unknown>)
      : {};
  const offendingSceneIds = Array.isArray(raw.offendingSceneIds)
    ? raw.offendingSceneIds.filter((id): id is string => typeof id === 'string')
    : [];
  const scope: InsertionSkillFailure['scope'] =
    flowLevel || offendingSceneIds.length === 0
      ? 'flow'
      : newSceneId !== null && offendingSceneIds.includes(newSceneId)
        ? 'new'
        : 'existing';
  return {
    code: failure.code,
    message: failure.message,
    details: { ...raw, offendingSceneIds },
    scope,
  };
}

/** The seven checks over `S`, first failure wins; `null` = pass. */
export function validateInsertionSkills(
  set: readonly OutlineSkillSelectionShape[],
  flow: readonly TeachingFlowEntry[],
  newSceneId: string,
): InsertionSkillFailure | null {
  const flowChecks = [
    () => validateFlowSkillPolicies(flow),
    () => validateFlowPolicySatisfiability(flow),
  ];
  for (const check of flowChecks) {
    const failure = check();
    if (failure) return classify(failure, null, true);
  }
  const sceneChecks: Array<() => SkillValidatorFailure | null> = [
    () => validateSkillReferencesResolve(flow, set),
    () => {
      try {
        validateOutlineSkillSelections(set, flow);
        return null;
      } catch (error) {
        if (error instanceof TeachingPackageError) {
          return {
            code: error.code,
            message: error.message,
            details: (error.details ?? {
              offendingSceneIds: [],
            }) as SkillValidatorFailure['details'],
          } as SkillValidatorFailure;
        }
        throw error;
      }
    },
    () => validateRequiredSkillSatisfaction(set, flow),
    () => validateSkillAssignmentStructure(set, flow),
    () => validateSceneClassifications(set),
  ];
  for (const check of sceneChecks) {
    const failure = check();
    if (failure) return classify(failure, newSceneId, false);
  }
  return null;
}

/**
 * The pre-check before any paid call: only the per-Scene checks a new slide
 * cannot fix, over the live Scenes alone. A failure is the reviewer's to fix
 * first (the Skill edit route blocks on the same condition).
 */
export function preCheckExistingSceneSkills(
  liveScenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
): InsertionSkillFailure | null {
  const set = liveScenes.map(selectionShapeOf);
  const failure = validateSceneClassifications(set) ?? validateSkillAssignmentStructure(set, flow);
  return failure ? classify(failure, null, false) : null;
}

/** The refusal for a failure that is not the planner's to fix. */
export function insertionSkillsInvalidError(failure: InsertionSkillFailure): TeachingPackageError {
  return new TeachingPackageError(
    'INSERTION_SKILLS_INVALID',
    `the lesson's Teaching Skills do not validate (${failure.code}): ${failure.message}`,
    { ...failure.details, validatorCode: failure.code },
  );
}
