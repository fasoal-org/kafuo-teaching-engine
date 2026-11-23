/**
 * GET /api/teaching-packages/[id]/agent-ops/ops/[opId]?tenantId= — the status of
 * an agent editor op (agent API plan §8 E3): the regeneration or insertion row
 * its key names (`rg_<key>` / `in_<key>`), read the way the editor's own status
 * GET reads it. Another version's or tenant's op → 404.
 *
 * Service-to-service only (Kafuo Backend, service key). `200` = done or failed,
 * `202` = still running.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { opStatus } from '@/lib/server/teaching-package/agent-ops';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  parseTenantId,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; opId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id, opId } = await params;
    const tenantId = parseTenantId(req.nextUrl.searchParams.get('tenantId'));
    const version = await getTeachingPackageVersion(id, { tenantId });
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const answer = await opStatus({ pool: pool as never, version, tenantId }, opId);
    return NextResponse.json(answer.body, {
      status: answer.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the agent editor op' } },
      { status: 500 },
    );
  }
}
