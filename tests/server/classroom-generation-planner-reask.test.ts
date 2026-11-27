// Critical items before package regeneration (27 Nov 2026), EN-4: a g5.v12 planner is
// asked ONCE more with the violations no deterministic fix repairs (`reaskPlan`, decided
// by the runner before the first plan costs an image re-plan or a review). It is the same
// run: `MAX_GENERATION_RUNS` is not touched, a second bad answer falls back to today's
// handling, and a run without the hook — every Teaching Model before g5.v12 — is unchanged
// (pinned by classroom-generation-outline-reroll.test.ts, which has no hook).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GenerationCorrectionOptions,
  GovernedGenerationContext,
} from '@/lib/server/classroom-generation';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  reserveClassroom: vi.fn(),
  releaseClassroomReservation: vi.fn(),
  persistClassroom: vi.fn(),
  generateClassroomId: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
}));
vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));
vi.mock('@/lib/server/classroom-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-storage')>()),
  reserveClassroom: mocks.reserveClassroom,
  releaseClassroomReservation: mocks.releaseClassroomReservation,
  persistClassroom: mocks.persistClassroom,
  generateClassroomId: mocks.generateClassroomId,
}));
vi.mock('@/lib/server/classroom-media-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-media-generation')>()),
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Sink Basics',
  description: 'Explain sinks',
  keyPoints: ['Sinks are injectable'],
  order: 1,
  slideType: 'content',
  contentRole: 'explanation',
  contentKind: 'concept',
  teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
} as const;

const GOVERNED_CONTEXT: GovernedGenerationContext = {
  contract: 'kafuo.teaching-skills.v1',
  teachingModel: { key: 'g5', version: 'g5.v12' },
  flow: [
    {
      stage: 'lesson_introduction',
      instructions: 'Introduce.',
      skillPolicy: {
        required: [],
        preferred: [{ skillId: 'feynman-learning', version: 'v1' }],
        allowed: [{ skillId: 'feynman-learning', version: 'v1' }],
        combinationRestrictions: [],
      },
    },
  ],
};

const PAUSE_ISSUE = {
  code: 'TEST_NEEDS_A_PERSON',
  disposition: 'admin_correctable' as const,
  outlineIndex: 0,
  message: 'needs a person',
};

/** What the runner hands back: a violation no deterministic fix repaired. */
const ORDER_VIOLATION = {
  code: 'SLIDE_OUT_OF_BOOK_ORDER',
  disposition: 'admin_correctable' as const,
  outlineIndex: 3,
  outlineId: 'outline-4',
  field: 'teachingStage',
  message:
    'outline #4 «Chemical properties» teaches unit 6771 (part 3), which belongs to the objective block at flow position 5: move it into that block',
};

const answer = (title: string, diagnostics: unknown[] = []) => ({
  success: true,
  data: {
    languageDirective: 'Use English.',
    outlines: [{ ...outline, title }],
    diagnostics,
  },
  answer: {
    parse: { extraction: 'exact', repair: 'none', reasoningPrefixStripped: false, exact: true },
    malformed: [],
  },
});

type OutlineCallOptions = Record<string, unknown> & {
  correctiveContext?: string;
  logger?: unknown;
};
type OutlineCallArgs = [
  unknown,
  unknown,
  unknown,
  (s: string, u: string) => Promise<string>,
  OutlineCallOptions,
];

async function generateWith(correction: GenerationCorrectionOptions) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: 'Teach sink basics', governed: GOVERNED_CONTEXT },
    { baseUrl: 'http://localhost', correction },
  );
}

/** Each mocked outline call reads the model's text first, as the real generator does. */
function outlineAnswers(...results: unknown[]) {
  let index = 0;
  mocks.generateSceneOutlinesFromRequirements.mockImplementation(
    async (...args: OutlineCallArgs) => {
      await args[3]('system', 'user');
      return results[Math.min(index++, results.length - 1)];
    },
  );
}

const outlineCalls = () =>
  mocks.generateSceneOutlinesFromRequirements.mock.calls as OutlineCallArgs[];

describe('generateClassroom: one bounded re-ask of the planner (g5.v12, EN-4)', () => {
  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'model text' });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneContent.mockResolvedValue({ elements: [], remark: 'r' });
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, stage, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      stage,
      scenes,
      createdAt: '2026-11-02T00:00:00.000Z',
    }));
    mocks.reserveClassroom.mockResolvedValue(undefined);
    mocks.releaseClassroomReservation.mockResolvedValue(undefined);
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.replaceMediaPlaceholders.mockImplementation(() => undefined);
    mocks.generateTTSForClassroom.mockResolvedValue(undefined);
    mocks.generateClassroomId.mockReturnValue('stagereask1');
  });

  it('asks the planner once more, on the same call, with each violation in the prompt', async () => {
    outlineAnswers(answer('first plan'), answer('second plan'));
    const reaskPlan = vi.fn((_outlines: unknown) => [ORDER_VIOLATION]);

    await generateWith({ reaskPlan, collectOutlineIssues: () => [] });

    // The hook sees the first answer's plan, before anything else is spent on it.
    expect(reaskPlan).toHaveBeenCalledTimes(1);
    expect(reaskPlan.mock.calls[0]![0]).toEqual([expect.objectContaining({ title: 'first plan' })]);
    const calls = outlineCalls();
    expect(calls).toHaveLength(2);
    // The first call is the plain prompt; the second carries the violations.
    expect(calls[0]![4].correctiveContext).toBeUndefined();
    expect(calls[1]![4].correctiveContext).toBe(
      // (The formatter prefixes each finding with its slide's zero-based position.)
      `OUTLINE_CORRECTION_REQUIRED: 1 issue(s): #3 ${ORDER_VIOLATION.message}`,
    );
    // Nothing else in the prompt options changed between the two calls.
    const { correctiveContext: _first, ...firstRest } = calls[0]![4];
    const { correctiveContext: _second, ...secondRest } = calls[1]![4];
    expect(secondRest).toEqual(firstRest);
    // Both calls reached the model, once each.
    const outlineModelCalls = (mocks.callLLM.mock.calls as unknown[][]).filter(
      (call) =>
        (call[0] as { messages?: Array<{ content?: string }> } | undefined)?.messages?.[1]
          ?.content === 'user',
    );
    expect(outlineModelCalls).toHaveLength(2);
  });

  it('the second plan is the one the run goes on with', async () => {
    outlineAnswers(answer('first plan'), answer('second plan'));

    const result = await generateWith({ reaskPlan: () => [ORDER_VIOLATION] });

    expect(result.outlines.map((entry: { title: string }) => entry.title)).toEqual(['second plan']);
  });

  it('a second answer that still fails is never asked a third time: it fails closed (the pause)', async () => {
    outlineAnswers(answer('first plan'), answer('second plan'));
    const reaskPlan = vi.fn(() => [ORDER_VIOLATION]);

    await expect(
      generateWith({ reaskPlan, collectOutlineIssues: () => [PAUSE_ISSUE] }),
    ).rejects.toMatchObject({
      code: 'GENERATION_CORRECTION_REQUIRED',
      candidate: { phase: 'outline', diagnostics: [PAUSE_ISSUE] },
    });

    expect(outlineCalls()).toHaveLength(2);
    expect(reaskPlan).toHaveBeenCalledTimes(1);
  });

  it('a second answer that yields no plan gives the first one back: the run goes on, the gates decide', async () => {
    outlineAnswers(answer('first plan'), {
      success: false,
      error: 'OUTLINE_TEACHING_FLOW_INVALID: no outlines were returned',
    });

    const result = await generateWith({ reaskPlan: () => [ORDER_VIOLATION] });

    expect(outlineCalls()).toHaveLength(2);
    // Not a failed run: the first plan is what the gates, the repairs and, if need be,
    // the pause see.
    expect(result.outlines.map((entry: { title: string }) => entry.title)).toEqual(['first plan']);
  });

  it('nothing to re-ask: the first answer stands, with one outline call', async () => {
    outlineAnswers(answer('first plan'), answer('second plan'));

    const result = await generateWith({ reaskPlan: () => null });

    expect(outlineCalls()).toHaveLength(1);
    expect(result.outlines.map((entry: { title: string }) => entry.title)).toEqual(['first plan']);
  });

  it('a hook that throws changes nothing: the first answer stands', async () => {
    outlineAnswers(answer('first plan'), answer('second plan'));

    const result = await generateWith({
      reaskPlan: () => {
        throw new Error('diagnosis down');
      },
    });

    expect(outlineCalls()).toHaveLength(1);
    expect(result.outlines.map((entry: { title: string }) => entry.title)).toEqual(['first plan']);
  });

  it('without the hook a run makes exactly one outline call (every model before g5.v12)', async () => {
    outlineAnswers(answer('first plan'), answer('second plan'));

    await generateWith({ collectOutlineIssues: () => [] });

    expect(outlineCalls()).toHaveLength(1);
    expect(outlineCalls()[0]![4].correctiveContext).toBeUndefined();
  });
});
