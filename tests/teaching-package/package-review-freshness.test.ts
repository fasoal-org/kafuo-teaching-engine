/**
 * A-34 / A-34b (27 Nov 2026): a finished AI review is a verdict on what its reviewer READ
 * of the Stage. It goes stale only when that changes -- a text edit, a reordered, added
 * or deleted slide -- never on a save that changed nothing or an editor auto-height pass.
 * Submit and Approve refuse PACKAGE_REVIEW_STALE; a legacy row with no revision is stale
 * (fail closed); Regenerate flagged asks ONE fresh review that only reviews. Every
 * Teaching Model. A PGlite database, no model call.
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
  readStageScenesOn,
  refuseStaleReview,
  reviewIsStale,
} from '@/lib/server/teaching-package/package-review-freshness';
import { reviewInputDigest } from '@/lib/server/teaching-package/package-review-input';
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

describe('A-34b: a verdict is stale only when what the reviewer reads changed', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;
  const cp = () => pool as unknown as ConnectableQueryable;

  const currentRev = async () => (await readStageFreshnessManifest(STAGE, qp()))?.rev ?? 0;
  const liveDigest = async () => reviewInputDigest(await readStageScenesOn(qp(), STAGE));
  const version = { id: VERSION, tenantId: TENANT, currentStageId: STAGE, status: 'draft' };
  const refuse = async () => refuseStaleReview(qp(), version, await currentRev());
  const setStatus = (status: string) =>
    pool.query(`UPDATE teaching_package_versions SET status = $2 WHERE id = $1`, [VERSION, status]);

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
    // A text box on the first slide, the way a generated slide carries one.
    await pool.query(
      `UPDATE document_scenes
          SET data = jsonb_set(data, '{content,canvas,elements}',
            '[{"id":"t1","type":"text","content":"<p>الماء يغلي عند 100</p>",
               "left":10,"top":10,"width":400,"height":60}]'::jsonb)
        WHERE stage_id = $1 AND id = 'scene-1'`,
      [STAGE],
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

  /** A review of the Stage that finished `status`, about the Stage as it is now, or none. */
  async function finished(
    status: 'passed' | 'needs_teacher' | 'unavailable',
    about: 'now' | 'none' | { rev: number | null; digest: string | null } = 'now',
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
    const verdict =
      about === 'now'
        ? { reviewedStageRev: await currentRev(), reviewedStageDigest: await liveDigest() }
        : about === 'none'
          ? { reviewedStageRev: null, reviewedStageDigest: null }
          : { reviewedStageRev: about.rev, reviewedStageDigest: about.digest };
    const done = await finishReview(
      qp(),
      id,
      'w',
      { status, findings: [], fixes: [], ...verdict },
      4,
    );
    return done!;
  }

  const update = (sql: string) =>
    pool.query(`UPDATE document_scenes SET ${sql} WHERE stage_id = $1 AND id = 'scene-1'`, [STAGE]);
  const editText = () =>
    update(
      `data = jsonb_set(data, '{content,canvas,elements,0,content}', '"<p>الماء يغلي عند 90</p>"')`,
    );

  it('the run’s reader and the gate’s reader give one review input for one Stage', async () => {
    // The job stamps from the document store's slides; Submit reads them on its transaction.
    const { loadLiveScenes } = await import('@/lib/server/teaching-package/package-review');
    const loaded = (await loadLiveScenes(cp(), STAGE))!;
    expect(reviewInputDigest(loaded)).toBe(await liveDigest());
  });

  it('the finish stores the revision and the review input on the TE row only', async () => {
    const review = await finished('passed');
    expect(review.reviewedStageRev).toBe(await currentRev());
    expect(review.reviewedStageDigest).toBe(await liveDigest());
    expect(packageReviewWire(review)).not.toHaveProperty('reviewedStageRev');
    expect(packageReviewWire(review)).not.toHaveProperty('reviewedStageDigest');
    await expect(refuse()).resolves.toBeUndefined();
  });

  it('a save that changed nothing moves the revision but stays fresh', async () => {
    const review = await finished('passed');
    await update(`data = data`);
    expect(await currentRev()).toBeGreaterThan(review.reviewedStageRev!);
    await expect(refuse()).resolves.toBeUndefined();
  });

  it('an auto-height pass (a text box’s size only) stays fresh; so do a move and a restyle', async () => {
    await finished('passed');
    await update(`data = jsonb_set(data, '{content,canvas,elements,0,height}', '84')`);
    await update(`data = jsonb_set(data, '{content,canvas,elements,0,top}', '30')`);
    await update(
      `data = jsonb_set(data, '{content,canvas,elements,0,content}',
         '"<p style=\\"line-height:1.5\\">الماء يغلي عند 100</p>"')`,
    );
    await expect(refuse()).resolves.toBeUndefined();
  });

  it('a text edit after a passed review: STALE (409) with both revisions', async () => {
    const review = await finished('passed');
    await editText();
    await expect(refuse()).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_STALE',
      status: 409,
      details: { reviewedStageRev: review.reviewedStageRev, currentRev: await currentRev() },
    });
  });

  it('a deleted slide is stale', async () => {
    await finished('passed');
    await pool.query(`DELETE FROM document_scenes WHERE stage_id = $1 AND id = 'scene-2'`, [STAGE]);
    await expect(refuse()).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_STALE' });
  });

  it('a reorder is stale', async () => {
    await finished('passed');
    await pool.query(
      `UPDATE document_scenes
          SET scene_order = CASE id WHEN 'scene-1' THEN 2 ELSE 1 END,
              data = jsonb_set(data, '{order}', CASE id WHEN 'scene-1' THEN '2' ELSE '1' END::jsonb)
        WHERE stage_id = $1`,
      [STAGE],
    );
    await expect(refuse()).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_STALE' });
  });

  it('a legacy row is stale: fail closed (no revision, or no review input)', async () => {
    await finished('passed', 'none');
    await expect(refuse()).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_STALE',
      details: { reviewedStageRev: null },
    });
    const sameRev = { status: 'passed' as const, reviewedStageRev: 3, reviewedStageDigest: null };
    expect(await reviewIsStale(sameRev, 3, async () => 'x')).toBe(true);
  });

  it('not this gate’s to refuse: no review, a review on its way, an unavailable one', async () => {
    await expect(refuse()).resolves.toBeUndefined();
    await insertQueuedReview(qp(), {
      id: 'tpr-queued',
      aggregate: { tenantId: TENANT, learningItem: ITEM },
      versionId: VERSION,
      attemptId: 'tpa-queued',
      stageId: STAGE,
      subjectCode: null,
      now: 2,
    });
    await expect(refuse()).resolves.toBeUndefined();
    const never = async () => {
      throw new Error('the live Stage is read only when the revision moved');
    };
    const of = (status: PackageReview['status'], rev: number | null) => ({
      status,
      reviewedStageRev: rev,
      reviewedStageDigest: rev === null ? null : 'd',
    });
    expect(await reviewIsStale(of('unavailable', null), 3, never)).toBe(false);
    expect(await reviewIsStale(of('running', null), 3, never)).toBe(false);
    expect(await reviewIsStale(of('needs_teacher', 3), 3, never)).toBe(false);
    expect(await reviewIsStale(of('fixed', 2), 3, async () => 'd')).toBe(false);
    expect(await reviewIsStale(of('fixed', 2), 3, async () => 'other')).toBe(true);
  });

  async function press(key = 'learning_item_tp_command:226:regeneration:stamp:1:k') {
    return queueFlaggedSlideRefix(
      cp(),
      { tenantId: TENANT, versionId: VERSION, idempotencyKey: key },
      { now: () => 9 },
    );
  }

  it('a press on a stale verdict asks ONE fresh review that only reviews; then Submit waits for it', async () => {
    const done = await finished('passed');
    await editText();
    const queued = await press();
    expect(queued).toMatchObject({ previousReviewId: done.id, sceneIds: [], replayed: false });
    expect(queued.review).toMatchObject({
      status: 'queued',
      findings: [],
      fixes: [],
      reviewedAt: null,
      summary: null,
      reviewedStageRev: null,
      reviewedStageDigest: null,
    });
    // A `tpr-rf-` id: its run is a first review that only reviews (`isPressedFirstReview`).
    expect(queued.review.id.startsWith('tpr-rf-')).toBe(true);
    const row = await readPackageReview(qp(), queued.review.id, { tenantId: TENANT });
    expect(row).toMatchObject({ status: 'queued', reviewedAt: null });
    // The fresh review is on its way: not stale, and another press is "in progress".
    await expect(refuse()).resolves.toBeUndefined();
    await expect(press('another-key')).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_IN_PROGRESS',
    });
  });

  it('a press on a legacy row asks the fresh review too', async () => {
    await finished('passed', 'none');
    const queued = await press();
    expect(queued.review).toMatchObject({ status: 'queued', reviewedAt: null, findings: [] });
  });

  it('a press after a save that changed nothing keeps the old path (nothing to regenerate)', async () => {
    await finished('passed');
    await update(`data = data`);
    await expect(press()).rejects.toMatchObject({ code: 'NO_REGENERABLE_SLIDES' });
  });

  it('HIGH-1: a rejected version a teacher edits gets its fresh review from a press', async () => {
    const done = await finished('passed');
    await setStatus('rejected');
    await editText();
    const queued = await press();
    expect(queued).toMatchObject({ previousReviewId: done.id, sceneIds: [], replayed: false });
    expect(queued.review).toMatchObject({ status: 'queued', reviewedAt: null, findings: [] });
  });

  it('MEDIUM-1: no press opens on a version in review; the refusal names Start Edit first', async () => {
    await finished('passed', 'none');
    await setStatus('in_review');
    await expect(press()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      refuseStaleReview(qp(), { ...version, status: 'in_review' }, await currentRev()),
    ).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_STALE',
      details: { remedy: 'start_edit_then_regenerate_flagged' },
      message: expect.stringContaining('start an edit'),
    });
    await expect(refuse()).rejects.toMatchObject({
      details: { remedy: 'regenerate_flagged' },
    });
    await expect(
      refuseStaleReview(qp(), { ...version, status: 'rejected' }, await currentRev()),
    ).rejects.toMatchObject({ details: { remedy: 'regenerate_flagged' } });
  });

  it('LOW: renumbering the slides without moving one stays fresh', async () => {
    await finished('passed');
    await pool.query(
      `UPDATE document_scenes
          SET scene_order = scene_order * 10,
              data = jsonb_set(data, '{order}', to_jsonb((data->>'order')::int * 10))
        WHERE stage_id = $1`,
      [STAGE],
    );
    await expect(refuse()).resolves.toBeUndefined();
  });

  it('LOW: a letter coloured inside a word stays fresh (the reviewer reads the word whole)', async () => {
    await finished('passed');
    await update(
      `data = jsonb_set(data, '{content,canvas,elements,0,content}',
         '"<p>الماء يغ<span style=\\"color:red\\">ل</span>ي عند 100</p>"')`,
    );
    await expect(refuse()).resolves.toBeUndefined();
  });

  it('an unavailable review is left to its own rule, never counted stale', async () => {
    await finished('unavailable', 'none');
    await editText();
    await expect(refuse()).resolves.toBeUndefined();
  });
});
