/**
 * Owner decision (17 Nov 2026): the learner's WRITTEN attempt at a teacher-guide item
 * whose guide answer is a proof or an open «إجابة ممكنة» answer, graded AFTER submission
 * by the Kafuo Backend against the guide's model answer. The learner sees only the
 * Backend's short verdict and feedback, never the model answer.
 *
 * Where the written attempt is created: in the existing attempt-quiz flow. For each such
 * item a SOLUTION slide solves (its plan's `modelAnswers`, so the lesson teaches it), the
 * ENGINE appends one `short_answer` question to the attempt the learner meets before that
 * slide — an exercise item to its solution slide's own attempt (`<slide>-attempt`), a
 * check item to the attempt after the first try-it slide that states it. The model never
 * writes it, so no stem has to be matched back to an item:
 * - its text is OUR question, the book's own text of the item (`guideItemOwnText`, never
 *   normalized) after a fixed lead line — never the guide's text;
 * - it carries no key, explanation or rubric (`hasAnswer: false`), and two points (W5);
 * - it goes after the quiz's own questions, so the guard's question indexes never move.
 *
 * The stamp: the question's id is minted from the guide and the item
 * ({@link guideWrittenQuestionId}), so the server-side map from a question id to its
 * `guideRef: { contentUnitId, label }` is rebuilt at grading time from the package's
 * PINNED guide ({@link guideWrittenAnswers}) — nothing is stored on the question (no
 * `@openmaic/dsl` change), nothing beyond the opaque id reaches a learner, and a resumed
 * run or a regeneration mints the same id.
 */
import { createHash } from 'node:crypto';

import { ATTEMPT_OUTLINE_SUFFIX } from '@/lib/server/teaching-package/attempt-quizzes';
import {
  guideItemKey,
  guideItemOwnText,
  hasGuideModelAnswer,
  type GuideOutlinePlan,
  type ModelAnswerGuideItem,
} from '@/lib/server/teaching-package/guide-answers';
import type { SceneOutline } from '@/lib/types/generation';
import type { QuizQuestion } from '@/lib/types/stage';
import type { KafuoTeacherGuide } from '@/lib/types/teaching-package';

/** The model-answer kinds graded as a written answer (a `figure` never is). */
export type GuideWrittenKind = 'proof' | 'possible';

/** The guide item a written question asks: OUR content unit and OUR item label. */
export interface GuideRef {
  contentUnitId: string;
  label: string;
}

const WRITTEN_ID_PREFIX = 'q_guide_';
const WRITTEN_ID = /^q_guide_[0-9a-f]{20}$/;

/** The id of the written question of one guide item: stable for one guide, opaque. */
export function guideWrittenQuestionId(guideId: string, ref: GuideRef): string {
  const digest = createHash('sha256')
    .update(`${guideId}\n${ref.contentUnitId}\n${ref.label}`)
    .digest('hex');
  return `${WRITTEN_ID_PREFIX}${digest.slice(0, 20)}`;
}

/** A question id the engine minted for a written guide attempt. */
export function isGuideWrittenQuestionId(id: unknown): boolean {
  return typeof id === 'string' && WRITTEN_ID.test(id);
}

/** The fixed lead line before the book's question. */
const WRITTEN_LEAD: Readonly<Record<GuideWrittenKind, string>> = {
  proof: 'اكتب البرهان بنفسك خطوةً بخطوة، مع سبب كل خطوة:',
  possible: 'اكتب إجابتك بنفسك، بكلماتك:',
};

/** At most this many characters in a written question (cut with «…»). */
export const WRITTEN_QUESTION_MAX_CHARS = 2_000;

function writtenKind(item: ModelAnswerGuideItem): GuideWrittenKind | null {
  const kind = item.modelAnswer.kind;
  return kind === 'proof' || kind === 'possible' ? kind : null;
}

/** One written question and the item it asks. */
export interface GuideWrittenQuestion {
  ref: GuideRef;
  /** The book question it asks (`unit|number`, `unit|*` for a unit solved whole). */
  questionKey: string;
  question: QuizQuestion;
}

/** The written questions of one attempt outline. */
export interface GuideWrittenAttempt {
  /** The solution slides that solve its items (their settlement comes first). */
  solutionIds: string[];
  questions: GuideWrittenQuestion[];
}

function writtenQuestion(
  guideId: string,
  item: ModelAnswerGuideItem,
  kind: GuideWrittenKind,
  own: string,
): QuizQuestion {
  const stem = `${WRITTEN_LEAD[kind]}\n${own}`;
  return {
    id: guideWrittenQuestionId(guideId, item),
    type: 'short_answer',
    question:
      stem.length <= WRITTEN_QUESTION_MAX_CHARS
        ? stem
        : `${stem.slice(0, WRITTEN_QUESTION_MAX_CHARS - 1).trimEnd()}…`,
    hasAnswer: false,
    points: 2,
  };
}

function cites(outline: SceneOutline, unitId: string): boolean {
  return (outline.sourceContentUnitIds ?? []).map(String).includes(unitId);
}

/**
 * The attempt the learner meets before the solution slide at `solutionAt` for `item`:
 * an exercise's own attempt; a check's attempt after the first try-it slide that states
 * it and has one. Null when there is none before the slide.
 */
function attemptBefore(
  outlines: readonly SceneOutline[],
  solutionAt: number,
  item: ModelAnswerGuideItem,
): string | null {
  const indexOf = (id: string) => outlines.findIndex((outline) => outline.id === id);
  const quizBefore = (id: string) => {
    const at = indexOf(id);
    return at >= 0 && at < solutionAt && outlines[at]!.type === 'quiz';
  };
  if (item.element === 'exercise') {
    const id = `${outlines[solutionAt]!.id}${ATTEMPT_OUTLINE_SUFFIX}`;
    return quizBefore(id) ? id : null;
  }
  for (let at = 0; at < solutionAt; at += 1) {
    const outline = outlines[at]!;
    if (outline.type !== 'slide' || outline.contentRole !== 'check_understanding') continue;
    if (!cites(outline, item.contentUnitId)) continue;
    const id = `${outline.id}${ATTEMPT_OUTLINE_SUFFIX}`;
    if (quizBefore(id)) return id;
  }
  return null;
}

/**
 * The run's written attempts, by attempt outline id: one question per proof or
 * «إجابة ممكنة» item a solution slide solves (each item once, at its first solution),
 * when an attempt comes before that slide and the book prints the item.
 */
export function guideWrittenAttempts(
  outlines: readonly SceneOutline[],
  plans: ReadonlyMap<string, GuideOutlinePlan>,
  options: { guideId: string; unitTexts: ReadonlyMap<string, string> },
): Map<string, GuideWrittenAttempt> {
  const attempts = new Map<string, GuideWrittenAttempt>();
  const seen = new Set<string>();
  outlines.forEach((outline, at) => {
    const plan = plans.get(outline.id);
    if (outline.type !== 'slide' || plan?.role !== 'solution') return;
    for (const item of plan.modelAnswers ?? []) {
      const kind = writtenKind(item);
      const key = guideItemKey(item);
      if (kind === null || seen.has(key)) continue;
      const attemptId = attemptBefore(outlines, at, item);
      if (attemptId === null) continue;
      const own = guideItemOwnText(options.unitTexts.get(item.contentUnitId) ?? '', item);
      if (own === null) continue;
      seen.add(key);
      const attempt = attempts.get(attemptId) ?? { solutionIds: [], questions: [] };
      if (!attempt.solutionIds.includes(outline.id)) attempt.solutionIds.push(outline.id);
      attempt.questions.push({
        ref: { contentUnitId: item.contentUnitId, label: item.label },
        questionKey: `${item.contentUnitId}|${item.number ?? '*'}`,
        question: writtenQuestion(options.guideId, item, kind, own),
      });
      attempts.set(attemptId, attempt);
    }
  });
  return attempts;
}

/**
 * The quiz content with `questions` as its written questions: any written question it
 * already holds out, these appended after its own. The SAME object when it holds none
 * and none is added.
 */
export function withGuideWrittenQuestions<T>(content: T, questions: readonly QuizQuestion[]): T {
  const own = (content as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(own)) return content;
  const kept = own.filter(
    (question) => !isGuideWrittenQuestionId((question as { id?: unknown } | null)?.id),
  );
  if (kept.length === own.length && questions.length === 0) return content;
  return {
    ...(content as object),
    questions: [...kept, ...questions.map((question) => ({ ...question }))],
  } as T;
}

// ── Grading (`quiz-grades`) ───────────────────────────────────────────────────────────

/** The bound of `gradingContext.questionText` / `.modelAnswer` (the Backend's too). */
export const MAX_GRADING_CONTEXT_CHARS = 4_000;

/**
 * The service-only context the Backend grades a written answer with. Never stored,
 * never in a learner payload: only `quiz-grades` (service auth) returns it.
 */
export interface GuideGradingContext {
  questionText: string;
  modelAnswer: string;
  kind: GuideWrittenKind;
}

/** A pinned proof or «إجابة ممكنة» item, by the id of its written question. */
export interface GuideWrittenAnswer {
  ref: GuideRef;
  kind: GuideWrittenKind;
  modelAnswer: string;
}

/**
 * The server-side map from a written question's id to its `guideRef` and model answer,
 * rebuilt from the package's PINNED guide (the attempt snapshot), never from live data.
 * The first item of a ref wins.
 */
export function guideWrittenAnswers(
  guide: KafuoTeacherGuide | null | undefined,
): Map<string, GuideWrittenAnswer> {
  const answers = new Map<string, GuideWrittenAnswer>();
  if (!guide || typeof guide.guideId !== 'string' || !Array.isArray(guide.items)) return answers;
  for (const item of guide.items) {
    if (!item || typeof item !== 'object' || !hasGuideModelAnswer(item)) continue;
    const { kind, text } = item.modelAnswer as { kind: unknown; text?: unknown };
    if ((kind !== 'proof' && kind !== 'possible') || typeof text !== 'string') continue;
    if (typeof item.contentUnitId !== 'string' || typeof item.label !== 'string') continue;
    const id = guideWrittenQuestionId(guide.guideId, item);
    if (answers.has(id)) continue;
    answers.set(id, {
      ref: { contentUnitId: item.contentUnitId, label: item.label },
      kind,
      modelAnswer: text,
    });
  }
  return answers;
}

function withinBound(text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== '' && text.length <= MAX_GRADING_CONTEXT_CHARS;
}

/** The grading context, or null unless both texts are non-blank and within the bound. */
export function guideGradingContext(
  questionText: unknown,
  answer: GuideWrittenAnswer,
): GuideGradingContext | null {
  if (!withinBound(questionText) || !withinBound(answer.modelAnswer)) return null;
  return { questionText, modelAnswer: answer.modelAnswer, kind: answer.kind };
}
