/**
 * g5.v11 (teacher-guide answer referee plan §8.3–8.5): the code safety net behind the
 * approved answers. Pure over the run's outline plans (`guideOutlinePlans`); the scene
 * pipeline (`classroom-generation.ts`) calls it, and only when the run carries one.
 *
 * - Comparator: each solution item's final line on the canvas («الإجابة (1A): 12») and
 *   each attempt question's keyed option are compared with the approved answer
 *   (`guide-answer-compare.ts`). A missing final line is a mismatch: it is the
 *   comparator's only reading of the canvas, and the writer was told to write it.
 * - Leak guard: no approved value on a try-it slide's canvas or narration, or in an
 *   attempt's question stem or narration (the right option among the options is fine).
 * - One regeneration with a correction naming only the correct final answer; still
 *   failing → the item leaves the lesson: an attempt question is removed (the attempt
 *   itself when no question is left or the question cannot be told), and a solution or
 *   a try-it slide leaves together with its group (never a try without its solution).
 */
import {
  compareGuideAnswer,
  leaksGuideAnswer,
  normalizeGuideDigits,
} from '@/lib/server/teaching-package/guide-answer-compare';
import {
  finalAnswerLine,
  formatGuideAnswer,
  SOLUTION_KEY_POINT_PREFIX,
  type GuideOutlinePlan,
  type KeyedGuideItem,
} from '@/lib/server/teaching-package/guide-answers';
import type { SceneOutline } from '@/lib/types/generation';

export type GuideAnswerFindingCode =
  | 'GUIDE_ANSWER_MISMATCH'
  | 'GUIDE_ANSWER_MISSING'
  | 'GUIDE_ANSWER_LEAK';

export interface GuideAnswerFinding {
  code: GuideAnswerFindingCode;
  item: KeyedGuideItem;
  where: 'canvas' | 'quiz' | 'stem' | 'narration';
  /** Attempts: the question indexes at fault; `null` when they cannot be told. */
  questions?: number[] | null;
  /** What was written instead, in a few words (never logged with the answer). */
  detail: string;
}

/** What happened to an outline whose finding outlived its one regeneration. */
export interface GuideAnswerSettlement {
  outlineId: string;
  action: 'questions_removed' | 'dropped';
  /** The outline ids that left the lesson (empty when only questions were removed). */
  dropped: string[];
  removedQuestions: number[];
  findings: Array<{
    code: GuideAnswerFindingCode;
    contentUnitId: string;
    label: string;
    where: string;
  }>;
}

export interface GuideAnswerGuard {
  /** The run's final plans (set when the outline is finalized, fresh or resumed). */
  usePlans(plans: ReadonlyMap<string, GuideOutlinePlan>): void;
  /** The plan of one outline, or undefined when it holds no keyed item. */
  planOf(outlineId: string): GuideOutlinePlan | undefined;
  /**
   * Deterministic clean-up of the content that is kept, AFTER the check (which skips
   * these lines): our own «الإجابة الصحيحة المعتمدة» wording, if a writer copied it,
   * leaves the canvas as «الإجابة الصحيحة».
   */
  cleanWording<T>(outline: SceneOutline, content: T): T;
  checkContent(outline: SceneOutline, content: unknown): GuideAnswerFinding[];
  checkNarration(
    outline: SceneOutline,
    actions: ReadonlyArray<{ type: string; text?: unknown }>,
  ): GuideAnswerFinding[];
  /** The one regeneration's correction: the correct final answers only, never a method. */
  correction(outline: SceneOutline, findings: readonly GuideAnswerFinding[]): string;
  /**
   * Still failing after the one regeneration: the content to keep (an attempt without
   * its faulty questions) or the outline ids that leave the lesson. `content` is null
   * for a narration finding.
   */
  settle(
    outline: SceneOutline,
    content: unknown,
    findings: readonly GuideAnswerFinding[],
  ): { content: unknown } | { drop: string[] };
}

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

export function createGuideAnswerGuard(options: {
  /** The book text of each unit (verses and hadith already removed), by unit id. */
  unitTexts: ReadonlyMap<string, string>;
  /** Called once per settled outline (for the attempt snapshot and the log). */
  onSettled?: (settlement: GuideAnswerSettlement) => void;
}): GuideAnswerGuard {
  let plans: ReadonlyMap<string, GuideOutlinePlan> = new Map();
  const bookText = (item: KeyedGuideItem) => options.unitTexts.get(item.contentUnitId) ?? '';

  const leaks = (
    items: readonly KeyedGuideItem[],
    text: string,
    where: GuideAnswerFinding['where'],
  ): GuideAnswerFinding[] =>
    items
      .filter((item) => leaksGuideAnswer(item.answer, text, bookText(item)))
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
      if (candidates.some((line) => compareGuideAnswer(item.answer, line.value).match)) return [];
      const reason = compareGuideAnswer(item.answer, candidates[candidates.length - 1]!.value);
      return [
        { code: 'GUIDE_ANSWER_MISMATCH', item, where: 'canvas', detail: reason.reason ?? '' },
      ];
    });
  };

  const attemptFindings = (plan: GuideOutlinePlan, content: unknown): GuideAnswerFinding[] => {
    const questions = questionsOf(content);
    const findings: GuideAnswerFinding[] = [];
    for (const item of plan.items) {
      if (item.answer.type === 'choice') {
        // The book's options in the book's order: the keyed letter is the book's.
        const keyed = questions.some((question) =>
          keyedValues(question).some((value) => compareGuideAnswer(item.answer, value).match),
        );
        if (!keyed) {
          findings.push({
            code: 'GUIDE_ANSWER_MISMATCH',
            item,
            where: 'quiz',
            questions: null,
            detail: 'no question keys that option',
          });
        }
        continue;
      }
      const offering: number[] = [];
      let keyed = false;
      questions.forEach((question, index) => {
        const right = (question.options ?? []).filter(
          (option) =>
            typeof option.label === 'string' && compareGuideAnswer(item.answer, option.label).match,
        );
        if (right.length === 0) return;
        offering.push(index);
        const values = keyedValues(question);
        if (right.some((option) => values.includes(String(option.value)))) keyed = true;
      });
      if (!keyed) {
        findings.push({
          code: 'GUIDE_ANSWER_MISMATCH',
          item,
          where: 'quiz',
          questions: offering.length > 0 ? offering : null,
          detail: offering.length > 0 ? 'another option is keyed' : 'the answer is not an option',
        });
      }
    }
    // The stems are read before the try: no approved value in any of them.
    questions.forEach((question, index) => {
      const stem = typeof question.question === 'string' ? decode(question.question) : '';
      for (const finding of leaks(plan.items, stem, 'stem')) {
        findings.push({ ...finding, questions: [index] });
      }
    });
    return findings;
  };

  return {
    usePlans(next) {
      plans = next;
    },
    planOf(outlineId) {
      return plans.get(outlineId);
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
    checkContent(outline, content) {
      const plan = plans.get(outline.id);
      if (!plan || !content) return [];
      if (plan.role === 'solution') return solutionFindings(plan, content);
      if (plan.role === 'attempt') return attemptFindings(plan, content);
      return leaks(plan.items, canvasLines(content).join('\n'), 'canvas');
    },
    checkNarration(outline, actions) {
      const plan = plans.get(outline.id);
      if (!plan || plan.role === 'solution') return [];
      return leaks(plan.items, spoken(actions), 'narration');
    },
    correction(outline, findings) {
      const lines = [
        'CORRECTION (checked final answers; state only these, never mention a guide):',
      ];
      const seen = new Set<string>();
      for (const finding of findings) {
        const key = `${finding.code}|${finding.item.contentUnitId}|${finding.item.label}|${finding.where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const answer = formatGuideAnswer(finding.item.answer);
        const name = finding.item.display;
        if (finding.code === 'GUIDE_ANSWER_LEAK') {
          lines.push(
            finding.where === 'narration'
              ? `- The narration comes BEFORE the learner's try of item ${name}: never say, compute or hint its answer (${answer}); read the task only.`
              : finding.where === 'stem'
                ? `- The question on item ${name} is read BEFORE the try: never write its answer (${answer}) in the question text; keep it only as the correct option.`
                : `- This slide comes BEFORE the learner's try of item ${name}: never show, compute or hint its answer (${answer}); state the task and its givens only.`,
          );
        } else if (outline.type === 'quiz') {
          lines.push(
            `- The question on item ${name}: its correct option must be exactly ${answer}; put it among the options and mark it as the answer.`,
          );
        } else {
          lines.push(
            `- Item ${name}: the correct final answer is ${answer}. Its working must reach exactly this, and the item ends with the line «${finalAnswerLine(finding.item)}».`,
          );
        }
      }
      return lines.join('\n');
    },
    settle(outline, content, findings) {
      const plan = plans.get(outline.id);
      const summary = findings.map((finding) => ({
        code: finding.code,
        contentUnitId: finding.item.contentUnitId,
        label: finding.item.label,
        where: finding.where,
      }));
      const drop = (ids: string[]) => {
        options.onSettled?.({
          outlineId: outline.id,
          action: 'dropped',
          dropped: ids,
          removedQuestions: [],
          findings: summary,
        });
        return { drop: ids };
      };
      if (plan?.role !== 'attempt') return drop(plan?.group.length ? plan.group : [outline.id]);
      if (content === null || findings.some((finding) => !finding.questions)) {
        return drop([outline.id]);
      }
      const faulty = new Set(findings.flatMap((finding) => finding.questions ?? []));
      const questions = questionsOf(content);
      const kept = questions.filter((_question, index) => !faulty.has(index));
      if (kept.length === 0) return drop([outline.id]);
      options.onSettled?.({
        outlineId: outline.id,
        action: 'questions_removed',
        dropped: [],
        removedQuestions: [...faulty].sort((a, b) => a - b),
        findings: summary,
      });
      return { content: { ...(content as object), questions: kept } };
    },
  };
}
