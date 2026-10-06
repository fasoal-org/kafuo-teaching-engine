import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassroomPersistenceSink,
  GenerateClassroomInput,
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

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

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
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Sink Basics',
  description: 'Explain sinks',
  keyPoints: ['Sinks are injectable'],
  order: 1,
} as const;

const slideContent = { elements: [], remark: 'Sinks are injectable' };

/** A recording custom sink: id 'stage-pg-N', optional persist/release failures. */
function makeRecordingSink(failures: { persist?: Error } = {}) {
  const calls = { reserve: [] as string[], release: [] as string[] };
  const sink: ClassroomPersistenceSink = {
    reserve: async (buildStage) => {
      const id = `stage-pg-${calls.reserve.length + 1}`;
      calls.reserve.push(id);
      return { id, stage: buildStage(id) };
    },
    persist: async ({ id, stage, scenes }) => {
      if (failures.persist) throw failures.persist;
      return { id, url: '', stage, scenes, createdAt: '2026-09-14T00:00:00.000Z' };
    },
    release: async (id) => {
      calls.release.push(id);
    },
  };
  return { sink, calls };
}

async function generateWith(options: {
  persistence?: ClassroomPersistenceSink;
  input?: Partial<GenerateClassroomInput>;
}) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: 'Teach sink basics', ...options.input },
    {
      baseUrl: 'http://localhost',
      ...(options.persistence ? { persistence: options.persistence } : {}),
    },
  );
}

describe('generateClassroom persistence sink', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines: [outline] },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneContent.mockResolvedValue(slideContent);
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
      createdAt: '2026-09-14T00:00:00.000Z',
    }));
    mocks.reserveClassroom.mockResolvedValue(undefined);
    mocks.releaseClassroomReservation.mockResolvedValue(undefined);
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.replaceMediaPlaceholders.mockImplementation(() => undefined);
    mocks.generateTTSForClassroom.mockResolvedValue(undefined);
    mocks.generateClassroomId.mockReturnValue('stagesink1');
  });

  it('defaults to the filesystem sink with identical arguments and order', async () => {
    await generateWith({});

    expect(mocks.reserveClassroom).toHaveBeenCalledTimes(1);
    expect(mocks.reserveClassroom.mock.calls[0][0]).toBe('stagesink1');
    // The FS persist keeps its exact historical shape: ({id, stage, scenes}, baseUrl).
    expect(mocks.persistClassroom).toHaveBeenCalledTimes(1);
    const [data, baseUrl] = mocks.persistClassroom.mock.calls[0];
    expect(baseUrl).toBe('http://localhost');
    expect(data.id).toBe('stagesink1');
    expect(data.stage.id).toBe('stagesink1');
    expect(Object.keys(data).sort()).toEqual(['id', 'scenes', 'stage']);
    expect(mocks.releaseClassroomReservation).not.toHaveBeenCalled();
  });

  it('drives a custom sink through reserve → persist on success, with outlines', async () => {
    const { sink, calls } = makeRecordingSink();
    const persist = vi.fn(sink.persist);
    const recordingSink: ClassroomPersistenceSink = { ...sink, persist };

    const result = await generateWith({ persistence: recordingSink });

    expect(result.id).toBe('stage-pg-1');
    expect(calls.reserve).toEqual(['stage-pg-1']);
    expect(persist).toHaveBeenCalledTimes(1);
    const [data, baseUrl] = persist.mock.calls[0]!;
    expect(baseUrl).toBe('http://localhost');
    expect(data.id).toBe('stage-pg-1');
    expect(data.outlines).toEqual([outline]);
    expect(data.scenes.length).toBe(1);
    expect(data.stage.id).toBe('stage-pg-1');
    // The filesystem path is never touched by a custom sink.
    expect(mocks.reserveClassroom).not.toHaveBeenCalled();
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
    expect(mocks.releaseClassroomReservation).not.toHaveBeenCalled();
    expect(calls.release).toEqual([]);
  });

  it('stamps the authoritative language and its resolved direction on the Stage, and hands the direction to slide generation', async () => {
    for (const [language, textDirection] of [
      ['ar', 'rtl'],
      ['en-US', 'ltr'],
    ] as const) {
      mocks.generateSceneContent.mockClear();
      const { sink } = makeRecordingSink();
      const persist = vi.fn(sink.persist);
      await generateWith({ persistence: { ...sink, persist }, input: { language } });

      const [data] = persist.mock.calls[0]!;
      expect(data.stage).toMatchObject({ language, textDirection });
      // The LLM-written directive says "Use English." in BOTH runs: direction
      // follows the lesson metadata, never the directive or generated text.
      expect(data.stage.languageDirective).toBe('Use English.');
      expect(mocks.generateSceneContent.mock.calls[0]![2]).toMatchObject({ textDirection });
    }
  });

  it('records neither field when the caller supplies no language (legacy / non-Kafuo)', async () => {
    const { sink } = makeRecordingSink();
    const persist = vi.fn(sink.persist);
    await generateWith({ persistence: { ...sink, persist } });

    const [data] = persist.mock.calls[0]!;
    expect(data.stage).not.toHaveProperty('language');
    expect(data.stage).not.toHaveProperty('textDirection');
    expect(mocks.generateSceneContent.mock.calls[0]![2]).not.toHaveProperty('textDirection');
  });

  it('records an unreadable language tag without guessing a direction', async () => {
    const { sink } = makeRecordingSink();
    const persist = vi.fn(sink.persist);
    await generateWith({ persistence: { ...sink, persist }, input: { language: 'Arabic' } });

    const [data] = persist.mock.calls[0]!;
    expect(data.stage.language).toBe('Arabic');
    expect(data.stage).not.toHaveProperty('textDirection');
  });

  it('calls release on the sink only when generation fails after reserve', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines: [] },
    });
    const { sink, calls } = makeRecordingSink();
    const persist = vi.fn(async () => {
      throw new Error('unreachable');
    });

    await expect(generateWith({ persistence: { ...sink, persist } })).rejects.toThrow(
      'No scenes were generated',
    );

    expect(calls.reserve).toEqual(['stage-pg-1']);
    expect(persist).not.toHaveBeenCalled();
    expect(calls.release).toEqual(['stage-pg-1']);
  });

  it('never persists when zero scenes survive', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines: [] },
    });
    const { sink } = makeRecordingSink();
    const persist = vi.fn(sink.persist);

    await expect(generateWith({ persistence: { ...sink, persist } })).rejects.toThrow(
      'No scenes were generated',
    );
    expect(persist).not.toHaveBeenCalled();
  });

  describe('narration audio gaps are marked for review (NARRATION_AUDIO_FAILED)', () => {
    const speech = () => [
      { id: 'a1', type: 'speech', text: 'first line' },
      { id: 'a2', type: 'speech', text: 'second line' },
    ];

    beforeEach(() => {
      mocks.generateSceneActions.mockResolvedValue(speech());
    });

    async function persistedScene(input: Partial<GenerateClassroomInput>) {
      const { sink } = makeRecordingSink();
      const persist = vi.fn(sink.persist);
      await generateWith({ persistence: { ...sink, persist }, input });
      expect(persist).toHaveBeenCalledTimes(1);
      return persist.mock.calls[0]![0].scenes[0] as {
        actions?: Array<{ id: string; type: string; text?: string; audioId?: string }>;
        generationIssues?: Array<{ code: string; message: string }>;
      };
    }

    it('marks the scene with the count when a line failed, and the package still completes', async () => {
      mocks.generateTTSForClassroom.mockImplementation(async (scenes) => {
        const first = scenes[0].actions.find((action: { type: string }) => action.type === 'speech');
        first.audioId = 'tts_s1_a1';
      });
      const scene = await persistedScene({ enableTTS: true });
      expect(scene.generationIssues).toEqual([
        expect.objectContaining({ code: 'NARRATION_AUDIO_FAILED', message: expect.stringContaining('1 of 2') }),
      ]);
    });

    it('marks every spoken line when the whole TTS phase throws (or is skipped)', async () => {
      mocks.generateTTSForClassroom.mockRejectedValue(new Error('provider down'));
      const scene = await persistedScene({ enableTTS: true });
      expect(scene.generationIssues?.[0]).toMatchObject({ code: 'NARRATION_AUDIO_FAILED' });
      expect(scene.generationIssues?.[0]?.message).toContain('2 of 2');
    });

    it('adds no mark when every spoken line has audio', async () => {
      mocks.generateTTSForClassroom.mockImplementation(async (scenes) => {
        for (const action of scenes[0].actions) if (action.type === 'speech') action.audioId = `tts_s1_${action.id}`;
      });
      const scene = await persistedScene({ enableTTS: true });
      expect(scene.generationIssues ?? []).toEqual([]);
    });

    it('adds no mark when TTS was not requested', async () => {
      const scene = await persistedScene({ enableTTS: false });
      expect(mocks.generateTTSForClassroom).not.toHaveBeenCalled();
      expect(scene.generationIssues ?? []).toEqual([]);
    });
  });
});
