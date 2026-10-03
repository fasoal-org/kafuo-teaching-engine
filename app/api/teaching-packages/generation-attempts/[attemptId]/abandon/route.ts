/**
 * POST /api/teaching-packages/generation-attempts/[attemptId]/abandon — give
 * up a candidate paused with `awaiting_admin_correction`
 * (slide-classification-admin-correction-plan §3.3). The attempt fails with
 * the retryable `ADMIN_CORRECTION_ABANDONED`, any retained Stage is
 * compensated, and the failure webhook is emitted. Idempotent: an already
 * abandoned attempt answers `abandoned: false`. Answers `200 { attempt,
 * abandoned }`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { abandonGenerationAttempt } from '@/lib/server/teaching-package/generation-correction';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

export const runtime = 'nodejs';

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

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    // The service owns the reason rule (REASON_REQUIRED / length); a
    // non-string is handed over as empty so it gets that refusal, not a 500.
    const { attempt, abandoned } = await abandonGenerationAttempt(pool, attemptId, {
      tenantId,
      actorRef: body.actorRef,
      reason: typeof body.reason === 'string' ? body.reason : '',
    });
    return NextResponse.json({ attempt, abandoned });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to abandon generation attempt' } },
      { status: 500 },
    );
  }
}
