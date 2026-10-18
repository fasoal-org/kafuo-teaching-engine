import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
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

/**
 * Roles phase 1 review OM-01 (row 10): POST
 * /api/stages/[id]/scenes/[sceneId]/narration-audio is reachable with only the
 * editor-grant cookie (O1), so its own grant check is the guard. The route goes
 * through the real resolver (`regeneration-grant.ts`) over PGlite; only the
 * audio service is stubbed, so no TTS provider, network or paid call can run.
 * The service itself is covered by `scene-narration-audio.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  regenerateAudio: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/scene-narration-audio', () => ({
  regenerateSceneNarrationAudio: mocks.regenerateAudio,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

const STAGE = 'stage-audio-x';
const OTHER = 'stage-audio-y';

function cookieFor(
  stageId: string,
  capability: 'read' | 'write',
  options: { purpose?: 'edit' | 'preview' | 'learner'; now?: number; versionId?: string } = {},
): { cookie: string; learnerKey: string } {
  const { token, payload } = buildEditorGrantPayload({
    tenantId: 'tenant-test',
    versionId: options.versionId ?? `tpv-${stageId}`,
    stageId,
    capability,
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return {
    cookie: `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, stageId),
    )}`,
    learnerKey: payload.learnerKey,
  };
}

describe('POST narration-audio grant refusal (review OM-01 row 10)', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://audio-route-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'audio-route-key');
    mocks.regenerateAudio.mockReset();
    mocks.regenerateAudio.mockImplementation(async (_grant: unknown, sceneId: string) => ({
      sceneId,
      scene: makeSlideScene(sceneId, STAGE, 1),
      rev: 2,
      generated: 1,
      missing: 0,
    }));

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
      makeDocument(STAGE, 'Draft package', [makeSlideScene('scene-1', STAGE, 1)]),
    );
    await store.saveDocument(
      makeDocument(OTHER, 'Other draft package', [makeSlideScene('scene-1', OTHER, 1)]),
    );
    for (const stageId of [STAGE, OTHER]) {
      await insertVersion(pool as never, {
        id: `tpv-${stageId}`,
        aggregate: {
          tenantId: 'tenant-test',
          learningItem: { type: 'lesson', id: `li-${stageId}` },
        },
        version: 1,
        status: 'draft',
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
    }
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function post(cookie: string, sceneId = 'scene-1', stageId = STAGE): Promise<Response> {
    const { POST } = await import('@/app/api/stages/[id]/scenes/[sceneId]/narration-audio/route');
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    return POST(
      new NextRequest(`http://localhost/api/stages/${stageId}/scenes/${sceneId}/narration-audio`, {
        method: 'POST',
        headers,
      }),
      { params: Promise.resolve({ id: stageId, sceneId }) },
    );
  }

  it('read, learner and preview grants → 403 READ_ONLY_GRANT; the audio service never runs', async () => {
    // The shapes the mint produces: only an `edit` handoff carries `write`
    // (`app/api/teaching-packages/[id]/editor-handoff/route.ts`).
    for (const cookie of [
      cookieFor(STAGE, 'read').cookie,
      cookieFor(STAGE, 'read', { purpose: 'learner' }).cookie,
      cookieFor(STAGE, 'read', { purpose: 'preview' }).cookie,
    ]) {
      const response = await post(cookie);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'READ_ONLY_GRANT' } });
    }
    expect(mocks.regenerateAudio).not.toHaveBeenCalled();
  });

  it('no grant, a forged cookie, an expired grant and another Stage’s grant → plain 404; the audio service never runs', async () => {
    const cases = [
      '',
      `teaching_package_grant=${encodeURIComponent(JSON.stringify(['forged.token']))}`,
      cookieFor(STAGE, 'write', { now: Date.now() - 30 * 24 * 3600 * 1000 }).cookie,
      cookieFor(OTHER, 'write').cookie,
      // A grant for this Stage whose version names another Stage.
      cookieFor(STAGE, 'write', { versionId: `tpv-${OTHER}` }).cookie,
    ];
    for (const cookie of cases) {
      const response = await post(cookie);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
    }
    expect(mocks.regenerateAudio).not.toHaveBeenCalled();
  });

  it('a write grant passes the grant check and reaches the audio service with the grant’s scope', async () => {
    const { cookie, learnerKey } = cookieFor(STAGE, 'write', { purpose: 'edit' });
    const response = await post(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      sceneId: 'scene-1',
      rev: 2,
      generated: 1,
      missing: 0,
    });
    expect(mocks.regenerateAudio).toHaveBeenCalledTimes(1);
    const [scope, sceneId, deps] = mocks.regenerateAudio.mock.calls[0]!;
    expect(scope).toEqual({
      tenantId: 'tenant-test',
      versionId: `tpv-${STAGE}`,
      stageId: STAGE,
      learnerKey,
    });
    expect(sceneId).toBe('scene-1');
    expect(deps).toHaveProperty('pool');
  });
});
