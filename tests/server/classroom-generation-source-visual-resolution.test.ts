import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassroomPersistenceSink,
  SourceVisualChannel,
} from '@/lib/server/classroom-generation';

/**
 * Integration coverage for the source-visual identifier boundary.
 *
 * This test drives the REAL path, end to end:
 *
 *   source visual id `src-1`
 *     → generateClassroom's imageMapping (id → /api/classroom-media/… path)
 *     → the REAL generateSceneContent (model output references `src-1`)
 *     → resolveImageIds
 *     → the REAL createSceneWithActions
 *     → the persisted scene's image element src
 *
 * Deliberately NOT mocked: `generateSceneContent`, `resolveImageIds`,
 * `createSceneWithActions`. The model stub emits a BARE `src-1` reference —
 * the resolved `/api/classroom-media/…` value must be produced by the
 * generator itself, never handed to it pre-resolved. (The sibling suite
 * `classroom-generation-source-visuals.test.ts` mocks `generateSceneContent`
 * to assert the wiring; this one refuses that shortcut on purpose.)
 *
 * Regression guarded: `isImageIdReference` recognized only `img_<n>`, so every
 * Teaching Package `src-<n>` reference walked past the resolver untouched and
 * the scene persisted a bare `src-1` the renderer could not render.
 */

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  generateSceneActions: vi.fn(),
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
// Only the OUTLINE stage and the ACTIONS stage are stubbed — scene CONTENT
// generation (the boundary under test) runs for real.
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  generateSceneActions: mocks.generateSceneActions,
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
const STAGE_ID = 'stage-sv-res';
/** The exact shape `materializeSourceImages` returns: `src_<n>_<sha8>.<ext>`. */
const SERVING_PATH = `/api/classroom-media/${STAGE_ID}/media/src_1_0a1b2c3d.png`;

const pdfImage = (id: string) => ({ id, src: DATA_URL, pageNumber: 1, width: 3, height: 2 });

function sink(): ClassroomPersistenceSink {
  return {
    reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
    persist: async ({ id, stage, scenes }) => ({
      id,
      url: '',
      stage,
      scenes,
      createdAt: '2026-09-16T00:00:00.000Z',
    }),
    release: async () => {},
  };
}

const sourceVisuals = (): SourceVisualChannel =>
  ({
    images: [pdfImage('src-1')],
    materialize: async () => ({
      servingMapping: { 'src-1': SERVING_PATH },
      manifest: [{ id: 'src-1' }],
      failedIds: [] as string[],
    }),
  }) as unknown as SourceVisualChannel;

/** The model's scene-content reply: a BARE logical reference, as produced live. */
function sceneContentReply(src: string) {
  return {
    text: JSON.stringify({
      elements: [
        { type: 'image', src, left: 100, top: 100, width: 600, height: 400, rotate: 0 },
        { type: 'text', content: 'Figure caption', left: 100, top: 520, width: 600, height: 60 },
      ],
      remark: '',
    }),
  };
}

function persistedImageSrcs(result: { scenes: unknown[] }): string[] {
  const elements =
    (
      result.scenes[0] as {
        content?: { canvas?: { elements?: Array<{ type: string; src?: string }> } };
      }
    ).content?.canvas?.elements ?? [];
  return elements.filter((el) => el.type === 'image').map((el) => el.src ?? '');
}

async function generateWithSourceVisual(modelSrc: string) {
  mocks.callLLM.mockResolvedValue(sceneContentReply(modelSrc));
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    {
      requirement: 'Teach with the figures from the handout',
      pdfContent: { text: 'pdf body', images: [], pdfImages: [pdfImage('src-1')] },
    },
    { baseUrl: '', persistence: sink(), sourceVisuals: sourceVisuals() },
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
  mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
    success: true,
    data: {
      languageDirective: 'English.',
      outlines: [
        {
          id: 'o1',
          type: 'slide',
          title: 'The Figure',
          description: 'Walk through the handout figure.',
          keyPoints: ['Read the axes'],
          order: 1,
          suggestedImageIds: ['src-1'],
        },
      ],
    },
  });
  mocks.generateSceneActions.mockResolvedValue([]);
  mocks.reserveClassroom.mockResolvedValue(undefined);
  mocks.releaseClassroomReservation.mockResolvedValue(undefined);
  mocks.persistClassroom.mockResolvedValue(undefined);
  mocks.generateMediaForClassroom.mockResolvedValue({});
  mocks.replaceMediaPlaceholders.mockImplementation(() => undefined);
  mocks.generateTTSForClassroom.mockResolvedValue(undefined);
  mocks.generateClassroomId.mockReturnValue('stagesvres');
});

describe('generateClassroom — source visual id survives the real generation path', () => {
  it('persists the concrete /api/classroom-media path for a model-emitted `src-1`', async () => {
    const result = await generateWithSourceVisual('src-1');

    // The model really was asked to reference the logical id (not a URL).
    const promptText = JSON.stringify(mocks.callLLM.mock.calls[0]![0]);
    expect(promptText).toContain('src-1');

    const imageSrcs = persistedImageSrcs(result);
    expect(imageSrcs).toEqual([SERVING_PATH]);
    // The defect this guards: a bare logical id reaching persistence.
    expect(imageSrcs).not.toContain('src-1');
    for (const src of imageSrcs) {
      expect(src.startsWith('/api/classroom-media/')).toBe(true);
    }
  });

  it('drops an unmapped source reference rather than persisting an unrenderable src', async () => {
    const result = await generateWithSourceVisual('src-7');
    expect(persistedImageSrcs(result)).toEqual([]);
  });
});
