import { describe, expect, it } from 'vitest';

import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { validateExactTeachingFlow } from '@/lib/server/teaching-package/exact-flow';
import type { AppScene } from '@/lib/types/stage';

const FLOW: TeachingFlowEntry[] = [
  { stage: 'lesson_introduction', instructions: 'i' },
  { stage: 'outcome_teaching_cards', instructions: 'c' },
  { stage: 'outcome_worked_examples', instructions: 'e' },
];

function scene(
  order: number,
  teachingStage?: { key: string; flowIndex: number },
  outlineId?: string,
): AppScene {
  return {
    id: `scene-${order}`,
    stageId: 'stage-x',
    type: 'slide',
    title: `S${order}`,
    order,
    content: { type: 'slide', canvas: { id: 'c', viewportSize: 1000, viewportRatio: 0.5, theme: {} as never, elements: [] } },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
    ...(teachingStage ? { teachingStage } : {}),
    ...(outlineId ? { outlineId } : {}),
  } as unknown as AppScene;
}

const OUTLINES = (ids: Array<{ id: string; stage?: { key: string; flowIndex: number } }>) =>
  ids.map((entry) => ({
    id: entry.id,
    ...(entry.stage ? { teachingStage: entry.stage } : {}),
  }));

describe('validateExactTeachingFlow (FRD §11.3)', () => {
  it('accepts [0,0,1,2,2] for flow [A,B,C] (repeated stage, collapsed exact)', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(3, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(4, { key: 'outcome_worked_examples', flowIndex: 2 }),
      scene(5, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    expect(validateExactTeachingFlow(scenes, FLOW).valid).toBe(true);
  });

  it('orders scenes by persisted order, not array position', () => {
    const scenes = [
      scene(2, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(3, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    expect(validateExactTeachingFlow(scenes, FLOW).valid).toBe(true);
  });

  it('rejects a scene missing teachingStage', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2),
      scene(3, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    const result = validateExactTeachingFlow(scenes, FLOW);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.violation.reason).toBe('missing_teaching_stage');
      expect(result.violation.offendingSceneIds).toEqual(['scene-2']);
    }
  });

  it('rejects a key that does not equal flow[flowIndex].stage', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2, { key: 'outcome_worked_examples', flowIndex: 1 }),
      scene(3, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    const result = validateExactTeachingFlow(scenes, FLOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violation.reason).toBe('key_index_mismatch');
  });

  it('rejects an out-of-range flowIndex', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(3, { key: 'outcome_worked_examples', flowIndex: 4 }),
    ];
    expect(validateExactTeachingFlow(scenes, FLOW).valid).toBe(false);
  });

  it('rejects a missing stage ([0,2,3])', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    const result = validateExactTeachingFlow(scenes, FLOW);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.violation.reason).toBe('missing_stage');
      expect(result.violation.actual).toEqual([0, 2]);
      expect(result.violation.expected).toEqual([0, 1, 2]);
    }
  });

  it('rejects a reordered sequence ([0,2,1,3] shape)', () => {
    const fourFlow: TeachingFlowEntry[] = [...FLOW, { stage: 'closing', instructions: 'x' }];
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2, { key: 'outcome_worked_examples', flowIndex: 2 }),
      scene(3, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(4, { key: 'closing', flowIndex: 3 }),
    ];
    expect(validateExactTeachingFlow(scenes, fourFlow).valid).toBe(false);
  });

  it('rejects stage re-entry ([0,1,1,0,2])', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(2, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(3, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(4, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(5, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    const result = validateExactTeachingFlow(scenes, FLOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violation.reason).toBe('stage_reentry');
  });

  it('rejects ambiguous scene order (duplicate order values)', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }),
      scene(1, { key: 'outcome_teaching_cards', flowIndex: 1 }),
      scene(2, { key: 'outcome_worked_examples', flowIndex: 2 }),
    ];
    const result = validateExactTeachingFlow(scenes, FLOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violation.reason).toBe('ambiguous_scene_order');
  });

  it('rejects a scene that disagrees with its linked outline', () => {
    const scenes = [
      scene(1, { key: 'lesson_introduction', flowIndex: 0 }, 'outline-1'),
      scene(2, { key: 'outcome_teaching_cards', flowIndex: 1 }, 'outline-2'),
      scene(3, { key: 'outcome_worked_examples', flowIndex: 2 }, 'outline-3'),
    ];
    const outlines = OUTLINES([
      { id: 'outline-1', stage: { key: 'lesson_introduction', flowIndex: 0 } },
      { id: 'outline-2', stage: { key: 'lesson_introduction', flowIndex: 0 } },
      { id: 'outline-3', stage: { key: 'outcome_worked_examples', flowIndex: 2 } },
    ]);
    const result = validateExactTeachingFlow(scenes, FLOW, outlines);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.violation.reason).toBe('outline_scene_mismatch');
  });

  it('rejects an empty flow and empty scenes explicitly', () => {
    expect(validateExactTeachingFlow([], FLOW).valid).toBe(false);
    expect(validateExactTeachingFlow([scene(1)], []).valid).toBe(false);
  });
});
