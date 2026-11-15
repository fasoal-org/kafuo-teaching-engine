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
  'as given data. ' +
  // Teacher-guide plan follow-up (16 Nov 2026): item 208's try keyed 51.8 by averaging.
  // D-18 (16 Nov 2026): the method itself is the lesson's; "add the last difference"
  // keyed 24 for 2, 4, 8, 16, so the attempt names no method of its own.
  "The key and the explanation use the lesson's own method; never an average change. " +
  'Never reveal or hint the answer ' +
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
  /**
   * g5.v11 (review finding 9): the attempts this run already dropped (left with no
   * question, pinned on the attempt), so a resumed run never inserts them again.
   */
  skipAttemptIds?: ReadonlySet<string>;
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
// Review LOW-MED-8: only at the start of a line, followed by at least two Arabic words,
// so the options of a multiple-choice check («A) 5 B) 7») are never counted as items.
const BARE_SUB_ITEM =
  /^[^\S\n]*\(?([A-H]|[أبجد])\)[^\S\n]+[^\n]*?[؀-ۿ]{2,}[^\S\n]+[^\n]*?[؀-ۿ]{2,}/gmu;

/** The bare lettered sub-items of a check unit's text, in book order, each once. */
export function bareSubItems(text: string): string[] {
  const letters: string[] = [];
  for (const match of text.matchAll(BARE_SUB_ITEM)) {
    if (!letters.includes(match[1]!)) letters.push(match[1]!);
  }
  return letters;
}

function numberOf(digits: string): number {
  return Number(digits.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d))));
}

function questionNumberOf(line: string): number | null {
  const match = QUESTION_LINE.exec(line);
  return match ? numberOf(match[1]!) : null;
}

/** At most this many characters in one exercise statement (cut with «…»). */
const STATEMENT_MAX_CHARS = 700;

function capStatement(statement: string): string {
  if (statement.length <= STATEMENT_MAX_CHARS) return statement;
  return `${statement.slice(0, STATEMENT_MAX_CHARS - 1).trimEnd()}…`;
}

// Review of f5df1233 (15 Nov 2026), the grouping of an exercise unit's lines:
// - The margin header before a question, beside QUESTION_LINE's «المثال N»: «المثالان 1، 2»,
//   «الأمثلة 1–3» (the backend's `_EXERCISE_HEADER_RE` forms). A header-only line
//   («المثال 3», unit 6253) is dropped.
const MARGIN_PREFIX =
  /^(?:المثالان|المثال|الأمثلة)\s*[0-9٠-٩]{1,2}(?:\s*(?:[,،\-–—]|و|إلى)\s*[0-9٠-٩]{1,2})*(?:\s+|$)/u;
// - A figure-only question: its number alone, with a bracket («(3», «3)», «(٣)»; unit 6247).
//   It is a boundary; with no text after it, it gives no statement.
const BARE_NUMBER_LINE = /^(?:\(\s*([0-9٠-٩]{1,3})\s*\)?|([0-9٠-٩]{1,3})\s*\))$/u;
// - A lettered part of a question («a)», «(a», «(b)», «أ)»; units 6249, 6253): never a task.
const SUB_ITEM_LINE = /^(?:\(\s*([a-hA-H]|[أبجد])\s*\)?|([a-hA-H]|[أبجد])\s*\))(?=\s|$)/u;
// - A task line the next questions share (units 6253, 6258): it never joins the question above.
const TASK_LINE = /[::]\s*$|مما يأتي|فيما يأتي|الآتي/u;
// - A cumulative-review item with its own task (unit 6258 Q52, Q53): it takes no shared
//   task and ends the current one.
const OWN_TASK_TAG = /\(\s*مهارة\s+سابقة\s*\)/u;

/** A lone section title («تأكد», «مهارات التفكير العليا», «✓ تحقق من فهمك»). */
function isTitleLine(line: string): boolean {
  return (
    line.split(/\s+/u).length <= 4 && !/[0-9٠-٩A-Za-z]/u.test(line) && !/[::.؟?!]$/u.test(line)
  );
}

function subItemLetter(line: string): string | null {
  const match = SUB_ITEM_LINE.exec(line);
  return match ? (match[1] ?? match[2]!).toLowerCase() : null;
}

interface QuestionGroup {
  number: number;
  /** The shared task this question takes ('' when none). */
  task: string;
  lines: string[];
  /** False for a bare «(3» until a line joins it. */
  hasText: boolean;
}

/**
 * One group per numbered question, in book order. The lines before the first question,
 * after a section title, or from a task line up to the next question are the shared task
 * of the questions that follow (a section title ends it).
 */
function questionGroups(text: string): QuestionGroup[] {
  const groups: QuestionGroup[] = [];
  let task: string[] = [];
  let readingTask = true;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const body = line.replace(MARGIN_PREFIX, '');
    const number = questionNumberOf(line) ?? questionNumberOf(body);
    const bare = number === null ? BARE_NUMBER_LINE.exec(body) : null;
    if (number !== null || bare) {
      const own = number !== null && OWN_TASK_TAG.test(line);
      if (own) task = [];
      groups.push({
        number: number ?? numberOf(bare![1] ?? bare![2]!),
        task: task.join(' '),
        lines: [line],
        hasText: number !== null,
      });
      readingTask = false;
      continue;
    }
    if (body === '') continue;
    const current = groups[groups.length - 1];
    const joinCurrent = () => {
      if (!current) return;
      current.lines.push(line);
      current.hasText = true;
    };
    if (SUB_ITEM_LINE.test(line)) joinCurrent();
    else if (TASK_LINE.test(line)) {
      if (!readingTask) task = [];
      task.push(line);
      readingTask = true;
    } else if (isTitleLine(line)) {
      task = [];
      readingTask = true;
    } else if (readingTask) task.push(line);
    else joinCurrent();
  }
  return groups;
}

/**
 * A group's own lines. `withoutSacredItems` drops each LINE that holds a verse or hadith,
 * so a question whose numbered line held one leaves its «a) b)» parts under the question
 * above. Those parts never join it:
 * - when the next question skips a number the unit never shows (a removed question), the
 *   lines after the numbered line cannot be told apart, so only that line stays;
 * - a part letter seen twice starts a removed question's parts: the group ends before it.
 */
function ownLines(
  group: QuestionGroup,
  next: QuestionGroup | undefined,
  present: ReadonlySet<number>,
): string[] {
  for (let n = group.number + 1; next && n < next.number; n += 1) {
    if (!present.has(n)) return group.lines.slice(0, 1);
  }
  const seen = new Set<string>();
  for (let index = 1; index < group.lines.length; index += 1) {
    const letter = subItemLetter(group.lines[index]!);
    if (letter === null) continue;
    if (seen.has(letter)) return group.lines.slice(0, index);
    seen.add(letter);
  }
  return group.lines;
}

/** One statement of an exercise attempt, with the book question it asks. */
interface ExerciseStatement {
  unitId: string;
  number: number;
  statement: string;
}

/**
 * The book's own question text of the exercise units a slide solves (no answers): one
 * statement per numbered question, holding its continuation lines up to the next one,
 * after its shared task («<task> — <statement>»).
 */
function exerciseStatementEntries(
  cited: readonly string[],
  context: AttemptQuizContext,
  questions: Record<string, number[]> | undefined,
): ExerciseStatement[] {
  const statements: ExerciseStatement[] = [];
  for (const id of cited) {
    const allowed = questions?.[id];
    // Quality plan follow-up (item 208 Q11, 15 Nov 2026): table rows and «a) b)» lines stay.
    const groups = questionGroups(context.unitTexts?.get(id) ?? '');
    const present = new Set(groups.map((group) => group.number));
    groups.forEach((group, index) => {
      if (!group.hasText || (allowed && !allowed.includes(group.number))) return;
      const statement = ownLines(group, groups[index + 1], present).join(' ');
      statements.push({
        unitId: id,
        number: group.number,
        statement: capStatement(group.task ? `${group.task} — ${statement}` : statement),
      });
    });
  }
  return statements;
}

function exerciseStatements(
  cited: readonly string[],
  context: AttemptQuizContext,
  questions: Record<string, number[]> | undefined,
): string[] {
  return exerciseStatementEntries(cited, context, questions).map((entry) => entry.statement);
}

/**
 * g5.v11 (review finding 6): the book question each question of an exercise slide's
 * attempt asks, in the quiz's order — the same statements {@link insertAttemptQuizzes}
 * lists, within the quiz's question count. Empty when the unit text prints no numbered
 * question (the attempt then asks from the slide's title, and no question can be told).
 */
export function exerciseAttemptQuestions(
  cited: readonly string[],
  context: AttemptQuizContext,
  questions: Record<string, number[]> | undefined,
): Array<{ unitId: string; number: number }> {
  return exerciseStatementEntries(cited, context, questions)
    .slice(0, ATTEMPT_MAX_QUESTIONS)
    .map(({ unitId, number }) => ({ unitId, number }));
}

/** A question line's own number (and «المثال N» margin header) removed. */
function withoutQuestionNumber(line: string): string {
  return line
    .replace(MARGIN_PREFIX, '')
    .replace(/^\s*\(?\s*[0-9٠-٩]{1,3}\s*[).\-]?\s*/u, '')
    .trim();
}

/** A part line's letter removed («a) …», «(b …»). */
function withoutPartLetter(line: string): string {
  return line.replace(/^\s*\(?\s*(?:[a-hA-H]|[أبجد])\s*\)?(?=\s|$)/u, '').trim();
}

/**
 * g5.v11 (review finding 3): the book's own text of ONE numbered exercise question, for
 * the leak guard's "a given is no leak" rule — its shared task and its own lines (for a
 * part «11b», the question's first line and that part's lines), with its number, margin
 * header and part letter removed. Null when the unit prints no such question.
 */
export function exerciseQuestionText(
  text: string,
  number: number,
  letter?: string | null,
): string | null {
  const groups = questionGroups(text);
  const index = groups.findIndex((group) => group.number === number);
  if (index < 0) return null;
  const present = new Set(groups.map((group) => group.number));
  const group = groups[index]!;
  let lines = ownLines(group, groups[index + 1], present);
  const part = letter?.toLowerCase();
  if (part) {
    const start = lines.findIndex((line, at) => at > 0 && subItemLetter(line) === part);
    if (start > 0) {
      const next = lines.findIndex((line, at) => at > start && subItemLetter(line) !== null);
      lines = [lines[0]!, ...lines.slice(start, next < 0 ? lines.length : next)];
    }
  }
  const own = lines.map((line, at) =>
    at === 0 ? withoutQuestionNumber(line) : withoutPartLetter(line),
  );
  return [group.task, ...own].filter((line) => line !== '').join('\n');
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
  for (const id of context.skipAttemptIds ?? []) present.add(id);
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
