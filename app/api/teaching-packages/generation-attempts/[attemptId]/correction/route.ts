/**
 * GET   /api/teaching-packages/generation-attempts/[attemptId]/correction —
 *       the administrator's view of an attempt paused with
 *       `awaiting_admin_correction` (slide-classification-admin-correction-plan
 *       §3.3): candidate outlines, blocking + repaired diagnostics, flow
 *       positions, and the revision an edit or resume must name.
 * PATCH same path — apply `set` / `remove` / `move` operations to the paused
 *       candidate under a revision compare-and-set (stale → 409 STALE_STATE);
 *       the edited candidate is revalidated with the run's own diagnosis.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  editGenerationCorrection,
  getGenerationCorrection,
} from '@/lib/server/teaching-package/generation-correction';
import { parseCorrectionOperations } from '@/lib/server/teaching-package/outline-correction';
import {
  parseTenantContext,
  parseTenantId,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { attemptId } = await params;
    const tenantId = parseTenantId(req.nextUrl.searchParams.get('tenantId'));
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const correction = await getGenerationCorrection(pool, attemptId, { tenantId });
    return NextResponse.json({ correction });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read generation correction' } },
      { status: 500 },
    );
  }
}

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
    const operations = parseCorrectionOperations(body.operations);

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const correction = await editGenerationCorrection(pool, attemptId, {
      tenantId,
      actorRef: body.actorRef,
      expectedRevision,
      operations,
    });
    return NextResponse.json({ correction });
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
