/**
 * Subject Teaching Skills V1 reach the generation prompts. Plan:
 * `docs/frds/subject-teaching-skills-v1-plan-2026-11-14.md` §7.
 *
 * For one representative lesson in each of the five subjects, this test runs the real
 * path a governed g5.v9 run takes:
 * 1. Resolve the g5.v9 policy against the real registry (`resolveFlowSkillPolicies`, as
 *    `classroom-generation.ts` does).
 * 2. Put the subject Skill on the objective outline as its Primary, with the pedagogical
 *    method (UbD) supporting it (owner, 14 Nov 2026: the subject Skill leads).
 * 3. Render the real slide-content and slide-actions (narration) prompts, with a
 *    capturing model stub. No model is called.
 *
 * Each Skill's own instruction lines must be in both prompts, and no other subject's
 * Skill may be. The objective quiz position, which keeps its v8 policy, never gets the
 * subject Skill.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type ResolvedSkillDefinition,
  type SceneOutline,
} from '@openmaic/generation';

import { resolveFlowSkillPolicies } from '@/lib/server/teaching-package/skill-policy';
import { SUBJECT_TEACHING_SKILLS } from '@/lib/server/teaching-package/subject-teaching-skills';

import {
  g5V9Flow,
  OBJECTIVE_FLOW_INDEX,
  QUIZ_FLOW_INDEX,
  SUBJECTS,
  UBD,
  type Subject,
} from './subject-teaching-skills-fixtures';

const CATALOG = join(process.cwd(), 'skills/agent-runtime');

/** One representative objective slide per subject, as a g5.v9 lesson plans it. */
const LESSONS: Record<Subject, Pick<SceneOutline, 'title' | 'description' | 'keyPoints'>> = {
  MATH: {
    title: 'حل المعادلات ذات الخطوتين',
    description: 'حل المعادلة 3س + 5 = 20 بخطوات مبرَّرة، ثم التحقق من الحل بالتعويض.',
    keyPoints: ['خاصية الطرح للمساواة', 'خاصية القسمة للمساواة', 'التحقق بالتعويض'],
  },
  PHYSICS: {
    title: 'قانون نيوتن الثاني',
    description: 'العلاقة بين القوة المحصلة والكتلة والتسارع، وحساب تسارع جسم كتلته 2 kg.',
    keyPoints: ['القوة المحصلة ق = ك × ت', 'وحدة القوة: نيوتن', 'شروط تطبيق القانون'],
  },
  CHEMISTRY: {
    title: 'موازنة المعادلات الكيميائية',
    description: 'موازنة معادلة احتراق الميثان وتطبيق قانون حفظ الكتلة.',
    keyPoints: ['قانون حفظ الكتلة', 'المعاملات لا الأرقام السفلية', 'عدّ الذرات للتحقق'],
  },
  BIOLOGY: {
    title: 'البناء الضوئي',
    description: 'مدخلات البناء الضوئي ومخرجاته ومراحله في البلاستيدات الخضراء.',
    keyPoints: ['المدخلات والمخرجات', 'التفاعلات الضوئية واللاضوئية', 'تركيب البلاستيدة الخضراء'],
  },
  ARABIC: {
    title: 'كان وأخواتها',
    description: 'عمل كان وأخواتها في الجملة الاسمية مع الإعراب والمقارنة بإنّ وأخواتها.',
    keyPoints: ['ترفع المبتدأ وتنصب الخبر', 'علامات الإعراب', 'المقارنة بإنّ وأخواتها'],
  },
};

/** A line of each Skill's own method; no other Skill carries it. */
const OWN_INSTRUCTION: Record<Subject, string> = {
  MATH: 'Select the relevant rule, formula, property or theorem, and say why it applies here.',
  PHYSICS: 'Explain what is happening physically before any equation',
  CHEMISTRY: 'Balance the equation when one is required, atom by atom.',
  BIOLOGY: 'Link each characteristic to the function it serves',
  ARABIC: 'Do not apply the grammar teaching sequence to reading, literature or writing lessons.',
};

const SLIDE_CONTENT_RESPONSE = JSON.stringify({
  elements: [],
  background: { type: 'solid', color: '#fff' },
});
const SLIDE_ACTIONS_RESPONSE = JSON.stringify([{ type: 'text', content: 'نبدأ بالفكرة.' }]);
const QUIZ_CONTENT_RESPONSE = JSON.stringify([
  {
    id: 'q1',
    type: 'single',
    question: 'سؤال',
    options: ['أ', 'ب'],
    answer: 'A',
    analysis: 'شرح',
    points: 10,
  },
]);

function capture(store: { system?: string }, response: string): AICallFn {
  return async (system) => {
    store.system = system;
    return response;
  };
}

/** The run's resolved definitions, exactly as `classroom-generation.ts` builds them. */
function resolvedSkillsFor(subject: Subject): ResolvedSkillDefinition[] {
  return [...resolveFlowSkillPolicies(g5V9Flow(subject), CATALOG).values()].map((definition) => ({
    skillId: definition.skillId,
    version: definition.version,
    definition: definition.content,
  }));
}

const otherSubjects = (subject: Subject) => SUBJECTS.filter((other) => other !== subject);

describe.each(SUBJECTS)('%s lesson', (subject) => {
  const skill = SUBJECT_TEACHING_SKILLS[subject]!;
  const objectiveSlide: SceneOutline = {
    id: `${subject.toLowerCase()}-slide-1`,
    type: 'slide',
    order: 3,
    ...LESSONS[subject],
    teachingStage: { key: 'outcome_visual_explanations', flowIndex: OBJECTIVE_FLOW_INDEX },
    teachingSkills: { classification: 'instructional', primary: skill, supporting: [UBD] },
  };

  it('its Skill is the Primary of the slide-content prompt', async () => {
    const content: { system?: string } = {};
    await generateSceneContent(objectiveSlide, capture(content, SLIDE_CONTENT_RESPONSE), {
      languageDirective: 'Teach in Arabic.',
      resolvedSkills: resolvedSkillsFor(subject),
    });

    expect(content.system).toContain('Teaching Skills — HOW this slide teaches');
    expect(content.system).toContain(`PRIMARY SKILL: ${skill.skillId}@v1`);
    expect(content.system).toContain('SUPPORTING SKILL: understanding-by-design@v1');
    expect(content.system).toContain(OWN_INSTRUCTION[subject]);
    expect(content.system).toContain('Never invent a misconception to fill a slot.');
    for (const other of otherSubjects(subject)) {
      expect(content.system).not.toContain(SUBJECT_TEACHING_SKILLS[other]!.skillId);
      expect(content.system).not.toContain(OWN_INSTRUCTION[other]);
    }
  });

  it('its Skill is in the narration (slide-actions) prompt', async () => {
    const actions: { system?: string } = {};
    await generateSceneActions(
      objectiveSlide,
      { elements: [], background: { type: 'solid', color: '#fff' } },
      capture(actions, SLIDE_ACTIONS_RESPONSE),
      { languageDirective: 'Teach in Arabic.', resolvedSkills: resolvedSkillsFor(subject) },
    );

    expect(actions.system).toContain('Teaching Skill Authority — HOW this scene teaches');
    expect(actions.system).toContain(`PRIMARY SKILL: ${skill.skillId}@v1`);
    expect(actions.system).toContain(OWN_INSTRUCTION[subject]);
    for (const other of otherSubjects(subject)) {
      expect(actions.system).not.toContain(SUBJECT_TEACHING_SKILLS[other]!.skillId);
    }
  });

  it('the objective quiz keeps its v8 Skills and never gets the subject Skill', async () => {
    const quiz: { system?: string } = {};
    await generateSceneContent(
      {
        id: `${subject.toLowerCase()}-quiz-1`,
        type: 'quiz',
        order: 4,
        title: LESSONS[subject].title,
        description: 'Check the objective.',
        keyPoints: LESSONS[subject].keyPoints,
        quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] },
        teachingStage: { key: 'outcome_check_understanding', flowIndex: QUIZ_FLOW_INDEX },
        teachingSkills: {
          classification: 'instructional',
          primary: { skillId: 'feynman-learning', version: 'v1' },
        },
      },
      capture(quiz, QUIZ_CONTENT_RESPONSE),
      { languageDirective: 'Teach in Arabic.', resolvedSkills: resolvedSkillsFor(subject) },
    );

    expect(quiz.system).toContain('PRIMARY SKILL: feynman-learning@v1');
    expect(quiz.system).not.toContain(skill.skillId);
    expect(quiz.system).not.toContain(OWN_INSTRUCTION[subject]);
  });
});
