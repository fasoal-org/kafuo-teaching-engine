import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEditorGrantPayload } from '@/lib/server/teaching-package/editor-grant';
import { withLearnerGrant, withStudentGrant } from '@/lib/server/tutor/guards';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import type { LearnerStudentContext } from '@/lib/server/tutor/student-context';
import { mintStudentHandoff, redeemStudentHandoff } from '@/lib/server/tutor/student-grant';

/**
 * `withStudentGrant` / `withLearnerGrant` (plan §6.4, §9.3): the 404 gate,
 * the grant kinds each accepts, the learner requirements (purpose + student
 * block + Stage), and the per-grant turn token bucket → 429.
 */

const SERVICE_KEY = 'guards-test-key';
const STUDENT_REF = 'abcdefghijklmnopqrstuvwx';
const NOW = 1_800_000_000_000;

const STUDENT: LearnerStudentContext = {
  studentRef: STUDENT_REF,
  academic: { curriculumName: 'National', curriculumVersionLabel: '2026', gradeLabel: 'Grade 9' },
  subject: { code: 'PHYSICS', nameAr: 'الفيزياء', nameEn: 'Physics', academicLanguage: 'ar' },
  localeHint: 'ar',
  entitlements: { help: true },
};

function studentGrant(): string {
  const { token } = mintStudentHandoff({
    tenantId: '1',
    studentRef: STUDENT_REF,
    academic: {
      curriculumId: '27',
      curriculumName: 'National',
      curriculumVersionLabel: '2026',
      gradeLabel: 'Grade 9',
    },
    allowedSubjects: [
      { code: 'MATH', offeringId: '10', nameAr: 'الرياضيات', nameEn: 'Math', academicLanguage: 'ar' },
    ],
    entitlements: { freeChat: true, help: true },
    now: NOW,
  });
  return redeemStudentHandoff(token, NOW).grant;
}

function cookieFor(...tokens: string[]): string {
  return `teaching_package_grant=${encodeURIComponent(JSON.stringify(tokens))}`;
}

function learnerToken(overrides: Partial<Parameters<typeof buildEditorGrantPayload>[0]> = {}): string {
  return buildEditorGrantPayload({
    tenantId: '1',
    versionId: 'tpv-1',
    stageId: 'stage-1',
    capability: 'read',
    purpose: 'learner',
    learnerRef: 'learner-ref-0123456789abcdef',
    student: STUDENT,
    ...overrides,
  }).token;
}

const ok = () => NextResponse.json({ ok: true });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://guards-test');
  resetTurnRateLimitForTests();
});

describe('withStudentGrant', () => {
  it('404 when the Teaching Package API is not configured, before any verification', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const handler = vi.fn(ok);
    const response = await withStudentGrant(new NextRequest('http://localhost/api/tutor/x'), handler);
    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the verified grant and its rate-limit key to the handler', async () => {
    const grant = studentGrant();
    const handler = vi.fn(async (_req: NextRequest, ctx: { grant: { studentRef: string }; rateLimitKey: string }) =>
      NextResponse.json({ studentRef: ctx.grant.studentRef, key: ctx.rateLimitKey }),
    );
    const response = await withStudentGrant(
      new NextRequest('http://localhost/api/tutor/x', { headers: { authorization: `Bearer ${grant}` } }),
      handler,
      { now: () => NOW },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      studentRef: STUDENT_REF,
      key: `student:1:${STUDENT_REF}`,
    });
  });

  it('refuses a missing, expired, or learner-kind credential with the envelope', async () => {
    const handler = vi.fn(ok);
    const missing = await withStudentGrant(new NextRequest('http://localhost/api/tutor/x'), handler);
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({
      error: { code: 'GRANT_INVALID', message: expect.any(String), retryable: false },
    });

    const expired = await withStudentGrant(
      new NextRequest('http://localhost/api/tutor/x', {
        headers: { authorization: `Bearer ${studentGrant()}` },
      }),
      handler,
      { now: () => NOW + 2 * 3600 * 1000 },
    );
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: 'GRANT_EXPIRED' } });

    const learnerAsStudent = await withStudentGrant(
      new NextRequest('http://localhost/api/tutor/x', {
        headers: { authorization: `Bearer tsg.${learnerToken()}` },
      }),
      handler,
    );
    expect(learnerAsStudent.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies the per-grant token bucket: TUTOR_TURNS_PER_MINUTE then 429 with Retry-After', async () => {
    vi.stubEnv('TUTOR_TURNS_PER_MINUTE', '2');
    const grant = studentGrant();
    const handler = vi.fn(ok);
    const request = () =>
      new NextRequest('http://localhost/api/tutor/x', { headers: { authorization: `Bearer ${grant}` } });
    let t = NOW;
    const clock = { now: () => t };
    expect((await withStudentGrant(request(), handler, { rateLimit: true, ...clock })).status).toBe(200);
    expect((await withStudentGrant(request(), handler, { rateLimit: true, ...clock })).status).toBe(200);
    const limited = await withStudentGrant(request(), handler, { rateLimit: true, ...clock });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: 'RATE_LIMITED', retryable: true, details: { retryAfterS: expect.any(Number) } },
    });
    expect(handler).toHaveBeenCalledTimes(2);
    // Half a minute later one token has refilled (2/min).
    t = NOW + 30_000;
    expect((await withStudentGrant(request(), handler, { rateLimit: true, ...clock })).status).toBe(200);
    expect((await withStudentGrant(request(), handler, { rateLimit: true, ...clock })).status).toBe(429);
    // Reads (no rateLimit) never consume a token.
    expect((await withStudentGrant(request(), handler, clock)).status).toBe(200);
  });

  it('a handler throwing a TeachingPackageError is mapped; anything else is a 500 envelope', async () => {
    const grant = studentGrant();
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    const request = () =>
      new NextRequest('http://localhost/api/tutor/x', { headers: { authorization: `Bearer ${grant}` } });
    const mapped = await withStudentGrant(
      request(),
      async () => {
        throw new TeachingPackageError('TEACHING_MODEL_UNAVAILABLE', 'both routes failed');
      },
      { now: () => NOW },
    );
    expect(mapped.status).toBe(503);
    await expect(mapped.json()).resolves.toMatchObject({
      error: { code: 'TEACHING_MODEL_UNAVAILABLE', retryable: true },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = await withStudentGrant(
      request(),
      async () => {
        throw new Error('boom');
      },
      { now: () => NOW },
    );
    errorSpy.mockRestore();
    expect(internal.status).toBe(500);
    await expect(internal.json()).resolves.toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});

describe('withLearnerGrant', () => {
  it('404 when unconfigured', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    const response = await withLearnerGrant(
      new NextRequest('http://localhost/api/tutor/help/x', { headers: { cookie: cookieFor(learnerToken()) } }),
      ok,
    );
    expect(response.status).toBe(404);
  });

  it('accepts a learner grant with the student block and resolves it per Stage', async () => {
    const response = await withLearnerGrant(
      new NextRequest('http://localhost/api/tutor/help/x', {
        headers: { cookie: cookieFor(learnerToken(), learnerToken({ stageId: 'stage-2', versionId: 'tpv-2' })) },
      }),
      async (_req, ctx) => {
        expect(ctx.grants).toHaveLength(2);
        const grant = ctx.forStage('stage-2');
        expect(grant.versionId).toBe('tpv-2');
        expect(grant.student).toEqual(STUDENT);
        expect(grant.learnerKey).toMatch(/^tp:/);
        expect(() => ctx.forStage('stage-9')).toThrowError(/no learner grant/);
        return ok();
      },
    );
    expect(response.status).toBe(200);
  });

  it('refuses without purpose learner, without the student block, or with a student bearer', async () => {
    const handler = vi.fn(ok);
    const preview = await withLearnerGrant(
      new NextRequest('http://localhost/api/tutor/help/x', {
        headers: { cookie: cookieFor(learnerToken({ purpose: 'preview' })) },
      }),
      handler,
    );
    expect(preview.status).toBe(401);
    await expect(preview.json()).resolves.toMatchObject({ error: { code: 'GRANT_INVALID' } });

    const noStudent = await withLearnerGrant(
      new NextRequest('http://localhost/api/tutor/help/x', {
        headers: { cookie: cookieFor(learnerToken({ student: undefined })) },
      }),
      handler,
    );
    expect(noStudent.status).toBe(401);

    const studentBearer = await withLearnerGrant(
      new NextRequest('http://localhost/api/tutor/help/x', {
        headers: { authorization: `Bearer ${studentGrant()}` },
      }),
      handler,
    );
    expect(studentBearer.status).toBe(401);

    const nothing = await withLearnerGrant(new NextRequest('http://localhost/api/tutor/help/x'), handler);
    expect(nothing.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rate-limits per learner grant when asked, keyed by the Stage grant it resolves', async () => {
    vi.stubEnv('TUTOR_TURNS_PER_MINUTE', '1');
    const cookie = cookieFor(learnerToken());
    const request = () =>
      new NextRequest('http://localhost/api/tutor/help/turns', { method: 'POST', headers: { cookie } });
    const handler = async (_req: NextRequest, ctx: { forStage(stageId: string): unknown }) => {
      ctx.forStage('stage-1');
      return ok();
    };
    const clock = { now: () => NOW, rateLimit: true };
    expect((await withLearnerGrant(request(), handler, clock)).status).toBe(200);
    const limited = await withLearnerGrant(request(), handler, clock);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
