/**
 * GET /api/teaching-packages/[id]/introduction?tenantId&learningItemType&learningItemId
 * — the student lesson-entry introduction of one APPROVED version.
 *
 * Service-to-service only (Kafuo Backend). Read-only and approved-only: the caller
 * names the exact version its readiness verdict evaluated, and TE refuses any other
 * status, another tenant's version, or another Learning Item's version. See
 * `lib/server/teaching-package/approved-introduction.ts` for the projection.
 *
 * `200 { versionId, teachingModel, introduction: { context, whyThisLesson, overview } }`
 * `404 NOT_FOUND` · `409 TEACHING_PACKAGE_NOT_APPROVED` · `422 STAGE_NOT_LIVE |
 * INTRODUCTION_FLOW_UNSUPPORTED | INTRODUCTION_INCOMPLETE`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readApprovedIntroduction } from '@/lib/server/teaching-package/approved-introduction';
import {
  parseAggregateScope,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const search = req.nextUrl.searchParams;
    const aggregate = parseAggregateScope(
      search.get('tenantId'),
      search.get('learningItemType'),
      search.get('learningItemId'),
    );
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await readApprovedIntroduction(pool, {
      versionId: id,
      tenantId: aggregate.tenantId,
      learningItem: aggregate.learningItem,
    });
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the lesson introduction' } },
      { status: 500 },
    );
  }
}
