/**
 * The record of the plan review's automatic fixes (package-planner-issue-
 * resolve-plan-2026-11-22 §3b; prompt P1 item 3).
 */
import { describe, expect, it } from 'vitest';

import {
  bookRepairFixes,
  MAX_PLAN_FIXES,
  PLAN_REVIEWER_ACTOR,
  recordedPlanFixes,
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
