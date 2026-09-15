/**
 * POST /api/teaching-packages/[id]/successor — create a draft successor from an
 * approved version (§5/§7): the approved Stage is cloned server-side, the new
 * version row points at the clone, and the approved version is untouched.
 * Body: `{ actorRef, comment? }`. Answers `201 { version }`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { createSuccessor } from '@/lib/server/teaching-package/lifecycle';
import {
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    if (typeof body.actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const version = await createSuccessor(pool, {
      versionId: id,
      actorRef: body.actorRef,
      ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
    });
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('[TeachingPackages] Failed to create successor:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to create successor' } },
      { status: 500 },
    );
  }
}
