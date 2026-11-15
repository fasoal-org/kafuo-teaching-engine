import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';
import { createGuideAnswerGuard } from '@/lib/server/teaching-package/guide-answer-guard';
import type { GuideOutlinePlan, KeyedGuideItem } from '@/lib/server/teaching-package/guide-answers';

/**
 * g5.v11 (teacher-guide answer referee plan §8.3–8.5): the scene pipeline runs the code
 * check of the approved answers. A finding regenerates THAT scene once with a correction;
 * a slide still wrong leaves the lesson with its group, and a run without the guard is
 * generated exactly as before. Same real path as the bank-quiz test; only the LLM
 * boundary is stubbed.
 */

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));
vi.mock('@/lib/ai/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/llm')>()),
  callLLM: mocks.callLLM,
}));
vi.mock('@openmaic/generation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openmaic/generation')>();
  return {
    ...original,
    generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
    withGenerationRetry: <T>(
      operation: (attempt: number) => Promise<T>,
      options: Parameters<typeof original.withGenerationRetry>[1],
    ) => original.withGenerationRetry(operation, { ...options, baseDelayMs: 1, maxDelayMs: 1 }),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const STAGE_ID = 'stage-v11';
const persisted: { outlines?: Array<{ id: string }> } = {};

const sink = (): ClassroomPersistenceSink => ({
  reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
  persist: async ({ id, stage, scenes, outlines }) => {
    persisted.outlines = outlines as Array<{ id: string }>;
    return { id, url: '', stage, scenes, createdAt: '2026-11-16T00:00:00.000Z' };
  },
  release: async () => {},
});

const flow = [
  { stage: 'lesson_introduction', instructions: 'Open the lesson.' },
  { stage: 'outcome_check_understanding', instructions: 'Check the objective.' },
];

const slideOutline = (id: string, order: number, title: string) => ({
  id,
  type: 'slide' as const,
  slideType: 'content' as const,
  contentRole: 'example' as const,
  title,
  description: 'Teach it.',
  keyPoints: ['Anchor'],
  order,
  teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
  teachingSkills: { classification: 'instructional' as const },
});

const outlines = [
  slideOutline('open', 1, 'Opening'),
  slideOutline('sol', 2, 'Solution'),
  {
    id: 'sol-attempt',
    type: 'quiz' as const,
    title: 'Try',
    description: 'Try it.',
    keyPoints: ['Recap'],
    order: 3,
    teachingStage: { key: 'outcome_check_understanding', flowIndex: 1 },
    teachingSkills: { classification: 'non-instructional' as const },
    quizConfig: {
      questionCount: 1,
      difficulty: 'easy' as const,
      questionTypes: ['single' as const],
    },
  },
];

const baseInput = {
  requirement: 'Kafuo run',
  pdfContent: { text: 'pdf body', images: [] },
  teachingFlow: flow,
  governed: {
    contract: 'kafuo.teaching-skills.v1',
    teachingModel: { key: 'g5', version: 'g5.v11' },
    flow,
  },
};

const ITEM: KeyedGuideItem = {
  contentUnitId: '6234',
  label: '1A',
  element: 'try_it',
  number: 1,
  letter: 'A',
  display: '1A',
  answer: { type: 'number', value: 12 },
};

function guard() {
  const instance = createGuideAnswerGuard({ unitTexts: new Map([['6234', 'الأعداد 3، 6، 9']]) });
  const plans: Record<string, GuideOutlinePlan> = {
    sol: { role: 'solution', items: [ITEM], group: ['sol', 'sol-attempt'] },
    'sol-attempt': { role: 'attempt', items: [ITEM], group: ['sol-attempt'] },
  };
  instance.usePlans(new Map(Object.entries(plans)));
  return instance;
}

const slideContent = (line: string) =>
  JSON.stringify({
    elements: [
      { type: 'text', content: `<p>${line}</p>`, left: 100, top: 100, width: 600, height: 60 },
    ],
    remark: '',
  });
const ACTIONS = JSON.stringify([{ type: 'text', content: 'Canonical narration.' }]);
const quizContent = (keyed: string) =>
  JSON.stringify([
    {
      id: 'q1',
      type: 'single',
      question: 'ما الحد التالي؟',
      options: [
        { value: 'A', label: '12' },
        { value: 'B', label: '15' },
      ],
      answer: [keyed],
    },
  ]);

/** The solution slide answers 13 first; corrected (or always, with `stubborn`) as given. */
function routeModel(options: { stubborn?: boolean } = {}) {
  const calls = { solution: 0, quiz: 0 };
  mocks.callLLM.mockImplementation(
    async (request: { messages: Array<{ role: string; content: string }> }) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
      if (/Action Generator/.test(system)) return { text: ACTIONS };
      if (/^# Quiz Content Generator/m.test(system)) {
        calls.quiz += 1;
        return { text: quizContent(user.includes('HIDDEN') || calls.quiz > 1 ? 'A' : 'B') };
      }
      if (user.includes('Solution')) {
        calls.solution += 1;
        const corrected = user.includes('CORRECTION (checked final answers') && !options.stubborn;
        return { text: slideContent(corrected ? 'الإجابة (1A): 12' : 'الإجابة (1A): 13') };
      }
      return { text: slideContent('Body') };
    },
  );
  return calls;
}

async function run(input: unknown) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(input as never, { baseUrl: '', persistence: sink() });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  delete persisted.outlines;
  mocks.resolveModel.mockResolvedValue({
    model: { id: 'language-model' },
    modelInfo: { capabilities: { vision: true } },
    modelString: 'vision-model',
    providerId: 'test',
    apiKey: '',
  });
  mocks.isProviderKeyRequired.mockReturnValue(false);
  mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
    success: true,
    data: { languageDirective: 'Arabic.', outlines },
  });
});

const canvasText = (scene: { content: unknown }) =>
  JSON.stringify((scene.content as { canvas?: unknown }).canvas ?? scene.content);

describe('generateClassroom — g5.v11 approved-answer check', () => {
  it('without the guard, every scene is generated once, as before', async () => {
    const calls = routeModel();
    const result = await run(baseInput);
    expect(calls).toEqual({ solution: 1, quiz: 1 });
    expect(result.scenes).toHaveLength(3);
    expect(canvasText(result.scenes.find((scene) => scene.outlineId === 'sol')!)).toContain('13');
  });

  it('regenerates a wrong solution and a wrongly keyed attempt once, with a correction', async () => {
    const calls = routeModel();
    const result = await run({ ...baseInput, guideAnswerGuard: guard() });
    expect(calls).toEqual({ solution: 2, quiz: 2 });
    const solution = result.scenes.find((scene) => scene.outlineId === 'sol')!;
    expect(canvasText(solution)).toContain('الإجابة (1A): 12');
    const attempt = result.scenes.find((scene) => scene.outlineId === 'sol-attempt')!;
    expect(
      (attempt.content as { questions: Array<{ answer: string[] }> }).questions[0]!.answer,
    ).toEqual(['A']);
  });

  it('drops a solution still wrong after its one regeneration, with its attempt', async () => {
    const calls = routeModel({ stubborn: true });
    const result = await run({ ...baseInput, guideAnswerGuard: guard() });
    expect(calls.solution).toBe(2);
    expect(result.scenes.map((scene) => scene.outlineId)).toEqual(['open']);
    expect(result.outlines.map((outline) => outline.id)).toEqual(['open']);
    expect(persisted.outlines?.map((outline) => outline.id)).toEqual(['open']);
  });
});
