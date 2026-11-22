/**
 * The record of the plan review's automatic fixes (package-planner-issue-
 * resolve-plan-2026-11-22 §3b; prompt P1 item 3).
 */
import { describe, expect, it } from 'vitest';

import {
  autoFixesOf,
  bookRepairFixes,
  MAX_PLAN_FIXES,
  PLAN_REVIEW_STALE_MS,
  PLAN_REVIEWER_ACTOR,
  planReviewStatusOf,
  recordedPlanFixes,
  revertPlanFix,
  withoutUndoState,
  withPlanFixes,
} from '@/lib/server/teaching-package/plan-fix-records';
import type { SceneOutline } from '@/lib/types/generation';
import type { PlanReviewFix } from '@/lib/types/teaching-package';

const slide = (id: string, extra: Record<string, unknown> = {}): SceneOutline =>
  ({
    id,
    type: 'slide',
    title: `title ${id}`,
    description: '',
    keyPoints: ['a'],
    order: 1,
    ...extra,
  }) as unknown as SceneOutline;

describe('bookRepairFixes', () => {
  it('records an added slide, a removed slide in full with its old index, and each changed field', () => {
    const before = [slide('a'), slide('dup', { keyPoints: ['x'] }), slide('b')];
    const after = [
      slide('a', { order: 1 }),
      slide('a-book-missing_teaching-1-r1', { order: 2 }),
      slide('b', { order: 3, keyPoints: ['a', 'merged'] }),
    ];

    const fixes = bookRepairFixes(before, after);

    expect(fixes).toEqual([
      {
        op: 'remove',
        outlineId: 'dup',
        from: { index: 1, outline: before[1] },
        reason: expect.any(String),
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      },
      {
        op: 'insert_book_slide',
        outlineId: 'a-book-missing_teaching-1-r1',
        to: 1,
        reason: expect.any(String),
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      },
      {
        op: 'set',
        outlineId: 'b',
        field: 'keyPoints',
        from: ['a'],
        to: ['a', 'merged'],
        reason: expect.any(String),
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      },
    ]);
    // Plain Arabic reasons, and no lesson text in them.
    for (const fix of fixes) {
      expect(fix.reason).toMatch(/[؀-ۿ]/);
      expect(fix.reason).not.toContain('title');
    }
  });

  it('lists removes highest old index first, so an undo walked backwards re-inserts them in place', () => {
    const fixes = bookRepairFixes([slide('x'), slide('y'), slide('z')], [slide('y')]);
    expect(
      fixes.map((fix) => [fix.op, fix.outlineId, (fix.from as { index: number }).index]),
    ).toEqual([
      ['remove', 'z', 2],
      ['remove', 'x', 0],
    ]);
  });

  it('records a kept slide that changed its place among the kept ones as a move (the g5.v8 recall first)', () => {
    const fixes = bookRepairFixes(
      [slide('a'), slide('b'), slide('recall')],
      [slide('recall'), slide('a'), slide('b')],
    );
    expect(fixes).toEqual([
      {
        op: 'move',
        outlineId: 'recall',
        from: 2,
        to: 0,
        reason: expect.stringMatching(/[؀-ۿ]/),
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      },
    ]);
    // A slide that only shifted because one was added before it did not move.
    expect(
      bookRepairFixes([slide('a'), slide('b')], [slide('new'), slide('a'), slide('b')]).map(
        (fix) => fix.op,
      ),
    ).toEqual(['insert_book_slide']);
  });

  /** Undo `fixes` walking backwards, as the P3 «تراجع» will, and return the slide ids. */
  function undoAll(after: readonly SceneOutline[], fixes: ReturnType<typeof bookRepairFixes>) {
    const plan = after.map((outline) => outline.id);
    for (const fix of [...fixes].reverse()) {
      if (fix.op === 'insert_book_slide') plan.splice(fix.to as number, 1);
      if (fix.op === 'move') {
        plan.splice(fix.to as number, 1);
        plan.splice(fix.from as number, 0, fix.outlineId);
      }
      if (fix.op === 'remove') {
        plan.splice((fix.from as { index: number }).index, 0, fix.outlineId);
      }
    }
    return plan;
  }

  it.each([
    ['insert + move', ['a', 'b', 'recall'], ['recall', 'new', 'a', 'b']],
    ['remove + move', ['a', 'dup', 'b', 'recall'], ['recall', 'a', 'b']],
    ['remove + move + insert', ['x', 'a', 'dup', 'b', 'recall'], ['recall', 'a', 'n1', 'b', 'n2']],
    ['two moves around unplaced slides', ['p', 'q', 'a', 'b'], ['a', 'p', 'b', 'q']],
    ['moves only', ['a', 'b', 'c', 'd'], ['d', 'c', 'a', 'b']],
  ])(
    'an undo walked backwards restores the old plan exactly (%s)',
    (_label, beforeIds, afterIds) => {
      const before = beforeIds.map((id) => slide(id));
      const after = afterIds.map((id) => slide(id));
      const fixes = bookRepairFixes(before, after);
      expect(undoAll(after, fixes)).toEqual(beforeIds);
      // Each step replayed forwards from the old plan gives the new one.
      const forward = [...beforeIds];
      for (const fix of fixes) {
        if (fix.op === 'remove') forward.splice((fix.from as { index: number }).index, 1);
        if (fix.op === 'move') {
          forward.splice(fix.from as number, 1);
          forward.splice(fix.to as number, 0, fix.outlineId);
        }
        if (fix.op === 'insert_book_slide') forward.splice(fix.to as number, 0, fix.outlineId);
      }
      expect(forward).toEqual(afterIds);
    },
  );

  it('a renumbered order alone is no change', () => {
    expect(bookRepairFixes([slide('a', { order: 4 })], [slide('a', { order: 1 })])).toEqual([]);
  });
});

describe('recordedPlanFixes and withPlanFixes', () => {
  const draft = {
    op: 'move' as const,
    outlineId: 'a',
    from: 3,
    to: 1,
    reason: 'نقل',
    actor: PLAN_REVIEWER_ACTOR,
    round: 0,
  };

  it('stamps an id, the run and the time', () => {
    const [fix] = recordedPlanFixes([draft], 2, 1_000);
    expect(fix).toEqual({
      ...draft,
      id: expect.stringMatching(/^tpf-/),
      generationRun: 2,
      at: 1_000,
    });
    const [other] = recordedPlanFixes([draft], 2, 1_000);
    expect(other!.id).not.toBe(fix!.id);
  });

  it('keeps only the current run, appends in order, and caps at the newest MAX_PLAN_FIXES', () => {
    const run1 = recordedPlanFixes([draft], 1);
    const run2 = recordedPlanFixes([draft, { ...draft, outlineId: 'b' }], 2);
    expect(withPlanFixes({ fixes: run1 }, run2, 2).fixes).toEqual(run2);
    expect(withPlanFixes({ fixes: run2.slice(0, 1) }, run2.slice(1), 2).fixes).toEqual(run2);
    expect(withPlanFixes(undefined, run1, 1).fixes).toEqual(run1);

    const many = recordedPlanFixes(
      Array.from({ length: MAX_PLAN_FIXES + 5 }, (_, index) => ({
        ...draft,
        outlineId: `o${index}`,
      })),
      1,
    );
    const capped = withPlanFixes(undefined, many, 1).fixes;
    expect(capped).toHaveLength(MAX_PLAN_FIXES);
    expect(capped[0]!.outlineId).toBe('o5');
  });

  it('never shows the undo state to a browser', () => {
    const [fix] = recordedPlanFixes(
      [{ ...draft, op: 'remove', from: { index: 1, outline: {} } }],
      1,
    );
    const visible = withoutUndoState(fix as PlanReviewFix);
    expect(visible).not.toHaveProperty('from');
    expect(visible).not.toHaveProperty('to');
    expect(visible).toMatchObject({ op: 'remove', outlineId: 'a', reason: 'نقل' });
  });
});

describe('P3: the review status, the view list and the undo', () => {
  const paused = (extra: Record<string, unknown> = {}) => ({
    event: 'paused',
    at: 1_000,
    ...extra,
  });

  it('tells a plan paused before the review from a reviewed or running one', () => {
    expect(planReviewStatusOf([paused()])).toBe('not_reviewed');
    expect(planReviewStatusOf([paused({ planReviewed: true })])).toBe('reviewed');
    const started = { event: 'edited', at: 10_000, planReview: 'started' as const };
    expect(planReviewStatusOf([paused(), started], 10_000 + 60_000)).toBe('reviewing');
    // A review whose process died is not stuck forever.
    expect(planReviewStatusOf([paused(), started], 10_000 + PLAN_REVIEW_STALE_MS)).toBe(
      'not_reviewed',
    );
    expect(
      planReviewStatusOf([
        paused(),
        started,
        { event: 'edited', at: 20_000, planReview: 'finished' },
      ]),
    ).toBe('reviewed');
  });

  it('lists every fix without its values, and marks the undone ones', () => {
    const [move, set] = recordedPlanFixes(
      [
        {
          op: 'move',
          outlineId: 'a',
          from: 2,
          to: 0,
          reason: 'نقل',
          actor: PLAN_REVIEWER_ACTOR,
          round: 0,
        },
        {
          op: 'set',
          outlineId: 'b',
          field: 'contentRole',
          from: 'procedure',
          to: 'explanation',
          reason: 'دور',
          actor: PLAN_REVIEWER_ACTOR,
          round: 1,
        },
      ],
      1,
      5,
    );
    const list = autoFixesOf([
      paused({ planReviewed: true, planFixes: [move] }),
      { event: 'edited', at: 6, planFixes: [set] },
      { event: 'edited', at: 7, operations: [{ op: 'revert_fix', fixId: move!.id }] },
    ]);
    expect(list).toEqual([
      { id: move!.id, op: 'move', outlineId: 'a', reason: 'نقل', round: 0, at: 5, reverted: true },
      {
        id: set!.id,
        op: 'set',
        outlineId: 'b',
        field: 'contentRole',
        reason: 'دور',
        round: 1,
        at: 5,
        reverted: false,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain('procedure');
  });

  it('undoes each kind of fix, and refuses when the plan no longer holds what it needs', () => {
    const plan = [slide('a'), slide('b', { contentRole: 'explanation' }), slide('c')];
    const ids = (outlines: SceneOutline[] | null) => outlines?.map((outline) => outline.id);

    expect(ids(revertPlanFix(plan, { op: 'move', outlineId: 'c', from: 0 }))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(ids(revertPlanFix(plan, { op: 'insert_book_slide', outlineId: 'b' }))).toEqual([
      'a',
      'c',
    ]);
    const removed = slide('x');
    expect(
      ids(
        revertPlanFix(plan, { op: 'remove', outlineId: 'x', from: { index: 1, outline: removed } }),
      ),
    ).toEqual(['a', 'x', 'b', 'c']);
    // The old index is clamped.
    expect(
      ids(
        revertPlanFix(plan, {
          op: 'remove',
          outlineId: 'x',
          from: { index: 99, outline: removed },
        }),
      ),
    ).toEqual(['a', 'b', 'c', 'x']);
    const set = revertPlanFix(plan, {
      op: 'set',
      outlineId: 'b',
      field: 'contentRole',
      from: 'procedure',
    })!;
    expect(set[1]!.contentRole).toBe('procedure');
    // An absent old value removes the field.
    const cleared = revertPlanFix(plan, { op: 'set', outlineId: 'b', field: 'contentRole' })!;
    expect(cleared[1]).not.toHaveProperty('contentRole');
    // The input is never mutated.
    expect(plan[1]!.contentRole).toBe('explanation');

    expect(revertPlanFix(plan, { op: 'move', outlineId: 'gone', from: 0 })).toBeNull();
    expect(
      revertPlanFix(plan, {
        op: 'remove',
        outlineId: 'a',
        from: { index: 0, outline: slide('a') },
      }),
    ).toBeNull();
  });
});
