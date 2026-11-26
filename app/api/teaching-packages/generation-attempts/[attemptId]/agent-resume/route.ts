/**
 * POST /api/teaching-packages/generation-attempts/[attemptId]/agent-resume — the Kafuo
 * Agent API's C1 resume (agent API plan §8 E2, `correction:write`).
 *
 * Service-to-service only (Kafuo Backend, service key). The same body checks
 * (`parseCorrectionResumeBody`) and the same service (`resumeGenerationAttempt`) as the
 * administrator's `.../resume`, with `actorRef` = `agent:<user id>` only, and:
 *
 * - `dryRun: true` → every resume check runs (request digest, revision, plan review,
 *   open issues) and nothing changes: `200 { attempt, resumed: false, dryRun: true,
 *   wouldResume }`. `wouldResume: false` means the revision was already resumed (a
 *   replay). No worker is scheduled.
 * - otherwise `202 { attempt, resumed, dryRun: false }`, exactly as `.../resume`: only
 *   the resume that won the compare-and-set schedules the run.
 *
 * There is no agent route to abandon an attempt.
 */
import { after, type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { assertAgentActorRef, parseDryRun } from '@/lib/server/teaching-package/agent-correction';
import { parseCorrectionResumeBody } from '@/lib/server/teaching-package/correction-resume-request';
import { resolveOriginalRoutePin } from '@/lib/server/teaching-package/original-route-pin';
import { resumeGenerationAttempt } from '@/lib/server/teaching-package/generation-correction';
import { runGenerationAttempt } from '@/lib/server/teaching-package/generation-runner';
import {
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { attemptId } = await params;
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    assertAgentActorRef(body.actorRef);
    const dryRun = parseDryRun(body.dryRun);
    const { tenantId, actorRef, expectedRevision, start, aggregate, ...parsed } =
      parseCorrectionResumeBody(body);

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    // A pinned regeneration (plan D-18) resumes on the same original route, refused
    // before the attempt's state changes when that route can no longer run.
    const kafuo =
      (await resolveOriginalRoutePin(pool as never, parsed.kafuo))?.kafuo ?? parsed.kafuo;
    const result = await resumeGenerationAttempt(pool, attemptId, {
      tenantId,
      actorRef,
      expectedRevision,
      // buildKafuoStartRequest always computes the digest for a Kafuo request.
      requestDigest: start.requestDigest!,
      learningItem: aggregate.learningItem,
      dryRun,
    });
    if (dryRun) {
      return NextResponse.json(
        {
          attempt: result.attempt,
          resumed: false,
          dryRun: true,
          wouldResume: result.wouldResume === true,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (result.resumed) {
      const attempt = result.attempt;
      after(() => runGenerationAttempt(attempt.id, start.generation, kafuo, { resume: true }));
    }
    // The 202 body echoes the attempt (snapshot) — never the fresh URL.
    return NextResponse.json(
      { attempt: result.attempt, resumed: result.resumed, dryRun: false },
      { status: 202 },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to resume generation attempt' } },
      { status: 500 },
    );
  }
}
