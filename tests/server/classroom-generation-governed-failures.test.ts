import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';

/**
 * Module 3/4 W2 integration (TAE-RQ-017/004/013, plan §7.2): a governed run
 * cannot bind a Stage containing a fallback Action sequence or a missing
 * Scene, and those failures carry their own codes rather than a flow
 * mismatch. Non-governed runs keep today's behavior exactly — skipped
 * content-failed Scenes and accepted default Actions.
 *
 * Real path: outline LLM stub → REAL generateSceneContent → REAL
 * generateSceneActions (real prompt assembly, real parse, real fallback
 * observation) → REAL createSceneWithActions + api.scene.create. The only
 * seams stubbed are the LLM boundary and the retry DELAYS (the real
 * withGenerationRetry runs with baseDelayMs/maxDelayMs forced to 1ms —
 * attempt counting, shouldRetryResult, and exhaustion semantics are the
 * production ones; only the wall-clock backoff is compressed).
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
    // Delay-compressing wrapper around the REAL retry loop.
    withGenerationRetry: <T>(
      operation: (attempt: number) => Promise<T>,
      options: Parameters<typeof original.withGenerationRetry>[1],
    ) => original.withGenerationRetry(operation, { ...options, baseDelayMs: 1, maxDelayMs: 1 }),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const STAGE_ID = 'stage-w2';

const sink = (): ClassroomPersistenceSink => ({
  reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
  persist: async ({ id, stage, scenes }) => ({
    id,
    url: '',
    stage,
    scenes,
    createdAt: '2026-09-18T00:00:00.000Z',
  }),
  release: async () => {},
});

const governedFlow = [
  { stage: 'lesson_introduction', instructions: 'Open the lesson.' },
  { stage: 'outcome_teaching_cards', instructions: 'Consolidate the outcome.' },
];

const outlines = [
  {
    id: 'w2o1',
    type: 'slide' as const,
    title: 'Opening',
    description: 'Introduce the topic.',
    keyPoints: ['Anchor'],
    order: 1,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: { classification: 'instructional' as const },
  },
  {
    id: 'w2o2',
    type: 'slide' as const,
    title: 'Cards',
    description: 'Consolidate.',
    keyPoints: ['Recap'],
    order: 2,
    teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
    teachingSkills: { classification: 'non-instructional' as const },
  },
];

const governedInput = {
  requirement: 'Governed run',
  pdfContent: { text: 'pdf body', images: [] },
  teachingFlow: governedFlow,
  governed: {
    contract: 'kafuo.teaching-skills.v1',
    teachingModel: { key: 'g5', version: 'g5.v1' },
    flow: governedFlow,
  },
};

const ACTIONS_PROMPT = /^# (Slide|Quiz|Interactive|PBL).*Action Generator/m;
const CONTENT_OK = (scene: number) =>
  JSON.stringify({
    elements: [
      {
        type: 'text',
        content: `Scene ${scene} final body`,
        left: 100,
        top: 100,
        width: 600,
        height: 60,
      },
    ],
    remark: '',
  });
const CONTENT_UNPARSEABLE = JSON.stringify({ noElementsHere: true });
const ACTIONS_UNPARSEABLE = 'not a json array at all';
const ACTIONS_CANONICAL = JSON.stringify([{ type: 'text', content: 'Canonical narration.' }]);

interface Routed {
  actionsCalls: () => number;
  contentCalls: () => number;
}

/**
 * Route the stubbed model per call kind. `actions` is a per-attempt script
 * (last entry repeats); each entry is the reply text or null for "keep the
 * default garbage". `contentFailsOnScene` makes every content call FOR THAT
 * SCENE unparseable (the null path).
 */
function routeModel(script: { actions?: string[]; contentFailsOnScene?: number }): Routed {
  let actionsCalls = 0;
  let contentCalls = 0;
  mocks.callLLM.mockImplementation(
    async (request: { messages: Array<{ role: string; content: string }> }) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      if (ACTIONS_PROMPT.test(system)) {
        actionsCalls += 1;
        const replies = script.actions ?? [ACTIONS_CANONICAL];
        return { text: replies[Math.min(actionsCalls - 1, replies.length - 1)]! };
      }
      contentCalls += 1;
      const scene = contentCalls; // one content call per scene while succeeding
      const failScene = script.contentFailsOnScene;
      return { text: failScene && scene >= failScene ? CONTENT_UNPARSEABLE : CONTENT_OK(scene) };
    },
  );
  return {
    actionsCalls: () => actionsCalls,
    contentCalls: () => contentCalls,
  };
}

async function runGoverned(input: unknown) {
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

describe('generateClassroom — W2 governed failure policy', () => {
  it('an always-unparseable action model refuses with GOVERNED_ACTION_GENERATION_FAILED after bounded retries', async () => {
    const routed = routeModel({ actions: [ACTIONS_UNPARSEABLE] });

    await expect(runGoverned(governedInput)).rejects.toMatchObject({
      code: 'GOVERNED_ACTION_GENERATION_FAILED',
      status: 422,
    });
    // Bounded retries really happened: the default budget is 5 retries + 1.
    expect(routed.actionsCalls()).toBe(6);
  });

  it('an action model that fails once then succeeds gets exactly one retry and the package binds', async () => {
    const routed = routeModel({ actions: [ACTIONS_UNPARSEABLE, ACTIONS_CANONICAL] });

    const result = await runGoverned(governedInput);

    // Scene 1: fallback → one retry → canonical (2 calls); scene 2: first-try
    // canonical (1 call). EXACTLY one retry for the failing scene.
    expect(routed.actionsCalls()).toBe(3);
    expect(result.scenes).toHaveLength(2);
    // The bound Actions are the parsed canonical sequence, not the defaults.
    for (const scene of result.scenes) {
      expect(scene.actions).toEqual([expect.objectContaining({ type: 'speech' })]);
      expect((scene.actions![0] as { text?: string }).text).toBe('Canonical narration.');
    }
  });

  it("a governed Scene's failed content refuses with GOVERNED_SCENE_GENERATION_FAILED — NOT a flow mismatch", async () => {
    routeModel({ contentFailsOnScene: 2 });

    // The defect this guards: the skipped Scene used to surface later as a
    // retryable TEACHING_MODEL_FLOW_MISMATCH — a content failure misattributed
    // to the flow. Assert the code exactly.
    const rejection = await runGoverned(governedInput).then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: unknown) => error as { code?: string; status?: number },
    );
    expect(rejection.code).toBe('GOVERNED_SCENE_GENERATION_FAILED');
    expect(rejection.status).toBe(422);
  });
});

describe('generateClassroom — W2 non-governed behavior is unchanged', () => {
  it('still skips a content-failed Scene and still accepts default Actions', async () => {
    const routed = routeModel({
      actions: [ACTIONS_UNPARSEABLE],
      contentFailsOnScene: 2,
    });

    const result = await runGoverned({
      requirement: 'Non-governed run',
      pdfContent: { text: 'pdf body', images: [] },
      teachingFlow: governedFlow,
    });

    // Scene 2 was skipped (content failed), scene 1 survived.
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.title).toBe('Opening');
    // Scene 1's unparseable action model still yielded the default sequence
    // (spotlight 聚焦重点 + speech 场景讲解) on the FIRST attempt —
    // non-governed runs have no shouldRetryResult, so the first result wins
    // exactly as before W2.
    expect(routed.actionsCalls()).toBe(1);
    const actions = result.scenes[0]!.actions as Array<{ type: string; title?: string }>;
    expect(actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'speech', title: '场景讲解' })]),
    );
  });
});
