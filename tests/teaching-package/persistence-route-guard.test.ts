import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { TeachingPackageStageLockedError } from '@/lib/server/teaching-package/errors';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createFakeDocumentStore } from '../agent-runtime/_fake-document-store';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
}));

// Only the REST stage route builds its store through this seam; the embedded
// persistence route constructs the owner-bound store directly and is exercised
// for real below.
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
}));

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

describe('persistence route teaching package guard', () => {
  let pool: PGlitePool;
  const ownerCookie = '33333333-3333-4333-8333-333333333333';
  const qp = () => pool as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://route-guard-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'configured');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function seedStage(stageId: string): Promise<void> {
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: `anon:${ownerCookie}`,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(stageId, 'Route guarded', [makeSlideScene('scene-1', stageId, 1)]),
    );
  }

  async function seedVersion(stageId: string, status: 'draft' | 'approved'): Promise<void> {
    await insertVersion(qp(), {
      id: `tpv-route-${stageId}`,
      learningItem: { type: 'lesson', id: `li-${stageId}` },
      version: 1,
      status,
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  }

  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return import('@/app/api/persistence/[...path]/route').then(({ handlePersistenceRequest }) =>
      handlePersistenceRequest(
        new Request(`http://localhost/api/persistence${path}`, {
          ...init,
          headers: { cookie: `anonymous_id=${ownerCookie}`, ...init.headers },
        }),
        { poolFactory: () => pool as never },
      ),
    );
  }

  it('answers 423 STAGE_LOCKED for a scene PUT on an approved stage', async () => {
    const stageId = 'stage-route-approved';
    await seedStage(stageId);
    await seedVersion(stageId, 'approved');

    const response = await call(`/documents/${stageId}/scenes/scene-2`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSlideScene('scene-2', stageId, 2)),
    });
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'STAGE_LOCKED', message: expect.stringContaining('approved') },
    });
  });

  it('answers 423 STAGE_LOCKED for a document DELETE on an approved stage', async () => {
    const stageId = 'stage-route-approved-delete';
    await seedStage(stageId);
    await seedVersion(stageId, 'approved');

    const response = await call(`/documents/${stageId}`, { method: 'DELETE' });
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'STAGE_LOCKED' } });
  });

  it('still serves writes for a draft stage (200/204)', async () => {
    const stageId = 'stage-route-draft';
    await seedStage(stageId);
    await seedVersion(stageId, 'draft');

    const response = await call(`/documents/${stageId}/scenes/scene-2`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeSlideScene('scene-2', stageId, 2)),
    });
    expect([200, 204]).toContain(response.status);
  });
});

describe('REST stage route teaching package guard mapping', () => {
  const STAGE_ID = 'stage-rest-locked';
  type Params = { params: Promise<{ id: string }> };
  const routeParams: Params = { params: Promise.resolve({ id: STAGE_ID }) };

  /** NextRequest's own init type, so `signal: null` (DOM RequestInit) is not required. */
  type NextInit = ConstructorParameters<typeof NextRequest>[1];

  function jsonInit(method: string, body: unknown): NextInit {
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  beforeEach(() => {
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('DATABASE_URL', 'postgres://rest-guard-test');
    mocks.fakeStore = createFakeDocumentStore();
    mocks.fakeStore.docs.set(
      STAGE_ID,
      makeDocument(STAGE_ID, 'Original', [makeSlideScene('scene-1', STAGE_ID, 1)]),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps the guard refusal to 423 STAGE_LOCKED on PUT', async () => {
    mocks.fakeStore!.failNextSaveWith(new TeachingPackageStageLockedError(STAGE_ID, 'approved'));
    const { PUT } = await import('@/app/api/stages/[id]/route');
    const response = await PUT(
      new NextRequest(
        `http://localhost/api/stages/${STAGE_ID}`,
        jsonInit('PUT', makeDocument(STAGE_ID, 'X')),
      ),
      routeParams,
    );
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.errorCode).toBe('STAGE_LOCKED');
    expect(body.error).toContain('teaching package stage locked (approved)');
  });

  it('maps the guard refusal to 423 STAGE_LOCKED on PATCH', async () => {
    mocks.fakeStore!.failNextSaveWith(new TeachingPackageStageLockedError(STAGE_ID, 'in_review'));
    const { PATCH } = await import('@/app/api/stages/[id]/route');
    const response = await PATCH(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}`, jsonInit('PATCH', { name: 'X' })),
      routeParams,
    );
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'STAGE_LOCKED' });
  });

  it('maps the guard refusal to 423 STAGE_LOCKED on DELETE', async () => {
    mocks.fakeStore!.store.deleteDocument = async () => {
      throw new TeachingPackageStageLockedError(STAGE_ID, 'package-owned');
    };
    const { DELETE } = await import('@/app/api/stages/[id]/route');
    const response = await DELETE(
      new NextRequest(`http://localhost/api/stages/${STAGE_ID}`, { method: 'DELETE' }),
      routeParams,
    );
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'STAGE_LOCKED' });
  });
});
