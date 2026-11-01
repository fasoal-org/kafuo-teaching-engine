/**
 * GET /api/teaching-packages/[id]/quizzes?tenantId&learningItemType&learningItemId
 * — the quiz Scenes of one APPROVED version WITH their answer keys, for the Kafuo
 * Backend to save the reviewed check questions in its question bank at approval
 * (slide-questions plan rev 2, 1 Nov 2026).
 *
 * Service-to-service only (Kafuo Backend). Read-only and approved-only, with the
 * outline's scope and status rules. A W6 placeholder quiz is marked
 * `questionSource: 'bank'` and carries no questions. See
 * `lib/server/teaching-package/approved-outline.ts`.
 *
 * `200 { versionId, stageId, scenes }`
 * `404 NOT_FOUND` · `409 TEACHING_PACKAGE_NOT_APPROVED` · `422 STAGE_NOT_LIVE`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readApprovedQuizzes } from '@/lib/server/teaching-package/approved-outline';
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
    const result = await readApprovedQuizzes(pool, {
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
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the teaching package quizzes' } },
      { status: 500 },
    );
  }
}
