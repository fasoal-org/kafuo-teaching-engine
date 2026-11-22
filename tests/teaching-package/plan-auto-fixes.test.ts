/**
 * The free rule fixes of a blocking plan (package-planner-issue-resolve-plan-2026-11-22
 * §3b step 1, owner 22 Nov 2026): a stage mismatch whose key names one flow position,
 * and the slides that break the flow order, fixed with no model call — each step kept
 * only when its re-diagnosis adds no new finding code.
 */
import { describe, expect, it, vi } from 'vitest';
import { teachingFlowDiagnostics, type OutlineDiagnostic } from '@openmaic/generation';

import { diagnoseCandidateOutlines } from '@/lib/server/teaching-package/outline-correction';
import {
  applyPlanAutoFixes,
  locateFlowOrderProblems,
  type PlanAutoFixContext,
} from '@/lib/server/teaching-package/plan-auto-fixes';
import { PLAN_REVIEWER_ACTOR } from '@/lib/server/teaching-package/plan-fix-records';
import type { SceneOutline } from '@/lib/types/generation';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';

/** A flow of `size` distinct stages with no scene policy: only the flow rules apply. */
function flowOf(size: number): TeachingFlowEntry[] {
  return Array.from({ length: size }, (_, flowIndex) => ({
    stage: `stage-${flowIndex}`,
    instructions: 'Teach.',
  }));
}

function flowNamed(stages: string[]): TeachingFlowEntry[] {
  return stages.map((stage) => ({ stage, instructions: 'Teach.' }));
}

function outlinesFor(
  stages: Array<number | null>,
  flow: readonly TeachingFlowEntry[] = flowOf(Math.max(0, ...stages.map((s) => s ?? 0)) + 1),
): SceneOutline[] {
  return stages.map((flowIndex, index) => ({
    id: `o-${index + 1}`,
    type: 'slide',
    title: `Slide ${index + 1}`,
    description: '',
    keyPoints: [],
    order: index + 1,
    ...(flowIndex === null ? {} : { teachingStage: { key: flow[flowIndex]!.stage, flowIndex } }),
  }));
}

const stagesOf = (outlines: readonly SceneOutline[]) =>
  outlines.map((outline) => outline.teachingStage?.flowIndex ?? null);
const codesOf = (diagnostics: readonly OutlineDiagnostic[]) =>
  diagnostics.map((diagnostic) => diagnostic.code);

/**
 * A diagnosis read from the outlines it is given: the package's own flow rules,
 * plus any `extra` codes a test adds to prove a rollback.
 */
function flowDiagnosis(
  flow: readonly TeachingFlowEntry[],
  extra: (candidate: SceneOutline[]) => OutlineDiagnostic[] = () => [],
) {
  return vi.fn((candidate: SceneOutline[]) => {
    const outlines = candidate.map((outline, index) => ({ ...outline, order: index + 1 }));
    return {
      outlines,
      blocking: [...teachingFlowDiagnostics(outlines, flow), ...extra(outlines)],
    };
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('locateFlowOrderProblems (parity with the admin explainer)', () => {
  // Lesson 206: slides 1–29, then the first goal's quiz (stage 3), then 31 (4) and 32 (5):
  // collapsed [0, 1, 2, 4, 3, 4, 5], expected [0, 1, 2, 3, 4, 5].
  const lesson206 = [0, 1, ...Array(13).fill(2), ...Array(14).fill(4), 3, 4, 5];

  it("finds lesson 206's first-goal quiz placed after the second goal's slides, and its place", () => {
    const problems = locateFlowOrderProblems(outlinesFor(lesson206), flowOf(6));
    expect(problems).toEqual({
      missing: [],
      misplaced: [
        // Position 16: right after slide 15, the last slide of stage index 2.
        {
          outlineId: 'o-30',
          flowIndex: 3,
          fromIndex: 29,
          toIndex: 15,
          conflict: { kind: 'after', flowIndex: 4 },
        },
      ],
    });
  });

  it('a move to the given position yields the exact flow order', () => {
    const outlines = outlinesFor(lesson206);
    const [quiz] = locateFlowOrderProblems(outlines, flowOf(6)).misplaced;
    const next = outlines.filter((outline) => outline.id !== quiz!.outlineId);
    next.splice(quiz!.toIndex, 0, outlines[quiz!.fromIndex]!);
    const order = stagesOf(next);
    expect(order.filter((value, index) => index === 0 || value !== order[index - 1])).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it('says when a slide comes too early, before the slides of an earlier stage', () => {
    const [early] = locateFlowOrderProblems(outlinesFor([0, 3, 1, 1, 2, 3]), flowOf(4)).misplaced;
    expect(early).toMatchObject({
      outlineId: 'o-2',
      fromIndex: 1,
      conflict: { kind: 'before', flowIndex: 1 },
      // After slide 6, the last slide of its own stage, in the list without slide 2.
      toIndex: 5,
    });
  });

  it('names a stage no slide covers, and finds nothing when the order is right', () => {
    expect(locateFlowOrderProblems(outlinesFor([0, 0, 2]), flowOf(3))).toEqual({
      misplaced: [],
      missing: [1],
    });
    expect(locateFlowOrderProblems(outlinesFor([0, 1, 1, 2]), flowOf(3))).toEqual({
      misplaced: [],
      missing: [],
    });
  });

  it('opens the lesson with a slide whose stage is earlier than every in-order slide', () => {
    const [first] = locateFlowOrderProblems(outlinesFor([1, 1, 2, 0]), flowOf(3)).misplaced;
    expect(first).toMatchObject({
      outlineId: 'o-4',
      fromIndex: 3,
      toIndex: 0,
      conflict: { kind: 'after', flowIndex: 2 },
    });
  });

  it('skips a slide without a stage but counts it in the move index', () => {
    const problems = locateFlowOrderProblems(outlinesFor([0, null, 2, 1]), flowOf(3));
    expect(problems.missing).toEqual([]);
    expect(problems.misplaced).toEqual([
      {
        outlineId: 'o-3',
        flowIndex: 2,
        fromIndex: 2,
        toIndex: 3,
        conflict: { kind: 'before', flowIndex: 1 },
      },
    ]);
  });
});

describe('applyPlanAutoFixes', () => {
  it('sets flowIndex from a stage key that names exactly one flow position', () => {
    const flow = flowNamed(['open', 'teach', 'practice', 'close']);
    const outlines = outlinesFor([0, 1, 2, 3], flow);
    outlines[2] = { ...outlines[2]!, teachingStage: { key: 'practice', flowIndex: 1 } };
    const diagnose = flowDiagnosis(flow);
    const blocking = teachingFlowDiagnostics(outlines, flow);
    expect(codesOf(blocking)).toEqual(['TEACHING_STAGE_MISMATCH']);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(result.blocking).toEqual([]);
    expect(result.outlines[2]!.teachingStage).toEqual({ key: 'practice', flowIndex: 2 });
    expect(result.fixes).toEqual([
      {
        op: 'set',
        outlineId: 'o-3',
        field: 'teachingStage',
        from: { key: 'practice', flowIndex: 1 },
        to: { key: 'practice', flowIndex: 2 },
        reason: expect.stringMatching(/[؀-ۿ]/),
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      },
    ]);
    expect(result.fixes[0]!.reason).not.toContain('Slide 3');
  });

  it('leaves a key naming several positions, or none, for the review layer', () => {
    // A flow may repeat a stage: "teach" names positions 1 and 3.
    const flow = flowNamed(['open', 'teach', 'practice', 'teach', 'close']);
    const outlines = outlinesFor([0, 1, 2, 3, 4], flow);
    outlines[2] = { ...outlines[2]!, teachingStage: { key: 'teach', flowIndex: 2 } };
    outlines[4] = { ...outlines[4]!, teachingStage: { key: 'review', flowIndex: 4 } };
    const blocking = teachingFlowDiagnostics(outlines, flow);
    expect(codesOf(blocking)).toEqual(['TEACHING_STAGE_MISMATCH', 'TEACHING_STAGE_MISMATCH']);
    const diagnose = flowDiagnosis(flow);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).not.toHaveBeenCalled();
    expect(result).toEqual({ outlines, blocking, fixes: [] });
  });

  it('moves the misplaced slide to its flow place and clears FLOW_SEQUENCE_INVALID', () => {
    const flow = flowOf(6);
    const outlines = outlinesFor([0, 1, 2, 4, 3, 4, 5], flow);
    const blocking = teachingFlowDiagnostics(outlines, flow);
    expect(codesOf(blocking)).toEqual(['FLOW_SEQUENCE_INVALID']);
    const diagnose = flowDiagnosis(flow);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(result.blocking).toEqual([]);
    expect(stagesOf(result.outlines)).toEqual([0, 1, 2, 3, 4, 4, 5]);
    expect(result.outlines.map((outline) => outline.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.fixes).toEqual([
      {
        op: 'move',
        outlineId: 'o-5',
        from: 4,
        to: 3,
        reason: expect.stringMatching(/[؀-ۿ]/),
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      },
    ]);
  });

  it("fixes lesson 206's order with one move to position 16", () => {
    const flow = flowOf(6);
    const outlines = outlinesFor([0, 1, ...Array(13).fill(2), ...Array(14).fill(4), 3, 4, 5], flow);
    const result = applyPlanAutoFixes(outlines, teachingFlowDiagnostics(outlines, flow), {
      flow,
      diagnose: flowDiagnosis(flow),
    });
    expect(result.blocking).toEqual([]);
    expect(result.fixes.map((fix) => [fix.op, fix.outlineId, fix.from, fix.to])).toEqual([
      ['move', 'o-30', 29, 15],
    ]);
  });

  it('moves several misplaced slides one at a time, each index read after the last move', () => {
    const flow = flowOf(4);
    const outlines = outlinesFor([0, 3, 1, 2, 0], flow);
    const diagnose = flowDiagnosis(flow);

    const result = applyPlanAutoFixes(outlines, teachingFlowDiagnostics(outlines, flow), {
      flow,
      diagnose,
    });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(result.blocking).toEqual([]);
    expect(result.outlines.map((outline) => outline.id)).toEqual([
      'o-1',
      'o-5',
      'o-3',
      'o-4',
      'o-2',
    ]);
    expect(result.fixes.map((fix) => [fix.op, fix.outlineId, fix.from, fix.to])).toEqual([
      ['move', 'o-2', 1, 3],
      ['move', 'o-5', 4, 1],
    ]);
    // Undone backwards, the records restore the plan exactly.
    const undone = [...result.outlines];
    for (const fix of [...result.fixes].reverse()) {
      const [slide] = undone.splice(fix.to as number, 1);
      undone.splice(fix.from as number, 0, slide!);
    }
    expect(undone.map((outline) => outline.id)).toEqual(outlines.map((outline) => outline.id));
  });

  it('fixes a stage key, then moves the slide the fixed stage puts out of order', () => {
    // The mismatch hid the order check; once the stage is valid it shows, and step 2 fixes it.
    const flow = flowNamed(['open', 'teach', 'practice', 'close']);
    const outlines = outlinesFor([0, 1, 1, 3], flow);
    outlines[1] = { ...outlines[1]!, teachingStage: { key: 'practice', flowIndex: 1 } };
    const blocking = teachingFlowDiagnostics(outlines, flow);
    expect(codesOf(blocking)).toEqual(['TEACHING_STAGE_MISMATCH']);
    const diagnose = flowDiagnosis(flow);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(result.blocking).toEqual([]);
    expect(result.outlines.map((outline) => outline.id)).toEqual(['o-1', 'o-3', 'o-2', 'o-4']);
    expect(result.fixes.map((fix) => [fix.op, fix.outlineId, fix.from, fix.to])).toEqual([
      ['set', 'o-2', { key: 'practice', flowIndex: 1 }, { key: 'practice', flowIndex: 2 }],
      ['move', 'o-3', 2, 1],
    ]);
  });

  it('rolls a step back, unrecorded, when its re-diagnosis brings a new code', () => {
    const flow = flowOf(6);
    const outlines = outlinesFor([0, 1, 2, 4, 3, 4, 5], flow);
    const blocking = teachingFlowDiagnostics(outlines, flow);
    // A move that, say, takes recall off the first place of its part.
    const diagnose = flowDiagnosis(flow, (candidate) =>
      candidate[3]!.id === 'o-5'
        ? [{ code: 'RECALL_NOT_FIRST', disposition: 'admin_correctable', message: 'recall' }]
        : [],
    );

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outlines, blocking, fixes: [] });
  });

  it('rolls the stage fix back when the fixed slide breaks its stage policy', () => {
    const flow = flowNamed(['open', 'teach', 'practice', 'close']);
    const outlines = outlinesFor([0, 1, 2, 3], flow);
    outlines[2] = { ...outlines[2]!, teachingStage: { key: 'practice', flowIndex: 1 } };
    const blocking = teachingFlowDiagnostics(outlines, flow);
    const diagnose = flowDiagnosis(flow, (candidate) =>
      candidate[2]!.teachingStage?.flowIndex === 2
        ? [{ code: 'SLIDE_TYPE_NOT_ALLOWED', disposition: 'admin_correctable', message: 'type' }]
        : [],
    );

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outlines, blocking, fixes: [] });
  });

  it('rolls the stage fix back when the key puts a second slide into a one-slide stage', () => {
    // The key, not the slide, is likely wrong: P2 corrects it with a `set`, never a delete.
    const flow: TeachingFlowEntry[] = [
      {
        stage: 'open',
        instructions: 'Open.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
      },
      {
        stage: 'teach',
        instructions: 'Teach.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
      },
      {
        stage: 'close',
        instructions: 'Close.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
      },
    ];
    const outlines = outlinesFor([0, 1, 1, 2], flow);
    outlines[1] = { ...outlines[1]!, teachingStage: { key: 'open', flowIndex: 1 } };
    const blocking = teachingFlowDiagnostics(outlines, flow);
    expect(codesOf(blocking)).toEqual(['TEACHING_STAGE_MISMATCH']);
    const diagnose = flowDiagnosis(flow);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(codesOf(diagnose.mock.results[0]!.value.blocking)).toEqual(['POSITION_CARDINALITY']);
    expect(result).toEqual({ outlines, blocking, fixes: [] });
  });

  it('keeps a step whose open issues stay, as long as no new code appears', () => {
    const flow = flowOf(6);
    const outlines = outlinesFor([0, 1, 2, 4, 3, 4, 5], flow);
    const grounding: OutlineDiagnostic = {
      code: 'GROUNDING_MISSING',
      disposition: 'admin_correctable',
      outlineId: 'o-1',
      message: 'grounding',
    };
    const blocking = [...teachingFlowDiagnostics(outlines, flow), grounding];
    const diagnose = flowDiagnosis(flow, () => [grounding]);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(codesOf(result.blocking)).toEqual(['GROUNDING_MISSING']);
    expect(result.fixes).toHaveLength(1);
  });

  it('calls no diagnosis when nothing it fixes is open', () => {
    const flow = flowOf(3);
    const diagnose = flowDiagnosis(flow);
    const issue = (code: string): OutlineDiagnostic => ({
      code,
      disposition: 'admin_correctable',
      message: code,
    });
    const outlines = outlinesFor([0, 1, 1, 2], flow);
    for (const blocking of [
      [],
      [issue('GROUNDING_MISSING'), issue('POSITION_CARDINALITY'), issue('NO_OUTLINES')],
    ]) {
      expect(applyPlanAutoFixes(outlines, blocking, { flow, diagnose })).toEqual({
        outlines,
        blocking,
        fixes: [],
      });
    }
    // The order is wrong only because a stage has no slide: no move can fix that.
    const gap = outlinesFor([0, 0, 2], flow);
    const gapBlocking = teachingFlowDiagnostics(gap, flow);
    expect(codesOf(gapBlocking)).toEqual(['FLOW_SEQUENCE_INVALID']);
    expect(applyPlanAutoFixes(gap, gapBlocking, { flow, diagnose }).fixes).toEqual([]);
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('never mutates the outlines or the diagnostics it is given', () => {
    const flow = flowNamed(['open', 'teach', 'practice', 'close']);
    const outlines = outlinesFor([0, 1, 1, 3], flow);
    outlines[1] = { ...outlines[1]!, teachingStage: { key: 'practice', flowIndex: 1 } };
    const blocking = teachingFlowDiagnostics(outlines, flow);
    const before = structuredClone({ outlines, blocking });
    deepFreeze(outlines);
    deepFreeze(blocking);
    const context: PlanAutoFixContext = { flow, diagnose: flowDiagnosis(flow) };

    const result = applyPlanAutoFixes(outlines, blocking, context);

    expect(result.fixes).toHaveLength(2);
    expect({ outlines, blocking }).toEqual(before);
    expect(result.outlines).not.toBe(outlines);
  });
});

describe('applyPlanAutoFixes with the real diagnosis', () => {
  const flow: TeachingFlowEntry[] = [
    {
      stage: 'lesson_opener',
      instructions: 'Open.',
      scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
    },
    {
      stage: 'explain',
      instructions: 'Teach.',
      scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
    },
    {
      stage: 'practice',
      instructions: 'Practise.',
      scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
    },
    {
      stage: 'lesson_closure',
      instructions: 'Close.',
      scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
    },
  ];
  const slide = (id: string, key: string, flowIndex: number): SceneOutline => ({
    id,
    type: 'slide',
    slideType: 'content',
    contentRole: 'explanation',
    contentKind: 'concept',
    title: id,
    description: '',
    keyPoints: [],
    order: 1,
    teachingStage: { key, flowIndex },
  });
  const context = { flow, sourceImages: [], contentUnitIds: null, governed: false };
  const diagnose = (candidate: SceneOutline[]) => {
    const diagnosis = diagnoseCandidateOutlines(candidate, context);
    return { outlines: diagnosis.outlines, blocking: diagnosis.blocking };
  };

  it('fixes a mismatched stage key and the order it then shows, leaving the plan clean', () => {
    const outlines = [
      slide('o-1', 'lesson_opener', 0),
      slide('o-2', 'practice', 1),
      slide('o-3', 'explain', 1),
      slide('o-4', 'lesson_closure', 3),
    ];
    const blocking = diagnose(outlines).blocking;
    expect(codesOf(blocking)).toEqual(['TEACHING_STAGE_MISMATCH']);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(result.blocking).toEqual([]);
    expect(result.outlines.map((outline) => [outline.id, outline.teachingStage])).toEqual([
      ['o-1', { key: 'lesson_opener', flowIndex: 0 }],
      ['o-3', { key: 'explain', flowIndex: 1 }],
      ['o-2', { key: 'practice', flowIndex: 2 }],
      ['o-4', { key: 'lesson_closure', flowIndex: 3 }],
    ]);
    expect(result.fixes.map((fix) => [fix.op, fix.outlineId])).toEqual([
      ['set', 'o-2'],
      ['move', 'o-3'],
    ]);
  });

  it('rolls everything back when the order the stage fix uncovers cannot be cleared by a move', () => {
    // o-2's key says `explain` (index 1), but its index says `practice` (2). Trusting the
    // key leaves `practice` with no slide, which no move can fix: the key was likely the
    // wrong field, so the plan stays as it was and the mismatch stays open (P2 / a person).
    const outlines = [
      slide('o-1', 'lesson_opener', 0),
      slide('o-x', 'explain', 1),
      slide('o-2', 'explain', 2),
      slide('o-4', 'lesson_closure', 3),
    ];
    const blocking = diagnose(outlines).blocking;
    expect(codesOf(blocking)).toEqual(['TEACHING_STAGE_MISMATCH']);

    const result = applyPlanAutoFixes(outlines, blocking, { flow, diagnose });

    expect(result.fixes).toEqual([]);
    expect(result.outlines).toEqual(outlines);
    expect(codesOf(result.blocking)).toEqual(['TEACHING_STAGE_MISMATCH']);
  });
});
