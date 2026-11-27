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
  /**
   * The target slide's `reviewedSceneDigest` when the review finished (15 Nov
   * 2026); absent on reviews finished before, and on a finding with no slide.
   */
  sceneDigest?: string;
  /**
   * Dead end (b), 27 Nov 2026: set by `seedRefixFindings` on a finding whose slide was
   * already regenerated but whose re-check could not run: the next fix loop re-checks
   * the live slide without paying for a regeneration. TE row only: `packageReviewWire`
   * never sends it.
   */
  recheckOnly?: true;
  /**
   * Dead end (b), review of c3f02fdc: what a `REREVIEW_UNAVAILABLE` finding waits for,
   * kept on the finding itself because a flagged-slide run wipes `fixes`:
   * `recheck` -- only the re-check of its regenerated slide (the next press re-checks
   * it); `audio` -- that, and the slide's narration audio failed too (the next press
   * regenerates it, so its audio is made again); `person` -- a book figure no retry can
   * show (an unread or refused figure). TE row only: `packageReviewWire` never sends it.
   */
  heldFor?: 'recheck' | 'audio' | 'person';
}

export interface StoredFix {
  sceneId: string;
  findingIds: string[];
  outcome: 'fixed' | 'still_wrong' | 'refused' | 'stopped';
  code: string | null;
  regenerationId?: string | null;
  /**
   * RV-5 (27 Nov 2026): the model that served the re-review that decided this fix
   * (`anthropic:claude-opus-5-5`, `openai:gpt-6-sol`), or `null` when no re-review
   * answered. The row's `provider`/`model` name the first review's call only; this
   * names every re-check, in a resumed or flagged-slide run too. Stored on the TE row
   * only: `packageReviewWire` never sends it (contract §4.1 is unchanged).
   */
  reviewModel?: string | null;
  /** RV-5: the provider of `reviewModel`. */
  reviewProvider?: 'anthropic' | 'openai' | null;
  /**
   * RV-1/RV-4 (g5.v12): the findings left open only because this re-check could not see
   * figures a fresh review run would send (the run's budget, a resumed run). The next
   * Regenerate-flagged press retries exactly these. TE row only, never on the wire.
   */
  retryForFigures?: string[];
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

/**
 * Dead end (a), 27 Nov 2026: a version with no attempt of its own (an edit successor)
 * gets ONE review per Stage. The row is one per `attempt_id` (`tpr_attempt_unique`), and
 * the producing attempt already holds its own version's review, so the row's attempt
 * key names both: `<producing attempt>#stage:<stage>`. Everything that reads the
 * attempt -- the book units, the Teaching Model, the ledger, the wire -- reads the
 * producing attempt (`reviewSourceAttemptId`). No schema change.
 */
const STAGE_REVIEW_SEPARATOR = '#stage:';

export function stageReviewAttemptId(sourceAttemptId: string, stageId: string): string {
  return `${sourceAttemptId}${STAGE_REVIEW_SEPARATOR}${stageId}`;
}

/** The attempt that produced the reviewed content (a stage review's producing attempt). */
export function reviewSourceAttemptId(attemptId: string): string {
  const at = attemptId.indexOf(STAGE_REVIEW_SEPARATOR);
  return at >= 0 ? attemptId.slice(0, at) : attemptId;
}

/** The id prefix of a review a Regenerate-flagged press queued (`refixReviewId`). */
export const REFIX_REVIEW_ID_PREFIX = 'tpr-rf-';

/**
 * Review 27 Nov 2026: a review whose FIRST answer a press or a submit asked for -- a
 * Stage review (dead end (a)) or a re-asked `unavailable` one (dead end (c)). It only
 * reviews: its findings go to the teacher, and the next press regenerates their slides.
 * (A press's ordinary flagged-slide run keeps its stored first answer, so it is never
 * asked for one.)
 */
export function isPressedFirstReview(review: Pick<PackageReview, 'id' | 'attemptId'>): boolean {
  return (
    review.id.startsWith(REFIX_REVIEW_ID_PREFIX) ||
    reviewSourceAttemptId(review.attemptId) !== review.attemptId
  );
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

/**
 * HIGH-1: revoke a lease this process gave up on (an evicted, hung run). The
 * row stays `running` and is claimable at once; every later write or renewal
 * of the revoked run is refused by the `lease_owner` guard.
 */
export async function releaseReviewLease(
  queryable: Queryable,
  id: string,
  input: { workerId: string; now: number },
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE teaching_package_reviews SET lease_owner = NULL, lease_until = NULL, updated_at = $3
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id`,
    [id, input.workerId, input.now],
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
  /**
   * L-B: the review's totals from the ledger (every paid attempt of every run),
   * SET as they are; absent → the running totals stay.
   */
  usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
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
            input_tokens = CASE WHEN $9::boolean THEN $10::bigint ELSE input_tokens END,
            output_tokens = CASE WHEN $9::boolean THEN $11::bigint ELSE output_tokens END,
            cost_usd = CASE WHEN $9::boolean THEN $12::numeric ELSE cost_usd END,
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
      outcome.usage !== undefined,
      outcome.usage?.inputTokens ?? null,
      outcome.usage?.outputTokens ?? null,
      outcome.usage?.costUsd ?? null,
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

/**
 * Inside a transaction: the newest review of `stageId` (the version's current
 * Stage), row-locked, or `null`. A review of an older Stage describes slides
 * that no longer exist, so the flagged-slide regeneration never reads one.
 */
export async function readStageReviewForUpdate(
  tx: Queryable,
  input: { tenantId: string; versionId: string; stageId: string },
): Promise<PackageReview | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT * FROM teaching_package_reviews
      WHERE tenant_id = $1 AND version_id = $2 AND stage_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    [input.tenantId, input.versionId, input.stageId],
  );
  const row = result.rows[0];
  return row ? rowToReview(row) : null;
}

/**
 * Regenerate only the flagged slides (owner, 15 Nov 2026): a finished review
 * goes back to `queued` under a NEW id, with the given findings and no fixes.
 *
 * - A new id, because the fix loop keys each slide regeneration on
 *   `rv-<reviewId>-<sceneId>`: the old id would replay the earlier
 *   regeneration and change nothing. The row stays one per attempt.
 * - `reviewed_at` is kept, so `runPackageReview` never pays for the
 *   whole-package review again and goes straight to the fix loop.
 * - `created_at` is now: Kafuo counts its stuck-review guard from it
 *   (`queued_at`), so an old time would release Submit/Approve at once.
 * - Spend restarts (the ledger is summed by review id at the end).
 *
 * Guarded on a terminal status; `null` when the row moved meanwhile.
 */
export async function requeueReviewForRefix(
  tx: Queryable,
  input: { reviewId: string; newReviewId: string; findings: StoredFinding[]; now: number },
): Promise<PackageReview | null> {
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE teaching_package_reviews
        SET id = $2, status = 'queued', findings = $3::jsonb, fixes = '[]'::jsonb,
            error_code = NULL, input_tokens = NULL, output_tokens = NULL, cost_usd = NULL,
            run_attempts = 0, lease_owner = NULL, lease_until = NULL,
            started_at = NULL, completed_at = NULL, created_at = $4, updated_at = $4
      WHERE id = $1 AND status = ANY($5::text[])
      RETURNING *`,
    [
      input.reviewId,
      input.newReviewId,
      JSON.stringify(input.findings),
      input.now,
      [...TERMINAL_REVIEW_STATUSES],
    ],
  );
  const row = result.rows[0];
  return row ? rowToReview(row) : null;
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

/**
 * The signed read model (contract §4.1): everything the teacher's report
 * needs. Pure, and kept here so a read route never loads the fix loop or the
 * generation graph (`package-review.ts` re-exports it).
 */
export function packageReviewWire(review: PackageReview) {
  const open = review.findings.filter((finding) => finding.status === 'open').length;
  return {
    id: review.id,
    versionId: review.versionId,
    stageId: review.stageId,
    // The producing attempt, never a stage review's row key (dead end (a)).
    attemptId: reviewSourceAttemptId(review.attemptId),
    status: review.status,
    provider: review.provider,
    model: review.model,
    summary: review.summary,
    // `recheckOnly` and `heldFor` are TE's own (dead end (b)): the wire keeps its fields.
    findings: review.findings.map(
      ({ recheckOnly: _recheckOnly, heldFor: _heldFor, ...finding }) => finding,
    ),
    fixes: review.fixes.map((fix) => ({
      sceneId: fix.sceneId,
      findingIds: fix.findingIds,
      outcome: fix.outcome,
      code: fix.code,
    })),
    counts: { findings: review.findings.length, open, fixed: review.findings.length - open },
    /** D-8: the reviewer did not read the whole book (the report shows one warning line). */
    bookTruncated: review.bookTruncated,
    errorCode: review.errorCode,
    createdAt: review.createdAt,
    completedAt: review.completedAt,
  };
}
