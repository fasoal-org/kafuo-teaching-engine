/**
 * Regenerate only the flagged slides (owner, 15 Nov 2026; plan
 * `docs/frds/regenerate-flagged-slides-only-plan-2026-11-15.md`).
 *
 * The admin's Regenerate on a draft used to rebuild the whole package: a new
 * outline, every slide, every audio clip and a full AI review, and a new
 * outline could pause for an admin correction again. This runs the review's
 * fix loop again instead, on the version's CURRENT review, for the slides
 * that still carry an open finding:
 *
 *   - each such slide is regenerated once with all of its open fix notes, its
 *     narration re-synthesised, and only it re-reviewed (`package-review-fix-loop.ts`);
 *   - the outline, every other slide and its audio are never touched;
 *   - teacher-only findings (S5 missing book parts, a bank quiz, a check no
 *     regeneration may fix) stay with the teacher, as the owner decided.
 *
 * The finished review row is re-queued under a NEW id (see
 * `requeueReviewForRefix`); the review sweep starts it within one interval.
 * The id is derived from the request's idempotency key, so a transport retry
 * of the same request returns the review it already queued.
 */
import { createHash } from 'node:crypto';

import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import type { Queryable } from '@openmaic/storage/document/pg';

import { readVersionForUpdate } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { loadLiveScenes } from '@/lib/server/teaching-package/package-review';
import { teacherOnlyReason } from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  reviewSlidesOf,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
  readStageReviewForUpdate,
  requeueReviewForRefix,
  type PackageReview,
  type StoredFinding,
} from '@/lib/server/teaching-package/package-review-store';
import type { AppScene } from '@/lib/types/stage';

/**
 * Kafuo forwards the Admin's `Idempotency-Key` as it is
 * (`learning_item_tp_command:<id>:regeneration:stamp:<ms>:<rand>`, with colons). It
 * only feeds the hash of the re-queued review's id, so any visible ASCII is accepted.
 */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,256}$/;

export interface RefixSeed {
  /** Every finding of the review; open ones carry their teacher-only reason or `null`. */
  findings: StoredFinding[];
  /** The slides the fix loop will regenerate, in display order. */
  sceneIds: string[];
}

/**
 * The review's findings as the next fix loop must see them. Every open
 * finding's reason is recomputed: a teacher-only one (S5, bank quiz, a check
 * no regeneration may fix) keeps it, and every other one (`STILL_WRONG`,
 * `NOT_ATTEMPTED`, `VERSION_CHANGED`, a failed audio or re-review) is reset to
 * `null`, which is what makes the loop regenerate that slide again. Fixed
 * findings stay fixed.
 */
export function seedRefixFindings(
  findings: readonly StoredFinding[],
  slides: readonly ReviewSlide[],
): RefixSeed {
  const seeded = findings.map((finding) =>
    finding.status === 'open'
      ? {
          ...finding,
          teacherReason: teacherOnlyReason({ ...finding, teacherReason: null }, slides),
        }
      : { ...finding },
  );
  const sceneIds = slides
    .filter((slide) =>
      seeded.some(
        (finding) =>
          finding.targetId === slide.id &&
          finding.status === 'open' &&
          finding.teacherReason === null,
      ),
    )
    .map((slide) => slide.id);
  return { findings: seeded, sceneIds };
}

/** Deterministic per (tenant, version, request key): a retry names the same review. */
export function refixReviewId(tenantId: string, versionId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}\u0000${versionId}\u0000${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 16);
  return `tpr-rf-${digest}`;
}

export interface QueueRefixInput {
  tenantId: string;
  versionId: string;
  idempotencyKey: string;
}

export interface QueuedRefix {
  review: PackageReview;
  /** The review this one replaced; `null` on a replay. */
  previousReviewId: string | null;
  /** The slides to regenerate (empty on a replay: the stored findings say). */
  sceneIds: string[];
  replayed: boolean;
}

export interface QueueRefixDeps {
  now?: () => number;
  loadScenes?: (pool: ConnectableQueryable, stageId: string) => Promise<AppScene[] | null>;
}

async function generationInFlight(
  tx: Queryable,
  item: { tenantId: string; type: string; id: string },
): Promise<boolean> {
  const result = await tx.query<{ found: number }>(
    `SELECT 1 AS found FROM teaching_package_generation_attempts
      WHERE tenant_id = $1 AND learning_item_type = $2 AND learning_item_id = $3
        AND status IN ('queued', 'running', 'awaiting_admin_correction')
      LIMIT 1`,
    [item.tenantId, item.type, item.id],
  );
  return result.rows.length > 0;
}

/**
 * Queue the flagged-slide regeneration of one draft. Refusals (409 unless
 * noted): `NOT_FOUND` (404), `INVALID_TRANSITION` (not a draft),
 * `GENERATION_IN_PROGRESS`, `PACKAGE_REVIEW_NOT_READY` (no finished review of
 * the current Stage), `PACKAGE_REVIEW_IN_PROGRESS`, `STAGE_NOT_LIVE` and
 * `NO_REGENERABLE_SLIDES`.
 */
export async function queueFlaggedSlideRefix(
  pool: ConnectableQueryable,
  input: QueueRefixInput,
  deps: QueueRefixDeps = {},
): Promise<QueuedRefix> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'idempotencyKey must be 1-256 visible ASCII characters',
    );
  }
  const now = deps.now ?? Date.now;
  const loadScenes = deps.loadScenes ?? loadLiveScenes;
  const newReviewId = refixReviewId(input.tenantId, input.versionId, input.idempotencyKey);

  return nodePostgresTransaction(pool)(async (tx: Queryable): Promise<QueuedRefix> => {
    const version = await readVersionForUpdate(tx, input.versionId, { tenantId: input.tenantId });
    if (!version) {
      throw new TeachingPackageError('NOT_FOUND', `teaching package ${input.versionId} not found`);
    }
    const review = await readStageReviewForUpdate(tx, {
      tenantId: input.tenantId,
      versionId: version.id,
      stageId: version.currentStageId,
    });
    if (review && review.id === newReviewId) {
      return { review, previousReviewId: null, sceneIds: [], replayed: true };
    }
    if (version.status !== 'draft') {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `only a draft's flagged slides can be regenerated; this version is ${version.status}`,
      );
    }
    if (
      await generationInFlight(tx, {
        tenantId: input.tenantId,
        type: version.learningItem.type,
        id: version.learningItem.id,
      })
    ) {
      throw new TeachingPackageError(
        'GENERATION_IN_PROGRESS',
        'a generation of this learning item is in progress',
      );
    }
    if (!review || review.reviewedAt === null) {
      throw new TeachingPackageError(
        'PACKAGE_REVIEW_NOT_READY',
        'the current package has no finished AI review to take its open issues from',
      );
    }
    if (review.status === 'queued' || review.status === 'running') {
      throw new TeachingPackageError(
        'PACKAGE_REVIEW_IN_PROGRESS',
        'the AI review of this package is still running',
      );
    }
    const scenes = await loadScenes(pool, version.currentStageId);
    if (!scenes) {
      throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
    }
    const seed = seedRefixFindings(review.findings, reviewSlidesOf(scenes));
    if (seed.sceneIds.length === 0) {
      throw new TeachingPackageError(
        'NO_REGENERABLE_SLIDES',
        'no open issue sits on a slide a regeneration may fix',
      );
    }
    const requeued = await requeueReviewForRefix(tx, {
      reviewId: review.id,
      newReviewId,
      findings: seed.findings,
      now: now(),
    });
    if (!requeued) {
      throw new TeachingPackageError(
        'PACKAGE_REVIEW_IN_PROGRESS',
        'the AI review of this package changed meanwhile',
      );
    }
    return {
      review: requeued,
      previousReviewId: review.id,
      sceneIds: seed.sceneIds,
      replayed: false,
    };
  });
}
