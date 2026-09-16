/**
 * Teaching Package lifecycle on a REAL PostgreSQL pool.
 *
 * Why this suite exists separately from `lifecycle.test.ts`: that suite runs on
 * PGlite, whose "pool" hands every caller the same single connection. The
 * lifecycle's pre-submit exact-flow gate loads the Stage document through the
 * owner-bound document store, and that store opens its OWN transaction on its
 * OWN pool connection (`createOwnerBoundDocumentStore.withTransaction`), where a
 * read takes `SELECT ... FROM stage_meta WHERE stage_id = $1 FOR SHARE`. The
 * submit transaction has already taken `FOR UPDATE` on that same `stage_meta`
 * row (`lockStageMetaLive`). On one connection those are the same transaction
 * and never conflict; on a real pool they are two sessions and `FOR SHARE`
 * blocks behind `FOR UPDATE` — while the holder sits `idle in transaction`
 * awaiting the blocked promise, so PostgreSQL's deadlock detector never fires
 * and the request hangs until the client gives up.
 *
 * Every test here therefore carries an explicit timeout: a regression of that
 * deadlock shows up as a deterministic test failure, not a hung run.
 *
 * Gate: `PG_CONTRACT_URL` (the same gate as `lifecycle-concurrency.pg.test.ts`).
 * `DATABASE_URL` must name the SAME database, because the document store
 * resolves its pool from `DATABASE_URL` rather than from the pool passed to the
 * lifecycle command — pointing them at different databases would make
 * `loadDocument` answer `null` and skip the very branch under test.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readVersion,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import {
  approve,
  createSuccessor,
  discardSuccessor,
  reject,
  startReviewEdit,
  submitForReview,
} from '@/lib/server/teaching-package/lifecycle';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { LearningItemRef } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const contractUrl = process.env.PG_CONTRACT_URL;

/**
 * A transition must answer well inside this budget. The reported deadlock hung
 * for ~75 s (the HTTP client's own timeout), so anything above a few seconds is
 * the bug, not slowness.
 */
const TRANSITION_TIMEOUT_MS = 15_000;

const TENANT = 'tenant-pglc';
const FLOW = [
  { stage: 'lesson_introduction', instructions: 'introduce the lesson once' },
  { stage: 'outcome_teaching_cards', instructions: 'teach objective O1' },
];

describe.skipIf(!contractUrl)('teaching package lifecycle on PostgreSQL', () => {
  let pool: Pool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}-${process.pid}`;
  const qp = () => pool as unknown as ConnectableQueryable;

  beforeAll(async () => {
    // The document store reads DATABASE_URL; keep both on one database (see the
    // module header) so the exact-flow gate really loads this suite's stages.
    process.env.DATABASE_URL = contractUrl;
    pool = new Pool({ connectionString: contractUrl, max: 10 });
    const queryable = qp();
    await ensureDocumentSchema(queryable);
    await ensureStageMetaSchema(queryable);
    await ensureTeachingPackageSchema(queryable);
  }, 60_000);

  beforeEach(async () => {
    // CASCADE: `teaching_package_source_contexts` references attempts, and
    // versions reference themselves (predecessor/superseded_by).
    await pool.query(
      `TRUNCATE teaching_package_webhook_deliveries, teaching_package_review_events,
                teaching_package_source_contexts, teaching_package_generation_attempts,
                teaching_package_versions CASCADE`,
    );
    await pool.query(`DELETE FROM stage_meta WHERE stage_id LIKE 'stage-pglc-%'`);
    await pool.query(`DELETE FROM document_stages WHERE id LIKE 'stage-pglc-%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  function documentStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  /** Scenes that cover FLOW exactly: [0, 0, 1] collapses to [0, 1]. */
  function flowCoveringScenes(stageId: string): AppScene[] {
    return [
      {
        ...makeSlideScene('s1', stageId, 1),
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      },
      {
        ...makeSlideScene('s2', stageId, 2),
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      },
      {
        ...makeSlideScene('s3', stageId, 3),
        teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
      },
    ] as AppScene[];
  }

  /** Scenes that violate FLOW: position 1 is never covered. */
  function flowViolatingScenes(stageId: string): AppScene[] {
    return [
      {
        ...makeSlideScene('s1', stageId, 1),
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      },
      { ...makeSlideScene('s2', stageId, 2) },
    ] as AppScene[];
  }

  /**
   * One flow-backed version: a live Stage carrying the given scenes, plus a
   * succeeded generation attempt whose `input_snapshot.teachingFlow` is the
   * authoritative flow, linked as the version's producing attempt. Without the
   * attempt, `readFlowForVersion` answers null and submit skips the gate —
   * which is precisely why the existing PG concurrency suite never deadlocked.
   */
  async function seedFlowBackedVersion(options?: {
    scenes?: (stageId: string) => AppScene[];
    status?: 'draft' | 'rejected';
    itemId?: string;
  }): Promise<{ versionId: string; stageId: string; learningItem: LearningItemRef }> {
    const stageId = unique('stage-pglc');
    const itemId = options?.itemId ?? unique('li-pglc');
    const buildScenes = options?.scenes ?? flowCoveringScenes;
    const store = documentStore();
    await store.saveDocument(makeDocument(stageId, 'Flow', buildScenes(stageId)));

    const versionId = unique('tpv-pglc');
    const learningItem: LearningItemRef = { type: 'lesson', id: itemId };
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: TENANT, learningItem },
      version: 1,
      status: options?.status ?? 'draft',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    const attemptId = unique('tpa-pglc');
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: TENANT, learningItem },
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
        teachingFlow: FLOW,
      },
      now: 1,
    });
    await pool.query(`UPDATE teaching_package_versions SET current_attempt_id = $2 WHERE id = $1`, [
      versionId,
      attemptId,
    ]);
    return { versionId, stageId, learningItem };
  }

  /** Sessions this suite's pool left parked mid-transaction. */
  async function idleInTransactionCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // ── 1. Submit returns successfully on PostgreSQL (the deadlock regression) ──
  it(
    'submit returns on a real pool when the exact-flow gate loads the stage document',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      const updated = await submitForReview(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(updated.status).toBe('in_review');
      expect(updated.submittedStageRev).not.toBeNull();
    },
    TRANSITION_TIMEOUT_MS,
  );

  // ── 2..6. The whole review loop, each on a real pool ──
  it(
    'start edit returns successfully',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      const updated = await startReviewEdit(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(updated.status).toBe('draft');
      expect(updated.submittedStageRev).toBeNull();
    },
    TRANSITION_TIMEOUT_MS,
  );

  it(
    'reject returns successfully and requires a reason',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await expect(
        reject(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1', reason: '  ' }),
      ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      const updated = await reject(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
        reason: 'the worked examples do not follow the source',
      });
      expect(updated.status).toBe('rejected');
    },
    TRANSITION_TIMEOUT_MS,
  );

  it(
    'resubmit from rejected returns successfully',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await reject(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
        reason: 'needs another pass',
      });
      const updated = await submitForReview(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(updated.status).toBe('in_review');
    },
    TRANSITION_TIMEOUT_MS,
  );

  it(
    'approve returns successfully',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      const updated = await approve(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(updated.status).toBe('approved');
    },
    TRANSITION_TIMEOUT_MS,
  );

  // ── 7. Create successor still works, then 6. discard it ──
  it(
    'create successor then discard it both return successfully',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await approve(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });

      const successor = await createSuccessor(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
      });
      expect(successor.status).toBe('draft');
      expect(successor.version).toBe(2);
      expect(successor.predecessorVersionId).toBe(versionId);
      // The approved predecessor stays current while the successor is a draft.
      expect((await readVersion(qp(), versionId, { tenantId: TENANT }))!.status).toBe('approved');

      const discarded = await discardSuccessor(qp(), {
        tenantId: TENANT,
        versionId: successor.id,
        actorRef: 'reviewer-1',
      });
      expect(discarded.status).toBe('discarded');
      expect((await readVersion(qp(), versionId, { tenantId: TENANT }))!.status).toBe('approved');
    },
    TRANSITION_TIMEOUT_MS * 2,
  );

  // ── 8. An exact-flow failure is a 409, not a hang ──
  it(
    'submit with a flow-violating scene sequence answers 409 instead of hanging',
    async () => {
      const { versionId } = await seedFlowBackedVersion({ scenes: flowViolatingScenes });
      const promise = submitForReview(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
      });
      await expect(promise).rejects.toBeInstanceOf(TeachingPackageError);
      await expect(promise).rejects.toMatchObject({
        code: 'TEACHING_MODEL_FLOW_MISMATCH',
        status: 409,
      });
      // The version is untouched: a refused submit is not a transition.
      expect((await readVersion(qp(), versionId, { tenantId: TENANT }))!.status).toBe('draft');
    },
    TRANSITION_TIMEOUT_MS,
  );

  // ── 9. Two concurrent transitions on one package serialize ──
  it(
    'two concurrent submits of one version serialize into exactly one transition',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      const results = await Promise.allSettled([
        submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-a' }),
        submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-b' }),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser sees the winner's committed state, never a second transition.
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TeachingPackageError);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'INVALID_TRANSITION',
        status: 409,
      });
      const events = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM teaching_package_review_events
          WHERE version_id = $1 AND to_status = 'in_review'`,
        [versionId],
      );
      expect(Number(events.rows[0]!.count)).toBe(1);
    },
    TRANSITION_TIMEOUT_MS * 2,
  );

  // ── 10. Different aggregates do not block each other ──
  it(
    'submits on two different learning items do not block each other',
    async () => {
      const first = await seedFlowBackedVersion();
      const second = await seedFlowBackedVersion();
      const [a, b] = await Promise.all([
        submitForReview(qp(), {
          tenantId: TENANT,
          versionId: first.versionId,
          actorRef: 'reviewer-a',
        }),
        submitForReview(qp(), {
          tenantId: TENANT,
          versionId: second.versionId,
          actorRef: 'reviewer-b',
        }),
      ]);
      expect(a.status).toBe('in_review');
      expect(b.status).toBe('in_review');
    },
    TRANSITION_TIMEOUT_MS,
  );

  // ── 11. No connection is left parked mid-transaction ──
  it(
    'leaves no connection idle in transaction after a full review loop',
    async () => {
      const { versionId } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await startReviewEdit(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await approve(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      expect(await idleInTransactionCount()).toBe(0);
    },
    TRANSITION_TIMEOUT_MS * 2,
  );

  // ── 12. Webhook rows commit with the transitions ──
  it(
    'commits one webhook delivery row per successful transition, in sequence order',
    async () => {
      const { versionId, learningItem } = await seedFlowBackedVersion();
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await reject(qp(), {
        tenantId: TENANT,
        versionId,
        actorRef: 'reviewer-1',
        reason: 'one more pass',
      });
      await submitForReview(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      await approve(qp(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });

      const rows = await pool.query<{ sequence: string; event_type: string; status: string }>(
        `SELECT sequence, event_type, status
           FROM teaching_package_webhook_deliveries
          WHERE tenant_id = $1 AND learning_item_type = $2 AND learning_item_id = $3
          ORDER BY sequence`,
        [TENANT, learningItem.type, learningItem.id],
      );
      // submit, reject, resubmit, approve — four status transitions, no gaps.
      expect(rows.rows).toHaveLength(4);
      expect(rows.rows.map((row) => row.event_type)).toEqual([
        'teaching_package.status_changed',
        'teaching_package.status_changed',
        'teaching_package.status_changed',
        'teaching_package.status_changed',
      ]);
      expect(rows.rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4]);
      expect(new Set(rows.rows.map((row) => row.status))).toEqual(new Set(['pending']));
    },
    TRANSITION_TIMEOUT_MS * 2,
  );
});
