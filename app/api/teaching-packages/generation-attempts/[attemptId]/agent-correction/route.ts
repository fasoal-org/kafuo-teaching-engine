/**
 * PATCH /api/teaching-packages/generation-attempts/[attemptId]/agent-correction —
 * the Kafuo Agent API's C1 correction edit (agent API plan §8 E2, `correction:write`).
 *
 * Service-to-service only (Kafuo Backend, service key). The same service as the
 * administrator's PATCH `.../correction` (`editGenerationCorrection`: revision
 * compare-and-set, stale → 409 `STALE_STATE`, the run's own diagnosis), with:
 *
 * - `actorRef` = `agent:<user id>` only;
 * - only the engine's five operations (`set`, `remove`, `move`, `insert_book_slide`,
 *   `ignore_issue`); `review_plan` / `revert_fix` → 422 `AGENT_ACTION_NOT_ALLOWED`;
 * - `dryRun: true` → every check and the diagnosis run and the view the edit would
 *   produce is returned, with the stored `revision`; nothing is saved.
 *
 * Body `{ tenantContext, actorRef, expectedRevision, operations[], dryRun? }`;
 * `200 { correction, dryRun }`. There is no agent route to abandon an attempt.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  assertAgentActorRef,
  assertAgentCorrectionOperations,
  parseDryRun,
} from '@/lib/server/teaching-package/agent-correction';
import { editGenerationCorrection } from '@/lib/server/teaching-package/generation-correction';
import { parseCorrectionOperations } from '@/lib/server/teaching-package/outline-correction';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

export const runtime = 'nodejs';

export async function PATCH(
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
    const actorRef = assertAgentActorRef(body.actorRef);
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
    const dryRun = parseDryRun(body.dryRun);
    const operations = parseCorrectionOperations(body.operations);
    assertAgentCorrectionOperations(operations);

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const correction = await editGenerationCorrection(pool, attemptId, {
      tenantId,
      actorRef,
      expectedRevision,
      operations,
      dryRun,
    });
    return NextResponse.json({ correction, dryRun }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to edit generation correction' } },
      { status: 500 },
    );
  }
}
