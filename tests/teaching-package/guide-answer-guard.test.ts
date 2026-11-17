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

describe('settlement (owner, 17 Nov 2026: the approved answer is the truth, nothing is dropped)', () => {
  it('writes the approved final line into a check item’s solution and keeps it, key and all', () => {
    const { instance, settled } = guard({ sol: SOLUTION });
    const sol = outline('sol', 'slide', {
      keyPoints: ['نجمع 3', 'الإجابة الصحيحة المعتمدة (1A): 12'],
      description: 'plan\n\nAPPROVED FINAL ANSWERS (g5.v11): …\n- الإجابة (1A): 12',
    });
    const wrong = {
      elements: [{ id: 't0', type: 'text', content: '<p><strong>الإجابة (1A):</strong> 13</p>' }],
    };
    const findings = instance.checkContent(sol, wrong);
    const decision = instance.settle(sol, wrong, findings);
    expect(decision.kind).toBe('keep');
    const kept = (decision as { content: unknown }).content;
    // The wrong value is replaced in place, inside the slide's own markup.
    expect(canvasLines(kept)).toEqual(['الإجابة (1A): 12']);
    expect(JSON.stringify(kept)).toContain('<p><strong>الإجابة (1A): 12</strong></p>');
    expect(instance.checkContent(sol, kept)).toEqual([]);
    expect(settled.at(-1)).toMatchObject({
      action: 'final_line_written',
      items: [{ contentUnitId: '6234', label: '1A', outcome: 'written' }],
    });
    // The item keeps its guide answer (no unverified key, no regeneration without it).
    expect(instance.planOf('sol')!.items).toEqual([ITEM]);
  });

  it('never drops an exercise: its missing final line is added and its attempt question stays', () => {
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
    const canvas = {
      elements: [
        {
          id: 'h',
          type: 'text',
          left: 60,
          top: 40,
          width: 880,
          height: 60,
          content: '<p style="font-size:32px;">حل</p>',
          defaultColor: '#123456',
          defaultFontName: 'Font',
        },
        {
          id: 'w',
          type: 'text',
          left: 60,
          top: 120,
          width: 880,
          height: 50,
          content: '<p style="font-size:20px;">تمرين 1 (س11 في كتابك): نضاعف</p>',
          defaultColor: '#654321',
          defaultFontName: 'Font',
        },
        {
          id: 'f',
          type: 'text',
          left: 60,
          top: 180,
          width: 880,
          height: 50,
          content: '<p>الإجابة (س12): 71.9</p>',
        },
      ],
    };
    const findings = instance.checkContent(ex, canvas);
    expect(findings.map((finding) => [finding.code, finding.item.label])).toEqual([
      ['GUIDE_ANSWER_MISSING', '11'],
    ]);
    const decision = instance.settle(ex, canvas, findings);
    expect(decision.kind).toBe('keep');
    const kept = (decision as { content: { elements: Array<Record<string, unknown>> } }).content;
    expect(canvasLines(kept)).toContain('الإجابة (س11): 32');
    const added = kept.elements.at(-1)!;
    // Under the lowest element, in the style of the slide's last text.
    expect(added).toMatchObject({
      type: 'text',
      top: 234,
      defaultColor: '#654321',
      defaultFontName: 'Font',
    });
    expect(String(added.content)).toContain('font-size:20px');
    expect(instance.checkContent(ex, kept)).toEqual([]);
    expect(settled.at(-1)).toMatchObject({
      action: 'final_line_written',
      items: [{ label: '11', outcome: 'written' }],
    });
    // Nothing left the lesson: the attempt keeps both questions, the slide both items.
    const attemptQuiz = quiz(
      { question: 'أسعار؟', options: ['24', '32'], answer: 'B' },
      { question: 'إنتاج؟', options: ['71.9', '51.8'], answer: 'A' },
    );
    expect(instance.pruneAttempt(outline('ex-attempt', 'quiz'), attemptQuiz)).toEqual({
      content: attemptQuiz,
    });
    expect(instance.planOf('ex')!.items).toHaveLength(2);
    expect(instance.leftOut().size).toBe(0);
  });

  it('a final line written inside a formula leaves it, and the approved line is written as text', () => {
    const { instance } = guard({ ex: { role: 'solution', items: [EX11], solves: 1 } });
    const canvas = {
      elements: [{ id: 'l', type: 'latex', latex: 'الإجابة (س11): 24', top: 100, height: 40 }],
    };
    const findings = instance.checkContent(outline('ex'), canvas);
    const kept = (instance.settle(outline('ex'), canvas, findings) as { content: unknown }).content;
    expect(canvasLines(kept)).toEqual(['الإجابة (س11): 32']);
  });

  it('keys an attempt’s own question to the approved answer and never removes it', () => {
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
    const decision = instance.settle(attempt, content, findings);
    expect(decision.kind).toBe('keep');
    const kept = (decision as { content: { questions: Array<Record<string, unknown>> } }).content;
    expect(kept.questions[0]).toMatchObject({ answer: ['B'], analysis: 'الإجابة الصحيحة: 32.' });
    expect(instance.checkContent(attempt, kept)).toEqual([]);
    expect(instance.pruneAttempt(attempt, kept)).toEqual({ content: kept });
    expect(settled.map((entry) => entry.action)).toEqual(['key_rewritten']);
  });

  it('writes the approved answer into the keyed option when no option states it', () => {
    const plan: GuideOutlinePlan = {
      role: 'attempt',
      items: [EX11],
      questionOf: { '6249|11': 0 },
      questionCount: 1,
    };
    const { instance } = guard({ 'ex-attempt': plan });
    const attempt = outline('ex-attempt', 'quiz');
    const content = quiz({ question: 'أسعار؟', options: ['24', '30'], answer: 'B' });
    const findings = instance.checkContent(attempt, content);
    const kept = (instance.settle(attempt, content, findings) as { content: unknown }).content as {
      questions: Array<{ options: Array<{ label: string }>; answer: string[] }>;
    };
    expect(kept.questions[0]!.options.map((option) => option.label)).toEqual(['24', '32']);
    expect(kept.questions[0]!.answer).toEqual(['B']);
  });

  it('writes it in the options’ own variables (ص/س), never one odd «y/x» option', () => {
    const EX26: KeyedGuideItem = {
      ...EX11,
      label: '26',
      number: 26,
      display: 'س26',
      answer: { type: 'text', value: 'x = 2' },
    };
    const { instance } = guard({
      'ex-attempt': {
        role: 'attempt',
        items: [EX26],
        questionOf: { '6249|26': 0 },
        questionCount: 1,
      },
    });
    const attempt = outline('ex-attempt', 'quiz');
    const content = quiz({
      question: 'ما معادلة المستقيم المار بالنقطتين (2، -1) و(2، 6)؟',
      options: ['ص = 2', 'لا يمكن كتابة معادلته', 'ص = س + 2'],
      answer: 'B',
    });
    const findings = instance.checkContent(attempt, content);
    const kept = (instance.settle(attempt, content, findings) as { content: unknown }).content as {
      questions: Array<{ options: Array<{ label: string }>; answer: string[] }>;
    };
    expect(kept.questions[0]!.options.map((option) => option.label)).toEqual([
      'ص = 2',
      'س = 2',
      'ص = س + 2',
    ]);
    expect(instance.checkContent(attempt, kept)).toEqual([]);
  });

  it('a stem that still states the answer after its plain regeneration loses that question', () => {
    const plan: GuideOutlinePlan = {
      role: 'attempt',
      items: [EX11],
      questionOf: { '6249|11': 0 },
      questionCount: 2,
    };
    const { instance } = guard({ 'ex-attempt': plan });
    const attempt = outline('ex-attempt', 'quiz');
    const content = quiz(
      { question: 'الجواب 32، ما العدد التالي؟', options: ['24', '32'], answer: 'B' },
      { question: 'سؤال آخر؟', options: ['1', '2'], answer: 'A' },
    );
    const findings = instance.checkContent(attempt, content);
    expect(instance.settle(attempt, content, findings).kind).toBe('regenerate');
    instance.accept(attempt, findings);
    const pruned = instance.pruneAttempt(attempt, content) as { content: { questions: unknown[] } };
    expect(pruned.content.questions).toHaveLength(1);
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
  it('regenerates once with the correction, then writes the approved final line (no third call)', async () => {
    const { instance } = guard({ sol: SOLUTION });
    const corrections: Array<string | undefined> = [];
    const generate = vi.fn(async (_outline: SceneOutline, correction?: string) => {
      corrections.push(correction);
      return slide('نضيف 3', 'الإجابة (1A): 13');
    });
    const sol = outline('sol');
    const result = await guardedSceneContent(instance, sol, slide('الإجابة (1A): 13'), generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(corrections[0]).toContain('CORRECTION');
    expect(result.outline).toBe(sol);
    expect(canvasLines(result.content)).toEqual(['نضيف 3', 'الإجابة (1A): 12']);
    expect(result.leaks).toEqual([]);
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
    // Owner (17 Nov 2026): a wrong final line is written over, so the attempt keeps its key.
    const findings = instance.checkContent(sol, slide('الإجابة (1A): 13'));
    expect(instance.settle(sol, slide('الإجابة (1A): 13'), findings).kind).toBe('keep');
    expect(instance.rekeyAttempt(attempt)).toBeUndefined();
    // A paused run's slide settled unverified (a slide that solves another item) still
    // takes the key out of its attempt.
    instance.restore([
      { outlineId: 'sol', items: [{ contentUnitId: '6234', label: '1A', outcome: 'unverified' }] },
    ]);
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

  it('restores a written item with its key (owner, 17 Nov 2026)', () => {
    const { instance } = guard({
      'try-attempt': { role: 'attempt', items: [ITEM] },
      sol: SOLUTION,
    });
    instance.restore([
      { outlineId: 'sol', items: [{ contentUnitId: '6234', label: '1A', outcome: 'written' }] },
    ]);
    expect(instance.planOf('sol')!.items).toEqual([ITEM]);
    expect(instance.planOf('try-attempt')!.items).toEqual([ITEM]);
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

  /** A guard reading these units' book text (the items' own numbers). */
  const withTexts = (plans: Record<string, GuideOutlinePlan>, texts: Record<string, string>) => {
    const settled: GuideAnswerSettlement[] = [];
    const instance = createGuideAnswerGuard({
      unitTexts: new Map(Object.entries(texts)),
      onSettled: (settlement) => settled.push(settlement),
    });
    instance.usePlans(new Map(Object.entries(plans)));
    return { instance, settled };
  };
  const lines = (guard: ReturnType<typeof withTexts>, content: unknown) =>
    canvasLines(guard.instance.settleUnsolved(keyed(), content).content);
  const BOOK_6247 =
    '1) التكلفة بالريال: 4.50، 6.75، 9.00، … ما التكلفة التالية؟\n' +
    '2) مواعيد الحافلات: 10:15، 11:00، 11:45 صباحًا. ما الموعد التالي؟\n' +
    '5) 3، 3، 6، 9، 15، … ما الحد التالي؟';

  it('open point: a planned tag copied over another item’s working is not solved', () => {
    // Question 2's bus working under the «(س5)» tag holds none of 5's own numbers.
    expect(lines(withTexts(PLANS, { '6247': BOOK_6247 }), scene26('5'))).not.toContain(
      'الإجابة (س5): 24',
    );
    // Question 5 solved under its tag keeps its line.
    const solved = slide('تمرين 2 (س5 في كتابك) — 3، 3، 6، 9، 15: 9 + 15 = 24', 'الإجابة (س5): 24');
    expect(lines(withTexts(PLANS, { '6247': BOOK_6247 }), solved)).toContain('الإجابة (س5): 24');
  });

  it('review MED: a unit solved whole is read by its label’s number, or by its own numbers', () => {
    // A single-question unit: `resolveTeacherGuide` gives it no number.
    const WHOLE: KeyedGuideItem = {
      contentUnitId: '6260',
      label: '11',
      element: 'exercise',
      number: null,
      letter: null,
      display: 'س11',
      answer: { type: 'number', value: 71.9 },
    };
    const plans = { sol: { role: 'solution' as const, items: [EX1, WHOLE], solves: 2 } };
    const texts = {
      '6247': BOOK_6247,
      '6260': 'إنتاج مصنع بالملايين: 5، 7.2، 9.2، 14.1، 19.7، 28.4. ما المتوقع عام 2027؟',
    };
    const ex1 = '(س1 في كتابك) 4.50، 6.75، 9.00 → 11.25';
    // Tagged by its label's number.
    expect(
      lines(
        withTexts(plans, texts),
        slide(ex1, '(س11 في كتابك) الإنتاج: 5، 7.2 … 28.4', 'الإجابة (س11): 71.9'),
      ),
    ).toContain('الإجابة (س11): 71.9');
    // Untagged (the writer gets no tag for it), its own numbers on the slide.
    expect(
      lines(
        withTexts(plans, texts),
        slide(ex1, 'تمرين 4 — 5، 7.2، 9.2، 14.1، 19.7، 28.4؛ 2027', 'الإجابة (س11): 71.9'),
      ),
    ).toContain('الإجابة (س11): 71.9');
    // Its line under question 1's working, none of its numbers anywhere: not solved.
    const guard = withTexts(plans, texts);
    expect(lines(guard, slide(ex1, 'الإجابة (س11): 71.9'))).not.toContain('الإجابة (س11): 71.9');
    expect(guard.settled.at(-1)).toMatchObject({
      items: [{ contentUnitId: '6260', label: '11', outcome: 'unverified' }],
    });
  });

  it('final review: an untagged whole unit with fewer than two own numbers keeps its line', () => {
    const PROOF: KeyedGuideItem = {
      contentUnitId: '6261',
      label: '29',
      element: 'exercise',
      number: null,
      letter: null,
      display: 'س29',
      answer: { type: 'text', value: 'عدد فردي' },
    };
    const plans = { sol: { role: 'solution' as const, items: [EX1, PROOF], solves: 2 } };
    const guard = withTexts(plans, {
      '6247': BOOK_6247,
      '6261': 'ضع تخمينًا لناتج ضرب عددين فرديين، ثم برهنه.',
    });
    const content = slide(
      '(س1 في كتابك) 4.50، 6.75، 9.00 → 11.25',
      'الإجابة (س1): 11.25',
      'تمرين 5 — ناتج ضرب عددين فرديين: 2(2من + م + ن) + 1',
      'الإجابة (س29): عدد فردي',
    );
    const sol = keyed();
    // The slide tags another exercise; this one cannot be told, so nothing changes.
    expect(guard.instance.settleUnsolved(sol, content)).toEqual({ content, outline: sol });
    expect(guard.settled).toEqual([]);
  });

  it('review LOW: reads a tag’s parts and its wording variants', () => {
    const EX11A: KeyedGuideItem = {
      ...EX1,
      contentUnitId: '6249',
      label: '11a',
      number: 11,
      letter: 'A',
      display: 'س11a',
      answer: { type: 'number', value: 32 },
    };
    const EX11B: KeyedGuideItem = { ...EX11A, label: '11b', letter: 'B', display: 'س11b' };
    const plans = { sol: { role: 'solution' as const, items: [EX11A, EX11B, EX7], solves: 2 } };
    const finals = ['الإجابة (س11a): 32', 'الإجابة (س11b): 32', 'الإجابة (س7): عدد زوجي'];
    const read = (...tags: string[]) => lines(withTexts(plans, {}), slide(...tags, ...finals));
    // A tag naming part a never clears part b.
    expect(read('(س11أ في كتابك)', '(س٧ في كتابك)')).toEqual([
      '(س11أ في كتابك)',
      '(س٧ في كتابك)',
      'الإجابة (س11a): 32',
      'الإجابة (س7): عدد زوجي',
    ]);
    // Several parts in one tag, and «من كتابك», are tags: every line stays.
    expect(read('(س١١أ، ب)', '(س٧ في كتابك)')).toEqual(['(س١١أ، ب)', '(س٧ في كتابك)', ...finals]);
    expect(read('(س11 في كتابك)', '(س٧ من كتابك)')).toEqual([
      '(س11 في كتابك)',
      '(س٧ من كتابك)',
      ...finals,
    ]);
  });
});

/**
 * Lesson 2-5 run tpa-O26Zt1Zlhcnl (17 Nov 2026): checks 3A, 3B, 4 and 5 were solved right
 * and showed the guide's answer, but were logged GUIDE_ANSWER_MISSING / unverified — each
 * slide ends on «المعادلة:» or a boxed formula, never a «الإجابة (…):» line. The canvases
 * below are the run's own elements (slides 15, 19 and 26), in canvas order.
 */
describe('lesson 2-5: the run’s four false "unverified" flags', () => {
  const check = (unit: string, label: string, value: string): KeyedGuideItem => ({
    contentUnitId: unit,
    label,
    element: 'try_it',
    number: Number.parseInt(label, 10),
    letter: /[A-H]$/.test(label) ? label.slice(-1) : null,
    display: label,
    answer: { type: 'text', value },
  });
  const C3A = check('6409', '3A', 'y = ³⁄₅ x + ²⁶⁄₅');
  const C3B = check('6409', '3B', 'y = 3x');
  const C4 = check('6411', '4', 'y = 0');
  const C5 = check('6415', '5', 'y = −3/4 x + 15/4');
  const canvas = (...elements: Array<['text' | 'latex', string]>) => ({
    elements: elements.map(([type, value], index) =>
      type === 'text'
        ? { id: `t${index}`, type, content: `<p style="font-size:18px;">${value}</p>` }
        : { id: `l${index}`, type, latex: value },
    ),
  });
  const SLIDE_15 = canvas(
    ['text', 'حل تحقق من فهمك 3'],
    ['text', 'أوجد معادلة المستقيم المار بالنقطتين في كل بند.'],
    ['text', '3B: النقطتان'],
    ['latex', '(0,0),\\ (2,6)'],
    ['text', 'الميل: فرق الصادات على فرق السينات'],
    ['latex', 'm=\\frac{6-0}{2-0}=3'],
    ['text', 'المقطع الصادي صفر؛ إذن المعادلة:'],
    ['latex', '\\boxed{y=3x}'],
    ['latex', '(0,0)'],
    ['latex', '(2,6)'],
    ['latex', 'x'],
    ['latex', 'y'],
    ['text', '3A: النقطتان'],
    ['latex', '(-2,4),\\ (8,10)'],
    ['text', 'نحسب الميل من فرق الإحداثيات:'],
    ['latex', 'm=\\frac{10-4}{8-(-2)}=\\frac{6}{10}=\\frac35'],
    ['text', 'نعوّض بالميل والنقطة في صيغة الميل والنقطة:'],
    ['latex', 'y-4=\\frac35[x-(-2)]=\\frac35(x+2)'],
    ['latex', 'y-4=\\frac35x+\\frac65'],
    ['latex', 'y=\\frac35x+\\frac65+\\frac{20}5=\\boxed{\\frac35x+\\frac{26}5}'],
    ['latex', '(-2,4)'],
    ['latex', '(8,10)'],
    ['text', 'الخلاصة: يُحسب الميل من النقطتين، ثم تُستخدم نقطة لإيجاد المعادلة.'],
  );
  const SLIDE_19 = canvas(
    ['text', 'حل تحقق من فهمك 4'],
    ['latex', '(3,0),\\quad (5,0)'],
    ['latex', 'm=\\frac{0-0}{5-3}=\\frac{0}{2}=0'],
    ['latex', 'y-0=0(x-3)'],
    ['latex', 'y=0'],
    ['text', 'المعادلة:'],
    ['latex', '(3,0)'],
    ['latex', '(5,0)'],
    ['latex', 'x'],
    ['latex', 'y'],
    ['latex', '0'],
    ['text', 'المستقيم هو محور السينات'],
  );
  const SLIDE_26 = canvas(
    ['text', 'حل تحقق من فهمك 5'],
    ['text', '<strong>تحقق 5:</strong> أوجد معادلة المستقيم الموازي لـ'],
    ['latex', 'y=-\\frac{3}{4}x+3'],
    ['text', 'والمار بالنقطة'],
    ['latex', '(-3,6)'],
    ['latex', 'm=-\\frac{3}{4}'],
    ['latex', '6=-\\frac{3}{4}(-3)+b=\\frac{9}{4}+b'],
    ['latex', 'b=6-\\frac{9}{4}=\\frac{24}{4}-\\frac{9}{4}=\\frac{15}{4}'],
    ['text', '<strong>المعادلة:</strong>'],
    ['latex', 'y=-\\frac{3}{4}x+\\frac{15}{4}'],
    ['text', 'الميل مشترك، وقد يختلف المقطع الصادي.'],
  );

  it('verifies 3A and 3B, each on its own lines of slide 15', () => {
    const { instance } = guard({ sol: { role: 'solution', items: [C3B, C3A], solves: 2 } });
    expect(instance.checkContent(outline('sol'), SLIDE_15)).toEqual([]);
  });

  it('verifies check 4 on slide 19 and check 5 on slide 26', () => {
    const { instance } = guard({
      s19: { role: 'solution', items: [C4], solves: 1 },
      s26: { role: 'solution', items: [C5], solves: 1 },
    });
    expect(instance.checkContent(outline('s19'), SLIDE_19)).toEqual([]);
    expect(instance.checkContent(outline('s26'), SLIDE_26)).toEqual([]);
  });

  it('still reports an item its own lines do not solve, even when another item’s do', () => {
    const wrong3A = { ...C3A, answer: { type: 'text' as const, value: 'y = 3x' } };
    const { instance } = guard({ sol: { role: 'solution', items: [C3B, wrong3A], solves: 2 } });
    expect(
      instance.checkContent(outline('sol'), SLIDE_15).map((finding) => finding.item.label),
    ).toEqual(['3A']);
  });

  it('keys the run’s check-3 attempt in the quiz’s Arabic variables', () => {
    const { instance } = guard({
      att: {
        role: 'attempt',
        items: [C3B, C3A],
        questionOf: { '6409|3B': 0, '6409|3A': 1 },
        questionCount: 2,
      },
    });
    const run = quiz(
      {
        question: 'ما معادلة المستقيم المار بالنقطتين (0، 0) و(2، 6)؟',
        options: ['ص = 6س', 'ص = 3س + 6', 'ص = 3س', 'ص = (1/3)س'],
        answer: 'C',
      },
      {
        question: 'ما معادلة المستقيم المار بالنقطتين (-2، 4) و(8، 10)؟',
        options: ['ص = (3/5)س + 4', 'ص = (3/5)س + 26/5', 'ص = (5/3)س + 26/5', 'ص = (3/5)س + 14/5'],
        answer: 'B',
      },
    );
    expect(instance.checkContent(outline('att', 'quiz'), run)).toEqual([]);
  });
});
