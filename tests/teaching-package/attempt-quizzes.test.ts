/**
 * g5.v10 (learner-first plan W1, owner D-1 A and D-11): the engine places a keyed
 * single-choice practice quiz after every try-it slide and before every exercise slide.
 */
import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_OUTLINE_SUFFIX,
  insertAttemptQuizzes,
  isAttemptOutline,
} from '@/lib/server/teaching-package/attempt-quizzes';
import { isBankCheckQuizOutline } from '@/lib/server/teaching-package/bank-quiz-scene';
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';

const STAGE = { key: 'outcome_visual_explanations', flowIndex: 2 } as never;

const slide = (id: string, contentRole: string, units: string[], keyPoints: string[] = ['x']) =>
  ({
    id,
    type: 'slide',
    title: id,
    description: '',
    keyPoints,
    order: 0,
    contentRole,
    teachingStage: STAGE,
    sourceContentUnitIds: units,
  }) as unknown as SceneOutline;

const BOOK: Pick<KafuoBookStructure, 'units'> = {
  units: [
    {
      contentUnitId: '6230',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '6234',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '6247',
      kind: 'GUIDED_PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
    },
  ],
};

const OUTLINES = [
  slide('ex1', 'worked_example', ['6230']),
  slide('try1', 'check_understanding', ['6234'], ['١أ', '١ب', '١ج']),
  slide('sol1', 'worked_example', ['6234']),
  slide('exer1', 'worked_example', ['6247']),
  slide('summary', 'summary', []),
];

describe('engine-placed attempt quizzes', () => {
  it('puts an attempt after each try-it slide and before each exercise slide', () => {
    const result = insertAttemptQuizzes(OUTLINES, BOOK, {
      facts: {
        '6234': { itemLabels: ['1A', '1B', '1C'], hiddenSteps: [] },
        '6247': { itemLabels: [], hiddenSteps: [], questionNumbers: [1, 2] },
      },
    });
    expect(result.map((outline) => outline.id)).toEqual([
      'ex1',
      'try1',
      `try1${ATTEMPT_OUTLINE_SUFFIX}`,
      'sol1',
      `exer1${ATTEMPT_OUTLINE_SUFFIX}`,
      'exer1',
      'summary',
    ]);
    expect(result.map((outline) => outline.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const attempt = result[2]!;
    expect(attempt).toMatchObject({
      type: 'quiz',
      title: 'جرّب بنفسك',
      keyPoints: ['١أ', '١ب', '١ج'],
      sourceContentUnitIds: ['6234'],
      teachingStage: STAGE,
      quizConfig: { questionCount: 3, difficulty: 'easy', questionTypes: ['single'] },
    });
    expect(attempt.description).toContain('never graded for marks');
    expect(result[4]!.quizConfig?.questionCount).toBe(2);
    expect(isAttemptOutline(attempt)).toBe(true);
    expect(isAttemptOutline(result[1]!)).toBe(false);
    // Never a bank placeholder: it sits at the objective position, not the check one.
    expect(isBankCheckQuizOutline(attempt)).toBe(false);
  });

  it("carries the slide's Teaching Skills so a governed Submit reads it like its slide (review HIGH-1)", () => {
    const skills = { classification: 'instructional', primary: { skillId: 'math', version: 'v1' } };
    const withSkills = OUTLINES.map((outline) =>
      outline.id === 'try1' ? ({ ...outline, teachingSkills: skills } as SceneOutline) : outline,
    );
    const attempt = insertAttemptQuizzes(withSkills, BOOK).find((o) => o.id === 'try1-attempt')!;
    expect(attempt.teachingSkills).toEqual(skills);
  });

  it("asks an exercise attempt from the book's question lines, never the solving slide's working (review LOW-10)", () => {
    const solving = [
      slide(
        'exer1',
        'worked_example',
        ['6247'],
        ['التكلفة: 4.50، 6.75، 9.00 → نضيف 2.25؛ الحد التالي 11.25'],
      ),
    ];
    const unitTexts = new Map([
      [
        '6247',
        [
          'تأكد',
          'المثال 1 اكتب تخمينًا يصف النمط في كل متتابعة مما يأتي:',
          '(1 التكلفة: 4.50 ريالات، 6.75 ريالات، 9.00 ريالات،',
          '(2 مواعيد انطلاق الحافلات: 10:15 صباحًا، 11:00 صباحًا، 11:45 صباحًا،',
          '(5 3, 3, 6, 9, 15,',
        ].join('\n'),
      ],
    ]);
    const [attempt] = insertAttemptQuizzes(solving, BOOK, {
      unitTexts,
      exerciseSlideQuestions: [{ '6247': [1, 2] }],
    });
    expect(attempt!.keyPoints).toEqual([
      '(1 التكلفة: 4.50 ريالات، 6.75 ريالات، 9.00 ريالات،',
      '(2 مواعيد انطلاق الحافلات: 10:15 صباحًا، 11:00 صباحًا، 11:45 صباحًا،',
    ]);
    expect(attempt!.keyPoints.join(' ')).not.toContain('11.25');
    expect(attempt!.quizConfig?.questionCount).toBe(2);
    // Without the book text: the slide title only, never its working.
    const [bare] = insertAttemptQuizzes(solving, BOOK);
    expect(bare!.keyPoints).toEqual(['exer1']);
  });

  it('is idempotent: a resumed outline that holds its attempts is returned as is', () => {
    const once = insertAttemptQuizzes(OUTLINES, BOOK);
    expect(insertAttemptQuizzes(once, BOOK)).toBe(once);
  });

  it('adds nothing without a book map or without check and exercise slides', () => {
    expect(insertAttemptQuizzes(OUTLINES, undefined)).toBe(OUTLINES);
    const plain = [slide('a', 'explanation', ['6230'])];
    expect(insertAttemptQuizzes(plain, BOOK)).toBe(plain);
  });

  it('quality plan W4: a check with bare «A) B) C)» under «3)» gets three tries (item 208 unit 6241)', () => {
    const unitTexts = new Map([
      [
        '6234',
        [
          '✓ تحقق من فهمك',
          '3) أسعار: يبين الجدول المجاور سعر',
          'منتج خلال السنوات من 1419هـ إلى 1444هـ.',
          'A) أنشئ التمثيل البياني الأنسب لعرض هذه البيانات.',
          'B) ضع تخمينًا لسعر المنتج عام 1449هـ.',
          'C) هل من المنطقي القول بأن هذا النمط سيستمر بمرور الزمن؟',
        ].join('\n'),
      ],
    ]);
    const check = [slide('try3', 'check_understanding', ['6234'], ['تمرين 1: أسعار'])];
    const [, attempt] = insertAttemptQuizzes(check, BOOK, {
      unitTexts,
      facts: { '6234': { itemLabels: ['3'] } as never },
    });
    expect(attempt!.quizConfig?.questionCount).toBe(3);
    expect(attempt!.keyPoints).toContain(
      'C) هل من المنطقي القول بأن هذا النمط سيستمر بمرور الزمن؟',
    );
    // A check whose labels the facts already split keeps its count.
    const [, labelled] = insertAttemptQuizzes(check, BOOK, {
      unitTexts,
      facts: { '6234': { itemLabels: ['3A', '3B'] } as never },
    });
    expect(labelled!.quizConfig?.questionCount).toBe(2);
    expect(labelled!.keyPoints).toEqual(['تمرين 1: أسعار']);
  });

  it('quality plan W4: «المثال 3 11)» is question 11 (item 208 unit 6249)', () => {
    const unitTexts = new Map([
      [
        '6247',
        [
          '8) خمّن العلاقة بين a و b إذا كان a + b = 0',
          'المثال 3 11) إنتاج مصنع: استعمل الجدول المجاور الذي يبين عدد القطع المنتجة.',
          'a) أنشئ التمثيل البياني الأنسب لعرض هذه البيانات.',
          '12) الزاويتان A و B متتامتان',
        ].join('\n'),
      ],
    ]);
    const solving = [slide('exer2', 'worked_example', ['6247'])];
    const [attempt] = insertAttemptQuizzes(solving, BOOK, {
      unitTexts,
      exerciseSlideQuestions: [{ '6247': [8, 11, 12] }],
    });
    expect(attempt!.keyPoints).toEqual([
      '8) خمّن العلاقة بين a و b إذا كان a + b = 0',
      'المثال 3 11) إنتاج مصنع: استعمل الجدول المجاور الذي يبين عدد القطع المنتجة.',
      '12) الزاويتان A و B متتامتان',
    ]);
    expect(attempt!.quizConfig?.questionCount).toBe(3);
  });

  it('caps an attempt at four questions and falls back to the slide key points', () => {
    const many = [slide('t', 'check_understanding', ['6234'], ['1', '2', '3', '4', '5', '6'])];
    const [, attempt] = insertAttemptQuizzes(many, BOOK);
    expect(attempt!.quizConfig?.questionCount).toBe(4);
  });
});
