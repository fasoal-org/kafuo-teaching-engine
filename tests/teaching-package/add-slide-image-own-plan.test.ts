import { describe, expect, it, vi } from 'vitest';

import type { SceneOutline } from '@openmaic/generation';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { replanSlideWithImage } from '@/lib/server/teaching-package/add-slide-image';
import type { AppScene } from '@/lib/types/stage';
import { makeOutline, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * ED-8 (owner, 26 Nov 2026, as `f2139cd1` did for Regenerate): adding a textbook image
 * to a page a teacher added (no outline id) never seeds the re-plan with the plan that
 * sits at its order — the neighbour's key points, role and images. Only a legacy Stage
 * (no Scene carries an outline id) keeps the order fallback. Seams only: no pool, no model.
 */

const STAGE = 'stage-ed8';
const NEW_IMAGE = {
  id: 'img-new',
  servingPath: '/visuals/img-new.png',
  pageNumber: 3,
  sha256: 'a'.repeat(64),
};

// The plan at order 1 belongs to the slide that now sits at order 2.
const record = (): AppDocumentOutline => ({
  ...makeOutline('Lesson'),
  sourceVisuals: [NEW_IMAGE] as never,
  outlines: [
    {
      id: 'o-neighbour',
      type: 'slide',
      title: 'Neighbour',
      description: 'The neighbour slide plan.',
      keyPoints: ['The neighbour key point'],
      order: 1,
      contentRole: 'worked_example',
      suggestedImageIds: ['img-neighbour'],
    },
  ] as never,
});

const teacherPage = (): AppScene =>
  ({
    ...makeSlideScene('s-teacher', STAGE, 1, 'My page'),
    sourceContentUnitIds: ['u1'],
  }) as AppScene;

async function seededOutline(others: AppScene[]): Promise<SceneOutline> {
  const scene = teacherPage();
  const replan = vi.fn(async (input: { outline: SceneOutline }) => ({
    ok: true as const,
    outline: input.outline,
    calls: 1,
  }));
  const result = await replanSlideWithImage({
    pool: {} as never,
    scene,
    outlineRecord: record(),
    scenes: [scene, ...others],
    units: [],
    addition: { sourceVisualId: NEW_IMAGE.id },
    languageDirective: 'English.',
    aiCall: (async () => '') as never,
    visuals: (async () => ({
      visuals: [{ entry: NEW_IMAGE, image: { id: NEW_IMAGE.id, pageNumber: 3 } }],
      visionImages: [{ id: NEW_IMAGE.id, src: 'data:image/png;base64,AA==' }],
    })) as never,
    replan: replan as never,
  });
  expect(result.ok).toBe(true);
  return replan.mock.calls[0]![0].outline;
}

describe('replanSlideWithImage — ED-8: a page a teacher added has no plan of its own', () => {
  it('on a Stage whose Scenes carry outline ids, the neighbour’s plan is never read', async () => {
    const planned = { ...makeSlideScene('s-planned', STAGE, 2), outlineId: 'o-neighbour' };

    const outline = await seededOutline([planned as AppScene]);

    expect(outline.keyPoints).toEqual([]);
    expect(outline.description).toBe('My page');
    expect(outline.contentRole).toBeUndefined();
    expect(outline.suggestedImageIds).toEqual([NEW_IMAGE.id]);
  });

  it('a legacy Stage (no Scene carries an outline id) keeps the order fallback', async () => {
    const legacy = makeSlideScene('s-legacy', STAGE, 2);

    const outline = await seededOutline([legacy]);

    expect(outline.keyPoints).toEqual(['The neighbour key point']);
    expect(outline.suggestedImageIds).toEqual(['img-neighbour', NEW_IMAGE.id]);
  });
});
