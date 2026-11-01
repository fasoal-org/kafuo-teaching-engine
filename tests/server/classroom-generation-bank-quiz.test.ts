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
