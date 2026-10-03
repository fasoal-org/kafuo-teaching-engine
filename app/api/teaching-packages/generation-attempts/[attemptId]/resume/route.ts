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
 */
import { after, type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resumeGenerationAttempt } from '@/lib/server/teaching-package/generation-correction';
import { runGenerationAttempt } from '@/lib/server/teaching-package/generation-runner';
import {
  buildKafuoStartRequest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import { assertKafuoFlowWithoutGames } from '@/lib/server/teaching-package/kafuo-game-deferral';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  isSubjectCode,
  POLICY_VERSION,
  readRoutingMode,
} from '@/lib/server/teaching-model/subject-policy';

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
    if (typeof body.actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    const tenantId = parseTenantContext(body);
    const expectedRevision = body.expectedRevision;
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 1
    ) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'expectedRevision must be a positive integer',
      );
    }
    if (!body.request || typeof body.request !== 'object' || Array.isArray(body.request)) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'request must be the Kafuo generation request object',
      );
    }

    const { request, aggregate } = parseKafuoGenerationRequest(
      body.request as Record<string, unknown>,
    );
    // The tenant is server-scoped exactly once per call: the re-sent request
    // must name the tenant the resume is addressed to.
    if (aggregate.tenantId !== tenantId) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'request.tenantContext.tenantId must equal tenantContext.tenantId',
      );
    }
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    // The same subject-routing refusal the generate route applies (Kafuo R1
    // contracts §6, AMB-04): under TEACHING_SUBJECT_ROUTING=enforced an
    // unrouted subject is refused on the request, before any state changes.
    if (readRoutingMode() === 'enforced' && !isSubjectCode(kafuo.subjectCode)) {
      throw new TeachingPackageError(
        'SUBJECT_ROUTE_UNAVAILABLE',
        kafuo.subjectCode === null
          ? 'learningItem.subjectOffering.code is required: the subject has no routing key, so no teaching model route exists for it'
          : `learningItem.subjectOffering.code ${JSON.stringify(kafuo.subjectCode)} is not in the routing policy ${POLICY_VERSION}`,
        { subjectCode: kafuo.subjectCode, subjectOffering: kafuo.subjectOffering },
      );
    }

    // Kafuo Release 1 defers generated games: an attempt started under a flow
    // that requires or allows a game (g5.v2–v5) is refused before its state
    // changes. Its retained snapshot is not rewritten; abandon still works.
    assertKafuoFlowWithoutGames(request.teachingModel, 'resume');

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const { attempt, resumed } = await resumeGenerationAttempt(pool, attemptId, {
      tenantId,
      actorRef: body.actorRef,
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
