/**
 * GET /api/teaching-packages/[id]/reviews?tenantId= — every AI package review
 * of one version, newest first (ai-reviewer-layer contract §4.2).
 *
 * POST /api/teaching-packages/[id]/reviews — regenerate only the flagged
 * slides of a draft (owner, 15 Nov 2026): the current review's fix loop runs
 * again on the slides that still carry an open finding. Body:
 * `{ tenantContext: { tenantId }, idempotencyKey }`. 202 with the queued
 * review, the review it replaced and the slides to regenerate; a retry with the
 * same key returns the same review (`replayed: true`).
 *
 * Service-to-service only (Kafuo Backend). The review text (book quotes, the
 * reviewer's notes) travels here, never in a webhook (contract §1).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  listReviewsForVersion,
  packageReviewWire,
} from '@/lib/server/teaching-package/package-review-store';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  parseTenantContext,
  parseTenantId,
  readJsonObject,
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
    const reviews = await listReviewsForVersion(pool as never, version.id, { tenantId });
    return NextResponse.json(
      { reviews: reviews.map(packageReviewWire) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read package reviews' } },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const tenantId = parseTenantContext(body);
    if (typeof body.idempotencyKey !== 'string') {
      throw new TeachingPackageError('INVALID_REQUEST', 'idempotencyKey must be a string');
    }
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    // Loaded lazily, like the review sweep: the fix loop's module graph (slide
    // regeneration, narration) must not load for every reviews read.
    const { queueFlaggedSlideRefix } =
      await import('@/lib/server/teaching-package/package-review-refix');
    const queued = await queueFlaggedSlideRefix(pool as never, {
      tenantId,
      versionId: id,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(
      {
        review: packageReviewWire(queued.review),
        previousReviewId: queued.previousReviewId,
        sceneIds: queued.sceneIds,
        replayed: queued.replayed,
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to regenerate the flagged slides' } },
      { status: 500 },
    );
  }
}
