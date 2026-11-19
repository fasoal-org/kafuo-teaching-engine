/**
 * g5.v11 (teacher-guide answer referee plan §8, owner 16 Nov 2026): the approved
 * teacher-guide answers go in FIRST, then a code check is the safety net.
 *
 * Pure and deterministic. The guide items Kafuo sends (`teacherGuide`) are resolved
 * against OUR book items — a check unit's item labels («1A») and an exercise unit's
 * numbered questions («11», «11b») from the pinned unit facts — never by the guide's
 * own numbering. Only an item whose status is `approved` or `settled` AND that carries
 * an answer is "keyed"; doubtful, changed, reference and missing items are never given.
 *
 * Who gets a keyed answer (plan §8 table, binding):
 * - the solution slide (a worked_example citing the item's unit, and for a check item
 *   only AFTER that check's try-it slide): its key points and a writer instruction; its
 *   narration follows the canvas;
 * - the practice attempt quiz: a hidden key in its description, never in its key points
 *   (the quiz stem is written from those), and cut off before its narration writer
 *   ({@link withoutHiddenAnswerKey});
 * - NEVER the try-it slide (check_understanding), its narration, or the attempt stem.
 *
 * Owner decision (17 Nov 2026): a `reference` item's MODEL ANSWER (a proof, or an open
 * «إجابة ممكنة») is resolved the same way but is never a key: it is listed apart
 * (`modelAnswers`), never in `keyed` or `answer`, never compared, and reaches ONLY the
 * solution slide's writer instruction (description), so its worked proof or solution
 * follows the guide. Never a key point, an attempt, a try-it slide or a check's slide
 * before its try: no code can tell a paraphrased proof, so it goes only after the try.
 * Owner decision (17 Nov 2026, later the same day) reverses "never compared / never an
 * attempt" for ONE purpose: a proof or «إجابة ممكنة» item the lesson solves gets a
 * WRITTEN attempt question (`guide-written-attempts.ts`: the book's own question, never
 * the guide text), graded by the Backend after submission against the model answer read
 * from the package's PINNED snapshot (`quiz-grades` → `gradingContext`). The model answer
 * itself still reaches no attempt, key, stem, explanation or learner payload.
 *
 * Owner decision (17 Nov 2026): a `figure` model answer is the guide's answer DRAWING
 * («مثّل بيانيًا», «ارسم …»). It goes exactly where the other model answers go — the
 * solution slide that solves its question, after the try — as that outline's selected
 * image (`suggestedImageIds` + an `imagePlans` note, id `src-guide-<n>`), beside the writer
 * note. Only a drawing the run fetched, verified and stored is listed
 * (`attachedFigureIds`); any other figure is as if never sent.
 */
import {
  ATTEMPT_OUTLINE_SUFFIX,
  bareSubItems,
  exerciseAttemptQuestions,
  exerciseQuestionText,
  isAttemptOutline,
} from '@/lib/server/teaching-package/attempt-quizzes';
import {
  WHOLE_UNIT_GUIDE_KEY,
  type ExerciseGuideMark,
  type ExerciseGuideStatuses,
} from '@/lib/server/teaching-package/exercise-selection';
import {
  normalizeBookText,
  trailingItemNumbers,
  type BookUnitFacts,
} from '@/lib/server/teaching-package/hidden-step-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { ImagePlan } from '@openmaic/generation';
import type {
  KafuoBookStructure,
  KafuoTeacherGuide,
  KafuoTeacherGuideAnswer,
  KafuoTeacherGuideItem,
  KafuoTeacherGuideModelAnswer,
} from '@/lib/types/teaching-package';

/** A guide item resolved to one of OUR book items. */
export interface ResolvedGuideItem {
  contentUnitId: string;
  /** The label as Kafuo sent it. */
  label: string;
  element: 'try_it' | 'exercise';
  /** The item's question number, or null for an exercise unit solved whole. */
  number: number | null;
  /** The item's part letter (A–H), or null. */
  letter: string | null;
  /** How the item is named to the writers: «1A» (a check), «س11» or «س11b» (an exercise). */
  display: string;
}

/** A resolved item whose approved or settled answer is given to the writers. */
export interface KeyedGuideItem extends ResolvedGuideItem {
  answer: KafuoTeacherGuideAnswer;
}

/** A resolved `reference` item carrying the guide's model answer (owner, 17 Nov 2026). */
export interface ModelAnswerGuideItem extends ResolvedGuideItem {
  modelAnswer: KafuoTeacherGuideModelAnswer;
  /** A `figure` only: the stored drawing's image id (`src-guide-<n>`). Never on another kind. */
  figureImageId?: string;
}

/**
 * The image id of the drawing of the guide's item at `itemIndex` (0-based, in the order
 * Kafuo sent the items): TE-minted and stable for one guide, so a resumed run and a
 * regeneration name the same drawing. It keeps the source-visual `src-` prefix, the one
 * the slide generator resolves onto a stored image's serving path.
 */
export function guideFigureImageId(itemIndex: number): string {
  return `src-guide-${itemIndex + 1}`;
}

/** An image id the engine minted for a guide answer drawing. */
export function isGuideFigureImageId(id: unknown): boolean {
  return typeof id === 'string' && /^src-guide-\d+$/.test(id);
}

export interface ResolvedTeacherGuide {
  guideId: string;
  /** Keyed items in book order (book unit order, then item order). */
  keyed: KeyedGuideItem[];
  /** Reference items with a model answer, in book order. Never keys, never compared. */
  modelAnswers: ModelAnswerGuideItem[];
  /** The exercise selection marks (`selectExercises`). */
  exerciseStatuses: ExerciseGuideStatuses;
  /** Items that match no item of our book: they get no answer and are logged. */
  unresolved: Array<{ contentUnitId: string; label: string; reason: string }>;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_INDIC = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_LETTER: Readonly<Record<string, string>> = { أ: 'A', ا: 'A', ب: 'B', ج: 'C', د: 'D' };

function westernDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_INDIC.indexOf(digit)));
}

/**
 * OUR item label as Kafuo sends it: «1A», «ex 11b», «س١١», «11», «3 B». A leading
 * «ex», «س» or «تمرين» is ignored; Arabic part letters map to A–D.
 */
export function parseGuideLabel(label: string): { number: number | null; letter: string | null } {
  const text = westernDigits(label)
    .trim()
    .replace(/^(?:ex(?:ercise)?\.?|س|سؤال|تمرين)\s*/iu, '');
  const match = /^\(?\s*(\d{1,3})\s*\)?\s*\(?\s*([A-Ha-h]|[أابجد])?\s*\)?$/u.exec(text);
  if (!match) return { number: null, letter: null };
  const raw = match[2];
  const letter = raw ? (ARABIC_LETTER[raw] ?? raw.toUpperCase()) : null;
  return { number: Number(match[1]), letter };
}

const KEYED_STATUSES: ReadonlySet<string> = new Set(['approved', 'settled']);

/** An item whose answer the writers get: approved or settled, with an answer. */
export function isKeyedGuideItem(
  item: KafuoTeacherGuideItem,
): item is KafuoTeacherGuideItem & { answer: KafuoTeacherGuideAnswer } {
  return KEYED_STATUSES.has(item.status) && item.answer !== undefined;
}

/** A reference item carrying its model answer (owner, 17 Nov 2026): never keyed. */
export function hasGuideModelAnswer(
  item: KafuoTeacherGuideItem,
): item is KafuoTeacherGuideItem & { modelAnswer: KafuoTeacherGuideModelAnswer } {
  return item.status === 'reference' && item.modelAnswer !== undefined;
}

/** A doubtful or changed item, or a settled one without an answer (a person excluded it). */
function isHeld(item: KafuoTeacherGuideItem): boolean {
  return (
    item.status === 'doubtful' ||
    item.status === 'changed' ||
    (item.status === 'settled' && item.answer === undefined)
  );
}

function itemKey(number: number, letter: string | null): string {
  return `${number}${letter ?? ''}`;
}

/**
 * Resolve the guide against the book map and the pinned unit facts. An item on a unit
 * that is not a check or an exercise, or whose label is not one of that unit's items,
 * is unresolved: it gets no answer (today's behaviour) and is reported. A `figure` model
 * answer is listed only when its drawing is in `attachedFigureIds` (owner, 17 Nov 2026:
 * fetched, verified and stored by the run); without the option no figure is listed.
 */
export function resolveTeacherGuide(
  guide: KafuoTeacherGuide,
  book: Pick<KafuoBookStructure, 'units'>,
  facts: Readonly<Record<string, BookUnitFacts>> | null | undefined,
  options: { attachedFigureIds?: ReadonlySet<string> } = {},
): ResolvedTeacherGuide {
  const units = new Map(book.units.map((unit, index) => [unit.contentUnitId, { unit, index }]));
  const resolved: Array<{
    item: ResolvedGuideItem;
    source: KafuoTeacherGuideItem;
    rank: number;
    /** The item's position in the guide as sent (its drawing's id). */
    at: number;
  }> = [];
  const unresolved: ResolvedTeacherGuide['unresolved'] = [];
  const perUnitCount = new Map<string, number>();
  for (const source of guide.items) {
    perUnitCount.set(source.contentUnitId, (perUnitCount.get(source.contentUnitId) ?? 0) + 1);
  }
  for (const [at, source] of guide.items.entries()) {
    const reject = (reason: string) =>
      unresolved.push({ contentUnitId: source.contentUnitId, label: source.label, reason });
    const entry = units.get(source.contentUnitId);
    const element = entry?.unit.element;
    if (!entry || (element !== 'try_it' && element !== 'exercise')) {
      // Lesson 2-5 (17 Nov 2026): the reason says what the book map did with the unit
      // («not a check or exercise unit of this lesson» was logged for the lesson's own
      // «تأكد» and practice units, which the map had left untyped).
      const kind = entry?.unit.kind ?? 'unit';
      reject(
        !entry
          ? 'the unit is not in this lesson’s book map'
          : element === 'ignore'
            ? `the book map leaves this ${kind} out of the lesson (element ignore)`
            : element === null || element === undefined
              ? `the book map gives this ${kind} no element`
              : `a ${element} unit, not a check or exercise`,
      );
      continue;
    }
    const unitFacts = facts?.[source.contentUnitId];
    if (!unitFacts) {
      reject('the unit has no retained text');
      continue;
    }
    const { number, letter } = parseGuideLabel(source.label);
    if (element === 'try_it') {
      const labels = unitFacts.itemLabels;
      // A check whose text labels no item holds one item: its only guide item is it.
      const single = labels.length === 0 && perUnitCount.get(source.contentUnitId) === 1;
      let position = -1;
      if (number !== null) {
        position = labels.indexOf(itemKey(number, letter));
        if (position < 0 && letter === null) position = labels.indexOf(String(number));
      }
      if (position < 0 && !single) {
        reject('the label is not one of the check items');
        continue;
      }
      resolved.push({
        source,
        at,
        rank: entry.index * 10_000 + Math.max(position, 0),
        item: {
          contentUnitId: source.contentUnitId,
          label: source.label,
          element,
          number,
          letter,
          display: number !== null ? itemKey(number, letter) : source.label,
        },
      });
      continue;
    }
    const questions = unitFacts.questionNumbers ?? [];
    const multi = questions.length >= 2;
    if (multi && (number === null || !questions.includes(number))) {
      reject('the label is not one of the exercise questions');
      continue;
    }
    if (!multi && number !== null && questions.length === 1 && questions[0] !== number) {
      reject('the label is not the exercise question');
      continue;
    }
    const questionNumber = multi ? number : null;
    resolved.push({
      source,
      at,
      rank:
        entry.index * 10_000 +
        (questionNumber ?? 0) * 10 +
        (letter ? letter.charCodeAt(0) - 64 : 0),
      item: {
        contentUnitId: source.contentUnitId,
        label: source.label,
        element,
        number: questionNumber,
        letter,
        display: number !== null ? `س${number}${letter ? letter.toLowerCase() : ''}` : source.label,
      },
    });
  }
  resolved.sort((a, b) => a.rank - b.rank);

  const statuses: Record<string, Record<string, ExerciseGuideMark>> = {};
  for (const { item, source } of resolved) {
    if (item.element !== 'exercise') continue;
    const mark: ExerciseGuideMark | null = isHeld(source)
      ? 'held'
      : isKeyedGuideItem(source)
        ? 'keyed'
        : null;
    if (!mark) continue;
    const key = item.number !== null ? String(item.number) : WHOLE_UNIT_GUIDE_KEY;
    const marks = (statuses[item.contentUnitId] ??= {});
    // One held part holds the whole question: its try would ask that part too.
    if (marks[key] !== 'held') marks[key] = mark;
  }
  return {
    guideId: guide.guideId,
    keyed: resolved.flatMap(({ item, source }) =>
      isKeyedGuideItem(source) ? [{ ...item, answer: source.answer }] : [],
    ),
    modelAnswers: resolved.flatMap(({ item, source, at }): ModelAnswerGuideItem[] => {
      if (!hasGuideModelAnswer(source)) return [];
      if (source.modelAnswer.kind !== 'figure')
        return [{ ...item, modelAnswer: source.modelAnswer }];
      // A drawing the run did not store is as if never sent (fail-soft).
      const figureImageId = guideFigureImageId(at);
      return options.attachedFigureIds?.has(figureImageId)
        ? [{ ...item, modelAnswer: source.modelAnswer, figureImageId }]
        : [];
    }),
    exerciseStatuses: statuses,
    unresolved,
  };
}

/** One item's key across the plans and the pinned settlements. */
export function guideItemKey(item: Pick<ResolvedGuideItem, 'contentUnitId' | 'label'>): string {
  return `${item.contentUnitId}|${item.label}`;
}

// ── An item's own question text (review finding 3) ───────────────────────────────────

/** A check label touching a parenthesis: «1A)», «(2A», «4B)» (`checkItemLabels`). */
const CHECK_LABEL =
  /(?:\(\s*(\d{1,2})\s?([A-H]|[ابجد])(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(\d{1,2})\s?([A-H]|[ابجد])\s*\))/gu;
/** A check item numbered at a line's start: «1.», «1-», «1)», «(1)», «.1 » (`checkItemLabels`). */
const NUMBERED_CHECK =
  /^[^\S\n]*(?:\.(\d{1,2})(?=\s)|\(\s*(\d{1,2})\s*\)|(\d{1,2})[^\S\n]*(?:[.\-–](?=\s)|\)))/gmu;
/** A margin header and a question number at a line's start («المثال 3 11)», «(1 »). */
const LINE_QUESTION_NUMBER =
  /^[^\S\n]*(?:(?:المثالان|المثال|الامثله)[^\S\n]*\d{1,3}(?:[^\S\n]*(?:[,،\-–]|و|الي)[^\S\n]*\d{1,3})*[^\S\n]*)?\(?[^\S\n]*\d{1,3}[^\S\n]*[).\-–]?(?=[^\S\n]|$)/gmu;
const BOOK_LETTER: Readonly<Record<string, string>> = { ا: 'A', ب: 'B', ج: 'C', د: 'D' };

interface LabelMark {
  key: string;
  start: number;
  end: number;
}

/** A check item's own text: from its label to the next item's label, the label out. */
function checkItemText(text: string, number: number, letter: string | null): string | null {
  const normalized = normalizeBookText(text, false);
  const bounds = checkItemBounds(normalized, number, letter);
  return bounds ? normalized.slice(bounds.start, bounds.end).trim() : null;
}

/** The marks `normalizeBookText` deletes (tashkeel, superscript alef, tatweel). */
const BOOK_MARK = /[ً-ٰٟـ]/u;

/**
 * `normalizeBookText(text, false)` with, for each normalized character, the index of the
 * raw character it came from — so a span found on the normalized text is cut from the
 * RAW text (owner, 17 Nov 2026: a learner never reads the folded «ه»/«ي»/«ا» forms).
 */
function normalizedWithOffsets(text: string): { normalized: string; offsets: number[] } {
  let normalized = '';
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (BOOK_MARK.test(char)) continue;
    normalized += normalizeBookText(char, false);
    offsets.push(index);
  }
  return { normalized, offsets };
}

/** A check item's own text as the BOOK prints it (diacritics and letters kept). */
function checkItemRawText(text: string, number: number, letter: string | null): string | null {
  const { normalized, offsets } = normalizedWithOffsets(text);
  const bounds = checkItemBounds(normalized, number, letter);
  if (!bounds) return null;
  const rawStart = bounds.start < offsets.length ? offsets[bounds.start]! : text.length;
  const rawEnd = bounds.end < offsets.length ? offsets[bounds.end]! : text.length;
  return text.slice(rawStart, rawEnd).trim();
}

/** The span of a check item's own text on the normalized unit text (its label out). */
function checkItemBounds(
  normalized: string,
  number: number,
  letter: string | null,
): { start: number; end: number } | null {
  let marks: LabelMark[] = [...normalized.matchAll(CHECK_LABEL)].map((match) => {
    const raw = match[2] ?? match[4]!;
    return {
      key: `${Number(match[1] ?? match[3])}${BOOK_LETTER[raw] ?? raw}`,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    };
  });
  if (marks.length === 0) {
    marks = [...normalized.matchAll(NUMBERED_CHECK)].map((match) => ({
      key: String(Number(match[1] ?? match[2] ?? match[3])),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }));
  }
  const wanted = [itemKey(number, letter), ...(letter === null ? [] : [String(number)])];
  const at = marks.findIndex((mark) => mark.key === wanted[0]);
  const found = at >= 0 ? at : marks.findIndex((mark) => wanted.includes(mark.key));
  if (found < 0) return null;
  const next = marks.find((mark, index) => index > found && mark.key !== marks[found]!.key);
  return { start: marks[found]!.end, end: next ? next.start : normalized.length };
}

/** A unit's text with every item label and question number taken out. */
function withoutItemLabels(text: string): string {
  const normalized = normalizeBookText(text, false).replace(CHECK_LABEL, ' ');
  // The OCR form «value (N» prints values at a line's start: only its «(N» are numbers.
  return trailingItemNumbers(normalized).length > 0
    ? normalized.replace(/\((\d{1,3})(?=\s|\)|$)/gu, ' ')
    : normalized.replace(LINE_QUESTION_NUMBER, ' ');
}

/**
 * Review finding 3: the text of the item's OWN book question, for the leak guard's "a
 * given is no leak" rule — never the whole unit, so another item's givens and the
 * question numbers never hide a leak. An exercise question is read with the attempt's
 * grouping (`exerciseQuestionText`); a check item from its label to the next one. Its
 * number, margin header and label are removed. When the unit does not print the item,
 * the unit's text with every label and question number removed.
 */
export function guideItemQuestionText(
  text: string,
  item: Pick<ResolvedGuideItem, 'element' | 'number' | 'letter'>,
): string {
  if (item.number !== null) {
    // Lesson 2-5: a question sharing its book line («(13 … (14 …») is its own.
    const own =
      item.element === 'exercise'
        ? exerciseQuestionText(text, item.number, item.letter, true)
        : checkItemText(text, item.number, item.letter);
    if (own !== null) return own;
  }
  return withoutItemLabels(text);
}

/**
 * Owner decision (17 Nov 2026): the item's OWN book question as the book prints it, for
 * the learner's written attempt — never normalized, never the guide's text. An exercise
 * question is read like `guideItemQuestionText`; a check item is cut from the raw text at
 * the same span; an item with no number (a one-item check, an exercise unit solved
 * whole) is its unit's whole text. Null when the unit does not print the item.
 */
export function guideItemOwnText(
  text: string,
  item: Pick<ResolvedGuideItem, 'element' | 'number' | 'letter'>,
): string | null {
  const own =
    item.number === null
      ? text
      : item.element === 'exercise'
        ? exerciseQuestionText(text, item.number, item.letter, true)
        : checkItemRawText(text, item.number, item.letter);
  const trimmed = own?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

// ── The writers' text ─────────────────────────────────────────────────────────────────

/** A guide answer as the writers read it (Western digits; the lesson's digits come later). */
export function formatGuideAnswer(answer: KafuoTeacherGuideAnswer): string {
  const unit = answer.unit ? ` ${answer.unit}` : '';
  switch (answer.type) {
    case 'number':
      return `${answer.approximate ? 'تقريبًا ' : ''}${answer.value}${unit}`;
    case 'bool':
      return `${answer.value ? 'صحيحة' : 'خاطئة'}${unit}`;
    case 'choice':
    case 'text':
      return `${answer.value}${unit}`;
  }
}

/** The key point a solution slide gets per keyed item (plan §8: «الإجابة الصحيحة المعتمدة»). */
export const SOLUTION_KEY_POINT_PREFIX = 'الإجابة الصحيحة المعتمدة';

export function solutionKeyPoint(item: KeyedGuideItem): string {
  return `${SOLUTION_KEY_POINT_PREFIX} (${item.display}): ${formatGuideAnswer(item.answer)}`;
}

/** The marker of the writer instruction, so the injection is idempotent. */
const SOLUTION_NOTE_MARKER = 'APPROVED FINAL ANSWERS (g5.v11)';
const ATTEMPT_KEY_MARKER = 'HIDDEN ANSWER KEY (g5.v11)';

/** The final line each solved item ends with on the canvas; the comparator reads it. */
export function finalAnswerLine(item: KeyedGuideItem): string {
  return `الإجابة (${item.display}): ${formatGuideAnswer(item.answer)}`;
}

function solutionNote(items: readonly KeyedGuideItem[]): string {
  return [
    `${SOLUTION_NOTE_MARKER}: the key points marked «${SOLUTION_KEY_POINT_PREFIX}» are the checked`,
    "correct final answers. For each item, write the lesson's own working, step by step with",
    "the book's method, that reaches exactly that answer; never bend a step to reach it.",
    'End each item on the canvas with exactly this final line:',
    ...items.map((item) => `- ${finalAnswerLine(item)}`),
    'Never write «المعتمدة», «دليل المعلم» or «الدليل» on the canvas or in the narration.',
  ].join('\n');
}

/** The marker of the model-answer instruction (owner, 17 Nov 2026). */
const MODEL_ANSWER_MARKER = 'GUIDE MODEL ANSWERS (g5.v11)';

const MODEL_ANSWER_KIND: Readonly<Record<KafuoTeacherGuideModelAnswer['kind'], string>> = {
  proof: 'proof',
  possible: 'one possible answer; other correct answers exist',
  figure: 'a drawing',
};

/** The writer's rule for the attached answer drawings (owner, 17 Nov 2026). */
const FIGURE_RULE = [
  "Each attached drawing is the guide's drawing of that item's correct answer: show it on the",
  "canvas (by its image id) beside that item's solution, after the working, and keep every value,",
  'point and label you write in line with it; never draw a different answer.',
].join('\n');

/**
 * The solution writer's model answers. Each line of a text is indented, so no text can
 * start a block of its own (`plannedDescription` cuts at a marker after a blank line). A
 * drawing is named by its image id (the outline selects it), with its note when sent.
 */
function modelAnswerNote(items: readonly ModelAnswerGuideItem[]): string {
  const text = (item: ModelAnswerGuideItem): string[] => {
    const sent = (item.modelAnswer.text ?? '').trim();
    return sent === '' ? [] : sent.split(/\r?\n/u).map((line) => `  ${line.trim()}`);
  };
  return [
    `${MODEL_ANSWER_MARKER}: the checked model answer of each item below that this slide solves`,
    '(a proof, or one possible answer of an open question). Write its proof or solution in line',
    "with it: the same givens, claims, reasons and conclusion, step by step, in the lesson's own",
    "words and notation and with the book's method. It is a reference, not text to copy: never",
    'copy a line addressed to the teacher. Present a possible answer as one correct answer, never',
    'as the only one.',
    ...items.flatMap((item) => {
      const lines = text(item);
      return [
        item.figureImageId !== undefined
          ? `- item ${item.display} (${MODEL_ANSWER_KIND.figure}: image ${item.figureImageId}, attached to this slide; رسمة الإجابة في دليل المعلم مرفقة)${lines.length > 0 ? ':' : ''}`
          : `- item ${item.display} (${MODEL_ANSWER_KIND[item.modelAnswer.kind]}):`,
        ...lines,
      ];
    }),
    ...(items.some((item) => item.figureImageId !== undefined) ? [FIGURE_RULE] : []),
    'Never write «دليل المعلم» or «الدليل» on the canvas or in the narration.',
  ].join('\n');
}

/** The image note of an attached drawing (`imagePlans`: what narration knows of it). */
function figureImagePlan(item: ModelAnswerGuideItem & { figureImageId: string }): ImagePlan {
  return {
    imageId: item.figureImageId,
    shows: `the finished drawing that answers item ${item.display} (its graph or figure)`,
    teachingPoint: `how this drawing answers item ${item.display}, after the item's working`,
  };
}

function attemptKey(items: readonly KeyedGuideItem[]): string {
  return [
    `${ATTEMPT_KEY_MARKER}: these are the checked correct answers of the items below, for the`,
    'answer key and the explanation ONLY. For each item, the correct option is exactly this',
    'answer and it is one of the options; the wrong options are common mistakes. Never write',
    'the answer, or any hint of it, in the question text.',
    ...items.map(
      (item) =>
        `- item ${item.display}: ${formatGuideAnswer(item.answer)}${
          item.answer.type === 'choice'
            ? " (keep the book's options in the book's order, so this letter is the correct one)"
            : ''
        }`,
    ),
  ].join('\n');
}

// ── Which outline gets which item ─────────────────────────────────────────────────────

export type GuideOutlineRole = 'solution' | 'attempt' | 'try';

/**
 * What one outline does with the keyed items of its units. D-19 (16 Nov 2026): no slide
 * ever leaves the lesson for a checked answer; only an attempt left with no question.
 */
export interface GuideOutlinePlan {
  role: GuideOutlineRole;
  items: KeyedGuideItem[];
  /**
   * Re-review finding 1: a solution slide's check items whose try-it slide comes LATER
   * in the lesson, or that no try-it slide states. They get no answer here and are
   * leak-checked, as on a try-it slide.
   */
  beforeTry?: KeyedGuideItem[];
  /**
   * Solutions: how many book questions the slide solves, keyed or not. An exercise item
   * leaves the slide only while another question stays on it.
   */
  solves?: number;
  /**
   * Attempts (review finding 6): the 0-based question that asks each item
   * ({@link guideItemKey}), or null when it cannot be told.
   */
  questionOf?: Readonly<Record<string, number | null>>;
  /** Attempts: the question count the quiz was planned with. */
  questionCount?: number;
  /**
   * Solutions only (owner, 17 Nov 2026): the model answers of the items the slide solves
   * after their try, for its writer. Never keys: the comparator never reads them.
   */
  modelAnswers?: ModelAnswerGuideItem[];
}

function citedUnits(outline: SceneOutline, element: 'try_it' | 'exercise', book: BookUnits) {
  return (outline.sourceContentUnitIds ?? []).map(String).filter((id) => book.get(id) === element);
}

type BookUnits = ReadonlyMap<string, string | null>;

/**
 * The plan of every outline that holds a keyed item, by outline id. `slideQuestions` is
 * the engine's exercises block (`selectExercises`), per exercise slide in order.
 */
export function guideOutlinePlans(
  outlines: readonly SceneOutline[],
  book: Pick<KafuoBookStructure, 'units'>,
  guide: ResolvedTeacherGuide,
  options: {
    slideQuestions?: ReadonlyArray<Readonly<Record<string, number[]>>>;
    facts?: Readonly<Record<string, BookUnitFacts>> | null;
    /**
     * The book text of each unit, as `insertAttemptQuizzes` read it: an attempt's
     * questions are then told apart (review finding 6). Absent → no question is told.
     */
    unitTexts?: ReadonlyMap<string, string>;
  } = {},
): Map<string, GuideOutlinePlan> {
  const elements: BookUnits = new Map(
    book.units.map((unit) => [unit.contentUnitId, unit.element] as const),
  );
  const keyedOf = (unitId: string) => guide.keyed.filter((item) => item.contentUnitId === unitId);
  const modelAnswersOf = (unitId: string) =>
    guide.modelAnswers.filter((item) => item.contentUnitId === unitId);
  const plans = new Map<string, GuideOutlinePlan>();
  const checkLabels = (unitId: string) => options.facts?.[unitId]?.itemLabels ?? [];

  // Re-review finding 1: where each check is first tried. A worked example solves a
  // check's items only after that try-it slide; before it (the order gate skips a check
  // with no paired example, and an editor may ignore `solution_before_try_it`), or with
  // no try at all, the slide comes before the learner's try: it gets no answer and is
  // leak-checked.
  const firstTry = new Map<string, number>();
  outlines.forEach((outline, index) => {
    if (outline.type !== 'slide' || outline.contentRole !== 'check_understanding') return;
    for (const unitId of citedUnits(outline, 'try_it', elements)) {
      if (!firstTry.has(unitId)) firstTry.set(unitId, index);
    }
  });

  // The items each slide solves, and (exercise slides) in which order they are asked.
  const asked = new Map<
    string,
    Array<{ unitId: string; number: number | null; letter?: string }>
  >();
  const slideQuestionsOf = new Map<string, Readonly<Record<string, number[]>> | undefined>();
  let exerciseSlide = 0;
  for (const [index, outline] of outlines.entries()) {
    if (outline.type !== 'slide') continue;
    const exercises = citedUnits(outline, 'exercise', elements);
    const checks = citedUnits(outline, 'try_it', elements);
    if (outline.contentRole === 'worked_example' && (exercises.length > 0 || checks.length > 0)) {
      const questions = exercises.length > 0 ? options.slideQuestions?.[exerciseSlide] : undefined;
      if (exercises.length > 0) exerciseSlide += 1;
      slideQuestionsOf.set(outline.id, questions);
      const tried = checks.filter((unitId) => (firstTry.get(unitId) ?? Infinity) < index);
      const beforeTry = checks.filter((unitId) => !tried.includes(unitId)).flatMap(keyedOf);
      const onSlide = (unitId: string) => (item: ResolvedGuideItem) => {
        const listed = questions?.[unitId];
        return !listed || (item.number !== null && listed.includes(item.number));
      };
      const items = [
        ...tried.flatMap(keyedOf),
        ...exercises.flatMap((unitId) => keyedOf(unitId).filter(onSlide(unitId))),
      ];
      // Owner, 17 Nov 2026: the model answers of the same items (a check's only after
      // its try; an exercise's only on the slide that solves that question).
      const modelAnswers = [
        ...tried.flatMap(modelAnswersOf),
        ...exercises.flatMap((unitId) => modelAnswersOf(unitId).filter(onSlide(unitId))),
      ];
      const order = exercises.flatMap(
        (unitId): Array<{ unitId: string; number: number | null }> => {
          const listed = questions?.[unitId];
          const numbers = listed ?? options.facts?.[unitId]?.questionNumbers ?? [];
          return numbers.length >= 2 || listed
            ? [...numbers].sort((a, b) => a - b).map((number) => ({ unitId, number }))
            : [{ unitId, number: null }];
        },
      );
      asked.set(outline.id, order);
      // A slide with no keyed item stays exactly as before when it guards a check before
      // its try (a try-side plan: its model answers are dropped, never a role change).
      if (items.length === 0 && (modelAnswers.length === 0 || beforeTry.length > 0)) {
        if (beforeTry.length > 0) plans.set(outline.id, { role: 'try', items: beforeTry });
        continue;
      }
      const checkItems = tried.reduce(
        (total, unitId) => total + Math.max(1, checkLabels(unitId).length),
        0,
      );
      plans.set(outline.id, {
        role: 'solution',
        items,
        solves: order.length + checkItems,
        ...(beforeTry.length > 0 ? { beforeTry } : {}),
        ...(modelAnswers.length > 0 ? { modelAnswers } : {}),
      });
      continue;
    }
    if (outline.contentRole === 'check_understanding' && checks.length > 0) {
      const items = checks.flatMap(keyedOf);
      if (items.length > 0) plans.set(outline.id, { role: 'try', items });
    }
  }

  // Attempts: the items their questions ask, within the quiz's question count, and the
  // question that asks each one when it can be told (review finding 6).
  for (const outline of outlines) {
    if (!isAttemptOutline(outline)) continue;
    const baseId = outline.id.slice(0, -ATTEMPT_OUTLINE_SUFFIX.length);
    const base = outlines.find((candidate) => candidate.id === baseId);
    if (!base) continue;
    const count = outline.quizConfig?.questionCount ?? Number.POSITIVE_INFINITY;
    const asks: Array<{ item: KeyedGuideItem; question: number | null }> = [];
    if (base.contentRole === 'check_understanding') {
      // A check's items in book order: its labels, unit by unit. A question is told only
      // when every cited unit labels its items and none prints bare «A) B)» lines (the
      // attempt then counts those instead).
      const cited = citedUnits(base, 'try_it', elements);
      const told = cited.every((unitId) => {
        const labels = checkLabels(unitId);
        const text = options.unitTexts?.get(unitId);
        return (
          options.unitTexts !== undefined &&
          labels.length > 0 &&
          !(labels.length <= 1 && bareSubItems(text ?? '').length >= 2)
        );
      });
      const order = cited.flatMap((unitId) => {
        const labels = checkLabels(unitId);
        return labels.length > 0
          ? labels.map((label) => ({ unitId, label }))
          : [{ unitId, label: '' }];
      });
      order.slice(0, count).forEach(({ unitId, label }, question) => {
        for (const item of keyedOf(unitId)) {
          const matches =
            label === '' ||
            (item.number !== null &&
              (itemKey(item.number, item.letter) === label || String(item.number) === label));
          if (matches) asks.push({ item, question: told ? question : null });
        }
      });
    } else {
      const basePlan = plans.get(baseId);
      const solutionItems = basePlan?.role === 'solution' ? basePlan.items : [];
      const exercises = citedUnits(base, 'exercise', elements);
      const statements = options.unitTexts
        ? exerciseAttemptQuestions(
            exercises,
            // Lesson 2-5: the attempt's statements as the g5.v11 run split them.
            { unitTexts: options.unitTexts, facts: options.facts ?? null, inlineQuestions: true },
            slideQuestionsOf.get(baseId) as Record<string, number[]> | undefined,
          ).slice(0, count)
        : [];
      if (statements.length > 0) {
        for (const item of solutionItems) {
          const questions = statements.flatMap((statement, index) =>
            statement.unitId === item.contentUnitId &&
            (item.number === null || statement.number === item.number)
              ? [index]
              : [],
          );
          if (questions.length > 0) {
            asks.push({ item, question: questions.length === 1 ? questions[0]! : null });
          }
        }
      } else {
        const order = (asked.get(baseId) ?? []).slice(0, count);
        for (const item of solutionItems) {
          const listed = order.some(
            (entry) =>
              entry.unitId === item.contentUnitId &&
              (entry.number === null || entry.number === item.number),
          );
          if (listed) asks.push({ item, question: null });
        }
      }
    }
    const unique = new Map<string, { item: KeyedGuideItem; question: number | null }>();
    for (const entry of asks) {
      if (!unique.has(guideItemKey(entry.item))) unique.set(guideItemKey(entry.item), entry);
    }
    if (unique.size === 0) continue;
    plans.set(outline.id, {
      role: 'attempt',
      items: [...unique.values()].map((entry) => entry.item),
      questionOf: Object.fromEntries(
        [...unique.entries()].map(([key, entry]) => [key, entry.question]),
      ),
      ...(outline.quizConfig?.questionCount !== undefined
        ? { questionCount: outline.quizConfig.questionCount }
        : {}),
    });
  }
  return plans;
}

/** One of the engine's «الإجابة الصحيحة المعتمدة (…): …» key points. */
function isSolutionKeyPoint(point: unknown): boolean {
  return typeof point === 'string' && point.startsWith(SOLUTION_KEY_POINT_PREFIX);
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function samePlans(a: readonly ImagePlan[] | undefined, b: readonly ImagePlan[] | undefined) {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The outline without the engine's guide answer drawings (owner, 17 Nov 2026): their ids
 * out of `suggestedImageIds` and their `imagePlans` notes. The SAME object without any.
 */
function withoutGuideFigures(outline: SceneOutline): SceneOutline {
  const carries =
    outline.suggestedImageIds?.some(isGuideFigureImageId) ||
    outline.imagePlans?.some((plan) => isGuideFigureImageId(plan.imageId));
  if (!carries) return outline;
  const { suggestedImageIds, imagePlans, ...rest } = outline;
  const ids = (suggestedImageIds ?? []).filter((id) => !isGuideFigureImageId(id));
  const plans = (imagePlans ?? []).filter((plan) => !isGuideFigureImageId(plan.imageId));
  return {
    ...rest,
    ...(ids.length > 0 ? { suggestedImageIds: ids } : {}),
    ...(plans.length > 0 ? { imagePlans: plans } : {}),
  };
}

/**
 * Re-review finding 2: the outline without ANY of the engine's g5.v11 blocks (the
 * description's appended blocks, the solution key points and the answer drawings),
 * whichever role put them there. The SAME object when it carries none.
 */
function withoutGuideBlocks(outline: SceneOutline): SceneOutline {
  const description = plannedDescription(outline.description);
  const keyPoints = outline.keyPoints?.filter((point) => !isSolutionKeyPoint(point));
  const base = withoutGuideFigures(outline);
  if (
    base === outline &&
    description === outline.description &&
    sameStrings(keyPoints, outline.keyPoints)
  ) {
    return outline;
  }
  return { ...base, description, ...(keyPoints ? { keyPoints } : {}) };
}

/**
 * Re-review finding 2: the outlines with every g5.v11 block taken out, so an attempt
 * built from a resumed outline (`insertAttemptQuizzes` copies a check slide's key points)
 * never copies a key its slide carried under an earlier role. The SAME array when no
 * outline carries one.
 */
export function withoutGuideAnswers(outlines: SceneOutline[]): SceneOutline[] {
  let changed = false;
  const result = outlines.map((outline) => {
    const clean = withoutGuideBlocks(outline);
    if (clean !== outline) changed = true;
    return clean;
  });
  return changed ? result : outlines;
}

/**
 * A clean outline with the blocks of its role: `keep` keyed, `leaveOut` left out, and (a
 * solution only) `modelAnswers` for its writer — never one of a question that left the
 * slide (D-19). An attached answer drawing (owner, 17 Nov 2026) is selected on the same
 * solution outline only; a figure without a stored drawing adds nothing.
 */
function withBlocks(
  base: SceneOutline,
  role: GuideOutlineRole,
  keep: readonly KeyedGuideItem[],
  leaveOut: readonly KeyedGuideItem[],
  modelAnswers: readonly ModelAnswerGuideItem[] = [],
): SceneOutline {
  if (role === 'try') return base;
  if (role === 'attempt') {
    return keep.length > 0
      ? { ...base, description: `${base.description}\n\n${attemptKey(keep)}` }
      : base;
  }
  const gone = new Set(leaveOut.map(questionOf));
  const models = modelAnswers.filter(
    (item) =>
      !gone.has(questionOf(item)) &&
      (item.modelAnswer.kind !== 'figure' || item.figureImageId !== undefined),
  );
  const figures = models.filter(
    (item): item is ModelAnswerGuideItem & { figureImageId: string } =>
      item.figureImageId !== undefined,
  );
  const blocks = [
    ...(keep.length > 0 ? [solutionNote(keep)] : []),
    ...(models.length > 0 ? [modelAnswerNote(models)] : []),
    ...(leaveOut.length > 0 ? [leaveOutNote(leaveOut)] : []),
  ];
  if (blocks.length === 0) return base;
  const figureIds = [...new Set(figures.map((item) => item.figureImageId))];
  return {
    ...base,
    keyPoints: [...(base.keyPoints ?? []), ...keep.map(solutionKeyPoint)],
    description: [base.description, ...blocks].join('\n\n'),
    ...(figureIds.length > 0
      ? {
          suggestedImageIds: [...(base.suggestedImageIds ?? []), ...figureIds],
          imagePlans: [
            ...(base.imagePlans ?? []),
            ...figureIds.map((id) => figureImagePlan(figures.find((f) => f.figureImageId === id)!)),
          ],
        }
      : {}),
  };
}

/**
 * The outlines with the keyed answers in place: a solution slide's key points and writer
 * instruction, an attempt's hidden key, a settled slide's left-out questions. Re-review
 * finding 2: EVERY outline is first cleaned of the engine's g5.v11 blocks, then gets the
 * blocks of its CURRENT plan (`plans`: the guard's effective plans, settled items out;
 * `leftOut`: the exercises a settlement removed from each solution slide) — so a resumed
 * outline whose role a correction changed never keeps a key its new role must not hold.
 * A try-it slide gets nothing. Idempotent; returns the SAME array when nothing changes.
 */
export function injectGuideAnswers(
  outlines: SceneOutline[],
  plans: ReadonlyMap<string, GuideOutlinePlan>,
  leftOut: ReadonlyMap<string, readonly KeyedGuideItem[]> = new Map(),
): SceneOutline[] {
  let changed = false;
  const result = outlines.map((outline) => {
    const plan = plans.get(outline.id);
    const leaveOut = plan?.role === 'try' ? [] : (leftOut.get(outline.id) ?? []);
    const role: GuideOutlineRole = plan?.role ?? (leaveOut.length > 0 ? 'solution' : 'try');
    const next = withBlocks(
      withoutGuideBlocks(outline),
      role,
      plan?.items ?? [],
      leaveOut,
      plan?.modelAnswers,
    );
    if (
      next.description === outline.description &&
      sameStrings(next.keyPoints, outline.keyPoints) &&
      sameStrings(next.suggestedImageIds, outline.suggestedImageIds) &&
      samePlans(next.imagePlans, outline.imagePlans)
    ) {
      return outline;
    }
    changed = true;
    return next;
  });
  return changed ? result : outlines;
}

/**
 * Review finding 1: the outline an attempt's NARRATION writer reads — its hidden key
 * cut off, since the key may reach the quiz content writer only. Re-review finding 2:
 * on any outline but a solution slide, every g5.v11 block and solution key point is cut
 * too (a check attempt copies its slide's key points). The SAME object when the outline
 * carries none (every other outline, every other Teaching Model).
 */
export function withoutHiddenAnswerKey<
  T extends Pick<SceneOutline, 'description'> &
    Partial<Pick<SceneOutline, 'type' | 'contentRole' | 'keyPoints'>>,
>(outline: T): T {
  const solution = outline.type === 'slide' && outline.contentRole === 'worked_example';
  const at = outline.description.indexOf(`\n\n${ATTEMPT_KEY_MARKER}`);
  const description = solution
    ? at < 0
      ? outline.description
      : outline.description.slice(0, at)
    : plannedDescription(outline.description);
  const keyPoints = solution
    ? outline.keyPoints
    : outline.keyPoints?.filter((point) => !isSolutionKeyPoint(point));
  if (description === outline.description && sameStrings(keyPoints, outline.keyPoints)) {
    return outline;
  }
  return { ...outline, description, ...(keyPoints ? { keyPoints } : {}) };
}

/**
 * Re-review finding 6: the items whose hidden key an attempt outline carries
 * (`attemptKey`), of `items`.
 */
export function keyedInAttempt(
  outline: Pick<SceneOutline, 'description'>,
  items: readonly KeyedGuideItem[],
): KeyedGuideItem[] {
  const at = outline.description.indexOf(`\n\n${ATTEMPT_KEY_MARKER}`);
  if (at < 0) return [];
  const block = outline.description.slice(at);
  return items.filter((item) => block.includes(`\n- item ${item.display}: `));
}

/** The marker of the "leave these questions out" instruction (D-19). */
const LEAVE_OUT_MARKER = 'LEFT OUT QUESTIONS (g5.v11)';

function leaveOutNote(items: readonly KeyedGuideItem[]): string {
  return [
    `${LEAVE_OUT_MARKER}: this slide no longer solves the questions below. Never show, solve`,
    'or mention them, on the canvas or in the narration; solve every other question as planned.',
    ...[...new Set(items.map((item) => item.display))].map((display) => `- ${display}`),
  ].join('\n');
}

/** One question of the lesson: its unit and number (a unit solved whole: `*`). */
function questionOf(item: Pick<ResolvedGuideItem, 'contentUnitId' | 'number'>): string {
  return `${item.contentUnitId}|${item.number ?? '*'}`;
}

/** The description without the engine's g5.v11 blocks (always appended last). */
function plannedDescription(description: string): string {
  const cuts = [SOLUTION_NOTE_MARKER, MODEL_ANSWER_MARKER, ATTEMPT_KEY_MARKER, LEAVE_OUT_MARKER]
    .map((marker) => description.indexOf(`\n\n${marker}`))
    .filter((at) => at >= 0);
  return cuts.length > 0 ? description.slice(0, Math.min(...cuts)) : description;
}

/**
 * D-19 (16 Nov 2026): the outline rebuilt with only `keep` of its plan's items keyed;
 * the others get no guide answer (the plain g5.v10 path). `leaveOut` (a solution's
 * exercise items) are named as questions the slide no longer solves. A try-it outline
 * gets no block: it never had an answer.
 */
export function withGuideItems(
  outline: SceneOutline,
  plan: GuideOutlinePlan,
  keep: readonly KeyedGuideItem[],
  leaveOut: readonly KeyedGuideItem[] = [],
): SceneOutline {
  const base = withoutGuideBlocks(outline);
  if (plan.role === 'try') return base;
  // Always a new outline: the caller records it as the settled one.
  return { ...withBlocks(base, plan.role, keep, leaveOut, plan.modelAnswers) };
}
