/**
 * The agent book review rows (`teaching_package_agent_reviews`, Kafuo Agent API
 * D2a) and the process-local page images. Kept apart from the package review
 * store: the automatic review, its gate and its event are not touched.
 *
 * Page images are NEVER stored: they live in this process's memory from the
 * request until the run reads them (or the TTL ends). A run that finds them gone
 * fails with `EVIDENCE_EXPIRED`, and the Backend submits again.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import type {
  AgentFinding,
  AgentReviewEvidence,
  EvidenceImage,
} from '@/lib/server/teaching-package/agent-book-review-prompt';
import type { TeachingPackageAggregateKey } from '@/lib/types/teaching-package';

export type AgentReviewStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface AgentReviewGroup {
  index: number;
  sceneIds: string[];
  status: 'succeeded' | 'failed';
  errorCode: string | null;
}

export interface AgentReview {
  id: string;
  tenantId: string;
  learningItem: TeachingPackageAggregateKey['learningItem'];
  versionId: string;
  stageId: string;
  subjectCode: string | null;
  requestId: string;
  evaluationId: string | null;
  runId: string | null;
  evidence: AgentReviewEvidence;
  hasImages: boolean;
  status: AgentReviewStatus;
  provider: 'anthropic' | 'openai' | null;
  model: string | null;
  findings: AgentFinding[];
  groups: AgentReviewGroup[];
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  attemptIds: string[];
  runAttempts: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export function newAgentReviewId(): string {
  return `tpar-${randomBytes(9).toString('base64url')}`;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function rowToAgentReview(row: Record<string, unknown>): AgentReview {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    learningItem: {
      type: row.learning_item_type as 'lesson' | 'section',
      id: String(row.learning_item_id),
    },
    versionId: String(row.version_id),
    stageId: String(row.stage_id),
    subjectCode: (row.subject_code as string | null) ?? null,
    requestId: String(row.request_id),
    evaluationId: (row.evaluation_id as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    evidence: json<AgentReviewEvidence>(row.evidence, {
      pages: [],
      blocks: [],
      units: [],
      constants: {},
      d1Findings: [],
      bookTruncated: false,
    }),
    hasImages: row.has_images === true,
    status: row.status as AgentReviewStatus,
    provider: (row.provider as AgentReview['provider']) ?? null,
    model: (row.model as string | null) ?? null,
    findings: json<AgentFinding[]>(row.findings, []),
    groups: json<AgentReviewGroup[]>(row.groups, []),
    errorCode: (row.error_code as string | null) ?? null,
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: num(row.cost_usd),
    attemptIds: json<string[]>(row.attempt_ids, []),
    runAttempts: Number(row.run_attempts ?? 0),
    createdAt: Number(row.created_at),
    startedAt: num(row.started_at),
    completedAt: num(row.completed_at),
  };
}

export interface QueuedAgentReviewInput {
  id: string;
  aggregate: TeachingPackageAggregateKey;
  versionId: string;
  stageId: string;
  subjectCode: string | null;
  requestId: string;
  evaluationId: string | null;
  runId: string | null;
  evidence: AgentReviewEvidence;
  hasImages: boolean;
  now: number;
}

/**
 * One `queued` row per `(tenant, requestId)`. A replay answers the stored row
 * (`replayed: true`) and never pays twice.
 */
export async function insertQueuedAgentReview(
  queryable: Queryable,
  input: QueuedAgentReviewInput,
): Promise<{ review: AgentReview; replayed: boolean }> {
  const inserted = await queryable.query<Record<string, unknown>>(
    `INSERT INTO teaching_package_agent_reviews
       (id, tenant_id, learning_item_type, learning_item_id, version_id, stage_id, subject_code,
        request_id, evaluation_id, run_id, evidence, has_images, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'queued', $13, $13)
     ON CONFLICT (tenant_id, request_id) DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.aggregate.tenantId,
      input.aggregate.learningItem.type,
      input.aggregate.learningItem.id,
      input.versionId,
      input.stageId,
      input.subjectCode,
      input.requestId,
      input.evaluationId,
      input.runId,
      JSON.stringify(input.evidence),
      input.hasImages,
      input.now,
    ],
  );
  if (inserted.rows[0]) return { review: rowToAgentReview(inserted.rows[0]), replayed: false };
  const existing = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_package_agent_reviews WHERE tenant_id = $1 AND request_id = $2`,
    [input.aggregate.tenantId, input.requestId],
  );
  return { review: rowToAgentReview(existing.rows[0]!), replayed: true };
}

export async function readAgentReview(
  queryable: Queryable,
  id: string,
  scope: { tenantId: string; versionId?: string },
): Promise<AgentReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_package_agent_reviews
      WHERE id = $1 AND tenant_id = $2 AND ($3::text IS NULL OR version_id = $3)`,
    [id, scope.tenantId, scope.versionId ?? null],
  );
  return result.rows[0] ? rowToAgentReview(result.rows[0]) : null;
}

/** Claim a `queued` row, or a `running` one whose lease lapsed. */
export async function claimAgentReview(
  queryable: Queryable,
  id: string,
  input: { workerId: string; now: number; leaseMs: number },
): Promise<AgentReview | null> {
  const result = await queryable.query<Record<string, unknown>>(
    `UPDATE teaching_package_agent_reviews
        SET status = 'running', lease_owner = $2, lease_until = $3,
            run_attempts = run_attempts + 1,
            started_at = COALESCE(started_at, $4), updated_at = $4
      WHERE id = $1
        AND (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < $4)))
      RETURNING *`,
    [id, input.workerId, input.now + input.leaseMs, input.now],
  );
  return result.rows[0] ? rowToAgentReview(result.rows[0]) : null;
}

export async function renewAgentReviewLease(
  queryable: Queryable,
  id: string,
  input: { workerId: string; now: number; leaseMs: number },
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE teaching_package_agent_reviews SET lease_until = $3, updated_at = $4
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id`,
    [id, input.workerId, input.now + input.leaseMs, input.now],
  );
  return result.rows.length > 0;
}

export async function listClaimableAgentReviewIds(
  queryable: Queryable,
  now: number,
  limit: number,
): Promise<string[]> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM teaching_package_agent_reviews
      WHERE status = 'queued'
         OR (status = 'running' AND (lease_until IS NULL OR lease_until < $1))
      ORDER BY created_at ASC
      LIMIT $2`,
    [now, limit],
  );
  return result.rows.map((row) => String(row.id));
}

export interface AgentReviewOutcome {
  status: 'succeeded' | 'partial' | 'failed';
  findings: AgentFinding[];
  groups: AgentReviewGroup[];
  provider: AgentReview['provider'];
  model: string | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Every paid model attempt (the spend above is their ledger sum). */
  attemptIds: string[];
}

/** The terminal write, under the lease (`workerId` null: a run with no lease, e.g. too many attempts). */
export async function finishAgentReview(
  tx: Queryable,
  id: string,
  outcome: AgentReviewOutcome,
  input: { workerId: string | null; now: number },
): Promise<AgentReview | null> {
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE teaching_package_agent_reviews
        SET status = $3, findings = $4::jsonb, groups = $5::jsonb, provider = $6, model = $7,
            error_code = $8, input_tokens = $9, output_tokens = $10, cost_usd = $11,
            attempt_ids = $13::jsonb,
            completed_at = $12, updated_at = $12, lease_owner = NULL, lease_until = NULL
      WHERE id = $1 AND status IN ('queued','running')
        AND ($2::text IS NULL OR lease_owner = $2)
      RETURNING *`,
    [
      id,
      input.workerId,
      outcome.status,
      JSON.stringify(outcome.findings),
      JSON.stringify(outcome.groups),
      outcome.provider,
      outcome.model,
      outcome.errorCode,
      outcome.inputTokens,
      outcome.outputTokens,
      outcome.costUsd,
      input.now,
      JSON.stringify(outcome.attemptIds),
    ],
  );
  return result.rows[0] ? rowToAgentReview(result.rows[0]) : null;
}

/** The service read model (`GET …/agent-book-reviews/[reviewId]`), snake_case like the agent reads. */
export function agentReviewWire(review: AgentReview) {
  return {
    review_id: review.id,
    version_id: review.versionId,
    stage_id: review.stageId,
    evaluation_id: review.evaluationId,
    run_id: review.runId,
    status: review.status,
    error_code: review.errorCode,
    provider: review.provider,
    model: review.model,
    book_truncated: review.evidence.bookTruncated,
    findings: review.findings,
    groups: review.groups.map((group) => ({
      index: group.index,
      scene_ids: group.sceneIds,
      status: group.status,
      error_code: group.errorCode,
    })),
    usage: {
      input_tokens: review.inputTokens,
      output_tokens: review.outputTokens,
      cost_usd: review.costUsd,
      // Total over every paid attempt (failed calls and fallbacks included).
      attempts: review.attemptIds.length,
    },
    created_at: new Date(review.createdAt).toISOString(),
    started_at: review.startedAt === null ? null : new Date(review.startedAt).toISOString(),
    completed_at: review.completedAt === null ? null : new Date(review.completedAt).toISOString(),
  };
}

// ── Page images: process memory only ────────────────────────────────────────────────

/** How long a review's images wait for its run (the sweep runs every few seconds). */
export const AGENT_REVIEW_IMAGE_TTL_MS = 60 * 60 * 1000;
/** Every held image together, so a burst of requests cannot exhaust memory. */
export const AGENT_REVIEW_IMAGES_MAX_BYTES = 64 * 1024 * 1024;

const heldImages = new Map<string, { images: EvidenceImage[]; bytes: number; expiresAt: number }>();

function heldBytes(): number {
  let total = 0;
  for (const entry of heldImages.values()) total += entry.bytes;
  return total;
}

/** Hold a review's images; false when the process is full (the route answers 503). */
export function holdAgentReviewImages(
  reviewId: string,
  images: EvidenceImage[],
  now: number,
): boolean {
  for (const [id, entry] of heldImages) if (entry.expiresAt <= now) heldImages.delete(id);
  const bytes = images.reduce((sum, image) => sum + image.data.length, 0);
  if (heldBytes() + bytes > AGENT_REVIEW_IMAGES_MAX_BYTES) return false;
  heldImages.set(reviewId, { images, bytes, expiresAt: now + AGENT_REVIEW_IMAGE_TTL_MS });
  return true;
}

/** The images, or null when they expired or this process never held them. */
export function takeAgentReviewImages(reviewId: string, now: number): EvidenceImage[] | null {
  const entry = heldImages.get(reviewId);
  if (!entry || entry.expiresAt <= now) {
    heldImages.delete(reviewId);
    return null;
  }
  return entry.images;
}

export function releaseAgentReviewImages(reviewId: string): void {
  heldImages.delete(reviewId);
}

/** Test seam: the base64 characters this process holds now. */
export function heldAgentReviewImageBytes(): number {
  return heldBytes();
}

/** Test seam. */
export function clearAgentReviewImages(): void {
  heldImages.clear();
}
