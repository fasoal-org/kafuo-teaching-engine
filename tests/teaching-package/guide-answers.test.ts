/**
 * g5.v11 (teacher-guide answer referee plan §8, 16 Nov 2026), wave 3: the guide items
 * resolved to OUR book items, the exercise selection that prefers keyed items and never
 * picks a held one, and the approved answers placed on the solution slides and the
 * attempts' hidden keys — never on a try-it slide.
 */
import { describe, expect, it } from 'vitest';

import { insertAttemptQuizzes } from '@/lib/server/teaching-package/attempt-quizzes';
import { teacherParityBook } from '@/lib/server/teaching-package/book-coverage';
import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import {
  formatGuideAnswer,
  guideItemQuestionText,
  guideOutlinePlans,
  injectGuideAnswers,
  parseGuideLabel,
  resolveTeacherGuide,
  SOLUTION_KEY_POINT_PREFIX,
  withGuideItems,
  withoutGuideAnswers,
  withoutHiddenAnswerKey,
} from '@/lib/server/teaching-package/guide-answers';
import type { BookUnitFacts } from '@/lib/server/teaching-package/hidden-step-types';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
  KafuoTeacherGuide,
  KafuoTeacherGuideItem,
} from '@/lib/types/teaching-package';

const V10 = { key: 'g5', version: 'g5.v10' };
const V11 = { key: 'g5', version: 'g5.v11' };

// Item 208's shape: example 6230, check 6234 (1A, 1B), exercises 6247 (one question),
// 6249 (questions 11–14), 6250 (one question).
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
      contentUnitId: '6247',
      kind: 'GUIDED_PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
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
    {
      contentUnitId: '6250',
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
  '6247': { itemLabels: [], hiddenSteps: [], questionNumbers: [1] },
  '6249': { itemLabels: [], hiddenSteps: [], questionNumbers: [11, 12, 13, 14] },
  '6250': { itemLabels: [], hiddenSteps: [] },
};

const approved = (contentUnitId: string, label: string, value: number): KafuoTeacherGuideItem => ({
  contentUnitId,
  label,
  status: 'approved',
  answer: { type: 'number', value },
});

function guide(items: KafuoTeacherGuideItem[]): KafuoTeacherGuide {
  return { guideId: 'tg-1', items };
}

describe('parseGuideLabel', () => {
  it.each([
    ['1A', 1, 'A'],
    ['ex 11b', 11, 'B'],
    ['س١١', 11, null],
    ['11', 11, null],
    ['3 ب', 3, 'B'],
    ['(2)', 2, null],
  ])('%s', (label, number, letter) => {
    expect(parseGuideLabel(label)).toEqual({ number, letter });
  });

  it('gives no number for a label that is not an item', () => {
    expect(parseGuideLabel('مسألة مفتوحة')).toEqual({ number: null, letter: null });
  });
});

describe('resolveTeacherGuide', () => {
  it('matches by OUR labels and question numbers, never by a number the unit lacks', () => {
    const resolved = resolveTeacherGuide(
      guide([
        approved('6249', 'ex 12', 72),
        approved('6234', '1B', 5),
        approved('6249', '15', 3),
        approved('6234', '2A', 3),
        approved('6230', '1', 4),
        { contentUnitId: '6249', label: '13', status: 'doubtful' },
        { contentUnitId: '6247', label: '1', status: 'settled' },
      ]),
      BOOK,
      FACTS,
    );
    expect(resolved.keyed.map((item) => `${item.contentUnitId}/${item.display}`)).toEqual([
      '6234/1B',
      '6249/س12',
    ]);
    expect(resolved.unresolved.map((item) => item.label)).toEqual(['15', '2A', '1']);
    expect(resolved.exerciseStatuses).toEqual({
      '6249': { '12': 'keyed', '13': 'held' },
      '6247': { '*': 'held' },
    });
  });

  it('formats each answer kind for the writers', () => {
    expect(formatGuideAnswer({ type: 'number', value: 11.25, unit: 'ريال' })).toBe('11.25 ريال');
    expect(formatGuideAnswer({ type: 'number', value: 72, approximate: true })).toBe('تقريبًا 72');
    expect(formatGuideAnswer({ type: 'bool', value: false })).toBe('خاطئة');
    expect(formatGuideAnswer({ type: 'choice', value: 'C' })).toBe('C');
    expect(formatGuideAnswer({ type: 'text', value: 'شوال' })).toBe('شوال');
  });
});

describe('g5.v11 exercise selection', () => {
  const v10Selection = selectExercises(teacherParityBook(BOOK, V10, FACTS)!, FACTS);

  it('is the g5.v10 selection on g5.v10 even when a guide is passed', () => {
    const book = teacherParityBook(BOOK, V10, FACTS, guide([approved('6249', '14', 1)]))!;
    expect(book.exerciseGuide).toBeUndefined();
    expect(selectExercises(book, FACTS)).toEqual(v10Selection);
  });

  it('is the g5.v10 selection on g5.v11 when the guide marks no exercise', () => {
    const book = teacherParityBook(BOOK, V11, FACTS, guide([approved('6234', '1A', 2)]))!;
    expect(selectExercises(book, FACTS)).toEqual(v10Selection);
  });

  it('never selects a held item and prefers a keyed one, keeping the caps', () => {
    const book = teacherParityBook(
      BOOK,
      V11,
      FACTS,
      guide([
        { contentUnitId: '6247', label: '1', status: 'changed' },
        { contentUnitId: '6249', label: '11', status: 'doubtful' },
        approved('6249', '14', 9),
      ]),
    )!;
    const selection = selectExercises(book, FACTS)!;
    const picked = selection.slides.flatMap((ids, index) =>
      ids.flatMap((id) =>
        (selection.slideQuestions?.[index]?.[id] ?? [0]).map((question) => `${id}:${question}`),
      ),
    );
    expect(picked).not.toContain('6247:0');
    expect(picked).not.toContain('6249:11');
    expect(picked).toContain('6249:14');
    expect(picked.length).toBeLessThanOrEqual(BOOK.exercisePolicy!.maxExercises);
    // Book order on the slides, whatever the pick order.
    const questions = picked
      .filter((entry) => entry.startsWith('6249:'))
      .map((entry) => Number(entry.split(':')[1]));
    expect(questions).toEqual([...questions].sort((a, b) => a - b));
  });

  it('keeps the g5.v10 set when every usable exercise is held (never a paused plan)', () => {
    const book = teacherParityBook(
      BOOK,
      V11,
      FACTS,
      guide([
        { contentUnitId: '6247', label: '1', status: 'doubtful' },
        ...[11, 12, 13, 14].map(
          (n): KafuoTeacherGuideItem => ({
            contentUnitId: '6249',
            label: String(n),
            status: 'changed',
          }),
        ),
        { contentUnitId: '6250', label: '1', status: 'doubtful' },
      ]),
    )!;
    expect(selectExercises(book, FACTS)?.unitIds).toEqual(v10Selection?.unitIds);
  });
});

// The planned lesson around the check and one exercise slide.
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
    slide(
      'try-1',
      'check_understanding',
      ['6234'],
      ['1A) أوجد الحد التالي', '1B) هل التخمين صحيح؟'],
    ),
    slide('sol-1', 'worked_example', ['6234'], ['نحسب الفرق بين الحدود']),
    slide('ex-1', 'worked_example', ['6249'], ['نحل السؤالين 11 و 12']),
  ].map((outline, index) => ({ ...outline, order: index + 1 }));
}

describe('approved answers in first (plan §8 table)', () => {
  const resolved = resolveTeacherGuide(
    guide([approved('6234', '1A', 12), approved('6249', '12', 71.9), approved('6249', '14', 3)]),
    BOOK,
    FACTS,
  );
  const slideQuestions = [{ '6249': [11, 12] }];
  const withAttempts = insertAttemptQuizzes(outlines(), BOOK, {
    facts: FACTS,
    exerciseSlideQuestions: slideQuestions,
  });
  const plans = guideOutlinePlans(withAttempts, BOOK, resolved, { slideQuestions, facts: FACTS });
  const injected = injectGuideAnswers(withAttempts, plans);
  const byId = new Map(injected.map((outline) => [outline.id, outline]));

  it('maps each outline to the items it solves, tries or asks', () => {
    // The check slide solves its two items; the exercise slide its two questions.
    expect(plans.get('sol-1')).toMatchObject({ role: 'solution', solves: 2 });
    expect(plans.get('sol-1')!.items.map((item) => item.display)).toEqual(['1A']);
    expect(plans.get('try-1')).toMatchObject({ role: 'try' });
    expect(plans.get('try-1-attempt')!.items.map((item) => item.display)).toEqual(['1A']);
    // Question 14 is not on this slide; question 12 is.
    expect(plans.get('ex-1')!.items.map((item) => item.display)).toEqual(['س12']);
    expect(plans.get('ex-1')).toMatchObject({ solves: 2 });
    expect(plans.get('ex-1-attempt')!.items.map((item) => item.display)).toEqual(['س12']);
    // Without the unit texts, no attempt question can be told (review finding 6).
    expect(plans.get('ex-1-attempt')!.questionOf).toEqual({ '6249|12': null });
  });

  it('gives the solution slide the answer as key points and a writer instruction', () => {
    const solution = byId.get('sol-1')!;
    expect(solution.keyPoints).toContain(`${SOLUTION_KEY_POINT_PREFIX} (1A): 12`);
    expect(solution.description).toContain('- الإجابة (1A): 12');
    expect(solution.description).toContain('Never write «المعتمدة»');
    expect(byId.get('ex-1')!.keyPoints).toContain(`${SOLUTION_KEY_POINT_PREFIX} (س12): 71.9`);
  });

  it('gives the attempt a hidden key in its description, never in its key points', () => {
    for (const id of ['try-1-attempt', 'ex-1-attempt']) {
      const attempt = byId.get(id)!;
      const before = withAttempts.find((outline) => outline.id === id)!;
      expect(attempt.keyPoints).toEqual(before.keyPoints);
      expect(attempt.description).toContain('HIDDEN ANSWER KEY (g5.v11)');
    }
    expect(byId.get('try-1-attempt')!.description).toContain('- item 1A: 12');
  });

  it('never touches a try-it slide', () => {
    expect(byId.get('try-1')).toBe(withAttempts.find((outline) => outline.id === 'try-1'));
  });

  it('is idempotent on a resumed outline', () => {
    expect(injectGuideAnswers(injected, plans)).toBe(injected);
  });

  it('cuts the hidden key off before the narration writer (review finding 1)', () => {
    const attempt = byId.get('try-1-attempt')!;
    const spoken = withoutHiddenAnswerKey(attempt);
    expect(spoken.description).not.toContain('HIDDEN ANSWER KEY');
    expect(spoken.description).not.toContain('12');
    expect(spoken.description).toBe(withAttempts.find((o) => o.id === attempt.id)!.description);
    // Every other outline is returned as it is (g5.v8–v10 never carry a key).
    const plain = byId.get('try-1')!;
    expect(withoutHiddenAnswerKey(plain)).toBe(plain);
  });

  it('rebuilds a settled outline without the failing items (D-19)', () => {
    const exercise = byId.get('ex-1')!;
    const plan = plans.get('ex-1')!;
    const leftOut = withGuideItems(exercise, plan, [], plan.items);
    expect(leftOut.keyPoints.some((point) => point.startsWith(SOLUTION_KEY_POINT_PREFIX))).toBe(
      false,
    );
    expect(leftOut.description).not.toContain('71.9');
    expect(leftOut.description).toContain('LEFT OUT QUESTIONS (g5.v11)');
    expect(leftOut.description).toContain('- س12');
    // A resumed run rebuilds the same blocks from the guard's effective plans and its
    // left-out exercises: nothing is injected again.
    const resumed = injectGuideAnswers([leftOut], new Map(), new Map([['ex-1', plan.items]]));
    expect(resumed[0]).toBe(leftOut);
    // Unverified: no guide answer and no left-out note (the plain g5.v10 path).
    const unverified = withGuideItems(exercise, plan, []);
    expect(unverified.description).toBe(withAttempts.find((o) => o.id === 'ex-1')!.description);
    const attempt = withGuideItems(byId.get('ex-1-attempt')!, plans.get('ex-1-attempt')!, []);
    expect(attempt.description).not.toContain('HIDDEN ANSWER KEY');
  });
});

describe('re-review finding 1: a solution slide is keyed only after its check’s try', () => {
  const resolved = resolveTeacherGuide(
    guide([approved('6234', '1A', 12), approved('6249', '12', 71.9)]),
    BOOK,
    FACTS,
  );
  const [tryIt, solution, exercise] = outlines();
  const slideQuestions = [{ '6249': [11, 12] }];
  const plan = (lesson: SceneOutline[]) =>
    guideOutlinePlans(lesson, BOOK, resolved, { slideQuestions, facts: FACTS });

  it('keys a worked example placed after the try-it slide', () => {
    expect(plan([tryIt!, solution!]).get('sol-1')).toMatchObject({ role: 'solution' });
  });

  it('treats a worked example placed BEFORE the try (or with no try) as a try-side slide', () => {
    const before = plan([solution!, tryIt!]);
    expect(before.get('sol-1')).toMatchObject({ role: 'try' });
    expect(plan([solution!]).get('sol-1')).toMatchObject({ role: 'try' });
    // Never injected: the slide comes before the learner's try.
    const lesson = [solution!, tryIt!];
    expect(injectGuideAnswers(lesson, before)).toBe(lesson);
  });

  it('keys a mixed slide’s exercise and guards its untried check', () => {
    const mixed = { ...exercise!, sourceContentUnitIds: ['6249', '6234'] };
    const plans = plan([mixed, tryIt!]);
    expect(plans.get('ex-1')).toMatchObject({ role: 'solution' });
    expect(plans.get('ex-1')!.items.map((item) => item.display)).toEqual(['س12']);
    expect(plans.get('ex-1')!.beforeTry!.map((item) => item.display)).toEqual(['1A']);
    const [injected] = injectGuideAnswers([mixed], plans);
    expect(injected!.description).toContain('(س12): 71.9');
    expect(injected!.description).not.toContain('(1A)');
  });
});

describe('re-review finding 2: the guide blocks follow the CURRENT role', () => {
  const resolved = resolveTeacherGuide(guide([approved('6234', '1A', 12)]), BOOK, FACTS);
  const plansOf = (lesson: SceneOutline[]) =>
    guideOutlinePlans(lesson, BOOK, resolved, { facts: FACTS });
  const keyed = injectGuideAnswers(outlines(), plansOf(outlines()));
  const stale = keyed.find((outline) => outline.id === 'sol-1')!;

  it('strips a former solution slide that a correction made a check, then rebuilds nothing', () => {
    expect(stale.description).toContain('APPROVED FINAL ANSWERS');
    // A scenes-phase correction turned the solution slide into a check.
    const corrected = keyed.map((outline) =>
      outline.id === 'sol-1'
        ? { ...outline, contentRole: 'check_understanding' as const }
        : outline,
    );
    const resumed = injectGuideAnswers(corrected, plansOf(corrected));
    const now = resumed.find((outline) => outline.id === 'sol-1')!;
    expect(now.description).toBe('plan of sol-1');
    expect(now.keyPoints.some((point) => point.startsWith(SOLUTION_KEY_POINT_PREFIX))).toBe(false);
  });

  it('never lets a check attempt copy a stale key point', () => {
    const corrected = keyed.map((outline) =>
      outline.id === 'sol-1'
        ? { ...outline, contentRole: 'check_understanding' as const }
        : outline,
    );
    const withAttempts = insertAttemptQuizzes(withoutGuideAnswers(corrected), BOOK, {
      facts: FACTS,
    });
    const attempt = withAttempts.find((outline) => outline.id === 'sol-1-attempt')!;
    expect(attempt.keyPoints.some((point) => point.startsWith(SOLUTION_KEY_POINT_PREFIX))).toBe(
      false,
    );
    // The narration writer never reads one either, even on an outline that kept it.
    const copied = { ...attempt, keyPoints: [...attempt.keyPoints, stale.keyPoints.at(-1)!] };
    expect(
      withoutHiddenAnswerKey(copied).keyPoints.some((point) =>
        point.startsWith(SOLUTION_KEY_POINT_PREFIX),
      ),
    ).toBe(false);
    // A solution slide's own narration still follows its key points.
    expect(withoutHiddenAnswerKey(stale)).toBe(stale);
  });
});

describe('attempt questions told apart (review finding 6)', () => {
  const unitTexts = new Map([
    ['6234', '1A) الأعداد 3، 6، 9 … ما الحد التالي؟\n1B) هل التخمين «12 عدد زوجي» صحيح؟'],
    [
      '6249',
      [
        'استعمل الأنماط للإجابة:',
        '11) أسعار: 2، 4، 8، 16. ما العدد التالي؟',
        '12) إنتاج مصنع: 41.6، 51.8، 61.7. ما الإنتاج المتوقع؟',
        '13) ما الحد التالي في 5، 10، 15؟',
        '14) ما الحد التالي في 1، 3، 5؟',
      ].join('\n'),
    ],
  ]);
  const resolved = resolveTeacherGuide(
    guide([approved('6234', '1B', 1), approved('6249', '12', 71.9), approved('6249', '11', 32)]),
    BOOK,
    FACTS,
  );
  const slideQuestions = [{ '6249': [11, 12] }];
  const withAttempts = insertAttemptQuizzes(outlines(), BOOK, {
    facts: FACTS,
    unitTexts,
    exerciseSlideQuestions: slideQuestions,
  });
  const plans = guideOutlinePlans(withAttempts, BOOK, resolved, {
    slideQuestions,
    facts: FACTS,
    unitTexts,
  });

  it('ties each exercise item to the question of its own book statement', () => {
    const attempt = plans.get('ex-1-attempt')!;
    expect(attempt.questionCount).toBe(2);
    expect(attempt.questionOf).toEqual({ '6249|11': 0, '6249|12': 1 });
  });

  it('ties each check item to its label position', () => {
    expect(plans.get('try-1-attempt')!.questionOf).toEqual({ '6234|1B': 1 });
  });
});

describe('an item’s own question text (review finding 3)', () => {
  const check = '1A) الأعداد 3، 6، 9 … ما الحد التالي؟\n1B) هل العدد 12 زوجي؟';
  const exercise = 'المثال 3 12) كم ضلعًا للمضلع ذي 7 أضلاع؟\n13) كم وجهًا للمكعب؟';

  it('cuts a check item from its label to the next one, the label out', () => {
    const text = guideItemQuestionText(check, { element: 'try_it', number: 1, letter: 'A' });
    expect(text).toContain('3، 6، 9');
    expect(text).not.toContain('12');
    expect(text).not.toContain('1A');
  });

  it('reads one exercise question without its number or margin header', () => {
    const text = guideItemQuestionText(exercise, { element: 'exercise', number: 12, letter: null });
    expect(text).toContain('7 أضلاع');
    expect(text).not.toMatch(/12|المثال|وجه/u);
  });

  it('falls back to the unit text with every label out when the item is not printed', () => {
    const text = guideItemQuestionText(exercise, { element: 'exercise', number: 40, letter: null });
    expect(text).not.toMatch(/(?:^|\s)(?:12|13)\)/u);
    expect(text).toContain('7');
  });
});
