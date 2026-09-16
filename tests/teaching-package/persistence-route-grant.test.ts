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
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
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

const STAGE_X = 'stage-grant-x';
const STAGE_Y = 'stage-grant-y';
const OWNER_COOKIE = '44444444-4444-4444-8444-444444444444';

function grantCookie(stageId: string, capability: 'read' | 'write'): string {
  const { token } = buildEditorGrantPayload({
    tenantId: 'tenant-test',
    versionId: `tpv-${stageId}`,
    stageId,
    capability,
  });
  return `teaching_package_grant=${encodeURIComponent(
    grantCookieValueForRedeem(new Headers(), token, stageId),
  )}`;
}

/** The learner key of the grant a cookie carries. */
async function grantLearnerKey(stageId: string): Promise<string> {
  const { payload } = buildEditorGrantPayload({
    tenantId: 'tenant-test',
    versionId: `tpv-${stageId}`,
    stageId,
    capability: 'read',
  });
  // The learner key is derived from a fresh nonce each call, so tests that
  // need the exact value must build the cookie once and reuse it.
  return payload.learnerKey;
}
void grantLearnerKey;

function sessionInit(id: string, stageId: string, learnerKey: string) {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'chat',
    stageId,
    learnerKey,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

describe('persistence route editor grant', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;
  let grantKeyOfX: string;
  let grantKeyOfY: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    // NO PERSISTENCE_DEV_TOKEN: every grant-free path must answer the
    // documented 503, proving package traffic never depends on dev auth.
    vi.stubEnv('DATABASE_URL', `postgres://route-grant-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'grant-route-key');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(
      process.env.DATABASE_URL!,
      () => pool as never,
    );

    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(STAGE_X, 'Package draft', [makeSlideScene('scene-1', STAGE_X, 1)]),
    );
    await store.saveDocument(
      makeDocument(STAGE_Y, 'Other stage', [makeSlideScene('scene-1', STAGE_Y, 1)]),
    );
    await insertVersion(qp(), {
      id: 'tpv-grant-x',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-grant-x' } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE_X,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertVersion(qp(), {
      id: 'tpv-grant-y',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-grant-y' } },
      version: 1,
      status: 'approved',
      currentStageId: STAGE_Y,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    // Fix one grant learner key per stage for the whole test.
    grantKeyOfX = (
      await import('@/lib/server/teaching-package/editor-grant')
    ).buildEditorGrantPayload({
      tenantId: 'tenant-test',
      versionId: 'tpv-grant-x',
      stageId: STAGE_X,
      capability: 'write',
    }).payload.learnerKey;
    grantKeyOfY = (
      await import('@/lib/server/teaching-package/editor-grant')
    ).buildEditorGrantPayload({
      tenantId: 'tenant-test',
      versionId: 'tpv-grant-y',
      stageId: STAGE_Y,
      capability: 'read',
    }).payload.learnerKey;
    void provider;
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

  function putSceneInit(
    stageId: string,
    cookie: string,
    extraHeaders: Record<string, string> = {},
  ): RequestInit {
    return {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
      body: JSON.stringify(makeSlideScene('scene-2', stageId, 2)),
    };
  }

  it('serves a read grant: document loads, mutations refused, other stages untouched', async () => {
    const cookie = grantCookie(STAGE_X, 'read');

    const read = await call(`/documents/${STAGE_X}`, { headers: { cookie } });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ stage: { id: STAGE_X } });

    const mutation = await call(
      `/documents/${STAGE_X}/scenes/scene-2`,
      putSceneInit(STAGE_X, cookie),
    );
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({ error: { code: 'GRANT_READ_ONLY' } });

    // The exact pair Kafuo Preview produced in the field: the document GET
    // succeeds and the Stage PUT — what the classroom's load-time roster
    // migration used to queue — is refused. Enforcement is server-side and
    // stays that way; the client gate is an additional layer, never a
    // replacement for this.
    const stageMutation = await call(`/documents/${STAGE_X}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: STAGE_X, name: 'renamed by preview' }),
    });
    expect(stageMutation.status).toBe(403);
    await expect(stageMutation.json()).resolves.toMatchObject({
      error: { code: 'GRANT_READ_ONLY' },
    });

    // Stage Y is NOT covered by this grant: pre-existing behavior (503).
    const other = await call(`/documents/${STAGE_Y}`, { headers: { cookie } });
    expect(other.status).toBe(503);
    await expect(other.json()).resolves.toMatchObject({
      error: { code: 'PERSISTENCE_DEV_TOKEN_MISSING' },
    });
  });

  it('serves a write grant: drafts are editable, deletes guarded, other stages untouched', async () => {
    const cookie = grantCookie(STAGE_X, 'write');

    const write = await call(`/documents/${STAGE_X}/scenes/scene-2`, putSceneInit(STAGE_X, cookie));
    expect([200, 204]).toContain(write.status);

    // No stage_meta row ever carries the anonymous cookie owner.
    const owners = await pool.query(`SELECT DISTINCT owner_id FROM stage_meta`);
    expect(owners.rows.map((row) => (row as { owner_id: string }).owner_id)).toEqual([
      TEACHING_PACKAGE_STAGE_OWNER,
    ]);

    const remove = await call(`/documents/${STAGE_X}`, { method: 'DELETE', headers: { cookie } });
    expect(remove.status).toBe(423);
    await expect(remove.json()).resolves.toMatchObject({ error: { code: 'STAGE_LOCKED' } });

    // A write grant on an APPROVED stage still cannot mutate: the guard.
    const approvedCookie = grantCookie(STAGE_Y, 'write');
    const approvedWrite = await call(
      `/documents/${STAGE_Y}/scenes/scene-2`,
      putSceneInit(STAGE_Y, approvedCookie),
    );
    expect(approvedWrite.status).toBe(423);

    // Stage Y with the X grant: no delegation, pre-existing 503.
    const foreign = await call(
      `/documents/${STAGE_Y}/scenes/scene-2`,
      putSceneInit(STAGE_Y, cookie),
    );
    expect(foreign.status).toBe(503);
  });

  it('delegates runtime only for the grant’s own stage and learner sandbox', async () => {
    const cookie = grantCookie(STAGE_X, 'read');
    void grantKeyOfX;
    void grantKeyOfY;

    // Create a session through the delegated route: body learner key must be
    // the grant's own — we mint a fresh grant and reuse ITS key.
    const { buildEditorGrantPayload: build } =
      await import('@/lib/server/teaching-package/editor-grant');
    const { payload, token } = build({
      tenantId: 'tenant-test',
      versionId: 'tpv-grant-x',
      stageId: STAGE_X,
      capability: 'write',
    });
    const cookieWithKey = `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, STAGE_X),
    )}`;

    const created = await call('/runtime/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify(sessionInit('sess-g1', STAGE_X, payload.learnerKey)),
    });
    expect(created.status).toBe(201);

    // The stored session's learner key is the grant's, never the header's.
    const headerSpoof = await call('/runtime/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieWithKey,
        'x-learner-key': 'anon:someone-else',
      },
      body: JSON.stringify(sessionInit('sess-g2', STAGE_X, payload.learnerKey)),
    });
    expect(headerSpoof.status).toBe(201);
    const stored = await pool.query(
      `SELECT learner_key FROM runtime_sessions WHERE id IN ('sess-g1','sess-g2')`,
    );
    expect(stored.rows.map((row) => (row as { learner_key: string }).learner_key)).toEqual([
      payload.learnerKey,
      payload.learnerKey,
    ]);

    // Records under the granted session work (the record's kind rides the
    // session; the init needs id/sessionId/createdAt/payload).
    const recordInit = (id: string, sessionId: string) => ({
      id,
      sessionId,
      createdAt: new Date().toISOString(),
      payload: { role: 'user', content: 'hi' },
    });
    const record = await call(`/runtime/sessions/sess-g1/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify(recordInit('rec-1', 'sess-g1')),
    });
    expect(record.status).toBe(201);

    // The grant's stage-scoped listing works.
    const listed = await call(
      `/runtime/stages/${STAGE_X}/learners/${encodeURIComponent(payload.learnerKey)}/sessions`,
      { headers: { cookie: cookieWithKey } },
    );
    expect(listed.status).toBe(200);

    // Another learner key on the granted stage: refused.
    const otherLearner = await call('/runtime/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify(sessionInit('sess-bad', STAGE_X, 'anon:other')),
    });
    expect(otherLearner.status).toBe(403);
    await expect(otherLearner.json()).resolves.toMatchObject({
      error: { code: 'GRANT_RUNTIME_SCOPE' },
    });

    // Another stage under this grant: refused.
    const otherStage = await call('/runtime/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify(sessionInit('sess-bad-2', STAGE_Y, payload.learnerKey)),
    });
    expect(otherStage.status).toBe(403);

    // A real learner's session on the granted stage: refused for records.
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const provider = await getServerPersistenceProvider(
      process.env.DATABASE_URL!,
      () => pool as never,
    );
    await provider.runtimeStore.createSession(
      sessionInit('sess-real', STAGE_X, 'anon:real-learner') as never,
    );
    const realLearnerRecords = await call(`/runtime/sessions/sess-real/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify(recordInit('rec-2', 'sess-real')),
    });
    expect(realLearnerRecords.status).toBe(403);
    expect(realLearnerRecords.json()).resolves.toMatchObject({
      error: { code: 'GRANT_RUNTIME_SCOPE' },
    });

    // A session on Stage Y under the Stage X grant: refused.
    await provider.runtimeStore.createSession(
      sessionInit('sess-y', STAGE_Y, payload.learnerKey) as never,
    );
    const stageYRecords = await call(`/runtime/sessions/sess-y/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify(recordInit('rec-3', 'sess-y')),
    });
    expect(stageYRecords.status).toBe(403);

    // Cross learner listing: refused.
    const crossList = await call(
      `/runtime/stages/${STAGE_X}/learners/${encodeURIComponent('anon:other')}/sessions`,
      { headers: { cookie: cookieWithKey } },
    );
    expect(crossList.status).toBe(403);

    // Merge and admin: never delegated — without the dev token they answer the
    // pre-existing 503, exactly as a grant-free request would.
    const merge = await call('/runtime/learners/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieWithKey },
      body: JSON.stringify({ fromLearnerKey: 'anon:a', toLearnerKey: 'anon:b' }),
    });
    expect(merge.status).toBe(503);
    const admin = await call(`/runtime/stages/${STAGE_X}`, {
      method: 'DELETE',
      headers: { cookie: cookieWithKey },
    });
    expect(admin.status).toBe(503);

    // Read and write grants produce identical runtime outcomes under the
    // same learner sandbox: capability broadens neither Stage nor learner
    // scope. A read grant creates sessions under its own key just the same…
    const { payload: readPayload, token: readToken } = build({
      tenantId: 'tenant-test',
      versionId: 'tpv-grant-x',
      stageId: STAGE_X,
      capability: 'read',
    });
    const readCookie = `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), readToken, STAGE_X),
    )}`;
    const readCreated = await call('/runtime/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: readCookie },
      body: JSON.stringify(sessionInit('sess-read', STAGE_X, readPayload.learnerKey)),
    });
    expect(readCreated.status).toBe(201);
    // …and refuses the same out-of-scope requests a write grant refuses.
    const readGrantSession = await call(
      `/runtime/stages/${STAGE_X}/learners/${encodeURIComponent('anon:x')}/sessions`,
      {
        headers: { cookie: readCookie },
      },
    );
    expect(readGrantSession.status).toBe(403);
    void cookie;
  });

  it('opens assets under any valid grant but still refuses mutations', async () => {
    const cookie = grantCookie(STAGE_X, 'read');
    const form = new FormData();
    form.append('meta', new Blob([JSON.stringify({})], { type: 'application/json' }), 'meta');
    form.append('bytes', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'bytes');

    const allocated = await call('/assets', { method: 'POST', headers: { cookie }, body: form });
    expect(allocated.status).toBe(201);
    const { id } = (await allocated.json()) as { id: string };

    const read = await call(`/assets/${id}/content`, { headers: { cookie } });
    expect(read.status).toBe(200);

    const put = await call(`/assets/${id}/content`, {
      method: 'PUT',
      headers: { cookie },
      body: form,
    });
    expect(put.status).toBe(403);
    const remove = await call(`/assets/${id}`, { method: 'DELETE', headers: { cookie } });
    expect(remove.status).toBe(403);
  });

  it('keeps the grant-free behavior: 503 without the dev token', async () => {
    const response = await call(`/documents/${STAGE_X}`, {
      headers: { cookie: `anonymous_id=${OWNER_COOKIE}` },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PERSISTENCE_DEV_TOKEN_MISSING' },
    });
  });

  it('does not list documents even under a grant', async () => {
    const cookie = grantCookie(STAGE_X, 'write');
    const response = await call('/documents', { headers: { cookie } });
    expect(response.status).toBe(503);
  });
});
