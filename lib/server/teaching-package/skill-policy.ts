/**
 * Teaching Skills policy resolution (Module 2 W5 — teaching-skills plan §P Step 6,
 * §E/§G).
 *
 * TE alone is authoritative for whether a policy's exact `(skillId, version)`
 * references resolve: Kafuo validated their shape before dispatch, and a
 * structurally valid reference to a non-existent canonical Skill or version
 * passes Kafuo and is refused HERE (plan §G — the ownership boundary).
 *
 * What this module does:
 * - collects every exact reference across the received flow entries' policies
 *   (required / preferred / allowed / combination restrictions);
 * - resolves each against the W1 canonical registry
 *   (`resolveCanonicalSkillVersion` — exact-version only, no "latest" path);
 * - maps the registry's single historical-integrity refusal onto the
 *   generation-time outcomes the contract names: unknown identity ⇒
 *   `SKILL_NOT_FOUND` (422), unresolvable version ⇒ `SKILL_VERSION_UNRESOLVED`
 *   (422). `SKILL_LINEAGE_UNRESOLVABLE` (409) stays reserved for HISTORICAL
 *   interpretation (plan §M) and never leaks out of this module;
 * - exposes `requireCompleteFlowPolicies` — the governed-request completeness
 *   refusal (`SKILL_POLICY_REQUIRED`, BR-TS-048) the W8 gate will wire.
 *
 * Module 2 W10 adds `validateOutlineSkillSelections` — the deterministic
 * Stage-1-gate validation of the selections the Generation Agent emitted onto
 * outline `teachingSkills` carriers (invented identity, out-of-policy
 * selection, required scope/role; preferred never binds).
 *
 * Module 2 W6 adds the policy-lineage digest (`computeSkillPolicyDigest`) —
 * integrity evidence for the attempt columns, never the mode declaration.
 *
 * What it deliberately does NOT do: re-expand the Teaching Model, re-derive or
 * re-project policy (Kafuo's `expand_teaching_model_flow` already did; TE
 * validates what it received), and it never touches the post-approval
 * question-generation mirror `expandFlowStages`.
 */
import { createHash } from 'node:crypto';

import {
  resolveCanonicalSkillVersion,
  type CanonicalSkillDefinition,
} from '@/lib/server/agent-runtime/canonical-skills';
import { skillsDir } from '@/lib/server/agent-runtime/skills';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';

/**
 * Deterministic digest of a request's resolved Skill Policy lineage (Module 2
 * W6, R-4): sha256 over the sorted-key compact JSON of the ordered per-entry
 * policies. Integrity evidence ONLY — it names which policy lineage governed
 * the attempt and makes silent drift detectable; it is not the governance mode
 * declaration (the `teachingSkills` contract marker is) and never a substitute
 * for Teaching Model version immutability.
 */
export function computeSkillPolicyDigest(flow: readonly TeachingFlowEntry[]): string | null {
  const carried = flow.filter((entry) => entry.skillPolicy !== undefined);
  if (carried.length === 0) return null;
  const canonical = JSON.stringify(
    carried.map((entry) => entry.skillPolicy),
    (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        );
      }
      return value;
    },
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Every exact reference one entry's policy names, in stable order. */
export function skillRefsInPolicy(
  policy: NonNullable<TeachingFlowEntry['skillPolicy']>,
): TeachingSkillRef[] {
  const refs: TeachingSkillRef[] = [];
  for (const rule of policy.required) refs.push(rule.skill);
  refs.push(...policy.preferred);
  refs.push(...policy.allowed);
  for (const restriction of policy.combinationRestrictions) {
    refs.push(restriction.skillA, restriction.skillB);
  }
  return refs;
}

/**
 * Resolve every exact `(skillId, version)` referenced by the received flow
 * entries' policies against the canonical registry. Returns the definitions
 * keyed by `skillId@version` — the resolved SKILL.md bodies later waves inject
 * into generation. Duplicate references across entries resolve once.
 *
 * Entries without policy are skipped here: whether a governed request may carry
 * them is a MODE question (`requireCompleteFlowPolicies`), not a resolution one.
 */
export function resolveFlowSkillPolicies(
  flow: readonly TeachingFlowEntry[],
  dir: string = skillsDir,
): Map<string, CanonicalSkillDefinition> {
  const resolved = new Map<string, CanonicalSkillDefinition>();
  for (const entry of flow) {
    if (!entry.skillPolicy) continue;
    for (const ref of skillRefsInPolicy(entry.skillPolicy)) {
      const key = `${ref.skillId}@${ref.version}`;
      if (resolved.has(key)) continue;
      resolved.set(key, resolvePolicyRef(ref, entry, dir));
    }
  }
  return resolved;
}

function resolvePolicyRef(
  ref: TeachingSkillRef,
  entry: TeachingFlowEntry,
  dir: string,
): CanonicalSkillDefinition {
  try {
    return resolveCanonicalSkillVersion(ref.skillId, ref.version, dir);
  } catch (error) {
    const details =
      error instanceof TeachingPackageError && error.details && typeof error.details === 'object'
        ? (error.details as { reason?: unknown })
        : {};
    // The W1 registry reports one refusal for historical interpretation; this
    // module owns the generation-time mapping (plan §G/§M). An unknown identity
    // is SKILL_NOT_FOUND; everything else means the exact version named by a
    // structurally valid reference cannot be resolved for use.
    if (details.reason === 'skill_unknown') {
      throw new TeachingPackageError(
        'SKILL_NOT_FOUND',
        `skill policy on flow entry "${entry.stage}" references canonical skill ${JSON.stringify(ref.skillId)}, which does not exist in the Teaching Engine registry`,
        { skillId: ref.skillId, version: ref.version, stage: entry.stage },
      );
    }
    throw new TeachingPackageError(
      'SKILL_VERSION_UNRESOLVED',
      `skill policy on flow entry "${entry.stage}" references ${JSON.stringify(ref.skillId)} version ${JSON.stringify(ref.version)}, which does not resolve to an exact canonical version — never substituted with a newer version`,
      { skillId: ref.skillId, version: ref.version, stage: entry.stage, reason: details.reason },
    );
  }
}

/**
 * The governed-request completeness refusal (BR-TS-048): when a request is
 * Module-2 governed, EVERY flow item must carry the Skill Policy its definition
 * item projected. A governed request that lost its policy fails closed here
 * instead of degrading to unrestricted catalog selection.
 *
 * The governance MODE itself (the `teachingSkills` marker) is parsed and derived
 * once by the W6 lineage work; this helper is the refusal that gate calls.
 */
export function requireCompleteFlowPolicies(
  flow: readonly TeachingFlowEntry[],
  options: { stageKeys?: readonly string[] } = {},
): void {
  for (let index = 0; index < flow.length; index += 1) {
    const entry = flow[index]!;
    if (entry.skillPolicy) continue;
    throw new TeachingPackageError(
      'SKILL_POLICY_REQUIRED',
      `teachingModel.flow[${index}] (stage "${entry.stage}") carries no Skill Policy; a governed request fails closed rather than using unrestricted Skill selection`,
      { flowIndex: index, stage: entry.stage, stageKeys: [...(options.stageKeys ?? [])] },
    );
  }
}

/**
 * The structural outline slice `validateOutlineSkillSelections` needs. Declared
 * locally so the validator stays independently callable against any SceneOutline
 * twin (app `lib/types/generation`, package outline-types) without an import
 * cycle.
 */
export interface OutlineSkillSelectionShape {
  id: string;
  teachingStage?: { key: string; flowIndex: number };
  teachingSkills?: {
    primary?: TeachingSkillRef;
    supporting?: readonly TeachingSkillRef[];
    classification?: string;
  };
}

const sameSkillPair = (a: TeachingSkillRef, b: TeachingSkillRef) =>
  a.skillId === b.skillId && a.version === b.version;

/**
 * Deterministic Stage-1-gate validation of the selections the Generation Agent
 * emitted onto outline `teachingSkills` carriers (Module 2 W10 — enforced by
 * code, never by prompt wording alone):
 *
 * - every selected ref (primary + supporting) must resolve against the W1
 *   canonical registry — an invented identity refuses with `SKILL_NOT_FOUND`
 *   (VAL-TS-001), an unresolvable exact version with `SKILL_VERSION_UNRESOLVED`;
 * - every selected ref must be inside its flow position's permitted (allowed)
 *   set — an out-of-policy selection refuses with `SKILL_ASSIGNMENT_INVALID`
 *   (VAL-TS-004; the unrestricted catalog is never a fallback, BR-TS-048);
 * - every required rule must be satisfied exactly as scoped and roled
 *   (`SKILL_REQUIREMENT_UNSATISFIED`, VAL-TS-005 — no default scope inferred).
 *
 * Preferred Skills deliberately DO NOT bind (BR-TS-011): a selection that skips
 * a preferred Skill is valid, and this validator must never reject one.
 *
 * Deliberately out of scope here (W12's §L checks): instructional-without-
 * primary structure, duplicate supporting / primary-as-supporting keying,
 * combination restrictions, and classification structural validity. For
 * requirement satisfaction an outline NOT explicitly classified
 * `non-instructional` counts as instructional — omitting the classification can
 * never dodge a requirement (BR-TS-054).
 */
export function validateOutlineSkillSelections(
  outlines: readonly OutlineSkillSelectionShape[],
  flow: readonly TeachingFlowEntry[],
  dir: string = skillsDir,
): void {
  // Per-outline permission checks first, so an invented identity is reported as
  // SKILL_NOT_FOUND rather than as a generic out-of-policy assignment.
  for (const outline of outlines) {
    const skills = outline.teachingSkills;
    if (!skills) continue;
    const selections: Array<{ role: 'primary' | 'supporting'; ref: TeachingSkillRef }> = [];
    if (skills.primary) selections.push({ role: 'primary', ref: skills.primary });
    for (const ref of skills.supporting ?? []) selections.push({ role: 'supporting', ref });

    if (selections.length === 0) continue;

    const stageRef = outline.teachingStage;
    if (!stageRef || stageRef.flowIndex < 0 || stageRef.flowIndex >= flow.length) {
      throw new TeachingPackageError(
        'SKILL_ASSIGNMENT_INVALID',
        `outline ${JSON.stringify(outline.id)} carries a Skill selection but no usable teachingStage flow position to attribute it to`,
        { offendingSceneIds: [outline.id] },
      );
    }
    const entry = flow[stageRef.flowIndex]!;
    const policy = entry.skillPolicy;
    if (!policy) {
      // Unreachable behind requireCompleteFlowPolicies on the assembled gate;
      // kept fail-closed so the validator is safe to call independently.
      throw new TeachingPackageError(
        'SKILL_POLICY_REQUIRED',
        `outline ${JSON.stringify(outline.id)} selects Skills at flow position ${stageRef.flowIndex} (stage "${entry.stage}"), which carries no Skill Policy`,
        { offendingSceneIds: [outline.id], flowIndex: stageRef.flowIndex, stage: entry.stage },
      );
    }

    for (const { role, ref } of selections) {
      // Registry resolution: invented identities and unresolvable exact versions
      // are distinct failures from an out-of-policy but resolvable selection.
      // The W5 helper reports the reference's own context; rethrow with the
      // selecting outline's scene scope so the refusal is actionable (FR-TS-053).
      try {
        resolvePolicyRef(ref, entry, dir);
      } catch (error) {
        if (error instanceof TeachingPackageError) {
          const base =
            error.details && typeof error.details === 'object' ? (error.details as object) : {};
          throw new TeachingPackageError(
            error.code,
            `outline ${JSON.stringify(outline.id)}: ${error.message}`,
            {
              ...base,
              offendingSceneIds: [outline.id],
              sceneId: outline.id,
              flowIndex: stageRef.flowIndex,
              stage: entry.stage,
              role,
            },
          );
        }
        throw error;
      }
      const permitted = policy.allowed.some((allowedRef) => sameSkillPair(allowedRef, ref));
      if (!permitted) {
        throw new TeachingPackageError(
          'SKILL_ASSIGNMENT_INVALID',
          `outline ${JSON.stringify(outline.id)} selects ${JSON.stringify(ref.skillId)}@${JSON.stringify(ref.version)} as ${role} at flow position ${stageRef.flowIndex} (stage "${entry.stage}"), which is outside that position's permitted Skills — the unrestricted catalog is never a fallback`,
          {
            offendingSceneIds: [outline.id],
            sceneId: outline.id,
            flowIndex: stageRef.flowIndex,
            stage: entry.stage,
            skillId: ref.skillId,
            skillVersion: ref.version,
            role,
          },
        );
      }
    }
  }

  // Required scope and role satisfaction per flow position (VAL-TS-005).
  for (let flowIndex = 0; flowIndex < flow.length; flowIndex += 1) {
    const entry = flow[flowIndex]!;
    const policy = entry.skillPolicy;
    if (!policy || policy.required.length === 0) continue;

    const atPosition = outlines.filter((outline) => outline.teachingStage?.flowIndex === flowIndex);
    // BR-TS-054: only an EXPLICIT non-instructional classification exempts an
    // outline from every-instructional-scene requirements; omission never does.
    const instructional = atPosition.filter(
      (outline) => outline.teachingSkills?.classification !== 'non-instructional',
    );

    for (const rule of policy.required) {
      const role = rule.role;
      const satisfied = (outline: OutlineSkillSelectionShape): boolean => {
        const skills = outline.teachingSkills;
        if (!skills) return false;
        if (role === 'primary') {
          return !!skills.primary && sameSkillPair(skills.primary, rule.skill);
        }
        return (skills.supporting ?? []).some((ref) => sameSkillPair(ref, rule.skill));
      };

      if (rule.scope === 'every_instructional_scene') {
        const offenders = instructional.filter((outline) => !satisfied(outline));
        if (offenders.length > 0) {
          throw new TeachingPackageError(
            'SKILL_REQUIREMENT_UNSATISFIED',
            `required Skill ${JSON.stringify(rule.skill.skillId)}@${JSON.stringify(rule.skill.version)} (role=${role}, scope=every_instructional_scene) is missing from ${offenders.length === 1 ? 'an instructional outline' : `${offenders.length} instructional outlines`} at flow position ${flowIndex} (stage "${entry.stage}")`,
            {
              offendingSceneIds: offenders.map((outline) => outline.id),
              flowIndex,
              stage: entry.stage,
              skillId: rule.skill.skillId,
              skillVersion: rule.skill.version,
              role,
              requiredScope: rule.scope,
            },
          );
        }
        continue;
      }

      // scope=flow_position — the only other closed-vocabulary scope; anything
      // else was already refused at the parse seam, so this is exhaustive.
      const anySatisfied = atPosition.some(satisfied);
      if (!anySatisfied) {
        throw new TeachingPackageError(
          'SKILL_REQUIREMENT_UNSATISFIED',
          `required Skill ${JSON.stringify(rule.skill.skillId)}@${JSON.stringify(rule.skill.version)} (role=${role}, scope=flow_position) is not selected anywhere at flow position ${flowIndex} (stage "${entry.stage}")`,
          {
            offendingSceneIds: atPosition.map((outline) => outline.id),
            flowIndex,
            stage: entry.stage,
            skillId: rule.skill.skillId,
            skillVersion: rule.skill.version,
            role,
            requiredScope: rule.scope,
          },
        );
      }
    }
  }
}
