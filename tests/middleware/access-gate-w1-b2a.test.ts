/**
 * Wave 1 · B2a — the `ACCESS_CODE` gate in production and the access cookie's
 * server-side age (readiness review ET-31).
 *
 * - Production without `ACCESS_CODE`: the middleware fails CLOSED (503) for
 *   every `/api` route that is not on the allow-list; allow-listed routes and
 *   pages pass as today. `TE_ALLOW_OPEN_ACCESS=1` (local production-mode runs)
 *   and development keep today's open behaviour.
 * - The `openmaic_access` cookie is `v2.<issuedAtMs>.<hmac>` and is refused
 *   after 12 hours by BOTH verifiers (Edge middleware and Node
 *   `verifyAccessToken`). Pre-v2 cookies are refused: admins type the code once.
 */
import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAccessToken, verifyAccessToken } from '@/lib/server/access-token';
import {
  ACCESS_TOKEN_FUTURE_SKEW_MS,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
} from '@/lib/server/startup-config';
import { middleware } from '@/middleware';

const { cookieSet } = vi.hoisted(() => ({ cookieSet: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: cookieSet }) }));

const CODE = 'test-access-code';
const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = ACCESS_TOKEN_MAX_AGE_SECONDS * 1000;

function request(method: string, path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, 'http://te.test'), {
    method,
    headers: cookie ? { cookie } : {},
  });
}

/** `passed`, or the refusal status. */
async function outcome(method: string, path: string, cookie?: string): Promise<'passed' | number> {
  const response = await middleware(request(method, path, cookie));
  if (response.headers.get('x-middleware-next') === '1') return 'passed';
  return response.status;
}

/** A genuine pre-v2 cookie: `<ms>.<hmac(code, ms)>`, exactly as the old code minted it. */
function legacyToken(code: string, issuedAtMs: number): string {
  const timestamp = issuedAtMs.toString();
  return `${timestamp}.${createHmac('sha256', code).update(timestamp).digest('hex')}`;
}

/** Allow-listed: Backend (service key) and mobile (tokens, grants) routes. */
const ALLOWED: ReadonlyArray<[string, string, string?]> = [
  ['GET', '/api/health'],
  ['GET', '/api/access-code/status'],
  ['POST', '/api/access-code/verify'],
  ['POST', '/api/teaching-packages/generate'],
  ['POST', '/api/teaching-model/help-turns'],
  ['POST', '/api/tutor/handoff'],
  ['GET', '/api/tutor/handoff/redeem?token=t'],
  ['POST', '/api/tutor/conversations/c1/messages'],
  ['POST', '/api/tutor/help/turns'],
  ['GET', '/api/classroom-media/stage-abc/media/figure.png?exp=1&sig=s'],
  ['GET', '/api/persistence/documents/stage-abc', 'teaching_package_grant=opaque'],
];

/** Gated: the provider-spending and internal routes. */
const GATED: ReadonlyArray<[string, string]> = [
  ['POST', '/api/chat'],
  ['POST', '/api/generate-classroom'],
  ['POST', '/api/generate/tts'],
  ['GET', '/api/server-providers'],
  ['POST', '/api/web-search'],
  ['GET', '/api/proxy-media?url=https://example.com'],
  ['GET', '/api/classroom-media/stage-abc/media/figure.png'],
  ['GET', '/api/tutorial'],
];

const PAGES = ['/', '/classroom/stage-abc'];

describe('ACCESS_CODE gate in production (ET-31)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('production with an empty ACCESS_CODE', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ACCESS_CODE', '');
    });

    it('answers 503 to every gated /api route', async () => {
      for (const [method, path] of GATED) {
        expect(await outcome(method, path), `${method} ${path}`).toBe(503);
      }
      const response = await middleware(request('POST', '/api/chat'));
      expect(await response.json()).toMatchObject({
        success: false,
        error: 'Access gate not configured',
      });
    });

    it('answers 503 even to a gated route that presents a valid-looking cookie', async () => {
      const cookie = `openmaic_access=${createAccessToken(CODE)}`;
      expect(await outcome('POST', '/api/chat', cookie)).toBe(503);
    });

    it('lets the allow-listed Backend and mobile routes through, as today', async () => {
      for (const [method, path, cookie] of ALLOWED) {
        expect(await outcome(method, path, cookie), `${method} ${path}`).toBe('passed');
      }
    });

    it('lets pages through', async () => {
      for (const path of PAGES) expect(await outcome('GET', path), path).toBe('passed');
    });

    it('stays open with the explicit opt-out TE_ALLOW_OPEN_ACCESS=1 (local production-mode run)', async () => {
      vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '1');
      for (const [method, path] of GATED) {
        expect(await outcome(method, path), `${method} ${path}`).toBe('passed');
      }
    });

    it('also fails closed when ACCESS_CODE is absent rather than empty', async () => {
      delete process.env.ACCESS_CODE;
      expect(await outcome('POST', '/api/chat')).toBe(503);
    });
  });

  it('production with ACCESS_CODE set behaves as before (401, cookie passes)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ACCESS_CODE', CODE);
    for (const [method, path] of GATED) {
      expect(await outcome(method, path), `${method} ${path}`).toBe(401);
      expect(
        await outcome(method, path, `openmaic_access=${createAccessToken(CODE)}`),
        `${method} ${path} with cookie`,
      ).toBe('passed');
    }
    for (const [method, path, cookie] of ALLOWED) {
      expect(await outcome(method, path, cookie), `${method} ${path}`).toBe('passed');
    }
  });

  it('development with an empty ACCESS_CODE is unchanged: every request passes', async () => {
    for (const env of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('ACCESS_CODE', '');
      for (const [method, path, cookie] of [...GATED, ...ALLOWED]) {
        expect(await outcome(method, path, cookie), `${env} ${method} ${path}`).toBe('passed');
      }
    }
  });
});

describe('access cookie age (12 hours, server-side)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ACCESS_CODE', CODE);
    vi.stubEnv('NODE_ENV', 'production');
    cookieSet.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const chat = (token: string) => outcome('POST', '/api/chat', `openmaic_access=${token}`);

  it('mints v2 tokens with a signed issued-at', () => {
    const now = Date.UTC(2026, 9, 9, 12);
    const token = createAccessToken(CODE, now);
    expect(token).toMatch(new RegExp(`^v2\\.${now}\\.[0-9a-f]{64}$`));
  });

  it('accepts a fresh cookie (Node verifier and middleware)', async () => {
    const now = Date.now();
    for (const age of [0, HOUR_MS, 11 * HOUR_MS]) {
      const token = createAccessToken(CODE, now - age);
      expect(verifyAccessToken(token, CODE, now), `age ${age}`).toBe(true);
      expect(await chat(token), `age ${age}`).toBe('passed');
    }
    // The boundary itself is still valid for the Node verifier.
    expect(verifyAccessToken(createAccessToken(CODE, now - MAX_AGE_MS), CODE, now)).toBe(true);
  });

  it('rejects a cookie older than 12 hours (Node verifier and middleware)', async () => {
    const now = Date.now();
    for (const age of [MAX_AGE_MS + 1, 13 * HOUR_MS, 7 * 24 * HOUR_MS]) {
      const token = createAccessToken(CODE, now - age);
      expect(verifyAccessToken(token, CODE, now), `age ${age}`).toBe(false);
      expect(await chat(token), `age ${age}`).toBe(401);
    }
  });

  it('rejects an issued-at further in the future than the clock skew allows', async () => {
    const now = Date.now();
    expect(
      verifyAccessToken(createAccessToken(CODE, now + ACCESS_TOKEN_FUTURE_SKEW_MS), CODE, now),
    ).toBe(true);
    const future = createAccessToken(CODE, now + ACCESS_TOKEN_FUTURE_SKEW_MS + HOUR_MS);
    expect(verifyAccessToken(future, CODE, now)).toBe(false);
    expect(await chat(future)).toBe(401);
  });

  it('rejects the legacy (pre-v2) cookie format, even when freshly issued', async () => {
    const legacy = legacyToken(CODE, Date.now());
    expect(verifyAccessToken(legacy, CODE)).toBe(false);
    expect(await chat(legacy)).toBe(401);
    // A legacy signature relabelled as v2 does not verify: the version is signed.
    const [timestamp, signature] = legacy.split('.');
    const relabelled = `v2.${timestamp}.${signature}`;
    expect(verifyAccessToken(relabelled, CODE)).toBe(false);
    expect(await chat(relabelled)).toBe(401);
  });

  it('rejects malformed, foreign and tampered cookies', async () => {
    const now = Date.now();
    const good = createAccessToken(CODE, now);
    const [, issuedAt, signature] = good.split('.');
    const bad = [
      'garbage',
      '',
      'v2..' + signature,
      `v2.${issuedAt}`,
      `v2.${issuedAt}.${signature}.extra`,
      `v1.${issuedAt}.${signature}`,
      `v2.${Number(issuedAt) + 1}.${signature}`,
      `v2.${issuedAt}.${'0'.repeat(64)}`,
      `v2.${issuedAt}.${signature.toUpperCase()}`,
      `v2.-${issuedAt}.${signature}`,
      `v2.${issuedAt}e0.${signature}`,
      createAccessToken('another-code', now),
    ];
    for (const token of bad) {
      expect(verifyAccessToken(token, CODE, now), token).toBe(false);
      if (token) expect(await chat(token), token).toBe(401);
    }
  });

  it('sets the cookie with the same 12-hour maxAge from the verify route', async () => {
    const { POST } = await import('@/app/api/access-code/verify/route');
    const response = await POST(
      new Request('http://te.test/api/access-code/verify', {
        method: 'POST',
        body: JSON.stringify({ code: CODE }),
      }),
    );
    expect(response.status).toBe(200);
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, token, options] = cookieSet.mock.calls[0];
    expect(name).toBe('openmaic_access');
    expect(options).toMatchObject({ maxAge: 12 * 60 * 60, httpOnly: true, secure: true });
    expect(verifyAccessToken(token, CODE)).toBe(true);
    expect(await chat(token)).toBe('passed');
  });
});
