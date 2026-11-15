/**
 * g5.v10 (learner-first plan W1, owner decisions D-1 A and D-11, 15 Nov 2026): the
 * learner's attempt before every solution, placed by the ENGINE (the planner ignored
 * counts before, so exercises were already engine-picked in g5.v8).
 *
 * After the outline is final (gates and repairs done), a keyed single-choice practice
 * quiz is inserted:
 * - right after each try-it slide (contentRole check_understanding) that cites a book
 *   «تحقق من فهمك» (element=try_it) unit, on the items that slide states;
 * - right before each exercise slide (a solving slide that cites an element=exercise
 *   unit), on that slide's exercises.
 *
 * The quiz sits at the same flow position as its slide (inside the objective). Its
 * outline id is the slide's id plus {@link ATTEMPT_OUTLINE_SUFFIX}, so the insertion is
 * idempotent: a resumed run whose outline already holds an attempt adds nothing. The
 * coverage gates count teaching SLIDES only (`teaches()`), so an attempt never changes a
 * coverage, solution or exercise count. Attempts are practice (TD-7): the backend grades
 * them right/wrong and stores nothing.
 */
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';
import type { BookUnitFacts } from '@/lib/server/teaching-package/hidden-step-types';

/** The attempt quiz of slide `x` has the outline id `x-attempt`. */
export const ATTEMPT_OUTLINE_SUFFIX = '-attempt';
/** At most this many questions in one attempt. */
export const ATTEMPT_MAX_QUESTIONS = 4;

/** An engine-placed attempt quiz (never planned by the model). */
export function isAttemptOutline(outline: Pick<SceneOutline, 'id' | 'type'>): boolean {
  return outline.type === 'quiz' && outline.id.endsWith(ATTEMPT_OUTLINE_SUFFIX);
}

const ATTEMPT_TITLE = 'جرّب بنفسك';

const ATTEMPT_DESCRIPTION =
  'Practice attempt for a weak student, before the solution is shown (never graded for marks). ' +
  'Write ONE single-choice question per item listed in the key points, in clear Arabic, from the ' +
  "item's own givens and wording; four options, exactly one correct, and the wrong options are " +
  'the common mistakes for that item. An item that asks to write a conjecture becomes "which ' +
  'conjecture do the data support?"; a counterexample item becomes "which value (or figure) is a ' +
  'counterexample?"; a data item becomes "what is expected next?". Never reveal or hint the answer ' +
  'in the question, and never mention scores, points or grades.';

type Book = Pick<KafuoBookStructure, 'units'> | undefined;

function unitsOf(book: Book, element: string): Set<string> {
  return new Set(
    (book?.units ?? [])
      .filter((unit) => unit.element === element)
      .map((unit) => String(unit.contentUnitId)),
  );
}

function citesAny(outline: SceneOutline, ids: ReadonlySet<string>): string[] {
  return (outline.sourceContentUnitIds ?? []).map(String).filter((id) => ids.has(id));
}

function questionCount(
  outline: SceneOutline,
  cited: readonly string[],
  facts: Record<string, BookUnitFacts> | null | undefined,
): number {
  const fromFacts = cited.reduce((total, id) => {
    const unit = facts?.[id];
    return total + (unit?.itemLabels.length || unit?.questionNumbers?.length || 0);
  }, 0);
  const count = fromFacts > 0 ? fromFacts : Math.max(outline.keyPoints.length, 1);
  return Math.min(Math.max(count, 1), ATTEMPT_MAX_QUESTIONS);
}

function attemptFor(
  slide: SceneOutline,
  cited: readonly string[],
  facts: Record<string, BookUnitFacts> | null | undefined,
): SceneOutline {
  return {
    id: `${slide.id}${ATTEMPT_OUTLINE_SUFFIX}`,
    type: 'quiz',
    title: ATTEMPT_TITLE,
    description: ATTEMPT_DESCRIPTION,
    keyPoints: [...slide.keyPoints],
    order: slide.order,
    ...(slide.teachingStage ? { teachingStage: slide.teachingStage } : {}),
    sourceContentUnitIds: [...cited],
    quizConfig: {
      questionCount: questionCount(slide, cited, facts),
      difficulty: 'easy',
      questionTypes: ['single'],
    },
  } as SceneOutline;
}

/**
 * The outline with every attempt quiz in place. Returns the SAME array when nothing is
 * inserted (no book map, no check or exercise slide, or every attempt already present).
 */
export function insertAttemptQuizzes(
  outlines: SceneOutline[],
  book: Book,
  facts?: Record<string, BookUnitFacts> | null,
): SceneOutline[] {
  const tryIts = unitsOf(book, 'try_it');
  const exercises = unitsOf(book, 'exercise');
  if (tryIts.size === 0 && exercises.size === 0) return outlines;
  const present = new Set(outlines.map((outline) => outline.id));
  const result: SceneOutline[] = [];
  let inserted = false;
  for (const outline of outlines) {
    const isSlide = outline.type === 'slide';
    const exerciseUnits =
      isSlide && outline.contentRole === 'worked_example' ? citesAny(outline, exercises) : [];
    if (exerciseUnits.length > 0 && !present.has(`${outline.id}${ATTEMPT_OUTLINE_SUFFIX}`)) {
      result.push(attemptFor(outline, exerciseUnits, facts));
      inserted = true;
    }
    result.push(outline);
    const checkUnits =
      isSlide && outline.contentRole === 'check_understanding' ? citesAny(outline, tryIts) : [];
    if (checkUnits.length > 0 && !present.has(`${outline.id}${ATTEMPT_OUTLINE_SUFFIX}`)) {
      result.push(attemptFor(outline, checkUnits, facts));
      inserted = true;
    }
  }
  if (!inserted) return outlines;
  return result.map((outline, index) => ({ ...outline, order: index + 1 }));
}
