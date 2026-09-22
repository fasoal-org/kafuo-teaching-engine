/**
 * Route guards for `app/api/tutor/**` (Kafuo R1 plan §6.4, §9.3; contracts §5).
 *
 * `withStudentGrant` — Free Chat: the `Authorization: Bearer tsg.…` student
 * grant is the only credential. `withLearnerGrant` — Help: the existing
 * Editor grant cookie, but ONLY entries with `purpose: 'learner'` that carry
 * the Kafuo R1 student block (contracts §3.2); an edit/preview grant, or a
 * learner grant minted before P5 without the block, is `GRANT_INVALID`.
 *
 * Both guards answer `404` when the Teaching Package API is off (the same gate
 * as every package route), map `TeachingPackageError` onto the contracts'
 * envelope `{ error: { code, message, retryable, details? } }`, and can apply
 * the per-grant turn token bucket (`rateLimit: true` on message submission
 * routes only). The handler never sees a request whose grant did not verify.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  readEditorGrants,
  type VerifiedEditorGrant,
} from '@/lib/server/teaching-package/editor-grant';
import {
  TeachingPackageError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { enforceTurnRateLimit } from '@/lib/server/tutor/rate-limit';
import type { LearnerStudentContext } from '@/lib/server/tutor/student-context';
import { verifyStudentGrant, type StudentGrantPayload } from '@/lib/server/tutor/student-grant';

/** Codes a client may retry unchanged (contracts §5 marks them "retryable"). */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<TeachingPackageErrorCode | string>([
  'TEACHING_MODEL_UNAVAILABLE',
  'ACCOUNTING_UNAVAILABLE',
  'BUDGET_ASSERTION_FAILED',
  'METER_UNAVAILABLE',
  'TURN_IN_PROGRESS',
  'RATE_LIMITED',
  'INTEGRATION_NOT_CONFIGURED',
]);

/**
 * Map a failure onto the tutor error envelope. `null` when the error is not a
 * `TeachingPackageError` (the guard answers its own 500 then). `RATE_LIMITED`
 * and `TURN_IN_PROGRESS` carry `Retry-After` from `details.retryAfterS`.
 */
export function tutorErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof TeachingPackageError)) return null;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  const retryAfter =
    error.details && typeof error.details === 'object'
      ? (error.details as { retryAfterS?: unknown }).retryAfterS
      : undefined;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    headers.set('Retry-After', String(Math.ceil(retryAfter)));
  }
  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        retryable: RETRYABLE_CODES.has(error.code),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    { status: error.status, headers },
  );
}

export function tutorInternalErrorResponse(message: string): NextResponse {
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message, retryable: true } },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}

export interface GuardOptions {
  /** Apply the per-grant turn token bucket before the handler runs. */
  rateLimit?: boolean;
  /** Epoch ms clock (tests). */
  now?: () => number;
}

export interface StudentGrantContext {
  grant: StudentGrantPayload;
  /** The token-bucket identity: `student:<tenantId>:<studentRef>`. */
  rateLimitKey: string;
}

export type StudentGrantHandler = (
  req: NextRequest,
  ctx: StudentGrantContext,
) => Promise<Response> | Response;

export function studentRateLimitKey(grant: Pick<StudentGrantPayload, 'tenantId' | 'studentRef'>): string {
  return `student:${grant.tenantId}:${grant.studentRef}`;
}

async function runGuarded(
  body: () => Promise<Response> | Response,
  failureMessage: string,
): Promise<Response> {
  try {
    return await body();
  } catch (error) {
    const mapped = tutorErrorResponse(error);
    if (mapped) return mapped;
    console.error('Tutor internal error', JSON.stringify(describeErrorSafely(error)));
    return tutorInternalErrorResponse(failureMessage);
  }
}

/** Free Chat guard (contracts §5): student grant bearer, else 401. */
export async function withStudentGrant(
  req: NextRequest,
  handler: StudentGrantHandler,
  options?: GuardOptions,
): Promise<Response> {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  const now = options?.now ?? Date.now;
  return runGuarded(async () => {
    const grant = verifyStudentGrant(req.headers.get('authorization'), now());
    const rateLimitKey = studentRateLimitKey(grant);
    if (options?.rateLimit) enforceTurnRateLimit(rateLimitKey, now());
    return handler(req, { grant, rateLimitKey });
  }, 'tutor request failed');
}

/** A learner grant with the Kafuo R1 student block: what Help can act on. */
export type VerifiedLearnerGrant = VerifiedEditorGrant & {
  purpose: 'learner';
  student: LearnerStudentContext;
};

export function isVerifiedLearnerGrant(grant: VerifiedEditorGrant): grant is VerifiedLearnerGrant {
  return grant.purpose === 'learner' && grant.student !== undefined;
}

export function learnerRateLimitKey(grant: Pick<VerifiedEditorGrant, 'tenantId' | 'learnerKey'>): string {
  return `learner:${grant.tenantId}:${grant.learnerKey}`;
}

export interface LearnerGrantContext {
  /** Every valid learner grant the cookie holds (the cookie is Stage-scoped, up to five). */
  grants: VerifiedLearnerGrant[];
  /**
   * The grant for one Stage — `GRANT_INVALID` when the cookie holds none for
   * it. Applies the turn token bucket when the guard was asked to.
   */
  forStage(stageId: string): VerifiedLearnerGrant;
}

export type LearnerGrantHandler = (
  req: NextRequest,
  ctx: LearnerGrantContext,
) => Promise<Response> | Response;

/**
 * Help guard (contracts §5): the learner cookie grant. Refuses outright when
 * no entry is a learner grant with the student block; the handler resolves
 * the Stage it acts on through `forStage` (the Stage id arrives in the body
 * or query, which is the handler's to parse).
 */
export async function withLearnerGrant(
  req: NextRequest,
  handler: LearnerGrantHandler,
  options?: GuardOptions,
): Promise<Response> {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  const now = options?.now ?? Date.now;
  return runGuarded(async () => {
    const grants = readEditorGrants(req.headers).filter(isVerifiedLearnerGrant);
    if (grants.length === 0) {
      throw new TeachingPackageError(
        'GRANT_INVALID',
        'a learner grant with student context is required',
      );
    }
    const forStage = (stageId: string): VerifiedLearnerGrant => {
      const grant = grants.find((entry) => entry.stageId === stageId);
      if (!grant) {
        throw new TeachingPackageError('GRANT_INVALID', 'no learner grant for this stage');
      }
      if (options?.rateLimit) enforceTurnRateLimit(learnerRateLimitKey(grant), now());
      return grant;
    };
    return handler(req, { grants, forStage });
  }, 'tutor request failed');
}
