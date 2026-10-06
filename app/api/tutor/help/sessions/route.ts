/**
 * `GET /api/tutor/help/sessions?versionId&stageId&sceneId[&beforeSeq&limit]`
 * — the learner's Help session for one Scene anchor with a message window
 * (Kafuo R1 contracts §5, P7). Learner grant cookie for the named Stage; the
 * `(versionId, stageId)` pair must be the grant's pinned one (else a
 * non-enumerating 404). An anchor without a session yet answers
 * `{ session: null, messages: [] }`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { withLearnerGrant } from '@/lib/server/tutor/guards';
import { getHelpSession } from '@/lib/server/tutor/help-service';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withLearnerGrant(req, async (request, ctx) => {
    const search = request.nextUrl.searchParams;
    const stageId = search.get('stageId') ?? '';
    if (!ctx.grants.some((grant) => grant.stageId === stageId)) {
      throw new TeachingPackageError('NOT_FOUND', 'no Help anchor for this version and stage');
    }
    const grant = ctx.forStage(stageId);
    const deps = await resolveTutorRuntimeDeps();
    const beforeSeq = Number(search.get('beforeSeq'));
    const limit = Number(search.get('limit'));
    const result = await getHelpSession(deps, grant, {
      versionId: search.get('versionId'),
      stageId,
      sceneId: search.get('sceneId'),
      beforeSeq: Number.isFinite(beforeSeq) && beforeSeq > 0 ? Math.floor(beforeSeq) : null,
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  });
}
