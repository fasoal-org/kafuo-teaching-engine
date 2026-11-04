/**
 * The g5.v8 exercises block, picked by the engine (teacher-parity plan I-3,
 * owner decision 2 Nov 2026): the planner ignored the counts, so the engine
 * chooses exactly which exercise units the block solves and on which slide,
 * and the planner is told to cite exactly those.
 *
 * Pure and deterministic: the selection is a function of the book map (its
 * units in book order and its `exercisePolicy`) and the per-unit facts the run
 * pins on the checkpoint (`sourceRefs.bookUnitFacts`). A correction re-check
 * reads the same pinned map and facts, so it sees the same set. A unit without
 * facts (no retained text) is ranked by its kind and book order only.
 */
import type { BookUnitFacts } from '@/lib/server/teaching-package/hidden-step-types';
import type { KafuoBookStructure, KafuoBookStructureUnit } from '@/lib/types/teaching-package';

/** The block's size when enough usable exercises exist. */
export const EXERCISE_TARGET = 8;
/** At most this many exercise units share one slide. */
export const EXERCISES_PER_SLIDE = 4;
/** «تأكد»: the book's guided practice, picked before «تدرب» (`PRACTICE`). */
const GUIDED_PRACTICE_KIND = 'GUIDED_PRACTICE';

export interface ExerciseSelection {
  /** The selected exercise unit ids, in book order. */
  unitIds: string[];
  /**
   * The same ids split into the exercise slides, in book order. A unit holding
   * several numbered questions may sit on more than one slide (3 Nov 2026).
   */
  slides: string[][];
  /**
   * Per slide, the numbered questions each of its multi-question units solves
   * there (unit id → question numbers, in book order). Present only when a
   * selected unit holds two or more numbered questions; a one-question unit is
   * solved whole and never listed.
   */
  slideQuestions?: Array<Record<string, number[]>>;
}

/** One pick: a whole unit, or one numbered question of a multi-question unit. */
interface ExerciseEntry {
  unit: KafuoBookStructureUnit;
  question?: number;
}

/** A usable exercise: an `exercise` unit not marked unusable; instructions_only units are excluded. */
function usable(unit: KafuoBookStructureUnit): boolean {
  return unit.element === 'exercise' && unit.exerciseUsable !== false;
}

/**
 * The exercise units the g5.v8 block solves, or `null` when the map has no
 * `exercisePolicy` or no usable exercise.
 *
 * - N = min(maxExercises, usable questions, 4 × maxExerciseSlides, max(minExercises, 8)),
 *   counted in numbered questions: a unit holding 2+ (`questionNumbers` in its
 *   facts) weighs that many and is picked question by question, so one
 *   8-question unit can fill 2 slides of 4; any other unit weighs one.
 * - Rounds over the examples (`pairedExampleUnitId`, in order of first
 *   appearance) pick one unit per example per round, so every example is
 *   covered when N allows. Within an example: «تأكد» before «تدرب», then a unit
 *   whose hidden-step types are not yet represented, then book order.
 * - S = clamp(ceil(N / 4), minExerciseSlides ?? 1, maxExerciseSlides), at most
 *   N; the selected units are split in book order into S balanced slides.
 */
export function selectExercises(
  book: Pick<KafuoBookStructure, 'units' | 'exercisePolicy'>,
  unitFacts?: Record<string, BookUnitFacts> | null,
): ExerciseSelection | null {
  const policy = book.exercisePolicy;
  if (!policy) return null;
  const order = new Map<string, number>();
  const candidates = book.units.filter((unit, index) => {
    // M-4 (4 Nov 2026 rule): a unit whose every item held a verse or hadith
    // has nothing left to solve, so it is never selected.
    if (!usable(unit) || unitFacts?.[unit.contentUnitId]?.noItemsLeft === true) return false;
    order.set(unit.contentUnitId, index);
    return true;
  });
  if (candidates.length === 0) return null;

  // A unit weighs its numbered questions (the backend counts `minExercises` the
  // same way): one holding 2+ questions is picked question by question, in its
  // own order; any other unit (lesson 306: one question per unit) is one pick.
  const questionsOf = (unit: KafuoBookStructureUnit): number[] => {
    const numbers = unitFacts?.[unit.contentUnitId]?.questionNumbers ?? [];
    return numbers.length >= 2 ? numbers : [];
  };
  const total = candidates.reduce((sum, unit) => sum + Math.max(1, questionsOf(unit).length), 0);
  const count = Math.min(
    policy.maxExercises,
    total,
    EXERCISES_PER_SLIDE * policy.maxExerciseSlides,
    Math.max(policy.minExercises ?? 0, EXERCISE_TARGET),
  );

  // Examples in order of first appearance; a unit without one is its own group.
  const groups = new Map<string, KafuoBookStructureUnit[]>();
  for (const unit of candidates) {
    const key = unit.pairedExampleUnitId ?? `unit:${unit.contentUnitId}`;
    const group = groups.get(key);
    if (group) group.push(unit);
    else groups.set(key, [unit]);
  }
  // A multi-question unit stays at the head of its group until every question
  // is picked, so its picks are always its first questions, in order.
  const remaining = new Map<string, number[]>(
    candidates.map((unit) => [unit.contentUnitId, [...questionsOf(unit)]] as const),
  );

  const steps = (unit: KafuoBookStructureUnit) =>
    unitFacts?.[unit.contentUnitId]?.hiddenSteps ?? [];
  const represented = new Set<string>();
  const picked: ExerciseEntry[] = [];
  const started = new Set<string>();
  const rank = (unit: KafuoBookStructureUnit): [number, number, number] => [
    unit.kind === GUIDED_PRACTICE_KIND ? 0 : 1,
    steps(unit).some((step) => !represented.has(step)) ? 0 : 1,
    order.get(unit.contentUnitId)!,
  ];
  const better = (a: KafuoBookStructureUnit, b: KafuoBookStructureUnit) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let index = 0; index < ra.length; index += 1) {
      if (ra[index] !== rb[index]) return ra[index]! < rb[index]!;
    }
    return false;
  };

  while (picked.length < count) {
    for (const group of groups.values()) {
      if (picked.length >= count) break;
      if (group.length === 0) continue;
      // A unit already begun keeps going before any other of its group.
      let best = group.findIndex((unit) => started.has(unit.contentUnitId));
      if (best < 0) {
        best = 0;
        for (let index = 1; index < group.length; index += 1) {
          if (better(group[index]!, group[best]!)) best = index;
        }
      }
      const unit = group[best]!;
      const questions = remaining.get(unit.contentUnitId)!;
      if (questions.length > 0) {
        picked.push({ unit, question: questions.shift()! });
        started.add(unit.contentUnitId);
        if (questions.length === 0) group.splice(best, 1);
      } else {
        group.splice(best, 1);
        picked.push({ unit });
      }
      steps(unit).forEach((step) => represented.add(step));
    }
  }

  const position = (entry: ExerciseEntry) => order.get(entry.unit.contentUnitId)!;
  picked.sort((a, b) => position(a) - position(b));
  const unitIds = [...new Set(picked.map((entry) => entry.unit.contentUnitId))];
  const slideCount = Math.min(
    picked.length,
    Math.min(
      policy.maxExerciseSlides,
      Math.max(policy.minExerciseSlides ?? 1, Math.ceil(picked.length / EXERCISES_PER_SLIDE)),
    ),
  );
  const slides: string[][] = [];
  const slideQuestions: Array<Record<string, number[]>> = [];
  let start = 0;
  for (let slide = 0; slide < slideCount; slide += 1) {
    const size =
      Math.floor(picked.length / slideCount) + (slide < picked.length % slideCount ? 1 : 0);
    const chunk = picked.slice(start, start + size);
    start += size;
    slides.push([...new Set(chunk.map((entry) => entry.unit.contentUnitId))]);
    const questions: Record<string, number[]> = {};
    for (const entry of chunk) {
      if (entry.question === undefined) continue;
      (questions[entry.unit.contentUnitId] ??= []).push(entry.question);
    }
    slideQuestions.push(questions);
  }
  const multi = picked.some((entry) => entry.question !== undefined);
  return { unitIds, slides, ...(multi ? { slideQuestions } : {}) };
}
