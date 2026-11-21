/**
 * The access-code status route's `editorGrantCovered` (owner, 21 Nov 2026).
 *
 * A browser that redeemed an editor handoff holds the Stage-scoped grant cookie and no
 * access cookie. Roles phase 1 O1 exempts every editor API that grant needs, but the
 * guard's modal was missed, so the first open of a package asked for the access code.
 * The status route now reports whether a non-learner grant for the asked-about
 * classroom's Stage, owned by the grant's tenant, covers the request — echoing nothing
 * from the grant itself. Setup copied from `editor-grant-tenant-access-routes.test.ts`.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { createAccessToken } from '@/lib/server/access-token';
import { buildEditorGrantPayload } from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const CODE = 'o1-status-access-code';
const TENANT = 'tenant-test';
const OTHER_TENANT = 'tenant-other';
const HOURS_9_MS = 9 * 60 * 60 * 1000;

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

type Purpose = 'edit' | 'preview' | 'learner';

async function status(stageId: string | null, cookie?: string): Promise<Response> {
  const { GET } = await import('@/app/api/access-code/status/route');
  const url = stageId
    ? `http://te.test/api/access-code/status?stageId=${encodeURIComponent(stageId)}`
    : 'http://te.test/api/access-code/status';
  const request = new NextRequest(url, { headers: cookie ? { cookie } : {} });
  return GET(request);
}

const body = async (response: Response) =>
  (await response.json()) as {
    enabled: boolean;
    authenticated: boolean;
    editorGrantCovered: boolean;
  };

describe('GET /api/access-code/status?stageId=: the editor grant covers its own classroom', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-o1s-${(counter += 1)}`;
  const qp = () => pool as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://o1s-${randomUUID()}`);
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'o1s-grant-key');
    vi.stubEnv('ACCESS_CODE', CODE);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  /** A tenant's draft Stage, exactly as the sibling suite seeds one. */
  async function seedStage(
    options: { tenantId?: string } = {},
  ): Promise<{ stageId: string; versionId: string }> {
    const tenantId = options.tenantId ?? TENANT;
    const stageId = nextId('stage');
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    }).saveDocument(
      makeDocument(stageId, 'O1-status', [makeSlideScene(`${stageId}-s0`, stageId, 1)]),
    );
    const versionId = nextId('tpv');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId, learningItem: { type: 'lesson', id: nextId('li') } },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      currentAttemptId: null,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    return { stageId, versionId };
  }

  function grantToken(
    stageId: string,
    versionId: string,
    options: { purpose?: Purpose; tenantId?: string; now?: number } = {},
  ): string {
    return buildEditorGrantPayload({
      tenantId: options.tenantId ?? TENANT,
      versionId,
      stageId,
      capability: 'write',
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    }).token;
  }

  const grantCookie = (token: string) =>
    `teaching_package_grant=${encodeURIComponent(JSON.stringify([token]))}`;

  it('an edit grant for the asked-about Stage covers, unauthenticated', async () => {
    const { stageId, versionId } = await seedStage();
    const response = await status(stageId, grantCookie(grantToken(stageId, versionId)));
    await expect(body(response)).resolves.toMatchObject({
      enabled: true,
      authenticated: false,
      editorGrantCovered: true,
    });
  });

  it('a preview grant covers the same way', async () => {
    const { stageId, versionId } = await seedStage();
    const response = await status(
      stageId,
      grantCookie(grantToken(stageId, versionId, { purpose: 'preview' })),
    );
    await expect(body(response)).resolves.toMatchObject({ editorGrantCovered: true });
  });

  it.each([
    ['a learner grant for this Stage', { purpose: 'learner' as Purpose }],
    ['an expired grant', { now: Date.now() - HOURS_9_MS }],
  ])('refuses %s', async (_name, options) => {
    const { stageId, versionId } = await seedStage();
    const response = await status(stageId, grantCookie(grantToken(stageId, versionId, options)));
    await expect(body(response)).resolves.toMatchObject({ editorGrantCovered: false });
  });

  it('refuses an altered signature and an edited payload', async () => {
    const { stageId, versionId } = await seedStage();
    const good = grantToken(stageId, versionId);
    const [payload, signature] = good.split('.');
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')),
        tenantId: OTHER_TENANT,
      }),
    ).toString('base64url');

    await expect(
      body(await status(stageId, grantCookie(`${payload}.${flipped}`))),
    ).resolves.toMatchObject({ editorGrantCovered: false });
    await expect(
      body(await status(stageId, grantCookie(`${edited}.${signature}`))),
    ).resolves.toMatchObject({ editorGrantCovered: false });
  });

  it('refuses a grant for another Stage, and a grant whose tenant does not own the Stage', async () => {
    const mine = await seedStage();
    const other = await seedStage();
    await expect(
      body(await status(mine.stageId, grantCookie(grantToken(other.stageId, other.versionId)))),
    ).resolves.toMatchObject({ editorGrantCovered: false });

    const foreign = await seedStage({ tenantId: OTHER_TENANT });
    await expect(
      body(
        await status(foreign.stageId, grantCookie(grantToken(foreign.stageId, foreign.versionId))),
      ),
    ).resolves.toMatchObject({ editorGrantCovered: false });
  });

  it.each([null, 'a.b', '..', 'a%2Fb'])('refuses stageId %p', async (stageId) => {
    const { stageId: real, versionId } = await seedStage();
    const cookie = grantCookie(grantToken(real, versionId));
    await expect(body(await status(stageId, cookie))).resolves.toMatchObject({
      editorGrantCovered: false,
    });
  });

  it('a valid access cookie stays authenticated and needs no grant', async () => {
    const { stageId, versionId } = await seedStage();
    const response = await status(
      stageId,
      `openmaic_access=${createAccessToken(CODE)}; ${grantCookie(grantToken(stageId, versionId))}`,
    );
    await expect(body(response)).resolves.toMatchObject({
      enabled: true,
      authenticated: true,
      editorGrantCovered: false,
    });
  });

  it('fails closed with no DATABASE_URL', async () => {
    const { stageId, versionId } = await seedStage();
    vi.stubEnv('DATABASE_URL', '');
    const response = await status(stageId, grantCookie(grantToken(stageId, versionId)));
    await expect(body(response)).resolves.toMatchObject({ editorGrantCovered: false });
  });

  it('without ACCESS_CODE nothing changes', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    const { stageId, versionId } = await seedStage();
    const response = await status(stageId, grantCookie(grantToken(stageId, versionId)));
    await expect(body(response)).resolves.toMatchObject({
      enabled: false,
      authenticated: false,
      editorGrantCovered: false,
    });
  });

  it('echoes nothing from the grant', async () => {
    const { stageId, versionId } = await seedStage();
    const response = await status(stageId, grantCookie(grantToken(stageId, versionId)));
    const raw = await response.json();
    const flat = JSON.stringify(raw);
    for (const secret of [TENANT, versionId, 'capability', 'exp', 'purpose']) {
      expect(flat).not.toContain(secret === TENANT ? `"${TENANT}"` : `"${secret}"`);
    }
  });
});
