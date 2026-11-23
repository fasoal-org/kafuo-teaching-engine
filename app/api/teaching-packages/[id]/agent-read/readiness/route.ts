/**
 * GET /api/teaching-packages/[id]/agent-read/readiness?tenantId= — whether
 * the package can be sent for approval, and every reason it cannot (Kafuo
 * Agent API plan §1.5, §3.3): status, the editor lock, `submitBlockers()` (the
 * Submit gate's own predicates, collected instead of thrown) and counts.
 *
 * Service-to-service only (Kafuo Backend, service key), read-only: it never
 * submits, locks, reclaims a lease or screens an image. Unknown version or
 * another tenant's → 404. Never cached.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { loadAgentReadiness } from '@/lib/server/teaching-package/agent-read/load';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  parseTenantId,
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
    const tenantId = parseTenantId(req.nextUrl.searchParams.get('tenantId'));
    const version = await getTeachingPackageVersion(id, { tenantId });
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const body = await loadAgentReadiness(pool as never, version);
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read package readiness' } },
      { status: 500 },
    );
  }
}
