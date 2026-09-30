/**
 * Learner quiz delivery and server-side grading for Teaching Package Stages.
 *
 * A quiz scene stores its grading secrets beside its prompts: the answer key
 * (`answer`), the explanation (`analysis`), the short-answer rubric
 * (`commentPrompt`) and `hasAnswer`. A learner client that received them could
 * read every correct answer out of the network response, so:
 *
 * - {@link sanitizeLearnerDelivery} rebuilds every quiz payload a LEARNER grant
 *   reads through an ALLOWLIST — `{ type, questions: [{ id, type, question,
 *   options: [{ label, value }], points }] }` — and nothing else survives. An
 *   allowlist, so a grading field added later is withheld by default. It
 *   returns new objects and never mutates its input.
 * - {@link gradeLearnerQuiz} grades a submission against the TRUSTED stored
 *   scene of the exact version the caller names. The client sends only
 *   question ids and answers; points, keys and verdicts are the server's.
 *
 * Verdict semantics are the ones learners already had (`lib/quiz/grading.ts`
 * and the Kafuo app's local grader), now computed here:
 * - choice: exact set match against the resolved key;
 * - keyed short answer: normalized match against any accepted answer;
 * - unkeyed short answer: `pending_review` — not wrong, not counted;
 * - a choice question whose key does not resolve to its options:
 *   `not_gradable` — also not counted.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { readVersion } from '@/lib/persistence/teaching-package';
import { resolveAnswerKeyToValue, toArray } from '@/lib/quiz/grading';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { LEARNER_HANDOFF_STATUSES } from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { AppScene, QuizQuestion } from '@/lib/types/stage';

import { isQuizContent, isRecord } from './learner-quiz-delivery';

export { sanitizeLearnerDelivery } from './learner-quiz-delivery';

// --------------------------------------------------------------------------
// Short-answer normalization (parity with the Kafuo app's normalizeAnswerText)
// --------------------------------------------------------------------------

/** Tashkeel U+064B–U+0652, Quranic marks U+0653–U+0655, superscript alef U+0670, tatweel U+0640. */
const ARABIC_MARKS = /[ً-ٰٕـ]/g;
const ALEF_FORMS = new Set(['أ', 'إ', 'آ', 'ٱ']);

/**
 * Trim, collapse whitespace, lower-case, and fold Arabic orthography: strip
 * diacritics and tatweel, unify alef forms, ة→ه, ى→ي, Arabic-Indic digits→ASCII.
 */
export function normalizeAnswerText(value: string): string {
  let out = '';
  for (const char of value.replace(ARABIC_MARKS, '')) {
    const code = char.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (ALEF_FORMS.has(char)) out += 'ا';
    else if (char === 'ة') out += 'ه';
    else if (char === 'ى') out += 'ي';
    else out += char;
  }
  return out.trim().replace(/\s+/g, ' ').toLowerCase();
}

// --------------------------------------------------------------------------
// Grading
// --------------------------------------------------------------------------

export type LearnerGradeStatus =
  | 'correct'
  | 'incorrect'
  | 'unanswered'
  | 'pending_review'
  | 'not_gradable';

export interface LearnerQuestionGrade {
  questionId: string;
  status: LearnerGradeStatus;
  earned: number;
  possible: number;
  /** Present only when the caller's policy reveals answers after submission. */
  correctAnswer?: string[];
  explanation?: string;
}

export interface LearnerQuizGrade {
  versionId: string;
  stageId: string;
  sceneId: string;
  results: LearnerQuestionGrade[];
  /** Sum over `correct` / `incorrect` / `unanswered` only. */
  earned: number;
  possible: number;
  /** Points held back as `pending_review` / `not_gradable`; never counted as wrong. */
  pendingPossible: number;
}

export interface LearnerQuizGradeRequest {
  versionId: string;
  tenantId: string;
  sceneId: string;
  answers: Record<string, string[]>;
  reveal: boolean;
}

export const MAX_ANSWER_ENTRIES = 32;
export const MAX_ANSWER_CHARS = 2_000;
export const MAX_QUESTIONS = 200;

function invalid(message: string): never {
  throw new TeachingPackageError('INVALID_REQUEST', message);
}

/** Validates the untrusted answers map shape and bounds. Returns a clean copy. */
export function parseLearnerAnswers(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) invalid('answers must be an object keyed by question id');
  const entries = Object.entries(value);
  if (entries.length > MAX_QUESTIONS) invalid('too many answered questions');
  const answers: Record<string, string[]> = {};
  for (const [questionId, raw] of entries) {
    if (
      !Array.isArray(raw) ||
      raw.length > MAX_ANSWER_ENTRIES ||
      raw.some((entry) => typeof entry !== 'string' || entry.length > MAX_ANSWER_CHARS)
    ) {
      invalid(`answers.${questionId} must be a short list of strings`);
    }
    answers[questionId] = [...(raw as string[])];
  }
  return answers;
}

function isAnswered(entries: string[] | undefined): entries is string[] {
  return !!entries && entries.some((entry) => entry.trim() !== '');
}

function gradeQuestion(
  question: QuizQuestion,
  submitted: string[] | undefined,
  reveal: boolean,
): LearnerQuestionGrade {
  const possible = typeof question.points === 'number' ? question.points : 1;
  const key = toArray(question.answer);
  const revealed = (): Pick<LearnerQuestionGrade, 'correctAnswer' | 'explanation'> => {
    if (!reveal) return {};
    const explanation = question.analysis?.trim();
    const correctAnswer =
      question.type === 'short_answer' ? key : key.map((a) => resolveAnswerKeyToValue(question, a));
    return {
      ...(correctAnswer.length > 0 ? { correctAnswer } : {}),
      ...(explanation ? { explanation } : {}),
    };
  };
  const base = { questionId: question.id, possible };

  if (question.type === 'short_answer') {
    const accepted = key.map(normalizeAnswerText).filter((entry) => entry !== '');
    if (accepted.length === 0) {
      // No key: a teacher or a model must judge it. Not wrong, not counted.
      return { ...base, status: 'pending_review', earned: 0, ...revealed() };
    }
    if (!isAnswered(submitted)) return { ...base, status: 'unanswered', earned: 0, ...revealed() };
    const correct = accepted.includes(normalizeAnswerText(submitted[0]!));
    return {
      ...base,
      status: correct ? 'correct' : 'incorrect',
      earned: correct ? possible : 0,
      ...revealed(),
    };
  }

  const values = new Set((question.options ?? []).map((option) => option.value));
  const resolved = [...new Set(key.map((a) => resolveAnswerKeyToValue(question, a)))];
  if (resolved.length === 0 || resolved.some((value) => !values.has(value))) {
    return { ...base, status: 'not_gradable', earned: 0, ...revealed() };
  }
  if (!isAnswered(submitted)) return { ...base, status: 'unanswered', earned: 0, ...revealed() };
  const given = [...new Set(submitted)];
  const correct =
    given.every((value) => values.has(value)) &&
    (question.type !== 'single' || given.length === 1) &&
    given.length === resolved.length &&
    given.every((value) => resolved.includes(value));
  return {
    ...base,
    status: correct ? 'correct' : 'incorrect',
    earned: correct ? possible : 0,
    ...revealed(),
  };
}

const COUNTED: ReadonlySet<LearnerGradeStatus> = new Set(['correct', 'incorrect', 'unanswered']);

/** Pure grading of one stored quiz scene. Exported for tests. */
export function gradeQuizQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string[]>,
  reveal: boolean,
): Pick<LearnerQuizGrade, 'results' | 'earned' | 'possible' | 'pendingPossible'> {
  const known = new Set(questions.map((question) => question.id));
  const unknown = Object.keys(answers).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new TeachingPackageError(
      'QUIZ_QUESTION_NOT_IN_SCENE',
      'the submission names questions that are not in this quiz scene',
      { unknownQuestionIds: unknown.slice(0, 20) },
    );
  }
  const results = questions.map((question) => gradeQuestion(question, answers[question.id], reveal));
  let earned = 0;
  let possible = 0;
  let pendingPossible = 0;
  for (const result of results) {
    if (COUNTED.has(result.status)) {
      earned += result.earned;
      possible += result.possible;
    } else {
      pendingPossible += result.possible;
    }
  }
  return { results, earned, possible, pendingPossible };
}

/**
 * Grades a learner submission against the stored quiz scene of EXACTLY
 * `versionId` in `tenantId`. The version must be one a learner may be served
 * (`approved`, or `superseded` for a session pinned before a successor), and
 * the scene must be a quiz of that version's own Stage.
 */
export async function gradeLearnerQuiz(
  pool: Queryable,
  request: LearnerQuizGradeRequest,
): Promise<LearnerQuizGrade> {
  const version = await readVersion(pool, request.versionId, { tenantId: request.tenantId });
  if (!version) {
    throw new TeachingPackageError('NOT_FOUND', `teaching package ${request.versionId} not found`);
  }
  if (!(LEARNER_HANDOFF_STATUSES as readonly string[]).includes(version.status)) {
    throw new TeachingPackageError(
      'TEACHING_PACKAGE_NOT_APPROVED',
      `a ${version.status} version cannot be graded for a learner`,
    );
  }
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the pinned version’s stage is not live');
  }
  const scene = (document.scenes as AppScene[]).find((entry) => entry.id === request.sceneId);
  const content = (scene as { content?: unknown } | undefined)?.content;
  if (!scene || !isQuizContent(content)) {
    throw new TeachingPackageError(
      'QUIZ_SCENE_NOT_FOUND',
      'the scene is not a quiz of the pinned version’s stage',
    );
  }
  return {
    versionId: version.id,
    stageId: version.currentStageId,
    sceneId: scene.id,
    ...gradeQuizQuestions(
      (content.questions as QuizQuestion[]).filter(
        (question) => isRecord(question) && typeof question.id === 'string',
      ),
      request.answers,
      request.reveal,
    ),
  };
}
