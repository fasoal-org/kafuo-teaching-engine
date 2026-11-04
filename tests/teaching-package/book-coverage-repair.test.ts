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

  it('leaves a check solved before its try-it to a person', async () => {
    const plan = planning('worked_example');
    const candidate = [
      slide('ex3', ['4030', '4032'], { contentRole: 'worked_example' }),
      ...CANDIDATE.slice(1),
    ];
    const blocking = findBookCoverageDiagnostics(candidate, BOOK);
    expect(blocking.map((d) => d.message)).toEqual([
      'UNDERSTANDING_CHECK 4032 in part 3 is solved on a slide before its try-it slide',
      'UNDERSTANDING_CHECK 4032 in part 3 has a try-it slide but no solution slide after it',
    ]);

    const result = await repairBookCoverageGaps(candidate, blocking, aiCall, context(plan));

    expect(plan).not.toHaveBeenCalled();
    expect(result.blocking).toEqual(blocking);
  });

  describe('g5.v8 checks after a worked example (lessons 314/315/318)', () => {
    // «مسائل تدريبية» 5382 after example 5379; 5375 opens part 1 with no slide
    // before it, so its gap has no anchor and stays a person's.
    const V8 = {
      templateVersionId: '2',
      teacherParity: true,
      rules: BOOK.rules,
      units: [
        {
          contentUnitId: '5375',
          kind: 'CONCEPT',
          element: 'concept',
          required: true,
          partIndex: 1,
        },
        {
          contentUnitId: '5379',
          kind: 'WORKED_EXAMPLE',
          element: 'worked_example',
          required: true,
          partIndex: 1,
        },
        {
          contentUnitId: '5382',
          kind: 'PRACTICE_PROBLEMS',
          element: 'try_it',
          required: true,
          partIndex: 1,
          pairedExampleUnitId: '5379',
        },
      ],
    } as unknown as KafuoBookStructure & { teacherParity: true };
    const V8_FLOW = [
      {
        stage: 'outcome_visual_explanations',
        instructions: 'Teach the part.',
        scenePolicy: {
          sceneTypes: ['slide'],
          visual: 'required',
          cardinality: 'one_or_more',
          contentRoles: ['explanation', 'worked_example', 'check_understanding'],
        },
      },
    ] as unknown as TeachingFlowEntry[];
    const candidate = [
      slide('ex', ['5379'], { contentRole: 'worked_example', title: 'مثال 1: طاقة الفوتون' }),
      slide('next', ['9999'], { slideType: 'transition' }),
    ];
    function v8Context(plan: BookCoverageRepairContext['plan']): BookCoverageRepairContext {
      return {
        ...context(plan),
        book: V8,
        flow: V8_FLOW,
        units: [
          { id: '5379', order: 1, role: 'WORKED_EXAMPLE', title: 'مثال 1', text: 'example' },
          {
            id: '5382',
            order: 2,
            role: 'PRACTICE_PROBLEMS',
            title: 'مسائل تدريبية',
            text: 'احسب طاقة فوتون\nتردده 5 × 10^14 Hz',
          },
        ],
        diagnose: (outlines) => ({ outlines, blocking: findBookCoverageDiagnostics(outlines, V8) }),
      };
    }
    const failing = vi.fn(async () => ({
      ok: false as const,
      code: 'INSERTION_PLAN_INVALID' as const,
      message: 'the slide could not be planned (timeout)',
      calls: 1,
    }));

    it('builds the try-it and its solution from the book when the planner fails', async () => {
      const blocking = findBookCoverageDiagnostics(candidate, V8);
      expect(blocking.map((d) => d.message)).toContain(
        'PRACTICE_PROBLEMS 5382 in part 1 (the check after example 5379) has no try-it slide',
      );

      const result = await repairBookCoverageGaps(candidate, blocking, aiCall, v8Context(failing));

      expect(result.inserted).toBe(2);
      expect(result.outlines.map((o) => [o.id, o.contentRole])).toEqual([
        ['ex', 'worked_example'],
        ['ex-book-missing_try_it-5382-r1', 'check_understanding'],
        ['ex-book-missing_try_it-5382-r1-book-missing_solution-5382-r1', 'worked_example'],
        ['next', 'explanation'],
      ]);
      const [tryIt, solution] = [result.outlines[1]!, result.outlines[2]!];
      expect(tryIt.title).toBe('جرّب: مسائل تدريبية');
      expect(tryIt.keyPoints).toEqual(['احسب طاقة فوتون', 'تردده 5 × 10^14 Hz']);
      expect(tryIt.sourceContentUnitIds).toEqual(['5382']);
      expect(solution.title).toBe('الحل: مسائل تدريبية');
      // A required visual is a native diagram with a complete note.
      expect(solution.visualPlan).toEqual({
        mode: 'native',
        diagram: { shows: 'الحل: مسائل تدريبية', teachingPoint: 'احسب طاقة فوتون' },
      });
      // The check is covered; only the unanchored 5375 gap is left to a person.
      expect(result.blocking.map((d) => d.message)).toEqual([
        'CONCEPT 5375 in part 1 has no teaching slide',
      ]);
    });

    it('M-3/L-5: the try-it keeps every line of the check and never a verse item', async () => {
      const VERSE = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
      const lines = [
        'عيّن التابع فيما يأتي:',
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => `${n}) بيت ${n}`),
      ];
      const base = v8Context(failing);
      const ctx: BookCoverageRepairContext = {
        ...base,
        units: base.units.map((unit) =>
          unit.id === '5382' ? { ...unit, text: [...lines, `8) ${VERSE}`].join('\n') } : unit,
        ),
      };
      failing.mockClear();
      const blocking = findBookCoverageDiagnostics(candidate, V8);
      const result = await repairBookCoverageGaps(candidate, blocking, aiCall, ctx);

      const tryIt = result.outlines.find((o) => o.contentRole === 'check_understanding')!;
      expect(tryIt.keyPoints!.length).toBeLessThanOrEqual(6);
      const shown = tryIt.keyPoints!.join('\n');
      for (const line of lines) expect(shown).toContain(line);
      expect(JSON.stringify(result.outlines)).not.toMatch(/[﴾﴿]/);
      // The planner was never handed the verse item either.
      const planned = JSON.stringify(failing.mock.calls.map((call) => (call as unknown[])[0]));
      expect(planned).toContain('بيت 7');
      expect(planned).not.toMatch(/[﴾﴿]/);
    });

    it('F-8 M-3: the repair strips verse and hadith items from the unit text before the planner and the fallback', async () => {
      const HADITH = 'قال رسول الله ﷺ: «إنما الأعمال بالنيات، وإنما لكل امرئ ما نوى»';
      const VERSE = '﴿قُلْ هُوَ اللَّهُ أَحَدٌ﴾';
      const text = [
        'عيّن النعت فيما يأتي:',
        `1) ${VERSE}`,
        '2) جاء الطالب المجتهد',
        `3) ${HADITH}`,
      ].join('\n');
      const base = v8Context(failing);
      const ctx: BookCoverageRepairContext = {
        ...base,
        units: base.units.map((unit) => (unit.id === '5382' ? { ...unit, text } : unit)),
      };
      failing.mockClear();
      const result = await repairBookCoverageGaps(
        candidate,
        findBookCoverageDiagnostics(candidate, V8),
        aiCall,
        ctx,
      );
      const tryIt = result.outlines.find((o) => o.contentRole === 'check_understanding')!;
      expect(tryIt.keyPoints).toEqual(['عيّن النعت فيما يأتي:', '2) جاء الطالب المجتهد']);
      const planned = JSON.stringify(failing.mock.calls.map((call) => (call as unknown[])[0]));
      expect(planned).toContain('جاء الطالب المجتهد');
      expect(planned).not.toMatch(/[﴾﴿]|إنما الأعمال/);
      expect(JSON.stringify(result.outlines)).not.toMatch(/[﴾﴿]|إنما الأعمال/);
      // The caller's units are not mutated.
      expect(ctx.units.find((unit) => unit.id === '5382')!.text).toBe(text);
    });

    it('F-8 L-5: spreadOverPoints joins the lines in book order into at most six points', async () => {
      const lines = ['حل ما يأتي:', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}) مسألة ${n}`)];
      const run = async (unitLines: string[]) => {
        const base = v8Context(failing);
        const ctx: BookCoverageRepairContext = {
          ...base,
          units: base.units.map((unit) =>
            unit.id === '5382' ? { ...unit, text: unitLines.join('\n') } : unit,
          ),
        };
        const result = await repairBookCoverageGaps(
          candidate,
          findBookCoverageDiagnostics(candidate, V8),
          aiCall,
          ctx,
        );
        return result.outlines.find((o) => o.contentRole === 'check_understanding')!.keyPoints!;
      };
      // Nine lines → groups of two (ceil(9 / 6)), five points, nothing dropped.
      expect(await run(lines)).toEqual([
        'حل ما يأتي:\n1) مسألة 1',
        '2) مسألة 2\n3) مسألة 3',
        '4) مسألة 4\n5) مسألة 5',
        '6) مسألة 6\n7) مسألة 7',
        '8) مسألة 8',
      ]);
      // Six lines or fewer are one point each, unchanged.
      expect(await run(lines.slice(0, 6))).toEqual(lines.slice(0, 6));
    });

    it('re-asks the planner for a native plan without a diagram, and the chain plans the solution', async () => {
      const plan = planning('asked');
      const blocking = findBookCoverageDiagnostics(candidate, V8);

      const result = await repairBookCoverageGaps(candidate, blocking, aiCall, v8Context(plan));

      expect(plan).toHaveBeenCalledTimes(2);
      expect(plan.mock.calls[1]![0].instruction).toContain('solution slide');
      const check = plan.mock.calls[0]![0].check;
      const native = slide('x', ['5382'], {
        contentRole: 'check_understanding',
        visualPlan: { mode: 'native' },
      } as Partial<SceneOutline>);
      expect(check(native)).toMatchObject({ ok: false, fixable: true });
      expect(result.inserted).toBe(2);
    });
  });

  describe('g5.v8 a unit that opens its part (lessons 308/313/315/318)', () => {
    const unit = (id: string, kind: string, element: string, partIndex: number) => ({
      contentUnitId: id,
      kind,
      element,
      required: true,
      partIndex,
    });
    const flowFor = (contentRoles: string[]) =>
      [
        {
          stage: 'outcome_visual_explanations',
          instructions: 'Teach the part.',
          scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more', contentRoles },
        },
      ] as unknown as TeachingFlowEntry[];
    function placedContext(
      book: KafuoBookStructure,
      flow: TeachingFlowEntry[],
      units: BookCoverageRepairContext['units'],
      plan: BookCoverageRepairContext['plan'],
    ): BookCoverageRepairContext {
      return {
        ...context(plan),
        book,
        flow,
        units,
        diagnose: (outlines) => ({
          outlines,
          blocking: findBookCoverageDiagnostics(outlines, book),
        }),
      };
    }
    const untaught = (blocking: { message: string }[]) =>
      blocking.map((d) => d.message).filter((m) => m.includes('has no teaching slide'));

    // Lesson 313: an intro text 5320 before the key concept 5321 in part 1.
    const L313 = {
      templateVersionId: '2',
      teacherParity: true,
      rules: BOOK.rules,
      units: [
        unit('5320', 'INTRODUCTION', 'concept', 1),
        unit('5321', 'KEY_CONCEPT', 'key_concept', 1),
      ],
    } as unknown as KafuoBookStructure;
    const L313_UNITS = [
      { id: '5320', order: 1, role: 'INTRODUCTION', title: 'تمهيد', text: 'سطر أول\nسطر ثان' },
      { id: '5321', order: 2, role: 'KEY_CONCEPT', title: 'المفهوم', text: 'concept' },
    ];
    const L313_CANDIDATE = [
      slide('cover', [], { slideType: 'cover', contentRole: 'orientation' }),
      slide('p1', ['5321'], { slideType: 'transition' }),
      slide('kc', ['5321']),
    ];

    it('313: plans the intro slide right before part 1 transition, as orientation', async () => {
      const plan = planning('asked');
      const blocking = findBookCoverageDiagnostics(L313_CANDIDATE, L313);
      expect(untaught(blocking)).toEqual(['INTRODUCTION 5320 in part 1 has no teaching slide']);

      const result = await repairBookCoverageGaps(
        L313_CANDIDATE,
        blocking,
        aiCall,
        placedContext(L313, flowFor(['orientation', 'explanation']), L313_UNITS, plan),
      );

      expect(result.inserted).toBe(1);
      expect(result.outlines.map((o) => [o.id, o.contentRole])).toEqual([
        ['cover', 'orientation'],
        ['cover-book-missing_teaching-5320-r1', 'orientation'],
        ['p1', 'explanation'],
        ['kc', 'explanation'],
      ]);
      expect(plan.mock.calls[0]![0].nextTitle).toBe('p1');
      expect(untaught(result.blocking)).toEqual([]);
    });

    it('313: an explanation-only position gets an explanation slide', async () => {
      const plan = planning('asked');
      const blocking = findBookCoverageDiagnostics(L313_CANDIDATE, L313);
      const result = await repairBookCoverageGaps(
        L313_CANDIDATE,
        blocking,
        aiCall,
        placedContext(L313, flowFor(['explanation']), L313_UNITS, plan),
      );
      expect(result.outlines[1]).toMatchObject({
        id: 'cover-book-missing_teaching-5320-r1',
        contentRole: 'explanation',
      });
    });

    it('still refuses when no slide comes before the part', async () => {
      const plan = planning('asked');
      const candidate = L313_CANDIDATE.slice(1);
      const blocking = findBookCoverageDiagnostics(candidate, L313);
      const result = await repairBookCoverageGaps(
        candidate,
        blocking,
        aiCall,
        placedContext(L313, flowFor(['explanation']), L313_UNITS, plan),
      );
      expect(plan).not.toHaveBeenCalled();
      expect(untaught(result.blocking)).toEqual([
        'INTRODUCTION 5320 in part 1 has no teaching slide',
      ]);
    });

    it('E-4: never places the slide inside the opening or exactly-one stages', async () => {
      const plan = planning('asked');
      const opener = { key: 'lesson_opener', flowIndex: 0 };
      const map = { key: 'lesson_learning_map', flowIndex: 1 };
      const body = { key: 'outcome_visual_explanations', flowIndex: 2 };
      const flow = [
        {
          stage: 'lesson_opener',
          instructions: '',
          scenePolicy: {
            sceneTypes: ['slide'],
            cardinality: 'exactly_one',
            contentRoles: ['orientation'],
          },
        },
        {
          stage: 'lesson_learning_map',
          instructions: '',
          scenePolicy: {
            sceneTypes: ['slide'],
            cardinality: 'exactly_one',
            contentRoles: ['orientation'],
          },
        },
        {
          stage: 'outcome_visual_explanations',
          instructions: 'Teach the part.',
          scenePolicy: {
            sceneTypes: ['slide'],
            cardinality: 'one_or_more',
            contentRoles: ['explanation'],
          },
        },
      ] as unknown as TeachingFlowEntry[];
      // The learning map cites the later part-1 unit 5321 (lessons 315, 317).
      const candidate = [
        slide('cover', [], {
          slideType: 'cover',
          contentRole: 'orientation',
          teachingStage: opener,
        }),
        slide('map', ['5321'], { contentRole: 'orientation', teachingStage: map }),
        slide('p1', ['5321'], { slideType: 'transition', teachingStage: body }),
        slide('kc', ['5321'], { teachingStage: body }),
      ];
      const blocking = findBookCoverageDiagnostics(candidate, L313);
      const result = await repairBookCoverageGaps(
        candidate,
        blocking,
        aiCall,
        placedContext(L313, flow, L313_UNITS, plan),
      );
      expect(result.inserted).toBe(1);
      expect(result.outlines.map((o) => [o.id, o.teachingStage?.key])).toEqual([
        ['cover', 'lesson_opener'],
        ['map', 'lesson_learning_map'],
        ['map-book-missing_teaching-5320-r1', 'outcome_visual_explanations'],
        ['p1', 'outcome_visual_explanations'],
        ['kc', 'outcome_visual_explanations'],
      ]);
      expect(result.outlines[2]!.contentRole).toBe('explanation');
    });

    // Lesson 315: CONCEPT_DEVELOPMENT 5673 opens part 5, before its example 5674.
    const L315 = {
      templateVersionId: '2',
      teacherParity: true,
      rules: BOOK.rules,
      units: [
        unit('5660', 'KEY_CONCEPT', 'key_concept', 4),
        unit('5673', 'CONCEPT_DEVELOPMENT', 'concept', 5),
        unit('5674', 'WORKED_EXAMPLE', 'worked_example', 5),
      ],
    } as unknown as KafuoBookStructure;
    const L315_UNITS = [
      { id: '5660', order: 1, role: 'KEY_CONCEPT', title: 'مفهوم 4', text: 'part 4' },
      { id: '5673', order: 2, role: 'CONCEPT_DEVELOPMENT', title: 'تطوير', text: 'فكرة 1\nفكرة 2' },
      { id: '5674', order: 3, role: 'WORKED_EXAMPLE', title: 'مثال', text: 'example' },
    ];
    const failing = vi.fn(async () => ({
      ok: false as const,
      code: 'INSERTION_PLAN_INVALID' as const,
      message: 'the slide could not be planned (timeout)',
      calls: 1,
    }));

    it('315: plans the part-5 concept right before the part-5 example slide', async () => {
      const plan = planning('asked');
      const candidate = [
        slide('kc4', ['5660']),
        slide('p5', ['5674'], { slideType: 'transition' }),
        slide('ex5', ['5674'], { contentRole: 'worked_example' }),
      ];
      const blocking = findBookCoverageDiagnostics(candidate, L315);
      expect(untaught(blocking)).toEqual([
        'CONCEPT_DEVELOPMENT 5673 in part 5 has no teaching slide',
      ]);

      const result = await repairBookCoverageGaps(
        candidate,
        blocking,
        aiCall,
        placedContext(L315, flowFor(['explanation', 'worked_example']), L315_UNITS, plan),
      );

      expect(result.outlines.map((o) => [o.id, o.contentRole])).toEqual([
        ['kc4', 'explanation'],
        ['kc4-book-missing_teaching-5673-r1', 'explanation'],
        ['p5', 'explanation'],
        ['ex5', 'worked_example'],
      ]);
      expect(untaught(result.blocking)).toEqual([]);
    });

    it('315: with no part-5 slide, builds it from the book after part 4 when the planner fails', async () => {
      const candidate = [slide('kc4', ['5660']), slide('end', [], { slideType: 'end' })];
      const book = { ...L315, units: L315.units.slice(0, 2) } as KafuoBookStructure;
      const blocking = findBookCoverageDiagnostics(candidate, book);
      const result = await repairBookCoverageGaps(
        candidate,
        blocking,
        aiCall,
        placedContext(book, flowFor(['explanation']), L315_UNITS, failing),
      );

      expect(failing).toHaveBeenCalled();
      expect(result.outlines.map((o) => o.id)).toEqual([
        'kc4',
        'kc4-book-missing_teaching-5673-r1',
        'end',
      ]);
      expect(result.outlines[1]).toMatchObject({
        slideType: 'content',
        contentRole: 'explanation',
        title: 'تطوير',
        keyPoints: ['فكرة 1', 'فكرة 2'],
        sourceContentUnitIds: ['5673'],
        teachingStage: STAGE,
      });
      expect(untaught(result.blocking)).toEqual([]);
    });
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
