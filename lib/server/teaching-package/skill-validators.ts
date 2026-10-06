/**
 * Deterministic Teaching Skills validators — §L submit-gate checks 4–9 only
 * (Module 2 W12 — teaching-skills plan §P Step 12 · §K/§L · FR-TS-053 ·
 * VAL-TS-003/004/005/006/008/009 · AC-TS-008/009).
 *
 * Every validator is an INDEPENDENTLY CALLABLE unit that returns a
 * scene-scoped failure object — never a boolean — carrying `offendingSceneIds`
 * plus the applicable FR-TS-053 context (sceneId · flowIndex · stage · skillId
 * · skillVersion · role · requiredScope). Returning (rather than throwing)
 * keeps the units composable: W17 owns the gate ordering and invocation, and
 * NOTHING in this module is wired into `prepareSubmitValidation` yet.
 *
 * | #  | Check                                                | Code                               |
 * | 4  | Policy present, coherent, correctly inherited        | SKILL_POLICY_REQUIRED / _INVALID   |
 * | 5  | Flow instructions × policy satisfiable               | TEACHING_MODEL_CONFIG_CONTRADICTORY|
 * | 6  | Skill exists; exact version resolves                 | SKILL_NOT_FOUND / _VERSION_UNRESOLVED |
 * | 7  | Required scope and role satisfied                    | SKILL_REQUIREMENT_UNSATISFIED      |
 * | 8  | Primary/Supporting structure; duplicates; restrictions | SKILL_ASSIGNMENT_INVALID         |
 * | 9  | Instructional classification structurally valid      | SCENE_CLASSIFICATION_INVALID       |
 *
 * Checks 2 (legacy/governed discriminator), 10 (alignment/confirmation) and 11
 * (lineage) and the ordering belong to the W17 gate assembly — absent here.
 *
 * Scope notes the plan states as boundaries:
 * - Duplicate checks key on the STABLE CANONICAL SKILL ID (FR-TS-017/018 are
 *   about identity and ignore version); resolution keys on the exact
 *   `(skillId, version)` pair (VAL-TS-002, FR-TS-068). Both keys are used,
 *   for different checks — see validateSkillAssignmentStructure.
 * - No universal pairwise compatibility engine (BR-TS-055, AC-TS-031): only
 *   explicit Teaching Model combination restrictions are enforced.
 * - Check 5 is bounded, deterministic configuration detection (FR-TS-074): a
 *   requirement set that cannot be satisfied at a position against the
 *   one-primary-per-scene invariant or an explicit restriction. It is a
 *   Teaching Model configuration fault — never an agent or reviewer fault —
 *   mirroring the OUTLINE_CONTENT_UNIT_GROUNDING_INVALID vs
 *   NORMALIZED_CONTENT_LINEAGE_MISMATCH split; a reviewer cannot override it.
 * - The W10 Stage-1 gate validator (`validateOutlineSkillSelections` in
 *   skill-policy.ts) intentionally coexists with these units: it enforces
 *   exactly the W10 prohibitions at generation time, while THIS module is the
 *   full §L set the submit gate will compose.
 */
import {
  resolveCanonicalSkillVersion,
  type CanonicalSkillResolutionIssue,
} from '@/lib/server/agent-runtime/canonical-skills';
import { skillsDir } from '@/lib/server/agent-runtime/skills';
import type { TeachingPackageErrorCode } from '@/lib/server/teaching-package/errors';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';
import type { OutlineSkillSelectionShape } from '@/lib/server/teaching-package/skill-policy';

/** The failure codes §L checks 4–9 can produce. */
export type SkillValidatorFailureCode = Extract<
  TeachingPackageErrorCode,
  | 'SKILL_POLICY_REQUIRED'
  | 'SKILL_POLICY_INVALID'
  | 'TEACHING_MODEL_CONFIG_CONTRADICTORY'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_VERSION_UNRESOLVED'
  | 'SKILL_REQUIREMENT_UNSATISFIED'
  | 'SKILL_ASSIGNMENT_INVALID'
  | 'SCENE_CLASSIFICATION_INVALID'
>;

/**
 * A scene-scoped deterministic validation failure (FR-TS-053):
 * `offendingSceneIds` names the affected Scenes; the remaining context fields
 * are carried where applicable. `details` deliberately mirrors the shape
 * `TeachingPackageError.details` already accommodates (`unknown`).
 */
export interface SkillValidatorFailure {
  code: SkillValidatorFailureCode;
  message: string;
  details: {
    offendingSceneIds: string[];
    sceneId?: string;
    flowIndex?: number;
    stage?: string;
    skillId?: string;
    skillVersion?: string;
    role?: string;
    requiredScope?: string;
    [key: string]: unknown;
  };
}

/** Convert a failure into the TeachingPackageError the routes already map. */
export function toTeachingPackageError(failure: SkillValidatorFailure): TeachingPackageError {
  return new TeachingPackageError(failure.code, failure.message, failure.details);
}

const pairKey = (ref: TeachingSkillRef) => `${ref.skillId}\u0000${ref.version}`;
const samePair = (a: TeachingSkillRef, b: TeachingSkillRef) =>
  a.skillId === b.skillId && a.version === b.version;

/** Every selection an outline's carrier names, tagged with its role. */
function selectionsOf(outline: OutlineSkillSelectionShape): Array<{
  role: 'primary' | 'supporting';
  ref: TeachingSkillRef;
}> {
  const skills = outline.teachingSkills;
  if (!skills) return [];
  const selections: Array<{ role: 'primary' | 'supporting'; ref: TeachingSkillRef }> = [];
  if (skills.primary) selections.push({ role: 'primary', ref: skills.primary });
  for (const ref of skills.supporting ?? []) selections.push({ role: 'supporting', ref });
  return selections;
}

// ---------------------------------------------------------------------------
// Check 4 — policy present, coherent, correctly inherited (VAL-TS-003)
// ---------------------------------------------------------------------------

/**
 * Every flow entry must carry the Skill Policy its definition item projected
 * (BR-TS-048/049), and that policy must be internally coherent (FRD §14.3):
 * required/preferred inside the allowed boundary, one exact version per skill
 * id per set, one required rule per skill id, restrictions naming two distinct
 * allowed members once each, at most one every-scene Primary.
 *
 * Inheritance itself is structural: Kafuo's `expand_teaching_model_flow`
 * projects the definition item's policy onto every resolved position and TE
 * never re-expands (plan §G) — so "correctly inherited" is validated as
 * presence + coherence of what was received, per resolved entry.
 */
export function validateFlowSkillPolicies(
  flow: readonly TeachingFlowEntry[],
): SkillValidatorFailure | null {
  for (let index = 0; index < flow.length; index += 1) {
    const entry = flow[index]!;
    if (!entry.skillPolicy) {
      return {
        code: 'SKILL_POLICY_REQUIRED',
        message: `teachingModel.flow[${index}] (stage "${entry.stage}") carries no Skill Policy; a governed package fails closed rather than using unrestricted Skill selection`,
        details: { offendingSceneIds: [], flowIndex: index, stage: entry.stage },
      };
    }
    const coherence = coherentPolicyFailure(entry.skillPolicy, index, entry.stage);
    if (coherence) return coherence;
  }
  return null;
}

/** The FRD §14.3 coherence rules as an independent, returning check. */
function coherentPolicyFailure(
  policy: NonNullable<TeachingFlowEntry['skillPolicy']>,
  index: number,
  stage: string,
): SkillValidatorFailure | null {
  const where = `teachingModel.flow[${index}] (stage "${stage}").skillPolicy`;
  const fail = (message: string): SkillValidatorFailure => ({
    code: 'SKILL_POLICY_INVALID',
    message: `${where}: ${message}`,
    details: { offendingSceneIds: [], flowIndex: index, stage },
  });

  const allowedPairs = new Set(policy.allowed.map(pairKey));
  const uniqueIds = (refs: TeachingSkillRef[], set: string) => {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.skillId)) {
        return `${set} names skill id "${ref.skillId}" more than once (one exact version per skill)`;
      }
      seen.add(ref.skillId);
    }
    return null;
  };
  if (uniqueIds(policy.allowed, 'allowed')) return fail(uniqueIds(policy.allowed, 'allowed')!);
  if (uniqueIds(policy.preferred, 'preferred')) {
    return fail(uniqueIds(policy.preferred, 'preferred')!);
  }
  const requiredIds = new Set<string>();
  for (const rule of policy.required) {
    if (requiredIds.has(rule.skill.skillId)) {
      return fail(`required carries more than one rule for skill id "${rule.skill.skillId}"`);
    }
    requiredIds.add(rule.skill.skillId);
  }
  for (const ref of [...policy.required.map((rule) => rule.skill), ...policy.preferred]) {
    if (!allowedPairs.has(pairKey(ref))) {
      return fail(
        `${ref.skillId}@${ref.version} is required/preferred but not in the allowed boundary (FRD §14.3)`,
      );
    }
  }
  const seenRestrictions = new Set<string>();
  for (const { skillA, skillB } of policy.combinationRestrictions) {
    for (const endpoint of [skillA, skillB]) {
      if (!allowedPairs.has(pairKey(endpoint))) {
        return fail(
          `combination restriction names ${endpoint.skillId}@${endpoint.version}, which is not in the allowed boundary`,
        );
      }
    }
    if (samePair(skillA, skillB)) {
      return fail('combination restriction must name two distinct skills');
    }
    const key = [pairKey(skillA), pairKey(skillB)].sort().join('|');
    if (seenRestrictions.has(key)) {
      return fail('the same combination restriction is declared twice');
    }
    seenRestrictions.add(key);
  }
  const everyScenePrimaries = policy.required.filter(
    (rule) => rule.scope === 'every_instructional_scene' && rule.role === 'primary',
  );
  if (everyScenePrimaries.length > 1) {
    return fail(
      `required names ${everyScenePrimaries.length} skills as the Primary of every instructional Scene — at most one is ever satisfiable (BR-TS-021)`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 5 — flow instructions × policy satisfiable (FR-TS-074)
// ---------------------------------------------------------------------------

/**
 * Bounded, deterministic satisfiability of one position's requirement set —
 * NEVER a prose-level "flow instructions × Skill HOW" comparison (plan §K
 * correction #6; no universal semantic engine, BR-TS-055). Detectable
 * contradictions:
 *
 * 1. two `every_instructional_scene` Primary rules — every instructional
 *    Scene would need two primaries (BR-TS-021 allows exactly one);
 * 2. an explicit restriction (X × Y) where X is required on EVERY
 *    instructional Scene and Y is required at the position in ANY scope or
 *    role — Y can only ever sit on an instructional Scene (a genuinely
 *    non-instructional Scene carries no Skills at all), and every
 *    instructional Scene already carries X, so some Scene would always hold
 *    the prohibited pair.
 *
 * This is a Teaching Model configuration fault (`422`): the Generation Agent
 * must not improvise around it and a reviewer cannot resolve it — it needs a
 * new Teaching Model version (BR-TS-051).
 */
export function validateFlowPolicySatisfiability(
  flow: readonly TeachingFlowEntry[],
): SkillValidatorFailure | null {
  for (let index = 0; index < flow.length; index += 1) {
    const entry = flow[index]!;
    const policy = entry.skillPolicy;
    if (!policy) continue; // Check 4 owns presence.

    const fail = (message: string, extra: Record<string, unknown> = {}): SkillValidatorFailure => ({
      code: 'TEACHING_MODEL_CONFIG_CONTRADICTORY',
      message: `teachingModel.flow[${index}] (stage "${entry.stage}"): ${message} — the Teaching Model configuration is invalid rather than the generation or review result (FR-TS-074)`,
      details: { offendingSceneIds: [], flowIndex: index, stage: entry.stage, ...extra },
    });

    const everyScenePrimaries = policy.required.filter(
      (rule) => rule.scope === 'every_instructional_scene' && rule.role === 'primary',
    );
    if (everyScenePrimaries.length > 1) {
      return fail(
        `required names ${everyScenePrimaries.length} every-instructional-Scene Primary rules (${everyScenePrimaries
          .map((rule) => `${rule.skill.skillId}@${rule.skill.version}`)
          .join(', ')}), which no Scene can satisfy together`,
        {
          skillId: everyScenePrimaries[0]!.skill.skillId,
          skillVersion: everyScenePrimaries[0]!.skill.version,
        },
      );
    }

    const everySceneSkills = policy.required
      .filter((rule) => rule.scope === 'every_instructional_scene')
      .map((rule) => rule.skill);
    for (const { skillA, skillB } of policy.combinationRestrictions) {
      for (const [x, y] of [
        [skillA, skillB],
        [skillB, skillA],
      ] as const) {
        const xEveryScene = everySceneSkills.some((ref) => samePair(ref, x));
        const yRequired = policy.required.some((rule) => samePair(rule.skill, y));
        if (xEveryScene && yRequired) {
          return fail(
            `${x.skillId}@${x.version} is required on every instructional Scene while ${y.skillId}@${y.version} is also required, but the two are explicitly prohibited together`,
            { skillId: y.skillId, skillVersion: y.version },
          );
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 6 — Skill exists; exact version resolves (VAL-TS-001/002)
// ---------------------------------------------------------------------------

/**
 * Every exact `(skillId, version)` reference resolves against the W1 canonical
 * registry — policy references across all entries, and, when outlines are
 * supplied, Scene assignment references too (VAL-TS-002 spans both). Exact
 * versions only: a newer version is never silently substituted (FR-TS-036).
 */
export function validateSkillReferencesResolve(
  flow: readonly TeachingFlowEntry[],
  outlines?: readonly OutlineSkillSelectionShape[],
  dir: string = skillsDir,
): SkillValidatorFailure | null {
  const resolve = (
    ref: TeachingSkillRef,
    scope: { flowIndex: number; stage: string; sceneId?: string },
  ): SkillValidatorFailure | null => {
    let issue: CanonicalSkillResolutionIssue;
    try {
      resolveCanonicalSkillVersion(ref.skillId, ref.version, dir);
      return null;
    } catch (error) {
      issue = (error as TeachingPackageError).details as CanonicalSkillResolutionIssue;
    }
    const code: SkillValidatorFailureCode =
      issue.reason === 'skill_unknown' ? 'SKILL_NOT_FOUND' : 'SKILL_VERSION_UNRESOLVED';
    return {
      code,
      message: `skill reference ${ref.skillId}@${ref.version} does not resolve (${issue.reason}) — never substituted with a newer version`,
      details: {
        offendingSceneIds: scope.sceneId ? [scope.sceneId] : [],
        sceneId: scope.sceneId,
        flowIndex: scope.flowIndex,
        stage: scope.stage,
        skillId: ref.skillId,
        skillVersion: ref.version,
        reason: issue.reason,
      },
    };
  };

  for (let index = 0; index < flow.length; index += 1) {
    const entry = flow[index]!;
    const policy = entry.skillPolicy;
    if (!policy) continue; // Check 4 owns presence.
    const refs = [
      ...policy.required.map((rule) => rule.skill),
      ...policy.preferred,
      ...policy.allowed,
      ...policy.combinationRestrictions.flatMap((restriction) => [
        restriction.skillA,
        restriction.skillB,
      ]),
    ];
    for (const ref of refs) {
      const failure = resolve(ref, { flowIndex: index, stage: entry.stage });
      if (failure) return failure;
    }
  }

  if (outlines) {
    for (const outline of outlines) {
      const stageRef = outline.teachingStage;
      for (const { ref } of selectionsOf(outline)) {
        const failure = resolve(ref, {
          flowIndex: stageRef?.flowIndex ?? -1,
          stage: stageRef ? (flow[stageRef.flowIndex]?.stage ?? '') : '',
          sceneId: outline.id,
        });
        if (failure) return failure;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 7 — required scope and role satisfied (VAL-TS-005)
// ---------------------------------------------------------------------------

/**
 * Every required rule is satisfied exactly as authored — no default scope is
 * ever inferred (BR-TS-010): `flow_position` means somewhere in the position
 * in the named role; `every_instructional_scene` means on every instructional
 * outline there. An outline NOT explicitly classified non-instructional counts
 * as instructional, so omitting the classification can never dodge a
 * requirement (BR-TS-054).
 */
export function validateRequiredSkillSatisfaction(
  outlines: readonly OutlineSkillSelectionShape[],
  flow: readonly TeachingFlowEntry[],
): SkillValidatorFailure | null {
  for (let flowIndex = 0; flowIndex < flow.length; flowIndex += 1) {
    const entry = flow[flowIndex]!;
    const policy = entry.skillPolicy;
    if (!policy || policy.required.length === 0) continue;

    const atPosition = outlines.filter((outline) => outline.teachingStage?.flowIndex === flowIndex);
    const instructional = atPosition.filter(
      (outline) => outline.teachingSkills?.classification !== 'non-instructional',
    );

    for (const rule of policy.required) {
      const satisfied = (outline: OutlineSkillSelectionShape): boolean => {
        const skills = outline.teachingSkills;
        if (!skills) return false;
        if (rule.role === 'primary') {
          return !!skills.primary && samePair(skills.primary, rule.skill);
        }
        return (skills.supporting ?? []).some((ref) => samePair(ref, rule.skill));
      };

      const context = {
        flowIndex,
        stage: entry.stage,
        skillId: rule.skill.skillId,
        skillVersion: rule.skill.version,
        role: rule.role,
        requiredScope: rule.scope,
      };

      if (rule.scope === 'every_instructional_scene') {
        const offenders = instructional.filter((outline) => !satisfied(outline));
        if (offenders.length > 0) {
          return {
            code: 'SKILL_REQUIREMENT_UNSATISFIED',
            message: `required Skill ${rule.skill.skillId}@${rule.skill.version} (role=${rule.role}, scope=every_instructional_scene) is missing from ${offenders.length === 1 ? 'an instructional outline' : `${offenders.length} instructional outlines`} at flow position ${flowIndex} (stage "${entry.stage}")`,
            details: {
              offendingSceneIds: offenders.map((outline) => outline.id),
              ...context,
            },
          };
        }
        continue;
      }

      if (!atPosition.some(satisfied)) {
        return {
          code: 'SKILL_REQUIREMENT_UNSATISFIED',
          message: `required Skill ${rule.skill.skillId}@${rule.skill.version} (role=${rule.role}, scope=flow_position) is not selected anywhere at flow position ${flowIndex} (stage "${entry.stage}")`,
          details: {
            offendingSceneIds: atPosition.map((outline) => outline.id),
            ...context,
          },
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 8 — Primary/Supporting structure; duplicates; explicit restrictions
// ---------------------------------------------------------------------------

/**
 * Structural assignment validity per Scene (VAL-TS-004/006/008/009):
 *
 * - every selection is attributable to a flow position and inside that
 *   position's permitted (allowed) set — the unrestricted catalog is never a
 *   fallback (BR-TS-048);
 * - every explicitly instructional outline carries exactly one primary
 *   (VAL-TS-006) and every explicitly non-instructional outline carries NO
 *   selection at all (no fake mandatory Skill, BR-TS-025/§20.6);
 * - duplicates key on the STABLE CANONICAL SKILL ID and ignore version
 *   (FR-TS-017/018): `Primary feynman-learning v1` + `Supporting
 *   feynman-learning v2` is the SAME Skill twice and is rejected here even
 *   though every `(skillId, version)` pair differs — the §K trap. Resolution
 *   (check 6) is the check that keys on the pair;
 * - explicit Teaching Model combination restrictions are honored (VAL-TS-009).
 *   No universal pairwise compatibility engine is attempted (BR-TS-055).
 */
export function validateSkillAssignmentStructure(
  outlines: readonly OutlineSkillSelectionShape[],
  flow: readonly TeachingFlowEntry[],
): SkillValidatorFailure | null {
  for (const outline of outlines) {
    const skills = outline.teachingSkills;
    const selections = selectionsOf(outline);

    if (skills?.classification === 'non-instructional' && selections.length > 0) {
      return {
        code: 'SKILL_ASSIGNMENT_INVALID',
        message: `outline ${JSON.stringify(outline.id)} is classified non-instructional yet carries a Skill assignment — a genuinely non-instructional Scene never receives a fake mandatory Skill`,
        details: {
          offendingSceneIds: [outline.id],
          sceneId: outline.id,
          skillId: selections[0]!.ref.skillId,
          skillVersion: selections[0]!.ref.version,
          role: selections[0]!.role,
        },
      };
    }

    if (skills?.classification === 'instructional' && !skills.primary) {
      return {
        code: 'SKILL_ASSIGNMENT_INVALID',
        message: `outline ${JSON.stringify(outline.id)} is classified instructional but carries no Primary Skill (VAL-TS-006) — a primary is never inferred from title, type, or actions`,
        details: { offendingSceneIds: [outline.id], sceneId: outline.id },
      };
    }

    if (selections.length === 0) continue;

    const stageRef = outline.teachingStage;
    if (!stageRef || stageRef.flowIndex < 0 || stageRef.flowIndex >= flow.length) {
      return {
        code: 'SKILL_ASSIGNMENT_INVALID',
        message: `outline ${JSON.stringify(outline.id)} carries a Skill selection but no usable teachingStage flow position to attribute it to`,
        details: { offendingSceneIds: [outline.id], sceneId: outline.id },
      };
    }
    const entry = flow[stageRef.flowIndex]!;
    const policy = entry.skillPolicy;
    const positionContext = {
      sceneId: outline.id,
      flowIndex: stageRef.flowIndex,
      stage: entry.stage,
    };

    // Permission boundary — the unrestricted catalog is never a fallback.
    if (policy) {
      for (const { role, ref } of selections) {
        if (!policy.allowed.some((allowedRef) => samePair(allowedRef, ref))) {
          return {
            code: 'SKILL_ASSIGNMENT_INVALID',
            message: `outline ${JSON.stringify(outline.id)} selects ${ref.skillId}@${ref.version} as ${role} at flow position ${stageRef.flowIndex} (stage "${entry.stage}"), which is outside that position's permitted Skills — the unrestricted catalog is never a fallback`,
            details: {
              offendingSceneIds: [outline.id],
              ...positionContext,
              skillId: ref.skillId,
              skillVersion: ref.version,
              role,
            },
          };
        }
      }

      // Explicit combination restrictions — pair-keyed, unordered.
      for (const { skillA, skillB } of policy.combinationRestrictions) {
        const holdsA = selections.some(({ ref }) => samePair(ref, skillA));
        const holdsB = selections.some(({ ref }) => samePair(ref, skillB));
        if (holdsA && holdsB) {
          return {
            code: 'SKILL_ASSIGNMENT_INVALID',
            message: `outline ${JSON.stringify(outline.id)} selects both ${skillA.skillId}@${skillA.version} and ${skillB.skillId}@${skillB.version}, an explicitly prohibited combination`,
            details: {
              offendingSceneIds: [outline.id],
              ...positionContext,
              skillId: skillB.skillId,
              skillVersion: skillB.version,
              prohibitedWith: `${skillA.skillId}@${skillA.version}`,
            },
          };
        }
      }
    }

    // Duplicates — canonical Skill ID, version deliberately ignored (§K).
    const seenIds = new Map<string, { role: string; version: string }>();
    for (const { role, ref } of selections) {
      const first = seenIds.get(ref.skillId);
      if (first) {
        return {
          code: 'SKILL_ASSIGNMENT_INVALID',
          message: `outline ${JSON.stringify(outline.id)} assigns skill id "${ref.skillId}" more than once (${first.role} ${ref.skillId}@${first.version} and ${role} ${ref.skillId}@${ref.version}) — duplicate checks key on the canonical Skill ID and ignore version (FR-TS-017/018)`,
          details: {
            offendingSceneIds: [outline.id],
            ...positionContext,
            skillId: ref.skillId,
            skillVersion: ref.version,
            role,
          },
        };
      }
      seenIds.set(ref.skillId, { role, version: ref.version });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 9 — instructional classification structurally valid (VAL-TS-007)
// ---------------------------------------------------------------------------

/**
 * Structural classification validity: on a governed package every Scene
 * carries an explicit classification, and its value is one of the two
 * closed-vocabulary outcomes. Whether a `non-instructional` label reflects the
 * Scene's actual purpose is a semantic question — W14/W15 alignment territory
 * with reviewer resolution — and is deliberately NOT decided here; what is
 * structural is that the classification EXISTS (it is never derived from Skill
 * absence or Scene type, BR-TS-054/FR-TS-023, because the Generation Agent had
 * to emit it at outline time).
 */
export function validateSceneClassifications(
  outlines: readonly OutlineSkillSelectionShape[],
): SkillValidatorFailure | null {
  for (const outline of outlines) {
    const classification = outline.teachingSkills?.classification;
    if (classification === undefined) {
      return {
        code: 'SCENE_CLASSIFICATION_INVALID',
        message: `outline ${JSON.stringify(outline.id)} carries no instructional/non-instructional classification — on a governed package the classification is explicit and is never derived from Skill absence or Scene type`,
        details: { offendingSceneIds: [outline.id], sceneId: outline.id },
      };
    }
    if (classification !== 'instructional' && classification !== 'non-instructional') {
      return {
        code: 'SCENE_CLASSIFICATION_INVALID',
        message: `outline ${JSON.stringify(outline.id)} carries classification ${JSON.stringify(classification)}, which is not one of "instructional" | "non-instructional"`,
        details: {
          offendingSceneIds: [outline.id],
          sceneId: outline.id,
          classification,
        },
      };
    }
  }
  return null;
}
