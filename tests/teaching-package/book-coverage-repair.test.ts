import { describe, expect, it, vi } from 'vitest';

import {
  BOOK_COVERAGE_INCOMPLETE,
  findBookCoverageDiagnostics,
} from '@/lib/server/teaching-package/book-coverage';
import {
  BOOK_COVERAGE_REPAIR_ROUNDS,
  repairBookCoverageGaps,
  type BookCoverageRepairContext,
} from '@/lib/server/teaching-package/book-coverage-repair';
import type { PlanInsertedSlideInput } from '@/lib/server/teaching-package/plan-inserted-slide';
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure, TeachingFlowEntry } from '@/lib/types/teaching-package';

// Lesson 1-1's shape for one part: example 3 and its check.
const BOOK: KafuoBookStructure = {
  templateVersionId: '2',
  rules: [
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'UNDERSTANDING_CHECK', element: 'try_it', required: true },
  ],
  units: [
    {
      contentUnitId: '4030',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 3,
    },
    {
      contentUnitId: '4032',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 3,
      pairedExampleUnitId: '4030',
    },
  ],
};

const FLOW = [
  { stage: 'outcome_visual_explanations', instructions: 'Teach the part.' },
] as unknown as TeachingFlowEntry[];

const STAGE = { key: 'outcome_visual_explanations', flowIndex: 0 };

function slide(id: string, units: string[], extra: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    slideType: 'content',
    contentRole: 'explanation',
    sourceContentUnitIds: units,
    teachingStage: STAGE,
    ...extra,
  } as SceneOutline;
}

// The paused lesson 306 candidate, reduced: example, try-it, then the next part.
const CANDIDATE = [
  slide('ex3', ['4030'], { contentRole: 'worked_example' }),
  slide('try3', ['4032'], { contentRole: 'check_understanding' }),
  slide('next', ['9999'], { slideType: 'transition' }),
];

function context(plan: BookCoverageRepairContext['plan']): BookCoverageRepairContext {
  return {
    book: BOOK,
    flow: FLOW,
    units: [
      { id: '4030', order: 18, role: 'WORKED_EXAMPLE', title: 'مثال 3', text: 'example text' },
      { id: '4032', order: 20, role: 'UNDERSTANDING_CHECK', title: 'تحقق', text: 'check text' },
    ],
    skillOptions: null,
    language: 'ar-SA',
    languageDirective: '',
    visuals: [],
    diagnose: (outlines) => ({
      outlines,
      blocking: findBookCoverageDiagnostics(outlines, BOOK),
    }),
    plan,
  };
}

/** A fake planner answering `role`, or with `'asked'` the role its instruction names. */
function planning(role: string) {
  return vi.fn(async (input: PlanInsertedSlideInput) => {
    const asked = /contentRole (\w+)/.exec(input.instruction)?.[1] ?? 'explanation';
    const outline = slide(input.outlineId, [...input.unitIds], {
      contentRole: (role === 'asked' ? asked : role) as SceneOutline['contentRole'],
      teachingStage: input.teachingStage,
    });
    const checked = input.check(outline);
    return checked.ok
      ? { ok: true as const, outline: checked.outline, repairs: [], calls: 1 }
      : { ok: false as const, code: 'INSERTION_PLAN_INVALID' as const, message: 'x', calls: 1 };
  });
}

const aiCall = vi.fn(async () => '{}');

describe('g5.v7 book coverage repair', () => {
  it('inserts the missing solution right after the try-it, and the gate then passes', async () => {
    const plan = planning('worked_example');
    const blocking = findBookCoverageDiagnostics(CANDIDATE, BOOK);
    expect(blocking.map((d) => d.code)).toEqual([BOOK_COVERAGE_INCOMPLETE]);

    const result = await repairBookCoverageGaps(CANDIDATE, blocking, aiCall, context(plan));

    expect(result.inserted).toBe(1);
    expect(result.blocking).toEqual([]);
    expect(result.outlines.map((o) => o.id)).toEqual([
      'ex3',
      'try3',
      'try3-book-missing_solution-4032-r1',
      'next',
    ]);
    const input = plan.mock.calls[0]![0];
    expect(input.unitIds).toEqual(['4032']);
    expect(input.units.map((u) => u.id)).toEqual(['4032', '4030']);
    expect(input.instruction).toContain('solution slide (contentRole worked_example)');
    expect(input.previousTitle).toBe('try3');
    expect(input.nextTitle).toBe('next');
    expect(result.outlines.map((o) => o.order)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the original issue when the planner cannot plan the slide', async () => {
    const plan = planning('explanation');
    const blocking = findBookCoverageDiagnostics(CANDIDATE, BOOK);

    const result = await repairBookCoverageGaps(CANDIDATE, blocking, aiCall, context(plan));

    expect(result.inserted).toBe(0);
    expect(result.blocking).toEqual(blocking);
    expect(result.outlines).toEqual(CANDIDATE);
  });

  it('stops after two rounds', async () => {
    // A diagnosis that never clears: every round re-finds the same gap.
    const plan = planning('worked_example');
    const stubborn = context(plan);
    const blocking = findBookCoverageDiagnostics(CANDIDATE, BOOK);
    stubborn.diagnose = () => ({ outlines: [...CANDIDATE], blocking });

    const result = await repairBookCoverageGaps(CANDIDATE, blocking, aiCall, stubborn);

    expect(plan).toHaveBeenCalledTimes(BOOK_COVERAGE_REPAIR_ROUNDS);
    expect(result.blocking).toEqual(blocking);
  });

  it('plans one try-it for a check that has neither try-it nor teaching slide', async () => {
    const plan = planning('asked');
    const candidate = [CANDIDATE[0]!, CANDIDATE[2]!];
    const blocking = findBookCoverageDiagnostics(candidate, BOOK);
    expect(blocking).toHaveLength(2);

    const result = await repairBookCoverageGaps(candidate, blocking, aiCall, context(plan));

    // Round 1 plans the one try-it; round 2 finds its solution missing and plans it.
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[0]![0].instruction).toContain('try-it slide');
    expect(result.outlines.map((o) => o.contentRole)).toEqual([
      'worked_example',
      'check_understanding',
      'worked_example',
      'explanation',
    ]);
    expect(result.blocking).toEqual([]);
  });

  it('offers the textbook visual linked to the unit and requires selecting it', async () => {
    const visual = { id: 'src-7', src: 'data:image/png;base64,AA', sourceContentUnitIds: ['4032'] };
    const other = { id: 'src-9', src: 'data:image/png;base64,AA', sourceContentUnitIds: ['5000'] };
    const plan = planning('worked_example');
    const ctx = { ...context(plan), visuals: [visual, other] };
    const blocking = findBookCoverageDiagnostics(CANDIDATE, BOOK);

    const result = await repairBookCoverageGaps(CANDIDATE, blocking, aiCall, ctx);

    const input = plan.mock.calls[0]![0];
    expect(input.eligibleVisuals.map((v) => v.id)).toEqual(['src-7']);
    expect(input.visionImages?.map((v) => v.id)).toEqual(['src-7']);
    // The fake selects no visual, so the check asks for it and nothing is inserted.
    expect(input.check(CANDIDATE[1]!)).toMatchObject({ ok: false, fixable: true });
    expect(result.inserted).toBe(0);
  });

  it('never repairs when another kind of issue also blocks', async () => {
    const plan = planning('worked_example');
    const blocking = [
      ...findBookCoverageDiagnostics(CANDIDATE, BOOK),
      { code: 'CONTENT_UNIT_UNGROUNDED', disposition: 'admin_correctable' as const, message: 'x' },
    ];

    const result = await repairBookCoverageGaps(CANDIDATE, blocking, aiCall, context(plan));

    expect(plan).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
    expect(result.blocking).toEqual(blocking);
  });
});
