/**
 * Agent API wave B («fix them all»): every other successful write to an editable
 * package stage's scenes sends `teaching_package.scene_changed` from the stage
 * guard — one per scene whose content changed (`edited` / `inserted` /
 * `deleted`), in the write's own transaction. Plain stages and failed writes
 * send nothing. PGlite.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { setSceneLearningObjectives } from '@/lib/server/teaching-package/scene-objectives';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<Row>(text, params);
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

const STAGE = 'stage-sed';
const PLAIN = 'stage-plain';
const TENANT = 'tenant-sed';
const VERSION = 'tpv-sed';

describe('scene edit webhook events (stage guard)', () => {
  let pool: PGlitePool;

  function store(
    fence: ReturnType<typeof teachingPackageStageGuardFence> = teachingPackageStageGuardFence(),
  ) {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: fence,
    });
  }

  async function events(): Promise<Array<Record<string, unknown>>> {
    const result = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM teaching_package_webhook_deliveries ORDER BY sequence`,
    );
    return result.rows.map((row) => ({ type: row.event_type, ...row.payload }));
  }

  const ten = (stageId: string) =>
    Array.from({ length: 10 }, (_, index) => makeSlideScene(`s${index + 1}`, stageId, index + 1));

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://sed-${randomUUID()}`);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    // Seeded before any version owns the stages: the seed itself sends nothing.
    await store().saveDocument(makeDocument(STAGE, 'pkg', ten(STAGE)));
    await store().saveDocument(makeDocument(PLAIN, 'plain', ten(PLAIN)));
    await insertVersion(pool as never, {
      id: VERSION,
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: 'li-sed' } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  const edited = (sceneId: string, actorRef = `teaching-package-editor:${STAGE}`) => ({
    type: 'teaching_package.scene_changed',
    versionId: VERSION,
    stageId: STAGE,
    sceneId,
    change: 'edited',
    actorRef,
  });

  it('a whole-document save that changes 2 of 10 scenes sends 2 events', async () => {
    const document = (await store().loadDocument(STAGE))!;
    await store().saveDocument({
      ...document,
      scenes: document.scenes.map((scene) =>
        scene.id === 's3' || scene.id === 's7' ? { ...scene, title: `${scene.title}!` } : scene,
      ),
    });
    expect(await events()).toEqual([edited('s3'), edited('s7')]);
  });

  it('a single scene PUT sends one "edited"; a new scene "inserted"; a delete "deleted"', async () => {
    const document = (await store().loadDocument(STAGE))!;
    await store().putScene(STAGE, { ...document.scenes[0]!, title: 'changed' });
    await store().putScene(STAGE, makeSlideScene('s11', STAGE, 11));
    await store().deleteScene(STAGE, 's2');
    expect((await events()).map((event) => [event.sceneId, event.change])).toEqual([
      ['s1', 'edited'],
      ['s11', 'inserted'],
      ['s2', 'deleted'],
    ]);
  });

  it('names the actor the caller gives', async () => {
    const document = (await store().loadDocument(STAGE))!;
    await store(
      teachingPackageStageGuardFence(undefined, { sceneEvents: { actorRef: 'agent-session:9' } }),
    ).putScene(STAGE, { ...document.scenes[0]!, title: 'by the agent' });
    expect(await events()).toEqual([edited('s1', 'agent-session:9')]);
  });

  it('a stage no package version owns sends nothing', async () => {
    const document = (await store().loadDocument(PLAIN))!;
    await store().saveDocument({
      ...document,
      scenes: document.scenes.map((scene) => ({ ...scene, title: 'x' })),
    });
    await store().deleteScene(PLAIN, 's1');
    expect(await events()).toEqual([]);
  });

  it('a write that fails before or after the body sends nothing', async () => {
    const document = (await store().loadDocument(STAGE))!;
    // Refused after the body: the caller's fence throws in the 'after' phase.
    let calls = 0;
    const failing = teachingPackageStageGuardFence(async () => {
      calls += 1;
      if (calls === 2) throw new Error('lease lost');
    });
    await expect(
      store(failing).putScene(STAGE, { ...document.scenes[0]!, title: 'never' }),
    ).rejects.toThrow('lease lost');
    // Refused before: the version is in review.
    await pool.query(`UPDATE teaching_package_versions SET status = 'in_review' WHERE id = $1`, [
      VERSION,
    ]);
    await expect(
      store().putScene(STAGE, { ...document.scenes[0]!, title: 'never' }),
    ).rejects.toMatchObject({ name: 'TeachingPackageStageLockedError' });
    expect(await events()).toEqual([]);
  });

  it('a caller that sends its own event opts out', async () => {
    const document = (await store().loadDocument(STAGE))!;
    await store(teachingPackageStageGuardFence(undefined, { sceneEvents: false })).putScene(STAGE, {
      ...document.scenes[0]!,
      title: 'regenerated elsewhere',
    });
    expect(await events()).toEqual([]);
  });

  it('a pure reorder (dragging one slide) sends nothing', async () => {
    const document = (await store().loadDocument(STAGE))!;
    // s1 moves to the end: every slide's position changes, no content does.
    const reordered = document.scenes.map((scene) =>
      scene.id === 's1' ? { ...scene, order: 11 } : { ...scene, order: scene.order - 1 },
    );
    await store().saveDocument({ ...document, scenes: reordered });
    expect(await events()).toEqual([]);
  });

  it('inserting a slide in the middle sends 1 "inserted" and 0 "edited"', async () => {
    const document = (await store().loadDocument(STAGE))!;
    const shifted = document.scenes.map((scene) =>
      scene.order >= 5 ? { ...scene, order: scene.order + 1 } : scene,
    );
    await store().saveDocument({
      ...document,
      scenes: [...shifted, makeSlideScene('s-mid', STAGE, 5)],
    });
    expect((await events()).map((event) => [event.sceneId, event.change])).toEqual([
      ['s-mid', 'inserted'],
    ]);
  });

  it('a single-scene write compares only the written scene', async () => {
    const document = (await store().loadDocument(STAGE))!;
    // Another scene's row changes inside the same transaction, out of band: a
    // whole-stage comparison would report it, the single-scene path does not.
    // Fence calls: the lookup read's before (1) and after (2), then the write's
    // before (3) — after the guard's snapshot, inside the write's transaction.
    let calls = 0;
    const sideWrite = teachingPackageStageGuardFence(async (queryable) => {
      calls += 1;
      if (calls === 3) {
        await queryable.query(
          `UPDATE document_scenes SET data = jsonb_set(data, '{title}', '"side"')
            WHERE stage_id = $1 AND id = 's9'`,
          [STAGE],
        );
      }
    });
    await store(sideWrite).putScene(STAGE, { ...document.scenes[0]!, title: 'only s1' });
    expect((await events()).map((event) => event.sceneId)).toEqual(['s1']);
  });

  it('coalesces a second identical event while the first is still undelivered', async () => {
    const document = (await store().loadDocument(STAGE))!;
    await store().putScene(STAGE, { ...document.scenes[0]!, title: 'one' });
    await store().putScene(STAGE, { ...document.scenes[0]!, title: 'two' });
    expect(await events()).toHaveLength(1);
    await pool.query(`UPDATE teaching_package_webhook_deliveries SET status = 'delivered'`);
    await store().putScene(STAGE, { ...document.scenes[0]!, title: 'three' });
    expect(await events()).toHaveLength(2);
  });

  it('never fails the write: a broken outbox rolls back only the events', async () => {
    const document = (await store().loadDocument(STAGE))!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await pool.query(
      'ALTER TABLE teaching_package_webhook_deliveries RENAME TO tpwd_moved_for_test',
    );
    await store().putScene(STAGE, { ...document.scenes[0]!, title: 'still saved' });
    await pool.query(
      'ALTER TABLE tpwd_moved_for_test RENAME TO teaching_package_webhook_deliveries',
    );
    expect((await store().loadDocument(STAGE))!.scenes[0]!.title).toBe('still saved');
    expect(await events()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).not.toContain('still saved');
    warn.mockRestore();
  });

  it('an unsafe actor ref is sent as "unknown"', async () => {
    const document = (await store().loadDocument(STAGE))!;
    await store(
      teachingPackageStageGuardFence(undefined, {
        sceneEvents: { actorRef: 'free text with requirement and spaces' },
      }),
    ).putScene(STAGE, { ...document.scenes[0]!, title: 'x' });
    expect(await events()).toEqual([edited('s1', 'unknown')]);
  });

  it('locks: versions read, then stage_meta FOR UPDATE, then the snapshot (no concurrency in PGlite)', async () => {
    const statements: string[] = [];
    const recorder = {
      query: (text: string, params?: unknown[]) => {
        statements.push(text.replace(/\s+/g, ' ').trim());
        return pool.query(text, params);
      },
    };
    await teachingPackageStageGuardFence()(
      recorder as never,
      { stageId: STAGE, mode: 'mutate', scope: 'content', sceneId: 's1' },
      'before',
    );
    const at = (needle: string) => statements.findIndex((text) => text.includes(needle));
    expect(at('FROM teaching_package_versions')).toBeGreaterThanOrEqual(0);
    expect(at('FROM stage_meta WHERE stage_id = $1 FOR UPDATE')).toBeGreaterThan(
      at('FROM teaching_package_versions'),
    );
    expect(at('md5(')).toBeGreaterThan(at('FROM stage_meta WHERE stage_id = $1 FOR UPDATE'));
    expect(statements[at('md5(')]).toContain('AND id = $2');
  });

  it('setSceneLearningObjectives sends one "edited" per changed scene, naming its actor', async () => {
    await setSceneLearningObjectives(
      pool as unknown as ConnectableQueryable,
      VERSION,
      { tenantId: TENANT, actorRef: 'kafuo:reviewer-3' },
      [
        {
          sceneId: 's4',
          learningObjectives: [
            { objectiveRef: 'obj-1', snapshot: { statement: 'يحسب الكتلة' }, capturedAt: 1 },
          ],
        },
      ],
    );
    expect(await events()).toEqual([edited('s4', 'kafuo:reviewer-3')]);
  });
});
