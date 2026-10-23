import { describe, expect, it, vi } from 'vitest';

import type { PdfImage, SceneOutline } from '@openmaic/generation';

import type { AppStage } from '@/lib/document-store/persistence-types';
import {
  insertOneScene,
  type InsertOneSceneInput,
} from '@/lib/server/teaching-package/insert-one-scene';
import type { AppScene } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/**
 * Reviewer-generated slide plan §10.3: the NEW slide is generated from the
 * normalized planned outline with no caller edit mode, only the eligible
 * images, fallback Actions refused, the narration mark on a voiced package,
 * and the minted `ins_…` outline id.
 */

const STAGE = 'stage-ios';
const stage: AppStage = { id: STAGE, name: 'Lesson', createdAt: 1, updatedAt: 1 } as AppStage;

const outline: SceneOutline = {
  id: 'ins_new',
  type: 'slide',
  order: 3,
  title: 'Friction',
  description: 'brief',
  keyPoints: ['a', 'b', 'c'],
  slideType: 'content',
  contentRole: 'explanation',
  contentKind: 'concept',
  teachingStage: { key: 'explain', flowIndex: 1 },
  sourceContentUnitIds: ['cu_3'],
  suggestedImageIds: ['src-1'],
};

const images: PdfImage[] = [
  { id: 'src-1', src: '/media/stage-ios/src-1.png', pageNumber: 1 } as PdfImage,
  { id: 'src-2', src: '/media/stage-ios/src-2.png', pageNumber: 2 } as PdfImage,
];

function run(overrides: Partial<InsertOneSceneInput> = {}) {
  const generateContent = vi.fn(async () => ({
    elements: [
      {
        id: 'text-1',
        type: 'text',
        content: '<p>Friction</p>',
        left: 10,
        top: 10,
        width: 300,
        height: 50,
        rotate: 0,
        defaultFontName: 'Inter',
        defaultColor: '#111111',
      },
    ],
  }));
  const generateActions = vi.fn(async () => [
    { id: 'a1', type: 'speech', text: 'Friction slows things.' },
  ]);
  const input: InsertOneSceneInput = {
    outline,
    newSceneId: 'scene_new',
    scenes: [
      makeSlideScene('s1', STAGE, 1),
      makeSlideScene('s2', STAGE, 2),
      makeSlideScene('s3', STAGE, 3),
    ],
    stage,
    eligibleImages: images,
    aiCallFor: () => async () => '',
    registerPolicy: null,
    generateContent: generateContent as never,
    generateActions: generateActions as never,
    now: () => 42,
    ...overrides,
  };
  return { input, generateContent, generateActions };
}

describe('insertOneScene', () => {
  it('builds the new slide under the minted ids, without any caller edit mode', async () => {
    const { input, generateContent } = run();
    const result = await insertOneScene(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene).toMatchObject({
      id: 'scene_new',
      outlineId: 'ins_new',
      order: 3,
      type: 'slide',
      teachingStage: { key: 'explain', flowIndex: 1 },
      sourceContentUnitIds: ['cu_3'],
    });
    const options = (
      generateContent.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>]
    )[2];
    expect(options).not.toHaveProperty('editDirective');
    expect(options).not.toHaveProperty('baselineContent');
    // Only the eligible images the plan selected.
    expect((options.assignedImages as PdfImage[]).map((image) => image.id)).toEqual(['src-1']);
  });

  it('places a sentinel for the new slide in the Actions page context', async () => {
    const { input, generateActions } = run();
    await insertOneScene(input);
    const ctx = (
      generateActions.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        { ctx: Record<string, unknown> },
      ]
    )[3].ctx;
    expect(ctx).toMatchObject({ pageIndex: 3, totalPages: 4 });
  });

  it('refuses model-free fallback Actions', async () => {
    const generateActions = vi.fn(
      async (
        _o: unknown,
        _c: unknown,
        _a: unknown,
        options: { onFallback: (info: { code: string }) => void },
      ) => {
        options.onFallback({ code: 'invalid-json' });
        return [];
      },
    );
    const { input } = run({ generateActions: generateActions as never });
    const result = await insertOneScene(input);
    expect(result).toMatchObject({ ok: false, code: 'SCENE_ACTION_GENERATION_FAILED' });
  });

  it('a voiced package marks the new slide for the existing audio repair (D-11)', async () => {
    const voiced = {
      ...makeSlideScene('s1', STAGE, 1),
      actions: [{ id: 'sp', type: 'speech', text: 'hello', audioId: 'aud-1' }],
    } as unknown as AppScene;
    const { input } = run({ scenes: [voiced, makeSlideScene('s2', STAGE, 2)] });
    const result = await insertOneScene(input);
    expect(result.ok && result.scene.generationIssues?.[0]?.code).toBe('NARRATION_AUDIO_FAILED');
    const silent = await insertOneScene(run().input);
    expect(silent.ok && silent.scene.generationIssues).toBeFalsy();
  });

  it('an empty content answer fails without assembling a slide', async () => {
    const { input } = run({ generateContent: vi.fn(async () => null) as never });
    expect(await insertOneScene(input)).toMatchObject({
      ok: false,
      code: 'SCENE_CONTENT_GENERATION_FAILED',
    });
  });
});
