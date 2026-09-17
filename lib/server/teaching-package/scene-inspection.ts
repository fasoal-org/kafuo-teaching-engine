/**
 * Per-Scene Teaching Skills inspection (Module 2 W16 — teaching-skills plan
 * §P Step 17 · §J · FR-TS-038/045/053 · AC-TS-026).
 *
 * The reviewer-facing read surface behind the Editor panel: all eight fields
 * per Scene — classification · Primary · Supporting · exact versions · policy
 * relationship · flow position · alignment state · actionable failures — for
 * EVERY Scene type. The builder is Scene-type-agnostic by construction: it
 * reads the `teachingSkills`/`teachingStage` app-layer carriers, which every
 * Scene type carries on the same field (W9's one-carrier rule); nothing here
 * switches on `scene.type`.
 *
 * Failures are produced by INVOKING the W12/W10 validators over the current
 * scene set and flow — never reimplemented — and are attributed to Scenes via
 * each validator's `offendingSceneIds`; a validator whose failure names no
 * scene (a flow-level configuration fault) is reported on every Scene at the
 * implicated flow position, so it is still visible where it bites.
 */
import {
  deriveSceneAlignment,
  type SceneAlignmentDerivation,
} from '@/lib/server/teaching-package/alignment';
import {
  validateRequiredSkillSatisfaction,
  validateSceneClassifications,
  validateSkillAssignmentStructure,
  validateSkillReferencesResolve,
  validateFlowSkillPolicies,
  validateFlowPolicySatisfiability,
  type SkillValidatorFailure,
} from '@/lib/server/teaching-package/skill-validators';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';

/** How a Scene's selections relate to its flow position's policy. */
export type PolicyRelationship = 'within-policy' | 'out-of-policy' | 'no-policy';

export interface SceneInspection {
  sceneId: string;
  sceneType: string;
  /** Flow identity + zero-based position, exactly as the Scene carries it. */
  flowPosition: { key: string; flowIndex: number } | null;
  classification: string | null;
  primary: TeachingSkillRef | null;
  supporting: TeachingSkillRef[];
  /** The position's permitted sets (empty when the position carries no policy). */
  policy: {
    relationship: PolicyRelationship;
    allowed: TeachingSkillRef[];
    required: Array<TeachingSkillRef & { role: string; scope: string }>;
    preferred: TeachingSkillRef[];
  };
  alignment: {
    state: SceneAlignmentDerivation['state'];
    aligned: boolean;
    reason?: SceneAlignmentDerivation['reason'];
    baselineOrigin?: 'generation' | 'reviewer-confirmation';
  };
  /** Scene-scoped actionable failures (FR-TS-053), each with its code. */
  failures: Array<{ code: string; message: string }>;
}

export interface StageTeachingSkillsInspection {
  scenes: SceneInspection[];
}

const samePair = (a: TeachingSkillRef, b: TeachingSkillRef) =>
  a.skillId === b.skillId && a.version === b.version;

/**
 * Invoke every §L validator ONCE over the full scene set (position-wide rules
 * like `flow_position` requirements must see every Scene at the position — a
 * per-scene run would misreport them), then attribute each failure to its
 * Scenes via `offendingSceneIds`. A failure that names no Scene (a flow-level
 * configuration fault, checks 4/5) is attributed to every Scene at the
 * implicated flow position, so it still surfaces where it bites.
 */
function attributeFailures(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
): Map<string, Array<{ code: string; message: string }>> {
  const byScene = new Map<string, Array<{ code: string; message: string }>>();
  const attribute = (sceneIds: Iterable<string>, failure: SkillValidatorFailure) => {
    for (const sceneId of sceneIds) {
      const list = byScene.get(sceneId) ?? [];
      list.push({ code: failure.code, message: failure.message });
      byScene.set(sceneId, list);
    }
  };
  const sceneValidators: Array<() => SkillValidatorFailure | null> = [
    () => validateSkillReferencesResolve(flow, scenes),
    () => validateRequiredSkillSatisfaction(scenes, flow),
    () => validateSkillAssignmentStructure(scenes, flow),
    () => validateSceneClassifications(scenes),
  ];
  for (const validate of sceneValidators) {
    const failure = validate();
    if (failure) attribute(failure.details.offendingSceneIds, failure);
  }
  for (const validate of [validateFlowSkillPolicies, validateFlowPolicySatisfiability]) {
    const failure = validate(flow);
    if (!failure) continue;
    const position = failure.details.flowIndex;
    const atPosition =
      typeof position === 'number'
        ? scenes.filter((scene) => scene.teachingStage?.flowIndex === position).map((s) => s.id)
        : scenes.map((scene) => scene.id);
    attribute(atPosition.length > 0 ? atPosition : scenes.map((scene) => scene.id), failure);
  }
  return byScene;
}

/**
 * Build the per-Scene inspection for one governed Stage: the eight fields per
 * Scene, alignment derived at read (§K), failures invoked from the §L
 * validators. Callers pass the loaded document scenes and the authoritative
 * flow; the function is pure and read-only.
 */
export function buildStageTeachingSkillsInspection(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
): StageTeachingSkillsInspection {
  const failuresByScene = attributeFailures(scenes, flow);
  return {
    scenes: scenes.map((scene) => {
      const skills = scene.teachingSkills;
      const position = scene.teachingStage ?? null;
      const entry = position ? (flow[position.flowIndex] ?? null) : null;
      const policy = entry?.skillPolicy;
      const selections = [
        ...(skills?.primary ? [skills.primary] : []),
        ...(skills?.supporting ?? []),
      ];
      const withinPolicy =
        policy === undefined
          ? ('no-policy' as const)
          : selections.every((ref) => policy.allowed.some((allowed) => samePair(allowed, ref)))
            ? ('within-policy' as const)
            : ('out-of-policy' as const);
      const derivation = deriveSceneAlignment(scene);
      return {
        sceneId: scene.id,
        sceneType: scene.type,
        flowPosition: position ? { key: position.key, flowIndex: position.flowIndex } : null,
        classification: skills?.classification ?? null,
        primary: skills?.primary ?? null,
        supporting: [...(skills?.supporting ?? [])],
        policy: {
          relationship: withinPolicy,
          allowed: policy ? [...policy.allowed] : [],
          required: policy
            ? policy.required.map((rule) => ({
                ...rule.skill,
                role: rule.role,
                scope: rule.scope,
              }))
            : [],
          preferred: policy ? [...policy.preferred] : [],
        },
        alignment: {
          state: derivation.state,
          aligned: derivation.aligned,
          ...(derivation.reason ? { reason: derivation.reason } : {}),
          ...(derivation.baselineOrigin ? { baselineOrigin: derivation.baselineOrigin } : {}),
        },
        failures: failuresByScene.get(scene.id) ?? [],
      };
    }),
  };
}
