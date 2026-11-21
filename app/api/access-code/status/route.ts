import { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/lib/server/access-token';
import { holdsTenantEditorGrant } from '@/lib/server/teaching-package/editor-grant-tenant-access';

export const runtime = 'nodejs';

/** Same charset as `isValidClassroomId` and `STAGE_ID` in the access-code allowlist. */
const STAGE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The access-code status the client guard asks for.
 *
 * `editorGrantCovered` (owner, 21 Nov 2026): a browser that redeemed an editor handoff
 * holds a Stage-scoped `teaching_package_grant` and no access cookie. Roles phase 1 O1
 * exempts every editor API that grant needs, but the guard itself still showed the
 * undismissable access-code modal. When `ACCESS_CODE` is set, the access cookie is not
 * valid, and the request names the classroom Stage it is opening, the grant check of
 * D-O1-1/2 (`holdsTenantEditorGrant`: signature and expiry, non-learner purpose, Stage
 * owned by the grant's tenant, fails closed) decides: with a covering grant the guard
 * skips the modal for exactly that classroom. The response echoes nothing from the
 * grant itself — no tenant, version, capability or expiry.
 */
export async function GET(req: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const token = req.cookies.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  let editorGrantCovered = false;
  if (enabled && !authenticated) {
    const stageId = req.nextUrl.searchParams.get('stageId');
    if (stageId && STAGE_ID_RE.test(stageId)) {
      editorGrantCovered = await holdsTenantEditorGrant(req.headers, stageId);
    }
  }

  return apiSuccess({ enabled, authenticated, editorGrantCovered });
}
