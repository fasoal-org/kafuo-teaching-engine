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
  buildEditorGrantPayload,
  editorGrantCookieHeaders,
  grantCookieValueForRedeem,
  verifyEditorHandoffToken,
} from '@/lib/server/teaching-package/editor-grant';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    const token = req.nextUrl.searchParams.get('token') ?? '';
    const payload = verifyEditorHandoffToken(token);
    if (!payload) {
      throw new TeachingPackageError('INVALID_REQUEST', 'the handoff token is invalid or expired');
    }

    const version = await getTeachingPackageVersion(payload.versionId);
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
    if (version.currentStageId !== payload.stageId) {
      throw new TeachingPackageError(
        'STALE_STATE',
        'the version’s stage changed after this handoff was minted',
      );
    }

    const { payload: grant, token: grantToken } = buildEditorGrantPayload({
      versionId: version.id,
      stageId: version.currentStageId,
      capability: payload.capability,
    });
    const cookieValue = grantCookieValueForRedeem(req.headers, grantToken, grant.stageId);
    const response = NextResponse.redirect(
      new URL(`/classroom/${grant.stageId}`, req.nextUrl.origin),
      { status: 302 },
    );
    for (const cookie of editorGrantCookieHeaders(cookieValue, grant.learnerKey)) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('[TeachingPackages] Failed to redeem editor handoff:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to redeem editor handoff' } },
      { status: 500 },
    );
  }
}
