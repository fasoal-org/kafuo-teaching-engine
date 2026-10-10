/**
 * `POST /api/tutor/handoff/redeem` (body `{ "token": "…" }`) — redeem a student
 * handoff into a student grant (Kafuo R1 contracts §5 row 1; plan §6.4).
 *
 * The handoff token IS the credential (no service key, no cookie). Answers
 * `{ grant, expiresAt, subjects, academic }` where `subjects` is Kafuo's list
 * ∩ the policy table — an empty list is a valid "no routed subject" state the
 * client renders, not an error. `expiresAt` is epoch seconds. `Cache-Control:
 * no-store` because the body is a bearer credential.
 *
 * ET-16 (launch plan Wave 2):
 *  - (a) a handoff is single-use: the second redeem of a token, on any
 *    instance, is `GRANT_INVALID` (`redeemStudentHandoffOnce`).
 *  - (b) the token belongs in the POST body, out of URLs (proxy and access logs,
 *    history). `GET ?token=` keeps working for one release because the current
 *    app build calls it; each use is logged as `tutor.handoff_redeem_get_deprecated`
 *    (without the token) so its retirement can be measured.
 *
 * Errors use the tutor envelope (`retryable` present): `GRANT_INVALID` /
 * `GRANT_EXPIRED` (401) for a bad, replayed or stale handoff; 404 when the
 * Teaching Package API is off.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { createLogger } from '@/lib/logger';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { tutorErrorResponse, tutorInternalErrorResponse } from '@/lib/server/tutor/guards';
import { redeemStudentHandoffOnce } from '@/lib/server/tutor/student-grant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('TutorHandoffRedeem');

async function redeem(token: string): Promise<Response> {
  try {
    const redeemed = await redeemStudentHandoffOnce(token);
    return NextResponse.json(
      {
        grant: redeemed.grant,
        expiresAt: Math.floor(redeemed.expiresAt / 1000),
        subjects: redeemed.subjects,
        academic: redeemed.academic,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
    );
  } catch (error) {
    const mapped = tutorErrorResponse(error);
    if (mapped) return mapped;
    console.error('Tutor redeem internal error', JSON.stringify(describeErrorSafely(error)));
    return tutorInternalErrorResponse('failed to redeem student handoff');
  }
}

export async function POST(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  let token = '';
  try {
    const body: unknown = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const value = (body as { token?: unknown }).token;
      if (typeof value === 'string') token = value;
    }
  } catch {
    token = '';
  }
  return redeem(token);
}

/** Deprecated (ET-16 b): the token travels in the URL. Kept for the current app build. */
export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  log.warn(JSON.stringify({ event: 'tutor.handoff_redeem_get_deprecated' }));
  return redeem(req.nextUrl.searchParams.get('token') ?? '');
}
