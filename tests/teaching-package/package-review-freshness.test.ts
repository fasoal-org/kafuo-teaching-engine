/**
 * A-34 (27 Nov 2026): a finished AI review is a verdict on one revision of its Stage. An
 * edit after it makes it stale: Submit and Approve refuse PACKAGE_REVIEW_STALE, a legacy
 * row with no revision is stale too (fail closed), and Regenerate flagged asks ONE fresh
 * review that only reviews. Every Teaching Model. A PGlite database, no model call.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { readStageFreshnessManifest } from '@openmaic/storage';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  refuseStaleReview,
  reviewIsStale,
} from '@/lib/server/teaching-package/package-review-freshness';
import { queueFlaggedSlideRefix } from '@/lib/server/teaching-package/package-review-refix';
import {
  claimReview,
  finishReview,
  insertQueuedReview,
  packageReviewWire,
  readPackageReview,
  type PackageReview,
} from '@/lib/server/teaching-package/package-review-store';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-a34';
const STAGE = 'stage-a34';
const VERSION = 'tpv-a34';
const ITEM = { type: 'lesson' as const, id: '226' };

describe('A-34: a review is a verdict on one revision of its Stage', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;
  const cp = () => pool as unknown as ConnectableQueryable;

  const currentRev = async () => (await readStageFreshnessManifest(STAGE, qp()))?.rev ?? 0;
  const version = { id: VERSION, tenantId: TENANT, currentStageId: STAGE };

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(STAGE, 'A-34', [
        makeSlideScene('scene-1', STAGE, 1),
        makeSlideScene('scene-2', STAGE, 2),
      ]),
    );
    await insertVersion(qp(), {
      id: VERSION,
      aggregate: { tenantId: TENANT, learningItem: ITEM },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      // g5.v11: the rule is approval safety, not planner text -- every Teaching Model.
      teachingModel: { key: 'g5', version: 'g5.v11' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
  });

  /** A review of the Stage that finished `status`, about `reviewedStageRev`. */
  async function finished(
    status: 'passed' | 'needs_teacher' | 'unavailable',
    reviewedStageRev: number | null,
    id = 'tpr-a34',
  ): Promise<PackageReview> {
    await insertQueuedReview(qp(), {
      id,
      aggregate: { tenantId: TENANT, learningItem: ITEM },
      versionId: VERSION,
      attemptId: `tpa-${id}`,
      stageId: STAGE,
      subjectCode: null,
      now: 2,
    });
    await claimReview(qp(), id, { workerId: 'w', now: 3, leaseMs: 60_000 });
    // Its first answer is stored (an unavailable one never got one).
    if (status !== 'unavailable') {
      await pool.query(`UPDATE teaching_package_reviews SET reviewed_at = 3 WHERE id = $1`, [id]);
    }
    const done = await finishReview(
      qp(),
      id,
      'w',
      { status, findings: [], fixes: [], reviewedStageRev },
      4,
    );
    return done!;
  }

  const editSlide = () =>
    pool.query(
      `UPDATE document_scenes SET data = jsonb_set(data, '{title}', '"عدّله المعلم"')
        WHERE id = 'scene-1'`,
    );

  it('the finish stores the revision on the TE row only; a passed review of the Stage as it is passes', async () => {
    const rev = await currentRev();
    const review = await finished('passed', rev);
    expect(review.reviewedStageRev).toBe(rev);
    expect(packageReviewWire(review)).not.toHaveProperty('reviewedStageRev');
    await expect(refuseStaleReview(qp(), version, rev)).resolves.toBeUndefined();
  });

  it('an edit after a passed review: STALE (409) with both revisions', async () => {
    const reviewed = await currentRev();
    await finished('passed', reviewed);
    await editSlide();
    const now = await currentRev();
    expect(now).toBeGreaterThan(reviewed);
    await expect(refuseStaleReview(qp(), version, now)).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_STALE',
      status: 409,
      details: { reviewedStageRev: reviewed, currentRev: now },
    });
  });

  it('a legacy row with no revision is stale: fail closed', async () => {
    await finished('passed', null);
    await expect(refuseStaleReview(qp(), version, await currentRev())).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_STALE',
      details: { reviewedStageRev: null },
    });
  });

  it('not this gate’s to refuse: no review, a review on its way, an unavailable one', async () => {
    await expect(refuseStaleReview(qp(), version, await currentRev())).resolves.toBeUndefined();
    await insertQueuedReview(qp(), {
      id: 'tpr-queued',
      aggregate: { tenantId: TENANT, learningItem: ITEM },
      versionId: VERSION,
      attemptId: 'tpa-queued',
      stageId: STAGE,
      subjectCode: null,
      now: 2,
    });
    await expect(refuseStaleReview(qp(), version, await currentRev())).resolves.toBeUndefined();
    expect(reviewIsStale({ status: 'unavailable', reviewedStageRev: null }, 3)).toBe(false);
    expect(reviewIsStale({ status: 'running', reviewedStageRev: null }, 3)).toBe(false);
    expect(reviewIsStale({ status: 'needs_teacher', reviewedStageRev: 3 }, 3)).toBe(false);
    expect(reviewIsStale({ status: 'fixed', reviewedStageRev: 2 }, 3)).toBe(true);
  });

  async function press(key = 'learning_item_tp_command:226:regeneration:stamp:1:k') {
    return queueFlaggedSlideRefix(
      cp(),
      { tenantId: TENANT, versionId: VERSION, idempotencyKey: key },
      { now: () => 9 },
    );
  }

  it('a press on a stale verdict asks ONE fresh review that only reviews; then Submit waits for it', async () => {
    const done = await finished('passed', await currentRev());
    await editSlide();
    const queued = await press();
    expect(queued).toMatchObject({ previousReviewId: done.id, sceneIds: [], replayed: false });
    expect(queued.review).toMatchObject({
      status: 'queued',
      findings: [],
      fixes: [],
      reviewedAt: null,
      summary: null,
      reviewedStageRev: null,
    });
    // A `tpr-rf-` id: its run is a first review that only reviews (`isPressedFirstReview`).
    expect(queued.review.id.startsWith('tpr-rf-')).toBe(true);
    const row = await readPackageReview(qp(), queued.review.id, { tenantId: TENANT });
    expect(row).toMatchObject({ status: 'queued', reviewedAt: null });
    // The fresh review is on its way: not stale, and another press is "in progress".
    await expect(refuseStaleReview(qp(), version, await currentRev())).resolves.toBeUndefined();
    await expect(press('another-key')).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_IN_PROGRESS',
    });
  });

  it('a press on a legacy row (no revision) asks the fresh review too', async () => {
    await finished('passed', null);
    const queued = await press();
    expect(queued.review).toMatchObject({ status: 'queued', reviewedAt: null, findings: [] });
  });

  it('a press on a verdict of the Stage as it is keeps the old path (nothing to regenerate)', async () => {
    await finished('passed', await currentRev());
    await expect(press()).rejects.toMatchObject({ code: 'NO_REGENERABLE_SLIDES' });
  });

  it('an unavailable review is left to its own rule, never counted stale', async () => {
    await finished('unavailable', null);
    await editSlide();
    await expect(refuseStaleReview(qp(), version, await currentRev())).resolves.toBeUndefined();
  });
});
