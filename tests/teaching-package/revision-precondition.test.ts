import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  parseExpectedSceneRevs,
  revisionConflicts,
  revisionPreconditionTarget,
} from '@/lib/server/teaching-package/revision-precondition-fence';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * AT-RV (single-slide-regeneration-plan §11): every grant-delegated document
 * write that can replace or delete a Scene carries the revisions it is based
 * on, checked inside the write transaction. Missing → 428; stale → 409 with
 * nothing written; owner (non-grant) writes are unchanged.
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

const STAGE = 'stage-rev-x';
const OWNER_STAGE = 'stage-rev-owner';
const OWNER_COOKIE = '55555555-5555-4555-8555-555555555555';
const HEADER = 'x-tp-expected-scene-revs';
const RESULT_HEADER = 'x-tp-scene-revs-result';

function grantCookie(capability: 'read' | 'write' = 'write'): string {
  const { token } = buildEditorGrantPayload({
    tenantId: 'tenant-test',
    versionId: 'tpv-rev-x',
    stageId: STAGE,
    capability,
  });
  return `teaching_package_grant=${encodeURIComponent(
    grantCookieValueForRedeem(new Headers(), token, STAGE),
  )}`;
}

const revsHeader = (revs: Record<string, number>) => encodeURIComponent(JSON.stringify(revs));

function titled(scene: AppScene, title: string): AppScene {
  return { ...scene, title };
}

describe('grant-delegated scene writes carry revision preconditions', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://route-rev-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'rev-route-key');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);

    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(STAGE, 'Package draft', [
        makeSlideScene('scene-1', STAGE, 1),
        makeSlideScene('scene-2', STAGE, 2),
      ]),
    );
    await insertVersion(pool as never, {
      id: 'tpv-rev-x',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-rev-x' } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    const ownerStore = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: `anon:${OWNER_COOKIE}`,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await ownerStore.saveDocument(
      makeDocument(OWNER_STAGE, 'Own course', [makeSlideScene('scene-1', OWNER_STAGE, 1)]),
    );
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return import('@/app/api/persistence/[...path]/route').then(({ handlePersistenceRequest }) =>
      handlePersistenceRequest(new Request(`http://localhost/api/persistence${path}`, init), {
        poolFactory: () => pool as never,
      }),
    );
  }

  async function revs(stageId = STAGE): Promise<Record<string, number>> {
    const result = await pool.query(
      `SELECT s.id, COALESCE(sr.rev, 0) AS rev FROM document_scenes s
         LEFT JOIN document_scene_revision sr ON sr.stage_id = s.stage_id AND sr.scene_id = s.id
        WHERE s.stage_id = $1`,
      [stageId],
    );
    return Object.fromEntries(
      (result.rows as Array<{ id: string; rev: number | string }>).map((row) => [
        row.id,
        Number(row.rev),
      ]),
    );
  }

  async function storedTitle(sceneId: string): Promise<string | undefined> {
    const result = await pool.query(
      `SELECT data->>'title' AS title FROM document_scenes WHERE stage_id = $1 AND id = $2`,
      [STAGE, sceneId],
    );
    return (result.rows[0] as { title?: string } | undefined)?.title;
  }

  function putScene(scene: AppScene, headers: Record<string, string> = {}): Promise<Response> {
    return call(`/documents/${STAGE}/scenes/${scene.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: grantCookie(), ...headers },
      body: JSON.stringify(scene),
    });
  }

  function putDocument(scenes: AppScene[], headers: Record<string, string> = {}) {
    return call(`/documents/${STAGE}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: grantCookie(), ...headers },
      body: JSON.stringify(makeDocument(STAGE, 'Package draft', scenes)),
    });
  }

  it('AT-RV 1: an old tab’s whole-document save without the header → 428, nothing written', async () => {
    const before = await revs();
    const response = await putDocument([
      titled(makeSlideScene('scene-1', STAGE, 1), 'old tab'),
      makeSlideScene('scene-2', STAGE, 2),
    ]);
    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRECONDITION_REQUIRED' },
    });
    expect(await revs()).toEqual(before);
    expect(await storedTitle('scene-1')).toBe('Scene 1');
  });

  it('AT-RV 2: a scene PUT or DELETE without the header → 428; a malformed header counts as missing', async () => {
    const before = await revs();
    expect((await putScene(titled(makeSlideScene('scene-1', STAGE, 1), 'x'))).status).toBe(428);
    const remove = await call(`/documents/${STAGE}/scenes/scene-2`, {
      method: 'DELETE',
      headers: { cookie: grantCookie() },
    });
    expect(remove.status).toBe(428);
    const malformed = await putScene(titled(makeSlideScene('scene-1', STAGE, 1), 'x'), {
      [HEADER]: 'not-json',
    });
    expect(malformed.status).toBe(428);
    expect(await revs()).toEqual(before);
  });

  it('AT-RV 3 + 11: a stale tab gets 409 with the current rev; the fresh tab saves twice in a row', async () => {
    const loaded = await revs();
    // Tab A saves scene-1 on its loaded base and learns the new rev.
    const first = await putScene(titled(makeSlideScene('scene-1', STAGE, 1), 'A1'), {
      [HEADER]: revsHeader({ 'scene-1': loaded['scene-1']! }),
    });
    expect([200, 204]).toContain(first.status);
    const learned = parseExpectedSceneRevs(first.headers.get(RESULT_HEADER));
    expect(learned).toEqual({ 'scene-1': loaded['scene-1']! + 1 });
    // AT-RV 11: a second save from the same tab on the learned rev.
    const second = await putScene(titled(makeSlideScene('scene-1', STAGE, 1), 'A2'), {
      [HEADER]: revsHeader(learned!),
    });
    expect([200, 204]).toContain(second.status);
    // Tab B still holds the load-time rev.
    const stale = await putScene(titled(makeSlideScene('scene-1', STAGE, 1), 'B'), {
      [HEADER]: revsHeader({ 'scene-1': loaded['scene-1']! }),
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: { code: string; details: { scenes: Array<{ id: string; currentRev: number }> } };
    };
    expect(body.error.code).toBe('SCENE_REVISION_CONFLICT');
    expect(body.error.details.scenes).toEqual([
      { id: 'scene-1', currentRev: loaded['scene-1']! + 2 },
    ]);
    expect(stale.headers.get(RESULT_HEADER)).toBeNull();
    expect(await storedTitle('scene-1')).toBe('A2');
  });

  it('AT-RV 6: a whole-document save with one stale scene → 409 and no scene is written', async () => {
    const loaded = await revs();
    // Someone else changes scene-2.
    await putScene(titled(makeSlideScene('scene-2', STAGE, 2), 'elsewhere'), {
      [HEADER]: revsHeader({ 'scene-2': loaded['scene-2']! }),
    });
    const afterOther = await revs();
    const response = await putDocument(
      [
        titled(makeSlideScene('scene-1', STAGE, 1), 'whole'),
        titled(makeSlideScene('scene-2', STAGE, 2), 'whole'),
      ],
      { [HEADER]: revsHeader(loaded) },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { details: { scenes: Array<{ id: string; currentRev: number | null }> } };
    };
    expect(body.error.details.scenes).toEqual([
      { id: 'scene-2', currentRev: afterOther['scene-2'] },
    ]);
    expect(await revs()).toEqual(afterOther);
    expect(await storedTitle('scene-1')).toBe('Scene 1');
    expect(await storedTitle('scene-2')).toBe('elsewhere');
  });

  it('AT-RV 6b: a whole-document save on fresh revs succeeds and returns every live rev', async () => {
    const loaded = await revs();
    const response = await putDocument(
      [titled(makeSlideScene('scene-1', STAGE, 1), 'whole'), makeSlideScene('scene-3', STAGE, 3)],
      { [HEADER]: revsHeader(loaded) },
    );
    expect([200, 204]).toContain(response.status);
    const result = parseExpectedSceneRevs(response.headers.get(RESULT_HEADER));
    // scene-2 was deleted by the whole save, scene-3 created.
    expect(result).toEqual(await revs());
    expect(Object.keys(result!).sort()).toEqual(['scene-1', 'scene-3']);
  });

  it('AT-RV 7: a scene deleted elsewhere, then a whole save that still expects it → 409', async () => {
    const loaded = await revs();
    const removed = await call(`/documents/${STAGE}/scenes/scene-2`, {
      method: 'DELETE',
      headers: { cookie: grantCookie(), [HEADER]: revsHeader({ 'scene-2': loaded['scene-2']! }) },
    });
    expect([200, 204]).toContain(removed.status);
    expect(parseExpectedSceneRevs(removed.headers.get(RESULT_HEADER))).toBeNull();
    expect(decodeURIComponent(removed.headers.get(RESULT_HEADER)!)).toBe('{"scene-2":null}');
    const response = await putDocument(
      [makeSlideScene('scene-1', STAGE, 1), makeSlideScene('scene-2', STAGE, 2)],
      { [HEADER]: revsHeader(loaded) },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { details: { scenes: Array<{ id: string; currentRev: number | null }> } };
    };
    expect(body.error.details.scenes).toEqual([{ id: 'scene-2', currentRev: null }]);
    expect(Object.keys(await revs())).toEqual(['scene-1']);
  });

  it('a whole save that would delete a scene it never loaded → 409 (the unknown scene is listed)', async () => {
    const loaded = await revs();
    const { 'scene-2': _unknown, ...partial } = loaded;
    const response = await putDocument([makeSlideScene('scene-1', STAGE, 1)], {
      [HEADER]: revsHeader(partial),
    });
    expect(response.status).toBe(409);
    expect(await revs()).toEqual(loaded);
  });

  it('a new scene with no entry is a creation; an entry for a scene that is gone is a conflict', async () => {
    const created = await putScene(makeSlideScene('scene-9', STAGE, 9), {
      [HEADER]: revsHeader({}),
    });
    expect([200, 204]).toContain(created.status);
    const ghost = await putScene(makeSlideScene('scene-8', STAGE, 8), {
      [HEADER]: revsHeader({ 'scene-8': 4 }),
    });
    expect(ghost.status).toBe(409);
  });

  it('AT-RV 9: owner (non-grant) saves without a header are unchanged', async () => {
    const response = await call(`/documents/${OWNER_STAGE}/scenes/scene-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `anonymous_id=${OWNER_COOKIE}` },
      body: JSON.stringify(titled(makeSlideScene('scene-1', OWNER_STAGE, 1), 'owner')),
    });
    expect([200, 204]).toContain(response.status);
    expect(response.headers.get(RESULT_HEADER)).toBeNull();
  });

  it('a read grant is still refused with 403 before any precondition is considered', async () => {
    const response = await call(`/documents/${STAGE}/scenes/scene-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: grantCookie('read') },
      body: JSON.stringify(makeSlideScene('scene-1', STAGE, 1)),
    });
    expect(response.status).toBe(403);
  });

  it('a stage PUT (no scene content) is not covered', async () => {
    const response = await call(`/documents/${STAGE}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: grantCookie() },
      body: JSON.stringify({ id: STAGE, name: 'Renamed', createdAt: 1, updatedAt: 2 }),
    });
    expect([200, 204]).toContain(response.status);
  });
});

describe('revision precondition helpers', () => {
  it('derives the covered target from the method and path', () => {
    expect(revisionPreconditionTarget('PUT', '/documents/s1')).toEqual({
      kind: 'document',
      stageId: 's1',
    });
    expect(revisionPreconditionTarget('DELETE', '/documents/s1/scenes/x%20y')).toEqual({
      kind: 'scene',
      stageId: 's1',
      sceneId: 'x y',
      method: 'DELETE',
    });
    expect(revisionPreconditionTarget('PUT', '/documents/s1/stage')).toBeNull();
    expect(revisionPreconditionTarget('GET', '/documents/s1')).toBeNull();
    expect(revisionPreconditionTarget('DELETE', '/documents/s1')).toBeNull();
  });

  it('parses only integer, non-negative revisions', () => {
    expect(parseExpectedSceneRevs(encodeURIComponent('{"a":3}'))).toEqual({ a: 3 });
    expect(parseExpectedSceneRevs(encodeURIComponent('{"a":-1}'))).toBeNull();
    expect(parseExpectedSceneRevs(encodeURIComponent('{"a":1.5}'))).toBeNull();
    expect(parseExpectedSceneRevs(encodeURIComponent('[1]'))).toBeNull();
    expect(parseExpectedSceneRevs(null)).toBeNull();
  });

  it('reports every conflict of a whole-document write', () => {
    const live = new Map([
      ['a', 2],
      ['b', 5],
    ]);
    expect(revisionConflicts({ kind: 'document', stageId: 's' }, { a: 2, b: 5 }, live)).toEqual([]);
    expect(revisionConflicts({ kind: 'document', stageId: 's' }, { a: 1, c: 7 }, live)).toEqual([
      { id: 'a', currentRev: 2 },
      { id: 'b', currentRev: 5 },
      { id: 'c', currentRev: null },
    ]);
  });
});
