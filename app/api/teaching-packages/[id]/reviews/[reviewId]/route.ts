/**
 * GET /api/teaching-packages/[id]/reviews/[reviewId]?tenantId= — one AI
 * package review with its summary, findings (book quotes) and fixes
 * (ai-reviewer-layer contract §4.1). Service-to-service only (Kafuo Backend).
 * Another tenant's review, or a review of another version, is `404`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { packageReviewWire } from '@/lib/server/teaching-package/package-review';
import { readPackageReview } from '@/lib/server/teaching-package/package-review-store';
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
    const review = await readPackageReview(pool as never, reviewId, { tenantId });
    if (!review || review.versionId !== version.id) {
      throw new TeachingPackageError('NOT_FOUND', `package review ${reviewId} not found`);
    }
    return NextResponse.json(
      { review: packageReviewWire(review) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the package review' } },
      { status: 500 },
    );
  }
}
