import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppDocument, AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  commitSceneInsertion,
  readSceneInsertionByKeyUnderStageLock,
  startSceneInsertion,
} from '@/lib/server/teaching-package/scene-insertion-store';
import { startSceneRegeneration } from '@/lib/server/teaching-package/scene-regeneration-store';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const contractUrl = process.env.PG_CONTRACT_URL;

/**
 * True-parallel PostgreSQL for the reviewer-generated slide insertion
 * (plan §11.3–§11.4, §18 `scene-insertion-store.pg`): the shared Stage mutex
 * between insertion T1 and regeneration T1 in both orders, and a commit
 * racing the T2 write. PGlite is single-connection, so only a real database
 * races two transactions. Skipped unless PG_CONTRACT_URL names a DISPOSABLE
 * database (the same gate as the regeneration and lifecycle suites); it never
 * truncates — every row uses a fresh id.
 */
describe.skipIf(!contractUrl)('slide insertion on PostgreSQL', () => {
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

  function store() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  async function seed() {
    const stageId = `stage-pgi-${randomUUID()}`;
    await store().saveDocument(
      makeDocument(stageId, 'pg', [
        makeSlideScene('scene-1', stageId, 1),
        makeSlideScene('scene-2', stageId, 2),
      ]),
    );
    const versionId = `tpv-pgi-${randomUUID()}`;
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

  const insertionStart = (
    stageId: string,
    versionId: string,
    overrides: Partial<Parameters<typeof startSceneInsertion>[1]> = {},
  ) =>
    startSceneInsertion(queryable(), {
      tenantId: 'tenant-pg',
      versionId,
      stageId,
      newSceneId: `new-${randomUUID()}`,
      newOutlineId: `ins_${randomUUID()}`,
      unitIds: ['cu_1'],
      afterSceneId: 'scene-1',
      beforeSceneId: 'scene-2',
      teachingStage: { key: 'explain', flowIndex: 1 },
      idempotencyKey: `k-${randomUUID()}`,
      requestDigest: 'd',
      instruction: '',
      reason: 'reason',
      actorRef: 'actor',
      sessionRef: null,
      recheck: () => null,
      ...overrides,
    });

  const regenerationStart = (stageId: string, versionId: string) =>
    startSceneRegeneration(queryable(), {
      tenantId: 'tenant-pg',
      versionId,
      stageId,
      sceneId: 'scene-2',
      idempotencyKey: `k-${randomUUID()}`,
      requestDigest: 'd',
      instruction: 'make it simpler please',
      reason: 'reason',
      actorRef: 'actor',
      sessionRef: null,
    });

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Hold the Stage mutex in a separate transaction so the two T1s queue
   * behind it in a KNOWN order (first started waits first), then release.
   */
  async function inOrder<A, B>(stageId: string, first: () => Promise<A>, second: () => Promise<B>) {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [stageId]);
    const a = first();
    await pause(250);
    const b = second();
    await pause(250);
    await holder.query('COMMIT');
    holder.release();
    return Promise.all([a, b]);
  }

  it('insertion and regeneration started together: exactly the FIRST runs, in both orders', async () => {
    {
      const { stageId, versionId } = await seed();
      const [insertion, regeneration] = await inOrder(
        stageId,
        () => insertionStart(stageId, versionId),
        () => regenerationStart(stageId, versionId),
      );
      expect(insertion.kind).toBe('started');
      expect(regeneration).toMatchObject({
        kind: 'refused',
        refusal: { code: 'STAGE_GENERATION_IN_PROGRESS' },
      });
    }
    {
      const { stageId, versionId } = await seed();
      const [regeneration, insertion] = await inOrder(
        stageId,
        () => regenerationStart(stageId, versionId),
        () => insertionStart(stageId, versionId),
      );
      expect(regeneration.kind).toBe('started');
      expect(insertion).toMatchObject({
        kind: 'refused',
        refusal: { code: 'STAGE_GENERATION_IN_PROGRESS' },
      });
    }
  });

  it('two insertion starts on one Stage: one runs, the other is SCENE_INSERTION_IN_PROGRESS', async () => {
    const { stageId, versionId } = await seed();
    const [a, b] = await Promise.all([
      insertionStart(stageId, versionId),
      insertionStart(stageId, versionId),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['refused', 'started']);
    const refused = [a, b].find((outcome) => outcome.kind === 'refused') as {
      refusal: { code: string };
    };
    expect(refused.refusal.code).toBe('SCENE_INSERTION_IN_PROGRESS');
  });

  it('the same key sent twice at once: one starts, the other answers the replay', async () => {
    const { stageId, versionId } = await seed();
    const key = `k-${randomUUID()}`;
    const start = () =>
      startSceneInsertion(queryable(), {
        tenantId: 'tenant-pg',
        versionId,
        stageId,
        newSceneId: `new-${randomUUID()}`,
        newOutlineId: `ins_${randomUUID()}`,
        unitIds: ['cu_1'],
        afterSceneId: 'scene-1',
        beforeSceneId: 'scene-2',
        teachingStage: { key: 'explain', flowIndex: 1 },
        idempotencyKey: key,
        requestDigest: 'same',
        instruction: '',
        reason: 'reason',
        actorRef: 'actor',
        sessionRef: null,
        recheck: () => null,
      });
    const [a, b] = await Promise.all([start(), start()]);
    expect([a.kind, b.kind].sort()).toEqual(['replay', 'started']);
  });

  it('a T1 that waits for the Stage lock past its admission deadline is refused (a real lock wait)', async () => {
    const { stageId, versionId } = await seed();
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [stageId]);
    const late = insertionStart(stageId, versionId, { admitBy: Date.now() + 200 });
    await pause(600);
    await holder.query('COMMIT');
    holder.release();
    expect(await late).toMatchObject({
      kind: 'refused',
      refusal: { code: 'INSERTION_ADMISSION_CLOSED' },
    });
  });

  it('the by-key read queued behind a T1 sees its row; once past the deadline, no T1 can start', async () => {
    const { stageId, versionId } = await seed();
    const key = `k-${randomUUID()}`;
    const [started, read] = await inOrder(
      stageId,
      () =>
        insertionStart(stageId, versionId, { idempotencyKey: key, admitBy: Date.now() + 60_000 }),
      () =>
        readSceneInsertionByKeyUnderStageLock(queryable(), {
          stageId,
          versionId,
          idempotencyKey: key,
        }),
    );
    expect(started.kind).toBe('started');
    expect(read.row?.idempotencyKey).toBe(key);

    const other = `k-${randomUUID()}`;
    const admitBy = Date.now() + 100;
    await pause(300);
    const absent = await readSceneInsertionByKeyUnderStageLock(queryable(), {
      stageId,
      versionId,
      idempotencyKey: other,
    });
    expect(absent.row).toBeNull();
    expect(absent.serverNow).toBeGreaterThan(admitBy);
    expect(
      await insertionStart(stageId, versionId, { idempotencyKey: other, admitBy }),
    ).toMatchObject({ kind: 'refused', refusal: { code: 'INSERTION_ADMISSION_CLOSED' } });
  });

  it('a commit racing the T2 write: the fence sees the moved revision and the rebuild keeps it', async () => {
    const { stageId, versionId } = await seed();
    const started = await insertionStart(stageId, versionId);
    if (started.kind !== 'started') throw new Error('not started');
    let builds = 0;
    const result = await commitSceneInsertion(
      queryable(),
      {
        insertionId: started.insertion.id,
        attemptToken: started.insertion.attemptToken,
        tenantId: 'tenant-pg',
        versionId,
        stageId,
        newSceneId: started.insertion.newSceneId,
        actorRef: 'actor',
        reason: 'reason',
      },
      async (doc: AppDocument) => {
        builds += 1;
        if (builds === 1) {
          const first = doc.scenes.find((scene) => scene.id === 'scene-1')!;
          await store().putScene(stageId, { ...first, title: 'concurrent edit' });
        }
        return {
          ...doc,
          scenes: [
            ...doc.scenes.map((scene) =>
              scene.order >= 2 ? { ...scene, order: scene.order + 1 } : scene,
            ),
            { ...makeSlideScene(started.insertion.newSceneId, stageId, 2) } as AppScene,
          ],
        };
      },
    );
    expect(result.builds).toBe(2);
    const document = await store().loadDocument(stageId);
    expect(document!.scenes.find((scene) => scene.id === 'scene-1')!.title).toBe('concurrent edit');
    expect(document!.scenes).toHaveLength(3);
  });
});
