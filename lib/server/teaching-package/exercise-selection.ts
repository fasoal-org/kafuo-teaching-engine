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
  /** The same ids split into the exercise slides, in book order. */
  slides: string[][];
}

/** A usable exercise: an `exercise` unit not marked unusable (incl. instructions_only). */
function usable(unit: KafuoBookStructureUnit): boolean {
  return unit.element === 'exercise' && unit.exerciseUsable !== false;
}

/**
 * The exercise units the g5.v8 block solves, or `null` when the map has no
 * `exercisePolicy` or no usable exercise.
 *
 * - N = min(maxExercises, usable, 4 × maxExerciseSlides, max(minExercises, 8)).
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
    if (!usable(unit)) return false;
    order.set(unit.contentUnitId, index);
    return true;
  });
  if (candidates.length === 0) return null;

  const count = Math.min(
    policy.maxExercises,
    candidates.length,
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

  const steps = (unit: KafuoBookStructureUnit) =>
    unitFacts?.[unit.contentUnitId]?.hiddenSteps ?? [];
  const represented = new Set<string>();
  const picked: KafuoBookStructureUnit[] = [];
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
      let best = 0;
      for (let index = 1; index < group.length; index += 1) {
        if (better(group[index]!, group[best]!)) best = index;
      }
      const [unit] = group.splice(best, 1);
      picked.push(unit!);
      steps(unit!).forEach((step) => represented.add(step));
    }
  }

  const unitIds = picked
    .sort((a, b) => order.get(a.contentUnitId)! - order.get(b.contentUnitId)!)
    .map((unit) => unit.contentUnitId);
  const slideCount = Math.min(
    unitIds.length,
    Math.min(
      policy.maxExerciseSlides,
      Math.max(policy.minExerciseSlides ?? 1, Math.ceil(unitIds.length / EXERCISES_PER_SLIDE)),
    ),
  );
  const slides: string[][] = [];
  let start = 0;
  for (let slide = 0; slide < slideCount; slide += 1) {
    const size =
      Math.floor(unitIds.length / slideCount) + (slide < unitIds.length % slideCount ? 1 : 0);
    slides.push(unitIds.slice(start, start + size));
    start += size;
  }
  return { unitIds, slides };
}
