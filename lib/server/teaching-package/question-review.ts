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
  questionReviewWire,
  releaseQuestionReviewLease,
  renewQuestionReviewLease,
  saveQuestionReviewAnswer,
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
export const QUESTION_REVIEW_LIMITS = {
  questions: { min: 1, max: 40 },
  textMax: 4_000,
  /**
   * L-6 / LOW-6: `correctAnswer` as its JSON text, after every string inside
   * it was cut to `textMax`.
   */
  correctAnswerMax: 16_000,
} as const;
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
  /** The run's abort signal: aborted when the sweep evicts a hung run (set by the job). */
  signal?: AbortSignal;
  /** LOW-6b: the book was cut; the book block says so in one sentence (set by the job). */
  bookTruncated?: boolean;
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
    stablePrompt: renderBookBlock(request.units, { truncated: request.bookTruncated === true }),
    prompt: renderQuestionsBlock(review),
    output: {
      kind: 'json',
      validate: (raw) => parseQuestionReviewAnswer(raw, ids),
      jsonSchema: QUESTION_REVIEW_SCHEMA,
    },
    ...(request.signal ? { signal: request.signal } : {}),
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
  /** The sweep's tracker: called after the claim and after the renewed lease. */
  onLeaseKept?: () => void;
  /** Aborted by the sweep when it evicts this run; the reviewer call stops with it. */
  signal?: AbortSignal;
  /** Test seam: the book read (production: `loadReviewBookUnits`). */
  loadBook?: typeof loadReviewBookUnits;
}

/**
 * The event (contract §3.4): verdicts and check codes, never the notes. The
 * verdicts travel only on a `completed` review (LOW-1).
 */
function completedPayload(review: QuestionReview) {
  const results = review.status === 'completed' ? review.results : [];
  return {
    questionReview: {
      id: review.id,
      versionId: review.versionId,
      requestId: review.requestId,
      status: review.status,
      provider: review.provider,
      model: review.model,
      results: results.map((result) => ({
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

  const finishInTransaction = (outcome: Parameters<typeof finishQuestionReview>[3]) =>
    nodePostgresTransaction(pool)(async (tx: Queryable) => {
      // LOW-1: an `unavailable` review keeps no verdicts, even a stored answer.
      const terminal = outcome.status === 'unavailable' ? { ...outcome, results: [] } : outcome;
      const finished = await finishQuestionReview(tx, claimed.id, workerId, terminal, now());
      if (!finished) return null;
      await enqueueWebhookEvent(
        tx,
        { tenantId: finished.tenantId, learningItem: finished.learningItem },
        'teaching_question_set.review_completed',
        () => completedPayload(finished),
      );
      return finished;
    });
  // HIGH-1: an evicted (aborted) run never finalizes — even if the revoke of
  // its lease failed — so the run that resumes the review owns its ending.
  const finish = async (outcome: Parameters<typeof finishQuestionReview>[3]) =>
    deps.signal?.aborted ? null : finishInTransaction(outcome);

  // M-4: once the paid answer is stored, a failure only lets the lease lapse;
  // the resume finishes from the stored answer instead of ending unavailable.
  // LOW-1: a stored answer counts only when it answers every sent question
  // (L-4: an incomplete one ends `unavailable`, never a second paid call).
  const storedAnswerUsable =
    claimed.reviewedAt !== null &&
    claimed.results.length === claimed.questions.length &&
    claimed.questions.every((question, index) => {
      return claimed.results[index]?.questionId === question.questionId;
    });
  let answerStored = storedAnswerUsable;
  try {
    // LOW-1: the claim cap comes first, so a finish that keeps failing still ends.
    if (claimed.runAttempts > MAX_QUESTION_REVIEW_RUN_ATTEMPTS) {
      return await finish({ status: 'unavailable', errorCode: 'REVIEW_ATTEMPTS_EXHAUSTED' });
    }
    if (storedAnswerUsable) {
      // A resume after the paid call: finish from the stored answer, never pay twice.
      return await finish({
        status: 'completed',
        results: claimed.results,
        provider: claimed.provider,
        model: claimed.model,
      });
    }
    if (claimed.reviewedAt !== null) {
      // L-4: a paid answer is stored but does not answer every question. A
      // resume never pays twice (contract), so fail closed instead.
      log.warn(`question review ${claimed.id}: the stored answer is incomplete`);
      return await finish({ status: 'unavailable', errorCode: 'STORED_ANSWER_INCOMPLETE' });
    }
    const retained = await readRetainedVersionContext(
      pool as unknown as Queryable,
      claimed.versionId,
      {
        tenantId: claimed.tenantId,
      },
    );
    if (!retained) return await finish({ status: 'unavailable', errorCode: 'NO_BOOK_SOURCE' });
    const book = await (deps.loadBook ?? loadReviewBookUnits)(pool as unknown as Queryable, {
      tenantId: claimed.tenantId,
      attemptId: retained.attemptId,
    });
    if (book.units.length === 0) {
      return await finish({ status: 'unavailable', errorCode: 'NO_BOOK_SOURCE' });
    }
    const subjectCode = (retained.inputSnapshot as { subjectCode?: unknown } | undefined)
      ?.subjectCode;
    // HIGH-1: the reads above may have stalled past the lease (evicted, or
    // claimed elsewhere): never start the paid call under a lost lease.
    if (deps.signal?.aborted) return null;
    const kept = await renewQuestionReviewLease(pool as unknown as Queryable, claimed.id, {
      workerId,
      now: now(),
      leaseMs: QUESTION_REVIEW_LEASE_MS,
    });
    // LOW-2 (as M-A): an eviction that lands while the renewal is in flight
    // still stops the paid call.
    if (!kept || deps.signal?.aborted) {
      log.warn(`question review ${claimed.id}: the lease moved on before the call`);
      return null;
    }
    deps.onLeaseKept?.();
    const answered = await (deps.callReviewer ?? callQuestionReviewer)({
      pool,
      review: claimed,
      units: book.units,
      attemptId: retained.attemptId,
      subjectCode: typeof subjectCode === 'string' ? subjectCode : 'UNKNOWN',
      bookTruncated: book.truncated,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const answer = {
      results: answered.results,
      provider: answered.call.provider,
      model: answered.call.modelString,
    };
    // An answer that arrives after the eviction is the resumed run's to get.
    if (deps.signal?.aborted) return null;
    // M-4: the paid answer is stored under the lease BEFORE the terminal write.
    if (
      !(await saveQuestionReviewAnswer(
        pool as unknown as Queryable,
        claimed.id,
        workerId,
        answer,
        now(),
      ))
    ) {
      log.warn(`question review ${claimed.id}: the lease moved on before the answer was stored`);
      return null;
    }
    answerStored = true;
    return await finish({ status: 'completed', ...answer });
  } catch (error) {
    // L-1: an evicted run's aborted call is not the review's failure; the
    // eviction exists so the review is resumed.
    if (deps.signal?.aborted) return null;
    if (answerStored && claimed.runAttempts < MAX_QUESTION_REVIEW_RUN_ATTEMPTS) {
      // The answer is kept: the lease lapses and the next sweep finishes from it.
      // Bounded: on the last allowed claim a failing finish falls through to
      // `unavailable` below, and a claim past the cap ends `unavailable` first.
      log.error(
        `question review ${claimed.id} could not be finalized; it resumes from the stored answer`,
        JSON.stringify(describeErrorSafely(error)),
      );
      return null;
    }
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
  } finally {
    // L-D: a run that stopped because it was evicted gives up its own lease at
    // once (best effort, exact owner), so the review is claimable now rather
    // than when the lease lapses — even when the sweep's revoke failed.
    if (deps.signal?.aborted) {
      void releaseQuestionReviewLease(pool as unknown as Queryable, claimed.id, {
        workerId,
        now: now(),
      }).catch((error: unknown) => {
        log.error(
          `question review ${claimed.id}: its own lease could not be released`,
          error instanceof Error ? error.name : 'Error',
        );
      });
    }
  }
}

/** The question reviews this process is running (see `sweepPackageReviews`). */
const runningQuestionReviews = new Map<
  string,
  { token: string; leaseOwner: string; leaseKeptAt: number; controller: AbortController }
>();

/**
 * Start or resume claimable question reviews in the background (the webhook
 * sweep), at most `MAX_QUESTION_REVIEWS_IN_FLIGHT` at once (D-6). A run that
 * has not kept its lease for a whole lease period is hung: it is evicted, its
 * reviewer call aborted and its lease revoked so the review can be resumed
 * (L-10, HIGH-1); every run claims under its own lease owner and renews it
 * before the paid call, so the evicted run neither pays nor writes if it wakes.
 */
export async function sweepQuestionReviews(
  deps: QuestionReviewDeps & { pool: ConnectableQueryable },
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  for (const [id, entry] of runningQuestionReviews) {
    if (now() - entry.leaseKeptAt > QUESTION_REVIEW_LEASE_MS) {
      runningQuestionReviews.delete(id);
      entry.controller.abort();
      log.warn(`question review ${id} did not keep its lease; evicted from this process`);
      // HIGH-1: revoke its lease, so the evicted run's later save or finish is
      // refused, even if no run resumes the review in this sweep. L-2: never
      // awaited, so a stuck run cannot hold up the sweep; the exact-owner guard
      // keeps a late revoke harmless.
      void releaseQuestionReviewLease(deps.pool as unknown as Queryable, id, {
        workerId: entry.leaseOwner,
        now: now(),
      }).catch((error: unknown) => {
        log.error(
          `question review ${id}: the evicted lease could not be revoked`,
          error instanceof Error ? error.name : 'Error',
        );
      });
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
    const entry = {
      token,
      leaseOwner: `${deps.workerId ?? currentWorkerId()}#${token}`,
      leaseKeptAt: now(),
      controller: new AbortController(),
    };
    runningQuestionReviews.set(id, entry);
    started.push(id);
    void runQuestionReview(id, {
      ...deps,
      workerId: entry.leaseOwner,
      onLeaseKept: () => {
        entry.leaseKeptAt = now();
      },
      signal: entry.controller.signal,
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

/**
 * The signed read model (contract §4.4) lives with the store, so the read
 * route never loads the reviewer call; re-exported here for the existing imports.
 */
export { questionReviewWire };

const CORRECT_ANSWER_MAX_DEPTH = 20;

/**
 * Every string inside `correctAnswer` cut to the text bound (values kept as
 * sent otherwise). Throws when the object nests deeper than
 * `CORRECT_ANSWER_MAX_DEPTH`.
 */
function trimStringLeaves(value: unknown, depth: number): unknown {
  const max = QUESTION_REVIEW_LIMITS.textMax;
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= CORRECT_ANSWER_MAX_DEPTH) throw new Error('nested too deeply');
  if (Array.isArray(value)) return value.map((item) => trimStringLeaves(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      trimStringLeaves(item, depth + 1),
    ]),
  );
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
    // L-6 / LOW-6: trimmed like the texts (contract §4.3): every string inside is
    // cut to the text bound; only an object still too large after that refuses.
    let correctAnswer: Record<string, unknown> | null = null;
    if (q.correctAnswer && typeof q.correctAnswer === 'object' && !Array.isArray(q.correctAnswer)) {
      try {
        correctAnswer = trimStringLeaves(q.correctAnswer, 0) as Record<string, unknown>;
      } catch {
        throw new Error(`questions[${index}].correctAnswer is nested too deeply`);
      }
      if (JSON.stringify(correctAnswer).length > QUESTION_REVIEW_LIMITS.correctAnswerMax) {
        throw new Error(
          `questions[${index}].correctAnswer must serialize to at most ${QUESTION_REVIEW_LIMITS.correctAnswerMax} characters`,
        );
      }
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
      correctAnswer,
      explanation:
        typeof q.explanation === 'string' && q.explanation.trim()
          ? clip(q.explanation, QUESTION_REVIEW_LIMITS.textMax)
          : null,
    };
  });
}
