/**
 * GET /api/teaching-packages/generation-attempts/[attemptId] — the generation
 * attempt's polling view: status, progress, error, versionId, stageId. The
 * attempt row carries only the lightweight input snapshot; the transient
 * execution input was never persisted and is never echoed here.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { getGenerationAttempt } from '@/lib/server/teaching-package/resolve';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { attemptId } = await params;
    const attempt = await getGenerationAttempt(attemptId);
    return NextResponse.json({ attempt });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('[TeachingPackages] Failed to read generation attempt:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read generation attempt' } },
      { status: 500 },
    );
  }
}
