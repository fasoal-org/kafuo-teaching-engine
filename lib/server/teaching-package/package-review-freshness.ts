/**
 * A-34 (27 Nov 2026): a finished AI review is a verdict on ONE revision of its Stage. A
 * teacher who edits after a `passed` review must not keep that verdict, so Approve never
 * passes on content nobody reviewed. TE only: nothing new goes on the wire.
 *
 * - The review row keeps the Stage revision its verdict is about (`reviewed_stage_rev`,
 *   set when the review finishes and the Stage is still what the review saw).
 * - Submit and Approve refuse `PACKAGE_REVIEW_STALE` when the version's newest finished
 *   review of its current Stage is of another revision. A row with no revision (from
 *   before A-34, or one whose Stage changed under its run) is stale: fail closed.
 * - The remedy is Regenerate flagged: on a stale review it asks one fresh review that only
 *   reviews (`queueFlaggedSlideRefix`), never a regeneration over the teacher's edit.
 *
 * Every Teaching Model: this is approval safety, not planner text. A review still queued or
 * running, an `unavailable` one (Kafuo's own rule decides those) and a version with no
 * review at all are not this gate's to refuse.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  readStageReview,
  type PackageReview,
} from '@/lib/server/teaching-package/package-review-store';

/** The finished verdicts a Stage revision belongs to. */
const VERDICT_STATUSES: ReadonlySet<PackageReview['status']> = new Set([
  'passed',
  'fixed',
  'needs_teacher',
]);

/** Whether a review's verdict is about another revision of its Stage than `currentRev`. */
export function reviewIsStale(
  review: Pick<PackageReview, 'status' | 'reviewedStageRev'>,
  currentRev: number,
): boolean {
  if (!VERDICT_STATUSES.has(review.status)) return false;
  return review.reviewedStageRev === null || review.reviewedStageRev !== currentRev;
}

/**
 * Refuse `PACKAGE_REVIEW_STALE` (409, `{ reviewedStageRev, currentRev }`) when the version's
 * newest review of its current Stage is a finished verdict on another revision. For
 * `submitForReview` and `approve`, inside their transaction, under the aggregate lock,
 * with the revision they just read.
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
  if (!review || !reviewIsStale(review, currentRev)) return;
  throw new TeachingPackageError(
    'PACKAGE_REVIEW_STALE',
    'the AI review is of an earlier version of these slides; press Regenerate flagged to review them again',
    { reviewedStageRev: review.reviewedStageRev, currentRev },
  );
}
