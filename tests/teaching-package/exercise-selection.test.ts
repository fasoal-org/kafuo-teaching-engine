/**
 * g5.v8 exercises block selected by the engine (owner, 2 Nov 2026): a pure,
 * deterministic pick from the book map and the pinned unit facts.
 */
import { describe, expect, it } from 'vitest';

import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import type { BookUnitFacts } from '@/lib/server/teaching-package/hidden-step-types';
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
