/**
 * The asynchronous question-set review (ai-reviewer-layer plan §4.7, D-4).
 *
 * The question-set request itself stays synchronous and unchanged (180 s
 * Backend timeout). After Kafuo saved a generated set it asks for a review
 * (`POST …/question-reviews`, 202). The sweep runs it: the whole set in ONE
 * reviewer call, the book units sent once (a cache-marked block), checks
 * Q1–Q5, then `teaching_question_set.review_completed` with one verdict per
 * question. Kafuo dispatches the targeted repairs (one per failing question)
 * and asks again for the repaired questions only; the TE never edits Kafuo's
 * questions. The notes travel through the signed GET, never the webhook.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readRetainedVersionContext } from '@/lib/persistence/teaching-package';
import {
  runReviewerCall,
  type ReviewerCallResult,
} from '@/lib/server/teaching-model/reviewer-call';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import {
  loadReviewBookUnits,
  stripTags,
  type ReviewBookUnit,
} from '@/lib/server/teaching-package/package-review-input';
import {
  renderBookBlock,
  schemaInstruction,
  unwrapJsonAnswer,
} from '@/lib/server/teaching-package/package-review-prompt';
import {
  claimQuestionReview,
  finishQuestionReview,
  listClaimableQuestionReviewIds,
  type QuestionCheck,
  type QuestionFinding,
  type QuestionResult,
  type QuestionReview,
  type ReviewedQuestion,
} from '@/lib/server/teaching-package/question-review-store';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';

const log = createLogger('QuestionReview');

export const QUESTION_REVIEW_STAGE = 'question-review';
/** D-7: above one worst-case reviewer call (primary + fallback, 15 min each) with margin. */
export const QUESTION_REVIEW_LEASE_MS = 40 * 60 * 1000;
export const MAX_QUESTION_REVIEW_RUN_ATTEMPTS = 3;
/** D-6: question reviews this process runs at once. */
export const MAX_QUESTION_REVIEWS_IN_FLIGHT = 2;
export const QUESTION_REVIEW_LIMITS = { questions: { min: 1, max: 40 }, textMax: 4_000 } as const;
const QUESTION_CHECKS: readonly QuestionCheck[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const NOTE_MAX = 2_000;

const QUESTION_REVIEW_INSTRUCTIONS = `You are the senior subject reviewer of school assessment questions that were generated for one lesson of a Saudi textbook. You read the book text the lesson was built from and the lesson objective, then check every question against a fixed checklist. You only report real errors.

CHECKLIST (use exactly these codes)
- Q1: Solve the question yourself first. The marked answer is right, and no other choice is also right.
- Q2: The question is clear and has one reading.
- Q3: The question comes from this lesson's book text and measures the objective.
- Q4: The distractors (wrong choices) are plausible, not obviously wrong or silly.
- Q5: The answer explanation is correct.

RULES
- Every question gets exactly one result, with its question_id exactly as given.
- verdict "pass" has no findings; verdict "fail" has at least one finding.
- book_evidence.quote: the exact book words that decide it (at most two sentences); unit_id: the unit id, or "".
- what_is_wrong: one or two sentences in Arabic for the teacher.
- fix_note: one instruction in Arabic that a question writer can follow to fix exactly this error (for Q1, give the correct answer and the working).
- severity: high = a wrong answer is marked right or the question cannot be answered; medium = misleading or off the objective; low = small wording slip.
- Answer with JSON only, matching the schema.`;

export const QUESTION_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question_id', 'verdict', 'findings'],
        properties: {
          question_id: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['check', 'severity', 'book_evidence', 'what_is_wrong', 'fix_note'],
              properties: {
                check: { type: 'string', enum: [...QUESTION_CHECKS] },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                book_evidence: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['quote', 'unit_id'],
                  properties: { quote: { type: 'string' }, unit_id: { type: 'string' } },
                },
                what_is_wrong: { type: 'string' },
                fix_note: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

/** The schema is in the fixed instructions too: Sol answers in text mode (review finding H-1). */
export const QUESTION_REVIEW_SYSTEM = `${QUESTION_REVIEW_INSTRUCTIONS}\n\n${schemaInstruction(QUESTION_REVIEW_SCHEMA)}`;

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function renderQuestionsBlock(
  review: Pick<QuestionReview, 'objectiveRef' | 'objectiveText' | 'questions'>,
): string {
  const lines = [
    `OBJECTIVE (objectiveRef=${review.objectiveRef}): ${review.objectiveText ?? 'not given'}`,
    'QUESTIONS:',
  ];
  for (const question of review.questions) {
    lines.push(
      `<<QUESTION id=${question.questionId} | type=${question.questionType}${
        question.targetRole ? ` | role=${question.targetRole}` : ''
      }>>`,
      `STEM: ${stripTags(question.stem)}`,
    );
    if (question.choices.length > 0) {
      lines.push('CHOICES:');
      for (const choice of question.choices) {
        lines.push(
          `  (${choice.id}) ${stripTags(choice.text)}${choice.isCorrect ? '  [MARKED CORRECT]' : ''}`,
        );
      }
    }
    if (question.correctAnswer)
      lines.push(`CORRECT ANSWER: ${JSON.stringify(question.correctAnswer)}`);
    if (question.explanation) lines.push(`EXPLANATION: ${stripTags(question.explanation)}`);
    lines.push('<<END QUESTION>>');
  }
  return lines.join('\n');
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return clip(value, max);
}

/** One combined repair note per failing question (the Backend's slot findings). */
export function combinedFixNote(findings: readonly QuestionFinding[]): string | null {
  if (findings.length === 0) return null;
  const note = findings.map((finding) => `(${finding.check}) ${finding.fixNote}`).join('\n');
  return clip(note, NOTE_MAX);
}

/** Every sent question answered exactly once; otherwise the answer is unusable (→ fallback). */
export function parseQuestionReviewAnswer(
  raw: string,
  questionIds: readonly string[],
): QuestionResult[] {
  const value = JSON.parse(unwrapJsonAnswer(raw)) as { results?: unknown };
  if (!value || typeof value !== 'object' || !Array.isArray(value.results)) {
    throw new Error('results must be an array');
  }
  const wanted = new Set(questionIds);
  const byId = new Map<string, QuestionResult>();
  for (const entry of value.results as unknown[]) {
    const r = entry as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') throw new Error('a result must be an object');
    const questionId = text(r.question_id, 'question_id', 200);
    if (!wanted.has(questionId) || byId.has(questionId)) continue;
    if (!Array.isArray(r.findings)) throw new Error('findings must be an array');
    const findings: QuestionFinding[] = (r.findings as unknown[]).slice(0, 10).map((raw) => {
      const f = raw as Record<string, unknown>;
      const check = f.check as QuestionCheck;
      if (!QUESTION_CHECKS.includes(check)) throw new Error(`unknown check ${String(f.check)}`);
      const severity = f.severity;
      if (severity !== 'high' && severity !== 'medium' && severity !== 'low') {
        throw new Error(`unknown severity ${String(severity)}`);
      }
      const evidence = (f.book_evidence ?? {}) as Record<string, unknown>;
      return {
        check,
        severity,
        bookEvidence: {
          quote: text(evidence.quote, 'book_evidence.quote', 1_200),
          unitId: text(evidence.unit_id ?? '', 'book_evidence.unit_id', 200) || null,
        },
        whatIsWrong: text(f.what_is_wrong, 'what_is_wrong', NOTE_MAX),
        fixNote: text(f.fix_note, 'fix_note', NOTE_MAX),
      };
    });
    // A "pass" with findings is a fail; a "fail" without findings has nothing to fix.
    const verdict = findings.length > 0 ? 'fail' : 'pass';
    byId.set(questionId, { questionId, verdict, findings, fixNote: combinedFixNote(findings) });
  }
  const missing = questionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`the answer skipped ${missing.length} question(s)`);
  return questionIds.map((id) => byId.get(id)!);
}

export interface QuestionReviewCallRequest {
  review: QuestionReview;
  units: readonly ReviewBookUnit[];
  attemptId: string;
  subjectCode: string;
}

export interface QuestionReviewCallAnswer {
  results: QuestionResult[];
  call: Pick<ReviewerCallResult, 'provider' | 'modelString'>;
}

export async function callQuestionReviewer(
  request: QuestionReviewCallRequest & { pool: ConnectableQueryable },
): Promise<QuestionReviewCallAnswer> {
  const { review } = request;
  const ids = review.questions.map((question) => question.questionId);
  const call = await runReviewerCall({
    pool: request.pool,
    tenantId: review.tenantId,
    subjectCode: request.subjectCode,
    capability: 'question_review',
    stage: QUESTION_REVIEW_STAGE,
    association: {
      kind: 'generation',
      generationAttemptId: request.attemptId,
      versionId: review.versionId,
      learningItemType: review.learningItem.type,
      learningItemId: review.learningItem.id,
      questionSetRef: review.requestId,
      reviewId: review.id,
    },
    aggregate: { tenantId: review.tenantId, learningItem: review.learningItem },
    system: QUESTION_REVIEW_SYSTEM,
    stablePrompt: renderBookBlock(request.units),
    prompt: renderQuestionsBlock(review),
    output: {
      kind: 'json',
      validate: (raw) => parseQuestionReviewAnswer(raw, ids),
      jsonSchema: QUESTION_REVIEW_SCHEMA,
    },
  });
  return {
    results: call.parsed as QuestionResult[],
    call: { provider: call.provider, modelString: call.modelString },
  };
}

export interface QuestionReviewDeps {
  pool?: ConnectableQueryable;
  now?: () => number;
  workerId?: string;
  callReviewer?: (
    request: QuestionReviewCallRequest & { pool: ConnectableQueryable },
  ) => Promise<QuestionReviewCallAnswer>;
  /** The sweep's tracker: called after the claim. */
  onLeaseKept?: () => void;
}

/** The event (contract §3.4): verdicts and check codes, never the notes. */
function completedPayload(review: QuestionReview) {
  return {
    questionReview: {
      id: review.id,
      versionId: review.versionId,
      requestId: review.requestId,
      status: review.status,
      provider: review.provider,
      model: review.model,
      results: review.results.map((result) => ({
        questionId: result.questionId,
        verdict: result.verdict,
        checks: [...new Set(result.findings.map((finding) => finding.check))].sort(),
        autoFixable: result.verdict === 'fail' && result.fixNote !== null,
      })),
      errorCode: review.errorCode,
      completedAt: review.completedAt,
    },
  };
}

/** Run (or resume) one question review. Never throws; every exit emits the event. */
export async function runQuestionReview(
  reviewId: string,
  deps: QuestionReviewDeps = {},
): Promise<QuestionReview | null> {
  const pool =
    deps.pool ?? (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
  const now = deps.now ?? Date.now;
  const workerId = deps.workerId ?? currentWorkerId();
  const claimed = await claimQuestionReview(pool as unknown as Queryable, reviewId, {
    workerId,
    now: now(),
    leaseMs: QUESTION_REVIEW_LEASE_MS,
  });
  if (!claimed) return null;
  deps.onLeaseKept?.();

  const finish = (outcome: Parameters<typeof finishQuestionReview>[3]) =>
    nodePostgresTransaction(pool)(async (tx: Queryable) => {
      const finished = await finishQuestionReview(tx, claimed.id, workerId, outcome, now());
      if (!finished) return null;
      await enqueueWebhookEvent(
        tx,
        { tenantId: finished.tenantId, learningItem: finished.learningItem },
        'teaching_question_set.review_completed',
        () => completedPayload(finished),
      );
      return finished;
    });

  try {
    if (claimed.runAttempts > MAX_QUESTION_REVIEW_RUN_ATTEMPTS) {
      return await finish({ status: 'unavailable', errorCode: 'REVIEW_ATTEMPTS_EXHAUSTED' });
    }
    const retained = await readRetainedVersionContext(
      pool as unknown as Queryable,
      claimed.versionId,
      {
        tenantId: claimed.tenantId,
      },
    );
    if (!retained) return await finish({ status: 'unavailable', errorCode: 'NO_BOOK_SOURCE' });
    const book = await loadReviewBookUnits(pool as unknown as Queryable, {
      tenantId: claimed.tenantId,
      attemptId: retained.attemptId,
    });
    if (book.units.length === 0) {
      return await finish({ status: 'unavailable', errorCode: 'NO_BOOK_SOURCE' });
    }
    const subjectCode = (retained.inputSnapshot as { subjectCode?: unknown } | undefined)
      ?.subjectCode;
    const answered = await (deps.callReviewer ?? callQuestionReviewer)({
      pool,
      review: claimed,
      units: book.units,
      attemptId: retained.attemptId,
      subjectCode: typeof subjectCode === 'string' ? subjectCode : 'UNKNOWN',
    });
    return await finish({
      status: 'completed',
      results: answered.results,
      provider: answered.call.provider,
      model: answered.call.modelString,
    });
  } catch (error) {
    log.warn(
      `question review ${claimed.id} ended unavailable`,
      JSON.stringify(describeErrorSafely(error)),
    );
    const code = (error as { code?: unknown } | null)?.code;
    try {
      return await finish({
        status: 'unavailable',
        errorCode:
          code === 'TEACHING_MODEL_UNAVAILABLE' || code === 'SUBJECT_ROUTE_UNAVAILABLE'
            ? 'REVIEWER_UNAVAILABLE'
            : code === 'ACCOUNTING_UNAVAILABLE'
              ? 'ACCOUNTING_UNAVAILABLE'
              : 'REVIEW_FAILED',
      });
    } catch (finalizeError) {
      log.error(
        `question review ${claimed.id} could not be finalized`,
        JSON.stringify(describeErrorSafely(finalizeError)),
      );
      return null;
    }
  }
}

/** The question reviews this process is running (see `sweepPackageReviews`). */
const runningQuestionReviews = new Map<string, { token: string; leaseKeptAt: number }>();

/**
 * Start or resume claimable question reviews in the background (the webhook
 * sweep), at most `MAX_QUESTION_REVIEWS_IN_FLIGHT` at once (D-6). A run that
 * has held its claim for a whole lease without finishing is hung: it is
 * evicted so the review can be resumed (L-10); every run claims under its own
 * lease owner, so the evicted run writes nothing if it wakes up.
 */
export async function sweepQuestionReviews(
  deps: QuestionReviewDeps & { pool: ConnectableQueryable },
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  for (const [id, entry] of runningQuestionReviews) {
    if (now() - entry.leaseKeptAt > QUESTION_REVIEW_LEASE_MS) {
      runningQuestionReviews.delete(id);
      log.warn(`question review ${id} did not keep its lease; evicted from this process`);
    }
  }
  const free = MAX_QUESTION_REVIEWS_IN_FLIGHT - runningQuestionReviews.size;
  if (free <= 0) return [];
  let ids: string[] = [];
  try {
    ids = await listClaimableQuestionReviewIds(deps.pool as unknown as Queryable, now(), free);
  } catch (error) {
    log.error('question review sweep failed', JSON.stringify(describeErrorSafely(error)));
    return [];
  }
  const started: string[] = [];
  for (const id of ids) {
    if (runningQuestionReviews.has(id)) continue;
    const token = randomBytes(4).toString('hex');
    const entry = { token, leaseKeptAt: now() };
    runningQuestionReviews.set(id, entry);
    started.push(id);
    void runQuestionReview(id, {
      ...deps,
      workerId: `${deps.workerId ?? currentWorkerId()}#${token}`,
      onLeaseKept: () => {
        entry.leaseKeptAt = now();
      },
    })
      .catch((error) => {
        log.error(`question review ${id} crashed`, JSON.stringify(describeErrorSafely(error)));
      })
      .finally(() => {
        if (runningQuestionReviews.get(id)?.token === token) runningQuestionReviews.delete(id);
      });
  }
  return started;
}

/** Contract §4.4: the signed read model, notes included. */
export function questionReviewWire(review: QuestionReview) {
  return {
    id: review.id,
    versionId: review.versionId,
    requestId: review.requestId,
    status: review.status,
    provider: review.provider,
    model: review.model,
    results: review.results,
    errorCode: review.errorCode,
    completedAt: review.completedAt,
  };
}

/** Validate the 202 route body's questions (contract §4.3). Throws a message for INVALID_REQUEST. */
export function parseReviewedQuestions(value: unknown): ReviewedQuestion[] {
  const { min, max } = QUESTION_REVIEW_LIMITS.questions;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`questions must be an array of ${min}–${max} questions`);
  }
  const seen = new Set<string>();
  return (value as unknown[]).map((raw, index) => {
    const q = raw as Record<string, unknown> | null;
    if (!q || typeof q !== 'object') throw new Error(`questions[${index}] must be an object`);
    if (typeof q.questionId !== 'string' || !q.questionId.trim() || q.questionId.length > 200) {
      throw new Error(`questions[${index}].questionId must be a non-empty string`);
    }
    if (seen.has(q.questionId)) throw new Error(`questions[${index}].questionId is repeated`);
    seen.add(q.questionId);
    if (typeof q.stem !== 'string' || !q.stem.trim()) {
      throw new Error(`questions[${index}].stem must be a non-empty string`);
    }
    const choices = q.choices === undefined || q.choices === null ? [] : q.choices;
    if (!Array.isArray(choices) || choices.length > 12) {
      throw new Error(`questions[${index}].choices must be an array of at most 12 choices`);
    }
    return {
      questionId: q.questionId,
      questionType: typeof q.questionType === 'string' ? clip(q.questionType, 50) : 'unknown',
      targetRole: typeof q.targetRole === 'string' ? clip(q.targetRole, 100) : null,
      stem: clip(q.stem, QUESTION_REVIEW_LIMITS.textMax),
      choices: (choices as unknown[]).map((choice, choiceIndex) => {
        const c = choice as Record<string, unknown> | null;
        if (!c || typeof c.text !== 'string') {
          throw new Error(`questions[${index}].choices[${choiceIndex}].text must be a string`);
        }
        return {
          id: typeof c.id === 'string' && c.id ? clip(c.id, 50) : String(choiceIndex + 1),
          text: clip(c.text, QUESTION_REVIEW_LIMITS.textMax),
          isCorrect: c.isCorrect === true,
        };
      }),
      correctAnswer:
        q.correctAnswer && typeof q.correctAnswer === 'object' && !Array.isArray(q.correctAnswer)
          ? (q.correctAnswer as Record<string, unknown>)
          : null,
      explanation:
        typeof q.explanation === 'string' && q.explanation.trim()
          ? clip(q.explanation, QUESTION_REVIEW_LIMITS.textMax)
          : null,
    };
  });
}
