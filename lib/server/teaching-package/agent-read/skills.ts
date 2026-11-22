/**
 * Skill requirement checks for the agent read API (Kafuo Agent API plan §1.5:
 * `skills.checks` per stage-wide requirement). Pure: no I/O.
 *
 * `validateRequiredSkillSatisfaction` stops at the first unsatisfied rule. To
 * report EVERY requirement without re-implementing it, the validator is invoked
 * once per (flow position, rule) on a copy of the flow in which only that rule
 * stays required; each call then returns that rule's full `offendingSceneIds`.
 * So a stage-wide requirement failing on six scenes is one entry, not six.
 */
import { validateRequiredSkillSatisfaction } from '@/lib/server/teaching-package/skill-validators';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';

export interface SkillRequirementCheck {
  code: string;
  message: string;
  /** `skillId@version` of the required Skill; null for a check that is not a requirement. */
  required: string | null;
  role: string | null;
  scope: string | null;
  teaching_stage_key: string | null;
  flow_index: number | null;
  failing_scene_ids: string[];
}

/** `{skillId, version}` → `skillId@version`. */
export function skillRefString(ref: TeachingSkillRef): string {
  return `${ref.skillId}@${ref.version}`;
}

/** One entry per unsatisfied requirement, in flow order then rule order. */
export function collectSkillRequirementChecks(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
): SkillRequirementCheck[] {
  const checks: SkillRequirementCheck[] = [];
  flow.forEach((entry, flowIndex) => {
    const policy = entry.skillPolicy;
    if (!policy) return;
    for (const rule of policy.required) {
      const isolated = flow.map((candidate, index) =>
        index === flowIndex
          ? { ...candidate, skillPolicy: { ...policy, required: [rule] } }
          : candidate.skillPolicy
            ? { ...candidate, skillPolicy: { ...candidate.skillPolicy, required: [] } }
            : candidate,
      );
      const failure = validateRequiredSkillSatisfaction(scenes, isolated);
      if (!failure) continue;
      checks.push({
        code: failure.code,
        message: failure.message,
        required: skillRefString(rule.skill),
        role: rule.role,
        scope: rule.scope,
        teaching_stage_key: entry.stage,
        flow_index: flowIndex,
        failing_scene_ids: [...failure.details.offendingSceneIds],
      });
    }
  });
  return checks;
}
