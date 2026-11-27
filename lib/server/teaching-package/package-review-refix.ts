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

import { readStageFreshnessManifest } from '@openmaic/storage';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import type { Queryable } from '@openmaic/storage/document/pg';

import { readAttemptById, readVersionForUpdate } from '@/lib/persistence/teaching-package';
import { readProducingAttemptId } from '@/lib/server/teaching-package/successor-model';
import type { TeachingPackageVersion } from '@/lib/types/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { loadLiveScenes } from '@/lib/server/teaching-package/package-review';
import {
  readStageScenesOn,
  reviewIsStale,
} from '@/lib/server/teaching-package/package-review-freshness';
import {
  REREVIEW_FIGURES_HELD,
  teacherOnlyReason,
} from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  reviewInputDigest,
  reviewSlidesOf,
  slideInputDigest,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
  insertQueuedReview,
  isPressedFirstReview,
  newPackageReviewId,
  REASKED_REVIEW_ID_PREFIX,
  REFIX_REVIEW_ID_PREFIX,
  wasReasked,
  readPackageReview,
  readStageReviewForUpdate,
  requeueReviewForRefix,
  stageReviewAttemptId,
  type PackageReview,
  type StoredFinding,
  type StoredFix,
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
 * A-34 (review HIGH-1): the statuses whose stale verdict a press asks again -- the ones a
 * teacher edits and Submit refuses `PACKAGE_REVIEW_STALE` on. A version in review takes
 * Start Edit first (`details.remedy`). Every other press path stays draft-only.
 */
const STALE_REMEDY_STATUSES: ReadonlySet<string> = new Set(['draft', 'rejected']);

/** Dead end (c): an `unavailable` review a new run would end the same way. */
const PERMANENTLY_UNAVAILABLE: ReadonlySet<string> = new Set([
  'NO_BOOK_SOURCE',
  'VERSION_NOT_FOUND',
]);

/**
 * The reasons a press of Regenerate tries again (plan §3): the slide stayed
 * wrong, a new error was never attempted, or the run stopped. Every other
 * reason stays as it is — a teacher-only one, a regeneration refused, or a slide
 * whose content was fixed but whose audio failed (it has its own "regenerate
 * audio" remedy) -- except a re-check that could not run (dead end (b), below).
 */
const RETRIED_REASONS: ReadonlySet<string> = new Set([
  'STILL_WRONG',
  'NOT_ATTEMPTED',
  'VERSION_CHANGED',
]);

/**
 * The review's findings as the next fix loop must see them:
 *
 * - an open finding with a retried reason (or none) is reset to `null`, which
 *   is what makes the loop regenerate that slide again — unless it is
 *   teacher-only (S5, bank quiz, a check no regeneration may fix), or a person
 *   edited its slide since the review saw it (`liveDigests` differ from the
 *   finding's `sceneDigest`): then it is re-checked only (`recheckOnly`), as the
 *   person made it, never regenerated (review H-2);
 * - of several open findings of one check on one slide (an earlier run adds
 *   the re-reported check again), only the newest is kept, so a press never
 *   piles up copies of one problem;
 * - fixed findings stay fixed.
 */
export function seedRefixFindings(
  findings: readonly StoredFinding[],
  slides: readonly ReviewSlide[],
  liveDigests: ReadonlyMap<string, string> = new Map(),
  fixes: readonly StoredFix[] = [],
): RefixSeed {
  const edited = (finding: StoredFinding) =>
    finding.sceneDigest !== undefined &&
    liveDigests.size > 0 &&
    liveDigests.get(finding.targetId) !== finding.sceneDigest;
  // The newest fix entry of each finding (a later run's entry wins).
  const fixOf = new Map<string, StoredFix>();
  for (const fix of fixes) for (const id of fix.findingIds) fixOf.set(id, fix);
  // Dead end (b), 27 Nov 2026: a `REREVIEW_UNAVAILABLE` finding sits on a slide that was
  // already regenerated, but whose re-check could not run (the call failed) or could not
  // see the book figures a fresh run sends (RV-1: the run's budget, a resumed run). Each
  // press now re-checks that live slide ONCE, without paying for a regeneration
  // (`recheckOnly`). What it waits for is read from the finding (`heldFor`, kept across
  // presses):
  // - `recheck`: re-checked only;
  // - `audio`: its narration audio failed too -- regenerated, so its audio is made again;
  // - `person`: a figure hold no retry cures (an unread or refused figure) -- left as it
  //   is, so no press pays for it again.
  // A row from before 27 Nov has no `heldFor`. Its fix entry's code is the audio failure
  // when there was one (any TeachingPackageError code), else `REREVIEW_UNAVAILABLE`; so
  // only that exact code is a plain re-check. A figure hold (`REREVIEW_FIGURES_HELD`)
  // kept no audio code: a curable one is regenerated (its audio may have failed), any
  // other waits for a person. Another code, or no fix entry: regenerated, the safe remedy.
  const heldFor = (finding: StoredFinding): NonNullable<StoredFinding['heldFor']> | null => {
    if (finding.teacherReason !== 'REREVIEW_UNAVAILABLE') return null;
    if (finding.heldFor) return finding.heldFor;
    const fix = fixOf.get(finding.id);
    if (fix?.code === REREVIEW_FIGURES_HELD) {
      return (fix.retryForFigures ?? []).includes(finding.id) ? 'audio' : 'person';
    }
    return fix?.code === 'REREVIEW_UNAVAILABLE' ? 'recheck' : 'audio';
  };
  // Review of 97cc78c3..4f6f8ddb (H-2): a slide a person edited since the review saw it is
  // re-checked once as the person made it (a re-check never regenerates), with EVERY open
  // finding of it a press acts on -- retried, `VERSION_CHANGED` from an earlier press, or
  // held (an audio or a `person` hold too) -- in that one re-check, so a teacher's own fix
  // can close them. The re-check records the slide it saw, so it runs once per edit.
  const acted = (finding: StoredFinding, editedSlide: boolean) => {
    const held = heldFor(finding);
    return (
      finding.teacherReason === null ||
      RETRIED_REASONS.has(finding.teacherReason) ||
      held === 'recheck' ||
      held === 'audio' ||
      (held === 'person' && editedSlide)
    );
  };
  const reasoned = findings.map((finding): StoredFinding => {
    // A marker is worked out again on every press, never carried forward; `heldFor`
    // stays only on a finding that is left as it is.
    const { recheckOnly: _stale, heldFor: _held, ...base } = finding;
    if (base.status !== 'open') return base;
    const editedSlide = edited(base);
    if (!acted(finding, editedSlide)) {
      return finding.heldFor ? { ...base, heldFor: finding.heldFor } : base;
    }
    const teacherOnly = teacherOnlyReason({ ...base, teacherReason: null }, slides);
    if (teacherOnly) return { ...base, teacherReason: teacherOnly };
    return {
      ...base,
      teacherReason: null,
      ...(editedSlide || heldFor(finding) === 'recheck' ? { recheckOnly: true as const } : {}),
    };
  });
  // Newest first: the last of one slide's check is the one kept.
  const seen = new Set<string>();
  const dropped = new Set<number>();
  for (let index = reasoned.length - 1; index >= 0; index -= 1) {
    const finding = reasoned[index]!;
    if (finding.status !== 'open' || finding.teacherReason !== null) continue;
    const key = `${finding.targetId}\u0000${finding.check}`;
    if (seen.has(key)) dropped.add(index);
    else seen.add(key);
  }
  const seeded = reasoned.filter((_, index) => !dropped.has(index));
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

/**
 * A replay's slides: the ones the queued review was seeded to regenerate (open,
 * no reason yet), in the stored order — so the Admin never says "0 slides".
 */
function queuedSceneIds(findings: readonly StoredFinding[]): string[] {
  const ids: string[] = [];
  for (const finding of findings) {
    if (
      finding.status === 'open' &&
      finding.teacherReason === null &&
      finding.targetId &&
      !ids.includes(finding.targetId)
    ) {
      ids.push(finding.targetId);
    }
  }
  return ids;
}

/** Deterministic per (tenant, version, request key): a retry names the same review. */
export function refixReviewId(tenantId: string, versionId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}\u0000${versionId}\u0000${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 16);
  return `${REFIX_REVIEW_ID_PREFIX}${digest}`;
}

/**
 * M-1: the id a press gives a review it re-asks after it ended `unavailable` (dead end
 * (c)) -- deterministic like `refixReviewId`, and marked, so its own exhaustion is known
 * as the second one.
 */
export function reaskReviewId(tenantId: string, versionId: string, idempotencyKey: string) {
  const digest = createHash('sha256')
    .update(`${tenantId}\u0000${versionId}\u0000${idempotencyKey}\u0000reask`)
    .digest('base64url')
    .slice(0, 16);
  return `${REASKED_REVIEW_ID_PREFIX}${digest}`;
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
 * Dead end (a): the first review of an edit successor's current Stage, read from its
 * producing attempt (the book, the Teaching Model). One per Stage: the row's attempt key
 * is `stageReviewAttemptId`. `null` when no attempt produced this content (no book).
 */
async function queueStageReview(
  tx: Queryable,
  version: TeachingPackageVersion,
  id: string,
  now: number,
): Promise<PackageReview | null> {
  const producing = await readProducingAttemptId(tx, version.id);
  if (!producing) return null;
  // Review of 103f9c1c: no catch -- a failed read inside the transaction aborts it anyway.
  const attempt = await readAttemptById(tx, producing.attemptId);
  const subjectCode = (attempt?.inputSnapshot as { subjectCode?: unknown } | undefined)
    ?.subjectCode;
  const storedId = await insertQueuedReview(tx, {
    id,
    aggregate: { tenantId: version.tenantId, learningItem: version.learningItem },
    versionId: version.id,
    attemptId: stageReviewAttemptId(producing.attemptId, version.currentStageId),
    stageId: version.currentStageId,
    subjectCode: typeof subjectCode === 'string' ? subjectCode : null,
    now,
  });
  return readPackageReview(tx, storedId, { tenantId: version.tenantId });
}

/**
 * Dead end (a) at submit: the first review of an edit successor's current Stage, when it
 * has none yet. For `submitForReview` to call after its commit (best effort; it never
 * fails a submit). Not wired yet: the call lands in `lifecycle.ts` (TE slot-5).
 * A Stage review only reviews (`isPressedFirstReview`), so no slide is regenerated even
 * when the teacher presses Start Edit while it runs; any finding waits for the teacher:
 * Start Edit, then Regenerate flagged. `null` when nothing was queued (an attempt of its
 * own, a review of this Stage already, no producing attempt). One per Stage, like the
 * press.
 */
export async function queueSuccessorStageReview(
  pool: ConnectableQueryable,
  input: { tenantId: string; versionId: string },
  deps: { now?: () => number } = {},
): Promise<PackageReview | null> {
  const now = deps.now ?? Date.now;
  return nodePostgresTransaction(pool)(async (tx: Queryable) => {
    const version = await readVersionForUpdate(tx, input.versionId, { tenantId: input.tenantId });
    if (!version || version.currentAttemptId !== null) return null;
    const existing = await readStageReviewForUpdate(tx, {
      tenantId: input.tenantId,
      versionId: version.id,
      stageId: version.currentStageId,
    });
    if (existing) return null;
    return queueStageReview(tx, version, newPackageReviewId(), now());
  });
}

/**
 * Queue the flagged-slide regeneration of one draft. Refusals (409 unless
 * noted): `NOT_FOUND` (404), `INVALID_TRANSITION` (not a draft),
 * `GENERATION_IN_PROGRESS`, `PACKAGE_REVIEW_NOT_READY` (no finished review of the
 * current Stage), `PACKAGE_REVIEW_IN_PROGRESS`, `STAGE_NOT_LIVE` and
 * `NO_REGENERABLE_SLIDES`.
 *
 * Dead ends (27 Nov 2026), through the same route and wire: an edit successor with no
 * review of its Stage gets its first review queued (a); a review that ended
 * `unavailable` before its first answer is asked again from the start (c); a
 * `REREVIEW_UNAVAILABLE` finding is re-checked without a regeneration (b,
 * `seedRefixFindings`). Each answers `202` with the queued review.
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
  const reaskId = reaskReviewId(input.tenantId, input.versionId, input.idempotencyKey);

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
    if (review && (review.id === newReviewId || review.id === reaskId)) {
      return {
        review,
        previousReviewId: null,
        sceneIds: queuedSceneIds(review.findings),
        replayed: true,
      };
    }
    // A-34/A-34b: a verdict on what the reviewer no longer sees (a person changed the
    // slides it read since, or a row from before A-34) is asked again from the start: ONE
    // whole review that only reviews (`isPressedFirstReview`: its `tpr-rf-` id), never a
    // regeneration over the edit. Its 202 is what Kafuo adopts; Submit and Approve wait
    // for its verdict. The same rule, and reader, as Submit's.
    // Review of 911b5e58..febbdcd9 (HIGH-1): it regenerates nothing, so it serves a draft
    // AND a rejected version a teacher edits, before the draft-only flagged-slide path.
    if (review && STALE_REMEDY_STATUSES.has(version.status)) {
      const currentRev = (await readStageFreshnessManifest(version.currentStageId, tx))?.rev ?? 0;
      const stale = await reviewIsStale(review, currentRev, async () =>
        reviewInputDigest(await readStageScenesOn(tx, version.currentStageId)),
      );
      if (stale) {
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
        const requeued = await requeueReviewForRefix(tx, {
          reviewId: review.id,
          newReviewId,
          findings: [],
          now: now(),
          freshFirstReview: true,
        });
        if (!requeued) {
          throw new TeachingPackageError(
            'PACKAGE_REVIEW_IN_PROGRESS',
            'the AI review of this package changed meanwhile',
          );
        }
        return { review: requeued, previousReviewId: review.id, sceneIds: [], replayed: false };
      }
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
    if (!review) {
      // Dead end (a), 27 Nov 2026: an edit successor (no attempt of its own) never had a
      // review, so Kafuo refuses its approval forever (TEACHING_PACKAGE_REVIEW_MISSING).
      // A press queues ONE first review of its current Stage, which only reviews (no slide
      // of the teacher's edit is regenerated: `isPressedFirstReview`); its
      // `review_completed` creates Kafuo's row. A version with an attempt of its own and
      // no review was not reviewed on purpose (Kafuo keeps a cleared row for it): still
      // "not ready".
      if (version.currentAttemptId === null) {
        const queued = await queueStageReview(tx, version, newReviewId, now());
        if (queued)
          return { review: queued, previousReviewId: null, sceneIds: [], replayed: false };
      }
      throw new TeachingPackageError(
        'PACKAGE_REVIEW_NOT_READY',
        'the current package has no finished AI review to take its open issues from',
      );
    }
    if (review.reviewedAt === null) {
      // Review 27 Nov 2026: a first review a press or a submit queued, still on its way, is
      // "in progress" (Kafuo adopts it from that refusal), never "not ready". A generation's
      // own first review keeps "not ready" until it answers.
      if (
        (review.status === 'queued' || review.status === 'running') &&
        isPressedFirstReview(review)
      ) {
        throw new TeachingPackageError(
          'PACKAGE_REVIEW_IN_PROGRESS',
          'the AI review of this package is still running',
        );
      }
      // Dead end (c): a review that ended `unavailable` before its first answer (both
      // routes down, say) is asked again from the start -- one whole-package review per
      // press, never a slide regeneration (`isPressedFirstReview`: it only reviews).
      // Review of c3f02fdc: a cause another run cannot cure (no book, no version) is not
      // re-asked -- it would end the same way on every press. Review 27 Nov 2026: nor is a
      // review that used up its runs after a press already re-asked it (each run may pay
      // for a first call; a second exhaustion is no outage a further press cures).
      // M-1: "re-asked" is the re-ask's own id (`reaskReviewId`), never any press's id --
      // a Stage review a press or a submit queued (dead end (a)) that exhausts on its
      // first try is re-asked once, like any other.
      const exhaustedAgain = review.errorCode === 'REVIEW_ATTEMPTS_EXHAUSTED' && wasReasked(review);
      if (
        review.status === 'unavailable' &&
        !PERMANENTLY_UNAVAILABLE.has(review.errorCode ?? '') &&
        !exhaustedAgain
      ) {
        const requeued = await requeueReviewForRefix(tx, {
          reviewId: review.id,
          newReviewId: reaskId,
          findings: [],
          now: now(),
        });
        if (!requeued) {
          throw new TeachingPackageError(
            'PACKAGE_REVIEW_IN_PROGRESS',
            'the AI review of this package changed meanwhile',
          );
        }
        return { review: requeued, previousReviewId: review.id, sceneIds: [], replayed: false };
      }
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
    const seed = seedRefixFindings(
      review.findings,
      reviewSlidesOf(scenes),
      // Review of 9009dfc4 (MEDIUM-B): "edited" is a change to what the reviewer reads of
      // the slide; a layout-only change (sizes, positions) is not one -- the slide follows
      // the normal regenerate path (a regeneration may replace a layout tweak).
      new Map(scenes.map((scene) => [scene.id, slideInputDigest(scene)])),
      review.fixes,
    );
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
