/**
 * g5.v11 (teacher-guide answer referee plan §8.3–8.5): the comparator of the solution
 * slides' final lines and the attempts' keyed options, the leak guard of the try-it
 * slides, their narration and the attempt stems, and the D-19 settlement (16 Nov 2026):
 * never a slide dropped, never a step for a person.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  canvasLines,
  createGuideAnswerGuard,
  guardedSceneContent,
  type GuideAnswerSettlement,
} from '@/lib/server/teaching-package/guide-answer-guard';
import {
  droppedGuideOutlineIds,
  latestRunSettlements,
  mergeGuideSettlements,
} from '@/lib/server/teaching-package/guide-answer-context';
import {
  injectGuideAnswers,
  type GuideOutlinePlan,
  type KeyedGuideItem,
} from '@/lib/server/teaching-package/guide-answers';
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
const TRUTH: KeyedGuideItem = {
  ...ITEM,
  label: '1C',
  letter: 'C',
  display: '1C',
  answer: { type: 'bool', value: false },
};
const EX11: KeyedGuideItem = {
  contentUnitId: '6249',
  label: '11',
  element: 'exercise',
  number: 11,
  letter: null,
  display: 'س11',
  answer: { type: 'number', value: 32 },
};
const EX12: KeyedGuideItem = {
  ...EX11,
  label: '12',
  number: 12,
  display: 'س12',
  answer: { type: 'number', value: 71.9 },
};

const outline = (id: string, type: 'slide' | 'quiz' = 'slide', extra: Partial<SceneOutline> = {}) =>
  ({ id, type, title: id, description: '', keyPoints: [], order: 1, ...extra }) as SceneOutline;

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

const UNIT_TEXTS = new Map([
  [
    '6234',
    '1A) الأعداد 3، 6، 9 … ما الحد التالي؟\n1B) اختر: أ) 3 ب) 6 ج) 12 د) 15\n1C) العدد 12 فردي.',
  ],
  [
    '6249',
    '11) أسعار: 2، 4، 8، 16. ما العدد التالي؟\n12) إنتاج مصنع: 41.6، 51.8، 61.7. ما المتوقع؟',
  ],
]);

function guard(plans: Record<string, GuideOutlinePlan>) {
  const settled: GuideAnswerSettlement[] = [];
  const instance = createGuideAnswerGuard({
    unitTexts: UNIT_TEXTS,
    onSettled: (settlement) => settled.push(settlement),
  });
  instance.usePlans(new Map(Object.entries(plans)));
  return { instance, settled };
}

const SOLUTION: GuideOutlinePlan = { role: 'solution', items: [ITEM], solves: 3 };
const ATTEMPT: GuideOutlinePlan = { role: 'attempt', items: [ITEM] };

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

describe('the attempt comparator (review finding 6)', () => {
  const attempt = outline('ex-attempt', 'quiz');

  it('accepts the approved answer keyed among the options', () => {
    const { instance } = guard({ 'ex-attempt': { role: 'attempt', items: [ITEM] } });
    const content = quiz({ question: 'ما الحد التالي؟', options: ['11', '12', '15'], answer: 'B' });
    expect(instance.checkContent(attempt, content)).toEqual([]);
  });

  it('reads a choice item on its OWN question, never on another one keying that letter', () => {
    const { instance } = guard({
      'ex-attempt': {
        role: 'attempt',
        items: [CHOICE, { ...CHOICE, label: '1D', display: '1D' }],
        questionOf: { '6234|1B': 0, '6234|1D': 1 },
        questionCount: 2,
      },
    });
    const content = quiz(
      { question: 'اختر', options: ['a', 'b', 'c', 'd'], answer: 'C' },
      { question: 'اختر', options: ['a', 'b', 'c', 'd'], answer: 'D' },
    );
    expect(instance.checkContent(attempt, content)).toMatchObject([
      { code: 'GUIDE_ANSWER_MISMATCH', item: { label: '1D' }, questions: [1] },
    ]);
  });

  it('reads any question when the quiz does not hold the questions it was planned with', () => {
    const { instance } = guard({
      'ex-attempt': {
        role: 'attempt',
        items: [CHOICE],
        questionOf: { '6234|1B': 1 },
        questionCount: 2,
      },
    });
    const content = quiz({ question: 'اختر', options: ['a', 'b', 'c', 'd'], answer: 'C' });
    expect(instance.checkContent(attempt, content)).toEqual([]);
  });

  it('never reads another question’s book data as a leak of an earlier item', () => {
    const { instance, settled } = guard({
      'ex-attempt': {
        role: 'attempt',
        items: [EX11, EX12],
        questionOf: { '6249|11': 0, '6249|12': 1 },
        questionCount: 2,
      },
    });
    const content = quiz(
      { question: 'أسعار: 2، 4، 8، 16. ما التالي؟', options: ['24', '32'], answer: 'B' },
      // Q2's data holds 32 (Q1's answer) as a given.
      { question: 'إنتاج: 32، 51.8، 61.7. ما المتوقع؟', options: ['71.9', '80'], answer: 'A' },
    );
    expect(instance.checkContent(attempt, content)).toEqual([]);
    expect(settled).toEqual([]);
  });

  it('reports a stem that states the answer', () => {
    const { instance } = guard({ 'ex-attempt': { role: 'attempt', items: [ITEM] } });
    const content = quiz({
      question: 'الحد التالي هو 12، صح؟',
      options: ['12', '15'],
      answer: 'A',
    });
    expect(instance.checkContent(attempt, content)).toMatchObject([
      { code: 'GUIDE_ANSWER_LEAK', where: 'stem', questions: [0] },
    ]);
  });
});

describe('the try-it leak guard', () => {
  const { instance } = guard({ try: { role: 'try', items: [ITEM, CHOICE, TRUTH] } });
  const tryIt = outline('try');
  const narration = (text: string) =>
    instance.checkNarration(tryIt, [{ type: 'speech', text }]).map((finding) => finding.item.label);

  it('lets the givens of the item’s OWN question through and flags the answer', () => {
    expect(instance.checkContent(tryIt, slide('الأعداد 3، 6، 9 … ما الحد التالي؟'))).toEqual([]);
    expect(instance.checkContent(tryIt, slide('الحد التالي 12'))).toMatchObject([
      { code: 'GUIDE_ANSWER_LEAK', where: 'canvas', item: { label: '1A' } },
    ]);
  });

  it('never exempts a value only another item of the unit holds (review finding 3)', () => {
    // «12» is a given of 1B and 1C, never of 1A: stating it on 1A's try is a leak.
    expect(narration('في النمط 3، 6، 9 يكون الحد التالي 12')).toEqual(['1A']);
  });

  it('flags an announced option letter or truth value (review finding 1)', () => {
    expect(narration('الخيار ج هو الصحيح')).toEqual(['1B']);
    expect(narration('الإجابة الصحيحة هي ج.')).toEqual(['1B']);
    expect(narration('إذن العبارة خاطئة.')).toEqual(['1C']);
    expect(narration('التخمين غير صحيح لأن 3 فردي.')).toEqual(['1C']);
  });

  it('never flags the options read aloud, the task, or a question', () => {
    expect(narration('اختر الإجابة الصحيحة: أ) 3 ب) 6 ج) 18 د) 15')).toEqual([]);
    expect(narration('هل العبارة صحيحة أم خاطئة؟ فكّر قبل أن تجيب.')).toEqual([]);
    expect(narration('حدّد إن كانت العبارة صحيحة أو خاطئة')).toEqual([]);
    expect(narration('انتبه للخطأ الشائع في الجمع')).toEqual([]);
  });

  it('names the item, never its value, in a leak correction (review finding 7)', () => {
    const findings = instance.checkContent(tryIt, slide('الحد التالي 12'));
    const note = instance.correction(tryIt, findings);
    expect(note).toContain('item 1A');
    expect(note).not.toContain('12');
    const spoken = instance.checkNarration(tryIt, [{ type: 'speech', text: 'الجواب هو 12' }]);
    expect(instance.correction(tryIt, spoken)).not.toContain('12');
  });

  it('checks the narration of a try-it slide, never of a solution slide', () => {
    const speech = [{ type: 'speech', text: 'الجواب هو 12' }];
    const { instance: solution } = guard({ sol: SOLUTION });
    expect(solution.checkNarration(outline('sol'), speech)).toEqual([]);
  });

  it('keeps a try-it slide that still leaks (D-19: no group is ever dropped)', () => {
    const findings = instance.checkContent(tryIt, slide('الحد التالي 12'));
    expect(instance.settle(tryIt, slide('x'), findings)).toEqual({
      kind: 'keep',
      content: slide('x'),
    });
    expect(instance.settleNarration(tryIt, findings)).toBe('keep');
  });
});

describe('D-19 settlement', () => {
  it('generates a check item’s solution once more WITHOUT its guide answer, and keeps it', () => {
    const { instance, settled } = guard({ sol: SOLUTION });
    const sol = outline('sol', 'slide', {
      keyPoints: ['نجمع 3', 'الإجابة الصحيحة المعتمدة (1A): 12'],
      description: 'plan\n\nAPPROVED FINAL ANSWERS (g5.v11): …\n- الإجابة (1A): 12',
    });
    const findings = instance.checkContent(sol, slide('الإجابة (1A): 13'));
    const decision = instance.settle(sol, slide('الإجابة (1A): 13'), findings);
    expect(decision.kind).toBe('regenerate');
    const rebuilt = (decision as { outline: SceneOutline }).outline;
    expect(rebuilt.keyPoints).toEqual(['نجمع 3']);
    expect(rebuilt.description).toBe('plan');
    expect(settled.at(-1)).toMatchObject({
      action: 'unverified',
      items: [{ contentUnitId: '6234', label: '1A', outcome: 'unverified' }],
    });
    // The kept slide is no longer compared with an answer it was never given.
    expect(instance.planOf('sol')).toBeUndefined();
  });

  it('leaves an exercise out of its slide and removes its attempt question', () => {
    const { instance, settled } = guard({
      ex: { role: 'solution', items: [EX11, EX12], solves: 2 },
      'ex-attempt': {
        role: 'attempt',
        items: [EX11, EX12],
        questionOf: { '6249|11': 0, '6249|12': 1 },
        questionCount: 2,
      },
    });
    const ex = outline('ex');
    const findings = instance.checkContent(ex, slide('الإجابة (س11): 24', 'الإجابة (س12): 71.9'));
    const decision = instance.settle(ex, null, findings);
    expect(decision.kind).toBe('regenerate');
    const rebuilt = (decision as { outline: SceneOutline }).outline;
    expect(rebuilt.description).toContain('LEFT OUT QUESTIONS (g5.v11)');
    expect(rebuilt.description).toContain('- س11');
    expect(rebuilt.description).toContain('- الإجابة (س12): 71.9');
    expect(rebuilt.description).not.toContain('(س11): 32');
    expect(settled.at(-1)).toMatchObject({
      action: 'items_removed',
      items: [{ label: '11', outcome: 'removed' }],
    });
    // The attempt (before its slide in the lesson) loses that question only.
    const attemptQuiz = quiz(
      { question: 'أسعار؟', options: ['24', '32'], answer: 'B' },
      { question: 'إنتاج؟', options: ['71.9', '51.8'], answer: 'A' },
    );
    const pruned = instance.pruneAttempt(outline('ex-attempt', 'quiz'), attemptQuiz);
    expect(
      'content' in pruned && (pruned.content as { questions: unknown[] }).questions,
    ).toHaveLength(1);
    expect(instance.solutionsOf('ex-attempt')).toEqual(['ex']);
  });

  it('never empties a slide: its only exercise loses its guide answer instead', () => {
    const { instance, settled } = guard({ ex: { role: 'solution', items: [EX11], solves: 1 } });
    const findings = instance.checkContent(outline('ex'), slide('الإجابة (س11): 24'));
    const decision = instance.settle(outline('ex'), null, findings);
    expect(decision.kind).toBe('regenerate');
    expect(settled.at(-1)).toMatchObject({ action: 'unverified' });
  });

  it('keeps an exercise whose attempt question cannot be told, without its guide answer', () => {
    const { instance, settled } = guard({
      ex: { role: 'solution', items: [EX11, EX12], solves: 2 },
      'ex-attempt': {
        role: 'attempt',
        items: [EX11],
        questionOf: { '6249|11': null },
        questionCount: 1,
      },
    });
    const findings = instance.checkContent(
      outline('ex'),
      slide('الإجابة (س11): 24', 'الإجابة (س12): 71.9'),
    );
    instance.settle(outline('ex'), null, findings);
    expect(settled.at(-1)).toMatchObject({ action: 'unverified', items: [{ label: '11' }] });
  });

  it('removes an attempt’s own faulty question, and drops an attempt left with none', () => {
    const plan: GuideOutlinePlan = {
      role: 'attempt',
      items: [EX11],
      questionOf: { '6249|11': 0 },
      questionCount: 1,
    };
    const { instance, settled } = guard({ 'ex-attempt': plan });
    const attempt = outline('ex-attempt', 'quiz');
    const content = quiz({ question: 'أسعار؟', options: ['24', '32'], answer: 'A' });
    const findings = instance.checkContent(attempt, content);
    expect(findings).toMatchObject([{ questions: [0] }]);
    expect(instance.settle(attempt, content, findings)).toEqual({ kind: 'keep', content });
    expect(instance.pruneAttempt(attempt, content)).toEqual({ drop: true });
    expect(settled.map((entry) => entry.action)).toEqual(['questions_removed', 'attempt_dropped']);
  });

  it('gives an attempt a model-free narration when it still states the answer', () => {
    const { instance } = guard({ 'ex-attempt': ATTEMPT });
    const findings = instance.checkNarration(outline('ex-attempt', 'quiz'), [
      { type: 'speech', text: 'الجواب 12' },
    ]);
    expect(instance.settleNarration(outline('ex-attempt', 'quiz'), findings)).toBe('model_free');
  });

  it('restores a paused run’s settlements: a removed exercise stays removed', () => {
    const { instance } = guard({
      ex: { role: 'solution', items: [EX11, EX12], solves: 2 },
      'ex-attempt': {
        role: 'attempt',
        items: [EX11, EX12],
        questionOf: { '6249|11': 0, '6249|12': 1 },
        questionCount: 2,
      },
    });
    instance.restore([
      { outlineId: 'ex', items: [{ contentUnitId: '6249', label: '11', outcome: 'removed' }] },
    ]);
    expect(instance.planOf('ex')!.items.map((item) => item.label)).toEqual(['12']);
    const pruned = instance.pruneAttempt(
      outline('ex-attempt', 'quiz'),
      quiz(
        { question: 'أسعار؟', options: ['24', '32'], answer: 'B' },
        { question: 'إنتاج؟', options: ['71.9'], answer: 'A' },
      ),
    );
    expect((pruned as { content: { questions: unknown[] } }).content.questions).toHaveLength(1);
  });
});

describe('pinned settlements (review finding 9)', () => {
  const record = (outlineId: string, run: number, dropped: string[] = []) => ({
    outlineId,
    action: dropped.length > 0 ? ('attempt_dropped' as const) : ('unverified' as const),
    dropped,
    removedQuestions: [],
    items: [],
    findings: [],
    generationRun: run,
  });

  it('merges a resumed run’s settlements with what it pinned before the pause', () => {
    const before = [record('a-attempt', 2, ['a-attempt']), record('old', 1)];
    const merged = mergeGuideSettlements(before, [record('b', 2)], 2);
    // Run 1 was discarded; run 2 keeps its pre-pause record and adds the new one, once.
    expect(merged.map((entry) => entry.outlineId)).toEqual(['a-attempt', 'b']);
    expect(mergeGuideSettlements(merged, [record('b', 2)], 2)).toHaveLength(2);
  });

  it('names the attempts THIS run dropped, never another run’s', () => {
    const pinned = [record('a-attempt', 2, ['a-attempt']), record('x-attempt', 1, ['x-attempt'])];
    expect([...droppedGuideOutlineIds(pinned, 2)]).toEqual(['a-attempt']);
    expect(latestRunSettlements(pinned).map((entry) => entry.outlineId)).toEqual(['a-attempt']);
  });
});

describe('guardedSceneContent', () => {
  it('regenerates once with the correction, then once more from the settled outline', async () => {
    const { instance } = guard({ sol: SOLUTION });
    const corrections: Array<string | undefined> = [];
    const generate = vi.fn(async (_outline: SceneOutline, correction?: string) => {
      corrections.push(correction);
      return slide('الإجابة (1A): 13');
    });
    const sol = outline('sol');
    const result = await guardedSceneContent(instance, sol, slide('الإجابة (1A): 13'), generate);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(corrections[0]).toContain('CORRECTION');
    expect(corrections[1]).toBeUndefined();
    expect(result.outline).not.toBe(sol);
    expect(canvasLines(result.content)).toEqual(['الإجابة (1A): 13']);
  });

  it('returns the first content untouched when it agrees', async () => {
    const { instance } = guard({ sol: SOLUTION });
    const generate = vi.fn();
    const first = slide('الإجابة (1A): 12');
    const sol = outline('sol');
    const result = await guardedSceneContent(instance, sol, first, generate);
    expect(generate).not.toHaveBeenCalled();
    expect(result).toEqual({ content: first, outline: sol, leaks: [] });
  });

  it('returns what a kept try-it slide still states before the try (re-review finding 5c)', async () => {
    const { instance } = guard({ try: { role: 'try', items: [ITEM] } });
    const generate = vi.fn(async () => slide('الحد التالي 12'));
    const result = await guardedSceneContent(
      instance,
      outline('try'),
      slide('الحد التالي 12'),
      generate,
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.leaks).toMatchObject([{ code: 'GUIDE_ANSWER_LEAK', item: { label: '1A' } }]);
  });
});

describe('re-review fixes', () => {
  it('finding 1: a solution slide’s check before its try is leak-checked, never compared', () => {
    const { instance, settled } = guard({
      ex: { role: 'solution', items: [EX11], solves: 1, beforeTry: [ITEM] },
    });
    const ex = outline('ex');
    const canvas = slide('الإجابة (س11): 32', 'وفي التحقق الحد التالي 12');
    const findings = instance.checkContent(ex, canvas);
    expect(findings).toMatchObject([{ code: 'GUIDE_ANSWER_LEAK', item: { label: '1A' } }]);
    expect(
      instance.checkNarration(ex, [{ type: 'speech', text: 'الحد التالي اثنا عشر' }]),
    ).toMatchObject([{ code: 'GUIDE_ANSWER_LEAK', where: 'narration' }]);
    // Still leaking: kept (D-19), and the slide's own items keep their guide answer.
    expect(instance.settle(ex, canvas, findings)).toEqual({ kind: 'keep', content: canvas });
    expect(settled.at(-1)).toMatchObject({ action: 'unverified', items: [{ label: '1A' }] });
    expect(instance.planOf('ex')!.items.map((item) => item.label)).toEqual(['11']);
  });

  it('finding 4: a final line that cannot be compared is never a mismatch', () => {
    const PI: KeyedGuideItem = { ...ITEM, answer: { type: 'number', value: 3.142 } };
    const { instance } = guard({ sol: { role: 'solution', items: [PI], solves: 1 } });
    expect(instance.checkContent(outline('sol'), slide('الإجابة (1A): 3,142'))).toEqual([]);
    expect(instance.checkContent(outline('sol'), slide('الإجابة (1A): 2,718'))).toMatchObject([
      { code: 'GUIDE_ANSWER_MISMATCH' },
    ]);
  });

  it('finding 4: a narration that says the answer in words leaks', () => {
    const { instance } = guard({ try: { role: 'try', items: [ITEM] } });
    expect(
      instance.checkNarration(outline('try'), [
        { type: 'speech', text: 'إذن الحد التالي اثنا عشر' },
      ]),
    ).toMatchObject([{ code: 'GUIDE_ANSWER_LEAK', item: { label: '1A' } }]);
  });

  it('finding 5a: never removes a question that only lists the value as a wrong option', () => {
    const { instance } = guard({
      ex: { role: 'solution', items: [EX11, EX12], solves: 2 },
      // The quiz's questions cannot be told apart (no question count).
      'ex-attempt': { role: 'attempt', items: [EX11] },
    });
    const attempt = outline('ex-attempt', 'quiz');
    const content = quiz(
      { question: 'أسعار؟', options: ['24', '32'], answer: 'A' },
      // Another item's correct question, offering 32 as a wrong option.
      { question: 'إنتاج؟', options: ['32', '71.9'], answer: 'B' },
    );
    const findings = instance.checkContent(attempt, content);
    expect(findings).toMatchObject([{ code: 'GUIDE_ANSWER_MISMATCH', questions: null }]);
    // Not removable: the item loses its guide key instead (D-19), and no question leaves.
    expect(instance.settle(attempt, content, findings).kind).toBe('regenerate');
    const pruned = instance.pruneAttempt(attempt, content);
    expect((pruned as { content: { questions: unknown[] } }).content.questions).toHaveLength(2);
  });

  it('finding 6: a check item unverified on its solution slide loses its attempt key', () => {
    const { instance, settled } = guard({
      try: { role: 'try', items: [ITEM] },
      'try-attempt': { role: 'attempt', items: [ITEM] },
      sol: SOLUTION,
    });
    expect(instance.solutionsOf('try-attempt')).toEqual(['sol']);
    const attempt = outline('try-attempt', 'quiz', {
      description: 'Try.\n\nHIDDEN ANSWER KEY (g5.v11): …\n- item 1A: 12',
    });
    // Nothing settled yet: the attempt keeps its key.
    expect(instance.rekeyAttempt(attempt)).toBeUndefined();
    const sol = outline('sol');
    const findings = instance.checkContent(sol, slide('الإجابة (1A): 13'));
    expect(instance.settle(sol, slide('الإجابة (1A): 13'), findings).kind).toBe('regenerate');
    // The attempt is generated once more without that key, and plans without it.
    const rekeyed = instance.rekeyAttempt(attempt)!;
    expect(rekeyed.description).toBe('Try.');
    expect(instance.planOf('try-attempt')).toBeUndefined();
    expect(settled.at(-1)).toMatchObject({
      outlineId: 'try-attempt',
      action: 'unverified',
      items: [{ label: '1A', outcome: 'unverified' }],
    });
    expect(instance.rekeyAttempt(rekeyed)).toBeUndefined();
  });

  it('finding 6: a resumed run’s attempt is planned without a key its solution was settled without', () => {
    const { instance } = guard({
      'try-attempt': { role: 'attempt', items: [ITEM] },
      sol: SOLUTION,
    });
    instance.restore([
      { outlineId: 'sol', items: [{ contentUnitId: '6234', label: '1A', outcome: 'unverified' }] },
    ]);
    expect(instance.planOf('try-attempt')).toBeUndefined();
    expect(instance.effectivePlans().has('try-attempt')).toBe(false);
  });

  it('names the exercises a settlement removed per solution slide', () => {
    const { instance } = guard({ ex: { role: 'solution', items: [EX11, EX12], solves: 2 } });
    instance.restore([
      { outlineId: 'ex', items: [{ contentUnitId: '6249', label: '11', outcome: 'removed' }] },
    ]);
    expect([...instance.leftOut().entries()].map(([id, items]) => [id, items.length])).toEqual([
      ['ex', 1],
    ]);
  });
});

describe('lesson 1-1: a final line on a slide that solves another item', () => {
  const EX1: KeyedGuideItem = {
    contentUnitId: '6247',
    label: '1',
    element: 'exercise',
    number: 1,
    letter: null,
    display: 'س1',
    answer: { type: 'number', value: 11.25, unit: 'ريالاً' },
  };
  const EX5: KeyedGuideItem = {
    ...EX1,
    label: '5',
    number: 5,
    display: 'س5',
    answer: { type: 'number', value: 24 },
  };
  const EX7: KeyedGuideItem = {
    ...EX1,
    contentUnitId: '6248',
    label: '7',
    number: 7,
    display: 'س7',
    answer: { type: 'text', value: 'عدد زوجي' },
  };
  const PLANS: Record<string, GuideOutlinePlan> = {
    sol: { role: 'solution', items: [EX1, EX5, EX7], solves: 3 },
    'sol-attempt': {
      role: 'attempt',
      items: [EX1, EX5, EX7],
      questionOf: { '6247|1': 0, '6247|5': 1, '6248|7': 2 },
      questionCount: 3,
    },
  };
  const P = '<p style="font-size:14px;text-align:right;">';
  const tag = (n: string) => `<span style="color:#6b7280;">(س${n} في كتابك)</span>`;
  /** Item 208 scene 26 as the run stored it: question 2 under the label planned for 5. */
  const scene26 = (secondTag: string) => ({
    elements: [
      {
        type: 'text',
        content: `${P}<strong>تمرين 1</strong> ${tag('1')} — التكلفة بالريال: 4.50، 6.75، 9.00.</p>${P}التخمين: 9.00 + 2.25 = 11.25.</p>${P}<strong>الإجابة (س1): 11.25 ريالاً</strong></p>`,
      },
      {
        type: 'text',
        content: `${P}<strong>تمرين 2</strong> ${tag(secondTag)} — مواعيد الحافلات: 10:15 صباحًا، 11:00 صباحًا، 11:45 صباحًا.</p>${P}11:45 صباحًا + 45 دقيقة = 12:30 مساءً.</p>${P}<strong>موعد الحافلة التالي: 12:30 مساءً</strong></p>${P}<strong>الإجابة (س5): 24</strong></p>`,
      },
      {
        type: 'text',
        content: `${P}<strong>تمرين 3</strong> ${tag('7')} — 2 × 4 = 8، و6 × 8 = 48.</p>${P}<strong>الإجابة (س7): عدد زوجي</strong></p>`,
      },
    ],
  });
  const keyed = () =>
    injectGuideAnswers(
      [
        outline('sol', 'slide', {
          contentRole: 'worked_example',
          description: 'حل التمارين ١–٣',
          keyPoints: ['تمرين ١', 'تمرين ٢', 'تمرين ٣'],
        }),
      ],
      new Map(Object.entries(PLANS)),
    )[0]!;

  it('keeps the final line of an exercise the slide solves', async () => {
    const { instance, settled } = guard(PLANS);
    const generate = vi.fn();
    const sol = keyed();
    const first = scene26('5');
    const result = await guardedSceneContent(instance, sol, first, generate);
    expect(generate).not.toHaveBeenCalled();
    expect(result).toEqual({ content: first, outline: sol, leaks: [] });
    expect(settled).toEqual([]);
  });

  it('strips the line of an exercise the slide does not solve, never pausing, and logs it unverified', async () => {
    const { instance, settled } = guard(PLANS);
    const generate = vi.fn();
    const sol = keyed();
    expect(sol.description).toContain('الإجابة (س5): 24');
    const first = scene26('2');
    const result = await guardedSceneContent(instance, sol, first, generate);
    // Deterministic: nothing is generated again, nothing throws.
    expect(generate).not.toHaveBeenCalled();
    const before = canvasLines(first);
    const after = canvasLines(result.content);
    expect(after).toEqual(before.filter((line) => line !== 'الإجابة (س5): 24'));
    expect(after).toContain('موعد الحافلة التالي: 12:30 مساءً');
    expect(after).toContain('الإجابة (س1): 11.25 ريالاً');
    expect(after).toContain('الإجابة (س7): عدد زوجي');
    // The paragraph leaves whole; the element's other paragraphs stay as they were.
    const bus = (result.content as { elements: Array<{ content: string }> }).elements[1]!.content;
    expect(bus).toBe(first.elements[1]!.content.slice(0, bus.length));
    expect(bus.endsWith('12:30 مساءً</strong></p>')).toBe(true);
    // The narration's outline (and the persisted plan) no longer carry 5's answer.
    expect(result.outline).not.toBe(sol);
    expect(result.outline.description).not.toContain('(س5)');
    expect(result.outline.keyPoints?.join('\n')).not.toContain('(س5)');
    expect(result.outline.description).toContain('الإجابة (س1): 11.25 ريالاً');
    expect(settled).toEqual([
      expect.objectContaining({
        outlineId: 'sol',
        action: 'unverified',
        items: [{ contentUnitId: '6247', label: '5', outcome: 'unverified' }],
        findings: [
          { code: 'GUIDE_ANSWER_UNSOLVED', contentUnitId: '6247', label: '5', where: 'canvas' },
        ],
      }),
    ]);
    // Unverified on the slide; its attempt keeps the key it was compared with.
    expect(instance.planOf('sol')?.items.map((item) => item.label)).toEqual(['1', '7']);
    expect(instance.planOf('sol-attempt')?.items.map((item) => item.label)).toEqual([
      '1',
      '5',
      '7',
    ]);
  });

  it('cuts an inline final line, and keeps every line on a slide that tags no exercise', () => {
    const { instance } = guard(PLANS);
    const inline = slide('(س1 في كتابك) 11.25 الإجابة (س1): 11.25', 'موعد 12:30 الإجابة (س5): 24');
    expect(canvasLines(instance.settleUnsolved(keyed(), inline).content)).toEqual([
      '(س1 في كتابك) 11.25 الإجابة (س1): 11.25',
      'موعد 12:30',
    ]);
    // A coordinate «(س2 - س1)» is never a book tag: the slide cannot be told.
    const fresh = guard(PLANS);
    const untagged = slide('م = (ص2 - ص1) ÷ (س2 - س1)', 'الإجابة (س5): 24');
    const sol = keyed();
    expect(fresh.instance.settleUnsolved(sol, untagged)).toEqual({
      content: untagged,
      outline: sol,
    });
    expect(fresh.settled).toEqual([]);
  });
});
