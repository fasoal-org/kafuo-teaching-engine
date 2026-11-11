/**
 * `teaching_package_reviews` rows (ai-reviewer-layer plan §4.6).
 *
 * Lifecycle: `queued` (inserted in the binding transaction) → `running`
 * (claimed under a lease by one worker) → one terminal status, written in the
 * same transaction as its `teaching_package.review_completed` outbox event. A
 * `running` row whose lease lapsed is claimable again, so a crash resumes the
 * review instead of failing it; `reviewed_at` keeps the paid first answer.
 * Epoch milliseconds.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import type {
  PackageReviewCheck,
  FindingSeverity,
} from '@/lib/server/teaching-package/package-review-prompt';
import type { TeachingPackageAggregateKey } from '@/lib/types/teaching-package';

export type PackageReviewStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'fixed'
  | 'needs_teacher'
  | 'unavailable';

export const TERMINAL_REVIEW_STATUSES: readonly PackageReviewStatus[] = [
  'passed',
  'fixed',
  'needs_teacher',
  'unavailable',
];

/**
 * Why an open finding waits for a person (contract §2). Review fixes added:
 * `NARRATION_AUDIO_FAILED` (D-5: the content was fixed, its narration audio
 * failed or is partial) and `REREVIEW_UNAVAILABLE` (L-2: the regenerated slide
 * could not be checked again).
 */
export type TeacherReason =
  | 'S5_TEACHER_ONLY'
  | 'BANK_QUIZ_NOT_REGENERABLE'
  | 'REGENERATION_REFUSED'
  | 'STILL_WRONG'
  | 'VERSION_CHANGED'
  | 'NOT_ATTEMPTED'
  | 'NARRATION_AUDIO_FAILED'
  | 'REREVIEW_UNAVAILABLE';

export interface StoredFinding {
  id: string;
  targetId: string;
  targetTitle: string;
  targetOrder: number | null;
  check: PackageReviewCheck;
  severity: FindingSeverity;
  bookEvidence: { quote: string; unitId: string | null };
  whatIsWrong: string;
  fixNote: string;
  status: 'open' | 'fixed';
  teacherReason: TeacherReason | null;
}

export interface StoredFix {
  sceneId: string;
  findingIds: string[];
  outcome: 'fixed' | 'still_wrong' | 'refused' | 'stopped';
  code: string | null;
  regenerationId?: string | null;
}

export interface PackageReview {
  id: string;
  tenantId: string;
  learningItem: { type: 'lesson' | 'section'; id: string };
  versionId: string;
  attemptId: string;
  stageId: string;
  subjectCode: string | null;
  status: PackageReviewStatus;
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  summary: string | null;
  findings: StoredFinding[];
  fixes: StoredFix[];
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** D-8: the reviewer read a cut book (stored with the first answer). */
  bookTruncated: boolean;
  runAttempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  reviewedAt: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export function newPackageReviewId(): string {
  return `tpr-${randomBytes(12).toString('base64url')}`;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToReview(row: Record<string, unknown>): PackageReview {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    learningItem: {
      type: row.learning_item_type === 'section' ? 'section' : 'lesson',
      id: String(row.learning_item_id),
    },
    versionId: String(row.version_id),
    attemptId: String(row.attempt_id),
    stageId: String(row.stage_id),
    subjectCode: typeof row.subject_code === 'string' ? row.subject_code : null,
    status: row.status as PackageReviewStatus,
    provider:
      row.provider === 'anthropic' || row.provider === 'openai'
        ? (row.provider as 'anthropic' | 'openai')
        : null,
    model: typeof row.model === 'string' ? row.model : null,
    summary: typeof row.summary === 'string' ? row.summary : null,
    findings: (Array.isArray(row.findings) ? row.findings : []) as StoredFinding[],
    fixes: (Array.isArray(row.fixes) ? row.fixes : []) as StoredFix[],
    errorCode: typeof row.error_code === 'string' ? row.error_code : null,
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: num(row.cost_usd),
    bookTruncated: row.book_truncated === true,
    runAttempts: Number(row.run_attempts ?? 0),
    leaseOwner: typeof row.lease_owner === 'string' ? row.lease_owner : null,
    leaseUntil: num(row.lease_until),
    reviewedAt: num(row.reviewed_at),
    createdAt: Number(row.created_at),
    startedAt: num(row.started_at),
    completedAt: num(row.completed_at),
  };
}

export interface QueuedReviewInput {
  id: string;
  aggregate: TeachingPackageAggregateKey;
  versionId: string;
  attemptId: string;
  stageId: string;
  subjectCode: string | null;
  now: number;
}

/**
 * Inside the binding transaction: one `queued` row per attempt. Returns the
 * STORED review id (L-5): when the attempt already has a review, its id, never
 * the unused new one, so the event names a review that exists.
 */
export async function insertQueuedReview(tx: Queryable, input: QueuedReviewInput): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO teaching_package_reviews
       (id, tenant_id, learning_item_type, learning_item_id, version_id, attempt_id, stage_id,
        subject_code, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $9)
     ON CONFLICT (attempt_id) DO NOTHING
     RETURNING id`,
    [
      input.id,
      input.aggregate.tenantId,
      input.aggregate.learningItem.type,
      input.aggregate.learningItem.id,
      input.versionId,
      input.attemptId,
      input.stageId,
      input.subjectCode,
      input.now,
    ],
  );
  if (inserted.rows[0]) return String(inserted.rows[0].id);
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM teaching_package_reviews WHERE attempt_id = $1`,
    [input.attemptId],
  );
  return String(existing.rows[0]!.id);
}

/**
 * Claim a review for one worker: a `queued` row, or a `running` row whose lease
 * lapsed (a crashed or restarted worker). `null` when another worker holds it
 * or it is terminal.
 */
export async function claimReview(
  queryable: Queryable,
  id: string,
  input: { workerId: string; now: number; leaseMs: number },
): Promise<PackageReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `UPDATE teaching_package_reviews
        SET status = 'running', lease_owner = $2, lease_until = $3,
            run_attempts = run_attempts + 1,
            started_at = COALESCE(started_at, $4), updated_at = $4
      WHERE id = $1
        AND (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < $4)))
      RETURNING *`,
    [id, input.workerId, input.now + input.leaseMs, input.now],
  );
  const row = result.rows[0];
  return row ? rowToReview(row) : null;
}

/** Heartbeat before each long step. False when the lease is no longer ours. */
export async function renewReviewLease(
  queryable: Queryable,
  id: string,
  input: { workerId: string; now: number; leaseMs: number },
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE teaching_package_reviews SET lease_until = $3, updated_at = $4
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id`,
    [id, input.workerId, input.now + input.leaseMs, input.now],
  );
  return result.rows.length > 0;
}

export interface ReviewProgress {
  summary?: string | null;
  findings?: StoredFinding[];
  fixes?: StoredFix[];
  provider?: 'anthropic' | 'openai' | null;
  model?: string | null;
  /** Added to the running totals (every reviewer call of this review). */
  usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  reviewedAt?: number;
  /** D-8: saved with the first answer. */
  bookTruncated?: boolean;
}

/** Store progress under the worker's lease (the first answer, then each fix). */
export async function saveReviewProgress(
  queryable: Queryable,
  id: string,
  workerId: string,
  progress: ReviewProgress,
  now: number,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE teaching_package_reviews
        SET summary = COALESCE($3, summary),
            findings = COALESCE($4::jsonb, findings),
            fixes = COALESCE($5::jsonb, fixes),
            provider = COALESCE($6, provider),
            model = COALESCE($7, model),
            input_tokens = CASE WHEN $8::bigint IS NULL THEN input_tokens ELSE COALESCE(input_tokens, 0) + $8::bigint END,
            output_tokens = CASE WHEN $9::bigint IS NULL THEN output_tokens ELSE COALESCE(output_tokens, 0) + $9::bigint END,
            cost_usd = CASE WHEN $10::numeric IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + $10::numeric END,
            reviewed_at = COALESCE($11, reviewed_at),
            book_truncated = COALESCE($13::boolean, book_truncated),
            updated_at = $12
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id`,
    [
      id,
      workerId,
      progress.summary ?? null,
      progress.findings ? JSON.stringify(progress.findings) : null,
      progress.fixes ? JSON.stringify(progress.fixes) : null,
      progress.provider ?? null,
      progress.model ?? null,
      progress.usage?.inputTokens ?? null,
      progress.usage?.outputTokens ?? null,
      progress.usage?.costUsd ?? null,
      progress.reviewedAt ?? null,
      now,
      progress.bookTruncated ?? null,
    ],
  );
  return result.rows.length > 0;
}

export interface ReviewOutcome {
  status: Exclude<PackageReviewStatus, 'queued' | 'running'>;
  errorCode?: string | null;
  summary?: string | null;
  findings?: StoredFinding[];
  fixes?: StoredFix[];
}

/**
 * The terminal write, inside the transaction that enqueues its event. Guarded
 * on the lease: a worker that lost the review writes nothing.
 */
export async function finishReview(
  tx: Queryable,
  id: string,
  workerId: string,
  outcome: ReviewOutcome,
  now: number,
): Promise<PackageReview | null> {
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE teaching_package_reviews
        SET status = $3, error_code = $4,
            summary = COALESCE($5, summary),
            findings = COALESCE($6::jsonb, findings),
            fixes = COALESCE($7::jsonb, fixes),
            lease_owner = NULL, lease_until = NULL,
            completed_at = $8, updated_at = $8
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING *`,
    [
      id,
      workerId,
      outcome.status,
      outcome.errorCode ?? null,
      outcome.summary ?? null,
      outcome.findings ? JSON.stringify(outcome.findings) : null,
      outcome.fixes ? JSON.stringify(outcome.fixes) : null,
      now,
    ],
  );
  const row = result.rows[0];
  return row ? rowToReview(row) : null;
}

export async function readPackageReview(
  queryable: Queryable,
  id: string,
  scope: { tenantId: string },
): Promise<PackageReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_package_reviews WHERE id = $1 AND tenant_id = $2`,
    [id, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToReview(row) : null;
}

export async function readReviewForAttempt(
  queryable: Queryable,
  attemptId: string,
): Promise<PackageReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_package_reviews WHERE attempt_id = $1`,
    [attemptId],
  );
  const row = result.rows[0];
  return row ? rowToReview(row) : null;
}

export async function listReviewsForVersion(
  queryable: Queryable,
  versionId: string,
  scope: { tenantId: string },
): Promise<PackageReview[]> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_package_reviews
      WHERE version_id = $1 AND tenant_id = $2
      ORDER BY created_at DESC, id DESC`,
    [versionId, scope.tenantId],
  );
  return result.rows.map(rowToReview);
}

/** Every review a sweep may start or resume now: queued, or running with a lapsed lease. */
export async function listClaimableReviewIds(
  queryable: Queryable,
  now: number,
  limit = 20,
): Promise<string[]> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM teaching_package_reviews
      WHERE status = 'queued'
         OR (status = 'running' AND (lease_until IS NULL OR lease_until < $1))
      ORDER BY created_at ASC
      LIMIT $2`,
    [now, limit],
  );
  return result.rows.map((row) => String(row.id));
}
