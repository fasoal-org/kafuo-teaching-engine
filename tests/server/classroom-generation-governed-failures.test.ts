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
    id: 'w2o2',
    type: 'slide' as const,
    slideType: 'content' as const,
    contentRole: 'example' as const,
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
  // 3 Oct 2026: a slide can be regenerated by the reviewer, so a governed slide
  // problem no longer fails the package — the slide is kept and marked.
  const issueCodes = (scene: { generationIssues?: Array<{ code: string }> }) =>
    (scene.generationIssues ?? []).map((issue) => issue.code);

  it('an always-unparseable action model keeps every slide, marked, after the single governed attempt', async () => {
    const routed = routeModel({ actions: [ACTIONS_UNPARSEABLE] });

    const result = await runGoverned(governedInput);

    expect(result.scenes).toHaveLength(outlines.length);
    for (const scene of result.scenes) {
      expect(issueCodes(scene)).toEqual(['GOVERNED_ACTION_GENERATION_FAILED']);
    }
    // Still single-shot: one action call per scene, never a re-roll.
    expect(routed.actionsCalls()).toBe(outlines.length);
  });

  it('does not spend a second governed action call after a failed first result', async () => {
    const routed = routeModel({ actions: [ACTIONS_UNPARSEABLE, ACTIONS_CANONICAL] });

    const result = await runGoverned(governedInput);

    expect(issueCodes(result.scenes[0]!)).toEqual(['GOVERNED_ACTION_GENERATION_FAILED']);
    expect(issueCodes(result.scenes[1]!)).toEqual([]);
    expect(routed.actionsCalls()).toBe(outlines.length);
  });

  it('a governed slide whose content fails is kept as a marked placeholder — never a flow mismatch', async () => {
    const routed = routeModel({ contentFailsOnScene: 2 });

    const result = await runGoverned(governedInput);

    // The flow position is kept (no TEACHING_MODEL_FLOW_MISMATCH), filled with
    // the outline's own title, and marked for the reviewer to regenerate.
    expect(result.scenes).toHaveLength(outlines.length);
    const placeholder = result.scenes[1]!;
    expect(issueCodes(placeholder)).toEqual(['GOVERNED_SCENE_GENERATION_FAILED']);
    expect(placeholder.outlineId).toBe('w2o2');
    expect(JSON.stringify(placeholder.content)).toContain('Cards');
    expect(issueCodes(result.scenes[0]!)).toEqual([]);
    // Scene 1 once, then scene 2 + its single unparseable-output re-ask.
    expect(routed.contentCalls()).toBe(3);
  });

  it('a governed quiz whose content fails is kept as a marked placeholder quiz', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          outlines[0]!,
          {
            id: 'w2q2',
            type: 'quiz' as const,
            title: 'Check',
            description: 'Check the outcome.',
            keyPoints: ['Recap'],
            order: 2,
            quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
            teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
            teachingSkills: { classification: 'non-instructional' as const },
          },
        ],
      },
    });
    routeModel({ contentFailsOnScene: 2 });

    const result = await runGoverned(governedInput);

    expect(result.scenes).toHaveLength(2);
    const quiz = result.scenes[1]!;
    expect(quiz.type).toBe('quiz');
    expect(issueCodes(quiz)).toEqual(['GOVERNED_SCENE_GENERATION_FAILED']);
    expect(quiz.content.type === 'quiz' && quiz.content.questions.length).toBe(1);
  });

  it('re-asks an unparseable Scene answer exactly once, with a correction, and keeps the package', async () => {
    let contentCalls = 0;
    const contentPrompts: string[] = [];
    mocks.callLLM.mockImplementation(
      async (request: { messages: Array<{ role: string; content: unknown }> }) => {
        const system = String(request.messages.find((m) => m.role === 'system')?.content ?? '');
        if (ACTIONS_PROMPT.test(system)) return { text: ACTIONS_CANONICAL };
        contentCalls += 1;
        const user = request.messages.find((m) => m.role === 'user')?.content;
        contentPrompts.push(typeof user === 'string' ? user : JSON.stringify(user));
        // The FIRST answer for scene 1 is unusable; everything after is valid.
        return { text: contentCalls === 1 ? CONTENT_UNPARSEABLE : CONTENT_OK(contentCalls) };
      },
    );

    const result = await runGoverned(governedInput);

    expect(result.scenes).toHaveLength(outlines.length);
    expect(contentCalls).toBe(outlines.length + 1);
    expect(contentPrompts[0]).not.toContain('Correction Required');
    expect(contentPrompts[1]).toContain('Correction Required');
    expect(contentPrompts[1]).toContain('not a valid JSON object with an "elements" array');
    // Only the re-asked scene carries the correction.
    expect(contentPrompts.slice(2).some((prompt) => prompt.includes('Correction Required'))).toBe(
      false,
    );
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
