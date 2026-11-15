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
import { withoutSacredItems } from '@/lib/server/teaching-package/sacred-text';
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
    // Review of f5df1233: each question carries the unit's shared task; «تأكد» is dropped.
    const task = 'المثال 1 اكتب تخمينًا يصف النمط في كل متتابعة مما يأتي:';
    expect(attempt!.keyPoints).toEqual([
      `${task} — (1 التكلفة: 4.50 ريالات، 6.75 ريالات، 9.00 ريالات،`,
      `${task} — (2 مواعيد انطلاق الحافلات: 10:15 صباحًا، 11:00 صباحًا، 11:45 صباحًا،`,
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
    // Review LOW-MED-8: a multiple-choice check's options are not items.
    const choices = new Map([['6234', '2) أي مما يلي عدد أولي؟\nA) 5 B) 8 C) 9 D) 12']]);
    const [, single] = insertAttemptQuizzes(check, BOOK, {
      unitTexts: choices,
      facts: { '6234': { itemLabels: ['2'] } as never },
    });
    expect(single!.quizConfig?.questionCount).toBe(1);
  });

  it('quality plan W4: «المثال 3 11)» is question 11 (item 208 unit 6249)', () => {
    const unitTexts = new Map([
      [
        '6247',
        [
          '8) خمّن العلاقة بين a و b إذا كان a + b = 0',
          'المثال 3 11) إنتاج مصنع: استعمل الجدول المجاور الذي يبين عدد القطع المنتجة.',
          'عدد القطع المنتجة لمصنع عدد القطع (بالملايين) السنة 5 2017 7.2 2018 9.2 2019',
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
    expect(attempt!.keyPoints).toHaveLength(3);
    expect(attempt!.keyPoints[0]).toBe('8) خمّن العلاقة بين a و b إذا كان a + b = 0');
    // Follow-up (item 208 Q11): Q11 carries its table row and its «a)» line.
    expect(attempt!.keyPoints[1]).toContain('المثال 3 11) إنتاج مصنع');
    expect(attempt!.keyPoints[1]).toContain('5 2017 7.2 2018');
    expect(attempt!.keyPoints[1]).toContain('a) أنشئ التمثيل البياني الأنسب');
    expect(attempt!.keyPoints[2]).toBe('12) الزاويتان A و B متتامتان');
    expect(attempt!.quizConfig?.questionCount).toBe(3);
  });

  it('quality plan follow-up: the exact unit 6249 Q11 text keeps its table and both parts (item 208)', () => {
    const unitTexts = new Map([
      [
        '6249',
        [
          'المثال 3 11) إنتاج مصنع: استعمل الجدول المجاور الذي يبين عدد القطع المنتجة في مصنع لبعض السنوات.',
          'عدد القطع المنتجة لمصنع عدد القطع (بالملايين) السنة 5 2017 7.2 2018 9.2 2019 14.1 2020 19.7 2021 28.4 2022',
          'a) أنشئ التمثيل البياني الأنسب لعرض هذه البيانات.',
          'b) ضع تخمينًا لعدد القطع في سنة 2027م.',
          '12) الزاويتان A و B متتامتان',
        ].join('\n'),
      ],
    ]);
    const book: Pick<KafuoBookStructure, 'units'> = {
      units: [{ ...BOOK.units[2]!, contentUnitId: '6249' }],
    };
    const solving = [slide('exer11', 'worked_example', ['6249'])];
    const [attempt] = insertAttemptQuizzes(solving, book, {
      unitTexts,
      exerciseSlideQuestions: [{ '6249': [11] }],
    });
    expect(attempt!.keyPoints).toHaveLength(1);
    expect(attempt!.keyPoints[0]).toContain('5 2017 7.2 2018 9.2 2019 14.1 2020');
    expect(attempt!.keyPoints[0]).toContain('ضع تخمينًا لعدد القطع في سنة 2027م');
    expect(attempt!.keyPoints[0]).not.toContain('الزاويتان');
    expect(attempt!.quizConfig?.questionCount).toBe(1);
  });

  describe('review of f5df1233: the exact dev-DB unit texts (item 208)', () => {
    // `select id, to_json(text) from content_units where id in (…)`, 15 Nov 2026.
    const DB_UNITS: Record<string, string> = {
      '6247':
        'تأكد\n\nالمثال 1 اكتب تخمينًا يصف النمط في كل متتابعة مما يأتي، ثم استعمله لإيجاد الحد التالي في كلّ منها:\n\n(1 التكلفة: 4.50 ريالات، 6.75 ريالات، 9.00 ريالات،\n\n(2 مواعيد انطلاق الحافلات: 10:15 صباحًا، 11:00 صباحًا، 11:45 صباحًا،\n\n(3\n\n(4\n\n(5 3, 3, 6, 9, 15,\n\n(6 2, 6, 14, 30, 62,',
      '6248':
        'المثال 2 ضع تخمينًا لكل قيمة أو علاقة هندسية مما يأتي:\n\n(7 ناتج ضرب عددين زوجيين.\n\n(8 العلاقة بين العددين a و b إذا كان a + b = 0.\n\n(9 العلاقة بين مجموعة النقاط في المستوى التي تبعد المسافة نفسها عن النقطة A.\n\n(10 العلاقة بين \\overline{AP} و \\overline{PB} إذا كانت M نقطة منتصف \\overline{AB} والنقطة P نقطة منتصف \\overline{AM}.',
      '6249':
        'المثال 3 11) إنتاج مصنع: استعمل الجدول المجاور الذي يبين عدد القطع المنتجة في مصنع لبعض السنوات.\n\nعدد القطع المنتجة لمصنع عدد القطع (بالملايين) السنة 5 2017 7.2 2018 9.2 2019 14.1 2020 19.7 2021 28.4 2022\n\na) أنشئ التمثيل البياني الأنسب لعرض هذه البيانات.\n\nb) ضع تخمينًا لعدد القطع في سنة 2027م.',
      '6250':
        'المثال 4 أعطِ مثالاً مضادًّا يبين أن كلًّا من التخمينات الآتية خاطئة.\n\n12) إذا كانت \\angle A و \\angle B متتامتين، فإن لهما ضلعًا مشتركًا.\n\n13) إذا قطع نصف مستقيم قطعةً مستقيمةً عند منتصفها، فإنه يعامدها.',
      '6253':
        'المثال 3\n\n(34 مدارس: يبين الجدول المجاور عدد الطلاب في إحدى المدارس الثانوية خلال الفترة من 1445 إلى 1448هـ.\n\n(a أنشئ التمثيل البياني الأنسب لعرض هذه البيانات.\n\n(b ضع تخمينًا معتمدًا على بيانات الجدول، واشرح كيف يؤيّد تمثيلك البياني هذا التخمين.\n\nالسنة عدد الطلاب 1445 190 1446 210 1447 240 1448 260\n\nحدد ما إذا كان أيٌّ من التخمينات الآتية صحيحًا أو خاطئًا، وإذا كان التخمين خاطئًا، فأعط مثالًا مضادًّا.',
      '6258':
        'مراجعة تراكمية\n\n(49) أحواض سمك: اشترى باسم حوض سمكٍ صغير على شكل أسطوانة دائرية قائمة، طول قطر قاعدتها 25 cm، وارتفاعها 35 cm، أوجد حجم الماء اللازم لملء الحوض. (مهارة سابقة)\n\nأوجد محيط \\triangle ABC إذا أُعطيت إحداثيات رؤوسه في كلّ مما يأتي: (مهارة سابقة)\n\n(51) A(-3, 2), B(2, -9), C(0, -10)\n\n(50) A(1, 6), B(1, 2), C(3, 2)\n\n(52) جبر: قياس زاويتين متتامتين يساوي (16z - 9)^\\circ و (4z + 3)^\\circ. أوجد قياس كلّ منهما. (مهارة سابقة)\n\n(53) جبر: إذا علمت أن: x = 3 و y = -4 و z = -5، فأوجد قيمة: 5|x + y| - 3|2 - z|. (مهارة سابقة)',
    };
    const unitTexts = new Map(Object.entries(DB_UNITS));
    const linesOf = (id: string) => DB_UNITS[id]!.split('\n\n');
    const book: Pick<KafuoBookStructure, 'units'> = {
      units: Object.keys(DB_UNITS).map((id) => ({ ...BOOK.units[2]!, contentUnitId: id })),
    };
    const tryOf = (units: string[], questions?: Record<string, number[]>) =>
      insertAttemptQuizzes([slide('exer', 'worked_example', units)], book, {
        unitTexts,
        ...(questions ? { exerciseSlideQuestions: [questions] } : {}),
      })[0]!;

    it('6247 + 6248: Q1, Q2, Q7 carry their own unit task; the bare «(3» «(4» stay out', () => {
      const [, task47, q1, q2] = linesOf('6247');
      const [task48, q7] = linesOf('6248');
      expect(task47).toBe(
        'المثال 1 اكتب تخمينًا يصف النمط في كل متتابعة مما يأتي، ثم استعمله لإيجاد الحد التالي في كلّ منها:',
      );
      const attempt = tryOf(['6247', '6248'], { '6247': [1, 2], '6248': [7] });
      expect(attempt.keyPoints).toEqual([
        `${task47} — ${q1}`,
        `${task47} — ${q2}`,
        `${task48} — ${q7}`,
      ]);
      expect(attempt.keyPoints[1]).not.toContain('(3');
      expect(attempt.quizConfig?.questionCount).toBe(3);
      // Every question of 6247: the figure-only 3 and 4 give no statement; «تأكد» is dropped.
      const all = tryOf(['6247']);
      expect(all.keyPoints.map((point) => point.split(' — ')[1])).toEqual(
        [2, 3, 6, 7].map((index) => linesOf('6247')[index]),
      );
      expect(all.keyPoints.join(' ')).not.toContain('تأكد');
    });

    it('6249: Q11 keeps its table and both parts', () => {
      const attempt = tryOf(['6249'], { '6249': [11] });
      expect(attempt.keyPoints).toEqual([linesOf('6249').join(' ')]);
      expect(attempt.keyPoints[0]).toContain('5 2017 7.2 2018 9.2 2019 14.1 2020');
    });

    it('6253: Q34 keeps its parts and table, never the Q35–41 task', () => {
      const [, q34, a, b, table] = linesOf('6253');
      const attempt = tryOf(['6253'], { '6253': [34] });
      expect(attempt.keyPoints).toEqual([[q34, a, b, table].join(' ')]);
      expect(attempt.keyPoints[0]).not.toContain('حدد ما إذا كان');
      expect(attempt.keyPoints[0]).not.toContain('المثال 3');
    });

    it('6250: both counterexample questions carry the unit task', () => {
      const [task, q12, q13] = linesOf('6250');
      expect(tryOf(['6250']).keyPoints).toEqual([`${task} — ${q12}`, `${task} — ${q13}`]);
    });

    it('6258: the perimeter stem is the task of Q51, Q50 only, never Q49, Q52 or Q53', () => {
      const [, q49, stem, q51, q50, q52, q53] = linesOf('6258');
      const attempt = tryOf(['6258']);
      expect(attempt.keyPoints).toEqual([q49, `${stem} — ${q51}`, `${stem} — ${q50}`, q52, q53]);
      expect(attempt.quizConfig?.questionCount).toBe(4);
    });
  });

  it('review of f5df1233: margin headers, a bare «(٤)», titles, and verse orphans', () => {
    const tryOf = (text: string, questions?: number[]) =>
      insertAttemptQuizzes([slide('exer', 'worked_example', ['6247'])], BOOK, {
        unitTexts: new Map([['6247', text]]),
        ...(questions ? { exerciseSlideQuestions: [{ '6247': questions }] } : {}),
      })[0]!.keyPoints;
    // «المثالان N، M» and «الأمثلة N–M» before a number, like «المثال N».
    expect(
      tryOf(['المثالان 1، 2 (3 أوجد الحد التالي', '(٤)', 'الأمثلة 4–6 7) أوجد المجموع'].join('\n')),
    ).toEqual(['المثالان 1، 2 (3 أوجد الحد التالي', 'الأمثلة 4–6 7) أوجد المجموع']);
    // A section title ends the shared task and joins nothing.
    expect(
      tryOf(['اكتب كل عدد مما يأتي:', '(1 خمسة', 'مهارات التفكير العليا', '(2 تبرير'].join('\n')),
    ).toEqual(['اكتب كل عدد مما يأتي: — (1 خمسة', '(2 تبرير']);
    // A verse question's numbered line is removed with its verse; its parts stay orphaned.
    const verse = '﴿قُلْ هُوَ اللَّهُ أَحَدٌ﴾';
    const gap = withoutSacredItems(
      [
        '(4 عيّن الفاعل في الجملة: كتب الطالبُ الدرسَ.',
        `(5 ${verse}`,
        '(a استخرج المبتدأ.',
        '(b استخرج الخبر.',
        '(6 عيّن المفعول به في الجملة: قرأ عليٌّ الكتابَ.',
      ].join('\n'),
    );
    expect(gap).not.toContain('(5');
    expect(tryOf(gap, [4])).toEqual(['(4 عيّن الفاعل في الجملة: كتب الطالبُ الدرسَ.']);
    const last = withoutSacredItems(
      [
        '(6 عيّن في الجملة: قرأ عليٌّ الكتابَ.',
        'a) الفعل.',
        'b) الفاعل.',
        `(7 ${verse}`,
        'a) استخرج المبتدأ.',
        'b) استخرج الخبر.',
      ].join('\n'),
    );
    expect(tryOf(last)).toEqual(['(6 عيّن في الجملة: قرأ عليٌّ الكتابَ. a) الفعل. b) الفاعل.']);
  });

  it('caps an attempt at four questions and falls back to the slide key points', () => {
    const many = [slide('t', 'check_understanding', ['6234'], ['1', '2', '3', '4', '5', '6'])];
    const [, attempt] = insertAttemptQuizzes(many, BOOK);
    expect(attempt!.quizConfig?.questionCount).toBe(4);
  });
});
