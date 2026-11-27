/**
 * A-34 (27 Nov 2026), A-34b: a finished AI review is a verdict on what its reviewer READ
 * of the Stage. A teacher who changes that after a `passed` review must not keep the
 * verdict, so Approve never passes on content nobody reviewed. TE only: nothing new goes
 * on the wire.
 *
 * - The review row keeps the Stage revision it finished at (`reviewed_stage_rev`) and the
 *   digest of the review input it read (`reviewed_stage_digest`, `reviewInputDigest`),
 *   both set only when the Stage was still what the review saw.
 * - A verdict is stale only when what the reviewer would SEE changed (A-34b): the same
 *   revision is fresh at once; a revision that moved is fresh when the live Stage's
 *   review input is unchanged (an editor auto-height pass, a save that changed nothing),
 *   and stale when it is not (a text edit, a reordered, added or deleted slide).
 * - A row with no revision or no digest (from before A-34, or one whose Stage changed
 *   under its run) is stale: fail closed.
 * - Submit and Approve refuse `PACKAGE_REVIEW_STALE`; Regenerate flagged asks one fresh
 *   review that only reviews (`queueFlaggedSlideRefix`).
 *
 * Every Teaching Model: this is approval safety, not planner text. A review still queued or
 * running, an `unavailable` one (Kafuo's own rule decides those) and a version with no
 * review at all are not this gate's to refuse.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { reviewInputDigest } from '@/lib/server/teaching-package/package-review-input';
import {
  readStageReview,
  type PackageReview,
} from '@/lib/server/teaching-package/package-review-store';
import type { AppScene } from '@/lib/types/stage';

/** The finished verdicts a Stage revision belongs to. */
const VERDICT_STATUSES: ReadonlySet<PackageReview['status']> = new Set([
  'passed',
  'fixed',
  'needs_teacher',
]);

/**
 * Whether a review's verdict no longer holds for the Stage at `currentRev`. `liveDigest`
 * (the live Stage's `reviewInputDigest`) is asked for only when the revision moved.
 */
export async function reviewIsStale(
  review: Pick<PackageReview, 'status' | 'reviewedStageRev' | 'reviewedStageDigest'>,
  currentRev: number,
  liveDigest: () => Promise<string>,
): Promise<boolean> {
  if (!VERDICT_STATUSES.has(review.status)) return false;
  if (review.reviewedStageRev === null || review.reviewedStageDigest === null) return true;
  if (review.reviewedStageRev === currentRev) return false;
  return (await liveDigest()) !== review.reviewedStageDigest;
}

/** The live slides of a Stage, read on the caller's transaction (no second connection). */
export async function readStageScenesOn(tx: Queryable, stageId: string): Promise<AppScene[]> {
  const result = await tx.query<{ data: unknown }>(
    `SELECT data FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order ASC, id ASC`,
    [stageId],
  );
  return result.rows.map(
    (row) => (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as AppScene,
  );
}

/**
 * Refuse `PACKAGE_REVIEW_STALE` (409, `{ reviewedStageRev, currentRev }`) when the version's
 * newest review of its current Stage is a finished verdict on what the reviewer no longer
 * sees. For `submitForReview` and `approve`, inside their transaction, under the aggregate
 * lock, with the revision they just read.
 */
export async function refuseStaleReview(
  tx: Queryable,
  version: { id: string; tenantId: string; currentStageId: string },
  currentRev: number,
): Promise<void> {
  const review = await readStageReview(tx, {
    tenantId: version.tenantId,
    versionId: version.id,
    stageId: version.currentStageId,
  });
  if (!review) return;
  const stale = await reviewIsStale(review, currentRev, async () =>
    reviewInputDigest(await readStageScenesOn(tx, version.currentStageId)),
  );
  if (!stale) return;
  throw new TeachingPackageError(
    'PACKAGE_REVIEW_STALE',
    'the AI review is of an earlier version of these slides; press Regenerate flagged to review them again',
    { reviewedStageRev: review.reviewedStageRev, currentRev },
  );
}
