/**
 * GET /api/teaching-packages?learningItemType&learningItemId — list every
 * version of one Learning Item in stable version order (FR-007).
 *
 * Server-to-server only: gated on `isTeachingPackageApiConfigured()` (plain
 * 404 when off) and authenticated with the Teaching Engine service key. The
 * response carries version rows only; no owner identity is ever returned.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  parseAggregateScope,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { listTeachingPackageVersions } from '@/lib/server/teaching-package/resolve';
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
    const versions = await listTeachingPackageVersions(aggregate);
    return NextResponse.json({ versions });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to list teaching package versions' } },
      { status: 500 },
    );
  }
}
