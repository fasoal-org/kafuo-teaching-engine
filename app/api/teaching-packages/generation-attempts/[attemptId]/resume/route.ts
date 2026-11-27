/**
 * POST /api/teaching-packages/generation-attempts/[attemptId]/resume — move a
 * corrected attempt `awaiting_admin_correction → queued` and run it again
 * under the SAME attempt id (slide-classification-admin-correction-plan §3.3).
 *
 * `request` is the attempt's own Kafuo generation request re-sent with FRESH
 * presigned URLs — the same shape POST /api/teaching-packages/generate
 * accepts. It is parsed with the same parser; its canonical digest (which
 * never covers `contentResource.url`) must equal the attempt's stored digest,
 * and the fresh `contentResource.url` lives in memory only, handed to the
 * runner. A replay of an already-resumed revision answers `resumed: false`
 * and schedules NO worker. Answers `202 { attempt, resumed }`.
 *
 * The body checks live in `parseCorrectionResumeBody`, shared with the Kafuo
 * Agent API's `agent-resume` route.
 */
import { after, type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
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
    const { tenantId, actorRef, expectedRevision, start, aggregate, ...parsed } =
      parseCorrectionResumeBody(body);

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    // A pinned regeneration (plan D-18) resumes on the same original route, refused
    // before the attempt's state changes when that route can no longer run.
    const kafuo =
      (await resolveOriginalRoutePin(pool as never, parsed.kafuo))?.kafuo ?? parsed.kafuo;
    const { attempt, resumed } = await resumeGenerationAttempt(pool, attemptId, {
      tenantId,
      actorRef,
      expectedRevision,
      // buildKafuoStartRequest always computes the digest for a Kafuo request.
      requestDigest: start.requestDigest!,
      learningItem: aggregate.learningItem,
    });
    // Only the resume that won the compare-and-set runs the attempt. A replay
    // of an already-resumed revision returns the attempt untouched —
    // scheduling a worker for it would race the one already started.
    if (resumed) {
      after(() => runGenerationAttempt(attempt.id, start.generation, kafuo, { resume: true }));
    }
    // The 202 body echoes the attempt (snapshot) — never the fresh URL.
    return NextResponse.json({ attempt, resumed }, { status: 202 });
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
