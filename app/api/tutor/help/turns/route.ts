/**
 * `POST /api/tutor/help/turns` — one Stage Help turn as SSE (Kafuo R1
 * contracts §0 H2, §5; plan §4.2 "Help turn", P7).
 *
 * Body `{ versionId, stageId, sceneId, stepRef?, clientMessageId, text,
 * intentHint? }`. Learner grant cookie (`purpose: 'learner'` + student block)
 * for exactly the Stage named in the body, plus the per-grant turn token
 * bucket (`RATE_LIMITED` 429). A body whose `(versionId, stageId)` is not
 * the grant's pinned pair, or whose Scene is not in that Stage, is a
 * non-enumerating 404. Pre-stream refusals are JSON with their HTTP status
 * (`422 HELP_GROUNDING_UNAVAILABLE`, `422 SUBJECT_ROUTE_UNAVAILABLE`,
 * `409 TURN_IN_PROGRESS` + `Retry-After`, `422 REQUEST_TOO_LARGE`,
 * `429 ALLOWANCE_EXHAUSTED`, `503 METER_UNAVAILABLE`); everything after the
 * reservation streams as SSE events. Node runtime, 120 s.
 */
import type { NextRequest } from 'next/server';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { readJsonObject } from '@/lib/server/teaching-package/route-helpers';
import { withLearnerGrant } from '@/lib/server/tutor/guards';
import { runHelpTurn } from '@/lib/server/tutor/help-service';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  return withLearnerGrant(
    req,
    async (request, ctx) => {
      const body = await readJsonObject(request);
      if (!body)
        throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
      const stageId = typeof body.stageId === 'string' ? body.stageId : '';
      // A Stage the cookie holds no learner grant for reads like an absent anchor
      // (non-enumerating), not like a credential problem.
      if (!ctx.grants.some((grant) => grant.stageId === stageId)) {
        throw new TeachingPackageError('NOT_FOUND', 'no Help anchor for this version and stage');
      }
      const grant = ctx.forStage(stageId);
      const deps = await resolveTutorRuntimeDeps();
      return runHelpTurn(deps, {
        grant,
        versionId: body.versionId,
        stageId: body.stageId,
        sceneId: body.sceneId,
        stepRef: body.stepRef,
        clientMessageId: body.clientMessageId,
        text: body.text,
        intentHint: body.intentHint,
        requestSignal: request.signal,
      });
    },
    { rateLimit: true },
  );
}
