/**
 * GET /api/teaching-packages/editor-handoff?token=… — redeem a handoff token
 * (browser route; the token IS the credential — no service key). Verifies the
 * HMAC and expiry, re-checks the version (write grants only for draft|
 * rejected; `currentStageId` must still equal the token's stage — a
 * regeneration between mint and redeem invalidates the token), then sets the
 * HttpOnly Stage-scoped grant cookie plus the readable companion learner-key
 * cookie and redirects to the classroom.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  LEARNER_HANDOFF_STATUSES,
  buildEditorGrantPayload,
  editorGrantCookieHeaders,
  grantCookieValueForRedeem,
  verifyEditorHandoffToken,
} from '@/lib/server/teaching-package/editor-grant';
import { getTeachingPackageVersionByToken } from '@/lib/server/teaching-package/resolve';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    const token = req.nextUrl.searchParams.get('token') ?? '';
    const payload = verifyEditorHandoffToken(token);
    if (!payload) {
      throw new TeachingPackageError('INVALID_REQUEST', 'the handoff token is invalid or expired');
    }

    // The token carries the canonical tenant; a version under a different
    // tenant behaves exactly like an absent one (non-enumerating NOT_FOUND).
    const version = await getTeachingPackageVersionByToken(payload.versionId);
    if (version.tenantId !== payload.tenantId) {
      throw new TeachingPackageError('NOT_FOUND', `teaching package ${payload.versionId} not found`);
    }
    if (
      payload.capability === 'write' &&
      version.status !== 'draft' &&
      version.status !== 'rejected'
    ) {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `the version is now ${version.status} and can no longer be edited`,
      );
    }
    if (
      payload.purpose === 'learner' &&
      (payload.capability !== 'read' ||
        !(LEARNER_HANDOFF_STATUSES as readonly string[]).includes(version.status))
    ) {
      // Re-checked at redeem: a version discarded or otherwise no longer servable
      // between mint and redeem is refused.
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `the version is now ${version.status} and cannot be opened for a learner`,
      );
    }
    if (version.currentStageId !== payload.stageId) {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the version’s stage changed after this handoff was minted',
      );
    }

    const { payload: grant, token: grantToken } = buildEditorGrantPayload({
      tenantId: version.tenantId,
      versionId: version.id,
      stageId: version.currentStageId,
      capability: payload.capability,
      ...(payload.purpose === 'learner' && payload.learnerRef
        ? { learnerRef: payload.learnerRef }
        : {}),
    });
    const cookieValue = grantCookieValueForRedeem(req.headers, grantToken, grant.stageId);
    const response = NextResponse.redirect(
      new URL(`/classroom/${grant.stageId}`, req.nextUrl.origin),
      { status: 302, headers: { 'Referrer-Policy': 'no-referrer' } },
    );
    for (const cookie of editorGrantCookieHeaders(cookieValue, grant.learnerKey)) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to redeem editor handoff' } },
      { status: 500 },
    );
  }
}
