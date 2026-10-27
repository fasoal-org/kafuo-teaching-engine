import { describe, expect, it } from 'vitest';

import { outlineFromScene } from '@/lib/server/agent-runtime/generation-tools';
import type { Scene } from '@/lib/types/stage';

/**
 * D-13 (reviewer-generated-slide plan, B-1): `outlineFromScene` matches a
 * Scene that carries an `outlineId` by that id ONLY, so an order shift never
 * pairs it with another Scene's planned entry.
 */
function slide(id: string, order: number, outlineId?: string): Scene {
  return {
    id,
    stageId: 'stage-test',
    order,
    title: `title ${id}`,
    type: 'slide',
    ...(outlineId !== undefined ? { outlineId } : {}),
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2463eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
    actions: [],
  } as Scene;
}

const snapshot = {
  outlines: [
    {
      id: 'o1',
      order: 1,
      title: 'one',
      type: 'slide',
      description: 'brief one',
      keyPoints: ['k1'],
    },
    {
      id: 'o2',
      order: 2,
      title: 'two',
      type: 'slide',
      description: 'brief two',
      keyPoints: ['k2'],
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};

describe('outlineFromScene (D-13 id-first)', () => {
  it('matches by outlineId even when another entry has the Scene order', () => {
    // After an insertion shifted it, o1's Scene sits at order 2.
    const outline = outlineFromScene(slide('s1', 2, 'o1'), snapshot);
    expect(outline.id).toBe('o1');
    expect(outline.description).toBe('brief one');
    expect(outline.keyPoints).toEqual(['k1']);
  });

  it('never falls back to order for an outlineId that resolves to nothing', () => {
    // An inserted slide: `ins_…` has no outline entry, and order 1 is o1's.
    const outline = outlineFromScene(slide('new', 1, 'ins_abc'), snapshot);
    expect(outline.id).toBe('ins_abc');
    expect(outline.description).toBe('title new');
    expect(outline.keyPoints).toEqual([]);
  });

  it('keeps the order fallback for a legacy Scene without outlineId', () => {
    const outline = outlineFromScene(slide('legacy', 2), snapshot);
    expect(outline.description).toBe('brief two');
    expect(outline.id).toBe('legacy');
  });
});
