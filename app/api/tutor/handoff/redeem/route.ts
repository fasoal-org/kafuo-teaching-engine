/**
 * GET /api/tutor/handoff/redeem?token=… — redeem a student handoff into a
 * student grant (Kafuo R1 contracts §5 row 1; plan §6.4).
 *
 * The handoff token IS the credential (no service key, no cookie). Answers
 * `{ grant, expiresAt, subjects, academic }` where `subjects` is Kafuo's list
 * ∩ the policy table — an empty list is a valid "no routed subject" state the
 * client renders, not an error. `expiresAt` is epoch seconds. `Cache-Control:
 * no-store` because the body is a bearer credential.
 *
 * Errors use the tutor envelope (`retryable` present): `GRANT_INVALID` /
 * `GRANT_EXPIRED` (401) for a bad or stale handoff; 404 when the Teaching
 * Package API is off.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { tutorErrorResponse, tutorInternalErrorResponse } from '@/lib/server/tutor/guards';
import { redeemStudentHandoff } from '@/lib/server/tutor/student-grant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    const token = req.nextUrl.searchParams.get('token') ?? '';
    const redeemed = redeemStudentHandoff(token);
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
