import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppDocument, AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  commitSceneInsertion,
  readSceneInsertionStatus,
  startSceneInsertion,
  type StartSceneInsertionInput,
} from '@/lib/server/teaching-package/scene-insertion-store';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * Reviewer-generated slide plan §11–§12 over PGlite: the T2 fence rebuilds
 * when the stage revision moves between the sandwich and the write (with the
 * same candidate, no model call), gives up after three builds, and the boot
 * evolutions widen an OLD schema in place (E-1, E-2) and are re-runnable.
 * True two-connection races live in `scene-insertion-store.pg.test.ts`.
 */

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

const STAGE = 'stage-isx';
const TENANT = 'tenant-isx';

describe('scene insertion store', () => {
  let pool: PGlitePool;
  const tx = () => pool as unknown as ConnectableQueryable;

  function store() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    await store().saveDocument(
      makeDocument(STAGE, 'store', [
        makeSlideScene('s1', STAGE, 1),
        makeSlideScene('s2', STAGE, 2),
      ]),
    );
    await insertVersion(pool as never, {
      id: 'tpv-isx',
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: 'li-isx' } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
  });

  const start = (overrides: Partial<StartSceneInsertionInput> = {}) =>
    startSceneInsertion(tx(), {
      tenantId: TENANT,
      versionId: 'tpv-isx',
      stageId: STAGE,
      newSceneId: 'scene-new',
      newOutlineId: 'ins_new',
      unitIds: ['cu_1'],
      afterSceneId: 's1',
      beforeSceneId: 's2',
      teachingStage: { key: 'explain', flowIndex: 1 },
      idempotencyKey: 'key-isx-1',
      requestDigest: 'digest',
      instruction: '',
      reason: 'a reason',
      actorRef: 'actor',
      sessionRef: null,
      recheck: () => null,
      ...overrides,
    });

  /** The insertion's build: shift s2, add the new Scene after s1. */
  function insertAfterS1(doc: AppDocument): AppDocument {
    return {
      ...doc,
      scenes: [
        ...doc.scenes.map((scene) =>
          scene.order >= 2 ? { ...scene, order: scene.order + 1 } : scene,
        ),
        { ...makeSlideScene('scene-new', STAGE, 2), outlineId: 'ins_new' } as AppScene,
      ],
    };
  }

  it('a write between the sandwich and the fence rebuilds from the new state — the edit survives', async () => {
    const started = await start();
    if (started.kind !== 'started') throw new Error('not started');
    let builds = 0;
    const result = await commitSceneInsertion(
      tx(),
      {
        insertionId: started.insertion.id,
        attemptToken: started.insertion.attemptToken,
        tenantId: TENANT,
        versionId: 'tpv-isx',
        stageId: STAGE,
        newSceneId: 'scene-new',
        actorRef: 'actor',
        reason: 'a reason',
      },
      async (doc) => {
        builds += 1;
        if (builds === 1) {
          // Another tab commits AFTER the sandwich read: the fence must see it.
          const s1 = doc.scenes.find((scene) => scene.id === 's1')!;
          await store().putScene(STAGE, { ...s1, title: 'edited elsewhere' });
        }
        return insertAfterS1(doc);
      },
    );
    expect(builds).toBe(2);
    expect(result.builds).toBe(2);
    const document = await store().loadDocument(STAGE);
    expect(document!.scenes.map((scene) => [scene.id, scene.order, scene.title])).toEqual([
      ['s1', 1, 'edited elsewhere'],
      ['scene-new', 2, 'Scene 2'],
      ['s2', 3, 'Scene 2'],
    ]);
    expect(result.sceneRevTransitions.s1!.after).toBeGreaterThan(
      result.sceneRevTransitions.s1!.before,
    );
    const row = await readSceneInsertionStatus(tx(), started.insertion.id);
    expect(row).toMatchObject({ status: 'succeeded', resultSceneRev: result.resultSceneRev });
  });

  it('gives up after three builds without a stable revision (INSERTION_STAGE_BUSY), writing nothing', async () => {
    const started = await start();
    if (started.kind !== 'started') throw new Error('not started');
    let builds = 0;
    await expect(
      commitSceneInsertion(
        tx(),
        {
          insertionId: started.insertion.id,
          attemptToken: started.insertion.attemptToken,
          tenantId: TENANT,
          versionId: 'tpv-isx',
          stageId: STAGE,
          newSceneId: 'scene-new',
          actorRef: 'actor',
          reason: 'a reason',
        },
        async (doc) => {
          builds += 1;
          const s1 = doc.scenes.find((scene) => scene.id === 's1')!;
          await store().putScene(STAGE, { ...s1, title: `edit ${builds}` });
          return insertAfterS1(doc);
        },
      ),
    ).rejects.toMatchObject({ code: 'INSERTION_STAGE_BUSY' });
    expect(builds).toBe(3);
    const document = await store().loadDocument(STAGE);
    expect(document!.scenes.map((scene) => scene.id)).toEqual(['s1', 's2']);
  });

  it('a lost lease refuses the commit (INSERTION_LEASE_LOST)', async () => {
    const started = await start();
    if (started.kind !== 'started') throw new Error('not started');
    await expect(
      commitSceneInsertion(
        tx(),
        {
          insertionId: started.insertion.id,
          attemptToken: 'wrong-token',
          tenantId: TENANT,
          versionId: 'tpv-isx',
          stageId: STAGE,
          newSceneId: 'scene-new',
          actorRef: 'actor',
          reason: 'a reason',
        },
        insertAfterS1,
      ),
    ).rejects.toMatchObject({ code: 'INSERTION_LEASE_LOST' });
  });

  it('the status read lazily reclaims an expired lease', async () => {
    const started = await start({ now: 1_000, leaseSeconds: 60 });
    if (started.kind !== 'started') throw new Error('not started');
    const row = await readSceneInsertionStatus(tx(), started.insertion.id, 1_000 + 61_000);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED' });
  });

  it('E-1/E-2 widen an OLD schema in place, and a re-boot is a no-op', async () => {
    await pool.query('DROP TABLE teaching_package_scene_insertions');
    await pool.query(
      'ALTER TABLE teaching_package_review_events DROP CONSTRAINT teaching_package_review_events_event_type_check',
    );
    await pool.query(
      `ALTER TABLE teaching_package_review_events ADD CONSTRAINT teaching_package_review_events_event_type_check
         CHECK (event_type IN ('created','submitted_for_review','review_edit_started','rejected','resubmitted',
           'approved','superseded','discarded','successor_created','stage_replaced',
           'scene_regeneration_started','scene_regeneration_completed','scene_regeneration_failed',
           'scene_regeneration_refused','scene_regeneration_restored'))`,
    );
    await ensureTeachingPackageSchema(pool as never);
    const def = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'teaching_package_review_events_event_type_check'`,
    );
    expect(def.rows[0]!.def).toContain('scene_insertion_refused');
    expect(def.rows[0]!.def).toContain('scene_regeneration_restored');
    await ensureTeachingPackageSchema(pool as never);
    const again = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'teaching_package_review_events_event_type_check'`,
    );
    expect(again.rows[0]!.def).toBe(def.rows[0]!.def);
    // The table and its two unique indexes exist again.
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'teaching_package_scene_insertions' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['tpsi_single_running', 'tpsi_version_key_unique']),
    );
    expect((await start()).kind).toBe('started');
    // A second running insertion on the Stage is refused under the mutex.
    const second = await start({ idempotencyKey: 'key-isx-2' });
    expect(second).toMatchObject({
      kind: 'refused',
      refusal: { code: 'SCENE_INSERTION_IN_PROGRESS' },
    });
  });
});
