/**
 * Deterministic Skill-selection validation (Module 2 W10 — plan §P Step 10,
 * §E/§I). Each W10 prohibition is enforced by CODE at the Stage-1 gate, never
 * by prompt wording alone:
 *
 * - inventing a Skill identity          ⇒ SKILL_NOT_FOUND         (VAL-TS-001)
 * - selecting outside policy            ⇒ SKILL_ASSIGNMENT_INVALID (VAL-TS-004)
 * - unrestricted-catalog fallback       ⇒ SKILL_ASSIGNMENT_INVALID (BR-TS-048)
 * - ignoring required scope or role     ⇒ SKILL_REQUIREMENT_UNSATISFIED (VAL-TS-005)
 * - treating preferred as mandatory     ⇒ NEVER rejected           (BR-TS-011)
 *
 * Structural checks that belong to W12 (exactly-one-primary, duplicate keying,
 * combination restrictions, classification validity) are deliberately absent
 * here and pinned as absent: this validator must not reject what W12 owns.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { skillSourceHash } from '@/lib/server/agent-runtime/skills';
import {
  validateOutlineSkillSelections,
  type OutlineSkillSelectionShape,
} from '@/lib/server/teaching-package/skill-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type {
  TeachingFlowEntry,
  TeachingSkillPolicy,
  TeachingSkillRef,
} from '@/lib/types/teaching-package';

const ref = (skillId: string, version = 'v1'): TeachingSkillRef => ({ skillId, version });

const FEYNMAN = ref('feynman-learning');
const L2L = ref('learning-to-learn');
const LECTURE = ref('lecture-style');

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

const outline = (
  id: string,
  flowIndex: number,
  stage: string,
  teachingSkills?: OutlineSkillSelectionShape['teachingSkills'],
  type: 'slide' | 'quiz' = 'slide',
): OutlineSkillSelectionShape =>
  ({
    id,
    type,
    title: id,
    description: '',
    keyPoints: [],
    order: flowIndex + 1,
    teachingStage: { key: stage, flowIndex },
    ...(teachingSkills ? { teachingSkills } : {}),
  }) as OutlineSkillSelectionShape;

const FLOW: TeachingFlowEntry[] = [
  flowEntry('lesson_introduction', policy()),
  flowEntry('outcome_teaching_cards', policy()),
];

const expectRefusal = (act: () => unknown): TeachingPackageError => {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TeachingPackageError);
  return thrown as TeachingPackageError;
};

describe('validateOutlineSkillSelections (W10 Stage-1 gate checks)', () => {
  it('accepts a fully legal selection: permitted primary, permitted supporting, satisfied required rule', () => {
    expect(() =>
      validateOutlineSkillSelections(
        [
          outline('o1', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: FEYNMAN,
            supporting: [L2L],
          }),
          outline('o2', 1, 'outcome_teaching_cards', {
            classification: 'instructional',
            primary: L2L,
          }),
        ],
        FLOW,
      ),
    ).not.toThrow();
  });

  it('accepts selections that OMIT every preferred Skill — preferred guides, it never binds (BR-TS-011)', () => {
    expect(() =>
      validateOutlineSkillSelections(
        [
          outline('o1', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: L2L,
          }),
        ],
        FLOW,
      ),
    ).not.toThrow();
  });

  it('refuses an invented Skill identity with SKILL_NOT_FOUND (VAL-TS-001)', () => {
    const error = expectRefusal(() =>
      validateOutlineSkillSelections(
        [
          outline('o1', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: ref('made-up-pedagogy'),
          }),
        ],
        FLOW,
      ),
    );
    expect(error.code).toBe('SKILL_NOT_FOUND');
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({
      offendingSceneIds: ['o1'],
      skillId: 'made-up-pedagogy',
    });
  });

  it('refuses an unresolvable exact version with SKILL_VERSION_UNRESOLVED, never substitutes', () => {
    const error = expectRefusal(() =>
      validateOutlineSkillSelections(
        [
          outline('o1', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: ref('feynman-learning', 'v99'),
          }),
        ],
        FLOW,
      ),
    );
    expect(error.code).toBe('SKILL_VERSION_UNRESOLVED');
    expect(error.details).toMatchObject({ offendingSceneIds: ['o1'] });
  });

  it('refuses a resolvable catalog Skill outside the permitted set with SKILL_ASSIGNMENT_INVALID (VAL-TS-004 / BR-TS-048)', () => {
    const error = expectRefusal(() =>
      validateOutlineSkillSelections(
        [
          // lecture-style exists and resolves — the catalog is simply not a fallback.
          outline('o1', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: LECTURE,
          }),
        ],
        FLOW,
      ),
    );
    expect(error.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/unrestricted catalog is never a fallback/);
    expect(error.details).toMatchObject({
      offendingSceneIds: ['o1'],
      sceneId: 'o1',
      flowIndex: 0,
      stage: 'lesson_introduction',
      skillId: 'lecture-style',
      role: 'primary',
    });
  });

  it('refuses a supporting ref outside the permitted set with the supporting role in the details', () => {
    const error = expectRefusal(() =>
      validateOutlineSkillSelections(
        [
          outline('o1', 0, 'lesson_introduction', {
            classification: 'instructional',
            primary: FEYNMAN,
            supporting: [LECTURE],
          }),
        ],
        FLOW,
      ),
    );
    expect(error.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(error.details).toMatchObject({ role: 'supporting', skillId: 'lecture-style' });
  });

  it('refuses a resolvable-but-unpermitted VERSION of an allowed Skill against a two-version registry', () => {
    // Only a registry with two declared versions can express "resolves, but the
    // exact permitted set names the other version" — the pure boundary case.
    const root = mkdtempSync(join(tmpdir(), 'openmaic-skill-selection-'));
    try {
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
            v1: {
              digest: skillSourceHash('---\nname: two-version\ndescription: d\n---\n\nbody v1\n'),
            },
            v2: {
              digest: skillSourceHash('---\nname: two-version\ndescription: d\n---\n\nbody v2\n'),
            },
          },
        })}\n`,
      );

      const flow: TeachingFlowEntry[] = [
        flowEntry('lesson_introduction', policy({ allowed: [ref('two-version')] })),
      ];
      const error = expectRefusal(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: ref('two-version', 'v2'),
            }),
          ],
          flow,
          root,
        ),
      );
      // v2 resolves cleanly — it is simply not permitted where policy pins v1.
      expect(error.code).toBe('SKILL_ASSIGNMENT_INVALID');
      expect(error.details).toMatchObject({ skillId: 'two-version', skillVersion: 'v2' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a selection that cannot be attributed to a flow position (fail-closed, never skipped)', () => {
    const orphan = {
      id: 'orphan',
      teachingSkills: { classification: 'instructional', primary: FEYNMAN },
    } as OutlineSkillSelectionShape;
    const error = expectRefusal(() => validateOutlineSkillSelections([orphan], FLOW));
    expect(error.code).toBe('SKILL_ASSIGNMENT_INVALID');
    expect(error.details).toMatchObject({ offendingSceneIds: ['orphan'] });
  });

  describe('required scope and role (VAL-TS-005 — no default scope inferred)', () => {
    const required = (scope: string, role: string, skill: TeachingSkillRef = FEYNMAN) => [
      { skill, scope, role },
    ];

    it('flow_position/primary: satisfied by ONE outline at the position, even alongside others', () => {
      expect(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: L2L,
            }),
            outline('o2', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
          ],
          [
            flowEntry(
              'lesson_introduction',
              policy({ required: required('flow_position', 'primary') }),
            ),
          ],
        ),
      ).not.toThrow();
    });

    it('flow_position/primary: unsatisfied anywhere ⇒ SKILL_REQUIREMENT_UNSATISFIED with position context', () => {
      const error = expectRefusal(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: L2L,
            }),
          ],
          [
            flowEntry(
              'lesson_introduction',
              policy({ required: required('flow_position', 'primary') }),
            ),
          ],
        ),
      );
      expect(error.code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
      expect(error.status).toBe(422);
      expect(error.details).toMatchObject({
        offendingSceneIds: ['o1'],
        flowIndex: 0,
        stage: 'lesson_introduction',
        skillId: 'feynman-learning',
        role: 'primary',
        requiredScope: 'flow_position',
      });
    });

    it('flow_position/supporting: satisfied by a supporting ref at the position', () => {
      expect(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: L2L,
              supporting: [FEYNMAN],
            }),
          ],
          [
            flowEntry(
              'lesson_introduction',
              policy({ required: required('flow_position', 'supporting') }),
            ),
          ],
        ),
      ).not.toThrow();
      // …but a PRIMARY assignment does not satisfy a supporting-role rule.
      const error = expectRefusal(() =>
        validateOutlineSkillSelections(
          [
            outline('o2', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
          ],
          [
            flowEntry(
              'lesson_introduction',
              policy({ required: required('flow_position', 'supporting') }),
            ),
          ],
        ),
      );
      expect(error.code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
    });

    it('every_instructional_scene/primary: every instructional outline must carry it as primary', () => {
      const flow = [
        flowEntry(
          'lesson_introduction',
          policy({ required: required('every_instructional_scene', 'primary') }),
        ),
      ];
      expect(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
            outline('o2', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
          ],
          flow,
        ),
      ).not.toThrow();

      const error = expectRefusal(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
            outline('o2', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: L2L,
            }),
          ],
          flow,
        ),
      );
      expect(error.code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
      expect(error.details).toMatchObject({
        offendingSceneIds: ['o2'],
        requiredScope: 'every_instructional_scene',
      });
    });

    it('every_instructional_scene: an explicit non-instructional outline is exempt', () => {
      expect(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
            outline('o2', 0, 'lesson_introduction', { classification: 'non-instructional' }),
          ],
          [
            flowEntry(
              'lesson_introduction',
              policy({ required: required('every_instructional_scene', 'primary') }),
            ),
          ],
        ),
      ).not.toThrow();
    });

    it('every_instructional_scene: an UNCLASSIFIED outline counts as instructional — omission never dodges a requirement (BR-TS-054)', () => {
      const error = expectRefusal(() =>
        validateOutlineSkillSelections(
          [
            outline('o1', 0, 'lesson_introduction', {
              classification: 'instructional',
              primary: FEYNMAN,
            }),
            outline('o2', 0, 'lesson_introduction'), // no classification, no skills
          ],
          [
            flowEntry(
              'lesson_introduction',
              policy({ required: required('every_instructional_scene', 'primary') }),
            ),
          ],
        ),
      );
      expect(error.code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
      expect(error.details).toMatchObject({ offendingSceneIds: ['o2'] });
    });
  });

  describe('classification independence at the selection layer (FR-TS-022/023, BR-TS-054)', () => {
    it('carries a non-instructional classification with no primary without rejecting it here (structure is W12)', () => {
      expect(() =>
        validateOutlineSkillSelections(
          [outline('o1', 0, 'lesson_introduction', { classification: 'non-instructional' })],
          FLOW,
        ),
      ).not.toThrow();
    });

    it('accepts an instructional QUIZ outline with a legal primary — scene type never determines classification (FR-TS-023)', () => {
      expect(() =>
        validateOutlineSkillSelections(
          [
            outline(
              'o1',
              0,
              'lesson_introduction',
              { classification: 'instructional', primary: FEYNMAN },
              'quiz',
            ),
          ],
          FLOW,
        ),
      ).not.toThrow();
    });

    it('does not demand carriers at all when nothing is required (W12 owns the structure checks)', () => {
      expect(() =>
        validateOutlineSkillSelections(
          [outline('o1', 0, 'lesson_introduction'), outline('o2', 1, 'outcome_teaching_cards')],
          FLOW,
        ),
      ).not.toThrow();
    });
  });
});
