/**
 * Owner decision (17 Nov 2026): a proof or «إجابة ممكنة» guide item the lesson solves gets
 * a WRITTEN attempt question before its solution slide — engine-written from the book's
 * own text, never the guide's — whose id maps back to the item from the PINNED guide.
 */
import { describe, expect, it } from 'vitest';

import { insertAttemptQuizzes } from '@/lib/server/teaching-package/attempt-quizzes';
import { createGuideAnswerGuard } from '@/lib/server/teaching-package/guide-answer-guard';
import {
  guideItemOwnText,
  guideItemQuestionText,
  guideOutlinePlans,
  resolveTeacherGuide,
  type GuideOutlinePlan,
  type KeyedGuideItem,
} from '@/lib/server/teaching-package/guide-answers';
import {
  guideGradingContext,
  guideWrittenAnswers,
  guideWrittenAttempts,
  guideWrittenQuestionId,
  isGuideWrittenQuestionId,
  MAX_GRADING_CONTEXT_CHARS,
  withGuideWrittenQuestions,
  type GuideWrittenAttempt,
} from '@/lib/server/teaching-package/guide-written-attempts';
import {
  normalizeBookText,
  type BookUnitFacts,
} from '@/lib/server/teaching-package/hidden-step-types';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
  KafuoTeacherGuide,
  KafuoTeacherGuideItem,
} from '@/lib/types/teaching-package';

const BOOK: KafuoBookStructure = {
  templateVersionId: '3',
  rules: [],
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
      pairedExampleUnitId: '6230',
    },
    {
      contentUnitId: '6249',
      kind: 'PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: '6230',
    },
  ],
  exercisePolicy: { maxExercises: 3, maxExerciseSlides: 2, minExercises: 2, minExerciseSlides: 1 },
};

const FACTS: Record<string, BookUnitFacts> = {
  '6234': { itemLabels: ['1A', '1B'], hiddenSteps: [] },
  '6249': { itemLabels: [], hiddenSteps: [], questionNumbers: [11, 12, 13, 14] },
};

// The book prints diacritics, «ة» and «ى»: the learner reads them as printed.
const CHECK_1B = 'أثبِتْ أنّ المتتابعةَ حسابيةٌ، وأنّ الفرقَ ثابتٌ حتى آخر حدّ.';
const EXERCISE_12 = 'اكتب تخمينًا يصف العلاقة بين عدد الأضلاع ومجموع الزوايا في المضلّع.';
const UNIT_TEXTS = new Map([
  ['6234', `✓ تحقق من فهمك\n1A) أوجد الحدَّ التالي في المتتابعة 3، 6، 9.\n1B) ${CHECK_1B}`],
  [
    '6249',
    [
      'تدرّب وحلّ المسائل',
      '11) إنتاج مصنعٍ: 120، 140، 160. ما الإنتاج المتوقَّع؟',
      `12) ${EXERCISE_12}`,
      '13) أوجد الحد العاشر.',
      '14) أثبت أن المجموع زوجي.',
    ].join('\n'),
  ],
]);

const PROOF = 'البرهان النموذجي: الفرق بين كل حدين متتاليين يساوي 3.';
const POSSIBLE = 'إجابة ممكنة: مجموع الزوايا = (ن − 2) × 180.';

const reference = (
  contentUnitId: string,
  label: string,
  modelAnswer: KafuoTeacherGuideItem['modelAnswer'],
): KafuoTeacherGuideItem => ({ contentUnitId, label, status: 'reference', modelAnswer });

const GUIDE: KafuoTeacherGuide = {
  guideId: 'tg-17',
  items: [
    {
      contentUnitId: '6234',
      label: '1A',
      status: 'approved',
      answer: { type: 'number', value: 12 },
    },
    reference('6234', '1B', { kind: 'proof', text: PROOF }),
    reference('6249', '12', { kind: 'possible', text: POSSIBLE }),
    // Not on the exercise slide: no solution, no written attempt.
    reference('6249', '14', { kind: 'proof', text: 'برهان لا يُدرَّس هنا.' }),
  ],
};

function outlines(): SceneOutline[] {
  const slide = (id: string, role: string, units: string[], keyPoints: string[]): SceneOutline =>
    ({
      id,
      type: 'slide',
      title: id,
      description: `plan of ${id}`,
      keyPoints,
      order: 0,
      slideType: 'content',
      contentRole: role,
      sourceContentUnitIds: units,
    }) as SceneOutline;
  return [
    slide('try-1', 'check_understanding', ['6234'], ['1A) أوجد الحد التالي', '1B) أثبت']),
    slide('sol-1', 'worked_example', ['6234'], ['نحسب الفرق بين الحدود']),
    slide('ex-1', 'worked_example', ['6249'], ['نحل السؤالين 11 و 12']),
  ].map((outline, index) => ({ ...outline, order: index + 1 }));
}

const slideQuestions = [{ '6249': [11, 12] }];
const resolved = resolveTeacherGuide(GUIDE, BOOK, FACTS);
const lesson = insertAttemptQuizzes(outlines(), BOOK, {
  facts: FACTS,
  exerciseSlideQuestions: slideQuestions,
});
const plans = guideOutlinePlans(lesson, BOOK, resolved, { slideQuestions, facts: FACTS });
const written = guideWrittenAttempts(lesson, plans, { guideId: 'tg-17', unitTexts: UNIT_TEXTS });

describe('the written attempt (owner, 17 Nov 2026)', () => {
  it('puts each solved proof or open item on the attempt the learner meets before its solution', () => {
    expect(lesson.map((outline) => outline.id)).toEqual([
      'try-1',
      'try-1-attempt',
      'sol-1',
      'ex-1-attempt',
      'ex-1',
    ]);
    expect([...written.keys()]).toEqual(['try-1-attempt', 'ex-1-attempt']);
    expect(written.get('try-1-attempt')!.solutionIds).toEqual(['sol-1']);
    expect(written.get('ex-1-attempt')!.solutionIds).toEqual(['ex-1']);
    expect(
      [...written.values()].flatMap((attempt) => attempt.questions.map((entry) => entry.ref)),
    ).toEqual([
      { contentUnitId: '6234', label: '1B' },
      { contentUnitId: '6249', label: '12' },
    ]);
  });

  it('asks OUR book question as printed, never the guide text, with no key', () => {
    const [check] = written.get('try-1-attempt')!.questions;
    const [exercise] = written.get('ex-1-attempt')!.questions;
    expect(check!.question).toEqual({
      id: guideWrittenQuestionId('tg-17', { contentUnitId: '6234', label: '1B' }),
      type: 'short_answer',
      question: `اكتب البرهان بنفسك خطوةً بخطوة، مع سبب كل خطوة:\n${CHECK_1B}`,
      hasAnswer: false,
      points: 2,
    });
    expect(exercise!.question.question).toBe(`اكتب إجابتك بنفسك، بكلماتك:\n${EXERCISE_12}`);
    expect(exercise!.questionKey).toBe('6249|12');
    const delivered = JSON.stringify([...written.values()]);
    for (const secret of [PROOF, POSSIBLE, 'البرهان النموذجي', 'إجابة ممكنة']) {
      expect(delivered).not.toContain(secret);
    }
    for (const entry of [check!, exercise!]) {
      expect(entry.question).not.toHaveProperty('answer');
      expect(entry.question).not.toHaveProperty('analysis');
      expect(entry.question).not.toHaveProperty('commentPrompt');
    }
  });

  it('cuts a check item from the RAW text at the span the leak guard reads', () => {
    const item = { element: 'try_it' as const, number: 1, letter: 'B' };
    const own = guideItemOwnText(UNIT_TEXTS.get('6234')!, item)!;
    expect(own).toBe(CHECK_1B);
    expect(normalizeBookText(own, false)).toBe(
      guideItemQuestionText(UNIT_TEXTS.get('6234')!, item),
    );
    expect(guideItemOwnText(UNIT_TEXTS.get('6234')!, { ...item, number: 7 })).toBeNull();
    expect(guideItemOwnText('   ', { element: 'try_it', number: null, letter: null })).toBeNull();
  });

  it('adds nothing for an item with no solution, no attempt before it, or no book text', () => {
    const noAttempt = lesson.filter((outline) => outline.id !== 'try-1-attempt');
    expect([
      ...guideWrittenAttempts(noAttempt, plans, { guideId: 'tg-17', unitTexts: UNIT_TEXTS }).keys(),
    ]).toEqual(['ex-1-attempt']);
    expect(
      guideWrittenAttempts(lesson, plans, { guideId: 'tg-17', unitTexts: new Map() }).size,
    ).toBe(0);
    // A figure model answer is never a written attempt.
    const figure = new Map(
      [...plans].map(([id, plan]): [string, GuideOutlinePlan] => [
        id,
        plan.modelAnswers
          ? {
              ...plan,
              modelAnswers: plan.modelAnswers.map((item) => ({
                ...item,
                modelAnswer: {
                  kind: 'figure' as const,
                  image: { checksumSha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 1 },
                },
              })),
            }
          : plan,
      ]),
    );
    expect(
      guideWrittenAttempts(lesson, figure, { guideId: 'tg-17', unitTexts: UNIT_TEXTS }).size,
    ).toBe(0);
  });

  it('appends after the quiz’s own questions, idempotently, under the same ids', () => {
    const questions = written.get('ex-1-attempt')!.questions.map((entry) => entry.question);
    const content = { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: 'ما؟' }] };
    const once = withGuideWrittenQuestions(content, questions);
    expect(once.questions.map((question) => question.id)).toEqual(['q1', questions[0]!.id]);
    expect(withGuideWrittenQuestions(once, questions)).toEqual(once);
    expect(withGuideWrittenQuestions(once, []).questions.map((q) => q.id)).toEqual(['q1']);
    expect(withGuideWrittenQuestions(content, [])).toBe(content);
    expect(content.questions).toHaveLength(1);
    expect(isGuideWrittenQuestionId(questions[0]!.id)).toBe(true);
    expect(isGuideWrittenQuestionId('q_guide_123')).toBe(false);
    // Stable for one guide, another guide's id differs.
    expect(guideWrittenQuestionId('tg-17', { contentUnitId: '6249', label: '12' })).toBe(
      questions[0]!.id,
    );
    expect(guideWrittenQuestionId('tg-18', { contentUnitId: '6249', label: '12' })).not.toBe(
      questions[0]!.id,
    );
  });
});

describe('the pinned guide behind a written question (grading)', () => {
  const answers = guideWrittenAnswers(GUIDE);

  it('maps each written id to its guideRef and model answer; never a key or a figure', () => {
    const id = guideWrittenQuestionId('tg-17', { contentUnitId: '6249', label: '12' });
    expect(answers.get(id)).toEqual({
      ref: { contentUnitId: '6249', label: '12' },
      kind: 'possible',
      modelAnswer: POSSIBLE,
    });
    const figure = guideWrittenAnswers({
      guideId: 'tg-17',
      items: [
        reference('6249', '13', {
          kind: 'figure',
          image: { checksumSha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 1 },
          text: 'رسمة',
        }),
        {
          contentUnitId: '6249',
          label: '11',
          status: 'approved',
          answer: { type: 'number', value: 1 },
        },
      ],
    });
    expect(figure.size).toBe(0);
    expect(guideWrittenAnswers(undefined).size).toBe(0);
  });

  it('gives a context only when both texts are non-blank and within the bound', () => {
    const answer = [...answers.values()][0]!;
    expect(guideGradingContext('السؤال', answer)).toEqual({
      questionText: 'السؤال',
      modelAnswer: answer.modelAnswer,
      kind: answer.kind,
    });
    expect(guideGradingContext('  ', answer)).toBeNull();
    expect(guideGradingContext('x'.repeat(MAX_GRADING_CONTEXT_CHARS + 1), answer)).toBeNull();
    expect(guideGradingContext('السؤال', { ...answer, modelAnswer: ' ' })).toBeNull();
    expect(guideGradingContext(undefined, answer)).toBeNull();
  });
});

describe('the guard keeps a written attempt', () => {
  const EX11: KeyedGuideItem = {
    contentUnitId: '6249',
    label: '11',
    element: 'exercise',
    number: 11,
    letter: null,
    display: 'س11',
    answer: { type: 'number', value: 180 },
  };
  const guardWith = (attempts: ReadonlyMap<string, GuideWrittenAttempt>) => {
    const guard = createGuideAnswerGuard({ unitTexts: UNIT_TEXTS });
    guard.usePlans(
      new Map<string, GuideOutlinePlan>([
        ['ex-1', { role: 'solution', items: [EX11], solves: 2 }],
        [
          'ex-1-attempt',
          { role: 'attempt', items: [EX11], questionOf: { '6249|11': 0 }, questionCount: 1 },
        ],
      ]),
    );
    // Exercise 11 left the lesson: its attempt question goes.
    guard.restore([{ outlineId: 'ex-1', items: [{ ...EX11, outcome: 'removed' }] }]);
    guard.useWrittenAttempts(attempts);
    return guard;
  };
  const attempt = { id: 'ex-1-attempt', type: 'quiz' } as SceneOutline;
  const content = { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: 'س11؟' }] };

  it('never drops an attempt left with only its written questions', () => {
    expect(guardWith(new Map()).pruneAttempt(attempt, content)).toEqual({ drop: true });
    const guard = guardWith(written);
    expect(guard.pruneAttempt(attempt, content)).toEqual({
      content: { ...content, questions: [] },
    });
    expect(guard.writtenQuestionsOf('ex-1-attempt').map((question) => question.id)).toEqual([
      guideWrittenQuestionId('tg-17', { contentUnitId: '6249', label: '12' }),
    ]);
    expect(guard.writtenQuestionsOf('sol-1')).toEqual([]);
    expect(guard.solutionsOf('try-1-attempt')).toEqual(['sol-1']);
    expect(guard.solutionsOf('ex-1-attempt')).toEqual(['ex-1']);
  });

  it('leaves out the written question of an exercise that left the lesson', () => {
    const [entry] = written.get('ex-1-attempt')!.questions;
    const gone = new Map([
      [
        'ex-1-attempt',
        { solutionIds: ['ex-1'], questions: [{ ...entry!, questionKey: '6249|11' }] },
      ],
    ]);
    const guard = guardWith(gone);
    expect(guard.writtenQuestionsOf('ex-1-attempt')).toEqual([]);
    expect(guard.pruneAttempt(attempt, content)).toEqual({ drop: true });
  });
});
