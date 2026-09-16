import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  TeachingPackageError,
  TeachingPackageStageLockedError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';

const SERVICE_KEY = 'test-service-key-0123456789';

function requestWithAuthorization(value?: string): Pick<Request, 'headers'> {
  return { headers: new Headers(value === undefined ? {} : { authorization: value }) };
}

describe('teaching package service auth', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a correct bearer token', () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    expect(() =>
      authenticateServiceRequest(requestWithAuthorization(`Bearer ${SERVICE_KEY}`)),
    ).not.toThrow();
  });

  it('refuses an incorrect bearer token with SERVICE_UNAUTHENTICATED', () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    expect(() =>
      authenticateServiceRequest(requestWithAuthorization('Bearer wrong-key')),
    ).toThrowError(TeachingPackageError);
    try {
      authenticateServiceRequest(requestWithAuthorization('Bearer wrong-key'));
    } catch (error) {
      expect(error).toMatchObject({ code: 'SERVICE_UNAUTHENTICATED', status: 401 });
    }
  });

  it('refuses a missing bearer token', () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    expect(() => authenticateServiceRequest(requestWithAuthorization())).toThrowError(
      TeachingPackageError,
    );
    expect(() => authenticateServiceRequest(requestWithAuthorization('Basic abc'))).toThrowError(
      /service key/,
    );
  });

  it('refuses every request when no service key is configured', () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect(() =>
      authenticateServiceRequest(requestWithAuthorization(`Bearer ${SERVICE_KEY}`)),
    ).toThrowError(TeachingPackageError);
  });

  describe('feature gate', () => {
    it('is off without a DATABASE_URL even when the key is set', () => {
      vi.stubEnv('DATABASE_URL', '');
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
      expect(isTeachingPackageApiConfigured()).toBe(false);
    });

    it('is off without a service key even when persistence is configured', () => {
      vi.stubEnv('DATABASE_URL', 'postgres://gate-test');
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
      expect(isTeachingPackageApiConfigured()).toBe(false);
    });

    it('is on only with both persistence and a service key', () => {
      vi.stubEnv('DATABASE_URL', 'postgres://gate-test');
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
      expect(isTeachingPackageApiConfigured()).toBe(true);
    });
  });

  describe('service owner principal', () => {
    // The anonymous-owner grammar: the suffix after "anon:" must be a UUID v4.
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    it('is the fixed service:teaching-package constant', () => {
      expect(TEACHING_PACKAGE_STAGE_OWNER).toBe('service:teaching-package');
      expect(TEACHING_PACKAGE_STAGE_OWNER.startsWith('anon:')).toBe(false);
    });

    it('is not a valid anonymous owner suffix', () => {
      expect(UUID_V4.test(TEACHING_PACKAGE_STAGE_OWNER)).toBe(false);
    });

    it('cannot be produced by resolveRequestOwnerId from a cookie', () => {
      const responseHeaders = new Headers();
      const resolved = resolveRequestOwnerId(
        {
          headers: new Headers({
            cookie: `anonymous_id=${encodeURIComponent(TEACHING_PACKAGE_STAGE_OWNER)}`,
          }),
        },
        responseHeaders,
      );
      expect(resolved).not.toBe(TEACHING_PACKAGE_STAGE_OWNER);
      expect(resolved.startsWith('anon:')).toBe(true);
      expect(UUID_V4.test(resolved.slice('anon:'.length))).toBe(true);
    });
  });

  describe('error mapping', () => {
    const EXPECTED_STATUSES: Record<TeachingPackageErrorCode, number> = {
      NOT_FOUND: 404,
      INVALID_REQUEST: 400,
      ACTOR_REQUIRED: 400,
      REASON_REQUIRED: 400,
      UNSUPPORTED_LEARNING_ITEM_TYPE: 400,
      MODEL_VERSION_REQUIRED: 400,
      INVALID_TRANSITION: 409,
      STALE_STATE: 409,
      ACTIVE_SUCCESSOR_EXISTS: 409,
      APPROVAL_CONFLICT: 409,
      STAGE_CHANGED_SINCE_SUBMISSION: 409,
      GENERATION_IN_PROGRESS: 409,
      NOT_A_SUCCESSOR: 409,
      STAGE_NOT_LIVE: 422,
      STAGE_NOT_PACKAGE_ELIGIBLE: 422,
      STAGE_LOCKED: 423,
      SERVICE_UNAUTHENTICATED: 401,
      IDEMPOTENCY_CONFLICT: 409,
      FLOW_REQUIRED: 400,
      FLOW_INVALID: 400,
      CONTENT_RESOURCE_REQUIRED: 400,
      TENANT_REQUIRED: 400,
      TEACHING_MODEL_FLOW_MISMATCH: 409,
      SOURCE_VISUAL_MODEL_UNAVAILABLE: 422,
      INTEGRATION_NOT_CONFIGURED: 503,
      TEACHING_PACKAGE_NOT_APPROVED: 409,
      QUESTION_SOURCE_CONTEXT_UNAVAILABLE: 409,
      OBJECTIVE_NOT_IN_PACKAGE: 422,
      OBJECTIVE_TEACHING_MISSING: 422,
      QUESTION_GENERATION_MODEL_UNAVAILABLE: 503,
      QUESTION_GENERATION_OUTPUT_INVALID: 502,
    };

    it('maps every code onto the folders envelope with its status', async () => {
      for (const [code, status] of Object.entries(EXPECTED_STATUSES)) {
        const error = new TeachingPackageError(
          code as TeachingPackageErrorCode,
          `message for ${code}`,
        );
        const response = teachingPackageErrorResponse(error);
        expect(response, code).not.toBeNull();
        expect(response!.status, code).toBe(status);
        expect(response!.headers.get('content-type'), code).toContain('application/json');
        const body = (await response!.json()) as { error: Record<string, unknown> };
        expect(body.error, code).toMatchObject({ code, message: `message for ${code}` });
      }
    });

    it('includes optional details in the envelope', async () => {
      const response = teachingPackageErrorResponse(
        new TeachingPackageError('INVALID_REQUEST', 'bad input', { field: 'id' }),
      );
      const body = (await response!.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({
        code: 'INVALID_REQUEST',
        message: 'bad input',
        details: { field: 'id' },
      });
    });

    it('maps the stage lock error to 423 STAGE_LOCKED', async () => {
      const response = teachingPackageErrorResponse(
        new TeachingPackageStageLockedError('stage-x', 'approved'),
      );
      expect(response!.status).toBe(423);
      const body = (await response!.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({
        code: 'STAGE_LOCKED',
        message: expect.stringContaining('teaching package stage locked (approved)'),
      });
    });

    it('maps a PostgreSQL unique violation (23505) to 409', async () => {
      const fake = Object.assign(new Error('duplicate key value'), { code: '23505' });
      const response = teachingPackageErrorResponse(fake);
      expect(response!.status).toBe(409);
      const body = (await response!.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({ code: 'CONFLICT' });
    });

    it('returns null for unrelated errors', () => {
      expect(teachingPackageErrorResponse(new Error('unrelated'))).toBeNull();
      expect(teachingPackageErrorResponse('not an error')).toBeNull();
    });
  });
});
