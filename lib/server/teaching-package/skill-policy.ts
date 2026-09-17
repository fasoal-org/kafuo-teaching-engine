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
