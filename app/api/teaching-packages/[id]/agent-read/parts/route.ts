/**
 * GET /api/teaching-packages/[id]/agent-read/parts?tenantId= — the editor's
 * «أجزاء الدرس» for review bots (Kafuo Agent API plan §3.3, spec §5.6): each
 * lesson part with the same badge and "Generate slide" rule the editor panel
 * shows, the slides that teach it and whether Submit requires it.
 *
 * Service-to-service only (Kafuo Backend, service key), read-only, no unit
 * text. Unknown version or another tenant's → 404.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { loadAgentParts } from '@/lib/server/teaching-package/agent-read/load';
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
    const body = await loadAgentParts(pool as never, version);
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read package lesson parts' } },
      { status: 500 },
    );
  }
}
