import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpDocumentStore, HttpDocumentStoreError } from '@openmaic/storage';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  bindStageSceneRevs,
  clearStageSceneRevs,
  fetchSceneRevisions,
  manifestSceneRevs,
  revisionAwareFetch,
  sceneRev,
  stageSceneRevs,
  withExpectedSceneRevs,
} from '@/lib/persistence/scene-revision-registry';
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

/**
 * The client–server crossing of the revision preconditions
 * (single-slide-regeneration-plan §11), in production wiring: a real
 * `HttpDocumentStore` built exactly as `lib/persistence/bootstrap.ts` builds it
 * (`withExpectedSceneRevs` headers + `revisionAwareFetch`), whose requests are
 * served by the real persistence route and `scene-revisions` route over
 * PGlite, under a real write grant cookie.
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

const STAGE = 'stage-wiring';

describe('revision preconditions across the HTTP boundary', () => {
  let pool: PGlitePool;
  let cookie: string;
  let store: HttpDocumentStore<AppScene, AppStage>;
  let fetchImpl: typeof fetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://wiring-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'wiring-key');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    }).saveDocument(
      makeDocument(STAGE, 'Draft', [
        makeSlideScene('scene-1', STAGE, 1),
        makeSlideScene('scene-2', STAGE, 2),
      ]),
    );
    await insertVersion(pool as never, {
      id: 'tpv-wiring',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-wiring' } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    const { token } = buildEditorGrantPayload({
      tenantId: 'tenant-test',
      versionId: 'tpv-wiring',
      stageId: STAGE,
      capability: 'write',
    });
    cookie = `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, STAGE),
    )}`;

    // The browser's same-origin fetch, routed to the real handlers.
    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      if (url.pathname.startsWith('/api/persistence/')) {
        const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
        return handlePersistenceRequest(new Request(url, { ...init, headers }), {
          poolFactory: () => pool as never,
        });
      }
      const revisions = /^\/api\/stages\/([^/]+)\/scene-revisions$/.exec(url.pathname);
      if (revisions) {
        const { GET } = await import('@/app/api/stages/[id]/scene-revisions/route');
        return GET(new NextRequest(url, { headers }), {
          params: Promise.resolve({ id: decodeURIComponent(revisions[1]!) }),
        });
      }
      throw new Error(`unrouted ${url.pathname}`);
    }) as typeof fetch;

    store = new HttpDocumentStore<AppScene, AppStage>({
      baseUrl: '/api/persistence',
      headers: async (context) => withExpectedSceneRevs({}, context),
      fetch: revisionAwareFetch(fetchImpl),
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  });

  afterEach(async () => {
    clearStageSceneRevs();
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function loadAndBind() {
    const before = await fetchSceneRevisions(STAGE, fetchImpl);
    const document = await store.loadDocument(STAGE);
    const after = await fetchSceneRevisions(STAGE, fetchImpl);
    expect(before?.rev).toBe(after?.rev);
    bindStageSceneRevs(STAGE, manifestSceneRevs(after!));
    return document!;
  }

  it('a loaded tab saves the same slide twice; a stale tab is refused with 409', async () => {
    const document = await loadAndBind();
    const loaded = stageSceneRevs(STAGE)!;
    const base = document.scenes.find((scene) => scene.id === 'scene-1')!;

    await store.putScene(STAGE, { ...base, title: 'first' });
    expect(sceneRev(STAGE, 'scene-1')).toBe(loaded['scene-1']! + 1);
    await store.putScene(STAGE, { ...base, title: 'second' });
    expect(sceneRev(STAGE, 'scene-1')).toBe(loaded['scene-1']! + 2);

    // Another tab still holding the load-time revisions.
    const fresh = stageSceneRevs(STAGE)!;
    bindStageSceneRevs(STAGE, loaded);
    const stale = await store
      .putScene(STAGE, { ...base, title: 'stale tab' })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(HttpDocumentStoreError);
    expect(stale).toMatchObject({
      status: 409,
      code: 'SCENE_REVISION_CONFLICT',
      details: { scenes: [{ id: 'scene-1', currentRev: loaded['scene-1']! + 2 }] },
    });
    bindStageSceneRevs(STAGE, fresh);
    const current = await store.getScene(STAGE, 'scene-1');
    expect(current?.title).toBe('second');
  });

  it('a whole-document save carries every binding and rebinds from the response', async () => {
    const document = await loadAndBind();
    await store.saveDocument({
      ...document,
      scenes: [{ ...document.scenes[0]!, title: 'whole' }, makeSlideScene('scene-3', STAGE, 3)],
    });
    const manifest = await fetchSceneRevisions(STAGE, fetchImpl);
    expect(stageSceneRevs(STAGE)).toEqual(manifestSceneRevs(manifest!));
    expect(Object.keys(stageSceneRevs(STAGE)!).sort()).toEqual(['scene-1', 'scene-3']);
  });

  it('a tab that never bound the Stage is refused with 428 — never last-writer-wins', async () => {
    const document = await store.loadDocument(STAGE);
    const refused = await store
      .putScene(STAGE, { ...document!.scenes[0]!, title: 'unbound' })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 428, code: 'PRECONDITION_REQUIRED' });
    expect((await store.getScene(STAGE, 'scene-1'))?.title).not.toBe('unbound');
  });
});
