/**
 * GET /api/teaching-packages/editor-handoff?token=… — redeem a handoff token
 * (browser route; the token IS the credential — no service key). Verifies the
 * HMAC and expiry, re-checks the version (write grants only for draft|
 * rejected; `currentStageId` must still equal the token's stage — a
 * regeneration between mint and redeem invalidates the token), then sets the
 * HttpOnly Stage-scoped grant cookie plus the readable companion learner-key
 * cookie and redirects to the classroom.
 *
 * ET-16 (a), launch plan Wave 2: a LEARNER handoff is single-use. Right after
 * the signature check its nonce is claimed (`claimLearnerHandoffOnce`, durable
 * across instances); a second redeem of the same token is `GRANT_INVALID` (401,
 * no cookie), the same refusal a replayed student handoff gets, and the app
 * asks Kafuo for a fresh handoff. Edit and preview handoffs (admin browser
 * redirects) are not claimed and behave exactly as before.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  LEARNER_HANDOFF_STATUSES,
  buildEditorGrantPayload,
  claimLearnerHandoffOnce,
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
    // ET-16 (a): one grant per learner handoff. Edit/preview are never claimed.
    if (payload.purpose === 'learner' && !(await claimLearnerHandoffOnce(payload))) {
      throw new TeachingPackageError(
        'GRANT_INVALID',
        'the learner handoff token was already redeemed',
      );
    }

    // The token carries the canonical tenant; a version under a different
    // tenant behaves exactly like an absent one (non-enumerating NOT_FOUND).
    const version = await getTeachingPackageVersionByToken(payload.versionId);
    if (version.tenantId !== payload.tenantId) {
      throw new TeachingPackageError(
        'NOT_FOUND',
        `teaching package ${payload.versionId} not found`,
      );
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
      ...(payload.purpose ? { purpose: payload.purpose } : {}),
      // Kafuo R1 (contracts §3.2): the student block rides from handoff to grant.
      ...(payload.purpose === 'learner' && payload.student ? { student: payload.student } : {}),
    });
    const cookieValue = grantCookieValueForRedeem(req.headers, grantToken, grant.stageId);
    // A native client asks for JSON: the IDENTICAL verification and cookies,
    // answered as `200 { stageId, capability, documentPath, expiresAt }` rather
    // than a redirect it would have to refuse to follow. Browser behaviour is
    // byte-for-byte unchanged.
    const wantsJson = (req.headers.get('accept') ?? '').includes('application/json');
    // The redirect is RELATIVE, so the browser stays on the origin it reached
    // this route through. `req.nextUrl.origin` is the server's own bind address
    // behind a proxy (`http://0.0.0.0:3000` on staging behind Tailscale Serve),
    // which no browser can open. The base below only builds the path and query.
    const classroomUrl = new URL(`/classroom/${grant.stageId}`, 'http://relative.invalid');
    // An Admin "Edit" handoff is an explicit request to edit. Carry that
    // intent through the redirect so the classroom opens Pro mode directly;
    // making the reviewer toggle a second, unrelated control left the
    // Teaching Skills surface hidden and made a successful handoff look like
    // read-only preview.
    if (grant.purpose === 'edit' && grant.capability === 'write') {
      classroomUrl.searchParams.set('mode', 'edit');
    }
    const classroomLocation = `${classroomUrl.pathname}${classroomUrl.search}`;
    const response = wantsJson
      ? NextResponse.json(
          {
            stageId: grant.stageId,
            capability: grant.capability,
            documentPath: `/api/persistence/documents/${grant.stageId}`,
            expiresAt: grant.exp,
          },
          {
            status: 200,
            headers: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
          },
        )
      : new NextResponse(null, {
          status: 302,
          headers: { Location: classroomLocation, 'Referrer-Policy': 'no-referrer' },
        });
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
