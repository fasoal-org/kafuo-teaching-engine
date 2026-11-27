import { describe, expect, it } from 'vitest';

import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import {
  readDroppedCheckQuizOutlineIds,
  validateExactTeachingFlow,
} from '@/lib/server/teaching-package/exact-flow';
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
    content: {
      type: 'slide',
      canvas: { id: 'c', viewportSize: 1000, viewportRatio: 0.5, theme: {} as never, elements: [] },
    },
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

describe('g5.v12 (QZ-2, decision A-32): a dropped check quiz', () => {
  const V12_FLOW: TeachingFlowEntry[] = [
    { stage: 'lesson_opener', instructions: 'o' },
    { stage: 'outcome_visual_explanations', instructions: 'v' },
    { stage: 'outcome_check_understanding', instructions: 'q' },
    { stage: 'outcome_visual_explanations', instructions: 'v' },
    { stage: 'outcome_check_understanding', instructions: 'q' },
  ];
  const scenes = [
    scene(1, { key: 'lesson_opener', flowIndex: 0 }),
    scene(2, { key: 'outcome_visual_explanations', flowIndex: 1 }),
    scene(3, { key: 'outcome_visual_explanations', flowIndex: 3 }),
    scene(4, { key: 'outcome_check_understanding', flowIndex: 4 }),
  ];
  const marked = (flowIndex: number, key: string) => ({
    id: `dropped-${flowIndex}`,
    teachingStage: { key, flowIndex },
    checkQuizDropped: { reason: 'unverified_answer_key', sceneId: `s-${flowIndex}` },
  });

  // The run's own record of what it dropped (fresh review finding 4).
  const recorded = new Set(['dropped-2', 'dropped-3']);

  it('its marked, recorded, empty check position passes', () => {
    expect(
      validateExactTeachingFlow(
        scenes,
        V12_FLOW,
        [marked(2, 'outcome_check_understanding')],
        recorded,
      ).valid,
    ).toBe(true);
  });

  it('without the marker, or a marker on a teaching position, the gate refuses as before', () => {
    expect(validateExactTeachingFlow(scenes, V12_FLOW, undefined, recorded).valid).toBe(false);
    const noTeaching = scenes.filter((entry) => entry.teachingStage?.flowIndex !== 3);
    expect(
      validateExactTeachingFlow(
        noTeaching,
        V12_FLOW,
        [marked(2, 'outcome_check_understanding'), marked(3, 'outcome_visual_explanations')],
        recorded,
      ).valid,
    ).toBe(false);
  });

  it('a marker the server never recorded (an outline write) is not exempt', () => {
    const outlines = [marked(2, 'outcome_check_understanding')];
    expect(validateExactTeachingFlow(scenes, V12_FLOW, outlines).valid).toBe(false);
    expect(validateExactTeachingFlow(scenes, V12_FLOW, outlines, new Set()).valid).toBe(false);
    expect(
      validateExactTeachingFlow(scenes, V12_FLOW, outlines, new Set(['dropped-4'])).valid,
    ).toBe(false);
  });
});

describe('readDroppedCheckQuizOutlineIds (A-32)', () => {
  const V12 = { key: 'g5', version: 'g5.v12' };
  const dropped = [
    { sceneId: 's', outlineId: 'q1', flowIndex: 2, reason: 'unverified_answer_key' },
  ];
  // versions: id → [current_attempt_id, predecessor_version_id]; attempts: id → snapshot.
  const fakeTx = (
    versions: Record<string, [string | null, string | null]>,
    attempts: Record<string, unknown>,
  ) => ({
    query: async (sql: string, params: unknown[]) => {
      const id = params[0] as string;
      if (/FROM teaching_package_versions/.test(sql)) {
        const row = versions[id];
        return {
          rows: row ? [{ current_attempt_id: row[0], predecessor_version_id: row[1] }] : [],
        };
      }
      return { rows: id in attempts ? [{ input_snapshot: attempts[id] }] : [] };
    },
  });

  it('reads the producing attempt record on g5.v12', async () => {
    const tx = fakeTx({ v1: ['a1', null] }, { a1: { droppedCheckQuizzes: dropped } });
    expect([
      ...(await readDroppedCheckQuizOutlineIds(tx as never, { id: 'v1', teachingModel: V12 })),
    ]).toEqual(['q1']);
  });

  it('a successor clone inherits its predecessor attempt record', async () => {
    const tx = fakeTx(
      { v2: [null, 'v1'], v1: ['a1', null] },
      { a1: { droppedCheckQuizzes: dropped } },
    );
    expect([
      ...(await readDroppedCheckQuizOutlineIds(tx as never, { id: 'v2', teachingModel: V12 })),
    ]).toEqual(['q1']);
  });

  it('is empty on every other model, and with no record', async () => {
    const tx = fakeTx({ v1: ['a1', null] }, { a1: { droppedCheckQuizzes: dropped } });
    const v11 = { key: 'g5', version: 'g5.v11' };
    expect(
      (await readDroppedCheckQuizOutlineIds(tx as never, { id: 'v1', teachingModel: v11 })).size,
    ).toBe(0);
    const bare = fakeTx({ v1: ['a1', null] }, { a1: {} });
    expect(
      (await readDroppedCheckQuizOutlineIds(bare as never, { id: 'v1', teachingModel: V12 })).size,
    ).toBe(0);
  });
});
