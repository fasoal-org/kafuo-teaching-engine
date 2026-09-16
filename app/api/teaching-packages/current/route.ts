/**
 * GET /api/teaching-packages/current?learningItemType&learningItemId — resolve
 * the approved/current package for one Learning Item (FR-009/010).
 *
 * `200 { kind: 'approved', version, stageId }` or `200 { kind: 'none' }`; the
 * resolver never falls back to a draft, rejected, superseded, or discarded
 * version. An approved version whose Stage is not live is an integrity
 * violation and answers 422 STAGE_NOT_LIVE.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  parseAggregateScope,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { resolveApprovedTeachingPackage } from '@/lib/server/teaching-package/resolve';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const params = req.nextUrl.searchParams;
    const aggregate = parseAggregateScope(
      params.get('tenantId'),
      params.get('learningItemType'),
      params.get('learningItemId'),
    );
    const resolution = await resolveApprovedTeachingPackage(aggregate);
    if (resolution.kind === 'none') return NextResponse.json({ kind: 'none' });
    return NextResponse.json({
      kind: 'approved',
      version: resolution.version,
      stageId: resolution.stageId,
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to resolve current package' } },
      { status: 500 },
    );
  }
}
