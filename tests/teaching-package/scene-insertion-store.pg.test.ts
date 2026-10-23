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

  const insertionStart = (stageId: string, versionId: string) =>
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

  it('insertion and regeneration started together: exactly one runs, in both orders', async () => {
    for (const order of ['insertion-first', 'regeneration-first'] as const) {
      const { stageId, versionId } = await seed();
      const [a, b] =
        order === 'insertion-first'
          ? await Promise.all([
              insertionStart(stageId, versionId),
              regenerationStart(stageId, versionId),
            ])
          : await Promise.all([
              regenerationStart(stageId, versionId),
              insertionStart(stageId, versionId),
            ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['refused', 'started']);
      const refused = [a, b].find((outcome) => outcome.kind === 'refused') as {
        refusal: { code: string };
      };
      expect(refused.refusal.code).toBe('STAGE_GENERATION_IN_PROGRESS');
    }
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
