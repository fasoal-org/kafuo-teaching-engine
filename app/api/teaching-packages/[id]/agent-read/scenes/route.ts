/**
 * GET /api/teaching-packages/[id]/agent-read/scenes?tenantId= — the package's
 * scenes as review bots read them (Kafuo Agent API plan §3.3, spec §5.5):
 * plain and rich text, numbers, element boxes, overlaps, textbook image,
 * narration audio, quiz keys, Skill checks, alignment and generation flags.
 *
 * Service-to-service only (Kafuo Backend, service key), read-only. Unknown
 * version or another tenant's → 404. The mapping lives in
 * `lib/server/teaching-package/agent-read/`; the projection is cached in
 * memory by (version, stage, stage revision).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { loadAgentScenes } from '@/lib/server/teaching-package/agent-read/load';
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
    const body = await loadAgentScenes(pool as never, version);
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read package scenes' } },
      { status: 500 },
    );
  }
}
