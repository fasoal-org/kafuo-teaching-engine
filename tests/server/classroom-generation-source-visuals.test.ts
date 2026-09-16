import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassroomPersistenceSink,
  GenerateClassroomInput,
  SourceVisualChannel,
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

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
]);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const pdfImage = (id: string) => ({
  id,
  src: DATA_URL,
  pageNumber: 1,
  width: 3,
  height: 2,
});

function sink(): ClassroomPersistenceSink {
  return {
    reserve: async (buildStage) => ({ id: 'stage-sv-1', stage: buildStage('stage-sv-1') }),
    persist: async ({ id, stage, scenes }) => ({
      id,
      url: '',
      stage,
      scenes,
      createdAt: '2026-09-15T00:00:00.000Z',
    }),
    release: async () => {},
  };
}

async function generate(options: {
  input?: Partial<GenerateClassroomInput>;
  materialize?: SourceVisualChannel;
}) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: 'Teach with figures', ...options.input },
    {
      baseUrl: '',
      persistence: sink(),
      ...(options.materialize ? { sourceVisuals: options.materialize } : {}),
    },
  );
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
  mocks.callLLM.mockResolvedValue({ text: 'ok' });
  mocks.applyOutlineFallbacks.mockImplementation((value) => value);
  mocks.generateSceneActions.mockResolvedValue([]);
  mocks.generateSceneContent.mockResolvedValue({ elements: [] });
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
      outlineId: sceneOutline.id,
    });
    return sceneResult.success ? (sceneResult.data ?? null) : null;
  });
  mocks.reserveClassroom.mockResolvedValue(undefined);
  mocks.releaseClassroomReservation.mockResolvedValue(undefined);
  mocks.persistClassroom.mockResolvedValue(undefined);
  mocks.generateMediaForClassroom.mockResolvedValue({});
  mocks.replaceMediaPlaceholders.mockImplementation(() => undefined);
  mocks.generateTTSForClassroom.mockResolvedValue(undefined);
  mocks.generateClassroomId.mockReturnValue('stagesv001');
});

describe('generateClassroom source visuals', () => {
  it('without visuals: the outline call receives NO pdfImages and no vision options (byte-compatible)', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [{ id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1 }] },
    });
    await generate({});
    const call = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]!;
    expect(call[2]).toBeUndefined(); // pdfImages
    expect(call[4]).not.toHaveProperty('visionEnabled');
    expect(call[4]).not.toHaveProperty('imageMapping');
  });

  it('with visuals and a non-vision model: fails SOURCE_VISUAL_MODEL_UNAVAILABLE, never degrades', async () => {
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'text-only-model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [{ id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1 }] },
    });
    await expect(
      generate({
        input: { pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] } },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_VISUAL_MODEL_UNAVAILABLE' });
  });

  it('with visuals: the outline call receives pdfImages + vision mapping, and the aiCall attaches images', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [{ id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1, suggestedImageIds: ['src-1'] }] },
    });
    const materialize = vi.fn(async (_stageId: string, selected: Array<{ id: string }>) => ({
      servingMapping: Object.fromEntries(selected.map((image) => [image.id, `/api/classroom-media/stage-sv-1/media/${image.id}.png`])),
      manifest: selected.map((image) => ({ id: image.id })),
      failedIds: [] as string[],
    }));
    await generate({
      input: { pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] } },
      materialize: { images: [pdfImage('src-1')], materialize } as unknown as SourceVisualChannel,
    });

    const outlineCall = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]!;
    expect(outlineCall[2]).toHaveLength(1);
    expect(outlineCall[4]).toMatchObject({ visionEnabled: true, imageMapping: { 'src-1': DATA_URL } });

    // The outline aiCall attaches images as multimodal user content.
    const outlineAiCall = outlineCall[3] as (
      system: string,
      user: string,
      images?: Array<{ id: string; src: string }>,
    ) => Promise<string>;
    await outlineAiCall('s', 'u', [{ id: 'src-1', src: DATA_URL }]);
    const lastCall = mocks.callLLM.mock.calls.at(-1)!;
    expect(Array.isArray(lastCall[0].messages[1].content)).toBe(true);

    // Only the SELECTED image is materialized — after reserve, exactly once.
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0]![1].map((image: { id: string }) => image.id)).toEqual(['src-1']);
  });

  it('slide content receives the outline’s assigned images with the serving mapping; quiz/interactive/PBL calls unchanged', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          { id: 'o1', type: 'slide', title: 'S', description: '', keyPoints: [], order: 1, suggestedImageIds: ['src-1'] },
          { id: 'o2', type: 'quiz', title: 'Q', description: '', keyPoints: [], order: 2, quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] }, suggestedImageIds: ['src-1'] },
          { id: 'o3', type: 'pbl', title: 'P', description: '', keyPoints: [], order: 3, pblConfig: { projectTopic: 't', projectDescription: 'd', targetSkills: ['s'], issueCount: 1 }, suggestedImageIds: ['src-1'] },
        ],
      },
    });
    const materialize = vi.fn(async (_stageId: string, selected: Array<{ id: string }>) => ({
      servingMapping: Object.fromEntries(selected.map((image) => [image.id, `/api/classroom-media/stage-sv-1/media/${image.id}.png`])),
      manifest: selected.map((image) => ({ id: image.id })),
      failedIds: [] as string[],
    }));
    await generate({
      input: { pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] } },
      materialize: { images: [pdfImage('src-1')], materialize } as unknown as SourceVisualChannel,
    });

    const slideOptions = mocks.generateSceneContent.mock.calls.find(
      (call) => call[0].id === 'o1',
    )![2];
    expect(slideOptions.assignedImages).toHaveLength(1);
    expect(slideOptions.imageMapping).toMatchObject({
      'src-1': '/api/classroom-media/stage-sv-1/media/src-1.png',
    });
    expect(slideOptions.visionEnabled).toBe(true);

    // Quiz and PBL content calls receive no source-visual channel.
    for (const outlineId of ['o2', 'o3']) {
      const options = mocks.generateSceneContent.mock.calls.find(
        (call) => call[0].id === outlineId,
      )![2];
      expect(options.assignedImages).toBeUndefined();
      expect(options.imageMapping).toBeUndefined();
    }
  });

  it('a selected-image materialization failure fails the run (no AI substitution)', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [{ id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1, suggestedImageIds: ['src-1'] }] },
    });
    await expect(
      generate({
        input: { pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] } },
        materialize: {
          images: [pdfImage('src-1')],
          materialize: (async () => ({
            servingMapping: {},
            manifest: [],
            failedIds: ['src-1'],
          })) as never,
        },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_VISUAL_PROCESSING_FAILED' });
  });

  it('a zero-image PDF passes without any vision enforcement', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [{ id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1 }] },
    });
    const result = await generate({
      input: { pdfContent: { text: 'pdf body', images: [], pdfImages: [] } },
    });
    expect(result.scenes.length).toBeGreaterThan(0);
  });

  it('per-need precedence: one selected source visual + one unrelated AI placeholder → both survive', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [{
          id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1,
          suggestedImageIds: ['src-1'],
          mediaGenerations: [{ type: 'image', elementId: 'gen_img_extra', prompt: 'decor' }],
        }],
      },
    });
    // Slide content: the selected source visual resolved onto its serving
    // path, plus an unrelated AI placeholder.
    mocks.generateSceneContent.mockImplementation(async (outline: { id: string }) => ({
      elements:
        outline.id === 'o1'
          ? [
              { id: 'e1', type: 'image', src: '/api/classroom-media/stage-sv-1/media/src-1.png' },
              { id: 'e2', type: 'image', src: 'gen_img_extra' },
            ]
          : [],
    }));
    const persisted = await generate({
      input: {
        pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] },
        enableImageGeneration: true,
      },
      materialize: {
        images: [pdfImage('src-1')],
        materialize: (async (_stageId: string, selected: Array<{ id: string }>) => ({
          servingMapping: Object.fromEntries(selected.map((image) => [image.id, `/api/classroom-media/stage-sv-1/media/${image.id}.png`])),
          manifest: selected.map((image) => ({ id: image.id })),
          failedIds: [] as string[],
        })) as never,
      },
    });
    const elements = (
      persisted.scenes[0] as unknown as {
        content: { canvas: { elements: Array<{ src: string }> } };
      }
    ).content.canvas.elements;
    expect(elements.map((el) => el.src)).toEqual([
      '/api/classroom-media/stage-sv-1/media/src-1.png',
      'gen_img_extra',
    ]);
    // The unrelated request reached media generation untouched.
    const outlinesToMedia = mocks.generateMediaForClassroom.mock.calls[0]![0];
    expect(outlinesToMedia[0].mediaGenerations).toHaveLength(1);
  });

  it('per-need precedence: a placeholder competing with an unplaced selected visual loses to the source', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [{
          id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1,
          suggestedImageIds: ['src-9'],
          mediaGenerations: [{ type: 'image', elementId: 'gen_img_1', prompt: 'competitor' }],
        }],
      },
    });
    mocks.generateSceneContent.mockImplementation(async () => ({
      elements: [{ id: 'e1', type: 'image', src: 'gen_img_1' }],
    }));
    const persisted = await generate({
      input: {
        pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-9')] },
        enableImageGeneration: true,
      },
      materialize: {
        images: [pdfImage('src-9')],
        materialize: (async (_stageId: string, selected: Array<{ id: string }>) => ({
          servingMapping: Object.fromEntries(selected.map((image) => [image.id, `/api/classroom-media/stage-sv-1/media/${image.id}.png`])),
          manifest: selected.map((image) => ({ id: image.id })),
          failedIds: [] as string[],
        })) as never,
      },
    });
    const elements = (
      persisted.scenes[0] as unknown as {
        content: { canvas: { elements: Array<{ src: string }> } };
      }
    ).content.canvas.elements;
    expect(elements[0]!.src).toBe('/api/classroom-media/stage-sv-1/media/src-9.png');
    // The superseded image request was dropped before media generation.
    const outlinesToMedia = mocks.generateMediaForClassroom.mock.calls[0]![0];
    expect(outlinesToMedia[0].mediaGenerations).toHaveLength(0);
  });

  it('persists the teaching flow and source-visual manifest through the sink', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [{ id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1, suggestedImageIds: ['src-1'] }] },
    });
    const persistSpy = vi.fn();
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    await generateClassroom(
      {
        requirement: 'r',
        pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] },
        teachingFlow: [{ stage: 'lesson_introduction', instructions: 'i' }],
      },
      {
        baseUrl: '',
        persistence: {
          reserve: async (buildStage) => ({ id: 'stage-sv-2', stage: buildStage('stage-sv-2') }),
          persist: async (data) => {
            persistSpy(data);
            return { id: data.id, url: '', stage: data.stage, scenes: data.scenes, createdAt: '2026-09-15T00:00:00.000Z' };
          },
          release: async () => {},
        },
        sourceVisuals: {
          images: [pdfImage('src-1')],
          materialize: (async (_stageId: string, selected: Array<{ id: string }>) => ({
            servingMapping: Object.fromEntries(selected.map((image) => [image.id, `/api/classroom-media/stage-sv-2/media/${image.id}.png`])),
            manifest: [{ id: 'src-1', contentResourceId: 'cs-1', pageNumber: 1, mimeType: 'image/png', sha256: '0'.repeat(64), servingPath: '/api/classroom-media/stage-sv-2/media/src-1.png' }],
            failedIds: [] as string[],
          })) as never,
        },
      },
    );
    const persisted = persistSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted.teachingFlow).toEqual([{ stage: 'lesson_introduction', instructions: 'i' }]);
    expect(persisted.sourceVisuals).toHaveLength(1);
    // And the result carries the outlines for the exact-flow gate.
    const result = (persisted as unknown as { outlines: unknown[] }).outlines;
    expect(Array.isArray(result)).toBe(true);
  });
});
