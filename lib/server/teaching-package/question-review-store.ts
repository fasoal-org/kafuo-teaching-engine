/**
 * `teaching_question_reviews` rows (ai-reviewer-layer plan §4.7, contract §4.3).
 *
 * `queued` (inserted by the 202 route; a replay of the same Kafuo `requestId`
 * answers the existing row) → `running` (claimed under a lease) → `completed`
 * or `unavailable`, written in the transaction that enqueues
 * `teaching_question_set.review_completed`. Epoch milliseconds.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import type { FindingSeverity } from '@/lib/server/teaching-package/package-review-prompt';

export type QuestionReviewStatus = 'queued' | 'running' | 'completed' | 'unavailable';
export type QuestionCheck = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export interface ReviewedQuestion {
  questionId: string;
  questionType: string;
  targetRole: string | null;
  stem: string;
  choices: Array<{ id: string; text: string; isCorrect: boolean }>;
  correctAnswer: Record<string, unknown> | null;
  explanation: string | null;
}

export interface QuestionFinding {
  check: QuestionCheck;
  severity: FindingSeverity;
  bookEvidence: { quote: string; unitId: string | null };
  whatIsWrong: string;
  fixNote: string;
}

export interface QuestionResult {
  questionId: string;
  verdict: 'pass' | 'fail';
  findings: QuestionFinding[];
  /** The combined note for one targeted repair, or null on a pass. */
  fixNote: string | null;
}

export interface QuestionReview {
  id: string;
  tenantId: string;
  learningItem: { type: 'lesson' | 'section'; id: string };
  versionId: string;
  requestId: string;
  language: string;
  objectiveRef: string;
  objectiveText: string | null;
  questions: ReviewedQuestion[];
  status: QuestionReviewStatus;
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  results: QuestionResult[];
  errorCode: string | null;
  runAttempts: number;
  /** Set when the paid answer is stored (M-4): a resume finishes from it, never pays again. */
  reviewedAt: number | null;
  createdAt: number;
  completedAt: number | null;
}

export function newQuestionReviewId(): string {
  return `tqr-${randomBytes(12).toString('base64url')}`;
}

function rowToQuestionReview(row: Record<string, unknown>): QuestionReview {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    learningItem: {
      type: row.learning_item_type === 'section' ? 'section' : 'lesson',
      id: String(row.learning_item_id),
    },
    versionId: String(row.version_id),
    requestId: String(row.request_id),
    language: String(row.language),
    objectiveRef: String(row.objective_ref),
    objectiveText: typeof row.objective_text === 'string' ? row.objective_text : null,
    questions: (Array.isArray(row.questions) ? row.questions : []) as ReviewedQuestion[],
    status: row.status as QuestionReviewStatus,
    provider:
      row.provider === 'anthropic' || row.provider === 'openai'
        ? (row.provider as 'anthropic' | 'openai')
        : null,
    model: typeof row.model === 'string' ? row.model : null,
    results: (Array.isArray(row.results) ? row.results : []) as QuestionResult[],
    errorCode: typeof row.error_code === 'string' ? row.error_code : null,
    runAttempts: Number(row.run_attempts ?? 0),
    reviewedAt:
      row.reviewed_at === null || row.reviewed_at === undefined ? null : Number(row.reviewed_at),
    createdAt: Number(row.created_at),
    completedAt:
      row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
  };
}

export interface QueueQuestionReviewInput {
  id: string;
  tenantId: string;
  learningItem: { type: 'lesson' | 'section'; id: string };
  versionId: string;
  requestId: string;
  language: string;
  objectiveRef: string;
  objectiveText: string | null;
  questions: ReviewedQuestion[];
  now: number;
}

/** Insert, or answer the existing row of the same `(tenant, requestId)`. */
export async function queueQuestionReview(
  queryable: Queryable,
  input: QueueQuestionReviewInput,
): Promise<{ review: QuestionReview; created: boolean }> {
  const inserted = await queryable.query<Record<string, unknown>>(
    `INSERT INTO teaching_question_reviews
       (id, tenant_id, learning_item_type, learning_item_id, version_id, request_id, language,
        objective_ref, objective_text, questions, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'queued', $11, $11)
     ON CONFLICT (tenant_id, request_id) DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.learningItem.type,
      input.learningItem.id,
      input.versionId,
      input.requestId,
      input.language,
      input.objectiveRef,
      input.objectiveText,
      JSON.stringify(input.questions),
      input.now,
    ],
  );
  if (inserted.rows[0]) return { review: rowToQuestionReview(inserted.rows[0]), created: true };
  const existing = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_question_reviews WHERE tenant_id = $1 AND request_id = $2`,
    [input.tenantId, input.requestId],
  );
  return { review: rowToQuestionReview(existing.rows[0]!), created: false };
}

export async function claimQuestionReview(
  queryable: Queryable,
  id: string,
  input: { workerId: string; now: number; leaseMs: number },
): Promise<QuestionReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `UPDATE teaching_question_reviews
        SET status = 'running', lease_owner = $2, lease_until = $3,
            run_attempts = run_attempts + 1,
            started_at = COALESCE(started_at, $4), updated_at = $4
      WHERE id = $1
        AND (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < $4)))
      RETURNING *`,
    [id, input.workerId, input.now + input.leaseMs, input.now],
  );
  const row = result.rows[0];
  return row ? rowToQuestionReview(row) : null;
}

/**
 * Store the paid answer under the worker's lease, before the terminal write
 * (M-4). False when the lease is no longer this worker's.
 */
export async function saveQuestionReviewAnswer(
  queryable: Queryable,
  id: string,
  workerId: string,
  answer: {
    results: QuestionResult[];
    provider: 'anthropic' | 'openai' | null;
    model: string | null;
  },
  now: number,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE teaching_question_reviews
        SET results = $3::jsonb, provider = $4, model = $5, reviewed_at = $6, updated_at = $6
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id`,
    [id, workerId, JSON.stringify(answer.results), answer.provider, answer.model, now],
  );
  return result.rows.length > 0;
}

export async function finishQuestionReview(
  tx: Queryable,
  id: string,
  workerId: string,
  outcome: {
    status: 'completed' | 'unavailable';
    results?: QuestionResult[];
    provider?: 'anthropic' | 'openai' | null;
    model?: string | null;
    errorCode?: string | null;
  },
  now: number,
): Promise<QuestionReview | null> {
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE teaching_question_reviews
        SET status = $3, results = COALESCE($4::jsonb, results),
            provider = COALESCE($5, provider), model = COALESCE($6, model),
            error_code = $7, lease_owner = NULL, lease_until = NULL,
            completed_at = $8, updated_at = $8
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING *`,
    [
      id,
      workerId,
      outcome.status,
      outcome.results ? JSON.stringify(outcome.results) : null,
      outcome.provider ?? null,
      outcome.model ?? null,
      outcome.errorCode ?? null,
      now,
    ],
  );
  const row = result.rows[0];
  return row ? rowToQuestionReview(row) : null;
}

export async function readQuestionReview(
  queryable: Queryable,
  id: string,
  scope: { tenantId: string },
): Promise<QuestionReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_question_reviews WHERE id = $1 AND tenant_id = $2`,
    [id, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToQuestionReview(row) : null;
}

export async function listClaimableQuestionReviewIds(
  queryable: Queryable,
  now: number,
  limit = 20,
): Promise<string[]> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM teaching_question_reviews
      WHERE status = 'queued'
         OR (status = 'running' AND (lease_until IS NULL OR lease_until < $1))
      ORDER BY created_at ASC
      LIMIT $2`,
    [now, limit],
  );
  return result.rows.map((row) => String(row.id));
}
