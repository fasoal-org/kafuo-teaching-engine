/**
 * GET /api/teaching-packages/[id]/agent-book-reviews/[reviewId]?tenantId= — one
 * agent book review (Kafuo Agent API D2a): status, the spec §6.3 findings, the
 * groups, the model and the usage. Service key only; another tenant's or another
 * version's review → 404. Read-only.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  agentReviewWire,
  readAgentReview,
} from '@/lib/server/teaching-package/agent-book-review-store';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  parseTenantId,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id, reviewId } = await params;
    const tenantId = parseTenantId(req.nextUrl.searchParams.get('tenantId'));
    const version = await getTeachingPackageVersion(id, { tenantId });
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const review = await readAgentReview(pool as never, reviewId, {
      tenantId,
      versionId: version.id,
    });
    if (!review) throw new TeachingPackageError('NOT_FOUND', `agent review ${reviewId} not found`);
    return NextResponse.json(agentReviewWire(review), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the agent book review' } },
      { status: 500 },
    );
  }
}
