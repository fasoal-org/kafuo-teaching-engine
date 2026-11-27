import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';
import { bankQuizActions } from '@/lib/server/teaching-package/bank-quiz-scene';
import {
  resolveSpeechRegisterPolicy,
  validateSpeechRegister,
} from '@/lib/server/speech/register-policy';
import { validateAppScene } from '@/lib/document-store/validators';

/**
 * W6 one question source (contract item 4): on a run with `bankCheckQuizzes`,
 * the quiz at `outcome_check_understanding` is a deterministic bank
 * placeholder — no quiz-content call, no quiz-narration call, never marked for
 * review. Without the flag (generic generation) the quiz is generated as before.
 * Same real path as the governed-failures test; only the LLM boundary is stubbed.
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

const STAGE_ID = 'stage-w6';

const sink = (): ClassroomPersistenceSink => ({
  reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
  persist: async ({ id, stage, scenes }) => ({
    id,
    url: '',
    stage,
    scenes,
    createdAt: '2026-11-01T00:00:00.000Z',
  }),
  release: async () => {},
});

const flow = [
  { stage: 'lesson_introduction', instructions: 'Open the lesson.' },
  { stage: 'outcome_check_understanding', instructions: 'Check the objective.' },
];

const outlines = [
  {
    id: 'w6o1',
    type: 'slide' as const,
    slideType: 'content' as const,
    contentRole: 'example' as const,
    title: 'Opening',
    description: 'Introduce the topic.',
    keyPoints: ['Anchor'],
    order: 1,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: { classification: 'instructional' as const },
  },
  {
    id: 'w6o2',
    type: 'quiz' as const,
    title: 'Check',
    description: 'Check the objective.',
    keyPoints: ['Recap'],
    order: 2,
    teachingStage: { key: 'outcome_check_understanding', flowIndex: 1 },
    teachingSkills: { classification: 'non-instructional' as const },
    quizConfig: {
      questionCount: 2,
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
    teachingModel: { key: 'g5', version: 'g5.v6' },
    flow,
  },
};

const SLIDE_CONTENT = JSON.stringify({
  elements: [{ type: 'text', content: 'Body', left: 100, top: 100, width: 600, height: 60 }],
  remark: '',
});
const ACTIONS = JSON.stringify([{ type: 'text', content: 'Canonical narration.' }]);

function routeModel() {
  const systems: string[] = [];
  mocks.callLLM.mockImplementation(
    async (request: { messages: Array<{ role: string; content: string }> }) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      systems.push(system);
      if (/Action Generator/.test(system)) return { text: ACTIONS };
      if (/^# Quiz Content Generator/m.test(system)) {
        return {
          text: JSON.stringify([
            {
              id: 'q1',
              type: 'single',
              question: 'Pick one',
              options: [
                { value: 'A', label: 'One' },
                { value: 'B', label: 'Two' },
              ],
              answer: ['A'],
            },
          ]),
        };
      }
      return { text: SLIDE_CONTENT };
    },
  );
  return {
    quizContentCalls: () => systems.filter((s) => /^# Quiz Content Generator/m.test(s)).length,
    quizActionCalls: () => systems.filter((s) => /^# Quiz Action Generator/m.test(s)).length,
  };
}

async function run(input: unknown) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(input as never, { baseUrl: '', persistence: sink() });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
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
    data: { languageDirective: 'English.', outlines },
  });
});

describe('generateClassroom — W6 bank check quiz', () => {
  it('keeps the check quiz as a bank placeholder with no quiz model call', async () => {
    const routed = routeModel();

    const result = await run({ ...baseInput, bankCheckQuizzes: true });

    expect(result.scenes).toHaveLength(2);
    const quiz = result.scenes.find((scene) => scene.type === 'quiz')!;
    expect(quiz.content).toEqual({ type: 'quiz', questions: [] });
    expect(quiz.questionSource).toBe('bank');
    expect(quiz.teachingStage).toEqual({ key: 'outcome_check_understanding', flowIndex: 1 });
    // Not a governed failure, not "needing review".
    expect(quiz.generationIssues ?? []).toEqual([]);
    expect(quiz.actions).toHaveLength(1);
    expect(quiz.actions?.[0]).toMatchObject({ type: 'speech' });
    expect(routed.quizContentCalls()).toBe(0);
    expect(routed.quizActionCalls()).toBe(0);
    // The marker passes the document write boundary.
    expect(validateAppScene(quiz)).toEqual({ valid: true });
    // The slide is untouched by the flag.
    expect(result.scenes.find((scene) => scene.type === 'slide')?.questionSource).toBeUndefined();
  });

  it('narrates the placeholder in Arabic for an Arabic lesson', async () => {
    routeModel();

    const result = await run({ ...baseInput, bankCheckQuizzes: true, language: 'ar-SA' });

    const quiz = result.scenes.find((scene) => scene.type === 'quiz')!;
    const speech = quiz.actions?.[0] as { text: string };
    expect(speech.text).toMatch(/[؀-ۿ]/);
    expect(quiz.questionSource).toBe('bank');
  });

  it('without the flag (generic generation) the quiz is generated as before', async () => {
    const routed = routeModel();

    const result = await run(baseInput);

    const quiz = result.scenes.find((scene) => scene.type === 'quiz')!;
    expect(quiz.questionSource).toBeUndefined();
    expect(routed.quizContentCalls()).toBe(1);
    expect(routed.quizActionCalls()).toBe(1);
  });
});

describe('generateClassroom — g5.v12 check quiz keys (QZ-2, Q-AK)', () => {
  // The approved answer of the one book item the check quiz cites: the text «One».
  const REFERENCE = {
    tag: 'ITEM_1',
    item: {
      contentUnitId: 'u2',
      label: '1',
      element: 'try_it' as const,
      number: 1,
      letter: null,
      display: '1',
      answer: { type: 'text' as const, value: 'One' },
    },
    question: 'Which one?',
  };
  const keyed = (keys: string[]) => {
    const systems: string[] = [];
    const users: string[] = [];
    let quizCalls = 0;
    mocks.callLLM.mockImplementation(
      async (request: { messages: Array<{ role: string; content: string }> }) => {
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        systems.push(system);
        if (/Action Generator/.test(system)) return { text: ACTIONS };
        if (/^# Quiz Content Generator/m.test(system)) {
          users.push(request.messages.find((m) => m.role === 'user')?.content ?? '');
          const key = keys[Math.min(quizCalls, keys.length - 1)]!;
          quizCalls += 1;
          return {
            text: JSON.stringify([
              {
                id: 'q1',
                type: 'single',
                question: 'Pick one',
                reference: 'ITEM_1',
                options: [
                  { value: 'A', label: 'One' },
                  { value: 'B', label: 'Two' },
                ],
                answer: [key],
              },
            ]),
          };
        }
        return { text: SLIDE_CONTENT };
      },
    );
    return { quizCalls: () => quizCalls, users };
  };
  const gated = (references: unknown[]) => ({
    referencesOf: (outline: { type: string }) => (outline.type === 'quiz' ? references : null),
  });

  // Decision A-32: an unverifiable check quiz is DROPPED as a Scene, its plan entry marked.
  const droppedPlan = (result: { outlines: Array<{ id: string; checkQuizDropped?: unknown }> }) =>
    result.outlines.find((outline) => outline.id === 'w6o2')?.checkQuizDropped;

  it('A-32: no reference — the check quiz is never generated and is dropped, its plan entry marked', async () => {
    const routed = keyed(['A']);

    const result = await run({ ...baseInput, checkQuizKeys: gated([]) });

    expect(routed.quizCalls()).toBe(0);
    // No quiz Scene, so no key at all reaches the Stage (or the bank); the slide stays.
    expect(result.scenes.some((scene) => scene.type === 'quiz')).toBe(false);
    expect(result.scenes.some((scene) => scene.type === 'slide')).toBe(true);
    expect(droppedPlan(result)).toEqual({
      reason: 'unverified_answer_key',
      sceneId: expect.any(String),
    });
    for (const scene of result.scenes) expect(scene.generationIssues ?? []).toEqual([]);
  });

  it('a verified key is kept, its tag stripped, in one call that names the approved answer', async () => {
    const routed = keyed(['A']);

    const result = await run({ ...baseInput, checkQuizKeys: gated([REFERENCE]) });

    const quiz = result.scenes.find((scene) => scene.type === 'quiz')!;
    expect(routed.quizCalls()).toBe(1);
    expect(routed.users[0]).toContain('ANSWER KEYS ARE CHECKED BY CODE');
    expect(routed.users[0]).toContain('Approved answer: One');
    const questions = (quiz.content as unknown as { questions: Array<Record<string, unknown>> })
      .questions;
    expect(questions).toHaveLength(1);
    expect(questions[0]!.answer).toEqual(['A']);
    expect(questions[0]).not.toHaveProperty('reference');
    expect(quiz.generationIssues ?? []).toEqual([]);
  });

  it('a wrong key (the fixture) is regenerated once with the correction; a right second key is kept', async () => {
    const routed = keyed(['B', 'A']);

    const result = await run({ ...baseInput, checkQuizKeys: gated([REFERENCE]) });

    const quiz = result.scenes.find((scene) => scene.type === 'quiz')!;
    expect(routed.quizCalls()).toBe(2);
    expect(routed.users[1]).toContain('could not be verified');
    expect((quiz.content as { questions: unknown[] }).questions).toHaveLength(1);
    expect(quiz.generationIssues ?? []).toEqual([]);
  });

  it('A-32: a key still wrong after the one regeneration drops the quiz as a Scene, never saved', async () => {
    const routed = keyed(['B', 'B']);

    const result = await run({ ...baseInput, checkQuizKeys: gated([REFERENCE]) });

    expect(routed.quizCalls()).toBe(2);
    expect(result.scenes.some((scene) => scene.type === 'quiz')).toBe(false);
    expect(droppedPlan(result)).toMatchObject({ reason: 'unverified_answer_key' });
  });

  // Fresh review finding 5: a `scenes` resume of a run that dropped the quiz.
  const resumeDropped = async (regenerateOutlineIds: string[]) => {
    keyed(['B', 'B']);
    const first = await run({ ...baseInput, checkQuizKeys: gated([REFERENCE]) });
    expect(droppedPlan(first)).toMatchObject({ reason: 'unverified_answer_key' });
    const routed = keyed(['A']);
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    const resumed = await generateClassroom(
      { ...baseInput, checkQuizKeys: gated([REFERENCE]) } as never,
      {
        baseUrl: '',
        persistence: sink(),
        correction: {
          resumeOutlines: {
            outlines: first.outlines as never,
            courseTitle: null,
            languageDirective: 'English.',
          },
          resumeScenes: {
            stageId: first.id,
            stage: first.stage,
            scenes: first.scenes,
            regenerateOutlineIds,
            sourceServingMapping: {},
            sourceManifest: [],
          },
        },
      },
    );
    return { routed, resumed };
  };

  it('A-32: a scenes resume keeps the dropped quiz dropped and never pays for it again', async () => {
    const { routed, resumed } = await resumeDropped([]);

    expect(routed.quizCalls()).toBe(0);
    expect(resumed.scenes.some((scene) => scene.type === 'quiz')).toBe(false);
    expect(droppedPlan(resumed)).toMatchObject({ reason: 'unverified_answer_key' });
  });

  it('A-32: a resume that lists the dropped quiz again generates it, and a verified key clears the mark', async () => {
    const { routed, resumed } = await resumeDropped(['w6o2']);

    expect(routed.quizCalls()).toBe(1);
    expect(resumed.scenes.some((scene) => scene.type === 'quiz')).toBe(true);
    expect(droppedPlan(resumed)).toBeUndefined();
  });

  it('without checkQuizKeys (every model before g5.v12) the quiz is generated exactly as before', async () => {
    const routed = keyed(['B']);

    const result = await run(baseInput);

    const quiz = result.scenes.find((scene) => scene.type === 'quiz')!;
    expect(routed.quizCalls()).toBe(1);
    expect(routed.users[0]).not.toContain('ANSWER KEYS ARE CHECKED BY CODE');
    expect(
      (quiz.content as { questions: Array<{ answer: unknown }> }).questions[0]!.answer,
    ).toEqual(['B']);
  });
});

describe('bank placeholder narration', () => {
  it('is Arabic for ar lessons, English otherwise', () => {
    expect((bankQuizActions('ar')[0] as { text: string }).text).toMatch(/[؀-ۿ]/);
    expect((bankQuizActions('en-US')[0] as { text: string }).text).toMatch(/^Let's check/);
    expect((bankQuizActions(undefined)[0] as { text: string }).text).toMatch(/^Let's check/);
  });

  it.each(['MATH', 'SCIENCE', 'CHEMISTRY', 'ARABIC'])(
    'passes the Arabic spoken-register policy for %s',
    (subjectCode) => {
      const policy = resolveSpeechRegisterPolicy({ language: 'ar-SA', subjectCode });
      expect(policy).not.toBeNull();
      const texts = bankQuizActions('ar-SA', subjectCode).map((action) => action.text);
      expect(validateSpeechRegister(texts, policy!)).toEqual([]);
    },
  );
});
