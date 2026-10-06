/**
 * 3 Oct 2026: on a governed run an invalid Action is removed from its scene and
 * the scene is marked, instead of pausing the attempt for an admin.
 */
import { describe, expect, it, vi } from 'vitest';

import { repairInvalidActions } from '@/lib/server/classroom-generation';
import type { Scene, Stage } from '@/lib/types/stage';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function slide(actions: unknown[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Slide',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'c1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'x' },
        elements: [{ id: 'el-1', type: 'text', left: 0, top: 0, width: 10, height: 10, rotate: 0 }],
      },
    },
    actions,
  } as unknown as Scene;
}

const stage = { id: 'stage-1', generatedAgentConfigs: [], agentIds: [] } as unknown as Stage;

describe('repairInvalidActions', () => {
  it('removes only the invalid Action and marks the scene with its code', () => {
    const scene = slide([
      { id: 'a1', type: 'speech', text: 'Hello' },
      { id: 'a2', type: 'spotlight', elementId: 'missing-element' },
      { id: 'a3', type: 'spotlight', elementId: 'el-1' },
    ]);
    expect(repairInvalidActions([scene], stage)).toBe(1);
    expect(scene.actions!.map((action) => action.id)).toEqual(['a1', 'a3']);
    expect(scene.generationIssues?.map((issue) => issue.code)).toEqual([
      'ACTION_REFERENCE_INVALID',
    ]);
    expect(scene.generationIssues?.[0]?.message).toContain('1 invalid');
  });

  it('leaves a valid scene untouched', () => {
    const scene = slide([{ id: 'a1', type: 'speech', text: 'Hello' }]);
    expect(repairInvalidActions([scene], stage)).toBe(0);
    expect(scene.generationIssues).toBeUndefined();
  });
});
