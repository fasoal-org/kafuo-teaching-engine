/**
 * g5.v8 exercises block selected by the engine (owner, 2 Nov 2026): a pure,
 * deterministic pick from the book map and the pinned unit facts.
 */
import { describe, expect, it } from 'vitest';

import {
  bookUnitFactsOf,
  findBookCoverageGaps,
  teacherParityBook,
} from '@/lib/server/teaching-package/book-coverage';
import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import {
  exerciseQuestionNumbers,
  type BookUnitFacts,
} from '@/lib/server/teaching-package/hidden-step-types';
import type { KafuoBookStructure, KafuoBookStructureUnit } from '@/lib/types/teaching-package';

const POLICY = { maxExercises: 10, maxExerciseSlides: 3, minExercises: 6, minExerciseSlides: 2 };

/**
 * A lesson 306-like map: examples 1–4, each followed in the book by an
 * instruction line (instructions_only), its «تأكد» (GUIDED_PRACTICE) and its
 * «تدرب» (PRACTICE) items: 28 usable in all, plus one number_only item.
 */
function lesson306(): KafuoBookStructure {
  const units: KafuoBookStructureUnit[] = [];
  const examples = ['4021', '4026', '4031', '4036'];
  for (const example of examples) {
    units.push({
      contentUnitId: example,
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    });
  }
  let id = 5000;
  const exercise = (
    paired: string,
    kind: string,
    extra: Partial<KafuoBookStructureUnit> = {},
  ): void => {
    id += 1;
    units.push({
      contentUnitId: String(id),
      kind,
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: paired,
      ...extra,
    });
  };
  // «تأكد» per example: 2, 2, 1, 2 — then «تدرب»: 5, 5, 6, 5 (28 usable).
  const guided = [2, 2, 1, 2];
  const practice = [5, 5, 6, 5];
  examples.forEach((example, index) => {
    exercise(example, 'GUIDED_PRACTICE', {
      exerciseUsable: false,
      exerciseUnusableReason: 'instructions_only',
    });
    for (let n = 0; n < guided[index]!; n += 1) exercise(example, 'GUIDED_PRACTICE');
  });
  examples.forEach((example, index) => {
    for (let n = 0; n < practice[index]!; n += 1) exercise(example, 'PRACTICE');
  });
  exercise('4036', 'PRACTICE', { exerciseUsable: false, exerciseUnusableReason: 'number_only' });
  return { templateVersionId: '3', rules: [], units, exercisePolicy: POLICY };
}

const byId = (book: KafuoBookStructure) =>
  new Map(book.units.map((unit) => [unit.contentUnitId, unit] as const));

describe('M-4: an exercise left without items after the verse strip', () => {
  const VERSE = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
  const units: KafuoBookStructureUnit[] = ['8001', '8002', '8003'].map((id) => ({
    contentUnitId: id,
    kind: 'PRACTICE',
    element: 'exercise',
    required: false,
    partIndex: 1,
  }));
  const book: KafuoBookStructure = {
    templateVersionId: '3',
    rules: [],
    units,
    exercisePolicy: POLICY,
  };
  const texts = [
    // Every numbered item is a verse.
    { id: '8001', text: `استخرج النعت:\n1) ${VERSE}\n2) ${VERSE}` },
    // One verse item, nothing else but the instruction.
    { id: '8002', text: `أعرب ما تحته خط:\n${VERSE}` },
    // A poem item survives beside the verse.
    { id: '8003', text: `عيّن التابع:\n1) بيت الشعر الأول\n2) ${VERSE}` },
  ];

  it('is marked, never selected, and not a coverage requirement', () => {
    const facts = bookUnitFactsOf(book, texts);
    expect(facts['8001']!.noItemsLeft).toBe(true);
    expect(facts['8002']!.noItemsLeft).toBe(true);
    expect(facts['8003']!.noItemsLeft).toBeUndefined();
    expect(selectExercises(book, facts)!.unitIds).toEqual(['8003']);

    // With only verse-only exercises, nothing is selectable and no slide is required.
    const verseOnly = { ...book, units: units.slice(0, 2) };
    expect(selectExercises(verseOnly, facts)).toBeNull();
    const coverage = teacherParityBook(verseOnly, { key: 'g5', version: 'g5.v8' }, facts);
    expect(findBookCoverageGaps([], coverage).map((gap) => gap.kind)).not.toContain(
      'missing_exercises',
    );
    const withPoem = teacherParityBook(book, { key: 'g5', version: 'g5.v8' }, facts);
    expect(findBookCoverageGaps([], withPoem).map((gap) => gap.kind)).toContain(
      'missing_exercises',
    );
  });
});

describe('selectExercises', () => {
  it('picks 8 of 28 usable, covering every example on 2 slides of 4', () => {
    const book = lesson306();
    const usable = book.units.filter(
      (unit) => unit.element === 'exercise' && unit.exerciseUsable !== false,
    );
    expect(usable).toHaveLength(28);
    const selection = selectExercises(book)!;
    expect(selection.unitIds).toHaveLength(8);
    expect(selection.slides.map((slide) => slide.length)).toEqual([4, 4]);
    expect(selection.slides.flat()).toEqual(selection.unitIds);
    const units = byId(book);
    const picked = selection.unitIds.map((id) => units.get(id)!);
    // Never an unusable unit (instructions_only, number_only).
    expect(picked.every((unit) => unit.exerciseUsable !== false)).toBe(true);
    // Every example is covered.
    expect(new Set(picked.map((unit) => unit.pairedExampleUnitId))).toEqual(
      new Set(['4021', '4026', '4031', '4036']),
    );
    // «تأكد» first: all 7 guided items, then one «تدرب» for example 3 (it has one «تأكد»).
    expect(picked.filter((unit) => unit.kind === 'GUIDED_PRACTICE')).toHaveLength(7);
    const practice = picked.filter((unit) => unit.kind === 'PRACTICE');
    expect(practice.map((unit) => unit.pairedExampleUnitId)).toEqual(['4031']);
    // Book order, and reproducible.
    const order = book.units.map((unit) => unit.contentUnitId);
    expect([...selection.unitIds].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(
      selection.unitIds,
    );
    expect(selectExercises(lesson306())).toEqual(selection);
  });

  it('prefers a hidden-step type not yet represented, then book order', () => {
    const book = lesson306();
    const units = byId(book);
    const example3Practice = book.units.filter(
      (unit) => unit.pairedExampleUnitId === '4031' && unit.kind === 'PRACTICE',
    );
    const plain = selectExercises(book)!;
    // Without facts: the first «تدرب» of example 3.
    expect(plain.unitIds).toContain(example3Practice[0]!.contentUnitId);
    const late = example3Practice[4]!.contentUnitId;
    const facts: Record<string, BookUnitFacts> = {
      [late]: { itemLabels: [], hiddenSteps: ['clock_time'] },
    };
    const withFacts = selectExercises(book, facts)!;
    expect(withFacts.unitIds).toContain(late);
    expect(withFacts.unitIds).not.toContain(example3Practice[0]!.contentUnitId);
    // A type already represented gives no preference.
    const guided = book.units.find(
      (unit) => unit.kind === 'GUIDED_PRACTICE' && unit.exerciseUsable !== false,
    )!;
    const represented = selectExercises(book, {
      ...facts,
      [guided.contentUnitId]: { itemLabels: [], hiddenSteps: ['clock_time'] },
    })!;
    expect(represented.unitIds).toContain(example3Practice[0]!.contentUnitId);
    expect(units.get(late)?.kind).toBe('PRACTICE');
  });

  it('takes every usable exercise when fewer than 6 are usable', () => {
    const book = lesson306();
    const keep = new Set(
      book.units
        .filter((unit) => unit.element === 'exercise' && unit.exerciseUsable !== false)
        .slice(0, 5)
        .map((unit) => unit.contentUnitId),
    );
    const small: KafuoBookStructure = {
      ...book,
      units: book.units.filter(
        (unit) =>
          unit.element !== 'exercise' ||
          unit.exerciseUsable === false ||
          keep.has(unit.contentUnitId),
      ),
      exercisePolicy: {
        maxExercises: 10,
        maxExerciseSlides: 3,
        minExercises: 5,
        minExerciseSlides: 1,
      },
    };
    const selection = selectExercises(small)!;
    expect(new Set(selection.unitIds)).toEqual(keep);
    expect(selection.slides.map((slide) => slide.length)).toEqual([3, 2]);
  });

  it('keeps the caps and the minimum slides', () => {
    const book = lesson306();
    const capped = selectExercises({
      ...book,
      exercisePolicy: { maxExercises: 2, maxExerciseSlides: 1 },
    })!;
    expect(capped.slides).toEqual([capped.unitIds]);
    expect(capped.unitIds).toHaveLength(2);
    const tenOnThree = selectExercises({
      ...book,
      exercisePolicy: {
        maxExercises: 10,
        maxExerciseSlides: 3,
        minExercises: 10,
        minExerciseSlides: 2,
      },
    })!;
    expect(tenOnThree.slides.map((slide) => slide.length)).toEqual([4, 3, 3]);
    // Never more slides than exercises.
    const one = selectExercises({
      ...book,
      exercisePolicy: {
        maxExercises: 1,
        maxExerciseSlides: 3,
        minExercises: 1,
        minExerciseSlides: 2,
      },
    })!;
    expect(one.slides).toHaveLength(1);
  });

  it('spreads one 8-question review unit over 2 slides by question range', () => {
    const review: KafuoBookStructureUnit = {
      contentUnitId: '7001',
      kind: 'PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 1,
    };
    const facts: Record<string, BookUnitFacts> = {
      '7001': {
        itemLabels: [],
        hiddenSteps: [],
        questionNumbers: exerciseQuestionNumbers(
          'التقويم\n● الفكرة الرئيسة\n١. سؤال\n2- سؤال\n3) سؤال\n(4) سؤال\n5. سؤال\n6. سؤال\n7. سؤال\n8. سؤال',
        ),
      },
    };
    expect(facts['7001']!.questionNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const book = { units: [review], exercisePolicy: POLICY };
    const selection = selectExercises(book, facts)!;
    expect(selection.unitIds).toEqual(['7001']);
    expect(selection.slides).toEqual([['7001'], ['7001']]);
    expect(selection.slideQuestions).toEqual([{ '7001': [1, 2, 3, 4] }, { '7001': [5, 6, 7, 8] }]);
    // Without the facts (an older checkpoint) the unit weighs one, as before.
    expect(selectExercises(book)).toEqual({ unitIds: ['7001'], slides: [['7001']] });
    // A 10-question unit under an 8 cap solves its first 8 questions.
    const ten = { '7001': { ...facts['7001']!, questionNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } };
    const capped = selectExercises(
      { units: [review], exercisePolicy: { ...POLICY, maxExercises: 8 } },
      ten,
    )!;
    expect(capped.slideQuestions!.flatMap((slide) => slide['7001'] ?? [])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('counts 6–8 exercises across a multi-question unit and single units', () => {
    const units: KafuoBookStructureUnit[] = ['7001', '7002', '7003'].map((id) => ({
      contentUnitId: id,
      kind: 'PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 1,
    }));
    const facts: Record<string, BookUnitFacts> = {
      '7001': { itemLabels: [], hiddenSteps: [], questionNumbers: [1, 2, 3, 4, 5] },
      '7002': { itemLabels: [], hiddenSteps: [], questionNumbers: [6] },
    };
    const selection = selectExercises({ units, exercisePolicy: POLICY }, facts)!;
    const solved = selection.slides.reduce(
      (sum, ids, index) =>
        sum +
        ids.reduce(
          (inner, id) => inner + (selection.slideQuestions?.[index]?.[id]?.length ?? 1),
          0,
        ),
      0,
    );
    expect(solved).toBeGreaterThanOrEqual(6);
    expect(solved).toBeLessThanOrEqual(8);
    expect(solved).toBe(7);
    expect(selection.unitIds).toEqual(['7001', '7002', '7003']);
    expect(selection.slides).toHaveLength(2);
    expect(selection.slides.map((ids) => ids.length)).toEqual([1, 3]);
    expect(selection.slideQuestions).toEqual([{ '7001': [1, 2, 3, 4] }, { '7001': [5] }]);
  });

  it('reads numbered questions by the backend rule', () => {
    expect(exerciseQuestionNumbers('تدرب\nالمثال 2\n● ملخص 3\n١١) سؤال\n12 سؤال')).toEqual([
      11, 12,
    ]);
    expect(exerciseQuestionNumbers('يساوي 1.5 والدرس 1-1')).toEqual([]);
    expect(exerciseQuestionNumbers('')).toEqual([]);
  });

  it('selects nothing without a policy or a usable exercise', () => {
    const book = lesson306();
    const { exercisePolicy: _policy, ...noPolicy } = book;
    expect(selectExercises(noPolicy)).toBeNull();
    const none: KafuoBookStructure = {
      ...book,
      units: book.units.filter(
        (unit) => unit.element !== 'exercise' || unit.exerciseUsable === false,
      ),
    };
    expect(selectExercises(none)).toBeNull();
  });
});
