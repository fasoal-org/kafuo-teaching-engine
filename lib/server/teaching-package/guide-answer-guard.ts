/**
 * g5.v11 (teacher-guide answer referee plan §8.3–8.5): the code safety net behind the
 * approved answers. Pure over the run's outline plans (`guideOutlinePlans`); the scene
 * pipeline (`classroom-generation.ts`) and the single-scene regeneration call it, and
 * only when the package carries one.
 *
 * - Comparator: each solution item's final line on the canvas («الإجابة (1A): 12») and
 *   each attempt question's keyed option are compared with the approved answer
 *   (`guide-answer-compare.ts`), an attempt item on ITS OWN question when that can be
 *   told. A missing final line is a mismatch: it is the comparator's only reading of
 *   the canvas, and the writer was told to write it.
 * - Leak guard: no approved value, and no announced option letter or truth value, on a
 *   try-it slide's canvas or narration, or in an attempt's question stem or narration
 *   (the right option among the options is fine). A given of the item's OWN question
 *   that equals the answer is no leak.
 * - One regeneration with a correction (the correct final answer for a solution or a
 *   key; never the value for a leak). Still failing → D-19 (16 Nov 2026), never a slide
 *   dropped and never a step for a person:
 *   - a check item: its outline is generated once more WITHOUT the guide answer (the
 *     plain g5.v10 path) and kept; the item is logged unverified;
 *   - an exercise item: the exercise leaves the lesson — its attempt question and its
 *     item on the solution slide (which is generated once more without it); when that
 *     cannot be done (the slide would solve nothing, or its attempt question cannot be
 *     told), the slide is generated without the guide answer of that exercise instead;
 *   - an attempt question TIED to the item at fault is removed (re-review finding 5a:
 *     never a question that only lists the value as a wrong option); an attempt left
 *     with no question is the ONLY outline that ever leaves (it is practice, never a
 *     coverage item);
 *   - a check item left without its guide answer on its solution slide loses its key in
 *     its attempt too (re-review finding 6), so the key and the solution never disagree;
 *   - a narration that still states the answer: an attempt gets the model-free
 *     narration; a try-it slide keeps its narration;
 *   - a try-it slide (or a solution slide's check before its try) that still states the
 *     answer is kept and marked for the reviewer (re-review finding 5c,
 *     {@link guideLeakIssue}); a single-slide regeneration keeps the slide as it was.
 * - Re-review finding 4: a written number that cannot be compared (it reads two ways)
 *   is never a mismatch.
 * - Lesson 1-1 (16 Nov 2026, scene 26): a solution slide must SOLVE each keyed exercise
 *   it ends with a final line for. On a slide that tags its exercises with the book's
 *   number («(س2 في كتابك)»), a keyed exercise is solved when its tag (its part too) is
 *   there over a block holding one of its own book numbers, or — a unit solved whole,
 *   which the writer is given no tag for — when half its book numbers are on the slide.
 *   Otherwise its final line leaves the canvas, its key leaves the outline the narration
 *   is written from, and the item is logged unverified on that slide. Deterministic:
 *   no generation, never a pause; its attempt keeps its compared key.
 */
import {
  announcesGuideAnswer,
  compareGuideAnswer,
  leaksGuideAnswer,
  normalizeGuideDigits,
} from '@/lib/server/teaching-package/guide-answer-compare';
import { ATTEMPT_OUTLINE_SUFFIX } from '@/lib/server/teaching-package/attempt-quizzes';
import {
  finalAnswerLine,
  formatGuideAnswer,
  guideItemKey,
  guideItemQuestionText,
  keyedInAttempt,
  parseGuideLabel,
  SOLUTION_KEY_POINT_PREFIX,
  withGuideItems,
  type GuideOutlinePlan,
  type KeyedGuideItem,
} from '@/lib/server/teaching-package/guide-answers';
import type { SceneOutline } from '@/lib/types/generation';

export type GuideAnswerFindingCode =
  | 'GUIDE_ANSWER_MISMATCH'
  | 'GUIDE_ANSWER_MISSING'
  | 'GUIDE_ANSWER_LEAK'
  /** A solution slide ends with an exercise's final line but solves another item. */
  | 'GUIDE_ANSWER_UNSOLVED';

export interface GuideAnswerFinding {
  code: GuideAnswerFindingCode;
  item: KeyedGuideItem;
  where: 'canvas' | 'quiz' | 'stem' | 'narration';
  /** Attempts: the question indexes at fault; `null` when they cannot be told. */
  questions?: number[] | null;
  /** What was written instead, in a few words (never logged with the answer). */
  detail: string;
}

/** What one settled outline did (D-19), pinned on the attempt: labels and codes, no answers. */
export interface GuideAnswerSettlement {
  outlineId: string;
  action:
    | 'questions_removed'
    | 'items_removed'
    | 'unverified'
    | 'narration_replaced'
    | 'attempt_dropped';
  /** The outline ids that left the lesson: only an attempt left with no question. */
  dropped: string[];
  removedQuestions: number[];
  /**
   * The items settled: `removed` = the exercise left the lesson (its attempt question
   * and its solution item); `unverified` = kept, generated without the guide answer.
   */
  items: Array<{ contentUnitId: string; label: string; outcome: 'removed' | 'unverified' }>;
  findings: Array<{
    code: GuideAnswerFindingCode;
    contentUnitId: string;
    label: string;
    where: string;
  }>;
}

/** What the scene does after its one corrected regeneration still failed. */
export type GuideSettleDecision =
  /** Keep this content (an attempt's faulty questions leave in `pruneAttempt`). */
  | { kind: 'keep'; content: unknown }
  /** Generate ONCE more from this outline (the failing items without their guide answer) and keep it. */
  | { kind: 'regenerate'; outline: SceneOutline };

export interface GuideAnswerGuard {
  /** The run's final plans (set when the outline is finalized, fresh or resumed). */
  usePlans(plans: ReadonlyMap<string, GuideOutlinePlan>): void;
  /**
   * The items an earlier part of the same run (a paused run, the bound package) already
   * settled: a removed exercise stays removed, an unverified item stays without its key.
   */
  restore(settlements: ReadonlyArray<Pick<GuideAnswerSettlement, 'outlineId' | 'items'>>): void;
  /** The plan of one outline (settled items out), or undefined when it holds no keyed item. */
  planOf(outlineId: string): GuideOutlinePlan | undefined;
  /** Every outline's plan, settled items out (what a resumed run injects). */
  effectivePlans(): Map<string, GuideOutlinePlan>;
  /** Per solution slide, the exercises a settlement removed (its «left out» note). */
  leftOut(): Map<string, KeyedGuideItem[]>;
  /**
   * Deterministic clean-up of the content that is kept, AFTER the check (which skips
   * these lines): our own «الإجابة الصحيحة المعتمدة» wording, if a writer copied it,
   * leaves the canvas as «الإجابة الصحيحة».
   */
  cleanWording<T>(outline: SceneOutline, content: T): T;
  /**
   * Lesson 1-1 (16 Nov 2026): on the kept content of a solution slide that tags its
   * exercises («(سN في كتابك)»), the keyed exercises it does not solve (see the file
   * header) lose their final line on the canvas and their key on the outline (so the
   * narration never states it), and are logged unverified on this slide. The SAME
   * content and outline when every keyed exercise is solved, or when the slide tags none
   * (it cannot be told).
   */
  settleUnsolved<T>(outline: SceneOutline, content: T): { content: T; outline: SceneOutline };
  checkContent(outline: SceneOutline, content: unknown): GuideAnswerFinding[];
  checkNarration(
    outline: SceneOutline,
    actions: ReadonlyArray<{ type: string; text?: unknown }>,
  ): GuideAnswerFinding[];
  /** The one regeneration's correction: the correct final answers only, never a method. */
  correction(outline: SceneOutline, findings: readonly GuideAnswerFinding[]): string;
  /**
   * Still failing after the one regeneration (D-19). `removal: false` (a single-scene
   * regeneration, which cannot touch another scene) never removes an exercise or a
   * question: the failing items are generated without their guide answer instead.
   */
  settle(
    outline: SceneOutline,
    content: unknown,
    findings: readonly GuideAnswerFinding[],
    options?: { removal?: boolean },
  ): GuideSettleDecision;
  /** Findings left on the kept content after the settle regeneration: logged, never acted on. */
  accept(outline: SceneOutline, findings: readonly GuideAnswerFinding[]): void;
  /** A narration still stating the answer: an attempt's is replaced by the model-free one. */
  settleNarration(
    outline: SceneOutline,
    findings: readonly GuideAnswerFinding[],
  ): 'keep' | 'model_free';
  /**
   * The solution slides an attempt's settlement comes from: an exercise attempt's own
   * slide (its question removals), and the slides that solve a check attempt's items
   * (re-review finding 6: an item left without its guide answer there). Empty for any
   * other outline.
   */
  solutionsOf(attemptId: string): string[];
  /**
   * Re-review finding 6: once {@link solutionsOf} settled, the attempt outline to
   * generate once more when it still keys a check item its solution slide now solves
   * without the guide answer (that key out); undefined when nothing changed.
   */
  rekeyAttempt(outline: SceneOutline): SceneOutline | undefined;
  /**
   * The attempt with its faulty questions and the questions of removed exercises taken
   * out; `drop` when no question is left (the attempt alone leaves the lesson).
   */
  pruneAttempt(outline: SceneOutline, content: unknown): { content: unknown } | { drop: true };
}

const GUIDE_LEAK_ISSUE_HEAD = 'this slide may state the answer of item ';
const GUIDE_LEAK_ISSUE_TAIL =
  " before the learner's try; regenerate it so it states the task and its givens only";

/**
 * Re-review finding 5c: the scene issue of a slide kept while it still states a checked
 * answer before the learner's try, so the package reviewer's fix loop sees it. Names
 * the items, never their answers.
 */
export function guideLeakIssue(findings: readonly GuideAnswerFinding[]): {
  code: 'GUIDE_ANSWER_LEAK';
  message: string;
} {
  const items = [...new Set(findings.map((finding) => finding.item.display))].join(', ');
  return {
    code: 'GUIDE_ANSWER_LEAK',
    message: `${GUIDE_LEAK_ISSUE_HEAD}${items}${GUIDE_LEAK_ISSUE_TAIL}`,
  };
}

/**
 * The item names a {@link guideLeakIssue} carries (never an answer), for the package
 * reviewer's must-fix finding on that slide. Empty for any other issue or wording.
 */
export function guideLeakIssueItems(issue: { code: string; message: string }): string[] {
  const { code, message } = issue;
  if (code !== 'GUIDE_ANSWER_LEAK') return [];
  if (!message.startsWith(GUIDE_LEAK_ISSUE_HEAD) || !message.endsWith(GUIDE_LEAK_ISSUE_TAIL)) {
    return [];
  }
  return message
    .slice(GUIDE_LEAK_ISSUE_HEAD.length, message.length - GUIDE_LEAK_ISSUE_TAIL.length)
    .split(', ')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Arabic marks and tatweel: U+0610–U+061A, U+064B–U+065F, U+0670, U+0640. */
const DIACRITICS = /[ؐ-ًؚ-ٰٟـ]/g;

function decode(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

type Element = Record<string, unknown>;

function elementsOf(content: unknown): Element[] {
  if (!content || typeof content !== 'object') return [];
  const record = content as { elements?: unknown; canvas?: { elements?: unknown } };
  const elements = record.elements ?? record.canvas?.elements;
  return Array.isArray(elements) ? (elements as Element[]) : [];
}

/** The canvas text, one line per paragraph, cell row or formula. */
export function canvasLines(content: unknown): string[] {
  const lines: string[] = [];
  for (const element of elementsOf(content)) {
    let text = '';
    if (element.type === 'text' && typeof element.content === 'string')
      text = decode(element.content);
    else if (element.type === 'shape') {
      const inner = (element.text as { content?: unknown } | undefined)?.content;
      if (typeof inner === 'string') text = decode(inner);
    } else if (element.type === 'latex' && typeof element.latex === 'string') text = element.latex;
    else if (element.type === 'table' && Array.isArray(element.data)) {
      text = (element.data as unknown[])
        .map((row) =>
          Array.isArray(row)
            ? row
                .map((cell) =>
                  cell && typeof (cell as { text?: unknown }).text === 'string'
                    ? decode((cell as { text: string }).text)
                    : '',
                )
                .join(' | ')
            : '',
        )
        .join('\n');
    }
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\s+/g, ' ').trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  return lines;
}

/** «الإجابة (1A): 12», «الإجابة النهائية: 12», «الإجابة (س١١) : ٧١٫٩ ريالًا». */
const FINAL_LINE =
  /(?:^|[\s(])(?:ال)?[إاأ]جاب[ةه](?:\s+(?:ال)?(?:نهائي|صحيح)[ةه])?\s*(?:[(（]\s*([^)）:]{1,32})\s*[)）])?\s*[:：]\s*(.+)$/u;

interface FinalLine {
  label: string | null;
  value: string;
}

function finalLines(lines: readonly string[]): FinalLine[] {
  const finals: FinalLine[] = [];
  for (const line of lines) {
    const plain = line.replace(DIACRITICS, '');
    // Our own key point wording is the writer's input, never its answer.
    if (/المعتمد/u.test(plain)) continue;
    const match = FINAL_LINE.exec(plain);
    if (match) finals.push({ label: match[1]?.trim() || null, value: match[2]!.trim() });
  }
  return finals;
}

const LABEL_LETTER: Readonly<Record<string, string>> = { أ: 'a', ا: 'a', ب: 'b', ج: 'c', د: 'd' };

/** A label for matching: Western digits and part letters only («س١١ب» → «11b»). */
function labelKey(label: string): string {
  return normalizeGuideDigits(label)
    .replace(/(?<=\d)\s*([أابجد])(?![ء-ي])/gu, (_all, letter: string) => LABEL_LETTER[letter]!)
    .toLowerCase()
    .replace(/[^0-9a-h]/g, '');
}

/** One question a book tag names; `parts` empty = every part of it. */
interface TaggedQuestion {
  number: number;
  parts: Set<string>;
}

/** The text of one tagged exercise: from its tag to the next one (untagged elements join it). */
interface TagBlock {
  questions: TaggedQuestion[];
  text: string;
}

/**
 * The book's tag of an exercise on a solution slide (`learnerFirstExerciseLabels`):
 * «(س٥ في كتابك)», «(س٧ من كتابك)», «(س11ب)», «(س١١أ، ب)», «(س5، س6 في كتابك)»,
 * «(س5–7 في كتابك)». Bracketed, holding only numbers, part letters and separators, so a
 * coordinate «(س2 - س1)» or «(س1، ص1)» is never one. The lesson's «تمرين ٢» label is never
 * read: it is the label PLANNED for an item, and the writer may solve another one under it.
 */
const TAG_SPAN = /[(（[]\s*(س\s*\d[^()（）[\]]{0,60}?)\s*[)）\]]/gu;
const TAG_WORDING = /\s*(?:(?:في|من|ب)\s*)?(?:ال)?كتاب[ء-ي]*\s*$/u;
const TAG_BODY = /^(?:\s|س|\d{1,3}|[a-h](?![a-z])|[أابجد](?![ء-ي])|[،,و]|[-–—])+$/iu;
const TAG_TOKEN = /\d{1,3}|[a-h](?![a-z])|[أابجد](?![ء-ي])|[-–—]/giu;
const PART_LETTER: Readonly<Record<string, string>> = { أ: 'a', ا: 'a', ب: 'b', ج: 'c', د: 'd' };

/** Marks out and Western digits, for reading tags and numbers off the canvas. */
function plainText(text: string): string {
  return text
    .replace(DIACRITICS, '')
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/** The questions one bracketed tag names, or null when it is not a book tag. */
function tagQuestions(inner: string): TaggedQuestion[] | null {
  const body = inner.replace(TAG_WORDING, '');
  if (!TAG_BODY.test(body) || /[-–—]\s*س/u.test(body)) return null;
  const questions: TaggedQuestion[] = [];
  let range = false;
  for (const [token] of body.matchAll(TAG_TOKEN)) {
    if (/\d/u.test(token)) {
      const number = Number(token);
      const last = questions.at(-1)?.number;
      if (range && last !== undefined && number > last && number - last <= 20) {
        for (let between = last + 1; between < number; between += 1) {
          questions.push({ number: between, parts: new Set() });
        }
      }
      questions.push({ number, parts: new Set() });
      range = false;
    } else if (/[-–—]/u.test(token)) {
      range = true;
    } else {
      questions.at(-1)?.parts.add(PART_LETTER[token] ?? token.toLowerCase());
      range = false;
    }
  }
  return questions.length > 0 ? questions : null;
}

/** A canvas line without its final-line part (the comparator's reading), marks out. */
function solvedPart(line: string): string {
  const plain = plainText(line);
  const final = FINAL_LINE.exec(plain);
  return final ? plain.slice(0, final.index) : plain;
}

/**
 * The tagged exercises of a canvas, element by element in order, outside the final
 * lines: a tag's block runs to the next tag, and an untagged element joins the block
 * before it (its working may sit apart from its title).
 */
function tagBlocks(content: unknown): { blocks: TagBlock[]; text: string } {
  const blocks: TagBlock[] = [];
  const texts: string[] = [];
  for (const element of elementsOf(content)) {
    const text = canvasLines({ elements: [element] })
      .map(solvedPart)
      .join('\n');
    texts.push(text);
    const tags = [...text.matchAll(TAG_SPAN)].flatMap((match) => {
      const questions = tagQuestions(match[1]!);
      return questions ? [{ at: match.index ?? 0, questions }] : [];
    });
    if (tags.length === 0) {
      if (blocks.length > 0) blocks[blocks.length - 1]!.text += `\n${text}`;
      continue;
    }
    tags.forEach((tag, index) => {
      const from = index === 0 ? 0 : tag.at;
      const to = tags[index + 1]?.at ?? text.length;
      blocks.push({ questions: tag.questions, text: text.slice(from, to) });
    });
  }
  return { blocks, text: texts.join('\n') };
}

/** The numbers a text holds («9.00» is 9, a time «10:15» stays whole). */
function numberTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const [token] of normalizeGuideDigits(text).matchAll(/\d+(?:[.:]\d+)*/g)) {
    tokens.add(token.includes(':') ? token : String(Number(token)));
  }
  return tokens;
}

/** A block's own numbers: its tags and «تمرين N» labels out. */
function blockNumbers(text: string): Set<string> {
  return numberTokens(text.replace(TAG_SPAN, ' ').replace(/تمرين\s*\d+/gu, ' '));
}

/** «الإجابة» in an element's HTML, with any marks between its letters. */
const MARKS = '[\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u0640]*';
const ANSWER_WORD = new RegExp(
  `(?:ا${MARKS}ل${MARKS})?[إاأ]${MARKS}ج${MARKS}ا${MARKS}ب${MARKS}[ةه]`,
  'gu',
);
/** Where `decode` ends a canvas line. */
const LINE_BREAK = /(<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>)/giu;

/** Where, in one HTML line, the final line of a label `strip` names starts; or null. */
function finalLineStart(segment: string, strip: (label: string) => boolean): number | null {
  for (const word of segment.matchAll(ANSWER_WORD)) {
    const at = word.index ?? 0;
    // Never a word inside a tag (an attribute).
    if (segment.lastIndexOf('<', at) > segment.lastIndexOf('>', at)) continue;
    const before = decode(segment.slice(0, at)).replace(DIACRITICS, '');
    if (before.length > 0 && !/[\s(]$/u.test(before)) continue;
    const rest = decode(segment.slice(at)).replace(DIACRITICS, '').replace(/\s+/g, ' ').trim();
    const final = FINAL_LINE.exec(rest);
    if (!final || final.index !== 0) continue;
    const label = final[1]?.trim();
    return label && strip(label) ? at : null;
  }
  return null;
}

/**
 * The HTML without the final lines of the labels `strip` names: the text from «الإجابة»
 * to the line's end leaves (its tags stay, so the markup stays whole), and a paragraph
 * left empty leaves whole. The SAME string when no such line is there.
 */
function withoutFinalLines(html: string, strip: (label: string) => boolean): string {
  const parts = html.split(LINE_BREAK);
  const kept: string[] = [];
  let changed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const segment = parts[index]!;
    const lineEnd = parts[index + 1] ?? '';
    const at = finalLineStart(segment, strip);
    if (at === null) {
      kept.push(segment, lineEnd);
      continue;
    }
    changed = true;
    const newline = segment.indexOf('\n', at);
    const end = newline < 0 ? segment.length : newline;
    const rest = segment.slice(0, at) + segment.slice(at, end).replace(/[^<>]+(?=<|$)/g, '');
    const next = rest + segment.slice(end);
    const closes = /^<\/(\w+)>$/u.exec(lineEnd)?.[1];
    const opensHere = closes !== undefined && new RegExp(`^\\s*<${closes}\\b`, 'iu').test(next);
    if (opensHere && decode(next).trim() === '') continue;
    kept.push(next, lineEnd);
  }
  return changed ? kept.join('') : html;
}

/** The content with `edit` applied to each text and shape element's HTML (as `cleanWording`). */
function editTexts<T>(content: T, edit: (html: string) => string): T {
  const elements = elementsOf(content);
  let changed = false;
  const next = elements.map((element) => {
    if (element.type === 'text' && typeof element.content === 'string') {
      const html = edit(element.content);
      if (html === element.content) return element;
      changed = true;
      return { ...element, content: html };
    }
    const inner = (element.text as { content?: unknown } | undefined)?.content;
    if (element.type === 'shape' && typeof inner === 'string') {
      const html = edit(inner);
      if (html === inner) return element;
      changed = true;
      return { ...element, text: { ...(element.text as object), content: html } };
    }
    return element;
  });
  if (!changed) return content;
  const record = content as Record<string, unknown>;
  return (
    Array.isArray(record.elements)
      ? { ...record, elements: next }
      : { ...record, canvas: { ...(record.canvas as object), elements: next } }
  ) as T;
}

interface QuizQuestionLike {
  question?: unknown;
  options?: Array<{ value?: unknown; label?: unknown }>;
  answer?: unknown;
}

function questionsOf(content: unknown): QuizQuestionLike[] {
  const questions = (content as { questions?: unknown } | null)?.questions;
  return Array.isArray(questions) ? (questions as QuizQuestionLike[]) : [];
}

function keyedValues(question: QuizQuestionLike): string[] {
  return Array.isArray(question.answer) ? (question.answer as unknown[]).map(String) : [];
}

function spoken(actions: ReadonlyArray<{ type: string; text?: unknown }>): string {
  return actions
    .flatMap((action) =>
      action.type === 'speech' && typeof action.text === 'string' ? [action.text] : [],
    )
    .join('\n');
}

function uniqueItems(findings: readonly GuideAnswerFinding[]): KeyedGuideItem[] {
  return [
    ...new Map(findings.map((finding) => [guideItemKey(finding.item), finding.item])).values(),
  ];
}

/** One book question of an exercise item («11a» and «11b» are question 11). */
function questionKey(item: KeyedGuideItem): string {
  return `${item.contentUnitId}|${item.number ?? '*'}`;
}

export function createGuideAnswerGuard(options: {
  /** The book text of each unit (verses and hadith already removed), by unit id. */
  unitTexts: ReadonlyMap<string, string>;
  /** Called once per settled outline (for the attempt snapshot and the log). */
  onSettled?: (settlement: GuideAnswerSettlement) => void;
}): GuideAnswerGuard {
  let plans: ReadonlyMap<string, GuideOutlinePlan> = new Map();
  /** Exercise items that left the lesson (their attempt question and solution item). */
  const removed = new Set<string>();
  /** Per solution or attempt outline: the items it now carries without a guide answer. */
  const unverified = new Map<string, Set<string>>();
  /** Per attempt: its own questions at fault, taken out in `pruneAttempt`. */
  const faultyQuestions = new Map<string, Set<number>>();
  const ownTexts = new Map<string, string>();

  /** Review finding 3: the item's OWN question text (never the whole unit) holds its givens. */
  const bookText = (item: KeyedGuideItem) => {
    const key = guideItemKey(item);
    let text = ownTexts.get(key);
    if (text === undefined) {
      text = guideItemQuestionText(options.unitTexts.get(item.contentUnitId) ?? '', item);
      ownTexts.set(key, text);
    }
    return text;
  };

  /** An exercise item's numbers in its OWN book question (its question number out). */
  const givensOf = (item: KeyedGuideItem, number: number | null): Set<string> => {
    const own = guideItemQuestionText(options.unitTexts.get(item.contentUnitId) ?? '', {
      element: item.element,
      number,
      letter: item.letter,
    });
    const tokens = numberTokens(plainText(own));
    if (number !== null) tokens.delete(String(number));
    return tokens;
  };

  /**
   * Lesson 1-1: whether a solution slide that tags its exercises solves this one.
   * - Tagged with its number (and its part, when the tag names parts): solved, unless its
   *   own book question holds two or more numbers and none of them is in the tagged
   *   block (the planned tag copied over another item's working).
   * - Untagged, a question the engine gave the writer a tag for (a listed question of a
   *   multi-question unit): not solved.
   * - Untagged, a unit solved whole (its writer gets no tag; review: its `number` is
   *   null, so its label's number is read): solved when at least half of its book
   *   numbers are on the slide; with fewer than two book numbers it cannot be told and
   *   is kept.
   */
  const solvedHere = (
    item: KeyedGuideItem,
    blocks: readonly TagBlock[],
    slideNumbers: ReadonlySet<string>,
  ): boolean => {
    const number = item.number ?? parseGuideLabel(item.label).number;
    const part = item.letter?.toLowerCase() ?? null;
    const givens = [...givensOf(item, number)];
    const tagged = blocks.filter((block) =>
      block.questions.some(
        (question) =>
          question.number === number &&
          (part === null || question.parts.size === 0 || question.parts.has(part)),
      ),
    );
    if (tagged.length > 0) {
      if (givens.length < 2) return true;
      return tagged.some((block) => {
        const own = blockNumbers(block.text);
        return givens.some((given) => own.has(given));
      });
    }
    if (item.number !== null) return false;
    // Final review: a whole unit with fewer than two own numbers cannot be told: kept.
    if (givens.length < 2) return true;
    return givens.filter((given) => slideNumbers.has(given)).length * 2 >= givens.length;
  };

  /** Re-review finding 6: a check item a solution slide now solves without its guide answer. */
  const unverifiedOnSolution = (key: string): boolean => {
    for (const [outlineId, keys] of unverified) {
      if (!keys.has(key)) continue;
      const plan = plans.get(outlineId);
      if (plan?.role === 'solution' && plan.items.some((item) => guideItemKey(item) === key)) {
        return true;
      }
    }
    return false;
  };

  const effective = (outlineId: string): GuideOutlinePlan | undefined => {
    const plan = plans.get(outlineId);
    if (!plan) return undefined;
    const skip = plan.role === 'try' ? undefined : unverified.get(outlineId);
    const items = plan.items.filter((item) => {
      const key = guideItemKey(item);
      if (removed.has(key) || skip?.has(key)) return false;
      // Its attempt never keys what its solution slide no longer reaches.
      return !(plan.role === 'attempt' && item.element === 'try_it' && unverifiedOnSolution(key));
    });
    // A solution slide whose items all settled still guards its checks before their try.
    if (items.length === 0 && (plan.beforeTry?.length ?? 0) === 0) return undefined;
    return items.length === plan.items.length ? plan : { ...plan, items };
  };

  const unverify = (outlineId: string, items: readonly KeyedGuideItem[]) => {
    const set = unverified.get(outlineId) ?? new Set<string>();
    for (const item of items) set.add(guideItemKey(item));
    unverified.set(outlineId, set);
  };

  const report = (
    outline: SceneOutline,
    action: GuideAnswerSettlement['action'],
    findings: readonly GuideAnswerFinding[],
    extra: Partial<Pick<GuideAnswerSettlement, 'dropped' | 'removedQuestions' | 'items'>> = {},
  ) =>
    options.onSettled?.({
      outlineId: outline.id,
      action,
      dropped: extra.dropped ?? [],
      removedQuestions: extra.removedQuestions ?? [],
      items: extra.items ?? [],
      findings: findings.map((finding) => ({
        code: finding.code,
        contentUnitId: finding.item.contentUnitId,
        label: finding.item.label,
        where: finding.where,
      })),
    });

  const outcomes = (items: readonly KeyedGuideItem[], outcome: 'removed' | 'unverified') =>
    items.map((item) => ({ contentUnitId: item.contentUnitId, label: item.label, outcome }));

  const leaks = (
    items: readonly KeyedGuideItem[],
    text: string,
    where: GuideAnswerFinding['where'],
  ): GuideAnswerFinding[] =>
    items
      .filter(
        (item) =>
          // Re-review finding 4: a narration's numbers said in words are read too.
          leaksGuideAnswer(item.answer, text, bookText(item), {
            spoken: where === 'narration',
          }) || announcesGuideAnswer(item.answer, text),
      )
      .map((item) => ({ code: 'GUIDE_ANSWER_LEAK', item, where, detail: 'the answer is stated' }));

  const solutionFindings = (plan: GuideOutlinePlan, content: unknown): GuideAnswerFinding[] => {
    const finals = finalLines(canvasLines(content));
    const unlabelled = finals.filter((line) => line.label === null);
    return plan.items.flatMap((item): GuideAnswerFinding[] => {
      const key = labelKey(item.display);
      const labelled = finals.filter((line) => line.label !== null && labelKey(line.label) === key);
      // An unlabelled «الإجابة: …» line is read only when it is the slide's ONLY one: a
      // check slide also solves items without a key, so any other line may be theirs.
      const candidates =
        labelled.length > 0
          ? labelled
          : plan.items.length === 1 && unlabelled.length === 1
            ? unlabelled
            : [];
      if (candidates.length === 0) {
        return [{ code: 'GUIDE_ANSWER_MISSING', item, where: 'canvas', detail: 'no final line' }];
      }
      const verdicts = candidates.map((line) => compareGuideAnswer(item.answer, line.value));
      // Re-review finding 4: a line that cannot be compared is never a mismatch.
      if (verdicts.some((verdict) => verdict.match || verdict.undecided)) return [];
      return [
        {
          code: 'GUIDE_ANSWER_MISMATCH',
          item,
          where: 'canvas',
          detail: verdicts[verdicts.length - 1]!.reason ?? '',
        },
      ];
    });
  };

  const attemptFindings = (plan: GuideOutlinePlan, content: unknown): GuideAnswerFinding[] => {
    const questions = questionsOf(content);
    // Review finding 6: an item is read on its OWN question, when the quiz holds the
    // questions it was planned with; otherwise (a question cannot be told) on any.
    const tied = plan.questionCount !== undefined && questions.length === plan.questionCount;
    const ownQuestion = (item: KeyedGuideItem): number | null => {
      const index = tied ? plan.questionOf?.[guideItemKey(item)] : null;
      return index !== null && index !== undefined && index < questions.length ? index : null;
    };
    const findings: GuideAnswerFinding[] = [];
    for (const item of plan.items) {
      const own = ownQuestion(item);
      if (item.answer.type === 'choice') {
        // The book's options in the book's order: the keyed letter is the book's.
        const keys = (question: QuizQuestionLike) =>
          keyedValues(question).some((value) => compareGuideAnswer(item.answer, value).match);
        const keyed = own !== null ? keys(questions[own]!) : questions.some(keys);
        if (!keyed) {
          findings.push({
            code: 'GUIDE_ANSWER_MISMATCH',
            item,
            where: 'quiz',
            questions: own !== null ? [own] : null,
            detail: 'another option is keyed',
          });
        }
        continue;
      }
      let offered = false;
      let keyed = false;
      questions.forEach((question, index) => {
        if (own !== null && index !== own) return;
        // Re-review finding 4: an option that cannot be compared may be the right one.
        const right = (question.options ?? []).filter((option) => {
          if (typeof option.label !== 'string') return false;
          const verdict = compareGuideAnswer(item.answer, option.label);
          return verdict.match || verdict.undecided === true;
        });
        if (right.length === 0) return;
        offered = true;
        const values = keyedValues(question);
        if (right.some((option) => values.includes(String(option.value)))) keyed = true;
      });
      if (!keyed) {
        // Re-review finding 5a: only the item's OWN question is at fault. A question that
        // merely lists the value (another item's, as a wrong option) is never removed;
        // when the item's question cannot be told, none is (D-19: no guide key instead).
        findings.push({
          code: 'GUIDE_ANSWER_MISMATCH',
          item,
          where: 'quiz',
          questions: own !== null ? [own] : null,
          detail: offered ? 'another option is keyed' : 'the answer is not an option',
        });
      }
    }
    // The stems are read before the try: no approved value in any of them. A tied stem
    // is read only for its own items (and those whose question cannot be told): another
    // question's book data may hold an earlier item's answer as a given (Q12's data
    // holding Q11's answer), and that is never a leak of Q11.
    questions.forEach((question, index) => {
      const stem = typeof question.question === 'string' ? decode(question.question) : '';
      const items = tied
        ? plan.items.filter((item) => {
            const own = plan.questionOf?.[guideItemKey(item)];
            return own === null || own === undefined || own === index;
          })
        : plan.items;
      for (const finding of leaks(items, stem, 'stem')) {
        findings.push({ ...finding, questions: [index] });
      }
    });
    return findings;
  };

  /** An exercise item can leave its solution slide only when its attempt question is told. */
  const attemptCanLose = (solutionId: string, item: KeyedGuideItem): boolean => {
    const attempt = plans.get(`${solutionId}${ATTEMPT_OUTLINE_SUFFIX}`);
    if (!attempt) return true;
    const key = guideItemKey(item);
    if (!attempt.items.some((candidate) => guideItemKey(candidate) === key)) return true;
    const question = attempt.questionOf?.[key];
    return question !== null && question !== undefined;
  };

  return {
    usePlans(next) {
      plans = next;
    },
    restore(settlements) {
      for (const settlement of settlements) {
        for (const item of settlement.items ?? []) {
          const key = guideItemKey(item);
          if (item.outcome === 'removed') removed.add(key);
          else {
            const set = unverified.get(settlement.outlineId) ?? new Set<string>();
            set.add(key);
            unverified.set(settlement.outlineId, set);
          }
        }
      }
    },
    planOf: effective,
    effectivePlans() {
      const result = new Map<string, GuideOutlinePlan>();
      for (const id of plans.keys()) {
        const plan = effective(id);
        if (plan) result.set(id, plan);
      }
      return result;
    },
    leftOut() {
      const result = new Map<string, KeyedGuideItem[]>();
      for (const [id, plan] of plans) {
        if (plan.role !== 'solution') continue;
        const items = plan.items.filter((item) => removed.has(guideItemKey(item)));
        if (items.length > 0) result.set(id, items);
      }
      return result;
    },
    cleanWording(outline, content) {
      if (plans.get(outline.id)?.role !== 'solution') return content;
      const elements = elementsOf(content);
      if (elements.length === 0) return content;
      const wording = new RegExp(`${SOLUTION_KEY_POINT_PREFIX}`, 'gu');
      const clean = (html: string) => html.replace(wording, 'الإجابة الصحيحة');
      let changed = false;
      const next = elements.map((element) => {
        if (element.type === 'text' && typeof element.content === 'string') {
          const content = clean(element.content);
          if (content === element.content) return element;
          changed = true;
          return { ...element, content };
        }
        const inner = (element.text as { content?: unknown } | undefined)?.content;
        if (element.type === 'shape' && typeof inner === 'string') {
          const content = clean(inner);
          if (content === inner) return element;
          changed = true;
          return { ...element, text: { ...(element.text as object), content } };
        }
        return element;
      });
      if (!changed) return content;
      const record = content as Record<string, unknown>;
      return (
        Array.isArray(record.elements)
          ? { ...record, elements: next }
          : { ...record, canvas: { ...(record.canvas as object), elements: next } }
      ) as typeof content;
    },
    settleUnsolved(outline, content) {
      const original = plans.get(outline.id);
      const plan = effective(outline.id);
      if (!original || plan?.role !== 'solution') return { content, outline };
      const { blocks, text } = tagBlocks(content);
      // A slide that tags none of its exercises cannot be told: its lines stay.
      if (blocks.length === 0) return { content, outline };
      const slideNumbers = blockNumbers(text);
      const unsolved = plan.items.filter(
        (item) => item.element === 'exercise' && !solvedHere(item, blocks, slideNumbers),
      );
      if (unsolved.length === 0) return { content, outline };
      const labels = new Set(unsolved.map((item) => labelKey(item.display)));
      const stripped = editTexts(content, (html) =>
        withoutFinalLines(html, (label) => labels.has(labelKey(label))),
      );
      unverify(outline.id, unsolved);
      report(
        outline,
        'unverified',
        unsolved.map((item) => ({
          code: 'GUIDE_ANSWER_UNSOLVED',
          item,
          where: 'canvas',
          detail: 'the slide solves another item',
        })),
        { items: outcomes(unsolved, 'unverified') },
      );
      // Its key point and final-line instruction leave the outline the narration is
      // written from (and the persisted plan); a D-19 «left out» note stays.
      const leaveOut = original.items.filter((item) => removed.has(guideItemKey(item)));
      return {
        content: stripped,
        outline: withGuideItems(outline, original, effective(outline.id)?.items ?? [], leaveOut),
      };
    },
    checkContent(outline, content) {
      const plan = effective(outline.id);
      if (!plan || !content) return [];
      if (plan.role === 'solution') {
        // Re-review finding 1: its checks tried only later are leak-checked as on a try.
        return [
          ...solutionFindings(plan, content),
          ...leaks(plan.beforeTry ?? [], canvasLines(content).join('\n'), 'canvas'),
        ];
      }
      if (plan.role === 'attempt') return attemptFindings(plan, content);
      return leaks(plan.items, canvasLines(content).join('\n'), 'canvas');
    },
    checkNarration(outline, actions) {
      const plan = effective(outline.id);
      if (!plan) return [];
      if (plan.role === 'solution')
        return leaks(plan.beforeTry ?? [], spoken(actions), 'narration');
      return leaks(plan.items, spoken(actions), 'narration');
    },
    correction(outline, findings) {
      const lines = [
        'CORRECTION (checked final answers; state only these, never mention a guide):',
      ];
      const seen = new Set<string>();
      for (const finding of findings) {
        const key = `${finding.code}|${guideItemKey(finding.item)}|${finding.where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = finding.item.display;
        if (finding.code === 'GUIDE_ANSWER_LEAK') {
          // Review finding 7: a leak note names the item, never its value — the try's
          // writers must not learn the answer from their own correction.
          lines.push(
            finding.where === 'narration'
              ? `- The narration comes BEFORE the learner's try of item ${name}: never say, compute or hint its answer, and never say which option is correct; read the task only.`
              : finding.where === 'stem'
                ? `- The question on item ${name} is read BEFORE the try: never write its answer, or any hint of it, in the question text; keep it only as the correct option.`
                : `- This slide comes BEFORE the learner's try of item ${name}: never show, compute or hint its answer, and never say which option is correct; state the task and its givens only.`,
          );
        } else if (outline.type === 'quiz') {
          lines.push(
            `- The question on item ${name}: its correct option must be exactly ${formatGuideAnswer(finding.item.answer)}; put it among the options and mark it as the answer.`,
          );
        } else {
          lines.push(
            `- Item ${name}: the correct final answer is ${formatGuideAnswer(finding.item.answer)}. Its working must reach exactly this, and the item ends with the line «${finalAnswerLine(finding.item)}».`,
          );
        }
      }
      return lines.join('\n');
    },
    settle(outline, content, allFindings, settleOptions = {}) {
      const original = plans.get(outline.id);
      if (!original || allFindings.length === 0) return { kind: 'keep', content };
      const removal = settleOptions.removal !== false;
      // A try-it slide, and a solution slide's checks tried only later (re-review
      // finding 1), never had the answer: their retry was the plain path. Kept and
      // logged; the caller marks the slide for the reviewer (`guideLeakIssue`).
      const beforeTry = new Set((original.beforeTry ?? []).map(guideItemKey));
      const tryFindings =
        original.role === 'try'
          ? allFindings
          : allFindings.filter((finding) => beforeTry.has(guideItemKey(finding.item)));
      if (tryFindings.length > 0) {
        report(outline, 'unverified', tryFindings, {
          items: outcomes(uniqueItems(tryFindings), 'unverified'),
        });
      }
      const findings = allFindings.filter((finding) => !tryFindings.includes(finding));
      if (findings.length === 0) return { kind: 'keep', content };
      const failing = uniqueItems(findings);
      // What the outline still keys (re-review finding 6: an attempt's check items its
      // solution slide no longer reaches are out too).
      const keepOf = () => effective(outline.id)?.items ?? [];
      if (original.role === 'attempt') {
        const removable =
          removal &&
          findings.every(
            (finding) =>
              finding.item.element === 'exercise' &&
              Array.isArray(finding.questions) &&
              finding.questions.length > 0,
          );
        if (removable) {
          const set = faultyQuestions.get(outline.id) ?? new Set<number>();
          for (const finding of findings)
            for (const index of finding.questions ?? []) set.add(index);
          faultyQuestions.set(outline.id, set);
          report(outline, 'questions_removed', findings, {
            removedQuestions: [...set].sort((a, b) => a - b),
          });
          return { kind: 'keep', content };
        }
        unverify(outline.id, failing);
        report(outline, 'unverified', findings, { items: outcomes(failing, 'unverified') });
        return { kind: 'regenerate', outline: withGuideItems(outline, original, keepOf()) };
      }
      // A solution slide: an exercise leaves (D-19) while another question stays on the
      // slide and its attempt question can be told; any other item loses its guide answer.
      let leaving = removal
        ? failing.filter((item) => item.element === 'exercise' && attemptCanLose(outline.id, item))
        : [];
      const gone = new Set(
        [...original.items.filter((item) => removed.has(guideItemKey(item))), ...leaving].map(
          questionKey,
        ),
      );
      if ((original.solves ?? original.items.length) - gone.size < 1) leaving = [];
      // A question leaves whole: its other keyed parts («11b» beside «11a») leave with it.
      const leavingQuestions = new Set(leaving.map(questionKey));
      const removedNow = original.items.filter(
        (item) => leavingQuestions.has(questionKey(item)) && !removed.has(guideItemKey(item)),
      );
      for (const item of removedNow) removed.add(guideItemKey(item));
      const kept = failing.filter((item) => !removed.has(guideItemKey(item)));
      unverify(outline.id, kept);
      report(outline, removedNow.length > 0 ? 'items_removed' : 'unverified', findings, {
        items: [...outcomes(removedNow, 'removed'), ...outcomes(kept, 'unverified')],
      });
      const leaveOut = original.items.filter((item) => removed.has(guideItemKey(item)));
      return {
        kind: 'regenerate',
        outline: withGuideItems(outline, original, keepOf(), leaveOut),
      };
    },
    accept(outline, findings) {
      const original = plans.get(outline.id);
      if (!original || findings.length === 0) return;
      const failing = uniqueItems(findings);
      // Only an item the outline keys loses its key (never a check before its try).
      const keyed = new Set(original.items.map(guideItemKey));
      if (original.role !== 'try') {
        unverify(
          outline.id,
          failing.filter((item) => keyed.has(guideItemKey(item))),
        );
      }
      report(outline, 'unverified', findings, { items: outcomes(failing, 'unverified') });
    },
    settleNarration(outline, findings) {
      const original = plans.get(outline.id);
      if (original?.role === 'attempt') {
        report(outline, 'narration_replaced', findings);
        return 'model_free';
      }
      report(outline, 'unverified', findings, {
        items: outcomes(uniqueItems(findings), 'unverified'),
      });
      return 'keep';
    },
    solutionsOf(attemptId) {
      const plan = plans.get(attemptId);
      if (plan?.role !== 'attempt' || !attemptId.endsWith(ATTEMPT_OUTLINE_SUFFIX)) return [];
      const baseId = attemptId.slice(0, -ATTEMPT_OUTLINE_SUFFIX.length);
      if (plans.get(baseId)?.role === 'solution') return [baseId];
      // A check attempt: the solution slides of its items.
      const keys = new Set(plan.items.map(guideItemKey));
      return [...plans.entries()]
        .filter(
          ([id, other]) =>
            id !== attemptId &&
            other.role === 'solution' &&
            other.items.some((item) => keys.has(guideItemKey(item))),
        )
        .map(([id]) => id);
    },
    rekeyAttempt(outline) {
      const original = plans.get(outline.id);
      if (original?.role !== 'attempt') return undefined;
      const stale = keyedInAttempt(outline, original.items).filter(
        (item) => item.element === 'try_it' && unverifiedOnSolution(guideItemKey(item)),
      );
      if (stale.length === 0) return undefined;
      unverify(outline.id, stale);
      report(outline, 'unverified', [], { items: outcomes(stale, 'unverified') });
      return withGuideItems(outline, original, effective(outline.id)?.items ?? []);
    },
    pruneAttempt(outline, content) {
      const original = plans.get(outline.id);
      if (original?.role !== 'attempt') return { content };
      const questions = questionsOf(content);
      const faulty = new Set(faultyQuestions.get(outline.id) ?? []);
      // A removed exercise's question, when the quiz holds the questions it was planned with.
      if (original.questionCount === undefined || questions.length === original.questionCount) {
        for (const item of original.items) {
          const question = original.questionOf?.[guideItemKey(item)];
          if (removed.has(guideItemKey(item)) && question !== null && question !== undefined) {
            faulty.add(question);
          }
        }
      }
      if (faulty.size === 0) return { content };
      const kept = questions.filter((_question, index) => !faulty.has(index));
      if (kept.length === 0) {
        report(outline, 'attempt_dropped', [], {
          dropped: [outline.id],
          removedQuestions: [...faulty].sort((a, b) => a - b),
        });
        return { drop: true };
      }
      return { content: { ...(content as object), questions: kept } };
    },
  };
}

/**
 * A scene's content checked by the guard, with its one corrected regeneration and the
 * D-19 settlement (at most two more generations). `generate(outline, correction)` is
 * the caller's content call; it returns null when no content came back. `leaks`
 * (re-review finding 5c): what a kept SLIDE still states before the learner's try —
 * the pipeline marks the scene for the reviewer, a single-slide regeneration keeps the
 * slide as it was.
 */
export async function guardedSceneContent<T>(
  guard: GuideAnswerGuard,
  outline: SceneOutline,
  first: T,
  generate: (outline: SceneOutline, correction?: string) => Promise<T | null>,
  options: { removal?: boolean; onFinding?: (findings: GuideAnswerFinding[]) => void } = {},
): Promise<{ content: T; outline: SceneOutline; leaks: GuideAnswerFinding[] }> {
  const slideLeaks = (findings: readonly GuideAnswerFinding[]) =>
    outline.type === 'slide'
      ? findings.filter((finding) => finding.code === 'GUIDE_ANSWER_LEAK')
      : [];
  // Lesson 1-1 (16 Nov 2026): whatever is kept, a final line of an exercise the slide
  // does not solve leaves it (`settleUnsolved`) — no generation, never a pause.
  const kept = (content: T, from: SceneOutline, leaks: GuideAnswerFinding[]) => {
    const solved = guard.settleUnsolved(from, guard.cleanWording(from, content));
    return { content: solved.content, outline: solved.outline, leaks };
  };
  const findings = guard.checkContent(outline, first);
  if (findings.length === 0) return kept(first, outline, []);
  options.onFinding?.(findings);
  const retry = await generate(outline, guard.correction(outline, findings));
  const left = retry ? guard.checkContent(outline, retry) : findings;
  if (retry && left.length === 0) return kept(retry, outline, []);
  const decision = guard.settle(outline, retry ?? first, left, {
    ...(options.removal === false ? { removal: false } : {}),
  });
  if (decision.kind === 'keep') return kept(decision.content as T, outline, slideLeaks(left));
  const settled = (await generate(decision.outline)) ?? retry ?? first;
  const final = guard.checkContent(decision.outline, settled);
  guard.accept(decision.outline, final);
  return kept(settled, decision.outline, slideLeaks(final));
}
