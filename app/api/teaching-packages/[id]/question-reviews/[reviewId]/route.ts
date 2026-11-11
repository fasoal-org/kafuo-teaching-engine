/**
 * GET /api/teaching-packages/[id]/question-reviews/[reviewId]?tenantId= — one
 * question-set review with every verdict, finding and repair note
 * (ai-reviewer-layer contract §4.4). Service-to-service only (Kafuo Backend).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  questionReviewWire,
  readQuestionReview,
} from '@/lib/server/teaching-package/question-review-store';
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
    const review = await readQuestionReview(pool as never, reviewId, { tenantId });
    if (!review || review.versionId !== version.id) {
      throw new TeachingPackageError('NOT_FOUND', `question review ${reviewId} not found`);
    }
    return NextResponse.json(
      { questionReview: questionReviewWire(review) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the question review' } },
      { status: 500 },
    );
  }
}
