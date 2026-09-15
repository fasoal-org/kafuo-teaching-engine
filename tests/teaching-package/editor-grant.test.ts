import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const routeMocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/resolve', () => ({
  getTeachingPackageVersion: routeMocks.getVersion,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: vi.fn() } }),
}));

import {
  buildEditorGrantPayload,
  deriveDocumentStageId,
  deriveRuntimeScope,
  editorGrantCookieHeaders,
  editorGrantReleaseCookieHeaders,
  grantCookieValueForRedeem,
  mintEditorHandoffToken,
  readEditorGrant,
  readEditorGrants,
  verifyEditorHandoffToken,
  type RuntimeScopeStore,
} from '@/lib/server/teaching-package/editor-grant';

const SERVICE_KEY = 'editor-grant-test-key';

function grantHeaders(
  ...entries: Array<{ stageId: string; capability: 'read' | 'write' }>
): Headers {
  const tokens = entries.map((entry) => {
    const { token } = buildEditorGrantPayload({
      versionId: `tpv-${entry.stageId}`,
      stageId: entry.stageId,
      capability: entry.capability,
    });
    return token;
  });
  return new Headers({
    cookie: `teaching_package_grant=${encodeURIComponent(JSON.stringify(tokens))}`,
  });
}

const memoryStore = (
  sessions: Record<string, { stageId: string; learnerKey: string }> = {},
): RuntimeScopeStore => ({
  async getSession(sessionId) {
    return sessions[sessionId];
  },
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://editor-grant-test');
  vi.clearAllMocks();
});

describe('editor handoff token', () => {
  it('round-trips a minted token', () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'write',
    });
    const payload = verifyEditorHandoffToken(token)!;
    expect(payload).toMatchObject({
      kind: 'handoff',
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'write',
    });
  });

  it('rejects an expired token', () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'read',
      now: Date.now() - 10 * 60 * 1000,
    });
    expect(verifyEditorHandoffToken(token)).toBeNull();
  });

  it('rejects a tampered token', () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'write',
    });
    const tampered = `${token.slice(0, -2)}ff`;
    expect(verifyEditorHandoffToken(tampered)).toBeNull();
    expect(verifyEditorHandoffToken('not-a-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'write',
    });
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'a-different-key');
    expect(verifyEditorHandoffToken(token)).toBeNull();
  });
});

describe('editor grant cookie', () => {
  it('reads the grant for the matching stage only', () => {
    const headers = grantHeaders({ stageId: 'stage-x', capability: 'write' });
    expect(readEditorGrant(headers, 'stage-x')).toMatchObject({
      stageId: 'stage-x',
      capability: 'write',
      learnerKey: expect.stringMatching(/^tp:/),
    });
    expect(readEditorGrant(headers, 'stage-y')).toBeNull();
  });

  it('ignores garbage and expired entries', () => {
    vi.useFakeTimers();
    try {
      const { token } = buildEditorGrantPayload({
        versionId: 'tpv-1',
        stageId: 'stage-x',
        capability: 'read',
      });
      vi.advanceTimersByTime(9 * 60 * 60 * 1000); // past the default 8h session
      const headers = new Headers({
        cookie: `teaching_package_grant=${encodeURIComponent(JSON.stringify([token, 'garbage']))}`,
      });
      expect(readEditorGrants(headers)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the entry for the same stage and caps the cookie at five entries', () => {
    let cookieHeaders = new Headers();
    for (let index = 0; index < 6; index += 1) {
      const stageId = `stage-${index % 5}`;
      const { token } = buildEditorGrantPayload({
        versionId: `tpv-${index}`,
        stageId,
        capability: 'write',
      });
      const value = grantCookieValueForRedeem(cookieHeaders, token, stageId);
      cookieHeaders = new Headers({
        cookie: `teaching_package_grant=${encodeURIComponent(value)}`,
      });
    }
    const grants = readEditorGrants(cookieHeaders);
    expect(grants.length).toBeLessThanOrEqual(5);
    // The last write replaced the entry for stage-0, not appended a sixth.
    expect(new Set(grants.map((grant) => grant.stageId)).size).toBe(grants.length);
  });

  it('writes HttpOnly/Path=/api attributes for the grant and a readable Path=/ companion', () => {
    const { payload, token } = buildEditorGrantPayload({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'read',
    });
    const headers = editorGrantCookieHeaders(JSON.stringify([token]), payload.learnerKey);
    expect(headers[0]).toContain('teaching_package_grant=');
    expect(headers[0]).toContain('Path=/api');
    expect(headers[0]).toContain('HttpOnly');
    expect(headers[1]).toContain(
      `teaching_package_learner_key=${encodeURIComponent(payload.learnerKey)}`,
    );
    expect(headers[1]).toContain('Path=/');
    expect(headers[1]).not.toContain('HttpOnly');

    for (const cookie of editorGrantReleaseCookieHeaders()) {
      expect(cookie).toContain('Max-Age=0');
    }
  });
});

describe('deriveRuntimeScope', () => {
  const store = memoryStore({
    'session-x': { stageId: 'stage-x', learnerKey: 'tp:alpha' },
    'session-y': { stageId: 'stage-y', learnerKey: 'tp:beta' },
  });

  it('derives POST /runtime/sessions from the body', async () => {
    await expect(
      deriveRuntimeScope(
        'POST',
        '/runtime/sessions',
        { stageId: 'stage-x', learnerKey: 'tp:a' },
        store,
      ),
    ).resolves.toEqual({ stageId: 'stage-x', learnerKey: 'tp:a', known: true });
  });

  it('derives session-scoped routes from the stored session', async () => {
    await expect(
      deriveRuntimeScope('GET', '/runtime/sessions/session-x', null, store),
    ).resolves.toEqual({ stageId: 'stage-x', learnerKey: 'tp:alpha', known: false });
    await expect(
      deriveRuntimeScope('POST', '/runtime/sessions/session-x/records', null, store),
    ).resolves.toMatchObject({ stageId: 'stage-x', learnerKey: 'tp:alpha' });
  });

  it('answers null for an unknown session', async () => {
    await expect(
      deriveRuntimeScope('GET', '/runtime/sessions/session-absent', null, store),
    ).resolves.toBeNull();
  });

  it('derives stage-scoped learner routes from the path', async () => {
    await expect(
      deriveRuntimeScope('GET', '/runtime/stages/stage-x/learners/tp:alpha/sessions', null, store),
    ).resolves.toEqual({ stageId: 'stage-x', learnerKey: 'tp:alpha', known: true });
    await expect(
      deriveRuntimeScope('DELETE', '/runtime/stages/stage-x/learners/tp:alpha', null, store),
    ).resolves.toMatchObject({ stageId: 'stage-x' });
  });

  it('answers null for merge and admin routes', async () => {
    await expect(
      deriveRuntimeScope(
        'POST',
        '/runtime/learners/merge',
        { fromLearnerKey: 'a', toLearnerKey: 'b' },
        store,
      ),
    ).resolves.toBeNull();
    await expect(deriveRuntimeScope('DELETE', '/runtime', null, store)).resolves.toBeNull();
    await expect(
      deriveRuntimeScope('DELETE', '/runtime/stages/stage-x', null, store),
    ).resolves.toBeNull();
  });
});

describe('redeem route', () => {
  const version = (status: string, stageId: string) => ({
    id: 'tpv-1',
    status,
    currentStageId: stageId,
  });

  function redeem(token: string) {
    return import('@/app/api/teaching-packages/editor-handoff/route').then(({ GET }) =>
      GET(
        new NextRequest(
          `http://localhost/api/teaching-packages/editor-handoff?token=${encodeURIComponent(token)}`,
        ),
      ),
    );
  }

  it('sets both cookies and redirects to the classroom', async () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'write',
    });
    routeMocks.getVersion.mockResolvedValue(version('draft', 'stage-x'));

    const response = await redeem(token);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://localhost/classroom/stage-x');
    const cookies = response.headers.getSetCookie();
    const grant = cookies.find((cookie) => cookie.startsWith('teaching_package_grant='));
    const learner = cookies.find((cookie) => cookie.startsWith('teaching_package_learner_key='));
    expect(grant).toBeDefined();
    expect(grant).toContain('Path=/api');
    expect(grant).toContain('HttpOnly');
    expect(grant).toContain('SameSite=Lax');
    expect(grant).toContain('Max-Age=');
    expect(learner).toBeDefined();
    expect(learner).toContain('Path=/');
    expect(learner).not.toContain('HttpOnly');
    // The companion cookie equals the grant entry's learner key (tp:<nonce>).
    const learnerValue = decodeURIComponent(learner!.split(';')[0]!.split('=')[1]!);
    expect(learnerValue).toMatch(/^tp:/);
    const grantValue = decodeURIComponent(grant!.split(';')[0]!.split('=').slice(1).join('='));
    const entries = JSON.parse(grantValue) as string[];
    expect(entries).toHaveLength(1);
  });

  it('refuses an edit handoff once the version left draft|rejected', async () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'write',
    });
    routeMocks.getVersion.mockResolvedValue(version('approved', 'stage-x'));
    const response = await redeem(token);
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('refuses a handoff whose stage was replaced by regeneration', async () => {
    const { token } = mintEditorHandoffToken({
      versionId: 'tpv-1',
      stageId: 'stage-old',
      capability: 'read',
    });
    routeMocks.getVersion.mockResolvedValue(version('draft', 'stage-new'));
    const response = await redeem(token);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'STALE_STATE' } });
  });

  it('refuses a garbage token with 400 and no cookie', async () => {
    const response = await redeem('garbage.token');
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('release clears both cookies', async () => {
    const { POST } = await import('@/app/api/teaching-packages/editor-handoff/release/route');
    const response = await POST();
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) expect(cookie).toContain('Max-Age=0');
  });
});

describe('deriveDocumentStageId', () => {
  it('returns the stage for document actions and null otherwise', () => {
    expect(deriveDocumentStageId({ kind: 'read', stageId: 'stage-x' })).toBe('stage-x');
    expect(deriveDocumentStageId({ kind: 'write', stageId: 'stage-x' })).toBe('stage-x');
    expect(deriveDocumentStageId({ kind: 'delete', stageId: 'stage-x' })).toBe('stage-x');
    expect(deriveDocumentStageId({ kind: 'create', stageId: 'stage-x' })).toBe('stage-x');
    expect(deriveDocumentStageId({ kind: 'list' })).toBeNull();
    expect(deriveDocumentStageId({ kind: 'unknown' })).toBeNull();
  });
});
