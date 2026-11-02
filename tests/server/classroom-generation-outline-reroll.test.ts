// Lesson 306 (2 Nov 2026): a broken outline answer is re-rolled ONCE per run
// (F-3) on a run that can pause for a person, its capped raw copy is handed to
// the run's diagnosis store (F-1), and a second broken answer falls back to
// today's handling (the pause) with no further model call.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GenerateClassroomInput,
  GenerationCorrectionOptions,
  GovernedGenerationContext,
} from '@/lib/server/classroom-generation';
import type { OutlineAnswerCapture } from '@/lib/types/teaching-package';

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

/** The real 306 answer shape (a nested answer object plus one slide), trimmed. */
const fixture306 = JSON.parse(
  readFileSync(
    new URL(
      '../../packages/@openmaic/generation/test/fixtures/outline-306-nested-answer.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { parsed: unknown[] };
const RAW_306 = JSON.stringify(fixture306.parsed);

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Sink Basics',
  description: 'Explain sinks',
  keyPoints: ['Sinks are injectable'],
  order: 1,
  teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
} as const;

const GOVERNED_CONTEXT: GovernedGenerationContext = {
  contract: 'kafuo.teaching-skills.v1',
  teachingModel: { key: 'g5', version: 'g5.v1' },
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

const BAD_ANSWER = {
  success: false,
  error: 'OUTLINE_ANSWER_MALFORMED: entry #1 is a nested answer object',
  answer: {
    parse: { extraction: 'exact', repair: 'none', reasoningPrefixStripped: false, exact: true },
    malformed: [
      'entry #1 is a nested answer object (has outlines, languageDirective), not a scene',
    ],
  },
  badAnswer: {
    code: 'OUTLINE_ANSWER_MALFORMED',
    reasons: ['entry #1 is a nested answer object (has outlines, languageDirective), not a scene'],
  },
};
const GOOD_ANSWER = {
  success: true,
  data: { languageDirective: 'Use English.', outlines: [outline], diagnostics: [] },
  answer: {
    parse: { extraction: 'exact', repair: 'none', reasoningPrefixStripped: false, exact: true },
    malformed: [],
  },
};

type OutlineCallOptions = Record<string, unknown> & {
  rejectMalformedAnswer?: boolean;
  requiredSourceUnitIds?: string[];
  logger?: unknown;
};
type OutlineCallArgs = [
  unknown,
  unknown,
  unknown,
  (s: string, u: string) => Promise<string>,
  OutlineCallOptions,
];

async function generateWith(options: {
  input?: Partial<GenerateClassroomInput>;
  correction?: GenerationCorrectionOptions;
}) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: 'Teach sink basics', ...options.input },
    {
      baseUrl: 'http://localhost',
      ...(options.correction ? { correction: options.correction } : {}),
    },
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

describe('generateClassroom: broken outline answer re-roll (lesson 306)', () => {
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
    mocks.generateClassroomId.mockReturnValue('stagereroll1');
  });

  it('re-rolls a broken answer once on the same outline call, then succeeds', async () => {
    outlineAnswers(BAD_ANSWER, GOOD_ANSWER);
    const captures: OutlineAnswerCapture[] = [];
    mocks.callLLM
      .mockResolvedValueOnce({ text: 'first broken answer' })
      .mockResolvedValue({ text: 'model text' });

    await generateWith({
      input: { governed: GOVERNED_CONTEXT },
      correction: { onOutlineAnswer: (capture) => void captures.push(capture) },
    });

    const calls = mocks.generateSceneOutlinesFromRequirements.mock.calls as OutlineCallArgs[];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[4]).toMatchObject({
        rejectMalformedAnswer: true,
        collectCorrectableIssues: true,
      });
      expect(call[4].logger).toBeDefined();
    }
    // Same prompt options both times: a repeat, not a corrective re-ask.
    expect(calls[1]![4]).toEqual(calls[0]![4]);
    // Both outline calls reached the model; the broken one was kept for diagnosis.
    const outlineModelCalls = mocks.callLLM.mock.calls.filter(
      (call) => call[0]?.messages?.[1]?.content === 'user',
    );
    expect(outlineModelCalls).toHaveLength(2);
    expect(captures).toEqual([
      expect.objectContaining({
        rawHead: 'first broken answer',
        rawTail: '',
        rawLength: 'first broken answer'.length,
        malformed: BAD_ANSWER.answer.malformed,
      }),
    ]);
  });

  it('two broken answers: no third model call, today’s handling of the last answer (the pause)', async () => {
    outlineAnswers(BAD_ANSWER, BAD_ANSWER, {
      ...GOOD_ANSWER,
      data: { ...GOOD_ANSWER.data, diagnostics: [PAUSE_ISSUE] },
    });
    mocks.callLLM
      .mockResolvedValueOnce({ text: 'broken one' })
      .mockResolvedValueOnce({ text: 'broken two' });
    const captures: OutlineAnswerCapture[] = [];

    await expect(
      generateWith({
        input: { governed: GOVERNED_CONTEXT },
        correction: { onOutlineAnswer: (capture) => void captures.push(capture) },
      }),
    ).rejects.toMatchObject({
      code: 'GENERATION_CORRECTION_REQUIRED',
      candidate: { phase: 'outline', diagnostics: [PAUSE_ISSUE] },
    });

    const calls = mocks.generateSceneOutlinesFromRequirements.mock.calls as OutlineCallArgs[];
    expect(calls).toHaveLength(3);
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    // The third read is the unchecked path on the SECOND answer's text.
    expect(calls[2]![4].rejectMalformedAnswer).toBeUndefined();
    await expect(calls[2]![3]('s', 'u')).resolves.toBe('broken two');
    expect(captures.map((capture) => capture.rawHead)).toEqual(['broken one', 'broken two']);
  });

  it('a diagnosis store failure never changes the run', async () => {
    outlineAnswers(BAD_ANSWER, GOOD_ANSWER);
    await expect(
      generateWith({
        input: { governed: GOVERNED_CONTEXT },
        correction: {
          onOutlineAnswer: () => {
            throw new Error('store down');
          },
        },
      }),
    ).resolves.toBeDefined();
  });

  it('a run without correction support gets no answer check (unchanged callers)', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines: [outline] },
    });
    await generateWith({ input: { governed: GOVERNED_CONTEXT } });
    const calls = mocks.generateSceneOutlinesFromRequirements.mock.calls as OutlineCallArgs[];
    expect(calls).toHaveLength(1);
    expect(calls[0]![4].rejectMalformedAnswer).toBeUndefined();
    expect(calls[0]![4].requiredSourceUnitIds).toBeUndefined();
  });

  it('passes the required book units to the check', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue(GOOD_ANSWER);
    await generateWith({
      input: { governed: GOVERNED_CONTEXT },
      correction: { requiredBookUnitIds: ['u1', 'u2', 'u3', 'u4'] },
    });
    const calls = mocks.generateSceneOutlinesFromRequirements.mock.calls as OutlineCallArgs[];
    expect(calls[0]![4].requiredSourceUnitIds).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('with the REAL generator: the 306 answer twice → one re-roll, then today’s pause', async () => {
    const actual =
      await vi.importActual<typeof import('@openmaic/generation')>('@openmaic/generation');
    mocks.generateSceneOutlinesFromRequirements.mockImplementation(
      actual.generateSceneOutlinesFromRequirements,
    );
    mocks.callLLM.mockResolvedValue({ text: RAW_306 });
    const captures: OutlineAnswerCapture[] = [];

    await expect(
      generateWith({
        input: { governed: GOVERNED_CONTEXT },
        correction: {
          onOutlineAnswer: (capture) => void captures.push(capture),
          collectOutlineIssues: () => [PAUSE_ISSUE],
        },
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_CORRECTION_REQUIRED' });

    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    expect(captures).toHaveLength(2);
    for (const capture of captures) {
      expect(capture.parse).toMatchObject({ extraction: 'exact', repair: 'none' });
      expect(capture.malformed[0]).toMatch(/nested answer object/);
      expect(capture.rawHead).toBe(RAW_306);
    }
  });

  it('with the REAL generator: the 306 answer, then a good one → success after one re-roll', async () => {
    const actual =
      await vi.importActual<typeof import('@openmaic/generation')>('@openmaic/generation');
    mocks.generateSceneOutlinesFromRequirements.mockImplementation(
      actual.generateSceneOutlinesFromRequirements,
    );
    mocks.callLLM
      .mockResolvedValueOnce({ text: RAW_306 })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          languageDirective: 'Use English.',
          outlines: [
            {
              ...outline,
              slideType: 'content',
              contentRole: 'explanation',
              contentKind: 'concept',
            },
          ],
        }),
      })
      .mockResolvedValue({ text: 'model text' });

    const result = await generateWith({
      input: { governed: GOVERNED_CONTEXT },
      correction: {},
    });
    expect(result).toBeDefined();
    const outlineCalls = mocks.generateSceneOutlinesFromRequirements.mock.calls;
    expect(outlineCalls).toHaveLength(2);
  });
});
