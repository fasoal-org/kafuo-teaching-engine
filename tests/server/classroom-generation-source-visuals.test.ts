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
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3,
  0, 0, 0, 2, 8, 6, 0, 0, 0,
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
      data: {
        languageDirective: 'English.',
        outlines: [
          { id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1 },
        ],
      },
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
      data: {
        languageDirective: 'English.',
        outlines: [
          { id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1 },
        ],
      },
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
      data: {
        languageDirective: 'English.',
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'T',
            description: '',
            keyPoints: [],
            order: 1,
            suggestedImageIds: ['src-1'],
          },
        ],
      },
    });
    const materialize = vi.fn(async (_stageId: string, selected: Array<{ id: string }>) => ({
      servingMapping: Object.fromEntries(
        selected.map((image) => [
          image.id,
          `/api/classroom-media/stage-sv-1/media/${image.id}.png`,
        ]),
      ),
      manifest: selected.map((image) => ({ id: image.id })),
      failedIds: [] as string[],
    }));
    await generate({
      input: { pdfContent: { text: 'pdf', images: [], pdfImages: [pdfImage('src-1')] } },
      materialize: { images: [pdfImage('src-1')], materialize } as unknown as SourceVisualChannel,
    });

    const outlineCall = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]!;
    expect(outlineCall[2]).toHaveLength(1);
    expect(outlineCall[4]).toMatchObject({
      visionEnabled: true,
      imageMapping: { 'src-1': DATA_URL },
    });

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
    expect(materialize.mock.calls[0]![1].map((image: { id: string }) => image.id)).toEqual([
      'src-1',
    ]);
  });

  it('slide content receives the outline’s assigned images with the serving mapping; quiz/interactive/PBL calls unchanged', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'S',
            description: '',
            keyPoints: [],
            order: 1,
            suggestedImageIds: ['src-1'],
          },
          {
            id: 'o2',
            type: 'quiz',
            title: 'Q',
            description: '',
            keyPoints: [],
            order: 2,
            quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] },
            suggestedImageIds: ['src-1'],
          },
          {
            id: 'o3',
            type: 'pbl',
            title: 'P',
            description: '',
            keyPoints: [],
            order: 3,
            pblConfig: {
              projectTopic: 't',
              projectDescription: 'd',
              targetSkills: ['s'],
              issueCount: 1,
            },
            suggestedImageIds: ['src-1'],
          },
        ],
      },
    });
    const materialize = vi.fn(async (_stageId: string, selected: Array<{ id: string }>) => ({
      servingMapping: Object.fromEntries(
        selected.map((image) => [
          image.id,
          `/api/classroom-media/stage-sv-1/media/${image.id}.png`,
        ]),
      ),
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

  it('hands the approved Content Unit text to slide content and narration only when supplied', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'S',
            description: '',
            keyPoints: [],
            order: 1,
            sourceContentUnitIds: ['10'],
          },
        ],
      },
    });
    const sourceUnits = [{ id: '10', title: 'Pressure', text: 'Pressure is force per unit area.' }];
    await generate({ input: { pdfContent: { text: 'pdf', images: [] }, sourceUnits } });
    expect(mocks.generateSceneContent.mock.calls[0]![2].sourceUnits).toBe(sourceUnits);
    expect(mocks.generateSceneActions.mock.calls[0]![3].sourceUnits).toBe(sourceUnits);

    // A caller without units (Workbench, legacy) passes nothing at all.
    mocks.generateSceneContent.mockClear();
    mocks.generateSceneActions.mockClear();
    await generate({ input: { pdfContent: { text: 'pdf', images: [] } } });
    expect(mocks.generateSceneContent.mock.calls[0]![2]).not.toHaveProperty('sourceUnits');
    expect(mocks.generateSceneActions.mock.calls[0]![3]).not.toHaveProperty('sourceUnits');
  });

  it('a selected-image materialization failure fails the run (no AI substitution)', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'T',
            description: '',
            keyPoints: [],
            order: 1,
            suggestedImageIds: ['src-1'],
          },
        ],
      },
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
      data: {
        languageDirective: 'English.',
        outlines: [
          { id: 'o1', type: 'slide', title: 'T', description: '', keyPoints: [], order: 1 },
        ],
      },
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
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'T',
            description: '',
            keyPoints: [],
            order: 1,
            suggestedImageIds: ['src-1'],
            mediaGenerations: [{ type: 'image', elementId: 'gen_img_extra', prompt: 'decor' }],
          },
        ],
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
          servingMapping: Object.fromEntries(
            selected.map((image) => [
              image.id,
              `/api/classroom-media/stage-sv-1/media/${image.id}.png`,
            ]),
          ),
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
    // RSS W4: the media phase (mocked here) mapped nothing for `gen_img_extra`,
    // and an unmapped placeholder never survives into the persisted Stage.
    expect(elements.map((el) => el.src)).toEqual([
      '/api/classroom-media/stage-sv-1/media/src-1.png',
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
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'T',
            description: '',
            keyPoints: [],
            order: 1,
            suggestedImageIds: ['src-9'],
            mediaGenerations: [{ type: 'image', elementId: 'gen_img_1', prompt: 'competitor' }],
          },
        ],
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
          servingMapping: Object.fromEntries(
            selected.map((image) => [
              image.id,
              `/api/classroom-media/stage-sv-1/media/${image.id}.png`,
            ]),
          ),
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

  it('g5.v8: a split unit image is re-planned away from the slide it does not illustrate', async () => {
    const linked = { ...pdfImage('src-1'), sourceContentUnitIds: ['4021'] };
    const slideOf = (id: string, order: number) => ({
      id,
      type: 'slide',
      title: id,
      description: '',
      keyPoints: ['a', 'b', 'c'],
      order,
      sourceContentUnitIds: ['4021'],
      suggestedImageIds: ['src-1'],
      visualPlan: { mode: 'image' },
      imagePlans: [{ imageId: 'src-1', shows: 's', teachingPoint: 't' }],
    });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: [slideOf('bus', 1), slideOf('seg', 2)] },
    });
    const replanPrompts: string[] = [];
    mocks.callLLM.mockImplementation(async (params: { messages: Array<{ content: unknown }> }) => {
      const system = String(params.messages[0]!.content);
      if (!system.startsWith('You re-plan the VISUAL')) return { text: 'ok' };
      replanPrompts.push(String(params.messages[1]!.content));
      return {
        text: JSON.stringify({
          suggestedImageIds: [],
          visualPlan: { mode: 'native', diagram: { shows: 'timeline', teachingPoint: 'gaps' } },
          keyPoints: ['10:15', '11:00', '11:45'],
        }),
      };
    });
    const find = vi.fn(() => [{ outlineId: 'bus', imageId: 'src-1', keptOnOutlineId: 'seg' }]);
    const materialize = vi.fn(async (_stageId: string, selected: Array<{ id: string }>) => ({
      servingMapping: Object.fromEntries(selected.map((image) => [image.id, `/m/${image.id}`])),
      manifest: selected.map((image) => ({ id: image.id })),
      failedIds: [] as string[],
    }));
    await generate({
      input: {
        pdfContent: { text: 'pdf', images: [], pdfImages: [linked] },
        teachingFlow: [{ stage: 'lesson_introduction', instructions: 'i' }],
        findDuplicateSourceVisuals: find,
      },
      materialize: { images: [linked], materialize } as unknown as SourceVisualChannel,
    });

    expect(find).toHaveBeenCalledTimes(1);
    // One re-plan, for the bus slide only, offered no image and told why.
    expect(replanPrompts).toHaveLength(1);
    expect(replanPrompts[0]).toContain('Slide title: bus');
    expect(replanPrompts[0]).toContain('Textbook images linked to this slide: none');
    expect(replanPrompts[0]).toContain('do not show src-1 here');
    const contentCalls = mocks.generateSceneContent.mock.calls.map(
      (call) => call[0] as { id: string; suggestedImageIds?: string[]; visualPlan?: unknown },
    );
    expect(contentCalls.find((outline) => outline.id === 'bus')?.suggestedImageIds).toBeUndefined();
    expect(contentCalls.find((outline) => outline.id === 'seg')?.suggestedImageIds).toEqual([
      'src-1',
    ]);
  });

  describe('g5.v8: lesson 306 check 4028 (one try-it + three solutions, one image)', () => {
    const image = { ...pdfImage('src-5'), sourceContentUnitIds: ['4028'] };
    const flow = [
      {
        stage: 'outcome_visual_explanations',
        instructions: 'i',
        scenePolicy: {
          sceneTypes: ['slide'],
          visual: 'source_grounded',
          cardinality: 'one_or_more',
        },
      },
    ] as GenerateClassroomInput['teachingFlow'];
    const ids = ['try-it', 'sol-a', 'sol-b', 'sol-c'];
    const slideOf = (id: string, order: number, withImage: boolean) => ({
      id,
      type: 'slide',
      title: id,
      description: '',
      keyPoints: ['a', 'b', 'c'],
      order,
      slideType: 'content',
      contentRole: id === 'try-it' ? 'check_understanding' : 'worked_example',
      teachingStage: { key: 'outcome_visual_explanations', flowIndex: 0 },
      sourceContentUnitIds: ['4028'],
      ...(withImage
        ? {
            suggestedImageIds: ['src-5'],
            visualPlan: { mode: 'image' },
            imagePlans: [{ imageId: 'src-5', shows: 'dots', teachingPoint: 'pattern' }],
          }
        : { visualPlan: { mode: 'native' } }),
    });

    /** A model that shows the listed image whenever one is offered. */
    function replanModel(prompts: string[]) {
      mocks.callLLM.mockImplementation(
        async (params: { messages: Array<{ content: unknown }> }) => {
          const system = String(params.messages[0]!.content);
          if (!system.startsWith('You re-plan the VISUAL')) return { text: 'ok' };
          const user = params.messages[1]!.content;
          const prompt = Array.isArray(user)
            ? user.map((part: { text?: string }) => part.text ?? '').join('\n')
            : String(user);
          prompts.push(prompt);
          const offered = /\n- src-5\b/.test(prompt);
          return {
            text: JSON.stringify(
              offered
                ? {
                    suggestedImageIds: ['src-5'],
                    imagePlans: [{ imageId: 'src-5', shows: 'dots', teachingPoint: 'pattern' }],
                    visualPlan: { mode: 'image' },
                    keyPoints: ['a', 'b', 'c'],
                  }
                : {
                    suggestedImageIds: [],
                    visualPlan: { mode: 'native', diagram: { shows: 'sum', teachingPoint: 'p' } },
                    keyPoints: ['a', 'b', 'c'],
                  },
            ),
          };
        },
      );
    }

    async function run(input: Partial<GenerateClassroomInput>) {
      const { findSplitUnitDuplicateImages } =
        await import('@/lib/server/teaching-package/split-unit-images');
      const materialize = vi.fn(async (_stageId: string, selected: Array<{ id: string }>) => ({
        servingMapping: Object.fromEntries(selected.map((entry) => [entry.id, `/m/${entry.id}`])),
        manifest: selected.map((entry) => ({ id: entry.id })),
        failedIds: [] as string[],
      }));
      await generate({
        input: {
          pdfContent: { text: 'pdf', images: [], pdfImages: [image] },
          teachingFlow: flow,
          findDuplicateSourceVisuals: findSplitUnitDuplicateImages,
          ...input,
        },
        materialize: { images: [image], materialize } as unknown as SourceVisualChannel,
      });
      return mocks.generateSceneContent.mock.calls
        .map((call) => call[0] as { id: string; suggestedImageIds?: string[] })
        .filter((outline) => ids.includes(outline.id));
    }

    it('all four planned with the image: three are re-planned without it', async () => {
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: {
          languageDirective: 'English.',
          outlines: ids.map((id, at) => slideOf(id, at + 1, true)),
        },
      });
      const prompts: string[] = [];
      replanModel(prompts);
      const slides = await run({});
      expect(slides).toHaveLength(4);
      expect(slides.filter((slide) => slide.suggestedImageIds?.includes('src-5'))).toHaveLength(1);
      expect(prompts).toHaveLength(3);
    });

    it('none planned with the image (SOURCE_VISUAL_NOT_SELECTED): the re-plan puts it on one slide only', async () => {
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: {
          languageDirective: 'English.',
          outlines: ids.map((id, at) => slideOf(id, at + 1, false)),
          diagnostics: ids.map((id, at) => ({
            code: 'SOURCE_VISUAL_NOT_SELECTED',
            disposition: 'admin_correctable',
            outlineIndex: at,
            outlineId: id,
            field: 'suggestedImageIds',
            message: `${id} has a textbook visual linked to the same Content Unit but did not select it`,
          })),
        },
      });
      const prompts: string[] = [];
      replanModel(prompts);
      const slides = await run({});
      expect(slides).toHaveLength(4);
      const holders = slides.filter((slide) => slide.suggestedImageIds?.includes('src-5'));
      expect(holders.map((slide) => slide.id)).toEqual(['try-it']);
      // Each solution is told why the image is not offered.
      expect(prompts).toHaveLength(4);
      for (const prompt of prompts.slice(1)) {
        expect(prompt).toContain('Textbook images linked to this slide: none');
        expect(prompt).toContain('src-5 is already shown on try-it');
      }
    });

    it('g5.v7 (no duplicate finder): the re-plan is unchanged', async () => {
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: {
          languageDirective: 'English.',
          outlines: ids.map((id, at) => slideOf(id, at + 1, false)),
          diagnostics: ids.map((id, at) => ({
            code: 'SOURCE_VISUAL_NOT_SELECTED',
            disposition: 'admin_correctable',
            outlineIndex: at,
            outlineId: id,
            field: 'suggestedImageIds',
            message: `${id} has a textbook visual linked to the same Content Unit but did not select it`,
          })),
        },
      });
      const prompts: string[] = [];
      replanModel(prompts);
      const slides = await run({ findDuplicateSourceVisuals: undefined });
      expect(slides.filter((slide) => slide.suggestedImageIds?.includes('src-5'))).toHaveLength(4);
      expect(prompts.every((prompt) => /\n- src-5\b/.test(prompt))).toBe(true);
    });
  });

  it('persists the teaching flow and source-visual manifest through the sink', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'T',
            description: '',
            keyPoints: [],
            order: 1,
            suggestedImageIds: ['src-1'],
          },
        ],
      },
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
            return {
              id: data.id,
              url: '',
              stage: data.stage,
              scenes: data.scenes,
              createdAt: '2026-09-15T00:00:00.000Z',
            };
          },
          release: async () => {},
        },
        sourceVisuals: {
          images: [pdfImage('src-1')],
          materialize: (async (_stageId: string, selected: Array<{ id: string }>) => ({
            servingMapping: Object.fromEntries(
              selected.map((image) => [
                image.id,
                `/api/classroom-media/stage-sv-2/media/${image.id}.png`,
              ]),
            ),
            manifest: [
              {
                id: 'src-1',
                contentResourceId: 'cs-1',
                pageNumber: 1,
                mimeType: 'image/png',
                sha256: '0'.repeat(64),
                servingPath: '/api/classroom-media/stage-sv-2/media/src-1.png',
              },
            ],
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
