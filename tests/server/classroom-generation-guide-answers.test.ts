import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';
import { createGuideAnswerGuard } from '@/lib/server/teaching-package/guide-answer-guard';
import {
  injectGuideAnswers,
  type GuideOutlinePlan,
  type KeyedGuideItem,
} from '@/lib/server/teaching-package/guide-answers';

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

function guard(plans: Record<string, GuideOutlinePlan> = PLANS) {
  const instance = createGuideAnswerGuard({ unitTexts: new Map([['6234', 'الأعداد 3، 6، 9']]) });
  instance.usePlans(new Map(Object.entries(plans)));
  return instance;
}

const PLANS: Record<string, GuideOutlinePlan> = {
  sol: { role: 'solution', items: [ITEM], solves: 2 },
  'sol-attempt': { role: 'attempt', items: [ITEM] },
};

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

  it('D-19: a check solution still wrong is generated once more without its guide answer and kept', async () => {
    const calls = routeModel({ stubborn: true });
    const result = await run({ ...baseInput, guideAnswerGuard: guard() });
    // First, corrected, then the plain g5.v10 path — never dropped, never a person.
    expect(calls.solution).toBe(3);
    expect(result.scenes.map((scene) => scene.outlineId)).toEqual(['open', 'sol', 'sol-attempt']);
    expect(persisted.outlines?.map((outline) => outline.id)).toEqual([
      'open',
      'sol',
      'sol-attempt',
    ]);
  });

  it('never gives an attempt’s narration writer its hidden key (review finding 1)', async () => {
    const keyed = outlines.map((outline) =>
      outline.id === 'sol-attempt'
        ? {
            ...outline,
            description: 'Try it.\n\nHIDDEN ANSWER KEY (g5.v11): the answers\n- item 1A: 12',
          }
        : outline,
    );
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Arabic.', outlines: keyed },
    });
    routeModel();
    await run({ ...baseInput, guideAnswerGuard: guard() });
    const prompts = mocks.callLLM.mock.calls.map((call) => {
      const request = call[0] as { messages: Array<{ role: string; content: string }> };
      return {
        system: request.messages.find((m) => m.role === 'system')?.content ?? '',
        user: request.messages.find((m) => m.role === 'user')?.content ?? '',
      };
    });
    const quizContent = prompts.filter((p) => /^# Quiz Content Generator/m.test(p.system));
    const quizNarration = prompts.filter((p) => /^# Quiz Action Generator/m.test(p.system));
    expect(quizContent.some((p) => p.user.includes('HIDDEN ANSWER KEY'))).toBe(true);
    expect(quizNarration.length).toBeGreaterThan(0);
    for (const prompt of quizNarration) expect(prompt.user).not.toContain('HIDDEN ANSWER KEY');
  });

  it('D-19: an exercise still wrong leaves its slide and its attempt question', async () => {
    const EX11: KeyedGuideItem = {
      contentUnitId: '6249',
      label: '11',
      element: 'exercise',
      number: 11,
      letter: null,
      display: 'س11',
      answer: { type: 'number', value: 32 },
    };
    const EX12: KeyedGuideItem = {
      ...EX11,
      label: '12',
      number: 12,
      display: 'س12',
      answer: { type: 'number', value: 71.9 },
    };
    // The exercise attempt comes BEFORE its solution slide.
    const exercise = [
      slideOutline('open', 1, 'Opening'),
      {
        ...outlines[2]!,
        id: 'ex-attempt',
        order: 2,
        quizConfig: {
          questionCount: 2,
          difficulty: 'easy' as const,
          questionTypes: ['single' as const],
        },
      },
      slideOutline('ex', 3, 'Exercise'),
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Arabic.', outlines: exercise },
    });
    const prompts: string[] = [];
    mocks.callLLM.mockImplementation(
      async (request: { messages: Array<{ role: string; content: string }> }) => {
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
        if (/Action Generator/.test(system)) return { text: ACTIONS };
        if (/^# Quiz Content Generator/m.test(system)) {
          return {
            text: JSON.stringify([
              {
                id: 'q1',
                type: 'single',
                question: 'أسعار: 2، 4، 8، 16. ما التالي؟',
                options: [
                  { value: 'A', label: '24' },
                  { value: 'B', label: '32' },
                ],
                answer: ['B'],
              },
              {
                id: 'q2',
                type: 'single',
                question: 'إنتاج مصنع؟',
                options: [
                  { value: 'A', label: '71.9' },
                  { value: 'B', label: '51.8' },
                ],
                answer: ['A'],
              },
            ]),
          };
        }
        if (user.includes('Exercise')) {
          prompts.push(user);
          return { text: slideContent('الإجابة (س11): 24</p><p>الإجابة (س12): 71.9') };
        }
        return { text: slideContent('Body') };
      },
    );
    const result = await run({
      ...baseInput,
      guideAnswerGuard: guard({
        ex: { role: 'solution', items: [EX11, EX12], solves: 2 },
        'ex-attempt': {
          role: 'attempt',
          items: [EX11, EX12],
          questionOf: { '6249|11': 0, '6249|12': 1 },
          questionCount: 2,
        },
      }),
    });
    // First, corrected, then once more without question 11.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('LEFT OUT QUESTIONS (g5.v11)');
    expect(result.scenes.map((scene) => scene.outlineId)).toEqual(['open', 'ex-attempt', 'ex']);
    const attempt = result.scenes.find((scene) => scene.outlineId === 'ex-attempt')!;
    expect(
      (attempt.content as { questions: Array<{ question: string }> }).questions.map(
        (question) => question.question,
      ),
    ).toEqual(['إنتاج مصنع؟']);
    // The persisted plan says what the slide now does.
    const persistedEx = (persisted.outlines as Array<{ id: string; description?: string }>).find(
      (outline) => outline.id === 'ex',
    )!;
    expect(persistedEx.description).toContain('LEFT OUT QUESTIONS (g5.v11)');
  });

  const quizPrompts = () =>
    mocks.callLLM.mock.calls
      .map((call) => {
        const request = call[0] as { messages: Array<{ role: string; content: string }> };
        return {
          system: request.messages.find((m) => m.role === 'system')?.content ?? '',
          user: request.messages.find((m) => m.role === 'user')?.content ?? '',
        };
      })
      .filter((prompt) => /^# Quiz Content Generator/m.test(prompt.system))
      .map((prompt) => prompt.user);

  it('re-review finding 6: a check attempt loses the key its solution slide was settled without', async () => {
    // try → its attempt (keyed) → the solution, which stays wrong and loses its guide answer.
    const lesson = [
      slideOutline('open', 1, 'Opening'),
      slideOutline('try', 2, 'Try slide'),
      {
        ...outlines[2]!,
        id: 'try-attempt',
        order: 3,
        description: 'Try it.\n\nHIDDEN ANSWER KEY (g5.v11): the answers\n- item 1A: 12',
      },
      slideOutline('sol', 4, 'Solution'),
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Arabic.', outlines: lesson },
    });
    const calls = routeModel({ stubborn: true });
    const result = await run({
      ...baseInput,
      guideAnswerGuard: guard({
        try: { role: 'try', items: [ITEM] },
        'try-attempt': { role: 'attempt', items: [ITEM] },
        sol: { role: 'solution', items: [ITEM], solves: 1 },
      }),
    });
    // The solution: first, corrected, then the plain path. The attempt: once with its
    // key, then once more without it, after the solution settled.
    expect(calls).toEqual({ solution: 3, quiz: 2 });
    const prompts = quizPrompts();
    expect(prompts[0]).toContain('HIDDEN ANSWER KEY');
    expect(prompts[1]).not.toContain('HIDDEN ANSWER KEY');
    expect(result.scenes.map((scene) => scene.outlineId)).toEqual([
      'open',
      'try',
      'try-attempt',
      'sol',
    ]);
    const attempt = (persisted.outlines as Array<{ id: string; description?: string }>).find(
      (outline) => outline.id === 'try-attempt',
    )!;
    expect(attempt.description).not.toContain('HIDDEN ANSWER KEY');
  });

  it('re-review finding 5c: a try-it slide that still states the answer is kept and marked', async () => {
    const lesson = [slideOutline('open', 1, 'Opening'), slideOutline('try', 2, 'Leaky try')];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Arabic.', outlines: lesson },
    });
    let leaky = 0;
    mocks.callLLM.mockImplementation(
      async (request: { messages: Array<{ role: string; content: string }> }) => {
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
        if (/Action Generator/.test(system)) return { text: ACTIONS };
        if (user.includes('Leaky try')) {
          leaky += 1;
          return { text: slideContent('الحد التالي هو 12') };
        }
        return { text: slideContent('Body') };
      },
    );
    const result = await run({
      ...baseInput,
      guideAnswerGuard: guard({ try: { role: 'try', items: [ITEM] } }),
    });
    expect(leaky).toBe(2);
    const tryScene = result.scenes.find((scene) => scene.outlineId === 'try')!;
    expect(tryScene.generationIssues?.map((issue) => issue.code)).toContain('GUIDE_ANSWER_LEAK');
    expect(JSON.stringify(tryScene.generationIssues)).not.toMatch(/\b12\b/);
  });

  it('re-review finding 6: a resumed attempt before a solution settled again never keeps a removed question', async () => {
    const EX11: KeyedGuideItem = {
      contentUnitId: '6249',
      label: '11',
      element: 'exercise',
      number: 11,
      letter: null,
      display: 'س11',
      answer: { type: 'number', value: 32 },
    };
    const EX12: KeyedGuideItem = {
      ...EX11,
      label: '12',
      number: 12,
      display: 'س12',
      answer: { type: 'number', value: 71.9 },
    };
    const plans: Record<string, GuideOutlinePlan> = {
      ex: { role: 'solution', items: [EX11, EX12], solves: 2 },
      'ex-attempt': {
        role: 'attempt',
        items: [EX11, EX12],
        questionOf: { '6249|11': 0, '6249|12': 1 },
        questionCount: 2,
      },
    };
    const lesson = [
      slideOutline('open', 1, 'Opening'),
      {
        ...outlines[2]!,
        id: 'ex-attempt',
        order: 2,
        quizConfig: {
          questionCount: 2,
          difficulty: 'easy' as const,
          questionTypes: ['single' as const],
        },
      },
      slideOutline('ex', 3, 'Exercise'),
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Arabic.', outlines: lesson },
    });
    let exerciseLine = 'الإجابة (س11): 32</p><p>الإجابة (س12): 71.9';
    mocks.callLLM.mockImplementation(
      async (request: { messages: Array<{ role: string; content: string }> }) => {
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
        if (/Action Generator/.test(system)) return { text: ACTIONS };
        if (/^# Quiz Content Generator/m.test(system)) {
          return {
            text: JSON.stringify([
              {
                id: 'q1',
                type: 'single',
                question: 'أسعار: 2، 4، 8، 16. ما التالي؟',
                options: [
                  { value: 'A', label: '24' },
                  { value: 'B', label: '32' },
                ],
                answer: ['B'],
              },
              {
                id: 'q2',
                type: 'single',
                question: 'إنتاج مصنع؟',
                options: [
                  { value: 'A', label: '71.9' },
                  { value: 'B', label: '51.8' },
                ],
                answer: ['A'],
              },
            ]),
          };
        }
        if (user.includes('Exercise')) return { text: slideContent(exerciseLine) };
        return { text: slideContent('Body') };
      },
    );
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    const first = await generateClassroom(
      { ...baseInput, guideAnswerGuard: guard(plans) } as never,
      { baseUrl: '', persistence: sink() },
    );
    const asked = (scenes: typeof first.scenes) =>
      (
        scenes.find((scene) => scene.outlineId === 'ex-attempt')!.content as {
          questions: unknown[];
        }
      ).questions.length;
    expect(asked(first.scenes)).toBe(2);

    // The resumed run generates the solution slide again; it now stays wrong on س11.
    exerciseLine = 'الإجابة (س11): 24</p><p>الإجابة (س12): 71.9';
    const resumed = await generateClassroom(
      { ...baseInput, guideAnswerGuard: guard(plans) } as never,
      {
        baseUrl: '',
        persistence: sink(),
        correction: {
          resumeOutlines: {
            outlines: persisted.outlines as never,
            courseTitle: null,
            languageDirective: 'Arabic.',
          },
          resumeScenes: {
            stageId: first.id,
            stage: first.stage,
            scenes: first.scenes,
            regenerateOutlineIds: ['ex'],
            sourceServingMapping: {},
            sourceManifest: [],
          },
        },
      },
    );
    expect(resumed.scenes.map((scene) => scene.outlineId)).toEqual(['open', 'ex-attempt', 'ex']);
    expect(asked(resumed.scenes)).toBe(1);
  });

  it('lesson 1-1: a final line under another exercise leaves the slide and its narration, never pausing', async () => {
    const EX1: KeyedGuideItem = {
      contentUnitId: '6247',
      label: '1',
      element: 'exercise',
      number: 1,
      letter: null,
      display: 'س1',
      answer: { type: 'number', value: 11.25 },
    };
    const EX5: KeyedGuideItem = {
      ...EX1,
      label: '5',
      number: 5,
      display: 'س5',
      answer: { type: 'number', value: 24 },
    };
    const plans: Record<string, GuideOutlinePlan> = {
      ex: { role: 'solution', items: [EX1, EX5], solves: 2 },
    };
    // The run injects the keys before the scenes (`injectGuideAnswers`).
    const lesson = injectGuideAnswers(
      [
        slideOutline('open', 1, 'Opening'),
        { ...slideOutline('ex', 2, 'Exercise'), contentRole: 'worked_example' as const },
      ],
      new Map(Object.entries(plans)),
    );
    expect(lesson[1]!.description).toContain('الإجابة (س5): 24');
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Arabic.', outlines: lesson },
    });
    let exerciseSlides = 0;
    const narrationPrompts: string[] = [];
    mocks.callLLM.mockImplementation(
      async (request: { messages: Array<{ role: string; content: string }> }) => {
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
        if (/Action Generator/.test(system)) {
          if (user.includes('Title: Exercise')) narrationPrompts.push(user);
          return { text: ACTIONS };
        }
        if (user.includes('Exercise')) {
          exerciseSlides += 1;
          // Item 208 scene 26: question 2 solved under the planned label, then 5's line.
          return {
            text: slideContent(
              'تمرين 1 (س1 في كتابك): 9.00 + 2.25 = 11.25</p><p>الإجابة (س1): 11.25</p>' +
                '<p>تمرين 2 (س2 في كتابك): 11:45 + 45 دقيقة = 12:30 مساءً</p><p>الإجابة (س5): 24',
            ),
          };
        }
        return { text: slideContent('Body') };
      },
    );
    const result = await run({ ...baseInput, guideAnswerGuard: guard(plans) });
    // Generated once: no regeneration, no pause.
    expect(exerciseSlides).toBe(1);
    expect(result.scenes.map((scene) => scene.outlineId)).toEqual(['open', 'ex']);
    const slide = canvasText(result.scenes.find((scene) => scene.outlineId === 'ex')!);
    expect(slide).toContain('الإجابة (س1): 11.25');
    expect(slide).toContain('12:30 مساءً');
    expect(slide).not.toContain('(س5)');
    // The narration writer never reads 5's answer, nor does the persisted plan hold it.
    expect(narrationPrompts.length).toBeGreaterThan(0);
    for (const prompt of narrationPrompts) {
      expect(prompt).not.toContain('(س5)');
      expect(prompt).toContain('(س1)');
    }
    const persistedEx = (
      persisted.outlines as Array<{ id: string; description?: string; keyPoints?: string[] }>
    ).find((outline) => outline.id === 'ex')!;
    expect(persistedEx.description).not.toContain('(س5)');
    expect(persistedEx.keyPoints?.join('\n')).not.toContain('(س5)');
  });
});
