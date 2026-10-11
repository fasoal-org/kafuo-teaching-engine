import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimHandoffNonce,
  createPgHandoffNonceStore,
  handoffNonceDigest,
  resetHandoffNonceMemoryForTests,
  setHandoffNonceStoreForTests,
  type HandoffNonceStore,
} from '@/lib/server/tutor/handoff-nonce-store';
import {
  mintStudentHandoff,
  redeemStudentHandoffOnce,
  verifyStudentGrant,
} from '@/lib/server/tutor/student-grant';

/**
 * W2-C3 · ET-16 (a)/(b): a student handoff is single-use, durably (Postgres,
 * `tutor_handoff_redemptions`, atomic `ON CONFLICT DO NOTHING`), failing closed
 * (503 HANDOFF_STORE_UNAVAILABLE, G2) when the store is down; the redeem route takes
 * the token in a POST body and keeps the deprecated `GET ?token=` working.
 */

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

const SERVICE_KEY = 'handoff-nonce-w2-c3-svc-key';
const STUDENT_REF = 'abcdefghijklmnopqrstuvwx';

function handoff(now = Date.now()) {
  return mintStudentHandoff({
    tenantId: '1',
    studentRef: STUDENT_REF,
    academic: {
      curriculumId: '27',
      curriculumName: 'National',
      curriculumVersionLabel: '2026',
      gradeLabel: 'Grade 9',
    },
    allowedSubjects: [
      {
        code: 'MATH',
        offeringId: '10',
        nameAr: 'الرياضيات',
        nameEn: 'Math',
        academicLanguage: 'ar',
      },
    ],
    entitlements: { freeChat: true, help: true },
    now,
  }).token;
}

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

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://handoff-nonce-w2-c3-test');
  resetHandoffNonceMemoryForTests();
  mocks.warn.mockReset();
});

afterEach(() => {
  setHandoffNonceStoreForTests(undefined);
});

describe('the Postgres nonce store', () => {
  it('claims a nonce exactly once and keeps only its digest', async () => {
    const { store, db } = await pgStore();
    const input = {
      kind: 'student-handoff' as const,
      nonce: 'n-1',
      tenantId: '1',
      expiresAtMs: 2_000_000,
      nowMs: 1_000_000,
    };
    expect(await store.claim(input)).toBe(true);
    expect(await store.claim(input)).toBe(false);
    expect(await store.claim({ ...input, kind: 'learner-handoff' })).toBe(true);
    const rows = await db.query<{ nonce_digest: string; expires_at: number }>(
      'SELECT nonce_digest, expires_at FROM tutor_handoff_redemptions ORDER BY nonce_digest',
    );
    expect(rows.rows.map((r) => r.nonce_digest).sort()).toEqual(
      [
        handoffNonceDigest('student-handoff', 'n-1'),
        handoffNonceDigest('learner-handoff', 'n-1'),
      ].sort(),
    );
    expect(rows.rows.every((r) => !r.nonce_digest.includes('n-1'))).toBe(true);
    await db.close();
  });

  it('lets exactly one of many concurrent claims win', async () => {
    const { store, db } = await pgStore();
    const input = {
      kind: 'student-handoff' as const,
      nonce: 'race',
      tenantId: '1',
      expiresAtMs: 2_000_000,
      nowMs: 1_000_000,
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await db.close();
  });
});

describe('claimHandoffNonce', () => {
  it('answers a same-instance replay from memory without asking the store', async () => {
    const { store, db, claims } = await pgStore();
    setHandoffNonceStoreForTests(store);
    const input = {
      kind: 'student-handoff' as const,
      nonce: 'n-2',
      tenantId: '1',
      expiresAtMs: Date.now() + 60_000,
      nowMs: Date.now(),
    };
    expect(await claimHandoffNonce(input)).toBe(true);
    expect(await claimHandoffNonce(input)).toBe(false);
    expect(claims()).toBe(1);
    await db.close();
  });

  it('refuses a nonce another instance already redeemed', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    const input = {
      kind: 'student-handoff' as const,
      nonce: 'n-3',
      tenantId: '1',
      expiresAtMs: Date.now() + 60_000,
      nowMs: Date.now(),
    };
    await store.claim(input); // "the other instance"
    expect(await claimHandoffNonce(input)).toBe(false);
    await db.close();
  });

  it('fails closed when the store is down: 503 HANDOFF_STORE_UNAVAILABLE, nothing remembered (G2)', async () => {
    let down = true;
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests({
      claim: async (input) => {
        if (down) throw new Error('db down');
        return store.claim(input);
      },
    });
    const input = {
      kind: 'student-handoff' as const,
      nonce: 'n-4',
      tenantId: '1',
      expiresAtMs: Date.now() + 60_000,
      nowMs: Date.now(),
    };
    await expect(claimHandoffNonce(input)).rejects.toMatchObject({
      code: 'HANDOFF_STORE_UNAVAILABLE',
      status: 503,
      details: { retryAfterS: 5 },
    });
    // A second outage answer is the same: memory never stands in for the store.
    await expect(claimHandoffNonce(input)).rejects.toMatchObject({
      code: 'HANDOFF_STORE_UNAVAILABLE',
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('tutor.handoff_nonce_store_unavailable'),
    );
    // Once the store is back the token redeems exactly once.
    down = false;
    expect(await claimHandoffNonce(input)).toBe(true);
    expect(await claimHandoffNonce(input)).toBe(false);
    await db.close();
  });

  it('the redeem route answers the outage as a retryable 503 (no grant minted)', async () => {
    setHandoffNonceStoreForTests({
      claim: async () => {
        throw new Error('db down');
      },
    });
    const { POST } = await import('@/app/api/tutor/handoff/redeem/route');
    const response = await POST(
      new NextRequest('http://localhost/api/tutor/handoff/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: handoff() }),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'HANDOFF_STORE_UNAVAILABLE', retryable: true },
    });
  });

  it('creates its table at boot with the other persistence schemas', async () => {
    const db = new PGlite();
    await db.waitReady;
    const { ensureHandoffNonceSchema } = await import('@/lib/server/tutor/handoff-nonce-store');
    await ensureHandoffNonceSchema(db as never);
    await ensureHandoffNonceSchema(db as never); // idempotent
    const rows = await db.query<{ name: string | null }>(
      "SELECT to_regclass('tutor_handoff_redemptions')::text AS name",
    );
    expect(rows.rows[0]?.name).toBe('tutor_handoff_redemptions');
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/persistence/server-provider.ts', 'utf8'),
    );
    expect(source).toContain('await ensureHandoffNonceSchema(queryable);');
    await db.close();
  });
});

describe('redeemStudentHandoffOnce', () => {
  it('mints one grant per handoff; the replay is GRANT_INVALID', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    const token = handoff();
    const first = await redeemStudentHandoffOnce(token);
    expect(verifyStudentGrant(`Bearer ${first.grant}`).studentRef).toBe(STUDENT_REF);
    await expect(redeemStudentHandoffOnce(token)).rejects.toMatchObject({
      code: 'GRANT_INVALID',
      status: 401,
    });
    await db.close();
  });

  it('refuses a bad or expired token before touching the store', async () => {
    const claim = vi.fn(async () => true);
    setHandoffNonceStoreForTests({ claim });
    await expect(redeemStudentHandoffOnce('garbage.token')).rejects.toMatchObject({
      code: 'GRANT_INVALID',
    });
    const stale = handoff(Date.now() - 10 * 60 * 1000);
    await expect(redeemStudentHandoffOnce(stale)).rejects.toMatchObject({ code: 'GRANT_EXPIRED' });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('POST /api/tutor/handoff/redeem (and the deprecated GET)', () => {
  async function route() {
    return import('@/app/api/tutor/handoff/redeem/route');
  }

  function post(body: unknown) {
    return new NextRequest('http://localhost/api/tutor/handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('redeems the token from the body, once', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    const { POST } = await route();
    const token = handoff();
    const first = await POST(post({ token }));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = (await first.json()) as { grant: string; expiresAt: number };
    expect(body.grant.startsWith('tsg.')).toBe(true);
    const replay = await POST(post({ token }));
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: 'GRANT_INVALID', retryable: false },
    });
    await db.close();
  });

  it('refuses a missing or malformed body like a bad token', async () => {
    const { POST } = await route();
    expect((await POST(post('not json'))).status).toBe(401);
    expect((await POST(post({ token: 42 }))).status).toBe(401);
    expect((await POST(post({}))).status).toBe(401);
  });

  it('keeps GET ?token= working for the current app build, logged as deprecated', async () => {
    const { store, db } = await pgStore();
    setHandoffNonceStoreForTests(store);
    const { GET, POST } = await route();
    const token = handoff();
    const response = await GET(
      new NextRequest(
        `http://localhost/api/tutor/handoff/redeem?token=${encodeURIComponent(token)}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('tutor.handoff_redeem_get_deprecated'),
    );
    expect(mocks.warn.mock.calls.flat().join(' ')).not.toContain(token);
    // The same token cannot be redeemed again, by either method.
    expect((await POST(post({ token }))).status).toBe(401);
    await db.close();
  });

  it('answers 404 when the Teaching Package API is off', async () => {
    const token = handoff();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    const { POST } = await route();
    expect((await POST(post({ token }))).status).toBe(404);
  });
});

describe('learner handoffs (claimLearnerHandoffOnce)', () => {
  it('claims a learner handoff once; edit and preview handoffs are never claimed', async () => {
    const { store, db, claims } = await pgStore();
    setHandoffNonceStoreForTests(store);
    const { claimLearnerHandoffOnce, mintEditorHandoffToken, verifyEditorHandoffToken } =
      await import('@/lib/server/teaching-package/editor-grant');
    const mint = (purpose: 'learner' | 'edit' | 'preview') =>
      verifyEditorHandoffToken(
        mintEditorHandoffToken({
          tenantId: '1',
          versionId: 'v-1',
          stageId: 's-1',
          capability: purpose === 'edit' ? 'write' : 'read',
          purpose,
        }).token,
      )!;
    const learner = mint('learner');
    expect(await claimLearnerHandoffOnce(learner)).toBe(true);
    expect(await claimLearnerHandoffOnce(learner)).toBe(false);
    const edit = mint('edit');
    expect(await claimLearnerHandoffOnce(edit)).toBe(true);
    expect(await claimLearnerHandoffOnce(edit)).toBe(true);
    expect(await claimLearnerHandoffOnce(mint('preview'))).toBe(true);
    expect(claims()).toBe(1);
    await db.close();
  });
});
