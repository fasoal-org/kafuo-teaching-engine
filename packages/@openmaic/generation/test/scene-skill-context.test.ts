/**
 * Teaching Skill context in downstream scene generation (Module 2 W11 —
 * teaching-skills plan §P Step 11 · §I · §B.10 · §O-4a/4b).
 *
 * Skill assignment must not be decorative: a selected Skill reaches the actual
 * content and action prompts and observably changes them, while the global
 * rules (single-voice teacher narration, output format, grounding, language)
 * stay binding. And the change must be gated on a RESOLVED Skill being
 * present: the generators are shared by four call sites, and the three
 * non-Kafuo ones (Workbench `generate_scene`, editor scene regeneration, the
 * scene-actions route) never pass `resolvedSkills` — their prompts must stay
 * byte-identical, even when an outline happens to carry a `teachingSkills`
 * carrier.
 */
import { expect, it } from 'vitest';

import {
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type ResolvedSkillDefinition,
  type SceneOutline,
} from '../src/index.js';
import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

const FEYNMAN = 'feynman-learning';
const LECTURE = 'lecture-style';
const SEL = 'social-emotional-learning';

const skill = (skillId: string, body: string): ResolvedSkillDefinition => ({
  skillId,
  version: 'v1',
  definition: body,
});

const FEYNMAN_BODY =
  '---\nname: feynman-learning\n---\n\n# Feynman Learning\n\nTeach by having the learner explain the concept back in their own simple words. Use plain-language analogies, surface and repair misconceptions immediately, and check understanding by asking the learner to re-explain.';
const LECTURE_BODY =
  '---\nname: lecture-style\n---\n\n# Lecture Style\n\nTeach in a structured expository sequence: define, elaborate with rigor, then summarize the formal result. Prefer precise terminology and a measured, authoritative cadence.';
const SEL_BODY =
  '---\nname: social-emotional-learning\n---\n\n# Social-Emotional Learning\n\nSupport the learner emotionally: acknowledge effort, normalize mistakes, and encourage persistence.';

const governedOutline = (primaryId: string, ...supportingIds: string[]): SceneOutline => ({
  ...slideOutline(),
  teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
  teachingSkills: {
    classification: 'instructional',
    primary: { skillId: primaryId, version: 'v1' },
    supporting: supportingIds.map((skillId) => ({ skillId, version: 'v1' })),
  },
});

type Captured = Record<string, { system: string; user: string }>;

const SLIDE_CONTENT_RESPONSE = JSON.stringify({
  elements: [],
  background: { type: 'solid', color: '#fff' },
});
const SLIDE_ACTIONS_RESPONSE = JSON.stringify([{ type: 'text', content: 'First, the key idea.' }]);
const QUIZ_CONTENT_RESPONSE = JSON.stringify([
  {
    id: 'q1',
    type: 'single',
    question: 'Which collaborator is injected?',
    options: ['The factory', 'The logger'],
    answer: 'B',
    analysis: 'The logger is injected by the caller.',
    points: 10,
  },
]);
const QUIZ_ACTIONS_RESPONSE = JSON.stringify([{ type: 'text', content: 'Time to check.' }]);
const INTERACTIVE_HTML = '<!DOCTYPE html><html><head></head><body></body></html>';
const PBL_CONTENT = { projectV2: undefined } as never;

function captureInto(store: Captured, key: string, response: string): AICallFn {
  return async (system, user) => {
    store[key] = { system, user };
    return response;
  };
}

it('renders byte-identical prompts without resolvedSkills — carrier or no carrier', async () => {
  // This is the invariant that keeps the three non-Kafuo call sites (Workbench
  // generate_scene, editor scene regeneration, scene-actions route) untouched:
  // they never pass resolvedSkills, so even an outline carrying a teachingSkills
  // carrier renders exactly the pre-teaching-skills prompt.
  const bare: Captured = {};
  const carrierOnly: Captured = {};

  await generateSceneContent(
    slideOutline(),
    captureInto(bare, 'slide-content', SLIDE_CONTENT_RESPONSE),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneContent(
    governedOutline(FEYNMAN),
    captureInto(carrierOnly, 'slide-content', SLIDE_CONTENT_RESPONSE),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneContent(
    quizOutline(),
    captureInto(bare, 'quiz-content', QUIZ_CONTENT_RESPONSE),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneContent(
    {
      ...quizOutline(),
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: FEYNMAN, version: 'v1' },
      },
    },
    captureInto(carrierOnly, 'quiz-content', QUIZ_CONTENT_RESPONSE),
    { languageDirective: 'Teach in English.' },
  );

  const slideContent = { elements: [], background: { type: 'solid' as const, color: '#fff' } };
  await generateSceneActions(
    slideOutline(),
    slideContent,
    captureInto(bare, 'slide-actions', SLIDE_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneActions(
    governedOutline(FEYNMAN),
    slideContent,
    captureInto(carrierOnly, 'slide-actions', SLIDE_ACTIONS_RESPONSE),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneActions(
    quizOutline(),
    { questions: [] },
    captureInto(bare, 'quiz-actions', QUIZ_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneActions(
    {
      ...quizOutline(),
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: FEYNMAN, version: 'v1' },
      },
    },
    { questions: [] },
    captureInto(carrierOnly, 'quiz-actions', QUIZ_ACTIONS_RESPONSE),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneActions(
    widgetOutline(),
    { html: INTERACTIVE_HTML, widgetType: 'simulation' },
    captureInto(bare, 'interactive-actions', '[]'),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneActions(
    {
      ...widgetOutline(),
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: FEYNMAN, version: 'v1' },
      },
    },
    { html: INTERACTIVE_HTML, widgetType: 'simulation' },
    captureInto(carrierOnly, 'interactive-actions', '[]'),
    { languageDirective: 'Teach in English.' },
  );
  await generateSceneActions(pblOutline(), PBL_CONTENT, captureInto(bare, 'pbl-actions', '[]'), {
    languageDirective: 'Teach in English.',
  });
  await generateSceneActions(
    {
      ...pblOutline(),
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: FEYNMAN, version: 'v1' },
      },
    },
    PBL_CONTENT,
    captureInto(carrierOnly, 'pbl-actions', '[]'),
    { languageDirective: 'Teach in English.' },
  );

  for (const key of Object.keys(bare)) {
    expect(carrierOnly[key], key).toEqual(bare[key]);
    expect(bare[key]!.system, key).not.toContain('Teaching Skill');
  }
});

it('two different Primary Skills produce observably different governed prompts', async () => {
  // Same outline at the same flow position; only the Primary Skill differs.
  // The selected Skill must reach the actual pedagogy prompts — narration,
  // pacing, interaction — not merely Scene metadata (§O-4b).
  const feynman: Captured = {};
  const lecture: Captured = {};

  const resolvedFeynman = [skill(FEYNMAN, FEYNMAN_BODY), skill(SEL, SEL_BODY)];
  const resolvedLecture = [skill(LECTURE, LECTURE_BODY)];

  await generateSceneContent(
    governedOutline(FEYNMAN, SEL),
    captureInto(feynman, 'content', SLIDE_CONTENT_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolvedFeynman,
    },
  );
  await generateSceneContent(
    governedOutline(LECTURE),
    captureInto(lecture, 'content', SLIDE_CONTENT_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolvedLecture,
    },
  );

  expect(feynman.content!.system).toContain('Teaching Skills — HOW this slide teaches');
  expect(feynman.content!.system).toContain('PRIMARY SKILL: feynman-learning@v1');
  expect(feynman.content!.system).toContain('plain-language analogies');
  expect(feynman.content!.system).toContain('SUPPORTING SKILL: social-emotional-learning@v1');
  expect(feynman.content!.system).toContain('acknowledge effort');
  expect(lecture.content!.system).toContain('PRIMARY SKILL: lecture-style@v1');
  expect(lecture.content!.system).toContain('structured expository sequence');
  expect(feynman.content!.system).not.toEqual(lecture.content!.system);

  const slideContent = { elements: [], background: { type: 'solid' as const, color: '#fff' } };
  await generateSceneActions(
    governedOutline(FEYNMAN, SEL),
    slideContent,
    captureInto(feynman, 'actions', SLIDE_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolvedFeynman,
    },
  );
  await generateSceneActions(
    governedOutline(LECTURE),
    slideContent,
    captureInto(lecture, 'actions', SLIDE_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolvedLecture,
    },
  );

  expect(feynman.actions!.system).toContain('Teaching Skill Authority — HOW this scene teaches');
  expect(feynman.actions!.system).toContain('the selected Skill governs');
  expect(feynman.actions!.system).toContain('Feynman Learning');
  expect(lecture.actions!.system).toContain('Lecture Style');
  expect(feynman.actions!.system).not.toEqual(lecture.actions!.system);
});

it('governed renders keep every global rule the §I classification protects', async () => {
  const captured: Captured = {};
  const resolved = [skill(FEYNMAN, FEYNMAN_BODY)];

  const slideContent = { elements: [], background: { type: 'solid' as const, color: '#fff' } };
  await generateSceneActions(
    governedOutline(FEYNMAN),
    slideContent,
    captureInto(captured, 'slide-actions', SLIDE_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolved,
    },
  );
  await generateSceneActions(
    {
      ...widgetOutline(),
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: FEYNMAN, version: 'v1' },
      },
    },
    { html: INTERACTIVE_HTML, widgetType: 'simulation' },
    captureInto(captured, 'interactive-actions', '[]'),
    { languageDirective: 'Teach in English.', resolvedSkills: resolved },
  );
  await generateSceneContent(
    governedOutline(FEYNMAN),
    captureInto(captured, 'slide-content', SLIDE_CONTENT_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolved,
    },
  );
  await generateSceneContent(
    {
      ...quizOutline(),
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: FEYNMAN, version: 'v1' },
      },
    },
    captureInto(captured, 'quiz-content', QUIZ_CONTENT_RESPONSE),
    { languageDirective: 'Teach in English.', resolvedSkills: resolved },
  );

  // Single-voice teacher-monologue rule, mirrored in slide-actions and
  // interactive-actions, stays binding next to the Skill authority block.
  expect(captured['slide-actions']!.system).toContain('Single voice, teacher only');
  expect(captured['interactive-actions']!.system).toContain('Single voice, teacher only');
  // Output format and pacing/quiz global quality constraints stay present.
  expect(captured['slide-actions']!.system).toContain('You MUST output a JSON array directly');
  expect(captured['interactive-actions']!.system).toContain('3-8 items');
  expect(captured['quiz-content']!.system).toContain('Difficulty');
  // The authority block itself names what stays binding.
  for (const key of ['slide-actions', 'interactive-actions', 'slide-content', 'quiz-content']) {
    expect(captured[key]!.system, key).toMatch(/stay binding|remain global requirements/);
    expect(captured[key]!.system, key).not.toContain('{{skillContextText}}');
    expect(captured[key]!.system, key).not.toContain('{{hasSkillContext}}');
  }
});

it('governs the light paths too (quiz-actions framing, pbl-actions introduction)', async () => {
  const captured: Captured = {};
  const resolved = [skill(FEYNMAN, FEYNMAN_BODY)];
  const carrier = {
    classification: 'instructional' as const,
    primary: { skillId: FEYNMAN, version: 'v1' },
  };

  await generateSceneActions(
    { ...quizOutline(), teachingSkills: carrier },
    { questions: [] },
    captureInto(captured, 'quiz-actions', QUIZ_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolved,
    },
  );
  await generateSceneActions(
    { ...pblOutline(), teachingSkills: carrier },
    PBL_CONTENT,
    captureInto(captured, 'pbl-actions', '[]'),
    {
      languageDirective: 'Teach in English.',
      resolvedSkills: resolved,
    },
  );

  expect(captured['quiz-actions']!.system).toContain('Teaching Skills — HOW this scene teaches');
  expect(captured['quiz-actions']!.system).toContain('Feynman Learning');
  expect(captured['quiz-actions']!.system).toContain('1-2 short segments');
  expect(captured['pbl-actions']!.system).toContain('Teaching Skills — HOW this scene teaches');
  expect(captured['pbl-actions']!.system).toContain('The PBL runtime itself');
});

it('pins today’s ungoverned action prompts (the three non-Kafuo call sites’ bytes)', async () => {
  // Fresh golden pins for the action prompts the pre-existing golden file does
  // not cover. These are NEW pins of today's bytes (not updates); any drift in
  // the ungoverned render — including conditional-block whitespace leakage of
  // exactly the §O-8 class — fails here.
  const captured: Captured = {};
  const slideContent = { elements: [], background: { type: 'solid' as const, color: '#fff' } };

  await generateSceneActions(
    slideOutline(),
    slideContent,
    captureInto(captured, 'slide-actions', SLIDE_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneActions(
    quizOutline(),
    { questions: [] },
    captureInto(captured, 'quiz-actions', QUIZ_ACTIONS_RESPONSE),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneActions(
    widgetOutline(),
    { html: INTERACTIVE_HTML, widgetType: 'simulation' },
    captureInto(captured, 'interactive-actions', '[]'),
    {
      languageDirective: 'Teach in English.',
    },
  );
  await generateSceneActions(
    pblOutline(),
    PBL_CONTENT,
    captureInto(captured, 'pbl-actions', '[]'),
    {
      languageDirective: 'Teach in English.',
    },
  );

  expect(captured).toMatchSnapshot();
});
