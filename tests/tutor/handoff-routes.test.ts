import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mintStudentHandoff, verifyStudentGrant, verifyStudentHandoff } from '@/lib/server/tutor/student-grant';

/**
 * `POST /api/tutor/handoff` (service key, contracts §3.1) and
 * `GET /api/tutor/handoff/redeem` (handoff token, contracts §5): gating,
 * authentication and the JSON shapes. No database is touched by either.
 */

const SERVICE_KEY = 'handoff-routes-svc-key';
const STUDENT_REF = 'abcdefghijklmnopqrstuvwx';

const VALID_BODY = {
  tenantContext: { tenantId: '1' },
  studentRef: STUDENT_REF,
  purposes: ['free_chat'],
  academic: {
    curriculumId: '27',
    curriculumName: 'National',
    curriculumVersionLabel: '2026',
    gradeLabel: 'Grade 9',
  },
  allowedSubjects: [
    { code: 'MATH', offeringId: '10', nameAr: 'الرياضيات', nameEn: 'Math', academicLanguage: 'ar' },
    { code: 'ENGLISH', offeringId: '12', nameAr: 'الإنجليزية', nameEn: 'English', academicLanguage: 'en' },
  ],
  localeHint: 'ar',
  entitlements: { freeChat: true, help: true },
  actorRef: 'actor-1',
};

function postRequest(body: unknown, authorization?: string): NextRequest {
  return new NextRequest('http://localhost/api/tutor/handoff', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function mint(body: unknown, authorization?: string) {
  const { POST } = await import('@/app/api/tutor/handoff/route');
  return POST(postRequest(body, authorization));
}

async function redeem(token: string) {
  const { GET } = await import('@/app/api/tutor/handoff/redeem/route');
  return GET(
    new NextRequest(`http://localhost/api/tutor/handoff/redeem?token=${encodeURIComponent(token)}`),
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://handoff-routes-test');
});

describe('POST /api/tutor/handoff', () => {
  it('answers 404 when the Teaching Package API is not configured', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    const response = await mint(VALID_BODY, `Bearer ${SERVICE_KEY}`);
    expect(response.status).toBe(404);
  });

  it('requires the service key', async () => {
    expect((await mint(VALID_BODY)).status).toBe(401);
    const wrong = await mint(VALID_BODY, 'Bearer nope');
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({
      error: { code: 'SERVICE_UNAUTHENTICATED' },
    });
  });

  it('mints a handoff carrying the request verbatim (expiresAt in seconds)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const response = await mint(VALID_BODY, `Bearer ${SERVICE_KEY}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = (await response.json()) as { token: string; expiresAt: number };
    expect(json.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 - 1);
    expect(json.expiresAt).toBeLessThanOrEqual(before + 5 * 60 + 5);
    const payload = verifyStudentHandoff(json.token);
    expect(payload).toMatchObject({
      tenantId: '1',
      studentRef: STUDENT_REF,
      localeHint: 'ar',
      entitlements: { freeChat: true, help: true },
      academic: VALID_BODY.academic,
    });
    // Unrouted codes are NOT refused at mint (the intersection happens at redeem).
    expect(payload.allowedSubjects.map((s) => s.code)).toEqual(['MATH', 'ENGLISH']);
  });

  it('validates the body shape', async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...VALID_BODY, actorRef: undefined }, 'ACTOR_REQUIRED'],
      [{ ...VALID_BODY, tenantContext: undefined }, 'TENANT_REQUIRED'],
      [{ ...VALID_BODY, studentRef: 'short' }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, purposes: ['help'] }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, purposes: [] }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, academic: { curriculumName: 'x' } }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, allowedSubjects: 'MATH' }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, allowedSubjects: [{ code: 'MATH' }] }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, entitlements: { freeChat: 'yes', help: true } }, 'INVALID_REQUEST'],
      [{ ...VALID_BODY, localeHint: 42 }, 'INVALID_REQUEST'],
    ];
    for (const [body, code] of cases) {
      const response = await mint(body, `Bearer ${SERVICE_KEY}`);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }
    const notJson = await (await import('@/app/api/tutor/handoff/route')).POST(
      new NextRequest('http://localhost/api/tutor/handoff', {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
        body: 'not json',
      }),
    );
    expect(notJson.status).toBe(400);
  });
});

describe('GET /api/tutor/handoff/redeem', () => {
  it('answers 404 when the Teaching Package API is not configured', async () => {
    const { token } = mintStudentHandoff({ ...VALID_BODY, tenantId: '1' });
    vi.stubEnv('DATABASE_URL', '');
    expect((await redeem(token)).status).toBe(404);
  });

  it('returns { grant, expiresAt, subjects, academic } with no-store', async () => {
    const { token } = mintStudentHandoff({ ...VALID_BODY, tenantId: '1' });
    const response = await redeem(token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = (await response.json()) as {
      grant: string;
      expiresAt: number;
      subjects: Array<{ code: string; offeringId: string }>;
      academic: Record<string, string>;
    };
    expect(Object.keys(json).sort()).toEqual(['academic', 'expiresAt', 'grant', 'subjects']);
    expect(json.grant.startsWith('tsg.')).toBe(true);
    expect(json.subjects).toEqual([VALID_BODY.allowedSubjects[0]]);
    expect(json.academic).toEqual(VALID_BODY.academic);
    const nowS = Math.floor(Date.now() / 1000);
    expect(json.expiresAt).toBeGreaterThanOrEqual(nowS + 3600 - 2);
    expect(json.expiresAt).toBeLessThanOrEqual(nowS + 3600 + 5);
    // The grant verifies as a student grant with the same intersection.
    const grant = verifyStudentGrant(`Bearer ${json.grant}`);
    expect(grant.allowedSubjects.map((s) => s.code)).toEqual(['MATH']);
    expect(Math.floor(grant.exp / 1000)).toBe(json.expiresAt);
  });

  it('refuses a bad, missing or expired token with the tutor error envelope (401)', async () => {
    const garbage = await redeem('garbage.token');
    expect(garbage.status).toBe(401);
    await expect(garbage.json()).resolves.toEqual({
      error: { code: 'GRANT_INVALID', message: expect.any(String), retryable: false },
    });
    const { GET } = await import('@/app/api/tutor/handoff/redeem/route');
    expect((await GET(new NextRequest('http://localhost/api/tutor/handoff/redeem'))).status).toBe(401);

    const { token } = mintStudentHandoff({
      ...VALID_BODY,
      tenantId: '1',
      now: Date.now() - 10 * 60 * 1000,
    });
    const expired = await redeem(token);
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: 'GRANT_EXPIRED' } });
  });
});
