/**
 * g5.v10 (learner-first plan W1, owner decisions D-1 A and D-11, 15 Nov 2026): the
 * learner's attempt before every solution, placed by the ENGINE (the planner ignored
 * counts before, so exercises were already engine-picked in g5.v8).
 *
 * After the outline is final (gates and repairs done), a keyed single-choice practice
 * quiz is inserted:
 * - right after each try-it slide (contentRole check_understanding) that cites a book
 *   «تحقق من فهمك» (element=try_it) unit, on the items that slide states (no answers);
 * - right before each exercise slide (a solving slide that cites an element=exercise
 *   unit), on that slide's own exercises, read from the book's question text — never
 *   from the solving slide's key points, which hold the working and the answers.
 *
 * The quiz sits at the same flow position as its slide (inside the objective) and
 * carries the slide's Teaching Skills selection, so a governed package's Submit gate
 * (classification, required Skills, alignment baseline) reads it like its slide. Its
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
  'counterexample?"; a data item becomes "what is expected next?". An item on a fixed named cycle ' +
  '(the Hijri months, the days of the week) lists the whole cycle with its numbers in the question, ' +
  'as given data. Never reveal or hint the answer ' +
  'in the question, and never mention scores, points or grades.';

type Book = Pick<KafuoBookStructure, 'units'> | undefined;

export interface AttemptQuizContext {
  /** The pinned facts of the book's check and exercise units. */
  facts?: Record<string, BookUnitFacts> | null;
  /** The book text of each unit (verses and hadith already removed), by unit id. */
  unitTexts?: ReadonlyMap<string, string>;
  /**
   * The engine's exercises block (`selectExercises`): per exercise slide, in order,
   * the numbered questions of each multi-question unit that slide solves.
   */
  exerciseSlideQuestions?: ReadonlyArray<Record<string, number[]>>;
}

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

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
// A numbered book question at the start of a line: «(1 التكلفة …», «1) …», «(١٢) …».
// Quality plan W4: also after the parse's «المثال N» header on the same line
// («المثال 3 11) إنتاج مصنع…», item 208 unit 6249: Q11 had no try).
const QUESTION_LINE = /^\s*(?:المثال\s*[0-9٠-٩]{1,2}\s+)?\(?\s*([0-9٠-٩]{1,3})\s*[).\-]?\s+\S/u;

// Quality plan W4: a check's lettered sub-items printed bare under one number
// («3) أسعار…» then «A) … B) … C) …», item 208 unit 6241: only 3B got a try).
const BARE_SUB_ITEM = /(?:^|\s)\(?([A-H]|[أبجد])\)\s+\S/gmu;

/** The bare lettered sub-items of a check unit's text, in book order, each once. */
export function bareSubItems(text: string): string[] {
  const letters: string[] = [];
  for (const match of text.matchAll(BARE_SUB_ITEM)) {
    if (!letters.includes(match[1]!)) letters.push(match[1]!);
  }
  return letters;
}

function questionNumberOf(line: string): number | null {
  const match = QUESTION_LINE.exec(line);
  if (!match) return null;
  const digits = match[1]!.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)));
  return Number(digits);
}

/** The book's own question lines of the exercise units a slide solves (no answers). */
function exerciseStatements(
  cited: readonly string[],
  context: AttemptQuizContext,
  questions: Record<string, number[]> | undefined,
): string[] {
  const lines: string[] = [];
  for (const id of cited) {
    const allowed = questions?.[id];
    for (const line of (context.unitTexts?.get(id) ?? '').split('\n')) {
      const number = questionNumberOf(line);
      if (number === null) continue;
      if (allowed && !allowed.includes(number)) continue;
      lines.push(line.trim());
    }
  }
  return lines;
}

function questionCount(itemCount: number): number {
  return Math.min(Math.max(itemCount, 1), ATTEMPT_MAX_QUESTIONS);
}

function attemptFor(
  slide: SceneOutline,
  cited: readonly string[],
  items: readonly string[],
  count: number,
): SceneOutline {
  return {
    id: `${slide.id}${ATTEMPT_OUTLINE_SUFFIX}`,
    type: 'quiz',
    title: ATTEMPT_TITLE,
    description: ATTEMPT_DESCRIPTION,
    keyPoints: [...items],
    order: slide.order,
    ...(slide.teachingStage ? { teachingStage: slide.teachingStage } : {}),
    // The slide's own selection: same position, same objective, same Skills.
    ...(slide.teachingSkills ? { teachingSkills: slide.teachingSkills } : {}),
    sourceContentUnitIds: [...cited],
    quizConfig: {
      questionCount: questionCount(count),
      difficulty: 'easy',
      questionTypes: ['single'],
    },
  } as SceneOutline;
}

function checkAttempt(
  slide: SceneOutline,
  cited: readonly string[],
  context: AttemptQuizContext,
): SceneOutline {
  let bareItems = 0;
  const bareLines: string[] = [];
  const fromFacts = cited.reduce((total, id) => {
    const labels = context.facts?.[id]?.itemLabels.length ?? 0;
    // W4: one numbered check whose items are bare «A) B) C)» counts each item, and
    // the book's own item lines (questions, never answers) join the key points.
    const text = context.unitTexts?.get(id) ?? '';
    const bare = labels <= 1 ? bareSubItems(text) : [];
    if (bare.length >= 2) {
      bareItems += bare.length;
      bareLines.push(...text.split('\n').filter((line) => line.trim() !== ''));
      return total + bare.length;
    }
    return total + labels;
  }, 0);
  // The try-it slide states the items without answers, so its key points are safe.
  const items = bareItems > 0 ? [...slide.keyPoints, ...bareLines] : slide.keyPoints;
  return attemptFor(slide, cited, items, fromFacts > 0 ? fromFacts : slide.keyPoints.length);
}

function exerciseAttempt(
  slide: SceneOutline,
  cited: readonly string[],
  context: AttemptQuizContext,
  questions: Record<string, number[]> | undefined,
): SceneOutline {
  const statements = exerciseStatements(cited, context, questions);
  if (statements.length > 0) return attemptFor(slide, cited, statements, statements.length);
  // No book text: the planner's titles only — never the solving slide's working.
  const fromFacts = cited.reduce(
    (total, id) =>
      total + (questions?.[id]?.length ?? context.facts?.[id]?.questionNumbers?.length ?? 1),
    0,
  );
  return attemptFor(slide, cited, [slide.title], fromFacts);
}

/**
 * The outline with every attempt quiz in place. Returns the SAME array when nothing is
 * inserted (no book map, no check or exercise slide, or every attempt already present).
 */
export function insertAttemptQuizzes(
  outlines: SceneOutline[],
  book: Book,
  context: AttemptQuizContext = {},
): SceneOutline[] {
  const tryIts = unitsOf(book, 'try_it');
  const exercises = unitsOf(book, 'exercise');
  if (tryIts.size === 0 && exercises.size === 0) return outlines;
  const present = new Set(outlines.map((outline) => outline.id));
  const result: SceneOutline[] = [];
  let inserted = false;
  let exerciseSlide = 0;
  for (const outline of outlines) {
    const isSlide = outline.type === 'slide';
    const exerciseUnits =
      isSlide && outline.contentRole === 'worked_example' ? citesAny(outline, exercises) : [];
    if (exerciseUnits.length > 0) {
      const questions = context.exerciseSlideQuestions?.[exerciseSlide];
      exerciseSlide += 1;
      if (!present.has(`${outline.id}${ATTEMPT_OUTLINE_SUFFIX}`)) {
        result.push(exerciseAttempt(outline, exerciseUnits, context, questions));
        inserted = true;
      }
    }
    result.push(outline);
    const checkUnits =
      isSlide && outline.contentRole === 'check_understanding' ? citesAny(outline, tryIts) : [];
    if (checkUnits.length > 0 && !present.has(`${outline.id}${ATTEMPT_OUTLINE_SUFFIX}`)) {
      result.push(checkAttempt(outline, checkUnits, context));
      inserted = true;
    }
  }
  if (!inserted) return outlines;
  return result.map((outline, index) => ({ ...outline, order: index + 1 }));
}
