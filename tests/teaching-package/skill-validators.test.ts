/**
 * The deterministic Teaching Skills validators — §L submit-gate checks 4–9
 * ONLY (Module 2 W12 — teaching-skills plan §P Step 12 · §K/§L · FR-TS-053 ·
 * VAL-TS-003/004/005/006/008/009 · AC-TS-008/009).
 *
 * Every validator is independently callable and independently testable, and
 * every blocked result is a scene-scoped FAILURE carrying `offendingSceneIds`
 * plus applicable context — never a boolean. Checks 2, 10, 11 and the gate
 * ordering belong to W17: nothing here is wired into prepareSubmitValidation.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { skillSourceHash } from '@/lib/server/agent-runtime/skills';
import type { OutlineSkillSelectionShape } from '@/lib/server/teaching-package/skill-policy';
import {
  toTeachingPackageError,
  validateFlowPolicySatisfiability,
  validateFlowSkillPolicies,
  validateRequiredSkillSatisfaction,
  validateSceneClassifications,
  validateSkillAssignmentStructure,
  validateSkillReferencesResolve,
} from '@/lib/server/teaching-package/skill-validators';
import type {
  TeachingFlowEntry,
  TeachingSkillPolicy,
  TeachingSkillRef,
} from '@/lib/types/teaching-package';

const ref = (skillId: string, version = 'v1'): TeachingSkillRef => ({ skillId, version });
const FEYNMAN = ref('feynman-learning');
const L2L = ref('learning-to-learn');

const policy = (overrides: Partial<TeachingSkillPolicy> = {}): TeachingSkillPolicy => ({
  required: [],
  preferred: [FEYNMAN],
  allowed: [FEYNMAN, L2L],
  combinationRestrictions: [],
  ...overrides,
});

const flowEntry = (stage: string, skillPolicy?: TeachingSkillPolicy): TeachingFlowEntry => ({
  stage,
  instructions: `Instructions for ${stage}.`,
  ...(skillPolicy ? { skillPolicy } : {}),
});

const FLOW: TeachingFlowEntry[] = [
  flowEntry('lesson_introduction', policy()),
  flowEntry('outcome_teaching_cards', policy()),
];

const outline = (
  id: string,
  flowIndex: number,
  stage: string,
  teachingSkills?: OutlineSkillSelectionShape['teachingSkills'],
): OutlineSkillSelectionShape =>
  ({
    id,
    title: id,
    description: '',
    keyPoints: [],
    order: flowIndex + 1,
    teachingStage: { key: stage, flowIndex },
    ...(teachingSkills ? { teachingSkills } : {}),
  }) as OutlineSkillSelectionShape;

/** A temp registry with TWO declared versions of one skill (the §K trap data). */
function twoVersionRegistry(): string {
  const root = mkdtempSync(join(tmpdir(), 'openmaic-skill-validators-'));
  for (const version of ['v1', 'v2']) {
    const text = `---\nname: two-version\ndescription: d\n---\n\nbody ${version}\n`;
    mkdirSync(join(root, 'two-version', 'versions', version), { recursive: true });
    writeFileSync(join(root, 'two-version', 'versions', version, 'SKILL.md'), text);
    if (version === 'v1') writeFileSync(join(root, 'two-version', 'SKILL.md'), text);
  }
  writeFileSync(
    join(root, 'two-version', 'skill-versions.json'),
    `${JSON.stringify({
      recordVersion: 1,
      currentVersion: 'v2',
      versions: {
        v1: { digest: skillSourceHash('---\nname: two-version\ndescription: d\n---\n\nbody v1\n') },
        v2: { digest: skillSourceHash('---\nname: two-version\ndescription: d\n---\n\nbody v2\n') },
      },
    })}\n`,
  );
  return root;
}

describe('check 4 — validateFlowSkillPolicies (present, coherent, inherited)', () => {
  it('passes a fully policy-carrying coherent flow', () => {
    expect(validateFlowSkillPolicies(FLOW)).toBeNull();
  });

  it('fails a missing policy with SKILL_POLICY_REQUIRED and position context', () => {
    const failure = validateFlowSkillPolicies([
      flowEntry('lesson_introduction', policy()),
      flowEntry('outcome_teaching_cards'),
    ])!;
    expect(failure).not.toBeNull();
    expect(failure.code).toBe('SKILL_POLICY_REQUIRED');
    expect(failure.details).toMatchObject({ flowIndex: 1, stage: 'outcome_teaching_cards' });
    expect(failure.details.offendingSceneIds).toEqual([]);
  });

  it('re-verifies each FRD §14.3 coherence rule independently of the parse seam', () => {
    const cases: Array<[label: string, TeachingSkillPolicy]> = [
      [
        'required outside the allowed boundary',
        policy({
          required: [{ skill: ref('lecture-style'), scope: 'flow_position', role: 'primary' }],
        }),
      ],
      [
        'two versions of one id in allowed',
        policy({ allowed: [ref('feynman-learning', 'v1'), ref('feynman-learning', 'v2')] }),
      ],
      [
        'two required rules for one id',
        policy({
          required: [
            { skill: FEYNMAN, scope: 'flow_position', role: 'primary' },
            { skill: ref('feynman-learning', 'v2'), scope: 'flow_position', role: 'supporting' },
          ],
        }),
      ],
      [
        'restriction endpoint outside allowed',
        policy({ combinationRestrictions: [{ skillA: FEYNMAN, skillB: ref('lecture-style') }] }),
      ],
      [
        'restriction naming one skill twice',
        policy({
          allowed: [FEYNMAN],
          combinationRestrictions: [{ skillA: FEYNMAN, skillB: FEYNMAN }],
        }),
      ],
      [
        'duplicate restriction',
        policy({
          combinationRestrictions: [
            { skillA: FEYNMAN, skillB: L2L },
            { skillA: L2L, skillB: FEYNMAN },
          ],
        }),
      ],
      [
        'two every-scene primaries',
        policy({
          required: [
            { skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' },
            { skill: L2L, scope: 'every_instructional_scene', role: 'primary' },
          ],
        }),
      ],
    ];
    for (const [label, bad] of cases) {
      const failure = validateFlowSkillPolicies([flowEntry('lesson_introduction', bad)])!;
      expect(failure, label).not.toBeNull();
      expect(failure.code, label).toBe('SKILL_POLICY_INVALID');
    }
  });
});

describe('check 5 — validateFlowPolicySatisfiability (FR-TS-074, bounded)', () => {
  it('passes requirements that are jointly satisfiable, including restrictions on unrequired members', () => {
    expect(
      validateFlowPolicySatisfiability([
        flowEntry(
          'lesson_introduction',
          policy({
            combinationRestrictions: [{ skillA: FEYNMAN, skillB: L2L }],
          }),
        ),
      ]),
    ).toBeNull();
  });

  it('fails two every-instructional-Scene Primary rules with TEACHING_MODEL_CONFIG_CONTRADICTORY', () => {
    const failure = validateFlowPolicySatisfiability([
      flowEntry(
        'outcome_teaching_cards',
        policy({
          required: [
            { skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' },
            { skill: L2L, scope: 'every_instructional_scene', role: 'primary' },
          ],
        }),
      ),
    ])!;
    expect(failure.code).toBe('TEACHING_MODEL_CONFIG_CONTRADICTORY');
    expect(failure.message).toMatch(/Teaching Model configuration is invalid/);
    expect(failure.details).toMatchObject({ flowIndex: 0, stage: 'outcome_teaching_cards' });
  });

  it('fails a restriction crossing an every-Scene requirement — the required member can never coexist', () => {
    // X required on every instructional Scene; Y required anywhere at the
    // position. Y can only sit on an instructional Scene (non-instructional
    // Scenes carry no Skills), which already carries X — the prohibited pair
    // is unavoidable. Both directions are detected.
    const contradictory = (xFirst: boolean) =>
      flowEntry(
        'outcome_teaching_cards',
        policy({
          required: [
            { skill: xFirst ? FEYNMAN : L2L, scope: 'every_instructional_scene', role: 'primary' },
            { skill: xFirst ? L2L : FEYNMAN, scope: 'flow_position', role: 'supporting' },
          ],
          combinationRestrictions: [{ skillA: FEYNMAN, skillB: L2L }],
        }),
      );
    for (const entry of [contradictory(true), contradictory(false)]) {
      const failure = validateFlowPolicySatisfiability([entry])!;
      expect(failure.code).toBe('TEACHING_MODEL_CONFIG_CONTRADICTORY');
      expect(failure.message).toMatch(/explicitly prohibited together/);
    }
  });

  it('is a configuration fault: 422 via toTeachingPackageError, reviewer-overridable nowhere', () => {
    const failure = validateFlowPolicySatisfiability([
      flowEntry(
        'outcome_teaching_cards',
        policy({
          required: [
            { skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' },
            { skill: L2L, scope: 'every_instructional_scene', role: 'primary' },
          ],
        }),
      ),
    ])!;
    const error = toTeachingPackageError(failure);
    expect(error.code).toBe('TEACHING_MODEL_CONFIG_CONTRADICTORY');
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ offendingSceneIds: [] });
  });
});

describe('check 6 — validateSkillReferencesResolve (exact versions only)', () => {
  it('passes a fully resolvable flow against the live registry', () => {
    expect(validateSkillReferencesResolve(FLOW)).toBeNull();
  });

  it('fails an invented identity with SKILL_NOT_FOUND and an unresolvable version with SKILL_VERSION_UNRESOLVED', () => {
    const invented = validateSkillReferencesResolve([
      flowEntry(
        'lesson_introduction',
        policy({
          preferred: [ref('no-such-skill')],
          allowed: [ref('no-such-skill'), FEYNMAN],
        }),
      ),
    ])!;
    expect(invented.code).toBe('SKILL_NOT_FOUND');
    expect(invented.details).toMatchObject({
      skillId: 'no-such-skill',
      flowIndex: 0,
      stage: 'lesson_introduction',
    });

    const unresolvable = validateSkillReferencesResolve([
      flowEntry(
        'lesson_introduction',
        policy({
          preferred: [ref('feynman-learning', 'v99')],
          allowed: [ref('feynman-learning', 'v99'), FEYNMAN],
        }),
      ),
    ])!;
    expect(unresolvable.code).toBe('SKILL_VERSION_UNRESOLVED');
    expect(unresolvable.details).toMatchObject({
      skillVersion: 'v99',
      reason: 'version_not_declared',
    });
  });

  it('resolution keys on the (skillId, version) PAIR: both versions of one skill resolve', () => {
    // The same registry the §K duplicate trap uses — at RESOLUTION level the
    // two versions are simply two distinct resolvable references.
    const root = twoVersionRegistry();
    try {
      const flow = [
        flowEntry(
          'lesson_introduction',
          policy({
            preferred: [ref('two-version', 'v1')],
            allowed: [ref('two-version', 'v1'), ref('two-version', 'v2')],
          }),
        ),
      ];
      expect(validateSkillReferencesResolve(flow, undefined, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('also resolves Scene ASSIGNMENT references when outlines are supplied (VAL-TS-002 spans both)', () => {
    const failure = validateSkillReferencesResolve(FLOW, [
      outline('o1', 0, 'lesson_introduction', {
        classification: 'instructional',
        primary: ref('feynman-learning', 'v42'),
      }),
    ])!;
    expect(failure.code).toBe('SKILL_VERSION_UNRESOLVED');
    expect(failure.details).toMatchObject({
      offendingSceneIds: ['o1'],
      sceneId: 'o1',
      skillId: 'feynman-learning',
      skillVersion: 'v42',
    });
  });
});

describe('check 7 — validateRequiredSkillSatisfaction (scope and role, no default)', () => {
  it('returns a scene-scoped failure for an unsatisfied flow_position primary rule', () => {
    const flow = [
      flowEntry(
        'outcome_teaching_cards',
        policy({
          required: [{ skill: FEYNMAN, scope: 'flow_position', role: 'primary' }],
        }),
      ),
    ];
    const failure = validateRequiredSkillSatisfaction(
      [
        outline('o1', 0, 'outcome_teaching_cards', {
          classification: 'instructional',
          primary: L2L,
        }),
      ],
      flow,
    )!;
    expect(failure.code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
    expect(failure.details).toMatchObject({
      offendingSceneIds: ['o1'],
      flowIndex: 0,
      stage: 'outcome_teaching_cards',
      skillId: 'feynman-learning',
      skillVersion: 'v1',
      role: 'primary',
      requiredScope: 'flow_position',
    });
  });

  it('lists every offending instructional outline for an every_instructional_scene rule', () => {
    const flow = [
      flowEntry(
        'outcome_teaching_cards',
        policy({
          required: [{ skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' }],
        }),
      ),
    ];
    const failure = validateRequiredSkillSatisfaction(
      [
        outline('o1', 0, 'outcome_teaching_cards', {
          classification: 'instructional',
          primary: FEYNMAN,
        }),
        outline('o2', 0, 'outcome_teaching_cards', {
          classification: 'instructional',
          primary: L2L,
        }),
        outline('o3', 0, 'outcome_teaching_cards', { classification: 'non-instructional' }),
        outline('o4', 0, 'outcome_teaching_cards'), // unclassified still counts as instructional
      ],
      flow,
    )!;
    expect(failure.code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
    expect(failure.details.offendingSceneIds).toEqual(['o2', 'o4']);
    expect(failure.details.requiredScope).toBe('every_instructional_scene');
  });

  it('passes when the rule is satisfied exactly as scoped and roled', () => {
    const flow = [
      flowEntry(
        'outcome_teaching_cards',
        policy({
          required: [
            { skill: FEYNMAN, scope: 'flow_position', role: 'supporting' },
            { skill: L2L, scope: 'every_instructional_scene', role: 'primary' },
          ],
        }),
      ),
    ];
    expect(
      validateRequiredSkillSatisfaction(
        [
          outline('o1', 0, 'outcome_teaching_cards', {
            classification: 'instructional',
            primary: L2L,
            supporting: [FEYNMAN],
          }),
        ],
        flow,
      ),
    ).toBeNull();
  });
});

describe('check 8 — validateSkillAssignmentStructure (the §K trap lives here)', () => {
  it('rejects Primary feynman v1 + Supporting feynman v2 as the SAME skill twice — canonical ID, not the pair', () => {
    // A tuple comparison admits this assignment because both (skillId,
    // version) pairs differ. Check 8 keys duplicates on the canonical Skill ID
    // and ignores version (FR-TS-017/018), while resolution (check 6) is the
    // pair-keyed check — proven distinct above. The policy here intentionally
    // allows both versions so the duplicate rule fires on its own, exactly as
    // the plan's trap demands; a coherent policy would have been refused by
    // check 4 first, which is why check 8 must be robust independently.
    const flow = [
      flowEntry('lesson_introduction', {
        required: [],
        preferred: [],
        allowed: [ref('feynman-learning', 'v1'), ref('feynman-learning', 'v2')],
        combinationRestrictions: [],
      }),
    ];
    const failure = validateSkillAssignmentStructure(
      [
        outline('o1', 0, 'lesson_introduction', {
          classification: 'instructional',
          primary: ref('feynman-learning', 'v1'),
          supporting: [ref('feynman-learning', 'v2')],
        }),
      ],
      flow,
    )!;
    expect(failure.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(failure.message).toMatch(/canonical Skill ID and ignore version/);
    expect(failure.details).toMatchObject({
      offendingSceneIds: ['o1'],
      sceneId: 'o1',
      skillId: 'feynman-learning',
      skillVersion: 'v2',
      role: 'supporting',
    });
  });

  it('rejects an identical-pair duplicate inside supporting as well', () => {
    const failure = validateSkillAssignmentStructure(
      [
        outline('o1', 0, 'lesson_introduction', {
          classification: 'instructional',
          primary: FEYNMAN,
          supporting: [L2L, L2L],
        }),
      ],
      FLOW,
    )!;
    expect(failure.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(failure.message).toMatch(/more than once/);
  });

  it('rejects an instructional outline with no Primary (VAL-TS-006) and a non-instructional outline with a selection', () => {
    const noPrimary = validateSkillAssignmentStructure(
      [outline('o1', 0, 'lesson_introduction', { classification: 'instructional' })],
      FLOW,
    )!;
    expect(noPrimary.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(noPrimary.details).toMatchObject({ offendingSceneIds: ['o1'] });

    const fake = validateSkillAssignmentStructure(
      [
        outline('o2', 0, 'lesson_introduction', {
          classification: 'non-instructional',
          primary: FEYNMAN,
        }),
      ],
      FLOW,
    )!;
    expect(fake.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(fake.message).toMatch(/fake mandatory Skill/);
  });

  it('rejects out-of-policy selections and explicit prohibited combinations — never a pairwise engine', () => {
    const outOfPolicy = validateSkillAssignmentStructure(
      [
        outline('o1', 0, 'lesson_introduction', {
          classification: 'instructional',
          primary: ref('lecture-style'),
        }),
      ],
      FLOW,
    )!;
    expect(outOfPolicy.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(outOfPolicy.message).toMatch(/unrestricted catalog is never a fallback/);

    const restricted = flowEntry(
      'lesson_introduction',
      policy({
        combinationRestrictions: [{ skillA: FEYNMAN, skillB: L2L }],
      }),
    );
    const combination = validateSkillAssignmentStructure(
      [
        outline('o2', 0, 'lesson_introduction', {
          classification: 'instructional',
          primary: FEYNMAN,
          supporting: [L2L],
        }),
      ],
      [restricted],
    )!;
    expect(combination.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(combination.message).toMatch(/explicitly prohibited combination/);
    // Only explicit Teaching Model restrictions are enforced (BR-TS-055) — an
    // unrestricted pair of permitted Skills is structurally fine.
    expect(
      validateSkillAssignmentStructure(
        [
          outline('o3', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: FEYNMAN,
            supporting: [L2L],
          }),
        ],
        FLOW,
      ),
    ).toBeNull();
  });
});

describe('check 9 — validateSceneClassifications (structurally valid)', () => {
  it('fails an absent classification and an out-of-vocabulary value', () => {
    const absent = validateSceneClassifications([outline('o1', 0, 'lesson_introduction')])!;
    expect(absent.code).toBe('SCENE_CLASSIFICATION_INVALID');
    expect(absent.message).toMatch(/never derived from Skill absence or Scene type/);
    expect(absent.details).toMatchObject({ offendingSceneIds: ['o1'] });

    const invalid = validateSceneClassifications([
      outline('o2', 0, 'lesson_introduction', {
        classification: 'whatever',
      } as OutlineSkillSelectionShape['teachingSkills']),
    ])!;
    expect(invalid.code).toBe('SCENE_CLASSIFICATION_INVALID');
  });

  it('accepts both explicit outcomes — purpose is semantic (W14/W15), presence is structural', () => {
    expect(
      validateSceneClassifications([
        outline('o1', 0, 'lesson_introduction', {
          classification: 'instructional',
          primary: FEYNMAN,
        }),
        outline('o2', 1, 'outcome_teaching_cards', { classification: 'non-instructional' }),
      ]),
    ).toBeNull();
  });
});

describe('submit gate wiring (W17 — the W12 "unwired" pin superseded by design)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  it('the gate INVOKES the validators, composed behind the discriminator, with exact-flow precedence intact', () => {
    const lifecycle = readFileSync(
      join(repoRoot, 'lib/server/teaching-package/lifecycle.ts'),
      'utf-8',
    );
    // Composed, not reimplemented: every W12 validator is invoked by name.
    for (const validator of [
      'validateFlowSkillPolicies',
      'validateFlowPolicySatisfiability',
      'validateSkillReferencesResolve',
      'validateRequiredSkillSatisfaction',
      'validateSkillAssignmentStructure',
      'validateSceneClassifications',
    ]) {
      expect(lifecycle, validator).toContain(validator);
    }
    // The existing exact-flow gate stays the precedence reference, and the
    // governed Skill gate runs only behind the W6 discriminator.
    expect(lifecycle).toContain('validateExactTeachingFlow');
    expect(lifecycle).toContain('if (governed)');
  });

  it('toTeachingPackageError preserves the §J status vocabulary', () => {
    for (const [code, status] of [
      ['SKILL_POLICY_REQUIRED', 400],
      ['SKILL_POLICY_INVALID', 422],
      ['TEACHING_MODEL_CONFIG_CONTRADICTORY', 422],
      ['SKILL_NOT_FOUND', 422],
      ['SKILL_VERSION_UNRESOLVED', 422],
      ['SKILL_REQUIREMENT_UNSATISFIED', 422],
      ['SKILL_ASSIGNMENT_INVALID', 422],
      ['SCENE_CLASSIFICATION_INVALID', 422],
    ] as const) {
      const error = toTeachingPackageError({
        code,
        message: `message for ${code}`,
        details: { offendingSceneIds: [] },
      });
      expect(error.status, code).toBe(status);
    }
  });
});
