import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { submitForReview } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  revisionPreconditionFence,
  type RevisionPreconditionState,
} from '@/lib/server/teaching-package/revision-precondition-fence';
import {
  commitSceneRegeneration,
  startSceneRegeneration,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const contractUrl = process.env.PG_CONTRACT_URL;

/**
 * True-parallel PostgreSQL for the regeneration commit and the revision
 * preconditions (single-slide-regeneration-plan AT-RV 4, §9.4 lock order).
 * PGlite is single-connection, so only a real database races two
 * transactions. Skipped unless PG_CONTRACT_URL names a DISPOSABLE database
 * (the same gate as the lifecycle concurrency suite). It never truncates:
 * every row it writes uses a fresh id.
 */
describe.skipIf(!contractUrl)('slide regeneration on PostgreSQL', () => {
  let pool: Pool;
  const queryable = () => pool as unknown as ConnectableQueryable;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl });
    await ensureDocumentSchema(queryable());
    await ensureStageMetaSchema(queryable());
    await ensureTeachingPackageSchema(queryable());
  });

  afterAll(async () => {
    await pool.end();
  });

  function store(fence?: ReturnType<typeof revisionPreconditionFence>) {
    const guard = teachingPackageStageGuardFence();
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: async (q, operation, phase) => {
        await fence?.(q, operation, phase);
        await guard(q, operation, phase);
      },
    });
  }

  async function seed() {
    const stageId = `stage-pgr-${randomUUID()}`;
    await store().saveDocument(
      makeDocument(stageId, 'pg', [
        makeSlideScene('scene-1', stageId, 1),
        makeSlideScene('scene-2', stageId, 2),
      ]),
    );
    const versionId = `tpv-pgr-${randomUUID()}`;
    await insertVersion(queryable(), {
      id: versionId,
      aggregate: {
        tenantId: 'tenant-pg',
        learningItem: { type: 'lesson', id: `li-${randomUUID()}` },
      },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    return { stageId, versionId };
  }

  async function rev(stageId: string, sceneId: string): Promise<number> {
    const result = await pool.query(
      'SELECT rev FROM document_scene_revision WHERE stage_id = $1 AND scene_id = $2',
      [stageId, sceneId],
    );
    return Number(result.rows[0]?.rev ?? 0);
  }

  it('AT-RV 4: two grant writes on the same base race — exactly one lands, the other conflicts', async () => {
    const { stageId } = await seed();
    const base = await rev(stageId, 'scene-1');
    const write = (title: string) => {
      const state: RevisionPreconditionState = {};
      const fence = revisionPreconditionFence(
        { kind: 'scene', stageId, sceneId: 'scene-1', method: 'PUT' },
        { 'scene-1': base },
        state,
      );
      return store(fence).putScene(stageId, makeSlideScene('scene-1', stageId, 1, title));
    };
    const results = await Promise.allSettled([write('A'), write('B')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ name: 'SceneRevisionConflictError' });
    expect(await rev(stageId, 'scene-1')).toBe(base + 1);
  });

  it('T2 races a grant write on the same base: exactly one wins, the Scene is never mixed', async () => {
    const { stageId, versionId } = await seed();
    const started = await startSceneRegeneration(queryable(), {
      tenantId: 'tenant-pg',
      versionId,
      stageId,
      sceneId: 'scene-1',
      idempotencyKey: `key-${randomUUID()}`,
      requestDigest: 'd',
      instruction: 'instruction for the model',
      reason: 'audit reason',
      actorRef: `teaching-package-editor:${stageId}`,
      sessionRef: null,
    });
    if (started.kind !== 'started') throw new Error(started.kind);
    const row = started.regeneration;
    const state: RevisionPreconditionState = {};
    const grantWrite = store(
      revisionPreconditionFence(
        { kind: 'scene', stageId, sceneId: 'scene-1', method: 'PUT' },
        { 'scene-1': row.baseSceneRev },
        state,
      ),
    ).putScene(stageId, makeSlideScene('scene-1', stageId, 1, 'editor'));
    const commit = commitSceneRegeneration(
      queryable(),
      {
        regenerationId: row.id,
        attemptToken: row.attemptToken,
        tenantId: 'tenant-pg',
        versionId,
        stageId,
        sceneId: 'scene-1',
        baseSceneRev: row.baseSceneRev,
        actorRef: row.actorRef,
        reason: row.reason,
      },
      makeSlideScene('scene-1', stageId, 1, 'regenerated'),
    );
    const results = await Promise.allSettled([grantWrite, commit]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await rev(stageId, 'scene-1')).toBe(row.baseSceneRev + 1);
    const title = await pool.query(
      `SELECT data->>'title' AS title FROM document_scenes WHERE stage_id = $1 AND id = 'scene-1'`,
      [stageId],
    );
    const winner = results[0]!.status === 'fulfilled' ? 'editor' : 'regenerated';
    expect(title.rows[0]?.title).toBe(winner);
  });

  it('§9.4 lock order: T2 racing submit-for-review settles without a deadlock', async () => {
    const { stageId, versionId } = await seed();
    const started = await startSceneRegeneration(queryable(), {
      tenantId: 'tenant-pg',
      versionId,
      stageId,
      sceneId: 'scene-2',
      idempotencyKey: `key-${randomUUID()}`,
      requestDigest: 'd',
      instruction: 'instruction for the model',
      reason: 'audit reason',
      actorRef: `teaching-package-editor:${stageId}`,
      sessionRef: null,
    });
    if (started.kind !== 'started') throw new Error(started.kind);
    const row = started.regeneration;
    const results = await Promise.allSettled([
      commitSceneRegeneration(
        queryable(),
        {
          regenerationId: row.id,
          attemptToken: row.attemptToken,
          tenantId: 'tenant-pg',
          versionId,
          stageId,
          sceneId: 'scene-2',
          baseSceneRev: row.baseSceneRev,
          actorRef: row.actorRef,
          reason: row.reason,
        },
        makeSlideScene('scene-2', stageId, 2, 'regenerated'),
      ),
      submitForReview(queryable(), { tenantId: 'tenant-pg', versionId, actorRef: 'kafuo' }),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).not.toBe('40P01');
      }
    }
    // Either order is valid; neither may deadlock.
  });
});
