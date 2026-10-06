/**
 * GET /api/teaching-packages/[id] — version detail (FR-008): the version row,
 * the attempt that produced its current Stage (when there is one), and the
 * Editor entry URLs for its Stage.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  parseTenantId,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import {
  getGenerationAttempt,
  getTeachingPackageVersion,
} from '@/lib/server/teaching-package/resolve';
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
    const currentAttempt = version.currentAttemptId
      ? await getGenerationAttempt(version.currentAttemptId, {
          tenantId: version.tenantId,
        }).catch(() => null)
      : null;
    return NextResponse.json({
      version,
      ...(currentAttempt ? { currentAttempt } : {}),
      editorUrls: {
        classroom: `/classroom/${version.currentStageId}`,
        workspace: `/workspace?course=${version.currentStageId}`,
      },
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read teaching package version' } },
      { status: 500 },
    );
  }
}
