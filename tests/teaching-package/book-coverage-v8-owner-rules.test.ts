/**
 * g5.v8 owner rules (3–4 Nov 2026) enforced in the outline gate and repair,
 * with shapes from the 4 Nov final review (lessons 312, 315, 316, 317):
 * one solution slide per «تأكد» check, recall first, the exercise item floor,
 * and solutions that never refuse.
 */
import { describe, expect, it } from 'vitest';

import {
  EXERCISE_TOO_FEW,
  findBookCoverageDiagnostics,
  findBookCoverageGaps,
  RECALL_NOT_FIRST,
  SOLUTION_SLIDES_DUPLICATED,
  teacherParityBook,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  instructionFor,
  mergeDuplicateSolutions,
  moveRecallFirst,
  repairBookCoverageGaps,
  type BookCoverageRepairContext,
} from '@/lib/server/teaching-package/book-coverage-repair';
import { isIgnorableIssue } from '@/lib/server/teaching-package/outline-correction';
import { withoutSacredItems } from '@/lib/server/teaching-package/sacred-text';
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';

const V8 = { key: 'g5', version: 'g5.v8' };
const V7 = { key: 'g5', version: 'g5.v7' };
const OPENER = { key: 'lesson_opener', flowIndex: 0 };
const MAP = { key: 'lesson_learning_map', flowIndex: 1 };
const BODY = { key: 'outcome_visual_explanations', flowIndex: 2 };

function slide(id: string, units: string[], extra: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    slideType: 'content',
    contentRole: 'explanation',
    sourceContentUnitIds: units,
    teachingStage: BODY,
    ...extra,
  } as SceneOutline;
}

const codes = (diagnostics: Array<{ code: string }>) => diagnostics.map((d) => d.code);

/** Lesson 317 «الدوال» (shape): example 5488, check 5489 with items 1أ–1ج. */
const BOOK_317: KafuoBookStructure = {
  rules: [],
  units: [
    {
      contentUnitId: '5481',
      kind: 'VOCABULARY_REVIEW',
      element: 'prior_knowledge',
      required: false,
      partIndex: 1,
    },
    {
      contentUnitId: '5485',
      kind: 'LEARNING_GOALS',
      element: 'objective_source',
      required: false,
      partIndex: 1,
    },
    {
      contentUnitId: '5486',
      kind: 'CONCEPT',
      element: 'key_concept',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '5488',
      kind: 'EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '5489',
      kind: 'CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
      pairedExampleUnitId: '5488',
    },
    {
      contentUnitId: '5500',
      kind: 'PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 1,
      pairedExampleUnitId: '5488',
    },
  ],
} as unknown as KafuoBookStructure;

const book317 = (model = V8): CoverageBookStructure => teacherParityBook(BOOK_317, model)!;

/** The plan as lesson 317 shipped it: opener cites the prior unit; one solution per item. */
function plan317(): SceneOutline[] {
  return [
    slide('open', ['5481', '5485'], { teachingStage: OPENER }),
    slide('map', ['5485'], { teachingStage: MAP }),
    slide('recall', ['5481'], { contentKind: 'definition' }),
    slide('concept', ['5486']),
    slide('ex1', ['5488'], { contentRole: 'worked_example' }),
    slide('try1', ['5489'], { contentRole: 'check_understanding' }),
    slide('sol1a', ['5489'], {
      contentRole: 'worked_example',
      keyPoints: ['1أ: …'],
      suggestedImageIds: ['img-1'],
    }),
    slide('sol1b', ['5489', '5486'], { contentRole: 'worked_example', keyPoints: ['1ب: …'] }),
    slide('sol1c', ['5489'], {
      contentRole: 'worked_example',
      keyPoints: ['1ج: …'],
      suggestedImageIds: ['img-2'],
    }),
    slide('exercises', ['5500', '5489'], { contentRole: 'worked_example' }),
    slide('close', ['5486'], { contentRole: 'summary' }),
  ];
}

describe('one solution slide per «تأكد» check (lessons 312, 317)', () => {
  it('flags more than one solution slide for one check as admin-correctable and ignorable', () => {
    const found = findBookCoverageDiagnostics(plan317(), book317());
    const duplicated = found.filter((d) => d.code === SOLUTION_SLIDES_DUPLICATED);
    expect(duplicated).toHaveLength(1);
    expect(duplicated[0]!.message).toContain('check 5489');
    expect(duplicated[0]!.disposition).toBe('admin_correctable');
    expect(duplicated.every(isIgnorableIssue)).toBe(true);
    // g5.v7 is unchanged: no such finding.
    expect(codes(findBookCoverageDiagnostics(plan317(), book317(V7)))).not.toContain(
      SOLUTION_SLIDES_DUPLICATED,
    );
  });

  it('merges them into the first: units, key points and visuals join, the rest go, exercises stay', () => {
    const { outlines, merged } = mergeDuplicateSolutions(plan317(), book317());
    expect(merged).toBe(2);
    expect(outlines.map((o) => o.id)).toEqual([
      'open',
      'map',
      'recall',
      'concept',
      'ex1',
      'try1',
      'sol1a',
      'exercises',
      'close',
    ]);
    const kept = outlines.find((o) => o.id === 'sol1a')!;
    expect(kept.sourceContentUnitIds).toEqual(['5489', '5486']);
    // E-2: each removed slide's title joins as its first line.
    expect(kept.keyPoints).toEqual(['1أ: …', 'sol1b', '1ب: …', 'sol1c', '1ج: …']);
    expect(kept.suggestedImageIds).toEqual(['img-1', 'img-2']);
    // The exercise slide also citing 5489 is never a solution of the check.
    expect(codes(findBookCoverageDiagnostics(outlines, book317()))).not.toContain(
      SOLUTION_SLIDES_DUPLICATED,
    );
    // Coverage still holds: the check keeps its try-it and one solution after it.
    expect(findBookCoverageGaps(outlines, book317())).toEqual([]);
  });
});

/** Lesson 315 «شوكيات الجلد» (shape): the opener cites the prior unit 5648; scene 3 teaches first. */
const BOOK_315: KafuoBookStructure = {
  rules: [],
  units: [
    {
      contentUnitId: '5647',
      kind: 'LEARNING_GOALS',
      element: 'objective_source',
      required: false,
      partIndex: 1,
    },
    {
      contentUnitId: '5648',
      kind: 'VOCABULARY_REVIEW',
      element: 'prior_knowledge',
      required: false,
      partIndex: 1,
    },
    {
      contentUnitId: '5651',
      kind: 'MAIN_IDEA',
      element: 'supporting',
      required: false,
      partIndex: 1,
    },
    {
      contentUnitId: '5653',
      kind: 'CONCEPT_DEVELOPMENT',
      element: 'key_concept',
      required: true,
      partIndex: 1,
    },
  ],
} as unknown as KafuoBookStructure;
const book315 = (model = V8) => teacherParityBook(BOOK_315, model)!;

function plan315(): SceneOutline[] {
  return [
    slide('open', ['5650', '5651', '5648', '5647'], { teachingStage: OPENER }),
    slide('map', ['5647'], { teachingStage: MAP }),
    slide('general', ['5651', '5653']),
    slide('recall', ['5648'], { contentKind: 'definition' }),
    slide('mouth', ['5653']),
  ];
}

describe('recall first (lessons 307, 315, 317)', () => {
  it('refuses a recall slide after the first teaching slide, and the repair moves it up', () => {
    const found = findBookCoverageDiagnostics(plan315(), book315());
    expect(codes(found)).toEqual([RECALL_NOT_FIRST]);
    expect(found[0]!.outlineId).toBe('recall');
    expect(found.every(isIgnorableIssue)).toBe(true);
    const { outlines, moved } = moveRecallFirst(plan315(), book315());
    expect(moved).toBe(true);
    expect(outlines.map((o) => o.id)).toEqual(['open', 'map', 'recall', 'general', 'mouth']);
    expect(findBookCoverageDiagnostics(outlines, book315())).toEqual([]);
    // g5.v7 never checks recall.
    expect(findBookCoverageDiagnostics(plan315(), book315(V7))).toEqual([]);
  });

  it('an opener citing the prior unit is not the recall: the gap is placeable before part 1', () => {
    const plan = plan315().filter((o) => o.id !== 'recall');
    const gaps = findBookCoverageGaps(plan, book315());
    expect(gaps.map((g) => g.kind)).toEqual(['missing_recall']);
    // After the learning map, in the body stage of part 1's first slide.
    expect(gaps[0]!.anchorIndex).toBe(1);
    expect(gaps[0]!.stageFromIndex).toBe(2);
  });

  it('the repair moves the recall without a model call and reports the change', async () => {
    const book = book315();
    const diagnose = (outlines: SceneOutline[]) => ({
      outlines,
      blocking: findBookCoverageDiagnostics(outlines, book),
    });
    const result = await repairBookCoverageGaps(
      plan315(),
      findBookCoverageDiagnostics(plan315(), book),
      (async () => {
        throw new Error('no model call expected');
      }) as never,
      {
        book,
        flow: [],
        units: [],
        skillOptions: null,
        language: 'ar-SA',
        languageDirective: '',
        visuals: [],
        diagnose,
      } as BookCoverageRepairContext,
    );
    expect(result.inserted).toBe(0);
    expect(result.restructured).toBe(1);
    expect(result.blocking).toEqual([]);
    expect(result.outlines.map((o) => o.id)).toEqual(['open', 'map', 'recall', 'general', 'mouth']);
  });

  it('E-1: a part-2 slide reusing the prior unit is not the recall and is never moved', () => {
    const book = teacherParityBook(
      {
        ...BOOK_315,
        units: [
          ...BOOK_315.units,
          {
            contentUnitId: '5700',
            kind: 'CONCEPT',
            element: 'key_concept',
            required: true,
            partIndex: 2,
          },
        ],
      } as KafuoBookStructure,
      V8,
    )!;
    const plan = [
      slide('open', ['5647'], { teachingStage: OPENER }),
      slide('map', ['5647'], { teachingStage: MAP }),
      slide('general', ['5651', '5653']),
      slide('part2', ['5648', '5700']),
    ];
    expect(codes(findBookCoverageDiagnostics(plan, book))).not.toContain(RECALL_NOT_FIRST);
    expect(findBookCoverageGaps(plan, book).map((g) => g.kind)).toEqual(['missing_recall']);
    const { outlines, moved } = moveRecallFirst(plan, book);
    expect(moved).toBe(false);
    expect(outlines.map((o) => o.id)).toEqual(['open', 'map', 'general', 'part2']);
  });

  it('E-3: rolls the move back when it adds a new non-parity finding', async () => {
    const book = book315();
    const original = findBookCoverageDiagnostics(plan315(), book);
    // A flow check that fails once the recall sits before «general».
    const diagnose = (outlines: SceneOutline[]) => ({
      outlines,
      blocking: [
        ...findBookCoverageDiagnostics(outlines, book),
        ...(outlines.findIndex((o) => o.id === 'recall') <
        outlines.findIndex((o) => o.id === 'general')
          ? [{ code: 'POSITION_CARDINALITY', disposition: 'admin_correctable', message: 'x' }]
          : []),
      ],
    });
    const result = await repairBookCoverageGaps(
      plan315(),
      original,
      (async () => {
        throw new Error('no model call expected');
      }) as never,
      {
        book,
        flow: [],
        units: [],
        skillOptions: null,
        language: 'ar-SA',
        languageDirective: '',
        visuals: [],
        diagnose,
      } as unknown as BookCoverageRepairContext,
    );
    expect(result.restructured).toBe(0);
    expect(result.inserted).toBe(0);
    expect(codes(result.blocking)).toEqual([RECALL_NOT_FIRST]);
    expect(result.outlines.map((o) => o.id)).toEqual(['open', 'map', 'general', 'recall', 'mouth']);
  });
});

describe('E-5: the missing-solution instruction', () => {
  const gap = {
    kind: 'missing_solution' as const,
    unit: BOOK_317.units[4]!,
    message: '',
  };
  it('keeps the g5.v7 wording byte for byte and uses the new wording on g5.v8', () => {
    expect(instructionFor(gap)).toBe(
      'Plan the solution slide (contentRole worked_example) for the book check in content unit 5489: ' +
        "work each of its items step by step to a final answer with this part's decision rule, the way the book's example in unit 5488 is solved." +
        ' The book prints no answer, so work it from the given data; a guess or prediction item gets a reasoned number stated as an estimate.',
    );
    const v8 = instructionFor(gap, true);
    expect(v8).toContain('ALL of its items together on this one slide');
    expect(v8).toContain('never a Quran verse or hadith');
  });
});

/** Lesson 312 (shape): one «تأكد» unit holding 8 numbered questions; minExercises 6. */
describe('exercise item floor (lesson 312: 5 items planned, 6 needed)', () => {
  const book = teacherParityBook(
    {
      rules: [],
      units: [
        {
          contentUnitId: '5460',
          kind: 'CONCEPT',
          element: 'key_concept',
          required: true,
          partIndex: 1,
        },
        {
          contentUnitId: '5464',
          kind: 'GUIDED_PRACTICE',
          element: 'exercise',
          required: false,
          partIndex: 1,
        },
      ],
      exercisePolicy: {
        maxExercises: 10,
        maxExerciseSlides: 3,
        minExercises: 6,
        minExerciseSlides: 2,
      },
    } as unknown as KafuoBookStructure,
    V8,
    { '5464': { questionNumbers: [1, 2, 3, 4, 5, 6, 7, 8] } as never },
  )!;
  const plan = (first: string[], second: string[]) => [
    slide('concept', ['5460']),
    slide('t-ex', [], { slideType: 'transition', title: 'تمارين' }),
    slide('ex-a', ['5464'], { contentRole: 'worked_example', keyPoints: first }),
    slide('ex-b', ['5464'], { contentRole: 'worked_example', keyPoints: second }),
    slide('close', ['5460'], { contentRole: 'summary' }),
  ];

  it('counts the numbered items the exercise slides plan against min(minExercises, selection)', () => {
    const short = findBookCoverageDiagnostics(
      plan(['1) …', '2) …', '3) …'], ['4) …', '5) …']),
      book,
    );
    expect(short.map((d) => d.message)).toContain(
      'the exercises block plans fewer than 6 numbered exercise items',
    );
    expect(short.filter((d) => d.code === EXERCISE_TOO_FEW).every(isIgnorableIssue)).toBe(true);
    const enough = findBookCoverageDiagnostics(
      plan(['1) …', '2) …', '3) …', '4) …'], ['5) …', '6) …', '7) …', '8) …']),
      book,
    );
    expect(codes(enough)).not.toContain(EXERCISE_TOO_FEW);
  });
});

describe('verse strip and solutions that refuse (lesson 316)', () => {
  // Lesson 316 «التوابع» check units 5438 and 5439, as stored: no verse, no hadith.
  const unit5438 = [
    'اختبار بنائي',
    'أولاً - حدد نوع البدل في كل جملة مما يأتي، واضبطه بالشكل:',
    '● للفائز بالمسابقة جائزة، سيارة. البدل: نوعه:',
    '● أعجبني الطالب، اجتهاده. البدل: نوعه:',
  ].join('\n');
  const unit5439 = [
    'ثانيًا - أكمل الجملة الآتية بالتابع المطلوب، واضبطه بالشكل:',
    '● قرأت الصحيفة (توكيد لفظي)',
    '● (توكيد معنوي)',
    '● (صفة)',
  ].join('\n');

  it('leaves check units without a verse untouched, so the strip cannot cause a refusal', () => {
    expect(withoutSacredItems(unit5438)).toBe(unit5438);
    expect(withoutSacredItems(unit5439)).toBe(unit5439);
  });

  it('keeps poetry items and drops only the verse lines (units 5434, 5437 shape)', () => {
    const mixed = [
      '6 عين كل تابع ومتبوعه فيما يأتي:',
      '﴿وَأَخِي هَٰرُونُ هُوَ أَفْصَحُ مِنِّي لِسَانًا﴾(2).',
      'خليليَّ عوجا ساعةً وتهجَّرا ولوما على ما أحدث الدهر أو ذرا',
      'تذكرتُ شيئًا قد مضى لسبيله ومن عادة المحزون أن يتذكَّرا',
    ].join('\n');
    const kept = withoutSacredItems(mixed);
    expect(kept).not.toContain('﴿');
    expect(kept).toContain('خليليَّ عوجا ساعةً');
    expect(kept).toContain('تذكرتُ شيئًا قد مضى');
  });
});
