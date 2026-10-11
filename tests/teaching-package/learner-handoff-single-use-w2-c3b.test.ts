/**
 * W2-C3b · ET-16 (a): the learner Stage handoff is single-use at the redeem
 * route (`GET /api/teaching-packages/editor-handoff`). The second redeem of
 * the same learner token, on this instance or another, is `GRANT_INVALID`
 * (401, no cookie) — the refusal the app already treats as "ask Kafuo for a
 * fresh handoff" (`TeachingEngineRefusal.isStaleHandoff`). Edit and preview
 * handoffs (admin browser redirects) are never claimed and redeem as before.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPgHandoffNonceStore,
  handoffNonceDigest,
  resetHandoffNonceMemoryForTests,
  setHandoffNonceStoreForTests,
  type HandoffNonceStore,
} from '@/lib/server/tutor/handoff-nonce-store';
import {
  mintEditorHandoffToken,
  verifyEditorHandoffToken,
  type EditorGrantCapability,
  type EditorHandoffPurpose,
} from '@/lib/server/teaching-package/editor-grant';

const mocks = vi.hoisted(() => ({ getVersion: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/server/teaching-package/resolve', () => ({
  getTeachingPackageVersion: mocks.getVersion,
  getTeachingPackageVersionByToken: mocks.getVersion,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: vi.fn() } }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

const SERVICE_KEY = 'learner-handoff-single-use-w2-c3b-key';
const LEARNER_REF = 'a1B2c3D4e5F6g7H8i9J0kLmN';
const TENANT = 'tenant-c3b';
const VERSION_ID = 'tpv-c3b-001';
const STAGE_ID = 'stage-c3b';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://learner-handoff-single-use-w2-c3b');
  vi.clearAllMocks();
  resetHandoffNonceMemoryForTests();
});

afterEach(() => {
  setHandoffNonceStoreForTests(undefined);
});

/** The real Postgres store over PGlite, counting claims. */
async function pgStore(): Promise<{ store: HandoffNonceStore; db: PGlite; claims: () => number }> {
  const db = new PGlite();
  await db.waitReady;
  const inner = createPgHandoffNonceStore(db as never);
  let claims = 0;
  return {
    db,
    claims: () => claims,
    store: {
      async claim(input) {
        claims += 1;
        return inner.claim(input);
      },
    },
  };
}

function version(status: string) {
  return { id: VERSION_ID, tenantId: TENANT, status, currentStageId: STAGE_ID };
}

function mint(
  purpose: EditorHandoffPurpose | undefined,
  capability: EditorGrantCapability = 'read',
) {
  return mintEditorHandoffToken({
    tenantId: TENANT,
    versionId: VERSION_ID,
    stageId: STAGE_ID,
    capability,
    ...(purpose ? { purpose } : {}),
    ...(purpose === 'learner' ? { learnerRef: LEARNER_REF } : {}),
  }).token;
}

async function redeem(token: string, headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/teaching-packages/editor-handoff/route');
  return GET(
    new NextRequest(
      `http://te.test/api/teaching-packages/editor-handoff?token=${encodeURIComponent(token)}`,
      { headers },
    ),
  );
}

describe('learner handoff redeem is single-use (ET-16 a)', () => {
  it('redeems once; the replay is GRANT_INVALID 401 with no cookie', async () => {
    const { store, db, claims } = await pgStore();
    setHandoffNonceStoreForTests(store);
    mocks.getVersion.mockResolvedValue(version('approved'));
    const token = mint('learner');

    const first = await redeem(token);
    expect(first.status).toBe(302);
    expect(first.headers.getSetCookie().length).toBeGreaterThan(0);

    const replay = await redeem(token);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'GRANT_INVALID' } });
    expect(replay.headers.getSetCookie()).toHaveLength(0);
    expect(replay.headers.get('location')).toBeNull();

    // The replay is refused from this instance's memory before any version read.
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
    expect(claims()).toBe(1);
    const rows = await db.query<{ nonce_digest: string; kind: string }>(
      'SELECT nonce_digest, kind FROM tutor_handoff_redemptions',
    );
    const nonce = verifyEditorHandoffToken(token)!.nonce;
    expect(rows.rows).toEqual([
      { nonce_digest: handoffNonceDigest('learner-handoff', nonce), kind: 'learner-handoff' },
    ]);
    await db.close();
  });

  it('answers a native (JSON) client the same 401 the app maps to a fresh handoff', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    mocks.getVersion.mockResolvedValue(version('approved'));
    const token = mint('learner');
    const json = { accept: 'application/json' };

    const first = await redeem(token, json);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ stageId: STAGE_ID, capability: 'read' });

    const replay = await redeem(token, json);
    expect(replay.status).toBe(401);
    expect((await replay.json()).error.code).toBe('GRANT_INVALID');
    expect(replay.headers.getSetCookie()).toHaveLength(0);
    await db.close();
  });

  it('refuses a token another instance already redeemed', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    mocks.getVersion.mockResolvedValue(version('approved'));
    const token = mint('learner');
    const payload = verifyEditorHandoffToken(token)!;
    // "The other instance" claimed it; this instance's memory has never seen it.
    expect(
      await store.claim({
        kind: 'learner-handoff',
        nonce: payload.nonce,
        tenantId: payload.tenantId,
        expiresAtMs: payload.exp,
        nowMs: Date.now(),
      }),
    ).toBe(true);

    const response = await redeem(token);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('GRANT_INVALID');
    expect(mocks.getVersion).not.toHaveBeenCalled();
    await db.close();
  });

  it('fails closed while the store is down, then redeems once when it is back', async () => {
    setHandoffNonceStoreForTests({
      claim: async () => {
        throw new Error('db down');
      },
    });
    mocks.getVersion.mockResolvedValue(version('approved'));
    const token = mint('learner');
    const down = await redeem(token);
    expect(down.status).toBe(503);
    expect(down.headers.getSetCookie()).toHaveLength(0);
    expect((await down.json()).error.code).toBe('HANDOFF_STORE_UNAVAILABLE');
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('tutor.handoff_nonce_store_unavailable'),
    );

    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    expect((await redeem(token)).status).toBe(302);
    expect((await redeem(token)).status).toBe(401);
    await db.close();
  });

  it('a fresh learner handoff for the same session still redeems', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    mocks.getVersion.mockResolvedValue(version('approved'));
    const token = mint('learner');
    expect((await redeem(token)).status).toBe(302);
    expect((await redeem(token)).status).toBe(401);
    expect((await redeem(mint('learner'))).status).toBe(302);
    await db.close();
  });

  it('refuses a bad token as before, without claiming anything', async () => {
    const claim = vi.fn(async () => true);
    setHandoffNonceStoreForTests({ claim });
    const response = await redeem('garbage.token');
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_REQUEST');
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('edit and preview handoffs are unchanged (never claimed)', () => {
  it.each([
    ['edit', 'write', 'draft'],
    ['preview', 'read', 'draft'],
  ] as const)('a %s handoff redeems twice', async (purpose, capability, status) => {
    const { store, db, claims } = await pgStore();
    setHandoffNonceStoreForTests(store);
    mocks.getVersion.mockResolvedValue(version(status));
    const token = mint(purpose, capability);
    const first = await redeem(token);
    const second = await redeem(token);
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(second.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(claims()).toBe(0);
    await db.close();
  });

  it('a pre-existing token without a purpose redeems twice', async () => {
    const { store, db, claims } = await pgStore();
    setHandoffNonceStoreForTests(store);
    mocks.getVersion.mockResolvedValue(version('draft'));
    const token = mint(undefined, 'read');
    expect((await redeem(token)).status).toBe(302);
    expect((await redeem(token)).status).toBe(302);
    expect(claims()).toBe(0);
    await db.close();
  });
});
