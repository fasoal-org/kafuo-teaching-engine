/**
 * Owner, 26 Nov 2026: when a lesson's order is broken, the refusal says what is wrong —
 * the missing page (a deleted check quiz) with the slide it belongs after, or only the
 * slides out of place — instead of listing every slide of the lesson.
 */
import { describe, expect, it } from 'vitest';

import { droppedCheckQuizPositions } from '@/lib/server/teaching-package/exact-flow';
import {
  exactFlowOrRefuse,
  flowProblemDetails,
} from '@/lib/server/teaching-package/scene-insertion';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

const FLOW = [
  { stage: 'lesson_opener', instructions: '' },
  { stage: 'outcome_visual_explanations', instructions: '' },
  { stage: 'outcome_check_understanding', instructions: '' },
  { stage: 'outcome_visual_explanations', instructions: '' },
  { stage: 'outcome_check_understanding', instructions: '' },
] as TeachingFlowEntry[];

const scene = (id: string, order: number, flowIndex: number) =>
  ({
    id,
    order,
    type: 'slide',
    teachingStage: { key: FLOW[flowIndex]!.stage, flowIndex },
  }) as unknown as AppScene;

describe('flowProblemDetails', () => {
  it('a deleted check quiz: the missing position and the slide it belongs after', () => {
    const scenes = [
      scene('cover', 1, 0),
      scene('s1', 2, 1),
      scene('s2', 3, 1),
      scene('s3', 4, 3),
      scene('q2', 5, 4),
    ];
    expect(flowProblemDetails(scenes, FLOW)).toEqual({
      misplacedSceneIds: [],
      missing: [{ flowIndex: 2, stage: 'outcome_check_understanding', afterSceneId: 's2' }],
    });
  });

  it('a slide dragged into another part: only that slide', () => {
    const scenes = [
      scene('cover', 1, 0),
      scene('s1', 2, 1),
      scene('q1', 3, 2),
      scene('s3', 4, 3),
      scene('moved', 5, 1),
      scene('q2', 6, 4),
    ];
    expect(flowProblemDetails(scenes, FLOW)).toEqual({ misplacedSceneIds: ['moved'], missing: [] });
  });

  it('a missing page is named after a slide in place, never after a dragged one', () => {
    const scenes = [
      scene('cover', 1, 0),
      scene('s1', 2, 1),
      scene('s3', 3, 3),
      scene('moved', 4, 1),
      scene('q2', 5, 4),
    ];
    const details = flowProblemDetails(scenes, FLOW);
    expect(details.misplacedSceneIds).toEqual(['moved']);
    expect(details.missing).toEqual([
      { flowIndex: 2, stage: 'outcome_check_understanding', afterSceneId: 's1' },
    ]);
  });

  it('the refusal of a projection names the real slides only, never the placeholder', async () => {
    const { exactFlowOrRefuse } = await import('@/lib/server/teaching-package/scene-insertion');
    const real = [scene('cover', 1, 0), scene('s1', 2, 1), scene('s3', 3, 3), scene('q2', 4, 4)];
    const projection = [
      ...real.slice(0, 2),
      scene('scene_ins_dry_run', 3, 1),
      ...real.slice(2).map((entry) => ({ ...entry, order: entry.order + 1 }) as AppScene),
    ];
    let details: { missing?: Array<{ afterSceneId: string | null }> } | undefined;
    try {
      exactFlowOrRefuse(projection, FLOW, null, real);
    } catch (error) {
      details = (error as { details?: typeof details }).details;
    }
    expect(details?.missing).toEqual([
      { flowIndex: 2, stage: 'outcome_check_understanding', afterSceneId: 's1' },
    ]);
  });
});

/**
 * Owner, 26 Nov 2026 (drag-reorder): the editor's drag check agrees with the
 * server's. From a lesson in order, a drop keeps the order exactly when the server
 * still accepts the lesson, so the rail never lets through a drop the server refuses.
 */
describe('the rail drag check agrees with the exact-flow check', () => {
  it('every reordering of a sound lesson', async () => {
    const { keepsTeachingOrder } = await import('@/lib/edit/scene-defaults');
    const { validateExactTeachingFlow } = await import('@/lib/server/teaching-package/exact-flow');
    const base = [
      scene('cover', 1, 0),
      scene('s1', 2, 1),
      scene('s1b', 3, 1),
      scene('q1', 4, 2),
      scene('s2', 5, 3),
      scene('q2', 6, 4),
    ];
    expect(validateExactTeachingFlow(base, FLOW).valid).toBe(true);
    // Every single drag: one slide taken out and dropped at another place.
    for (let from = 0; from < base.length; from += 1) {
      for (let to = 0; to < base.length; to += 1) {
        const rest = base.filter((_, index) => index !== from);
        const dropped = [...rest.slice(0, to), base[from]!, ...rest.slice(to)].map(
          (entry, index) => ({ ...entry, order: index + 1 }) as AppScene,
        );
        expect(keepsTeachingOrder(dropped)).toBe(validateExactTeachingFlow(dropped, FLOW).valid);
      }
    }
  });
});

// g5.v12 (A-32): a check quiz the run dropped leaves its page empty by design; a refusal
// for another problem never names it as missing.
describe('flowProblemDetails — a dropped check quiz (A-32)', () => {
  // q1 was dropped by the run; q2 was deleted by a teacher.
  const scenes = [scene('cover', 1, 0), scene('s1', 2, 1), scene('s3', 3, 3)];
  const outlines = [
    {
      id: 'q1',
      teachingStage: { key: FLOW[2]!.stage, flowIndex: 2 },
      checkQuizDropped: { reason: 'unverified_answer_key', sceneId: 'q1' },
    },
  ];

  it('the recorded drop is left out of `missing`; the other empty page stays', () => {
    const positions = droppedCheckQuizPositions(FLOW, outlines, new Set(['q1']));
    expect([...positions]).toEqual([2]);
    expect(flowProblemDetails(scenes, FLOW, positions)).toEqual({
      misplacedSceneIds: [],
      missing: [{ flowIndex: 4, stage: 'outcome_check_understanding', afterSceneId: 's3' }],
    });
  });

  it('an unrecorded marker is still named missing', () => {
    const positions = droppedCheckQuizPositions(FLOW, outlines, new Set());
    expect(positions.size).toBe(0);
    expect(flowProblemDetails(scenes, FLOW, positions).missing.map((m) => m.flowIndex)).toEqual([
      2, 4,
    ]);
  });

  it('the insertion refusal carries the same details', () => {
    let caught: unknown;
    try {
      exactFlowOrRefuse(scenes, FLOW, { outlines } as never, scenes, new Set(['q1']));
    } catch (error) {
      caught = error;
    }
    const details = (caught as { details?: { missing?: Array<{ flowIndex: number }> } }).details;
    expect(details?.missing?.map((m) => m.flowIndex)).toEqual([4]);
  });
});
