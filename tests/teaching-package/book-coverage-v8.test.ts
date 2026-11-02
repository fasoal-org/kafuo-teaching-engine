/**
 * g5.v8 teacher parity (plan 2 Nov 2026, W2): the book-map contract, the
 * planner text, the hidden-step detector, the coverage gates and the
 * split-unit duplicate image. Every g5.v7 shape is pinned unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  annotateBookMarkers,
  BOOK_COVERAGE_INCOMPLETE,
  bookStructureRequirement,
  bookUnitFactsOf,
  EXERCISE_CAP_EXCEEDED,
  EXERCISE_TOO_FEW,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  findBookCoverageDiagnostics,
  findBookCoverageGaps,
  isTeacherParityModel,
  teacherParityBook,
  WORKING_STEP_MISSING,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  repairBookCoverageGaps,
  type BookCoverageRepairContext,
} from '@/lib/server/teaching-package/book-coverage-repair';
import {
  checkItemLabels,
  detectHiddenStepTypes,
  HIDDEN_STEP_TYPES,
  showsWorkingStep,
} from '@/lib/server/teaching-package/hidden-step-types';
import {
  buildKafuoStartRequest,
  canonicalRequestDigest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import {
  applyCorrectionOperations,
  correctionCoverageBook,
  diagnosisContextFromCheckpoint,
  insertableBookGaps,
  isIgnorableIssue,
} from '@/lib/server/teaching-package/outline-correction';
import { findSplitUnitDuplicateImages } from '@/lib/server/teaching-package/split-unit-images';
import type { PlanInsertedSlideInput } from '@/lib/server/teaching-package/plan-inserted-slide';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationCheckpoint,
  KafuoBookStructure,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

const V7 = { key: 'g5', version: 'g5.v7' };
const V8 = { key: 'g5', version: 'g5.v8' };

// The g5.v7 fixture of `book-coverage.test.ts`, whose digest is pinned below.
const V7_BOOK: KafuoBookStructure = {
  templateVersionId: '5',
  rules: [
    { kind: 'KEY_CONCEPT', element: 'key_concept', required: true },
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'UNDERSTANDING_CHECK', element: 'try_it', required: true },
  ],
  units: [
    { contentUnitId: '10', kind: 'LEARNING_GOALS', element: 'objective_source', required: false },
    {
      contentUnitId: '11',
      kind: 'KEY_CONCEPT',
      element: 'key_concept',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '12',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '13',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
      pairedExampleUnitId: '12',
    },
  ],
};

// A lesson 306 slice as the Backend's g5.v8 wire sends it (two parts).
const V8_BOOK: KafuoBookStructure = {
  templateVersionId: '3',
  rules: [
    { kind: 'PRIOR_KNOWLEDGE', element: 'prior_knowledge', required: false },
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'UNDERSTANDING_CHECK', element: 'try_it', required: true },
    { kind: 'MATH_READING', element: 'supporting', required: false },
    { kind: 'GUIDED_PRACTICE', element: 'exercise', required: false },
    { kind: 'PRACTICE', element: 'exercise', required: false },
  ],
  units: [
    {
      contentUnitId: '4015',
      kind: 'PRIOR_KNOWLEDGE',
      element: 'prior_knowledge',
      required: false,
      partIndex: 1,
    },
    {
      contentUnitId: '4021',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '4025',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
      pairedExampleUnitId: '4021',
    },
    {
      contentUnitId: '4026',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 2,
    },
    {
      contentUnitId: '4037',
      kind: 'MATH_READING',
      element: 'supporting',
      required: false,
      partIndex: 2,
      attachesToUnitId: '4026',
    },
    {
      contentUnitId: '4038',
      kind: 'GUIDED_PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: '4021',
      exerciseUsable: false,
      exerciseUnusableReason: 'instructions_only',
    },
    {
      contentUnitId: '4040',
      kind: 'GUIDED_PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: '4021',
    },
    {
      contentUnitId: '4060',
      kind: 'PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: '4021',
    },
    {
      contentUnitId: '4061',
      kind: 'PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: '4021',
      exerciseUsable: false,
      exerciseUnusableReason: 'number_only',
    },
  ],
  exercisePolicy: { maxExercises: 2, maxExerciseSlides: 1 },
};

const TEXTS = [
  {
    id: '4025',
    text: 'تحقق من فهمك\n\n1A) الأشهر: شوال، ذو الحجة، صفر، 1B) 10, 4, -2, -8 1C) مثلث سيربنسكي',
  },
  {
    id: '4040',
    text: '2) مواعيد انطلاق الحافلات: 10:15 صباحًا، 11:00 صباحًا، 11:45 صباحًا،',
  },
  { id: '4060', text: '23) اجتماعات النادي: المحرّم، ربيع أول، جمادى الأولى،' },
  { id: '4061', text: '(24)' },
];

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'kafuo-req-1',
    tenantContext: { tenantId: 'tenant-1' },
    actorRef: 'user-42',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Deductive reasoning',
      unit: { id: '12', title: 'Unit 1' },
      curriculum: { id: '5', name: 'Math 1' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      language: 'ar',
    },
    learningObjectives: [
      {
        objectiveRef: '7001',
        snapshot: { statement: 'Law of Detachment.' },
        contentUnitIds: ['11', '12', '13'],
      },
    ],
    teachingModel: {
      key: 'g5',
      version: 'g5.v7',
      flow: [{ stage: 'lesson_opener', instructions: 'Cover.' }],
    },
    contentResource: {
      id: 'cs-77',
      url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
      mimeType: 'application/pdf',
    },
    generation: {},
    bookStructure: V7_BOOK,
    ...overrides,
  };
}

const STAGE = { key: 'outcome_visual_explanations', flowIndex: 2 };

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

const v8Book = (): CoverageBookStructure =>
  teacherParityBook(V8_BOOK, V8, bookUnitFactsOf(V8_BOOK, TEXTS))!;

/** The g5.v8 book with the exercises block minimum (owner, 2 Nov 2026). */
const minBook = (minExercises: number, minExerciseSlides: number): CoverageBookStructure =>
  teacherParityBook(
    {
      ...V8_BOOK,
      exercisePolicy: { maxExercises: 10, maxExerciseSlides: 3, minExercises, minExerciseSlides },
    },
    V8,
    bookUnitFactsOf(V8_BOOK, TEXTS),
  )!;

const MONTHS_WORKED = [
  'محرم = 1، صفر = 2، … شوال = 10، ذو القعدة = 11، ذو الحجة = 12',
  'شوال (10) ← ذو الحجة (12) ← صفر (2): يتقدم شهرين، فالتالي ربيع الآخر',
];

/** A complete g5.v8 plan of the slice: every gate passes. */
function completePlan(): SceneOutline[] {
  return [
    slide('t1', [], { slideType: 'transition' }),
    slide('recall', ['4015', '4037'], { contentKind: 'definition' }),
    slide('ex1', ['4021'], { contentRole: 'worked_example' }),
    slide('try1', ['4025'], { contentRole: 'check_understanding' }),
    slide('sol1A', ['4025'], { contentRole: 'worked_example', keyPoints: MONTHS_WORKED }),
    slide('sol1B', ['4025'], { contentRole: 'worked_example' }),
    slide('sol1C', ['4025'], { contentRole: 'worked_example' }),
    slide('t2', [], { slideType: 'transition' }),
    slide('ex2', ['4026'], { contentRole: 'worked_example' }),
    slide('t-ex', ['4038'], { slideType: 'transition', title: 'تمارين' }),
    slide('exercises', ['4038', '4040', '4060'], {
      contentRole: 'worked_example',
      keyPoints: [
        '10:15 ← 11:00 ← 11:45: كل موعد بعد السابق بـ 45 دقيقة، فالتالي 12:30 مساءً',
        'محرم = 1، ربيع الأول = 3، جمادى الأولى = 5: نتقدم شهرين، فالتالي رجب = 7',
      ],
    }),
    slide('close', ['4026'], { contentRole: 'summary' }),
  ];
}

const codes = (diagnostics: Array<{ code: string }>) => diagnostics.map((d) => d.code);

describe('g5.v8 book-map contract', () => {
  it('keeps the g5.v7 parse and digest byte-stable', () => {
    const { request } = parseKafuoGenerationRequest(body());
    expect(request.bookStructure).toEqual(V7_BOOK);
    // Pinned with the code as it was before g5.v8 (HEAD 76afe5be).
    expect(canonicalRequestDigest(request)).toBe(
      '0fb478e454d62cf7d31256597a8d66bb186c8c01f607576128c1cf093d7ac4d7',
    );
  });

  it('rebuilds the g5.v8 keys and covers them in the digest', () => {
    const v8 = { ...body(), bookStructure: V8_BOOK };
    const { request } = parseKafuoGenerationRequest(v8);
    expect(request.bookStructure).toEqual(V8_BOOK);
    const { exercisePolicy: _policy, ...withoutPolicy } = V8_BOOK;
    const { request: plain } = parseKafuoGenerationRequest({
      ...body(),
      bookStructure: withoutPolicy,
    });
    expect(plain.bookStructure).not.toHaveProperty('exercisePolicy');
    expect(canonicalRequestDigest(request)).not.toBe(canonicalRequestDigest(plain));
  });

  it('parses the optional exercise minimums; their absence keeps the parse and digest', () => {
    const withMin = {
      ...V8_BOOK,
      exercisePolicy: {
        maxExercises: 10,
        maxExerciseSlides: 3,
        minExercises: 6,
        minExerciseSlides: 2,
      },
    };
    const { request } = parseKafuoGenerationRequest(body({ bookStructure: withMin }));
    expect(request.bookStructure?.exercisePolicy).toEqual(withMin.exercisePolicy);
    const caps = { ...V8_BOOK, exercisePolicy: { maxExercises: 10, maxExerciseSlides: 3 } };
    const { request: older } = parseKafuoGenerationRequest(body({ bookStructure: caps }));
    expect(older.bookStructure?.exercisePolicy).toEqual({ maxExercises: 10, maxExerciseSlides: 3 });
    expect(Object.keys(older.bookStructure!.exercisePolicy!)).toEqual([
      'maxExercises',
      'maxExerciseSlides',
    ]);
    expect(canonicalRequestDigest(request)).not.toBe(canonicalRequestDigest(older));
  });

  it.each([
    [
      { exercisePolicy: { maxExercises: 10, maxExerciseSlides: 3, minExercises: 6 } },
      'must be sent together',
    ],
    [
      { exercisePolicy: { maxExercises: 10, maxExerciseSlides: 3, minExerciseSlides: 2 } },
      'must be sent together',
    ],
    [
      {
        exercisePolicy: {
          maxExercises: 10,
          maxExerciseSlides: 3,
          minExercises: 0,
          minExerciseSlides: 1,
        },
      },
      'exercisePolicy.minExercises must be a positive integer',
    ],
    [
      {
        exercisePolicy: {
          maxExercises: 10,
          maxExerciseSlides: 3,
          minExercises: 6,
          minExerciseSlides: '2',
        },
      },
      'exercisePolicy.minExerciseSlides must be a positive integer',
    ],
    [
      {
        exercisePolicy: {
          maxExercises: 5,
          maxExerciseSlides: 3,
          minExercises: 6,
          minExerciseSlides: 2,
        },
      },
      'must not exceed their caps',
    ],
    [
      {
        exercisePolicy: {
          maxExercises: 10,
          maxExerciseSlides: 1,
          minExercises: 6,
          minExerciseSlides: 2,
        },
      },
      'must not exceed their caps',
    ],
  ])('refuses a malformed exercise minimum', (overrides, message) => {
    expect(() =>
      parseKafuoGenerationRequest(body({ bookStructure: { ...V8_BOOK, ...overrides } })),
    ).toThrow(message);
  });

  it.each([
    [{ exercisePolicy: { maxExercises: 0, maxExerciseSlides: 3 } }, 'maxExercises'],
    [{ exercisePolicy: { maxExercises: 10, maxExerciseSlides: 1.5 } }, 'maxExerciseSlides'],
    [{ exercisePolicy: [] }, 'exercisePolicy must be an object'],
    [
      { units: [{ ...V8_BOOK.units[6], exerciseUsable: true, exerciseUnusableReason: 'empty' }] },
      'exerciseUsable must be false',
    ],
    [
      { units: [{ ...V8_BOOK.units[6], exerciseUsable: false, exerciseUnusableReason: 'blurry' }] },
      'exerciseUnusableReason',
    ],
    [{ units: [{ ...V8_BOOK.units[6], exerciseUsable: false }] }, 'exerciseUnusableReason'],
    [
      { units: [{ ...V8_BOOK.units[1], exerciseUsable: false, exerciseUnusableReason: 'empty' }] },
      'only on an exercise unit',
    ],
  ])('refuses a malformed g5.v8 key', (overrides, message) => {
    expect(() =>
      parseKafuoGenerationRequest(body({ bookStructure: { ...V8_BOOK, ...overrides } })),
    ).toThrow(message);
  });
});

describe('g5.v8 switch and planner text', () => {
  it('is an explicit Teaching Model check', () => {
    expect(isTeacherParityModel(V8)).toBe(true);
    expect(isTeacherParityModel(V7)).toBe(false);
    expect(isTeacherParityModel({ key: 'other', version: 'g5.v8' })).toBe(false);
    expect(teacherParityBook(V8_BOOK, V7)).toBe(V8_BOOK);
  });

  it('keeps the g5.v7 requirement byte for byte', () => {
    expect(bookStructureRequirement(V7_BOOK)).toBe(
      [
        '',
        'BOOK-STRUCTURED LESSON (g5.v7). Each [[CONTENT_UNIT]] marker shows the kind the book',
        'printed it as and its lesson part. The lesson template maps kinds to elements: KEY_CONCEPT=key_concept, WORKED_EXAMPLE=worked_example, UNDERSTANDING_CHECK=try_it.',
        'Plan in the book order: every required unit gets its own instructional slide that cites',
        'it; every try_it unit gets a try-it slide (contentRole check_understanding) without the',
        'answer, followed by a solution slide (contentRole worked_example) that cites it too.',
        "Never solve a try_it unit before its try-it slide: an example's own slide cites only",
        'the example, not the check that follows it.',
        'The book prints no answer to a check: its solution slide works every item to a final',
        'answer from the given data; an item that asks to guess or predict gets a reasoned number',
        '(for example from the average change), stated as an estimate.',
        'Transition slides never count as teaching a unit.',
      ].join('\n'),
    );
  });

  it('gives a g5.v8 request the teacher-parity requirement', () => {
    const v8 = parseKafuoGenerationRequest(
      body({
        teachingModel: { ...(body().teachingModel as object), version: 'g5.v8' },
        bookStructure: V8_BOOK,
      }),
    );
    const { kafuo } = buildKafuoStartRequest(v8.request, v8.aggregate);
    expect(kafuo.requirement).toContain('BOOK-STRUCTURED LESSON (g5.v8)');
    expect(kafuo.requirement).not.toContain('(g5.v7)');
    expect(kafuo.requirement).toContain('ONE solution slide');
    expect(kafuo.requirement).toContain('PER ITEM');
    expect(kafuo.requirement).toContain('RECALL');
    expect(kafuo.requirement).toContain('`ordered_named_set`');
    expect(kafuo.requirement).toContain('at most\n1 exercise slides');
    // An older wire without the minimum states none.
    expect(kafuo.requirement).not.toContain('AT LEAST');
    expect(bookStructureRequirement(minBook(6, 2), { teacherParity: true }).split('\n')).toEqual(
      expect.arrayContaining([
        'The block is not optional: it holds AT LEAST 6 usable exercise units',
        'on AT LEAST 2 exercise slides. Prefer one item per pattern or',
      ]),
    );
    // The same map under g5.v7 keeps the g5.v7 text.
    const v7 = parseKafuoGenerationRequest(body({ bookStructure: V8_BOOK }));
    expect(buildKafuoStartRequest(v7.request, v7.aggregate).kafuo.requirement).toContain(
      'BOOK-STRUCTURED LESSON (g5.v7)',
    );
  });

  it('marks exercise units with their example and usability; other markers are unchanged', () => {
    const text = [
      '[[CONTENT_UNIT id=4025 order=13]]',
      '[[CONTENT_UNIT id=4060 order=48]]',
      '[[CONTENT_UNIT id=4061 order=49]]',
      '[[CONTENT_UNIT id=4015 order=3]]',
    ].join('\n');
    expect(annotateBookMarkers(text, V8_BOOK).split('\n')).toEqual([
      '[[CONTENT_UNIT id=4025 order=13 kind=UNDERSTANDING_CHECK element=try_it part=1]]',
      '[[CONTENT_UNIT id=4060 order=48 kind=PRACTICE element=exercise part=2 paired=4021]]',
      '[[CONTENT_UNIT id=4061 order=49 kind=PRACTICE element=exercise part=2 paired=4021 exerciseUsable=false reason=number_only]]',
      '[[CONTENT_UNIT id=4015 order=3 kind=PRIOR_KNOWLEDGE element=prior_knowledge part=1]]',
    ]);
  });
});

describe('hidden-step detector', () => {
  it('matches the catalogue one row per type', () => {
    const catalogue = readFileSync(
      join(
        process.cwd(),
        'packages/@openmaic/generation/snippets/working-steps/hidden-step-types.md',
      ),
      'utf8',
    );
    const rows = [...catalogue.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    expect(rows.sort()).toEqual(Object.keys(HIDDEN_STEP_TYPES).sort());
  });

  it('detects ordered named sets and clock times in book text', () => {
    expect(detectHiddenStepTypes('23) اجتماعات النادي: المحرّم، ربيع أول، جمادى الأولى،')).toEqual([
      'ordered_named_set',
    ]);
    expect(detectHiddenStepTypes('22) أيام العمل: الأحد، الثلاثاء، الخميس،')).toEqual([
      'ordered_named_set',
    ]);
    expect(
      detectHiddenStepTypes('20) مواعيد الوصول: ١٠:٠٠ صباحًا، 12:30 مساءً، 3:00 مساءً'),
    ).toEqual(['clock_time']);
    // One name, a ratio, or the number zero («صفر») alone is no cycle.
    expect(detectHiddenStepTypes('الناتج صفر و النسبة 1:2')).toEqual([]);
    expect(detectHiddenStepTypes('14) 0, 2, 4, 6, 8')).toEqual([]);
  });

  it('never reads the numbers واحد / أحد / اثنين / صفر as weekdays or months', () => {
    // Math 1 source 603, item (30): «اثنين» (two) and «واحد» (one).
    expect(detectHiddenStepTypes('(30) ناتج ضرب عدد في اثنين، مضافًا إليه واحد.')).toEqual([]);
    // Math 1 source 617: «أحد الفريقين» (one of the teams), «الصفر» (zero), one weekday.
    expect(
      detectHiddenStepTypes(
        '(2) إذا اعتذر أحد الفريقين فسوف تؤجل المباراة. ' +
          'لم تنخفض درجة الحرارة عن الصفر السيليزية في يوم الإثنين. ' +
          'الاستنتاج: لم يسقط الثلج يوم الإثنين.',
      ),
    ).toEqual([]);
    expect(
      detectHiddenStepTypes('أحد العددين واحد والآخر اثنين، ومجموعهما مع صفر لا يتغير في شهر محرم'),
    ).toEqual([]);
    // «الذي» and the particle «ذو» are no Hijri month beside «صفر».
    expect(detectHiddenStepTypes('العدد الذي صفر في رمضان، وعدد ذو صفر')).toEqual([]);
    // A weekday after «يوم», and «صفر» as a month in a list, still count.
    expect(detectHiddenStepTypes('يوم السبت ثم يوم الأحد')).toEqual(['ordered_named_set']);
    // A one-letter prefix before the article still counts: a two-day list.
    expect(detectHiddenStepTypes('يتدرب السبت والأحد')).toEqual(['ordered_named_set']);
    expect(detectHiddenStepTypes('محرم، صفر')).toEqual(['ordered_named_set']);
    expect(detectHiddenStepTypes('شهر صفر بعد شهر رجب')).toEqual(['ordered_named_set']);
  });

  it('counts a clock time only with a time marker, never a ratio or scale', () => {
    expect(detectHiddenStepTypes('مقياس الرسم 1:20، ثم 1:50 للمخطط الثاني')).toEqual([]);
    expect(detectHiddenStepTypes('النسبة 3:15 والنسبة 2:30')).toEqual([]);
    expect(detectHiddenStepTypes('تبدأ الساعة 7:30 وتنتهي 9:15 صباحًا')).toEqual(['clock_time']);
  });

  it('reads check item labels, never algebra', () => {
    expect(checkItemLabels('تحقق من فهمك 1A) شوال 1B) 10, 4 1C) مثلث')).toEqual(['1A', '1B', '1C']);
    expect(checkItemLabels('تحقق من فهمك (2A ناتج جمع عددين زوجيين. (2B …')).toEqual(['2A', '2B']);
    expect(checkItemLabels('(1أ) … (1ب) …')).toEqual(['1A', '1B']);
    expect(checkItemLabels('إذا كان (2a + b) = 0')).toEqual([]);
  });

  it('accepts the visible working, refuses the one-line answer', () => {
    expect(showsWorkingStep('ordered_named_set', MONTHS_WORKED.join('\n'))).toBe(true);
    expect(showsWorkingStep('ordered_named_set', 'يتقدم خمسة أشهر، فالتالي ربيع الأول')).toBe(
      false,
    );
    expect(showsWorkingStep('clock_time', '10:15 ثم 11:00: الفرق 45 دقيقة')).toBe(true);
    expect(showsWorkingStep('clock_time', 'التالي 12:30 مساءً')).toBe(false);
  });
});

describe('g5.v8 coverage gates', () => {
  it('passes a complete plan', () => {
    expect(findBookCoverageDiagnostics(completePlan(), v8Book())).toEqual([]);
  });

  it('never applies to the same map under g5.v7', () => {
    const plan = completePlan().filter((outline) => !['recall', 'sol1B'].includes(outline.id!));
    const v7 = teacherParityBook(V8_BOOK, V7);
    expect(findBookCoverageDiagnostics(plan, v7)).toEqual([]);
  });

  it('asks for the recall slide after part 1 opens', () => {
    const plan = completePlan().filter((outline) => outline.id !== 'recall');
    const gaps = findBookCoverageGaps(plan, v8Book());
    expect(gaps).toEqual([
      expect.objectContaining({
        kind: 'missing_recall',
        citeUnitIds: ['4015', '4037'],
        anchorIndex: 0,
      }),
    ]);
  });

  it('asks for one solution slide per check item', () => {
    const plan = completePlan().filter((outline) => !['sol1B', 'sol1C'].includes(outline.id!));
    const gaps = findBookCoverageGaps(plan, v8Book());
    expect(gaps.map((gap) => [gap.kind, gap.itemLabel, gap.anchorIndex])).toEqual([
      ['missing_solution', '1B', 4],
      ['missing_solution', '1C', 4],
    ]);
    // The admin may insert them, after the check's last solution slide.
    expect(insertableBookGaps(plan, v8Book(), [])).toHaveLength(2);
  });

  it('refuses the exercise caps, an unusable item and a misplaced block', () => {
    const plan = completePlan();
    const extra = slide('exercises-2', ['4061'], { contentRole: 'worked_example' });
    const early = slide('early', ['4060'], { contentRole: 'worked_example' });
    plan.splice(3, 0, early);
    plan.splice(plan.length - 1, 0, extra);
    const found = findBookCoverageDiagnostics(plan, v8Book());
    expect(codes(found).sort()).toEqual(
      [
        EXERCISE_CAP_EXCEEDED, // 3 exercise slides > 1
        EXERCISE_UNUSABLE_CITED, // 4061 is number_only
        EXERCISES_MISPLACED, // 'early' sits inside part 1
      ].sort(),
    );
    expect(found.find((d) => d.code === EXERCISES_MISPLACED)?.outlineId).toBe('early');
    // The instruction line (4038, instructions_only) is cited without a finding.
    const more = completePlan().map((outline) =>
      outline.id === 'exercises'
        ? { ...outline, sourceContentUnitIds: ['4038', '4040', '4060', '4062'] }
        : outline,
    );
    const book = v8Book();
    book.units = [...book.units, { ...book.units[7]!, contentUnitId: '4062' }];
    expect(codes(findBookCoverageDiagnostics(more, book))).toEqual([EXERCISE_CAP_EXCEEDED]);
  });

  it('raises EXERCISE_TOO_FEW below the minimum units or slides, never without one', () => {
    // completePlan: 2 usable units (4040, 4060) on 1 exercise slide.
    expect(codes(findBookCoverageDiagnostics(completePlan(), v8Book()))).toEqual([]);
    expect(codes(findBookCoverageDiagnostics(completePlan(), minBook(2, 1)))).toEqual([]);
    const found = findBookCoverageDiagnostics(completePlan(), minBook(3, 2));
    expect(found.map((d) => [d.code, d.field, d.disposition])).toEqual([
      [EXERCISE_TOO_FEW, 'sourceContentUnitIds', 'admin_correctable'],
      [EXERCISE_TOO_FEW, 'sourceContentUnitIds', 'admin_correctable'],
    ]);
    expect(found.map((d) => d.message)).toEqual([
      'the exercises block cites fewer than 3 usable exercise units',
      'the exercises block has fewer than 2 exercise slides',
    ]);
    expect(found.every(isIgnorableIssue)).toBe(true);
    // Only the cited usable units count: the instruction line (4038) does not.
    const units = completePlan().map((outline) =>
      outline.id === 'exercises' ? { ...outline, sourceContentUnitIds: ['4038', '4040'] } : outline,
    );
    expect(codes(findBookCoverageDiagnostics(units, minBook(2, 1)))).toEqual([EXERCISE_TOO_FEW]);
    // No exercise slide at all is the missing_exercises gap alone.
    const none = completePlan().filter((outline) => outline.id !== 'exercises');
    expect(codes(findBookCoverageDiagnostics(none, minBook(3, 2)))).toEqual([
      BOOK_COVERAGE_INCOMPLETE,
    ]);
    // The same map under g5.v7 is never checked for it.
    const v7 = { ...V8_BOOK, exercisePolicy: minBook(3, 2).exercisePolicy };
    expect(codes(findBookCoverageDiagnostics(completePlan(), teacherParityBook(v7, V7)))).toEqual(
      [],
    );
  });

  it('asks for the exercises block when no slide solves an exercise', () => {
    const plan = completePlan().filter((outline) => outline.id !== 'exercises');
    const gaps = findBookCoverageGaps(plan, v8Book());
    expect(gaps.map((gap) => [gap.kind, gap.unit.contentUnitId, gap.anchorIndex])).toEqual([
      ['missing_exercises', '4040', undefined],
    ]);
  });

  it('raises WORKING_STEP_MISSING when the set or the minutes are not written', () => {
    const plan = completePlan().map((outline) =>
      outline.id === 'sol1A' || outline.id === 'exercises'
        ? { ...outline, keyPoints: ['يتقدم خمسة أشهر', 'التالي 12:30 مساءً'] }
        : outline,
    );
    const found = findBookCoverageDiagnostics(plan, v8Book()).filter(
      (d) => d.code === WORKING_STEP_MISSING,
    );
    expect(found.map((d) => d.message)).toEqual([
      expect.stringMatching(/4025.*\(ordered_named_set\)$/),
      expect.stringMatching(/4040.*\(clock_time\)$/),
      expect.stringMatching(/4060.*\(ordered_named_set\)$/),
    ]);
  });

  it('lets a person ignore every new code', () => {
    const plan = completePlan().filter((outline) => !['recall', 'sol1B'].includes(outline.id!));
    plan.splice(3, 0, slide('early', ['4061'], { contentRole: 'worked_example' }));
    const found = findBookCoverageDiagnostics(plan, v8Book());
    expect(new Set(codes(found))).toEqual(
      new Set([
        BOOK_COVERAGE_INCOMPLETE,
        EXERCISE_CAP_EXCEEDED,
        EXERCISE_UNUSABLE_CITED,
        EXERCISES_MISPLACED,
      ]),
    );
    expect(found.every(isIgnorableIssue)).toBe(true);
  });
});

describe('g5.v8 in the correction re-check', () => {
  const checkpoint = {
    sourceRefs: {
      essentialContentUnitIds: [],
      bookUnitFacts: bookUnitFactsOf(V8_BOOK, TEXTS),
      contentUnitIds: null,
      sourceImages: [],
    },
  } as unknown as Pick<GenerationCheckpoint, 'sourceRefs'>;

  it('reads the pinned facts for a g5.v8 attempt only', () => {
    const v8 = diagnosisContextFromCheckpoint(checkpoint, [], false, V8_BOOK, V8);
    expect(v8.bookStructure?.teacherParity).toBe(true);
    expect(v8.bookStructure?.unitFacts?.['4025']?.itemLabels).toEqual(['1A', '1B', '1C']);
    const v7 = diagnosisContextFromCheckpoint(checkpoint, [], false, V8_BOOK, V7);
    expect(v7.bookStructure).toEqual(V8_BOOK);
    // A checkpoint paused before the attempt's model was passed reads as before.
    expect(diagnosisContextFromCheckpoint(checkpoint, [], false, V8_BOOK).bookStructure).toEqual(
      V8_BOOK,
    );
    expect(correctionCoverageBook(checkpoint.sourceRefs, undefined, V8)).toBeUndefined();
  });
});

describe('g5.v8 coverage repair', () => {
  const FLOW = [
    { stage: 'lesson_opener', instructions: '' },
    { stage: 'lesson_learning_map', instructions: '' },
    { stage: 'outcome_visual_explanations', instructions: 'Teach the part.' },
  ] as unknown as TeachingFlowEntry[];

  const planner = () =>
    vi.fn(async (input: PlanInsertedSlideInput) => {
      const role = /contentRole (\w+)/.exec(input.instruction)?.[1] ?? 'explanation';
      const outline = slide(input.outlineId, [...input.unitIds], {
        contentRole: role as SceneOutline['contentRole'],
        title: /item (\w+)/.exec(input.instruction)?.[1] ?? 'recall',
        teachingStage: input.teachingStage,
      });
      const checked = input.check(outline);
      return checked.ok
        ? { ok: true as const, outline: checked.outline, repairs: [], calls: 1 }
        : { ok: false as const, code: 'INSERTION_PLAN_INVALID' as const, message: 'x', calls: 1 };
    });

  const contextFor = (
    book: CoverageBookStructure,
    plan: BookCoverageRepairContext['plan'],
    visuals: BookCoverageRepairContext['visuals'] = [],
  ): BookCoverageRepairContext => ({
    book,
    flow: FLOW,
    units: ['4015', '4037', '4021', '4025'].map((id, order) => ({
      id,
      order,
      role: 'X',
      title: null,
      text: 'text',
    })),
    skillOptions: null,
    language: 'ar-SA',
    languageDirective: '',
    visuals,
    diagnose: (outlines) => ({ outlines, blocking: findBookCoverageDiagnostics(outlines, book) }),
    plan,
  });

  it('plans the recall slide and each missing item in book order, with distinct ids', async () => {
    const plan = planner();
    const book = v8Book();
    const candidate = completePlan().filter(
      (outline) => !['recall', 'sol1B', 'sol1C'].includes(outline.id!),
    );
    const blocking = findBookCoverageDiagnostics(candidate, book);
    const repaired = await repairBookCoverageGaps(
      candidate,
      blocking,
      vi.fn(),
      contextFor(book, plan),
    );
    expect(repaired.blocking).toEqual([]);
    expect(repaired.outlines.slice(0, 7).map((outline) => outline.title)).toEqual([
      't1',
      'recall',
      'ex1',
      'try1',
      'sol1A',
      '1B',
      '1C',
    ]);
    expect(repaired.outlines.slice(5, 7).map((outline) => outline.id)).toEqual([
      'sol1A-book-missing_solution-4025-1B-r1',
      'sol1A-book-missing_solution-4025-1C-r1',
    ]);
    const recall = plan.mock.calls.find(([input]) => input.instruction.includes('recall'))![0];
    expect(recall.instruction).toContain('contentRole explanation');
    expect(recall.unitIds).toEqual(['4015', '4037']);
  });

  it('still places the item slides when g5.v8 findings stay open', async () => {
    const book = v8Book();
    const candidate = completePlan()
      .filter((outline) => !['sol1B', 'sol1C', 'exercises'].includes(outline.id!))
      .map((outline) =>
        outline.id === 'sol1A' ? { ...outline, keyPoints: ['يتقدم خمسة أشهر'] } : outline,
      );
    const blocking = findBookCoverageDiagnostics(candidate, book);
    expect(new Set(codes(blocking))).toEqual(
      new Set([BOOK_COVERAGE_INCOMPLETE, WORKING_STEP_MISSING]),
    );
    const repaired = await repairBookCoverageGaps(
      candidate,
      blocking,
      vi.fn(),
      contextFor(book, planner()),
    );
    expect(repaired.inserted).toBe(2);
    // Left to a person: the visible working and the (unanchored) exercises block.
    expect(repaired.blocking.map((d) => [d.code, d.message.slice(0, 30)])).toEqual([
      [BOOK_COVERAGE_INCOMPLETE, 'the exercises block is missing'],
      [WORKING_STEP_MISSING, expect.any(String)],
    ]);
  });

  it('places the item slides and leaves EXERCISE_TOO_FEW open for a person', async () => {
    const book = minBook(3, 2);
    const candidate = completePlan().filter((outline) => !['sol1B', 'sol1C'].includes(outline.id!));
    const blocking = findBookCoverageDiagnostics(candidate, book);
    expect(new Set(codes(blocking))).toEqual(new Set([BOOK_COVERAGE_INCOMPLETE, EXERCISE_TOO_FEW]));
    const repaired = await repairBookCoverageGaps(
      candidate,
      blocking,
      vi.fn(),
      contextFor(book, planner()),
    );
    expect(repaired.inserted).toBe(2);
    expect(codes(repaired.blocking)).toEqual([EXERCISE_TOO_FEW, EXERCISE_TOO_FEW]);
  });

  it('gives an extra item slide a native diagram when the check image is already shown', async () => {
    const book = v8Book();
    const plan = planner();
    const candidate = completePlan()
      .filter((outline) => !['sol1C'].includes(outline.id!))
      .map((outline) =>
        outline.id === 'sol1A' ? { ...outline, suggestedImageIds: ['img-4025'] } : outline,
      );
    const visual = { id: 'img-4025', src: 'data:', sourceContentUnitIds: ['4025'] };
    const repaired = await repairBookCoverageGaps(
      candidate,
      findBookCoverageDiagnostics(candidate, book),
      vi.fn(),
      contextFor(book, plan, [visual]),
    );
    expect(repaired.inserted).toBe(1);
    expect(plan.mock.calls[0]![0].eligibleVisuals).toEqual([]);
  });
});

describe('g5.v8 admin insert', () => {
  it('inserts the next item, without the image another slide already shows', () => {
    const book = v8Book();
    const plan = completePlan()
      .filter((outline) => !['sol1B', 'sol1C'].includes(outline.id!))
      .map((outline) =>
        outline.id === 'sol1A' ? { ...outline, suggestedImageIds: ['img-4025'] } : outline,
      );
    const next = applyCorrectionOperations(
      plan,
      [{ op: 'insert_book_slide', unitId: '4025', outlineId: 'sol1A' }],
      {
        phase: 'outline',
        flow: [],
        sourceRefs: {
          sourceImages: [{ id: 'img-4025', sha256: 'x', sourceContentUnitIds: ['4025'] }],
        } as unknown as GenerationCheckpoint['sourceRefs'],
        pendingOutlineIds: null,
        bookStructure: book,
      },
    );
    const inserted = next[5]!;
    expect(inserted.id).toBe('sol1A-book-missing_solution-4025');
    expect(inserted.description).toContain('item 1B only');
    expect(inserted.suggestedImageIds).toBeUndefined();
  });
});

describe('split-unit duplicate image (lesson 306, example 4021)', () => {
  const IMAGE = {
    id: 'src-1',
    src: '',
    pageNumber: 9,
    sourceContentUnitIds: ['4021'],
    description: 'Line segments in a growing pattern with lengths 4, 10, 18, 28, 40',
  };

  it('keeps the image on the segments slide and re-plans the bus slide', () => {
    const outlines = [
      slide('s5', ['4021'], {
        contentRole: 'worked_example',
        keyPoints: ['مواعيد الحافلات: 10:15، 11:00، 11:45', 'الفرق 45 دقيقة، فالتالي 12:30'],
        suggestedImageIds: ['src-1'],
        imagePlans: [{ imageId: 'src-1', shows: 'جدول مواعيد الحافلات', teachingPoint: 'x' }],
      }),
      slide('s6', ['4021'], {
        contentRole: 'worked_example',
        keyPoints: ['أطوال القطع: 4، 10، 18، 28، 40', 'الفروق 6، 8، 10، 12'],
        suggestedImageIds: ['src-1'],
        imagePlans: [{ imageId: 'src-1', shows: 'قطع مستقيمة', teachingPoint: 'x' }],
      }),
      slide('other', ['4026'], { suggestedImageIds: ['src-1'] }),
    ];
    expect(findSplitUnitDuplicateImages(outlines, [IMAGE])).toEqual([
      { outlineId: 's5', imageId: 'src-1', keptOnOutlineId: 's6' },
    ]);
  });
});
