/**
 * g5.v12 (critical items 27 Nov 2026, QZ-2, decision Q-AK): a check quiz's keys are
 * checked by code against the approved answers of the book items it cites; what is not
 * verified is dropped, and nothing unverified is ever kept.
 */
import { describe, expect, it } from 'vitest';

import {
  checkQuizReferences,
  isBankedCheckQuiz,
  keyCorrection,
  referenceDirective,
  verifyCheckQuizKeys,
} from '@/lib/server/teaching-package/check-quiz-keys';
import type { KeyedGuideItem } from '@/lib/server/teaching-package/guide-answers';
import type { SceneOutline } from '@/lib/types/generation';
import type { QuizQuestion } from '@/lib/types/stage';

const item = (
  contentUnitId: string,
  label: string,
  answer: KeyedGuideItem['answer'],
): KeyedGuideItem => ({
  contentUnitId,
  label,
  element: 'try_it',
  number: 1,
  letter: null,
  display: label,
  answer,
});

const GUIDE = {
  keyed: [
    item('u2', '1', { type: 'number', value: 300, unit: 'Pa' }),
    item('u5', '1', { type: 'bool', value: true }),
    item('u9', '1', { type: 'text', value: 'الكتلة' }),
  ],
};

// The tags the references carry, in book order.
const T1 = 'ITEM_1';
const T2 = 'ITEM_2';
const T3 = 'ITEM_3';

const checkQuiz = (units: string[], extra: Partial<SceneOutline> = {}): SceneOutline =>
  ({
    id: 'q1',
    type: 'quiz',
    title: 'q1',
    description: '',
    keyPoints: [],
    order: 1,
    teachingStage: { key: 'outcome_check_understanding', flowIndex: 2 },
    sourceContentUnitIds: units,
    ...extra,
  }) as SceneOutline;

const question = (
  reference: string | undefined,
  labels: string[],
  answer: string[],
  type: QuizQuestion['type'] = 'single',
  stem = 'السؤال',
): QuizQuestion =>
  ({
    id: `q-${reference ?? 'none'}-${labels.join('')}`,
    type,
    question: stem,
    options: labels.map((label, index) => ({ label, value: String.fromCharCode(65 + index) })),
    answer,
    ...(reference ? { reference } : {}),
  }) as unknown as QuizQuestion;

describe('which quizzes are gated', () => {
  it('the check quiz the bank imports, never an attempt or a teaching quiz', () => {
    expect(isBankedCheckQuiz(checkQuiz(['u2']))).toBe(true);
    expect(isBankedCheckQuiz(checkQuiz(['u2'], { id: 'try1-attempt' }))).toBe(false);
    expect(
      isBankedCheckQuiz(
        checkQuiz(['u2'], { teachingStage: { key: 'outcome_visual_explanations', flowIndex: 1 } }),
      ),
    ).toBe(false);
    expect(isBankedCheckQuiz({ ...checkQuiz(['u2']), type: 'slide' })).toBe(false);
  });

  it('references are the keyed guide items the quiz cites, tagged in book order', () => {
    const references = checkQuizReferences(
      checkQuiz(['u5', 'u2']),
      GUIDE,
      new Map([['u2', 'ماذا قرأت؟\n(١) احسب الضغط']]),
    );
    expect(references.map((reference) => [reference.tag, reference.item.contentUnitId])).toEqual([
      [T1, 'u2'],
      [T2, 'u5'],
    ]);
    expect(references[0]!.question).toContain('احسب الضغط');
    // No guide (today on g5.v12: the Backend sends it for g5.v11 only): no reference.
    expect(checkQuizReferences(checkQuiz(['u2']), null)).toEqual([]);
    expect(checkQuizReferences(checkQuiz(['u7']), GUIDE)).toEqual([]);
  });
});

describe('verifyCheckQuizKeys', () => {
  const STATEMENT = 'كتلة الجسم ثابتة عند نقله من مكان إلى آخر';
  const references = checkQuizReferences(
    checkQuiz(['u2', 'u5', 'u9']),
    GUIDE,
    new Map([['u5', `(١) ${STATEMENT}`]]),
  );
  const statement = (labels: string[], key: string, stem = `صح أم خطأ: ${STATEMENT}`) =>
    question(T2, labels, [key], 'single', stem);

  it('keeps a question whose key states the approved answer, without its tag', () => {
    const result = verifyCheckQuizKeys(
      [
        question(T1, ['150 Pa', '300 Pa'], ['B']),
        statement(['صحيحة', 'خاطئة'], 'A'),
        question(T3, ['الحجم', 'الكتلة'], ['B']),
      ],
      references,
    );
    expect(result.failed).toEqual([]);
    expect(result.verified).toHaveLength(3);
    for (const kept of result.verified) expect(kept).not.toHaveProperty('reference');
  });

  it('a physics stem naming resistors R1 and R2 is not mistaken for an internal tag', () => {
    const result = verifyCheckQuizKeys(
      [question(T1, ['150 Pa', '300 Pa'], ['B'], 'single', 'المقاومتان R1 و R2 على التوالي')],
      references,
    );
    expect(result.failed).toEqual([]);
  });

  it('drops a wrong key (the fixture), an untagged question and an unknown tag', () => {
    const result = verifyCheckQuizKeys(
      [
        question(T1, ['150 Pa', '300 Pa'], ['A']), // keys 150: the wrong number
        question(undefined, ['x', 'y'], ['A']),
        question('ITEM_9', ['x', 'y'], ['A']),
        statement(['صحيحة', 'خاطئة'], 'B'), // keys «false»
      ],
      references,
    );
    expect(result.verified).toEqual([]);
    expect(result.failed.map((entry) => entry.reason)).toEqual([
      'its key is not the approved answer',
      'names no book item',
      'names an unknown book item',
      'its key is not the approved answer',
    ]);
  });

  it('drops what code cannot check: two keys, a multiple question, a second question on one item', () => {
    const result = verifyCheckQuizKeys(
      [
        question(T1, ['300 Pa', '300 Pa'], ['A', 'B']),
        question(T1, ['300 Pa', '300'], ['A']),
        question(T2, ['صحيحة', 'خاطئة'], ['A'], 'multiple', `صح أم خطأ: ${STATEMENT}`),
        question(T3, ['الحجم', 'الكتلة'], ['B']),
        question(T3, ['الكتلة', 'الحجم'], ['A']),
      ],
      references,
    );
    expect(result.verified).toHaveLength(1);
    expect(result.failed.map((entry) => entry.reason)).toEqual([
      'not exactly one correct option',
      'another option also states the approved answer',
      'a multiple question cannot be checked',
      'a second question on the same book item',
    ]);
  });

  it('Wave 3 review H1/M1/L5: a right-looking key on wrong content is never verified', () => {
    const result = verifyCheckQuizKeys(
      [
        // A negated statement keyed «true»: the key is wrong for the stem as written.
        statement(['صحيحة', 'خاطئة'], 'A', `صح أم خطأ: كتلة الجسم ليست ثابتة عند نقله`),
        // A statement that is not the book's own.
        statement(['صحيحة', 'خاطئة'], 'A', 'صح أم خطأ: الوزن ثابت في كل مكان'),
        // «ليس الكتلة» contains «الكتلة» but says the opposite.
        question(T3, ['الحجم', 'ليس الكتلة'], ['B']),
        // A number key with a negation.
        question(T1, ['150 Pa', 'ليس 300 Pa'], ['B']),
        // The internal tag echoed to a learner.
        { ...question(T1, ['150 Pa', '300 Pa'], ['B']), question: `${T1}: احسب الضغط` },
        // Two options sharing one value.
        {
          ...question(T1, ['150 Pa', '300 Pa'], ['B']),
          options: [
            { label: '150 Pa', value: 'B' },
            { label: '300 Pa', value: 'B' },
          ],
        } as unknown as QuizQuestion,
      ],
      references,
    );
    expect(result.verified).toEqual([]);
    expect(result.failed.map((entry) => entry.reason)).toEqual([
      'its statement is not the book’s own',
      'its statement is not the book’s own',
      'its key is not the approved answer',
      'its key is not the approved answer',
      'it shows an internal item tag',
      'two options share one value',
    ]);
  });

  it('re-review N1/N2: a one-item check’s statement and a respaced equation key verify', () => {
    const guide = {
      keyed: [
        item('u6', '1', { type: 'bool', value: false }),
        item('u7', '1', { type: 'text', value: 'y = 2x + 3' }),
      ],
    };
    // A one-item check read whole: box title, instruction, then the statement.
    const refs = checkQuizReferences(
      checkQuiz(['u6', 'u7']),
      { keyed: guide.keyed.map((entry) => ({ ...entry, number: null })) },
      new Map([['u6', 'ماذا قرأت؟\nحدّد صحة العبارة:\nالماء يغلي عند 50 درجة']]),
    );
    const result = verifyCheckQuizKeys(
      [
        question(T1, ['صحيحة', 'خاطئة'], ['B'], 'single', 'صح أم خطأ: الماء يغلي عند 50 درجة'),
        question(T2, ['y=2x+3', 'y=3x+2'], ['A']),
      ],
      refs,
    );
    expect(result.failed).toEqual([]);
    expect(result.verified).toHaveLength(2);
  });

  it('a book choice answer is never a reference: its letter names the book’s own options', () => {
    const guide = { keyed: [item('u3', '2', { type: 'choice', value: 'ب' })] };
    expect(checkQuizReferences(checkQuiz(['u3']), guide)).toEqual([]);
  });

  it('the directive and the correction name each item and its approved answer, never an id', () => {
    const directive = referenceDirective(references);
    expect(directive).toContain(T1);
    expect(directive).toContain('300 Pa');
    expect(directive).not.toContain('u2');
    const correction = keyCorrection(
      [{ index: 0, tag: T1, reason: 'its key is not the approved answer' }],
      references,
    );
    expect(correction).toContain('question 1: its key is not the approved answer');
    expect(correction).toContain('300 Pa');
  });
});
