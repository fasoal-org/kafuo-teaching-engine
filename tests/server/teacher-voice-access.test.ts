/**
 * Teacher voice (owner, 22 Nov 2026): a teacher who opened the editor from the
 * admin holds an editor grant and no access code. The middleware now lets such a
 * browser reach `GET /api/server-providers`, `POST /api/generate/tts` and
 * `POST /api/persistence/assets`; the handlers decide. These pin the handlers'
 * own checks: the access cookie, or a non-learner editor grant (and, for TTS, a
 * write grant for the body's Stage).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAccessToken } from '@/lib/server/access-token';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import {
  hasAccessCookieOrNoGate,
  hasAccessCookieOrTeacherGrant,
} from '@/lib/server/teaching-package/editor-grant-tenant-access';

const CODE = 'teacher-voice-code';
const STAGE = 'stage-teacher-voice';

function grantCookie(capability: 'read' | 'write', purpose?: 'edit' | 'preview' | 'learner') {
  const { token } = buildEditorGrantPayload({
    tenantId: 'tenant-test',
    versionId: `tpv-${STAGE}`,
    stageId: STAGE,
    capability,
    ...(purpose ? { purpose } : {}),
  });
  return `teaching_package_grant=${encodeURIComponent(
    grantCookieValueForRedeem(new Headers(), token, STAGE),
  )}`;
}

function headers(cookie?: string): Headers {
  return new Headers(cookie ? { cookie } : {});
}

beforeEach(() => {
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'teacher-voice-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hasAccessCookieOrTeacherGrant', () => {
  it('passes everything when no ACCESS_CODE gates the deployment', () => {
    vi.stubEnv('ACCESS_CODE', '');
    expect(hasAccessCookieOrNoGate(headers())).toBe(true);
    expect(hasAccessCookieOrTeacherGrant(headers())).toBe(true);
  });

  it('passes a valid access cookie and refuses a foreign one', () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    expect(hasAccessCookieOrNoGate(headers(`openmaic_access=${createAccessToken(CODE)}`))).toBe(
      true,
    );
    expect(hasAccessCookieOrNoGate(headers(`openmaic_access=${createAccessToken('other')}`))).toBe(
      false,
    );
  });

  it('passes an edit or preview grant without the access cookie', () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    expect(hasAccessCookieOrTeacherGrant(headers(grantCookie('write', 'edit')))).toBe(true);
    expect(hasAccessCookieOrTeacherGrant(headers(grantCookie('read', 'preview')))).toBe(true);
  });

  it('refuses a learner grant, an unsigned cookie and no cookie at all', () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    expect(hasAccessCookieOrTeacherGrant(headers(grantCookie('read', 'learner')))).toBe(false);
    expect(
      hasAccessCookieOrTeacherGrant(
        headers(`teaching_package_grant=${encodeURIComponent('["not-signed"]')}`),
      ),
    ).toBe(false);
    expect(hasAccessCookieOrTeacherGrant(headers())).toBe(false);
  });
});

describe('GET /api/server-providers', () => {
  it('answers the middleware 401 to a learner grant and 200 to a teacher grant', async () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    const { GET } = await import('@/app/api/server-providers/route');
    const learner = await GET(
      new Request('http://te.test/api/server-providers', {
        headers: headers(grantCookie('read', 'learner')),
      }),
    );
    expect(learner.status).toBe(401);
    expect(await learner.json()).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Access code required',
    });
    const teacher = await GET(
      new Request('http://te.test/api/server-providers', {
        headers: headers(grantCookie('write', 'edit')),
      }),
    );
    expect(teacher.status).toBe(200);
  });
});

describe('POST /api/generate/tts without the access cookie', () => {
  async function post(cookie: string | undefined, body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/generate/tts/route');
    const { NextRequest } = await import('next/server');
    return POST(
      new NextRequest('http://te.test/api/generate/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({
          text: 'السلام عليكم',
          audioId: 'tts_request_s0_a1',
          ttsProviderId: 'openai-tts',
          ttsVoice: 'alloy',
          ...body,
        }),
      }),
    );
  }

  it('refuses a request that names no Stage with the middleware 401', async () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    const response = await post(grantCookie('write', 'edit'), {});
    expect(response.status).toBe(401);
  });

  it('refuses a teacher grant when no grant covers the named Stage (no persistence: 404)', async () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    vi.stubEnv('DATABASE_URL', '');
    const response = await post(grantCookie('write', 'edit'), { stageId: STAGE });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/generate/tts/assess without the access cookie', () => {
  it('needs a Stage and a write grant for it, like generate/tts', async () => {
    vi.stubEnv('ACCESS_CODE', CODE);
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'off');
    vi.stubEnv('DATABASE_URL', '');
    const { POST } = await import('@/app/api/generate/tts/assess/route');
    const { NextRequest } = await import('next/server');
    const send = (body: Record<string, unknown>) =>
      POST(
        new NextRequest('http://te.test/api/generate/tts/assess', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: grantCookie('write', 'edit') },
          body: JSON.stringify({
            ttsProviderId: 'openai-tts',
            ttsVoice: 'alloy',
            actions: [],
            ...body,
          }),
        }),
      );
    expect((await send({})).status).toBe(401);
    expect((await send({ stageId: STAGE })).status).toBe(404);
  });
});
