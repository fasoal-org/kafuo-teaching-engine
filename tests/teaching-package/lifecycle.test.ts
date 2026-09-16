import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { readStageFreshnessManifest } from '@openmaic/storage';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  ensureTeachingPackageSchema,
  insertVersion,
  listReviewEvents,
  readVersion,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import {
  approve,
  discardSuccessor,
  reject,
  startReviewEdit,
  submitForReview,
} from '@/lib/server/teaching-package/lifecycle';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';
import { insertAttempt } from '@/lib/persistence/teaching-package';

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

/** A pool whose queries throw when the predicate matches — failure injection. */
function poolFailingOn(
  pool: PGlitePool,
  shouldFail: (text: string, params: unknown[] | undefined) => boolean,
): ConnectableQueryable {
  const failQuery = async (text: string, params?: unknown[]) => {
    if (shouldFail(text, params)) throw new Error('injected statement failure');
    return pool.query(text, params);
  };
  return {
    query: failQuery,
    connect: async () => ({ query: failQuery, release() {} }),
  } as unknown as ConnectableQueryable;
}

async function expectTeachingPackageError(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TeachingPackageError);
  await expect(promise).rejects.toMatchObject({ code, status });
}

describe('teaching package lifecycle', () => {
  let pool: PGlitePool;
  const tx = () => pool as unknown as ConnectableQueryable;
  const qp = () => pool as never;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;

  async function seedLiveStage(stageId: string): Promise<void> {
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(stageId, 'Lifecycle', [makeSlideScene('scene-1', stageId, 1)]),
    );
  }

  /** v1 with the given status, plus an approved predecessor when asked for. */
  async function seedVersion(options: {
    status: TeachingPackageStatus;
    withPredecessor?: boolean;
  }): Promise<{ versionId: string; stageId: string; predecessorId: string | null }> {
    const stageId = unique('stage-lc');
    await seedLiveStage(stageId);
    let predecessorId: string | null = null;
    if (options.withPredecessor) {
      const predStageId = unique('stage-lc-pred');
      await seedLiveStage(predStageId);
      predecessorId = unique('tpv-pred');
      await insertVersion(qp(), {
        id: predecessorId,
        aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: unique('li-lc') } },
        version: 1,
        status: 'approved',
        currentStageId: predStageId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
    }
    const versionId = unique('tpv');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: {
        tenantId: 'tenant-test',
        learningItem: {
          type: 'lesson',
          id: predecessorId
            ? (await readVersion(qp(), predecessorId, { tenantId: 'tenant-test' }))!.learningItem.id
            : unique('li-lc'),
        },
      },
      version: predecessorId ? 2 : 1,
      status: options.status,
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      predecessorVersionId: predecessorId,
      now: 2,
    });
    return { versionId, stageId, predecessorId };
  }

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
    // The exact-flow submit gate loads stage documents through the
    // owner-scoped store; point the server persistence provider at this
    // test's PGlite pool (same seam generation.test.ts uses).
    const { getServerPersistenceProvider } = await import(
      '@/lib/persistence/server-provider'
    );
    vi.stubEnv('DATABASE_URL', `postgres://lifecycle-${(counter += 1)}`);
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  describe('submitForReview exact-flow gate', () => {
    async function seedFlowBackedVersion(
      buildScenes: (stageId: string) => AppScene[],
    ): Promise<string> {
      const { versionId, stageId } = await seedVersion({ status: 'draft' });
      // Overwrite the version's own stage document with the given scenes
      // (flow-tagged or not) through the same owner-bound store.
      const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId: TEACHING_PACKAGE_STAGE_OWNER,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence: teachingPackageStageGuardFence(),
      });
      await store.saveDocument(makeDocument(stageId, 'Flow', buildScenes(stageId)));
      // A generation attempt carrying the authoritative flow, linked as the
      // version's producing attempt.
      const flow = [
        { stage: 'lesson_introduction', instructions: 'i' },
        { stage: 'outcome_teaching_cards', instructions: 'c' },
      ];
      const attemptId = unique('tpa');
      const learningItem = (await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!
        .learningItem;
      await insertAttempt(qp(), {
        id: attemptId,
        aggregate: { tenantId: 'tenant-test', learningItem },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'actor-1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        inputSnapshot: {
          learningItem,
          teachingModel: { key: 'g5', version: 'g5.v1' },
          learningObjectives: [],
          contentUnitRefs: [],
          sourceRefs: [],
          generationContext: {},
          generationOptions: {},
          requirementDigest: '0'.repeat(64),
          requirementPreview: 'p',
          pdfContentSummary: null,
          requestedAt: 1,
          teachingFlow: flow,
        },
        now: 1,
      });
      await pool.query(
        `UPDATE teaching_package_versions SET current_attempt_id = $2 WHERE id = $1`,
        [versionId, attemptId],
      );
      return versionId;
    }

    it('blocks submission when a scene sequence violates the recorded flow', async () => {
      const versionId = await seedFlowBackedVersion((stageId) => [
        { ...makeSlideScene('s1', stageId, 1), teachingStage: { key: 'lesson_introduction', flowIndex: 0 } },
        { ...makeSlideScene('s2', stageId, 2) }, // missing position 1
      ] as AppScene[]);
      await expectTeachingPackageError(
        submitForReview(tx(), {
          tenantId: 'tenant-test',
          versionId,
          actorRef: 'reviewer-1',
        }),
        'TEACHING_MODEL_FLOW_MISMATCH',
        409,
      );
    });

    it('admits submission when the scene sequence covers the flow exactly', async () => {
      const versionId = await seedFlowBackedVersion((stageId) => [
        { ...makeSlideScene('s1', stageId, 1), teachingStage: { key: 'lesson_introduction', flowIndex: 0 } },
        { ...makeSlideScene('s2', stageId, 2), teachingStage: { key: 'lesson_introduction', flowIndex: 0 } },
        { ...makeSlideScene('s3', stageId, 3), teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 } },
      ] as AppScene[]);
      const updated = await submitForReview(tx(), {
        tenantId: 'tenant-test',
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(updated.status).toBe('in_review');
    });

    /* ---- the Stage moving between the proof and the lock --------------------------
     *
     * The exact-flow proof is now taken BEFORE the aggregate-locked transaction (it
     * loads the Stage document, which takes its own pool connection and would deadlock
     * against `stage_meta FOR UPDATE` if held under the lock -- see
     * `lifecycle-postgres.pg.test.ts`). So the proof can go stale if the Editor saves in
     * between, and the transaction must refuse to submit an experience it never
     * validated. Nothing here is reachable from the happy path, which is exactly why it
     * needs its own tests.
     * ------------------------------------------------------------------------------ */

    /** Bump the stage's revision the first `times` times its revision is read. */
    function poolBumpingStageRevOnRead(
      base: PGlitePool,
      stageId: string,
      times: number,
    ): ConnectableQueryable {
      let remaining = times;
      const query = async (text: string, params?: unknown[]) => {
        if (
          remaining > 0 &&
          text.includes('FROM document_stage_revision') &&
          params?.[0] === stageId
        ) {
          remaining -= 1;
          // A concurrent Editor save, as the trigger would record it.
          await base.query(
            `INSERT INTO document_stage_revision (stage_id, rev) VALUES ($1, 1)
               ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1`,
            [stageId],
          );
        }
        return base.query(text, params);
      };
      return {
        query,
        connect: async () => ({ query, release() {} }),
      } as unknown as ConnectableQueryable;
    }

    it('re-proves the flow once when the stage moves between validation and the lock', async () => {
      const versionId = await seedFlowBackedVersion((stageId) => [
        { ...makeSlideScene('s1', stageId, 1), teachingStage: { key: 'lesson_introduction', flowIndex: 0 } },
        { ...makeSlideScene('s2', stageId, 2), teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 } },
      ] as AppScene[]);
      const stageId = (await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!
        .currentStageId;

      // Drift exactly once: the first attempt's proof is stale, the retry's is not.
      const updated = await submitForReview(
        poolBumpingStageRevOnRead(pool, stageId, 1),
        { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' },
      );

      expect(updated.status).toBe('in_review');
      // The captured revision is the one the SECOND proof was verified against, so
      // approve's STAGE_CHANGED_SINCE_SUBMISSION compares against a validated stage.
      const manifest = await readStageFreshnessManifest(stageId, qp() as never);
      expect(updated.submittedStageRev).toBe(manifest.rev);
      // A drifted attempt commits nothing: exactly one transition was recorded.
      const events = await listReviewEvents(qp(), versionId);
      expect(events.filter((event) => event.toStatus === 'in_review')).toHaveLength(1);
    });

    it('refuses with STALE_STATE when the stage keeps moving', async () => {
      const versionId = await seedFlowBackedVersion((stageId) => [
        { ...makeSlideScene('s1', stageId, 1), teachingStage: { key: 'lesson_introduction', flowIndex: 0 } },
        { ...makeSlideScene('s2', stageId, 2), teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 } },
      ] as AppScene[]);
      const stageId = (await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!
        .currentStageId;

      // Drift on every proof: the bounded retry gives up rather than submitting an
      // unvalidated experience, and says so as a 409 rather than a 500.
      await expectTeachingPackageError(
        submitForReview(poolBumpingStageRevOnRead(pool, stageId, 99), {
          tenantId: 'tenant-test',
          versionId,
          actorRef: 'reviewer-1',
        }),
        'STALE_STATE',
        409,
      );
      expect((await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status).toBe(
        'draft',
      );
      const events = await listReviewEvents(qp(), versionId);
      expect(events.filter((event) => event.toStatus === 'in_review')).toHaveLength(0);
    });

    it('still refuses a non-submittable status with INVALID_TRANSITION, not a stage error', async () => {
      // Error precedence: the pre-transaction validation skips the document load for a
      // version this read says is not submittable, so an approved version whose stage is
      // gone still answers the status refusal rather than STAGE_NOT_LIVE.
      const { versionId, stageId } = await seedVersion({ status: 'approved' });
      await pool.query(`UPDATE stage_meta SET deleted_at = now() WHERE stage_id = $1`, [stageId]);

      await expectTeachingPackageError(
        submitForReview(tx(), {
          tenantId: 'tenant-test',
          versionId,
          actorRef: 'reviewer-1',
        }),
        'INVALID_TRANSITION',
        409,
      );
    });

    it('skips the gate for legacy versions with no recorded flow', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      const updated = await submitForReview(tx(), {
        tenantId: 'tenant-test',
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(updated.status).toBe('in_review');
    });
  });

  describe('submitForReview', () => {
    it('moves a draft to in_review and records the submission event', async () => {
      const { versionId, stageId } = await seedVersion({ status: 'draft' });

      const updated = await submitForReview(tx(), {
        tenantId: 'tenant-test',
        versionId,
        actorRef: 'actor-submit',
        comment: 'ready',
      });
      expect(updated.status).toBe('in_review');
      expect(updated.submittedAt).not.toBeNull();
      const events = await listReviewEvents(qp(), versionId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'submitted_for_review',
        fromStatus: 'draft',
        toStatus: 'in_review',
        actorRef: 'actor-submit',
        comment: 'ready',
      });
      // The stage revision is captured for the approve re-check.
      expect(updated.submittedStageRev).toBeGreaterThan(0);
      expect(stageId).toBeTruthy();
    });

    it('resubmits a rejected version as the same version', async () => {
      const { versionId } = await seedVersion({ status: 'rejected' });
      const updated = await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      expect(updated.status).toBe('in_review');
      const events = await listReviewEvents(qp(), versionId);
      expect(events[0]).toMatchObject({ eventType: 'resubmitted', fromStatus: 'rejected' });
    });

    it.each(['in_review', 'approved', 'superseded', 'discarded'] as const)(
      'refuses to submit from %s',
      async (status) => {
        const { versionId } = await seedVersion({ status });
        await expectTeachingPackageError(
          submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' }),
          'INVALID_TRANSITION',
          409,
        );
        expect((await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status).toBe(status);
        expect(await listReviewEvents(qp(), versionId)).toHaveLength(0);
      },
    );
  });

  describe('startReviewEdit', () => {
    it('returns an in_review version to draft and clears the captured revision', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });

      const updated = await startReviewEdit(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-2' });
      expect(updated.status).toBe('draft');
      expect(updated.submittedStageRev).toBeNull();
      const events = await listReviewEvents(qp(), versionId);
      expect(events.map((event) => event.eventType)).toEqual([
        'submitted_for_review',
        'review_edit_started',
      ]);
    });

    it.each(['draft', 'rejected', 'approved', 'superseded', 'discarded'] as const)(
      'refuses to start an edit from %s',
      async (status) => {
        const { versionId } = await seedVersion({ status });
        await expectTeachingPackageError(
          startReviewEdit(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' }),
          'INVALID_TRANSITION',
          409,
        );
      },
    );
  });

  describe('reject', () => {
    it('rejects an in_review version with a mandatory reason', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });

      const updated = await reject(tx(), {
        tenantId: 'tenant-test',
        versionId,
        actorRef: 'reviewer-1',
        reason: '  needs better examples  ',
      });
      expect(updated.status).toBe('rejected');
      const events = await listReviewEvents(qp(), versionId);
      expect(events[1]).toMatchObject({
        eventType: 'rejected',
        reason: 'needs better examples',
        actorRef: 'reviewer-1',
      });
    });

    it.each([undefined, '', '   '])('refuses a missing or blank reason %j', async (reason) => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      const eventsBefore = await listReviewEvents(qp(), versionId);

      await expectTeachingPackageError(
        reject(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1', reason: reason as string }),
        'REASON_REQUIRED',
        400,
      );
      // The row is untouched and no event was appended.
      expect((await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status).toBe('in_review');
      expect(await listReviewEvents(qp(), versionId)).toHaveLength(eventsBefore.length);
    });

    it.each(['draft', 'rejected', 'approved', 'superseded', 'discarded'] as const)(
      'refuses to reject from %s',
      async (status) => {
        const { versionId } = await seedVersion({ status });
        await expectTeachingPackageError(
          reject(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1', reason: 'nope' }),
          'INVALID_TRANSITION',
          409,
        );
      },
    );
  });

  describe('expectedStatus', () => {
    it('refuses a stale command with 409 STALE_STATE', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await expectTeachingPackageError(
        submitForReview(tx(), {
          tenantId: 'tenant-test',
          versionId,
          actorRef: 'actor-1',
          expectedStatus: 'approved',
        }),
        'STALE_STATE',
        409,
      );
      expect((await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status).toBe('draft');
    });

    it('requires a non-empty actor reference', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await expectTeachingPackageError(
        submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: '   ' }),
        'ACTOR_REQUIRED',
        400,
      );
    });
  });

  describe('approve', () => {
    it('approves an unchanged submitted version with no predecessor', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });

      const updated = await approve(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' });
      expect(updated.status).toBe('approved');
      expect(updated.approvedAt).not.toBeNull();
      const events = await listReviewEvents(qp(), versionId);
      expect(events.at(-1)).toMatchObject({
        eventType: 'approved',
        fromStatus: 'in_review',
        toStatus: 'approved',
        relatedVersionId: null,
      });
    });

    it('refuses approval when the stage changed since submission', async () => {
      const { versionId, stageId } = await seedVersion({ status: 'draft' });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      // A content write after submission bumps the revision (still editable
      // only because the version is in_review — go through startReviewEdit).
      await startReviewEdit(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId: TEACHING_PACKAGE_STAGE_OWNER,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence: teachingPackageStageGuardFence(),
      });
      await store.putScene(stageId, makeSlideScene('scene-2', stageId, 2));
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      // Another content change after this submission, hidden from the service:
      await pool.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data)
         VALUES ($1, 'scene-3', 3, '{}'::jsonb)
         ON CONFLICT (stage_id, id) DO NOTHING`,
        [stageId],
      );

      await expectTeachingPackageError(
        approve(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' }),
        'STAGE_CHANGED_SINCE_SUBMISSION',
        409,
      );
      expect((await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status).toBe('in_review');
    });

    it('approves after a pre-submission edit (revision matches)', async () => {
      const { versionId, stageId } = await seedVersion({ status: 'draft' });
      const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId: TEACHING_PACKAGE_STAGE_OWNER,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence: teachingPackageStageGuardFence(),
      });
      await store.putScene(stageId, makeSlideScene('scene-2', stageId, 2));
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });

      const updated = await approve(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' });
      expect(updated.status).toBe('approved');
    });

    it.each(['draft', 'rejected', 'approved', 'superseded', 'discarded'] as const)(
      'refuses to approve from %s',
      async (status) => {
        const { versionId } = await seedVersion({ status });
        await expectTeachingPackageError(
          approve(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' }),
          'INVALID_TRANSITION',
          409,
        );
      },
    );
  });

  describe('atomic supersession', () => {
    async function seedSupersessionPair() {
      const { versionId: v1 } = await seedVersion({ status: 'approved' });
      const v1Row = (await readVersion(qp(), v1, { tenantId: 'tenant-test' }))!;
      const stageId = unique('stage-lc-v2');
      await seedLiveStage(stageId);
      const v2 = unique('tpv');
      await insertVersion(qp(), {
        id: v2,
        aggregate: { tenantId: 'tenant-test', learningItem: v1Row.learningItem },
        version: 2,
        status: 'draft',
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        predecessorVersionId: v1,
        now: 3,
      });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId: v2, actorRef: 'actor-1' });
      return { v1, v2 };
    }

    it('demotes the predecessor and promotes the successor as one outcome', async () => {
      const { v1, v2 } = await seedSupersessionPair();

      const updated = await approve(tx(), { tenantId: 'tenant-test', versionId: v2, actorRef: 'reviewer-1' });
      expect(updated.status).toBe('approved');
      const demoted = await readVersion(qp(), v1, { tenantId: 'tenant-test' });
      expect(demoted).toMatchObject({
        status: 'superseded',
        supersededByVersionId: v2,
        supersededAt: expect.any(Number),
      });
      expect((await listReviewEvents(qp(), v1)).at(-1)).toMatchObject({
        eventType: 'superseded',
        relatedVersionId: v2,
      });
      expect((await listReviewEvents(qp(), v2)).at(-1)).toMatchObject({
        eventType: 'approved',
        relatedVersionId: v1,
      });
    });

    it('rolls the whole supersession back when the event append fails', async () => {
      const { v1, v2 } = await seedSupersessionPair();
      // Fail exactly the `superseded` event append inside the transaction (the
      // event type travels as a bind parameter, so match text and params).
      const failing = poolFailingOn(
        pool,
        (text, params) =>
          text.includes('INSERT INTO teaching_package_review_events') &&
          (params ?? []).includes('superseded'),
      );

      await expect(approve(failing, { tenantId: 'tenant-test', versionId: v2, actorRef: 'reviewer-1' })).rejects.toThrow(
        'injected statement failure',
      );
      expect((await readVersion(qp(), v1, { tenantId: 'tenant-test' }))!.status).toBe('approved');
      expect((await readVersion(qp(), v2, { tenantId: 'tenant-test' }))!.status).toBe('in_review');
      expect((await listReviewEvents(qp(), v1)).at(-1)?.eventType).not.toBe('superseded');
      expect((await listReviewEvents(qp(), v2)).at(-1)?.eventType).not.toBe('approved');
    });
  });

  describe('discardSuccessor', () => {
    it('discards a never-approved draft successor', async () => {
      const { versionId } = await seedVersion({ status: 'draft', withPredecessor: true });
      const updated = await discardSuccessor(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      expect(updated.status).toBe('discarded');
      expect(updated.discardedAt).not.toBeNull();
      expect((await listReviewEvents(qp(), versionId)).at(-1)).toMatchObject({
        eventType: 'discarded',
      });
    });

    it('discards a rejected successor and keeps its rejection history', async () => {
      const { versionId } = await seedVersion({ status: 'draft', withPredecessor: true });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      await reject(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1', reason: 'not good enough' });

      const updated = await discardSuccessor(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });
      expect(updated.status).toBe('discarded');
      expect((await listReviewEvents(qp(), versionId)).map((e) => e.eventType)).toEqual([
        'submitted_for_review',
        'rejected',
        'discarded',
      ]);
    });

    it('refuses to discard an in_review successor', async () => {
      const { versionId } = await seedVersion({ status: 'draft', withPredecessor: true });
      await submitForReview(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' });

      await expectTeachingPackageError(
        discardSuccessor(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' }),
        'INVALID_TRANSITION',
        409,
      );
      expect((await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status).toBe('in_review');
    });

    it('refuses to discard version 1 (not a successor)', async () => {
      const { versionId } = await seedVersion({ status: 'draft' });
      await expectTeachingPackageError(
        discardSuccessor(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' }),
        'NOT_A_SUCCESSOR',
        409,
      );
    });

    it.each(['approved', 'superseded', 'discarded'] as const)(
      'refuses to discard a %s version',
      async (status) => {
        // A lone row suffices (an approved subject cannot coexist with an
        // approved predecessor), and the status check fires first regardless.
        const { versionId } = await seedVersion({ status });
        await expectTeachingPackageError(
          discardSuccessor(tx(), { tenantId: 'tenant-test', versionId, actorRef: 'actor-1' }),
          'INVALID_TRANSITION',
          409,
        );
      },
    );
  });

  it('answers NOT_FOUND for an unknown version', async () => {
    await expectTeachingPackageError(
      submitForReview(tx(), { tenantId: 'tenant-test', versionId: 'tpv-absent', actorRef: 'actor-1' }),
      'NOT_FOUND',
      404,
    );
  });
});
