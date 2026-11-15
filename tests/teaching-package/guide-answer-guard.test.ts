/**
 * g5.v11 (teacher-guide answer referee plan §8.3–8.5), wave 4: the comparator of the
 * solution slides' final lines and the attempts' keyed options, and the leak guard of
 * the try-it slides, their narration and the attempt stems.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  canvasLines,
  createGuideAnswerGuard,
  type GuideAnswerSettlement,
} from '@/lib/server/teaching-package/guide-answer-guard';
import type { GuideOutlinePlan, KeyedGuideItem } from '@/lib/server/teaching-package/guide-answers';
import type { SceneOutline } from '@/lib/types/generation';

const ITEM: KeyedGuideItem = {
  contentUnitId: '6234',
  label: '1A',
  element: 'try_it',
  number: 1,
  letter: 'A',
  display: '1A',
  answer: { type: 'number', value: 12 },
};
const CHOICE: KeyedGuideItem = {
  ...ITEM,
  label: '1B',
  letter: 'B',
  display: '1B',
  answer: { type: 'choice', value: 'ج' },
};

const outline = (id: string, type: 'slide' | 'quiz' = 'slide') =>
  ({ id, type, title: id, description: '', keyPoints: [], order: 1 }) as SceneOutline;

const slide = (...lines: string[]) => ({
  elements: lines.map((line, index) => ({
    id: `t${index}`,
    type: 'text',
    content: `<p>${line}</p>`,
  })),
});

const quiz = (...questions: Array<{ question: string; options: string[]; answer: string }>) => ({
  questions: questions.map((question) => ({
    question: question.question,
    options: question.options.map((label, index) => ({
      value: String.fromCharCode(65 + index),
      label,
    })),
    answer: [question.answer],
  })),
});

function guard(plans: Record<string, GuideOutlinePlan>) {
  const settled: GuideAnswerSettlement[] = [];
  const instance = createGuideAnswerGuard({
    unitTexts: new Map([['6234', '1A) الأعداد 3، 6، 9 … ما الحد التالي؟ 1B) اختر']]),
    onSettled: (settlement) => settled.push(settlement),
  });
  instance.usePlans(new Map(Object.entries(plans)));
  return { instance, settled };
}

const SOLUTION: GuideOutlinePlan = {
  role: 'solution',
  items: [ITEM],
  group: ['try', 'try-attempt', 'sol'],
};
const ATTEMPT: GuideOutlinePlan = { role: 'attempt', items: [ITEM], group: ['try-attempt'] };
const TRY: GuideOutlinePlan = { role: 'try', items: [ITEM], group: ['try', 'try-attempt', 'sol'] };

describe('the solution comparator', () => {
  const { instance } = guard({ sol: SOLUTION });
  const check = (...lines: string[]) =>
    instance.checkContent(outline('sol'), slide(...lines)).map((finding) => finding.code);

  it('reads the final line, in any digit style', () => {
    expect(check('نضيف 3 كل مرة', 'الإجابة (1A): 12')).toEqual([]);
    expect(check('الإجابة (١A): ١٢')).toEqual([]);
    expect(check('الإجابة: 12')).toEqual([]);
  });

  it('reports a wrong final answer and a missing final line', () => {
    expect(check('الإجابة (1A): 13')).toEqual(['GUIDE_ANSWER_MISMATCH']);
    expect(check('نضيف 3 فيكون الحد التالي 12')).toEqual(['GUIDE_ANSWER_MISSING']);
  });

  it('never reads an unkeyed item’s unlabelled line as the keyed one', () => {
    // 1A keyed, 1B doubtful: both items end unlabelled, so neither line can be told apart.
    expect(check('الإجابة: 12', 'الإجابة: 7')).toEqual(['GUIDE_ANSWER_MISSING']);
    expect(check('الإجابة (1A): 12', 'الإجابة (1B): 7')).toEqual([]);
  });

  it('never reads back its own injected key point', () => {
    expect(check('الإجابة الصحيحة المعتمدة (1A): 12')).toEqual(['GUIDE_ANSWER_MISSING']);
  });

  it('cleans the injected wording off a kept canvas', () => {
    const cleaned = instance.cleanWording(
      outline('sol'),
      slide('الإجابة الصحيحة المعتمدة (1A): 12'),
    );
    expect(canvasLines(cleaned)).toEqual(['الإجابة الصحيحة (1A): 12']);
  });

  it('names only the correct final answer and the final line in its correction', () => {
    const findings = instance.checkContent(outline('sol'), slide('الإجابة (1A): 13'));
    const note = instance.correction(outline('sol'), findings);
    expect(note).toContain('the correct final answer is 12');
    expect(note).toContain('«الإجابة (1A): 12»');
    expect(note).not.toMatch(/average|method:/i);
  });
});

describe('the attempt comparator and stem guard', () => {
  const { instance, settled } = guard({ 'try-attempt': ATTEMPT });
  const attempt = outline('try-attempt', 'quiz');

  it('accepts the approved answer keyed among the options', () => {
    const content = quiz({ question: 'ما الحد التالي؟', options: ['11', '12', '15'], answer: 'B' });
    expect(instance.checkContent(attempt, content)).toEqual([]);
  });

  it('reports another option keyed, naming the question', () => {
    const content = quiz(
      { question: 'سؤال آخر', options: ['1', '2'], answer: 'A' },
      { question: 'ما الحد التالي؟', options: ['11', '12', '15'], answer: 'C' },
    );
    const findings = instance.checkContent(attempt, content);
    expect(findings).toMatchObject([{ code: 'GUIDE_ANSWER_MISMATCH', questions: [1] }]);
    // Still wrong after the one regeneration: that question leaves, the other stays.
    const result = instance.settle(attempt, content, findings);
    expect(
      'content' in result && (result.content as { questions: unknown[] }).questions,
    ).toHaveLength(1);
    expect(settled.at(-1)).toMatchObject({ action: 'questions_removed', removedQuestions: [1] });
  });

  it('drops the attempt when the answer is not an option at all', () => {
    const content = quiz({ question: 'ما الحد التالي؟', options: ['11', '13'], answer: 'A' });
    const findings = instance.checkContent(attempt, content);
    expect(findings).toMatchObject([{ questions: null }]);
    expect(instance.settle(attempt, content, findings)).toEqual({ drop: ['try-attempt'] });
  });

  it('reports a stem that states the answer', () => {
    const content = quiz({
      question: 'الحد التالي هو 12، صح؟',
      options: ['12', '15'],
      answer: 'A',
    });
    expect(instance.checkContent(attempt, content)).toMatchObject([
      { code: 'GUIDE_ANSWER_LEAK', where: 'stem', questions: [0] },
    ]);
  });

  it('compares a choice item by the keyed letter', () => {
    const { instance: choices } = guard({
      'try-attempt': { role: 'attempt', items: [CHOICE], group: ['try-attempt'] },
    });
    const right = quiz({ question: 'اختر', options: ['a', 'b', 'c', 'd'], answer: 'C' });
    const wrong = quiz({ question: 'اختر', options: ['a', 'b', 'c', 'd'], answer: 'D' });
    expect(choices.checkContent(attempt, right)).toEqual([]);
    expect(choices.checkContent(attempt, wrong)).toMatchObject([{ questions: null }]);
  });
});

describe('the try-it leak guard', () => {
  const { instance } = guard({ try: TRY });
  const tryIt = outline('try');

  it('lets the givens through and flags the answer', () => {
    expect(instance.checkContent(tryIt, slide('الأعداد 3، 6، 9 … ما الحد التالي؟'))).toEqual([]);
    expect(instance.checkContent(tryIt, slide('الحد التالي 12'))).toMatchObject([
      { code: 'GUIDE_ANSWER_LEAK', where: 'canvas' },
    ]);
  });

  it('checks the narration of a try-it slide, never of a solution slide', () => {
    const speech = [{ type: 'speech', text: 'الجواب هو 12' }];
    expect(instance.checkNarration(tryIt, speech)).toMatchObject([{ where: 'narration' }]);
    const { instance: solution } = guard({ sol: SOLUTION });
    expect(solution.checkNarration(outline('sol'), speech)).toEqual([]);
  });

  it('drops the whole check group when a try-it slide still leaks', () => {
    const findings = instance.checkContent(tryIt, slide('الحد التالي 12'));
    expect(instance.settle(tryIt, null, findings)).toEqual({ drop: ['try', 'try-attempt', 'sol'] });
  });

  it('checks nothing on an outline without a plan', () => {
    expect(instance.checkContent(outline('other'), slide('12'))).toEqual([]);
    expect(instance.planOf('other')).toBeUndefined();
  });
});

describe('settling a solution slide', () => {
  it('drops the slide with its group and reports it', () => {
    const onSettled = vi.fn();
    const instance = createGuideAnswerGuard({ unitTexts: new Map(), onSettled });
    instance.usePlans(new Map([['sol', SOLUTION]]));
    const findings = instance.checkContent(outline('sol'), slide('الإجابة (1A): 13'));
    expect(instance.settle(outline('sol'), slide('x'), findings)).toEqual({
      drop: ['try', 'try-attempt', 'sol'],
    });
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        outlineId: 'sol',
        action: 'dropped',
        findings: [
          { code: 'GUIDE_ANSWER_MISMATCH', contentUnitId: '6234', label: '1A', where: 'canvas' },
        ],
      }),
    );
  });
});
