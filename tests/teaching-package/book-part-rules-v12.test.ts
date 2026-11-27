/**
 * g5.v12 book-part rules (critical items before package regeneration, 27 Nov 2026;
 * planner review W1, decisions D-2, D-4 and EN-5). Shaped after local lesson 227
 * «خواص المادة» (attempt `tpa-niIfguhTprj6`), the first real g5.v12 plan:
 *
 * - slides 2, 6 and 14: a transition slide holding a title and one line (F6, D-2);
 * - slide 7: three concepts on one slide (F4, F9) — 6756, and the kind-less 6758 and 6760;
 * - slides 9 and 11: three checks on one try-it, one solution for all three (F2, F3);
 * - slide 16 (6768) before slide 17, the check 6767 it follows in the book (F4);
 * - slide 17: 6767 (part 2) with 6772 (part 3) on one try-it, no solution for either (F3);
 * - 6763, 6765 and 6770: listed supporting units no slide taught and nothing reported (F11);
 * - 6752 «الفكرة الرئيسة»: essential, which only the cover cited (F10).
 *
 * Every rule is checked against the same plan on g5.v11 too: none of them fires there.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  appOutlineDiagnostics,
  diagnosisContextFromCheckpoint,
  diagnoseCandidateOutlines,
  isIgnorableIssue,
  isIgnorableIssueOnPlan,
  type OutlineDiagnosisContext,
} from '@/lib/server/teaching-package/outline-correction';
import {
  BOOK_COVERAGE_INCOMPLETE,
  CHECKS_MERGED,
  DEFINITION_NOT_FIRST,
  EXAMPLE_TAUGHT_TWICE,
  EXERCISES_NOT_EASIEST_FIRST,
  findBookCoverageDiagnostics,
  findBookCoverageGaps,
  IDEAS_MERGED,
  isIdeaUnit,
  ideasMergedSlides,
  mergedCheckSlides,
  NO_CLOSING_SUMMARY,
  requireEssentialUntypedUnits,
  requireTaughtUnits,
  teacherParityBook,
  TITLE_ONLY_SLIDE,
  titleOnlyTransitions,
  bookPartPlacementWarnings,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  dropTitleOnlyTransitions,
  repairBookCoverageGaps,
  splitMergedChecks,
  unmergeIdeas,
  unplaceableBookGaps,
  type BookCoverageRepairContext,
} from '@/lib/server/teaching-package/book-coverage-repair';
import {
  buildBookPartMap,
  CHECK_BEFORE_ITS_PART,
  findBookOrderDiagnostics,
  listedPartUnitIds,
  personPlacedOutlines,
  placeCandidate,
  placeOutlinesByBookPart,
  SLIDE_OUT_OF_BOOK_ORDER,
  untaughtListedPartUnits,
} from '@/lib/server/teaching-package/book-part-placement';
import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import type { PlanInsertedSlideInput } from '@/lib/server/teaching-package/plan-inserted-slide';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
  KafuoBookStructureUnit,
  LearningObjectiveRef,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

// The g5.v11 / g5.v12 flow: one intro slide, then per objective its slides and its quiz.
const FLOW = [
  { stage: 'lesson_opener', instructions: 'intro' },
  { stage: 'outcome_visual_explanations', instructions: 'O1' },
  { stage: 'outcome_check_understanding', instructions: 'Q1' },
  { stage: 'outcome_visual_explanations', instructions: 'O2' },
  { stage: 'outcome_check_understanding', instructions: 'Q2' },
  { stage: 'outcome_visual_explanations', instructions: 'O3' },
  { stage: 'outcome_check_understanding', instructions: 'Q3' },
] as TeachingFlowEntry[];

const unit = (
  contentUnitId: string,
  element: string | null,
  partIndex: number,
): KafuoBookStructure['units'][number] => ({
  contentUnitId,
  kind:
    element === null
      ? null
      : element === 'try_it'
        ? 'UNDERSTANDING_CHECK'
        : element === 'worked_example'
          ? 'WORKED_EXAMPLE'
          : 'KEY_CONCEPT',
  element,
  required: element === 'key_concept' || element === 'try_it' || element === 'worked_example',
  partIndex,
});

/** The book, in book order. A `null` element is a kind-less unit (D-4). */
const BOOK: KafuoBookStructure = {
  templateVersionId: '4',
  rules: [],
  units: [
    unit('6752', 'supporting', 1), // «الفكرة الرئيسة»: only the cover cited it (F10)
    unit('6754', 'key_concept', 1),
    unit('6756', 'key_concept', 1),
    unit('6757', 'try_it', 1), // «ماذا قرأت؟»: no paired example
    unit('6758', null, 1), // solids
    unit('6759', 'try_it', 1),
    unit('6760', null, 1), // gases
    unit('6761', 'try_it', 1),
    unit('6762', null, 1), // the table
    unit('6763', 'supporting', 1), // the lab (F11)
    unit('6765', 'supporting', 1),
    unit('6766', 'key_concept', 2),
    unit('6767', 'try_it', 2), // physical properties
    unit('6768', null, 2), // distinguishing properties: printed AFTER the check
    unit('6770', 'supporting', 2), // «الكيمياء في واقع الحياة» (F11)
    unit('6771', 'key_concept', 3), // chemical properties
    unit('6772', 'try_it', 3), // chemical properties
    unit('6773', 'key_concept', 3),
  ],
};

const OBJECTIVES: LearningObjectiveRef[] = [
  {
    objectiveRef: 'o1',
    snapshot: { statement: 'خصائص المادة' },
    contentUnitIds: [
      '6752',
      '6754',
      '6756',
      '6757',
      '6758',
      '6759',
      '6760',
      '6761',
      '6762',
      '6763',
      '6765',
    ],
  },
  {
    objectiveRef: 'o2',
    snapshot: { statement: 'الخصائص الفيزيائية' },
    contentUnitIds: ['6766', '6767', '6768', '6770'],
  },
  {
    objectiveRef: 'o3',
    snapshot: { statement: 'الخصائص الكيميائية' },
    contentUnitIds: ['6771', '6772', '6773'],
  },
];

/** The manifest's essential roles (CONCEPT_EXPLANATION), as the Submit gate counts them. */
const ESSENTIAL = ['6752', '6754', '6756', '6758', '6760', '6762', '6766', '6768', '6771', '6773'];

const V11 = { key: 'g5', version: 'g5.v11' };
const V12 = { key: 'g5', version: 'g5.v12' };
const MAP = buildBookPartMap(BOOK, OBJECTIVES, FLOW)!;
/** The coverage book of a g5.v11 run: untyped essential units required (unchanged). */
const BOOK_V11 = teacherParityBook(requireEssentialUntypedUnits(BOOK, ESSENTIAL), V11)!;
/** The coverage book of a g5.v12 run: every listed part unit and every essential section required. */
const BOOK_V12 = teacherParityBook(
  requireTaughtUnits(requireEssentialUntypedUnits(BOOK, ESSENTIAL), [
    ...listedPartUnitIds(MAP),
    ...ESSENTIAL,
  ]),
  V12,
)!;

const at = (flowIndex: number) => ({ key: FLOW[flowIndex]!.stage, flowIndex });

const slide = (id: string, flowIndex: number, units: string[], extra: Partial<SceneOutline> = {}) =>
  ({
    id,
    type: 'slide',
    title: id,
    description: '',
    keyPoints: [],
    order: 0,
    slideType: 'content',
    contentRole: 'explanation',
    teachingStage: at(flowIndex),
    sourceContentUnitIds: units,
    ...extra,
  }) as SceneOutline;

const quiz = (id: string, flowIndex: number) =>
  ({
    id,
    type: 'quiz',
    title: id,
    description: '',
    keyPoints: [],
    order: 0,
    teachingStage: at(flowIndex),
  }) as SceneOutline;

/** Lesson 227's plan as the planner answered it. */
function plan227(): SceneOutline[] {
  return [
    slide('cover', 0, ['6752'], { slideType: 'cover' }),
    slide('t2', 1, [], { slideType: 'transition', keyPoints: ['الجزء الأول'] }), // D-2
    slide('s7', 1, ['6756', '6758', '6760']), // three ideas
    slide('s9', 1, ['6757', '6759', '6761'], { contentRole: 'check_understanding' }),
    slide('s11', 1, ['6757', '6759', '6761'], { contentRole: 'worked_example' }),
    slide('s12', 1, ['6762']),
    quiz('q1', 2),
    slide('t6', 3, [], { slideType: 'transition' }), // a title only
    slide('s16', 3, ['6768']), // the book prints 6767 first
    slide('s17', 3, ['6767', '6772'], { contentRole: 'check_understanding' }), // F3
    quiz('q2', 4),
    slide('t14', 5, [], { slideType: 'transition', keyPoints: ['الجزء الثالث'] }),
    slide('s19', 5, ['6771']),
    slide('s20', 5, ['6773'], { contentRole: 'worked_example' }),
    slide('closing', 5, ['6773'], { contentRole: 'summary' }),
    quiz('q3', 6),
  ];
}

const ids = (outlines: readonly SceneOutline[]) => outlines.map((outline) => outline.id);
const cited = (outline: SceneOutline) => (outline.sourceContentUnitIds ?? []).map(String);
const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);
const sorted = (values: readonly string[]) => [...values].sort();

/** The one diagnosis a v12 run uses: the book's coverage and rules, then its order. */
const diagnoseV12 = (outlines: SceneOutline[]) => ({
  outlines,
  blocking: [
    ...findBookCoverageDiagnostics(outlines, BOOK_V12),
    ...findBookOrderDiagnostics(outlines, MAP, FLOW),
  ],
});
const orderOnly = (outlines: SceneOutline[]) => ({
  outlines,
  blocking: findBookOrderDiagnostics(outlines, MAP, FLOW),
});

function repairContext(
  plan: BookCoverageRepairContext['plan'],
  over: {
    coverage?: CoverageBookStructure;
    unitsBook?: KafuoBookStructure;
    diagnose?: BookCoverageRepairContext['diagnose'];
  } = {},
): BookCoverageRepairContext {
  return {
    book: over.coverage ?? BOOK_V12,
    flow: FLOW,
    units: (over.unitsBook ?? BOOK).units.map((entry, index) => ({
      id: entry.contentUnitId,
      order: index + 1,
      role: entry.element === 'try_it' ? 'UNDERSTANDING_CHECK' : 'CONCEPT_EXPLANATION',
      title: `عنوان ${entry.contentUnitId}`,
      text: `السطر الأول ${entry.contentUnitId}\nالسطر الثاني ${entry.contentUnitId}`,
    })),
    skillOptions: null,
    language: 'ar-SA',
    languageDirective: '',
    visuals: [],
    diagnose: over.diagnose ?? diagnoseV12,
    plan,
  };
}

/** A fake insert planner answering the role its instruction names (as the repair test does). */
function planning() {
  return vi.fn(async (input: PlanInsertedSlideInput) => {
    const role = /contentRole (\w+)/.exec(input.instruction)?.[1] ?? 'explanation';
    const outline = slide(input.outlineId, input.teachingStage.flowIndex, [...input.unitIds], {
      contentRole: role as SceneOutline['contentRole'],
      teachingStage: input.teachingStage,
    });
    const checked = input.check(outline);
    return checked.ok
      ? { ok: true as const, outline: checked.outline, repairs: [], calls: 1 }
      : { ok: false as const, code: 'INSERTION_PLAN_INVALID' as const, message: 'x', calls: 1 };
  });
}

const aiCall = vi.fn(async () => '{}');

const V12_CODES = [
  CHECKS_MERGED,
  IDEAS_MERGED,
  TITLE_ONLY_SLIDE,
  SLIDE_OUT_OF_BOOK_ORDER,
  CHECK_BEFORE_ITS_PART,
];

describe('the coverage book of a run', () => {
  it('g5.v11 is exactly as before; g5.v12 carries the book-part mark and requires every listed unit', () => {
    expect(BOOK_V11).not.toHaveProperty('bookPartPlacement');
    expect(BOOK_V12.bookPartPlacement).toBe(true);
    const required = (book: typeof BOOK_V11, id: string) =>
      book.units.find((entry) => entry.contentUnitId === id)!.required;
    // 6763, 6765 and 6770 are supporting units the template does not require.
    for (const id of ['6752', '6763', '6765', '6770']) {
      expect(required(BOOK_V11, id), `${id} on v11`).toBe(false);
      expect(required(BOOK_V12, id), `${id} on v12`).toBe(true);
    }
    // The request's own map is never touched.
    expect(required(BOOK, '6763')).toBe(false);
  });
});

describe('EN-3 (D-4): a kind-less unit is part content', () => {
  it('the parts map holds 6758, 6760 and 6768, in their book place', () => {
    for (const id of ['6758', '6760', '6768']) {
      expect(MAP.units.get(id)).toMatchObject({ element: null });
    }
    expect(MAP.parts.find((part) => part.partIndex === 2)!.unitIds).toEqual([
      '6766',
      '6767',
      '6768',
      '6770',
    ]);
    expect(isIdeaUnit({ element: null, partIndex: 1 })).toBe(true);
    expect(isIdeaUnit({ element: null, partIndex: undefined })).toBe(false);
    expect(isIdeaUnit({ element: 'supporting', partIndex: 1 })).toBe(false);
  });
});

describe('EN-1: every check is gated on g5.v12, paired or not', () => {
  it('g5.v11 gates no unpaired check, exactly as before (F2)', () => {
    expect(
      findBookCoverageGaps(plan227(), BOOK_V11).map((gap) => [gap.kind, gap.unit.contentUnitId]),
    ).toEqual([
      ['missing_teaching', '6754'],
      ['missing_teaching', '6766'],
    ]);
  });

  it('g5.v12 asks for the solution slides of 6767 and 6772, anchored after their try-it', () => {
    const tryIt = plan227().findIndex((outline) => outline.id === 's17');
    const solutions = findBookCoverageGaps(plan227(), BOOK_V12).filter(
      (gap) => gap.kind === 'missing_solution',
    );
    expect(solutions.map((gap) => [gap.unit.contentUnitId, gap.anchorIndex])).toEqual([
      ['6767', tryIt],
      ['6772', tryIt],
    ]);
  });

  it('g5.v12 asks for the try-it of a check that has none, after the last slide of an earlier unit of its part', () => {
    const plan = plan227().filter((outline) => outline.id !== 's9' && outline.id !== 's11');
    const gap = findBookCoverageGaps(plan, BOOK_V12).find((gap) => gap.kind === 'missing_try_it')!;
    expect(gap.unit.contentUnitId).toBe('6757');
    // s7 teaches 6756, 6758 and 6760: the units the book prints before the check.
    expect(plan[gap.anchorIndex!]!.id).toBe('s7');
    // One try-it slide answers the "untaught" report of the same check too.
    expect(
      findBookCoverageGaps(plan, BOOK_V12)
        .filter((gap) => gap.unit.contentUnitId === '6757')
        .map((gap) => gap.kind),
    ).toEqual(['missing_teaching', 'missing_try_it']);
  });

  it('EN-4: what the book repair can still place is told from what only the planner or a person can', () => {
    // Every gap of the plan above has a place the repair can plan a slide into.
    const plan = plan227().filter((outline) => outline.id !== 's9' && outline.id !== 's11');
    expect(unplaceableBookGaps(plan, BOOK_V12, FLOW)).toEqual([]);
    // A check solved before its try-it is a person's to move: none of its gaps is planned.
    const solvedEarly = [
      slide('sol', 1, ['6757'], { contentRole: 'worked_example' }),
      slide('try', 1, ['6757'], { contentRole: 'check_understanding' }),
    ];
    expect(
      unplaceableBookGaps(solvedEarly, BOOK_V12, FLOW)
        .filter((gap) => gap.unit.contentUnitId === '6757')
        .map((gap) => gap.kind),
    ).toEqual(['solution_before_try_it', 'missing_solution']);
  });
});

describe('EN-8 / EN-5 / EN-7: every listed unit is taught, or named', () => {
  it('6763, 6765 and 6770 are gaps on g5.v12, each named with its part; silent on g5.v11', () => {
    const v12 = findBookCoverageGaps(plan227(), BOOK_V12);
    expect(
      sorted(
        v12.filter((gap) => gap.kind === 'missing_teaching').map((gap) => gap.unit.contentUnitId),
      ),
    ).toEqual(['6752', '6754', '6763', '6765', '6766', '6770']);
    expect(v12.find((gap) => gap.unit.contentUnitId === '6770')!.message).toBe(
      'KEY_CONCEPT 6770 in part 2 has no teaching slide',
    );
    expect(
      findBookCoverageGaps(plan227(), BOOK_V11)
        .map((gap) => gap.unit.contentUnitId)
        .filter((id) => ['6752', '6763', '6765', '6770'].includes(id)),
    ).toEqual([]);
  });

  it('EN-7: 6752, which only the cover cites, is required at planning on g5.v12', () => {
    expect(
      findBookCoverageGaps(plan227(), BOOK_V12).find((gap) => gap.unit.contentUnitId === '6752')!
        .kind,
    ).toBe('missing_teaching');
    expect(
      findBookCoverageGaps(plan227(), BOOK_V11).some((gap) => gap.unit.contentUnitId === '6752'),
    ).toBe(false);
  });
});

describe('review 27 Nov 2026: an idea is taught by a teaching slide of its own', () => {
  const withoutSlide7 = () =>
    // Slide 7 taught 6756, 6758 and 6760; with it gone, a solution slide cites 6758 too.
    plan227()
      .filter((outline) => outline.id !== 's7')
      .map((outline) =>
        outline.id === 's11'
          ? { ...outline, sourceContentUnitIds: [...cited(outline), '6758'] }
          : outline,
      );

  it('g5.v12: a kind-less idea cited only on a check’s solution slide is untaught', () => {
    const gaps = findBookCoverageGaps(withoutSlide7(), BOOK_V12);
    expect(gaps.find((gap) => gap.unit.contentUnitId === '6758')?.kind).toBe('missing_teaching');
    // …and so it is one a listed-unit report names.
    expect(untaughtListedPartUnits(withoutSlide7(), MAP, BOOK_V12)).toContain('6758');
  });

  it('g5.v12: the same on a try-it slide', () => {
    const plan = withoutSlide7().map((outline) =>
      outline.id === 's9'
        ? { ...outline, sourceContentUnitIds: [...cited(outline), '6760'] }
        : outline,
    );
    expect(
      findBookCoverageGaps(plan, BOOK_V12).find((gap) => gap.unit.contentUnitId === '6760')?.kind,
    ).toBe('missing_teaching');
  });

  it('a side note cited on a check slide stays taught, and g5.v11 counts any citation as before', () => {
    const plan = withoutSlide7().map((outline) =>
      outline.id === 's9'
        ? { ...outline, sourceContentUnitIds: [...cited(outline), '6763'] }
        : outline,
    );
    // 6763 is a side note (`supporting`): it may sit on the slide of the element it explains.
    expect(
      findBookCoverageGaps(plan, BOOK_V12).some((gap) => gap.unit.contentUnitId === '6763'),
    ).toBe(false);
    expect(
      findBookCoverageGaps(withoutSlide7(), BOOK_V11).some(
        (gap) => gap.unit.contentUnitId === '6758',
      ),
    ).toBe(false);
  });

  it('M1 (wave 1 review): an idea cited only on the orientation or the closing summary is untaught on g5.v12', () => {
    for (const contentRole of ['orientation', 'summary'] as const) {
      const plan = [
        ...withoutSlide7(),
        slide(`close-${contentRole}`, 5, ['6758'], { slideType: 'content', contentRole }),
      ].map((outline) =>
        outline.id === 's11'
          ? { ...outline, sourceContentUnitIds: cited(outline).filter((id) => id !== '6758') }
          : outline,
      );
      expect(
        findBookCoverageGaps(plan, BOOK_V12).find((gap) => gap.unit.contentUnitId === '6758')?.kind,
      ).toBe('missing_teaching');
    }
    // The key concept 6756 (required on both models), taught only by the closing summary:
    // a gap on g5.v12; on g5.v11 the citation counts, exactly as before.
    const summaryOnly = [
      ...withoutSlide7(),
      slide('close', 5, ['6756'], { slideType: 'content', contentRole: 'summary' }),
    ];
    expect(
      findBookCoverageGaps(summaryOnly, BOOK_V12).some(
        (gap) => gap.unit.contentUnitId === '6756' && gap.kind === 'missing_teaching',
      ),
    ).toBe(true);
    expect(
      findBookCoverageGaps(summaryOnly, BOOK_V11).some((gap) => gap.unit.contentUnitId === '6756'),
    ).toBe(false);
  });

  it('a plan that teaches every listed unit names none', () => {
    const plan = [
      slide('c', 1, ['6756']),
      slide('try', 1, ['6757'], { contentRole: 'check_understanding' }),
      slide('sol', 1, ['6757'], { contentRole: 'worked_example' }),
    ];
    expect(untaughtListedPartUnits(plan, MAP, BOOK_V12)).toEqual(
      listedPartUnitIds(MAP).filter((id) => !['6756', '6757'].includes(id)),
    );
  });
});

describe('the book-part detectors (g5.v12 only)', () => {
  it('MG-2: slides 9, 11 and 17 each merge checks; slide 17 across two parts', () => {
    expect(
      mergedCheckSlides(plan227(), BOOK_V12).map((group) => [
        group.outline.id,
        group.units.map((unit) => unit.contentUnitId),
      ]),
    ).toEqual([
      ['s9', ['6757', '6759', '6761']],
      ['s11', ['6757', '6759', '6761']],
      ['s17', ['6767', '6772']],
    ]);
  });

  it('MG-4: slide 7 teaches three ideas; a concept with its side note is one idea', () => {
    expect(ideasMergedSlides(plan227(), BOOK_V12).map((group) => group.outline.id)).toEqual(['s7']);
    expect(
      ideasMergedSlides(
        [slide('c', 1, ['6756', '6763']), slide('n', 1, ['6756', '6759'])],
        BOOK_V12,
      ),
    ).toEqual([]);
    // A try-it that also cites an example follows the checks' rules.
    expect(
      ideasMergedSlides(
        [slide('t', 1, ['6757', '6756'], { contentRole: 'check_understanding' })],
        BOOK_V12,
      ),
    ).toEqual([]);
  });

  it('L4 (wave 1 review): a kind-less unit no objective owns (never required) does not make a slide "several ideas"', () => {
    // Taking the slide out would drop 'x-free' with no gap to plan it again.
    const book: CoverageBookStructure = {
      ...BOOK_V12,
      units: [
        ...BOOK_V12.units,
        { contentUnitId: 'x-free', kind: null, element: null, required: false, partIndex: 1 },
      ],
    };
    expect(ideasMergedSlides([slide('c', 1, ['6756', 'x-free'])], book)).toEqual([]);
    // Two required ideas still are.
    expect(ideasMergedSlides([slide('c', 1, ['6756', '6758'])], book)).toHaveLength(1);
  });

  it('V12-2: slides 2, 6 and 14 are title-only; the «تمارين» transition is not one of them', () => {
    const plan = plan227();
    expect(titleOnlyTransitions(plan, BOOK_V12).map((index) => plan[index]!.id)).toEqual([
      't2',
      't6',
      't14',
    ]);
    const withBook: KafuoBookStructure = {
      ...BOOK_V12,
      units: [...BOOK_V12.units, unit('6777', 'exercise', 3)],
    };
    const exercises = [
      ...plan,
      slide('t-ex', 5, [], { slideType: 'transition' }),
      slide('ex-1', 5, ['6777'], { contentRole: 'worked_example' }),
    ];
    expect(titleOnlyTransitions(exercises, withBook).map((index) => exercises[index]!.id)).toEqual([
      't2',
      't6',
      't14',
    ]);
  });

  it('V12-2 (review): a transition that shows one of the book’s own visuals is a picture slide, never dropped', () => {
    const plan = plan227().map((outline) =>
      outline.id === 't6' ? { ...outline, suggestedImageIds: ['src-1'] } : outline,
    );
    expect(titleOnlyTransitions(plan, BOOK_V12).map((index) => plan[index]!.id)).toEqual([
      't2',
      't14',
    ]);
    expect(dropTitleOnlyTransitions(plan, BOOK_V12).dropped).toBe(2);
  });

  it('none of them fires on g5.v11', () => {
    const v11 = findBookCoverageDiagnostics(plan227(), BOOK_V11);
    expect(codes(v11)).toEqual([BOOK_COVERAGE_INCOMPLETE, BOOK_COVERAGE_INCOMPLETE]);
    for (const code of V12_CODES) {
      expect(
        v11.some((issue) => issue.code === code),
        code,
      ).toBe(false);
    }
    // Without the parts map (every model before v12) no slide is checked for order.
    const context: OutlineDiagnosisContext = {
      flow: FLOW,
      contentUnitIds: null,
      sourceImages: [],
      governed: false,
      bookStructure: BOOK_V11,
    };
    expect(codes(appOutlineDiagnostics(plan227(), context))).not.toContain(SLIDE_OUT_OF_BOOK_ORDER);
  });

  it('the diagnosis of a v12 run carries every finding, with the slide it is about', () => {
    const found = diagnoseV12(plan227()).blocking;
    const bySlide = Object.fromEntries(found.map((issue) => [issue.outlineId, issue.code]));
    expect(bySlide).toMatchObject({
      t2: TITLE_ONLY_SLIDE,
      s7: IDEAS_MERGED,
      s9: CHECKS_MERGED,
      s17: SLIDE_OUT_OF_BOOK_ORDER,
    });
    // Six sections without a slide (6752, 6754, 6763, 6765, 6766, 6770), two checks without a solution.
    expect(found.filter((issue) => issue.code === BOOK_COVERAGE_INCOMPLETE)).toHaveLength(8);
    // …and the same call, with the parts map, is the run's one outline diagnosis.
    const context: OutlineDiagnosisContext = {
      flow: FLOW,
      contentUnitIds: null,
      sourceImages: [],
      governed: false,
      bookStructure: BOOK_V12,
      bookParts: MAP,
    };
    expect(codes(appOutlineDiagnostics(plan227(), context))).toContain(SLIDE_OUT_OF_BOOK_ORDER);
  });
});

describe('EN-2: the order gate', () => {
  it('names slide 17: its units belong to two blocks, so the placement cannot put it right', () => {
    const [finding] = findBookOrderDiagnostics(plan227(), MAP, FLOW);
    expect(finding).toMatchObject({
      code: SLIDE_OUT_OF_BOOK_ORDER,
      outlineId: 's17',
      field: 'sourceContentUnitIds',
    });
    expect(finding!.message).toContain('(part 2 and part 3)');
  });

  it('names a check asked after a later unit of its part', () => {
    const plan = plan227().map((outline) =>
      outline.id === 's17' ? { ...outline, sourceContentUnitIds: ['6767'] } : outline,
    );
    const finding = findBookOrderDiagnostics(plan, MAP, FLOW).find(
      (issue) => issue.outlineId === 's17',
    )!;
    expect(finding.code).toBe(SLIDE_OUT_OF_BOOK_ORDER);
    expect(finding.message).toContain(
      'teaches unit 6767 (part 2) after outline #9 «s16», which teaches unit 6768 (part 2)',
    );
  });

  it('CHECK_BEFORE_ITS_PART: a check asked before the slide that teaches an earlier unit of its part', () => {
    const plan = [
      slide('s9', 1, ['6757'], { contentRole: 'check_understanding' }),
      slide('s7', 1, ['6756']),
    ];
    const [finding] = findBookOrderDiagnostics(plan, MAP, FLOW);
    expect(finding).toMatchObject({
      code: CHECK_BEFORE_ITS_PART,
      outlineId: 's9',
      field: 'order',
    });
    expect(finding!.message).toContain('Move the check after every slide');
  });

  it('names a teaching slide planned in another objective block, with the block it belongs to', () => {
    const [finding] = findBookOrderDiagnostics([slide('s19', 1, ['6771'])], MAP, FLOW);
    expect(finding).toMatchObject({
      code: SLIDE_OUT_OF_BOOK_ORDER,
      outlineId: 's19',
      field: 'teachingStage',
      flowIndex: 5,
      stage: FLOW[5]!.stage,
      allowedValues: [5],
    });
  });

  it('reports nothing on a plan in book order: try-it, solution, then the next unit', () => {
    const plan = [
      slide('c1', 1, ['6756']),
      slide('try', 1, ['6757'], { contentRole: 'check_understanding' }),
      slide('sol', 1, ['6757'], { contentRole: 'worked_example' }),
      slide('c2', 1, ['6758']),
      slide('closing', 5, ['6773'], { contentRole: 'summary' }),
    ];
    expect(findBookOrderDiagnostics(plan, MAP, FLOW)).toEqual([]);
  });

  it('the order findings cannot be ignored by a person, like the flow order', () => {
    expect(
      isIgnorableIssue({
        code: SLIDE_OUT_OF_BOOK_ORDER,
        disposition: 'admin_correctable',
        field: 'order',
        message: 'm',
      }),
    ).toBe(false);
    expect(
      isIgnorableIssue({
        code: CHECK_BEFORE_ITS_PART,
        disposition: 'admin_correctable',
        field: 'order',
        message: 'm',
      }),
    ).toBe(false);
    // Nor a merged check (wave 1 review, M5): Submit refuses it again, and an ignore
    // would switch the engine's own split off. (A g5.v12-only code.)
    expect(
      isIgnorableIssue({
        code: CHECKS_MERGED,
        disposition: 'admin_correctable',
        field: 'sourceContentUnitIds',
        message: 'm',
      }),
    ).toBe(false);
  });

  it('M5 (wave 1 review): on g5.v12 a book gap Submit refuses again cannot be ignored; g5.v11 as before', () => {
    // The key concept 6754 (required on both models) has no slide.
    const plan = [slide('c', 1, ['6756'])];
    const gapIssue = (book: CoverageBookStructure) => {
      const issue = findBookCoverageDiagnostics(plan, book).find(
        (diagnostic) =>
          diagnostic.code === BOOK_COVERAGE_INCOMPLETE && diagnostic.message.includes('6754'),
      );
      expect(issue).toBeDefined();
      return issue!;
    };
    expect(
      isIgnorableIssueOnPlan(gapIssue(BOOK_V12), { outlines: plan, bookStructure: BOOK_V12 }),
    ).toBe(false);
    expect(
      isIgnorableIssueOnPlan(gapIssue(BOOK_V11), { outlines: plan, bookStructure: BOOK_V11 }),
    ).toBe(true);
    // The plan-free rule is unchanged.
    expect(isIgnorableIssue(gapIssue(BOOK_V12))).toBe(true);
  });

  it('MG-3: a try-it merged from two parts is placed after the LAST check, never before that part is taught', () => {
    const planned = [
      slide('s16', 3, ['6768']),
      slide('s17', 3, ['6767', '6772'], { contentRole: 'check_understanding' }),
      slide('s19', 5, ['6771']),
      slide('s20', 5, ['6773']),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, MAP, FLOW)!;
    // 6772 (part 3) follows 6771 in the book: the try-it sits after slide 19, in its block.
    expect(ids(result.outlines)).toEqual(['s16', 's19', 's17', 's20', 'q3']);
    expect(result.outlines.find((outline) => outline.id === 's17')!.teachingStage!.flowIndex).toBe(
      5,
    );
  });

  it('a placement whose re-diagnosis adds an order finding is rolled back, and says so', () => {
    const planned = [slide('c1', 1, ['6756']), slide('s19', 1, ['6771']), quiz('q3', 6)];
    const guarded = placeCandidate(planned, MAP, FLOW, (candidate) => ({
      outlines: candidate,
      blocking:
        candidate === planned
          ? []
          : [{ code: SLIDE_OUT_OF_BOOK_ORDER, disposition: 'admin_correctable', message: 'broke' }],
    }));
    expect(guarded.placement).toBeNull();
    expect(guarded.rolledBackFor).toEqual([SLIDE_OUT_OF_BOOK_ORDER]);
    expect(guarded.outlines).toBe(planned);
    // With the order gate itself the same placement is kept: it puts s19 into its block.
    const kept = placeCandidate(planned, MAP, FLOW, orderOnly);
    expect(kept.placement).not.toBeNull();
    expect(kept.blocking).toEqual([]);
    const moved = kept.outlines.find((outline) => outline.id === 's19')!;
    expect(moved.teachingStage!.flowIndex).toBe(5);
    expect(ids(kept.outlines)).toEqual(['c1', 's19', 'q3']);
  });

  it('a person who moved or re-staged a slide is read off the checkpoint', () => {
    expect(personPlacedOutlines([])).toBe(false);
    expect(
      personPlacedOutlines([
        { event: 'edited', operations: [{ op: 'ignore_issue', issueKey: 'k' }] },
      ]),
    ).toBe(false);
    expect(
      personPlacedOutlines([
        { event: 'edited', operations: [{ op: 'set', field: 'contentRole' }] },
      ]),
    ).toBe(false);
    expect(personPlacedOutlines([{ event: 'edited', operations: [{ op: 'move' }] }])).toBe(true);
    expect(
      personPlacedOutlines([
        { event: 'edited', operations: [{ op: 'set', field: 'teachingStage' }] },
      ]),
    ).toBe(true);
  });
});

describe('the deterministic repairs (no model call)', () => {
  it("MG-2: slides 9 and 17 are split into one try-it per check with the book's own lines; the merged solution is taken out", () => {
    const result = splitMergedChecks(plan227(), BOOK_V12, repairContext(planning()));
    expect(result.split).toBe(3);
    expect(result.removed).toBe(1);
    expect(
      result.outlines
        .filter((outline) => outline.contentRole === 'check_understanding')
        .map((outline) => [outline.id, cited(outline)]),
    ).toEqual([
      ['s9', ['6757']],
      ['s9-check-6759', ['6759']],
      ['s9-check-6761', ['6761']],
      ['s17', ['6767']],
      ['s17-check-6772', ['6772']],
    ]);
    // The book's own lines, and no answer: the planner's merged key points are gone.
    const [first, second] = result.outlines.filter(
      (outline) => outline.contentRole === 'check_understanding',
    );
    expect(first!.keyPoints).toEqual(['السطر الأول 6757', 'السطر الثاني 6757']);
    expect(second!.keyPoints).toEqual(['السطر الأول 6759', 'السطر الثاني 6759']);
    expect(first!.title).toBe('جرّب: عنوان 6757');
    expect(second!.teachingStage).toEqual(at(1));
    // Slide 11 solved all three together: it is taken out, and each check gets its own.
    expect(ids(result.outlines)).not.toContain('s11');
    expect(result.outlines.map((outline) => outline.order)).toEqual(
      result.outlines.map((_, index) => index + 1),
    );
    // The plan it was given is never mutated.
    expect(cited(plan227()[3]!)).toEqual(['6757', '6759', '6761']);
  });

  it('MG-2 (review, MEDIUM): a merged solution that also cites a book example is taken out too, so no answer precedes its try-it', async () => {
    // The shape the reviewer ran: a key concept, an example, two checks on one try-it,
    // and ONE solution that cites the example with both checks — its text holds both answers.
    const small: KafuoBookStructure = {
      templateVersionId: '4',
      rules: [],
      units: [
        unit('k', 'key_concept', 1),
        unit('ex', 'worked_example', 1),
        unit('c1', 'try_it', 1),
        unit('c2', 'try_it', 1),
      ],
    };
    // One objective, so the flow has one objective block.
    const flow = FLOW.slice(0, 3) as TeachingFlowEntry[];
    const map = buildBookPartMap(
      small,
      [
        {
          objectiveRef: 'o1',
          snapshot: { statement: 's' },
          contentUnitIds: ['k', 'ex', 'c1', 'c2'],
        },
      ],
      flow,
    )!;
    const coverage = teacherParityBook(requireTaughtUnits(small, listedPartUnitIds(map)), V12)!;
    const diagnose = (outlines: SceneOutline[]) => ({
      outlines,
      blocking: [
        ...findBookCoverageDiagnostics(outlines, coverage),
        ...findBookOrderDiagnostics(outlines, map, flow),
      ],
    });
    const context = {
      ...repairContext(planning(), { coverage, unitsBook: small, diagnose }),
      flow,
    };
    const plan = [
      slide('k', 1, ['k']),
      slide('try-m', 1, ['c1', 'c2'], { contentRole: 'check_understanding' }),
      slide('sol-m', 1, ['ex', 'c1', 'c2'], {
        contentRole: 'worked_example',
        keyPoints: ['حل: ٥', 'حل: ٧'],
      }),
      quiz('q1', 2),
    ];

    const split = splitMergedChecks(plan, coverage, context);
    expect(split).toMatchObject({ split: 1, removed: 1 });
    expect(ids(split.outlines)).toEqual(['k', 'try-m', 'try-m-check-c2', 'q1']);

    const repaired = await repairBookCoverageGaps(plan, diagnose(plan).blocking, aiCall, context);
    // The example's own slide, and one solution per check.
    expect(repaired.inserted).toBe(3);
    const placed = placeCandidate(repaired.outlines, map, flow, diagnose);
    expect(placed.blocking).toEqual([]);
    expect(ids(placed.outlines)).toEqual([
      'k',
      'k-book-missing_teaching-ex-r1',
      'try-m',
      'try-m-book-missing_solution-c1-r1',
      'try-m-check-c2',
      'try-m-check-c2-book-missing_solution-c2-r1',
      'q1',
    ]);
    // The planner's merged solution, with both answers, is nowhere in the package.
    expect(JSON.stringify(placed.outlines.map((outline) => outline.keyPoints))).not.toContain(
      'حل:',
    );
  });

  it('MG-2 (review, MEDIUM): a g5.v8 finding the split brings out does not roll the split back', async () => {
    const plan = plan227();
    const context = repairContext(planning());
    // As in `[K, E, try-merged, sol-merged]`: the diagnosis reports an example taught
    // twice on any plan that holds a split try-it.
    context.diagnose = (outlines) => {
      const diagnosed = diagnoseV12(outlines);
      const splitTryIt = outlines.some((outline) => outline.id.endsWith('-check-6759'));
      return {
        outlines: diagnosed.outlines,
        blocking: [
          ...diagnosed.blocking,
          ...(splitTryIt
            ? [
                {
                  code: EXAMPLE_TAUGHT_TWICE,
                  disposition: 'admin_correctable' as const,
                  field: 'sourceContentUnitIds',
                  message: 'an example is taught twice',
                },
              ]
            : []),
        ],
      };
    };

    const result = await repairBookCoverageGaps(plan, diagnoseV12(plan).blocking, aiCall, context);

    expect(result.outlines.some((outline) => outline.id.endsWith('-check-6759'))).toBe(true);
    expect(result.restructured).toBeGreaterThan(0);
  });

  it('MG-4: slide 7 is taken out to be planned one slide per idea', () => {
    const result = unmergeIdeas(plan227(), BOOK_V12);
    expect(result.removed).toBe(1);
    expect(ids(result.outlines)).not.toContain('s7');
  });

  it('V12-2: the title-only transition slides are dropped, and only those', () => {
    const result = dropTitleOnlyTransitions(plan227(), BOOK_V12);
    expect(result.dropped).toBe(3);
    expect(ids(result.outlines)).toEqual([
      'cover',
      's7',
      's9',
      's11',
      's12',
      'q1',
      's16',
      's17',
      'q2',
      's19',
      's20',
      'closing',
      'q3',
    ]);
  });
});

describe('lesson 227, repaired and placed (the insert planner doubles for the model)', () => {
  it('ends in book order, one try-it and one solution per check, every listed unit taught, no title-only slide', async () => {
    const plan = planning();
    const repaired = await repairBookCoverageGaps(
      plan227(),
      diagnoseV12(plan227()).blocking,
      aiCall,
      repairContext(plan),
    );
    // Five solutions, six missing teaching slides, three ideas of slide 7.
    expect(repaired.inserted).toBe(14);
    // Slides 9 and 17 split (3 added, 1 solution taken out), slide 7 and three transitions dropped.
    expect(repaired.restructured).toBe(8);
    // Each solution was asked for its own check, right after that check's try-it.
    const solutions = plan.mock.calls
      .map(([input]) => input)
      .filter((input) => /solution slide/.test(input.instruction));
    // (`previousTitle` is the try-it's own title, «جرّب: عنوان N».)
    expect(solutions.map((input) => [input.unitIds, input.previousTitle])).toEqual([
      [['6772'], 'جرّب: عنوان 6772'],
      [['6767'], 'جرّب: عنوان 6767'],
      [['6761'], 'جرّب: عنوان 6761'],
      [['6759'], 'جرّب: عنوان 6759'],
      [['6757'], 'جرّب: عنوان 6757'],
    ]);
    // The ideas of slide 7 were each planned on a slide of their own.
    expect(
      plan.mock.calls
        .map(([input]) => input.unitIds)
        .filter((unitIds) => ['6756', '6758', '6760'].includes(unitIds[0]!)),
    ).toHaveLength(3);

    // What the repair leaves open is order only; the placement then puts every slide right.
    expect(new Set(codes(repaired.blocking))).toEqual(new Set([SLIDE_OUT_OF_BOOK_ORDER]));
    const placed = placeCandidate(repaired.outlines, MAP, FLOW, diagnoseV12);
    expect(placed.placement).not.toBeNull();
    expect(placed.blocking).toEqual([]);

    const final = placed.outlines;
    const teaching = final.filter(
      (outline) => outline.type === 'slide' && outline.slideType !== 'cover',
    );
    const position = (outline: SceneOutline) => final.indexOf(outline);
    // One try-it and one solution per check, the solution right after its try-it.
    for (const check of ['6757', '6759', '6761', '6767', '6772']) {
      const tryIt = teaching.find(
        (outline) =>
          outline.contentRole === 'check_understanding' && cited(outline).includes(check),
      )!;
      const solution = teaching.find(
        (outline) => outline.contentRole === 'worked_example' && cited(outline).includes(check),
      )!;
      expect(
        teaching.filter(
          (outline) =>
            cited(outline).includes(check) && outline.contentRole === 'check_understanding',
        ),
        check,
      ).toHaveLength(1);
      expect(position(solution), check).toBe(position(tryIt) + 1);
    }
    // Every listed unit and every essential section has a teaching slide.
    const taught = new Set(teaching.flatMap(cited));
    for (const id of [...listedPartUnitIds(MAP), ...ESSENTIAL])
      expect(taught.has(id), id).toBe(true);
    // No merged check, no merged ideas, no title-only transition.
    expect(mergedCheckSlides(final, BOOK_V12)).toEqual([]);
    expect(ideasMergedSlides(final, BOOK_V12)).toEqual([]);
    expect(titleOnlyTransitions(final, BOOK_V12)).toEqual([]);
    // The book's order: the kind-less 6768 is taught after the check 6767 it follows,
    // and the check 6772 (part 3) is asked after slide 19 teaches chemical properties.
    const of = (unitId: string) => teaching.find((outline) => cited(outline).includes(unitId))!;
    const tryOf = (check: string) =>
      teaching.find(
        (outline) =>
          outline.contentRole === 'check_understanding' && cited(outline).includes(check),
      )!;
    const solOf = (check: string) =>
      teaching.find(
        (outline) => outline.contentRole === 'worked_example' && cited(outline).includes(check),
      )!;
    // …the part's own order holds around each check (6756, check 6757, 6758, check 6759)…
    expect(position(of('6756'))).toBeLessThan(position(tryOf('6757')));
    expect(position(solOf('6757'))).toBeLessThan(position(of('6758')));
    expect(position(of('6758'))).toBeLessThan(position(tryOf('6759')));
    expect(position(of('6768'))).toBeGreaterThan(position(solOf('6767')));
    expect(position(tryOf('6772'))).toBeGreaterThan(position(of('6771')));
    expect(final.filter((outline) => outline.slideType === 'transition')).toEqual([]);
    // The cover and the quizzes are where they were.
    expect([final[0]!.id, final.at(-1)!.id]).toEqual(['cover', 'q3']);
  });
});

describe('EN-5: the rules the owner chose to warn on (never a gate)', () => {
  const inOrder = [
    slide('c1', 1, ['6756'], { contentKind: 'concept' }),
    slide('c2', 1, ['6754'], { contentKind: 'definition' }),
    slide('s20', 5, ['6773'], { contentRole: 'worked_example', contentKind: 'concept' }),
  ];

  it('g5.v12: a key concept with no definition box on its first slide, and no closing summary', () => {
    const warnings = bookPartPlacementWarnings(inOrder, BOOK_V12);
    expect(warnings.map((warning) => warning.code)).toEqual([
      DEFINITION_NOT_FIRST,
      NO_CLOSING_SUMMARY,
    ]);
    // 6754 has its box; 6756 does not; 6773 is taught by a worked example, not an explanation.
    expect(warnings[0]).toMatchObject({ outlineId: 'c1' });
    expect(warnings[0]!.message).toContain('6756');
    expect(
      bookPartPlacementWarnings(
        [...inOrder, slide('closing', 5, ['6773'], { contentRole: 'summary' })],
        BOOK_V12,
      ).map((warning) => warning.code),
    ).toEqual([DEFINITION_NOT_FIRST]);
  });

  it('nothing on g5.v11', () => {
    expect(bookPartPlacementWarnings(inOrder, BOOK_V11)).toEqual([]);
    expect(bookPartPlacementWarnings(inOrder, undefined)).toEqual([]);
  });
});

describe('the diagnosis of an edit, a resume and a paused plan’s review (the checkpoint context)', () => {
  /** What a pause pins: ids and verdicts only, never text (the rest of the shape is not read). */
  const checkpoint = {
    sourceRefs: {
      contentUnitIds: null,
      essentialContentUnitIds: ESSENTIAL,
      bookUnitFacts: undefined,
      contentUnits: [],
      sourceImages: [],
    },
  } as unknown as Parameters<typeof diagnosisContextFromCheckpoint>[0];

  it('g5.v12: carries the lesson’s parts and the run’s own coverage book', () => {
    const context = diagnosisContextFromCheckpoint(
      checkpoint,
      FLOW,
      false,
      BOOK,
      V12,
      undefined,
      OBJECTIVES,
    );
    expect(context.bookParts).toEqual(MAP);
    // The same book the run planned with: every listed unit and essential section required.
    expect(context.bookStructure).toEqual(BOOK_V12);
    // So the order gate answers there too, as it did in the run.
    expect(codes(diagnoseCandidateOutlines(plan227(), context).blocking)).toContain(
      SLIDE_OUT_OF_BOOK_ORDER,
    );
  });

  it('H1 (wave 1 review): a checkpoint that pinned the run’s taught set re-checks exactly that set', () => {
    // The run left 6770 out (no text): the correction does not require it either.
    const taught = listedPartUnitIds(MAP).filter((id) => id !== '6770');
    const context = diagnosisContextFromCheckpoint(
      {
        ...checkpoint,
        sourceRefs: { ...checkpoint.sourceRefs, taughtContentUnitIds: [...taught, ...ESSENTIAL] },
      },
      FLOW,
      false,
      BOOK,
      V12,
      undefined,
      OBJECTIVES,
    );
    const required = (context.bookStructure?.units ?? [])
      .filter((unit) => unit.required)
      .map((unit) => unit.contentUnitId);
    expect(required).not.toContain('6770');
    expect(required).toEqual(expect.arrayContaining(taught));
  });

  it('a plan paused in the scenes phase carries no parts: it cannot be reordered, so the order gate is not run on it', () => {
    const context = diagnosisContextFromCheckpoint(
      { ...checkpoint, phase: 'scenes' },
      FLOW,
      false,
      BOOK,
      V12,
      undefined,
      OBJECTIVES,
    );
    expect(context).not.toHaveProperty('bookParts');
    // The coverage book is the run's own, all the same.
    expect(context.bookStructure).toEqual(BOOK_V12);
    expect(codes(diagnoseCandidateOutlines(plan227(), context).blocking)).not.toContain(
      SLIDE_OUT_OF_BOOK_ORDER,
    );
  });

  it('g5.v11: no parts, and the coverage book exactly as before', () => {
    const context = diagnosisContextFromCheckpoint(
      checkpoint,
      FLOW,
      false,
      BOOK,
      V11,
      undefined,
      OBJECTIVES,
    );
    expect(context).not.toHaveProperty('bookParts');
    expect(context.bookStructure).toEqual(BOOK_V11);
    expect(codes(diagnoseCandidateOutlines(plan227(), context).blocking)).not.toContain(
      SLIDE_OUT_OF_BOOK_ORDER,
    );
  });
});

describe('EN-5 (review, MEDIUM): the exercise slides follow the engine’s EXERCISES BLOCK order', () => {
  const exercise = (contentUnitId: string): KafuoBookStructureUnit => ({
    contentUnitId,
    kind: 'PRACTICE',
    element: 'exercise',
    required: false,
    partIndex: 1,
  });
  const withExercises = (units: KafuoBookStructureUnit[], unitFacts = {}) =>
    teacherParityBook(
      {
        ...BOOK_V12,
        exercisePolicy: {
          maxExercises: 6,
          maxExerciseSlides: 3,
          minExercises: 1,
          minExerciseSlides: 1,
        },
        units: [...BOOK_V12.units, ...units],
        ...(Object.keys(unitFacts).length > 0 ? { unitFacts } : {}),
      },
      V12,
    )!;
  // The engine's selection puts both units on ONE slide, in book order.
  const twoUnits = withExercises([exercise('exA'), exercise('exB')]);
  // …and a unit of two numbered questions on one slide, question 1 then question 2.
  const questions = withExercises([exercise('exQ')], {
    exQ: { itemLabels: [], hiddenSteps: [], questionNumbers: [1, 2] },
  });
  const solve = (id: string, units: string[], keyPoints: string[] = []) =>
    slide(id, 5, units, { contentRole: 'worked_example', keyPoints });
  const orderWarnings = (coverage: CoverageBookStructure, outlines: SceneOutline[]) =>
    bookPartPlacementWarnings(outlines, coverage)
      .map((warning) => warning.code)
      .filter((code) => code === EXERCISES_NOT_EASIEST_FIRST);

  it('the engine’s selection, as the fixture assumes', () => {
    expect(selectExercises(twoUnits)!.slides).toEqual([['exA', 'exB']]);
    expect(selectExercises(questions, questions.unitFacts)!.slideQuestions).toEqual([
      { exQ: [1, 2] },
    ]);
  });

  it('follows the engine: both units on one slide, or one per slide in book order', () => {
    expect(orderWarnings(twoUnits, [solve('ex', ['exA', 'exB'])])).toEqual([]);
    expect(orderWarnings(twoUnits, [solve('a', ['exA']), solve('b', ['exB'])])).toEqual([]);
  });

  it('warns when the order is reversed, on one slide or across slides', () => {
    expect(orderWarnings(twoUnits, [solve('ex', ['exB', 'exA'])])).toEqual([
      EXERCISES_NOT_EASIEST_FIRST,
    ]);
    expect(orderWarnings(twoUnits, [solve('b', ['exB']), solve('a', ['exA'])])).toEqual([
      EXERCISES_NOT_EASIEST_FIRST,
    ]);
  });

  it('warns when a unit’s numbered questions are set later-question-first across slides', () => {
    const second = solve('q2', ['exQ'], ['(2) السؤال الثاني', 'ب', 'ج']);
    const first = solve('q1', ['exQ'], ['(1) السؤال الأول', 'ب', 'ج']);
    expect(orderWarnings(questions, [second, first])).toEqual([EXERCISES_NOT_EASIEST_FIRST]);
    expect(orderWarnings(questions, [first, second])).toEqual([]);
  });

  it('says nothing when the plan sets other items than the engine: that is the coverage gates’ matter', () => {
    expect(orderWarnings(twoUnits, [solve('a', ['exA'])])).toEqual([]);
  });
});
