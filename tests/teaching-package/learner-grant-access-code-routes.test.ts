/**
 * Roles Module phase 1, owner decision D-O1-5 (19 Oct 2026).
 *
 * Under O1's presence-only exemption, a learner holding only the grant cookie
 * would newly reach three editor GET rows for their own Stage:
 * - row 1: GET `/api/stages/:id/teaching-skills`;
 * - row 4: GET `/api/stages/:id/scene-regeneration`;
 * - row 7: GET `/api/stages/:id/scene-revisions`.
 *
 * Before O1 the middleware answered them with 401. Each handler now gives a
 * learner that exact answer while `ACCESS_CODE` is set and no valid access
 * cookie is present, judged on the grant the handler resolves for the Stage.
 * Edit, preview and legacy grants, the access cookie, and a deployment without
 * `ACCESS_CODE` behave as before.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { createAccessToken } from '@/lib/server/access-token';
import { buildEditorGrantPayload } from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const CODE = 'd-o1-5-access-code';
const TENANT = 'tenant-test';

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

type Row = 'teaching-skills' | 'scene-regeneration' | 'scene-revisions';
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const ROWS: readonly Row[] = ['teaching-skills', 'scene-regeneration', 'scene-revisions'];

async function loadGet(row: Row): Promise<Handler> {
  if (row === 'teaching-skills') {
    return (await import('@/app/api/stages/[id]/teaching-skills/route')).GET;
  }
  if (row === 'scene-regeneration') {
    return (await import('@/app/api/stages/[id]/scene-regeneration/route')).GET;
  }
  return (await import('@/app/api/stages/[id]/scene-revisions/route')).GET;
}

describe('D-O1-5: a learner grant keeps the old 401 on editor GET rows 1, 4 and 7', () => {
  let pool: PGlitePool;
  let stageId: string;
  let versionId: string;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-do15-${(counter += 1)}`;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://do15-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'do15-grant-key');
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '');
    vi.stubEnv('ACCESS_CODE', CODE);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);

    // A draft Stage with no generation attempt: row 1 answers `{ governed: false }`.
    stageId = nextId('stage');
    versionId = nextId('tpv');
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    }).saveDocument(makeDocument(stageId, 'D-O1-5', [makeSlideScene('scene-1', stageId, 1)]));
    await insertVersion(pool as never, {
      id: versionId,
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: nextId('li') } },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      currentAttemptId: null,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function token(
    options: {
      capability?: 'read' | 'write';
      purpose?: 'edit' | 'preview' | 'learner';
      stage?: string;
      version?: string;
    } = {},
  ): string {
    return buildEditorGrantPayload({
      tenantId: TENANT,
      versionId: options.version ?? versionId,
      stageId: options.stage ?? stageId,
      capability: options.capability ?? 'read',
      ...(options.purpose ? { purpose: options.purpose } : {}),
    }).token;
  }

  const grantCookie = (...tokens: string[]) =>
    `teaching_package_grant=${encodeURIComponent(JSON.stringify(tokens))}`;
  const learnerCookie = () => grantCookie(token({ purpose: 'learner' }));
  const accessCookie = () => `openmaic_access=${createAccessToken(CODE)}`;

  async function call(row: Row, cookie?: string): Promise<Response> {
    const GET = await loadGet(row);
    const request = new NextRequest(`http://te.test/api/stages/${stageId}/${row}`, {
      headers: cookie ? { cookie } : {},
    });
    return GET(request, { params: Promise.resolve({ id: stageId }) });
  }

  /** What the middleware answered these rows before O1: no access cookie → 401. */
  async function middleware401(row: Row): Promise<{ status: number; type: string; body: string }> {
    const { middleware } = await import('@/middleware');
    const response = await middleware(
      new NextRequest(`http://te.test/api/stages/${stageId}/${row}`),
    );
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  }

  it('answers a learner grant without the access cookie with the middleware 401, byte for byte', async () => {
    for (const row of ROWS) {
      const expected = await middleware401(row);
      expect(expected.status, row).toBe(401);
      expect(JSON.parse(expected.body), row).toEqual({
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'Access code required',
      });

      const response = await call(row, learnerCookie());
      expect(response.status, row).toBe(401);
      expect(response.headers.get('content-type'), row).toBe(expected.type);
      expect(await response.text(), row).toBe(expected.body);
    }
  });

  it('refuses the learner before the version check, as the middleware did', async () => {
    // A learner grant whose version no longer names this Stage: still the 401.
    const stale = grantCookie(token({ purpose: 'learner', version: 'tpv-gone' }));
    for (const row of ROWS) {
      expect((await call(row, stale)).status, row).toBe(401);
    }
    // The same stale grant as a preview grant keeps the handler's 404.
    const stalePreview = grantCookie(token({ purpose: 'preview', version: 'tpv-gone' }));
    for (const row of ROWS) {
      expect((await call(row, stalePreview)).status, row).toBe(404);
    }
  });

  it('judges the grant resolved for this Stage; extra cookie entries do not bypass it', async () => {
    const cookies = [
      // An unsigned entry and an edit grant for another Stage, then the learner's.
      grantCookie('forged.token', token({ purpose: 'learner' })),
      grantCookie(
        token({ capability: 'write', purpose: 'edit', stage: 'stage-other' }),
        token({ purpose: 'learner' }),
      ),
    ];
    for (const row of ROWS) {
      for (const cookie of cookies) {
        expect((await call(row, cookie)).status, row).toBe(401);
      }
    }
  });

  it('leaves edit, preview and legacy grants unchanged (200)', async () => {
    const grants = {
      edit: grantCookie(token({ capability: 'write', purpose: 'edit' })),
      'edit read': grantCookie(token({ capability: 'read', purpose: 'edit' })),
      preview: grantCookie(token({ capability: 'read', purpose: 'preview' })),
      'legacy (no purpose)': grantCookie(token({ capability: 'read' })),
    };
    for (const row of ROWS) {
      for (const [label, cookie] of Object.entries(grants)) {
        expect((await call(row, cookie)).status, `${row} ${label}`).toBe(200);
      }
    }
    const skills = await call('teaching-skills', grants.preview);
    await expect(skills.json()).resolves.toEqual({ governed: false });
    const gate = await call('scene-regeneration', grants.edit);
    await expect(gate.json()).resolves.toMatchObject({ capability: 'write', editable: true });
    const revisions = await call('scene-revisions', grants.preview);
    await expect(revisions.json()).resolves.toMatchObject({ scenes: [{ id: 'scene-1' }] });
  });

  it('leaves a learner grant with a valid access cookie unchanged (200)', async () => {
    for (const row of ROWS) {
      const response = await call(row, `${accessCookie()}; ${learnerCookie()}`);
      expect(response.status, row).toBe(200);
    }
    // The gate still reports the learner grant as read-only.
    const gate = await call('scene-regeneration', `${accessCookie()}; ${learnerCookie()}`);
    await expect(gate.json()).resolves.toMatchObject({ capability: 'read' });
  });

  it('still refuses a learner grant next to a forged or stale access cookie', async () => {
    const forged = `openmaic_access=v2.${Date.now()}.${'0'.repeat(64)}`;
    for (const row of ROWS) {
      expect((await call(row, `${forged}; ${learnerCookie()}`)).status, row).toBe(401);
    }
  });

  it('leaves a learner grant unchanged without ACCESS_CODE (200)', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    for (const row of ROWS) {
      expect((await call(row, learnerCookie())).status, row).toBe(200);
    }
  });

  it('keeps the other refusals unchanged (404 without a valid grant for this Stage)', async () => {
    const cookies = [
      undefined,
      grantCookie('forged.token'),
      grantCookie(token({ purpose: 'learner', stage: 'stage-other' })),
    ];
    for (const row of ROWS) {
      for (const cookie of cookies) {
        expect((await call(row, cookie)).status, `${row} ${cookie}`).toBe(404);
      }
    }
  });

  it('does not touch row 2: a learner PUT on teaching-skills keeps its 403', async () => {
    const { PUT } = await import('@/app/api/stages/[id]/teaching-skills/route');
    const response = await PUT(
      new NextRequest(`http://te.test/api/stages/${stageId}/teaching-skills`, {
        method: 'PUT',
        headers: { cookie: learnerCookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ assignments: [] }),
      }),
      { params: Promise.resolve({ id: stageId }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'READ_ONLY_GRANT' } });
  });
});
