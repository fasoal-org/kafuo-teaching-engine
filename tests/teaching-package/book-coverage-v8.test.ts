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
  EXERCISE_SELECTED_MISSING,
  EXERCISE_TOO_FEW,
  EXERCISE_UNSELECTED_CITED,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  exerciseBlockRequirement,
  findBookCoverageDiagnostics,
  findBookCoverageGaps,
  isTeacherParityModel,
  teacherParityBook,
  WORKING_STEP_MISSING,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  mergeDuplicateSolutions,
  repairBookCoverageGaps,
  type BookCoverageRepairContext,
} from '@/lib/server/teaching-package/book-coverage-repair';
import {
  checkItemLabels,
  detectHiddenStepTypes,
  exerciseQuestionNumbers,
  HIDDEN_STEP_TYPES,
  showsWorkingStep,
} from '@/lib/server/teaching-package/hidden-step-types';

describe('RTL question numbers (4 Nov 2026)', () => {
  it('counts «.5 » at line start, never a decimal inside a line', () => {
    expect(exerciseQuestionNumbers('.5 احسب\n.6 بسّط\nالناتج 0.5 تقريبًا')).toEqual([5, 6]);
    expect(checkItemLabels('تأكد\n.1 أوجد\n.2 احسب 3.5')).toEqual(['1', '2']);
  });

  it('reads the math OCR form «value (N» as items in consecutive runs only', () => {
    // Lesson 312 unit 5464, as stored (content_units.text).
    const unit5464 = [
      'تأكد',
      '',
      'مثال 1 حدّد مجموعات الأعداد التي ينتمي إليها كل عدد مما يأتي:',
      '',
      '62 (1 \\frac{5}{4} (2 \\sqrt{11} (3 -12 (4',
      '',
      'مثال 2 ما الخاصية الموضّحة في كلّ ممّا يأتي؟',
      '',
      '(6 \\cdot 8) \\cdot 5 = 6 \\cdot (8 \\cdot 5) (5 7(9 - 5) = 7 \\cdot 9 - 7 \\cdot 5 (6',
      '',
      '84 + 16 = 16 + 84 (7 (12 + 5)6 = 12 \\cdot 6 + 5 \\cdot 6 (8',
      '',
      'مثال 3 أوجد النظير الجمعي والنظير الضربي لكل عدد مما يأتي:',
      '',
      '-7 (9 \\frac{4}{9} (10 3.8 (11 \\sqrt{5} (12',
      '',
      'مثال 4 13) تخفيضات: يبين الجدول المجاور أسعار أربعة أصناف من الملابس في أحد العروض. فإذا زاد السعر الأصلي لكلّ منها بنسبة 8% فأوجد قيمة هذه الزيادة.',
      '',
      'الصنف السعر (﷼) قميص 40 بنطال 60 ثوب 100 معطف 200',
      '',
      'مثال 5 بسّط كل عبارة مما يأتي:',
      '',
      '5(3x + 6y) + 4(2x - 9y) (14 6(6a + 5b) - 3(4a + 7b) (15',
      '',
      '-4(6c - 3d) - 5(-2c - 4d) (16 -5(8x - 2y) - 4(-6x - 3y) (17',
    ].join('\n');
    const items5464 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17];
    expect(exerciseQuestionNumbers(unit5464)).toEqual(items5464);
    expect(checkItemLabels(unit5464)).toEqual(items5464.map(String));
    // Lesson 312 unit 5466, as stored.
    const unit5466 = [
      'مثال 5',
      '',
      'بسط كل عبارة مما يأتي:',
      '',
      '-2a + 9d - 5a - 6d \\quad (38)',
      '',
      '8b - 3c + 4b + 9c \\quad (37)',
      '',
      '6(9a - 3b) - 8(2a + 4b) \\quad (40)',
      '',
      '4(4x - 9y) + 8(3x + 2y) \\quad (39)',
      '',
      '-5(10x + 8z) - 6(4x - 7z) \\quad (42)',
      '',
      '-2(-5g + 6k) - 9(-2g + 4k) \\quad (41)',
    ].join('\n');
    expect(exerciseQuestionNumbers(unit5466)).toEqual([37, 38, 39, 40, 41, 42]);
    expect(checkItemLabels(unit5466)).toEqual(['37', '38', '39', '40', '41', '42']);
    // One stray bracket after a value is no item; neither is an expression bracket.
    expect(
      exerciseQuestionNumbers('القيمة 62 (7 تقريبًا\nس = 6 \\cdot (8 + 5) و 2 \\cdot (9 + 1)'),
    ).toEqual([]);
  });
});
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
    // One solution slide per check (owner, 4 Nov 2026).
    slide('sol1A', ['4025'], { contentRole: 'worked_example', keyPoints: MONTHS_WORKED }),
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
    expect(kafuo.requirement).toContain('PER CHECK');
    expect(kafuo.requirement).not.toContain('PER ITEM');
    expect(kafuo.requirement).toContain('RECALL');
    expect(kafuo.requirement).toContain('`ordered_named_set`');
    expect(kafuo.requirement).toContain('«تمارين», then the exercise slides');
    // The engine picks the items: no count or choice is left to the planner.
    expect(kafuo.requirement).toContain('The engine fixes which');
    expect(kafuo.requirement).not.toContain('AT LEAST');
    expect(kafuo.requirement).not.toContain('Prefer one item per pattern');
    expect(bookStructureRequirement(minBook(6, 2), { teacherParity: true })).not.toContain(
      'AT LEAST',
    );
    // The same map under g5.v7 keeps the g5.v7 text.
    const v7 = parseKafuoGenerationRequest(body({ bookStructure: V8_BOOK }));
    expect(buildKafuoStartRequest(v7.request, v7.aggregate).kafuo.requirement).toContain(
      'BOOK-STRUCTURED LESSON (g5.v7)',
    );
  });

  it('tells the planner exactly which exercise units each exercise slide solves', () => {
    expect(exerciseBlockRequirement(minBook(2, 1)).split('\n')).toEqual([
      '',
      '',
      'EXERCISES BLOCK (fixed by the engine): one «تمارين» transition slide, then exactly 1',
      'exercise slide (contentRole worked_example), in this order:',
      '- exercise slide 1 solves the units 4040, 4060;',
      'Each exercise slide cites exactly its units above (and may also cite the',
      'reason=instructions_only unit paired with the same example). Do not cite any other',
      'exercise unit anywhere in the lesson.',
    ]);
    expect(exerciseBlockRequirement(minBook(2, 2))).toContain(
      'exactly 2\nexercise slides (contentRole worked_example), in this order:\n' +
        '- exercise slide 1 solves the units 4040;\n- exercise slide 2 solves the units 4060;',
    );
    // Never for g5.v7, a map without a policy, or no usable exercise.
    expect(exerciseBlockRequirement(teacherParityBook(V8_BOOK, V7))).toBe('');
    const { exercisePolicy: _policy, ...noPolicy } = V8_BOOK;
    expect(exerciseBlockRequirement(teacherParityBook(noPolicy, V8))).toBe('');
    const unusable = {
      ...V8_BOOK,
      units: V8_BOOK.units.filter((unit) => !['4040', '4060'].includes(unit.contentUnitId)),
    };
    expect(exerciseBlockRequirement(teacherParityBook(unusable, V8))).toBe('');
    // …and then the v8 text says there is no block instead of pointing to one.
    const none = bookStructureRequirement(unusable, { teacherParity: true });
    expect(none).toContain('so the lesson has no\nexercises block');
    expect(none).not.toContain('EXERCISES BLOCK below');
    expect(bookStructureRequirement(V8_BOOK, { teacherParity: true })).toContain(
      'EXERCISES BLOCK below',
    );
    // Lessons 314/315/318: every check after an example is named by id.
    expect(bookStructureRequirement(V8_BOOK, { teacherParity: true })).toContain(
      '4025 (after example 4021)',
    );
    expect(bookStructureRequirement(V8_BOOK)).not.toContain('after example 4021');
    expect(exerciseBlockRequirement(undefined)).toBe('');
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
    // A weekday after «يوم», and «صفر» as a month in a list, still count (with a step).
    expect(detectHiddenStepTypes('يوم السبت ثم يوم الأحد، فما اليوم بعد 8 أيام؟')).toEqual([
      'ordered_named_set',
    ]);
    // A one-letter prefix before the article still counts: a two-day list and a dual step.
    expect(detectHiddenStepTypes('يتدرب السبت والأحد، ويرتاح يومين')).toEqual([
      'ordered_named_set',
    ]);
    expect(detectHiddenStepTypes('محرم، صفر، ربيع الأول')).toEqual(['ordered_named_set']);
    expect(detectHiddenStepTypes('بعد سبعة أشهر من شهر رجب يأتي شهر صفر')).toEqual([
      'ordered_named_set',
    ]);
  });

  it('needs three names, or two with a counted step, before asking for the numbered set', () => {
    // Lesson 328 unit 6139 (13 Nov 2026): two weekdays in a statement whose hypothesis and
    // conclusion the learner names. Nothing is counted, so no numbered week is owed.
    expect(
      detectHiddenStepTypes(
        'تأكد\n\nالمثال 1 حدّد الفرض والنتيجة في كلّ من العبارات الشرطية الآتية:\n\n' +
          '(1 يوم غد هو السبت إذا كان اليوم هو الجمعة.\n\n(2 إذا كان 7 > 5 + 2x، فإن x > 1.\n\n' +
          '(3 إذا كانت الزاويتان متكاملتين، فإن مجموع قياسيهما 180^\\text{o}',
      ),
    ).toEqual([]);
    expect(detectHiddenStepTypes('يوم السبت ثم يوم الأحد')).toEqual([]);
    expect(detectHiddenStepTypes('محرم، صفر')).toEqual([]);
    expect(detectHiddenStepTypes('في يوم الخميس 3 حصص ويوم الجمعة عطلة')).toEqual([]);
    // An item number before «يوم» is a label, not a count: «(1 يوم …», «2 يوم …» at line start.
    expect(detectHiddenStepTypes('(1 يوم السبت\n2 يوم الأحد')).toEqual([]);
    // Each counted step, beside two names.
    for (const step of [
      'بعد 10 أيام',
      'بعد ١٠٠ يوم',
      'بعد (10 أيام)',
      'ب3 أيام',
      'بعد خمسة أشهر',
      'بعد خمسة وعشرين يومًا',
      'بعد أسبوعين',
      'بيومين',
      'كم يومًا بينهما؟',
      'فكم يومًا بينهما؟',
      'how many days later?',
    ]) {
      expect(detectHiddenStepTypes(`إذا كان اليوم الجمعة فهل يكون السبت ${step}`)).toEqual([
        'ordered_named_set',
      ]);
    }
    expect(detectHiddenStepTypes('كم عدد الأيام من الأحد إلى الخميس؟')).toEqual([
      'ordered_named_set',
    ]);
  });

  it('never reads a date, a time or a scattered mention as a counted step', () => {
    // A number before a singular unit that names the day is a date, not a count.
    expect(detectHiddenStepTypes('باع 12 يوم السبت و15 يوم الأحد')).toEqual([]);
    // The minutes of a time of day are no count of days.
    expect(detectHiddenStepTypes('الساعة 7:30 يوم السبت ثم يوم الأحد')).toEqual([]);
    // Names and a count in different items (a blank line between) do not add up.
    expect(
      detectHiddenStepTypes('(1 اليوم الجمعة.\n\n(2 بعد 10 أيام يبدأ الاختبار.\n\n(3 غدًا السبت.'),
    ).toEqual([]);
    // Three names scattered over separate statements are no written sequence.
    expect(
      detectHiddenStepTypes(
        '(1 إذا كان اليوم الأحد فإن الدرس طويل.\n\n(2 يوم الثلاثاء عطلة.\n\n(3 الخميس آخر الأسبوع.',
      ),
    ).toEqual([]);
    // Three names as a sequence still count, with «و» or «ثم» between them.
    expect(detectHiddenStepTypes('يتدرب الأحد والثلاثاء والخميس')).toEqual(['ordered_named_set']);
    expect(detectHiddenStepTypes('السبت ثم الأحد ثم الاثنين')).toEqual(['ordered_named_set']);
    expect(detectHiddenStepTypes('محرم ثم صفر ثم ربيع الأول')).toEqual(['ordered_named_set']);
  });

  it('keeps an item whole across a blank line with no item number after it', () => {
    // The stem counts, the choices name the days: one item, split only by a paragraph break.
    expect(
      detectHiddenStepTypes(
        '(5 إذا كان اليوم الأحد، فما اليوم بعد 25 يومًا؟\n\nأ) الخميس ب) الجمعة',
      ),
    ).toEqual(['ordered_named_set']);
    // «100 يوم» before a word that is no day or month name still counts.
    expect(
      detectHiddenStepTypes('إذا كان اليوم الجمعة فهل يكون السبت بعد 100 يوم الأولى؟'),
    ).toEqual(['ordered_named_set']);
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
    // «1.»-style labels at line start (3 Nov 2026); «1.5» and «1-1» are not items.
    expect(checkItemLabels('تحقق من فهمك\n١. أوجد\n2- احسب\n(3) بسّط\n4) قارن 1.5')).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(checkItemLabels('الدرس 1-1 يساوي 1.5')).toEqual([]);
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

  it('asks for one solution slide per check, not per lettered item (4 Nov 2026)', () => {
    // One solution slide solving 1A, 1B and 1C together passes.
    const plan = completePlan().filter((outline) => !['sol1B', 'sol1C'].includes(outline.id!));
    expect(findBookCoverageGaps(plan, v8Book())).toEqual([]);
    // A planner split across slides is still accepted.
    expect(findBookCoverageGaps(completePlan(), v8Book())).toEqual([]);
    // No solution at all: one gap for the check, with no item label.
    const none = completePlan().filter(
      (outline) => !['sol1A', 'sol1B', 'sol1C'].includes(outline.id!),
    );
    const gaps = findBookCoverageGaps(none, v8Book());
    expect(gaps.map((gap) => [gap.kind, gap.itemLabel])).toEqual([['missing_solution', undefined]]);
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
    // The engine selected 4040 and 4060 (cap 2): 4062 is cited unselected,
    // reported once by the set check, not again as a unit-count cap.
    expect(findBookCoverageDiagnostics(more, book).map((d) => [d.code, d.message])).toEqual([
      [
        EXERCISE_UNSELECTED_CITED,
        'exercise unit 4062 is cited but is not selected for the exercises block',
      ],
    ]);
  });

  it('accepts one 8-question unit cited on 2 exercise slides by question range', () => {
    const texts = [
      ...TEXTS.filter((entry) => entry.id !== '4040'),
      { id: '4040', text: '1. أ\n2. ب\n3. ج\n4. د\n5. هـ\n6. و\n7. ز\n8. ح' },
    ];
    const policy = {
      maxExercises: 10,
      maxExerciseSlides: 3,
      minExercises: 6,
      minExerciseSlides: 2,
    };
    const book = teacherParityBook(
      { ...V8_BOOK, exercisePolicy: policy },
      V8,
      bookUnitFactsOf(V8_BOOK, texts),
    )!;
    const plan = completePlan();
    const at = plan.findIndex((outline) => outline.id === 'exercises');
    plan.splice(
      at,
      1,
      slide('exercises', ['4038', '4040'], { contentRole: 'worked_example' }),
      slide('exercises-2', ['4040'], { contentRole: 'worked_example' }),
    );
    expect(findBookCoverageDiagnostics(plan, book)).toEqual([]);
    const requirement = exerciseBlockRequirement(book);
    expect(requirement).toContain('- exercise slide 1 solves the units 4040 (questions 1–4 only);');
    expect(requirement).toContain('- exercise slide 2 solves the units 4040 (questions 5–8 only);');
  });

  it('accepts exactly the selected set and names a selected unit left uncited', () => {
    expect(findBookCoverageDiagnostics(completePlan(), minBook(2, 1))).toEqual([]);
    const missing = completePlan().map((outline) =>
      outline.id === 'exercises' ? { ...outline, sourceContentUnitIds: ['4038', '4040'] } : outline,
    );
    const found = findBookCoverageDiagnostics(missing, v8Book());
    expect(found.map((d) => [d.code, d.message, d.disposition])).toEqual([
      [
        EXERCISE_SELECTED_MISSING,
        'exercise unit 4060 is selected for the exercises block but no exercise slide cites it',
        'admin_correctable',
      ],
    ]);
    expect(found.every(isIgnorableIssue)).toBe(true);
    // No exercise slide at all is the missing_exercises gap alone.
    const none = completePlan().filter((outline) => outline.id !== 'exercises');
    expect(codes(findBookCoverageDiagnostics(none, v8Book()))).toEqual([BOOK_COVERAGE_INCOMPLETE]);
    // g5.v7 never checks the selection.
    expect(codes(findBookCoverageDiagnostics(missing, teacherParityBook(V8_BOOK, V7)))).toEqual([]);
  });

  it('raises EXERCISE_TOO_FEW below the minimum slides, never without one', () => {
    // completePlan: 2 usable units (4040, 4060) on 1 exercise slide.
    expect(codes(findBookCoverageDiagnostics(completePlan(), v8Book()))).toEqual([]);
    expect(codes(findBookCoverageDiagnostics(completePlan(), minBook(2, 1)))).toEqual([]);
    // The engine plans 2 units on 2 slides: the units are checked by set only
    // (both cited, and fewer than 3 exist), the 1 slide is below the minimum.
    const found = findBookCoverageDiagnostics(completePlan(), minBook(3, 2));
    expect(found.map((d) => [d.code, d.field, d.disposition, d.message])).toEqual([
      [
        EXERCISE_TOO_FEW,
        'sourceContentUnitIds',
        'admin_correctable',
        'the exercises block has fewer than 2 exercise slides',
      ],
    ]);
    expect(found.every(isIgnorableIssue)).toBe(true);
    // A missing unit is the set finding alone, never also a unit-count minimum.
    const units = completePlan().map((outline) =>
      outline.id === 'exercises' ? { ...outline, sourceContentUnitIds: ['4038', '4040'] } : outline,
    );
    expect(codes(findBookCoverageDiagnostics(units, minBook(2, 1)))).toEqual([
      EXERCISE_SELECTED_MISSING,
    ]);
    // Fewer usable units than the slide minimum: the engine's own plan (1 unit
    // on 1 slide) is never refused.
    const single = teacherParityBook(
      {
        ...V8_BOOK,
        units: V8_BOOK.units.filter((unit) => unit.contentUnitId !== '4060'),
        exercisePolicy: {
          maxExercises: 10,
          maxExerciseSlides: 3,
          minExercises: 2,
          minExerciseSlides: 2,
        },
      },
      V8,
      bookUnitFactsOf(V8_BOOK, TEXTS),
    )!;
    const followsEngine = completePlan().map((outline) =>
      outline.id === 'exercises' ? { ...outline, sourceContentUnitIds: ['4038', '4040'] } : outline,
    );
    expect(codes(findBookCoverageDiagnostics(followsEngine, single))).toEqual([]);
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

  it('E-2: a merge keeps a working step written in a removed per-item title', () => {
    const plan = completePlan().flatMap((outline) =>
      outline.id === 'sol1A'
        ? [
            { ...outline, title: 'حل 1A', keyPoints: ['يتقدم شهرين'] },
            slide('sol1B', ['4025'], {
              contentRole: 'worked_example',
              title: MONTHS_WORKED[0]!,
              description: 'نرتب الأشهر بأرقامها',
              keyPoints: ['فالتالي ربيع الآخر'],
            }),
          ]
        : [outline],
    );
    const working = (outlines: SceneOutline[]) =>
      codes(findBookCoverageDiagnostics(outlines, v8Book())).filter(
        (code) => code === WORKING_STEP_MISSING,
      );
    expect(working(plan)).toEqual([]);
    const { outlines, merged } = mergeDuplicateSolutions(plan, v8Book());
    expect(merged).toBe(1);
    const kept = outlines.find((outline) => outline.id === 'sol1A')!;
    expect(kept.keyPoints).toEqual([
      'يتقدم شهرين',
      MONTHS_WORKED[0],
      'نرتب الأشهر بأرقامها',
      'فالتالي ربيع الآخر',
    ]);
    expect(working(outlines)).toEqual([]);
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
        title: role === 'worked_example' ? 'solution' : 'recall',
        teachingStage: input.teachingStage,
        // One solution slide per check works every item with visible steps.
        ...(role === 'worked_example' ? { keyPoints: MONTHS_WORKED } : {}),
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

  it('plans the recall slide and ONE solution slide for the whole check', async () => {
    const plan = planner();
    const book = v8Book();
    const candidate = completePlan().filter(
      (outline) => !['recall', 'sol1A', 'sol1B', 'sol1C'].includes(outline.id!),
    );
    const blocking = findBookCoverageDiagnostics(candidate, book);
    const repaired = await repairBookCoverageGaps(
      candidate,
      blocking,
      vi.fn(),
      contextFor(book, plan),
    );
    expect(repaired.blocking).toEqual([]);
    expect(repaired.inserted).toBe(2);
    expect(repaired.outlines.slice(0, 6).map((outline) => outline.title)).toEqual([
      't1',
      'recall',
      'ex1',
      'try1',
      'solution',
      't2',
    ]);
    expect(repaired.outlines[4]!.id).toBe('try1-book-missing_solution-4025-r1');
    const solution = plan.mock.calls.find(([input]) =>
      input.instruction.includes('worked_example'),
    )![0];
    expect(solution.instruction).toContain('ALL of its items together on this one slide');
    expect(solution.instruction).not.toMatch(/item \w+ only/);
    const recall = plan.mock.calls.find(([input]) => input.instruction.includes('recall'))![0];
    expect(recall.instruction).toContain('contentRole explanation');
    expect(recall.unitIds).toEqual(['4015', '4037']);
  });

  it('still places the solution slide when g5.v8 findings stay open', async () => {
    const book = v8Book();
    const candidate = completePlan().filter(
      (outline) => !['sol1A', 'sol1B', 'sol1C', 'exercises'].includes(outline.id!),
    );
    const blocking = findBookCoverageDiagnostics(candidate, book);
    expect(new Set(codes(blocking))).toEqual(new Set([BOOK_COVERAGE_INCOMPLETE]));
    const repaired = await repairBookCoverageGaps(
      candidate,
      blocking,
      vi.fn(),
      contextFor(book, planner()),
    );
    expect(repaired.inserted).toBe(1);
    // Left to a person: the (unanchored) exercises block.
    expect(repaired.blocking.map((d) => [d.code, d.message.slice(0, 30)])).toEqual([
      [BOOK_COVERAGE_INCOMPLETE, 'the exercises block is missing'],
    ]);
  });

  it('places the solution slide and leaves EXERCISE_TOO_FEW open for a person', async () => {
    const book = minBook(3, 2);
    const candidate = completePlan().filter(
      (outline) => !['sol1A', 'sol1B', 'sol1C'].includes(outline.id!),
    );
    const blocking = findBookCoverageDiagnostics(candidate, book);
    expect(new Set(codes(blocking))).toEqual(new Set([BOOK_COVERAGE_INCOMPLETE, EXERCISE_TOO_FEW]));
    const repaired = await repairBookCoverageGaps(
      candidate,
      blocking,
      vi.fn(),
      contextFor(book, planner()),
    );
    expect(repaired.inserted).toBe(1);
    expect(codes(repaired.blocking)).toEqual([EXERCISE_TOO_FEW]);
  });

  it('places the solution slide and leaves the selection findings open for a person', async () => {
    const book = v8Book();
    book.units = [...book.units, { ...book.units[7]!, contentUnitId: '4062' }];
    const candidate = completePlan()
      .filter((outline) => !['sol1A', 'sol1B', 'sol1C'].includes(outline.id!))
      .map((outline) =>
        outline.id === 'exercises'
          ? { ...outline, sourceContentUnitIds: ['4038', '4040', '4062'] }
          : outline,
      );
    const repaired = await repairBookCoverageGaps(
      candidate,
      findBookCoverageDiagnostics(candidate, book),
      vi.fn(),
      contextFor(book, planner()),
    );
    expect(repaired.inserted).toBe(1);
    expect(codes(repaired.blocking)).toEqual([
      EXERCISE_SELECTED_MISSING,
      EXERCISE_UNSELECTED_CITED,
    ]);
  });

  it('inserts nothing for a check already solved on one slide', async () => {
    const book = v8Book();
    const plan = planner();
    const candidate = completePlan().filter((outline) => !['sol1B', 'sol1C'].includes(outline.id!));
    const repaired = await repairBookCoverageGaps(
      candidate,
      findBookCoverageDiagnostics(candidate, book),
      vi.fn(),
      contextFor(book, plan),
    );
    expect(repaired.inserted).toBe(0);
    expect(plan).not.toHaveBeenCalled();
  });
});

describe('g5.v8 admin insert', () => {
  it('inserts the one solution slide of the check after its try-it slide', () => {
    const book = v8Book();
    const plan = completePlan()
      .filter((outline) => !['sol1A', 'sol1B', 'sol1C'].includes(outline.id!))
      .map((outline) =>
        outline.id === 'try1' ? { ...outline, suggestedImageIds: ['img-4025'] } : outline,
      );
    const next = applyCorrectionOperations(
      plan,
      [{ op: 'insert_book_slide', unitId: '4025', outlineId: 'try1' }],
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
    const inserted = next[4]!;
    expect(inserted.id).toBe('try1-book-missing_solution-4025');
    expect(inserted.description).toContain('ALL of its items together on this one slide');
    expect(
      next.filter(
        (outline) =>
          outline.contentRole === 'worked_example' &&
          (outline.sourceContentUnitIds ?? []).includes('4025'),
      ),
    ).toHaveLength(1);
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
