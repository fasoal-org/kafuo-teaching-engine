/**
 * GET /api/teaching-packages/[id]/outline?tenantId&learningItemType&learningItemId
 * — the scene outline of one APPROVED version, for Kafuo's guided teaching runner.
 *
 * Service-to-service only (Kafuo Backend). Read-only and approved-only. Structure
 * only (ids, order, type, flow position, content role, title, narration flag); the
 * learner reads scene content through the learner handoff. See
 * `lib/server/teaching-package/approved-outline.ts`.
 *
 * `200 { versionId, stageId, teachingModel, objectiveRefs, flowStages, scenes }`
 * `404 NOT_FOUND` · `409 TEACHING_PACKAGE_NOT_APPROVED` · `422 STAGE_NOT_LIVE`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readApprovedOutline } from '@/lib/server/teaching-package/approved-outline';
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
    const result = await readApprovedOutline(pool, {
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
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the teaching package outline' } },
      { status: 500 },
    );
  }
}
