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
      '6234': { itemLabels: ['1A', '1B', '1C'], hiddenSteps: [] },
      '6247': { itemLabels: [], hiddenSteps: [], questionNumbers: [1, 2] },
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

  it('is idempotent: a resumed outline that holds its attempts is returned as is', () => {
    const once = insertAttemptQuizzes(OUTLINES, BOOK);
    expect(insertAttemptQuizzes(once, BOOK)).toBe(once);
  });

  it('adds nothing without a book map or without check and exercise slides', () => {
    expect(insertAttemptQuizzes(OUTLINES, undefined)).toBe(OUTLINES);
    const plain = [slide('a', 'explanation', ['6230'])];
    expect(insertAttemptQuizzes(plain, BOOK)).toBe(plain);
  });

  it('caps an attempt at four questions and falls back to the slide key points', () => {
    const many = [slide('t', 'check_understanding', ['6234'], ['1', '2', '3', '4', '5', '6'])];
    const [, attempt] = insertAttemptQuizzes(many, BOOK);
    expect(attempt!.quizConfig?.questionCount).toBe(4);
  });
});
