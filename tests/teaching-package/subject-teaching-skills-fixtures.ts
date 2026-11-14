/**
 * Shared fixtures for the Subject Teaching Skills V1 tests: the g5.v8 Skill Policies, and
 * the g5.v9 flow Kafuo sends for a subject. Plan:
 * `docs/frds/subject-teaching-skills-v1-plan-2026-11-14.md`.
 *
 * Mirror of Kafuo's `teaching_model_flows/g5_v2.py` policies, which g5.v3–g5.v8 reuse,
 * plus `subject_teaching_skills.project_subject_teaching_skill`. The subject → Skill
 * map, the stage, the scope and the role are read from the shared fixture both
 * repositories pin, so this mirror cannot drift from it silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  TeachingFlowEntry,
  TeachingSkillPolicy,
  TeachingSkillRef,
} from '@/lib/types/teaching-package';

export interface SubjectTeachingSkillsFixture {
  contract: string;
  teachingModel: { key: string; versions: string[] };
  stage: string;
  requirement: { scope: string; role: string };
  skills: Record<string, TeachingSkillRef>;
}

export const SHARED_FIXTURE: SubjectTeachingSkillsFixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/subject-teaching-skills.v1.json'), 'utf8'),
);

export const SUBJECTS = ['MATH', 'PHYSICS', 'CHEMISTRY', 'BIOLOGY', 'ARABIC'] as const;
export type Subject = (typeof SUBJECTS)[number];

const v1 = (skillId: string): TeachingSkillRef => ({ skillId, version: 'v1' });
export const UBD = v1('understanding-by-design');
const SEL = v1('social-emotional-learning');
const L2L = v1('learning-to-learn');
const SPIRAL = v1('spiral-curriculum');
const FEYNMAN = v1('feynman-learning');

const policy = (allowed: TeachingSkillRef[], preferred: TeachingSkillRef): TeachingSkillPolicy => ({
  required: [],
  preferred: [preferred],
  allowed,
  combinationRestrictions: [],
});

/** The g5.v8 (= g5.v2) authored policies per stage key. */
export const V8_POLICIES: Record<string, TeachingSkillPolicy> = {
  lesson_opener: policy([UBD, SEL, L2L], UBD),
  lesson_learning_map: policy([UBD, SEL, L2L], UBD),
  outcome_visual_explanations: policy([UBD, SPIRAL, L2L, SEL, FEYNMAN], UBD),
  outcome_check_understanding: policy([FEYNMAN, L2L, UBD], FEYNMAN),
};

/** One objective's expansion: opener, map, then the objective's two positions. */
const STAGES = [
  'lesson_opener',
  'lesson_learning_map',
  'outcome_visual_explanations',
  'outcome_check_understanding',
] as const;

/** The flow index of the objective teaching position in {@link g5Flow}. */
export const OBJECTIVE_FLOW_INDEX = 2;
/** The flow index of the objective quiz position in {@link g5Flow}. */
export const QUIZ_FLOW_INDEX = 3;

/** g5.v8's expanded flow for one objective (no subject Skill anywhere). */
export function g5V8Flow(): TeachingFlowEntry[] {
  return STAGES.map((stage) => ({
    stage,
    instructions: `Teach the ${stage} position.`,
    skillPolicy: structuredClone(V8_POLICIES[stage]!),
  }));
}

/** g5.v9's expanded flow for one objective of a lesson in `subject`, as Kafuo sends it. */
export function g5V9Flow(subject: string | null): TeachingFlowEntry[] {
  const flow = g5V8Flow();
  const skill = subject ? SHARED_FIXTURE.skills[subject] : undefined;
  if (!skill) return flow;
  return flow.map((entry) =>
    entry.stage === SHARED_FIXTURE.stage && entry.skillPolicy
      ? {
          ...entry,
          skillPolicy: {
            ...entry.skillPolicy,
            allowed: [...entry.skillPolicy.allowed, { ...skill }],
            required: [
              ...entry.skillPolicy.required,
              {
                skill: { ...skill },
                scope: SHARED_FIXTURE.requirement.scope,
                role: SHARED_FIXTURE.requirement.role,
              },
            ],
          },
        }
      : entry,
  );
}
