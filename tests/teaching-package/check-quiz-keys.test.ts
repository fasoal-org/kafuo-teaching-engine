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
): QuizQuestion =>
  ({
    id: `q-${reference ?? 'none'}-${labels.join('')}`,
    type,
    question: 'السؤال',
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
      ['R1', 'u2'],
      ['R2', 'u5'],
    ]);
    expect(references[0]!.question).toContain('احسب الضغط');
    // No guide (today on g5.v12: the Backend sends it for g5.v11 only): no reference.
    expect(checkQuizReferences(checkQuiz(['u2']), null)).toEqual([]);
    expect(checkQuizReferences(checkQuiz(['u7']), GUIDE)).toEqual([]);
  });
});

describe('verifyCheckQuizKeys', () => {
  const references = checkQuizReferences(checkQuiz(['u2', 'u5', 'u9']), GUIDE);

  it('keeps a question whose key states the approved answer, without its tag', () => {
    const result = verifyCheckQuizKeys(
      [
        question('R1', ['150 Pa', '300 Pa'], ['B']),
        question('R2', ['صحيحة', 'خاطئة'], ['A']),
        question('R3', ['الحجم', 'الكتلة'], ['B']),
      ],
      references,
    );
    expect(result.failed).toEqual([]);
    expect(result.verified).toHaveLength(3);
    for (const kept of result.verified) expect(kept).not.toHaveProperty('reference');
  });

  it('drops a wrong key (the fixture), an untagged question and an unknown tag', () => {
    const result = verifyCheckQuizKeys(
      [
        question('R1', ['150 Pa', '300 Pa'], ['A']), // keys 150: the wrong number
        question(undefined, ['x', 'y'], ['A']),
        question('R9', ['x', 'y'], ['A']),
        question('R2', ['صحيحة', 'خاطئة'], ['B']), // keys «false»
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
        question('R1', ['300 Pa', '300 Pa'], ['A', 'B']),
        question('R2', ['صحيحة', 'خاطئة'], ['A'], 'multiple'),
        question('R3', ['الحجم', 'الكتلة'], ['B']),
        question('R3', ['الكتلة', 'الحجم'], ['A']),
      ],
      references,
    );
    expect(result.verified).toHaveLength(1);
    expect(result.failed.map((entry) => entry.reason)).toEqual([
      'not exactly one correct option',
      'a multiple question cannot be checked',
      'a second question on the same book item',
    ]);
  });

  it('the directive and the correction name each item and its approved answer, never an id', () => {
    const directive = referenceDirective(references);
    expect(directive).toContain('R1');
    expect(directive).toContain('300 Pa');
    expect(directive).not.toContain('u2');
    const correction = keyCorrection(
      [{ index: 0, tag: 'R1', reason: 'its key is not the approved answer' }],
      references,
    );
    expect(correction).toContain('question 1: its key is not the approved answer');
    expect(correction).toContain('300 Pa');
  });
});
