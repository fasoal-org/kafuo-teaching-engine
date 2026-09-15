/**
 * GET /api/teaching-packages/[id]/history — the append-only review history of
 * one version, in append order (FR-055).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import {
  getTeachingPackageVersion,
  listTeachingPackageReviewEvents,
} from '@/lib/server/teaching-package/resolve';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const version = await getTeachingPackageVersion(id);
    const events = await listTeachingPackageReviewEvents(version.id);
    return NextResponse.json({ events });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('[TeachingPackages] Failed to read history:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read review history' } },
      { status: 500 },
    );
  }
}
