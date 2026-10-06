/**
 * PUT /api/teaching-packages/[id]/scene-objectives — attach Kafuo Learning
 * Objectives to a version's scenes (§9). Body:
 * `{ actorRef, assignments: [{ sceneId, learningObjectives }] }`.
 * Only draft|rejected versions accept objective writes; the stage guard and
 * the write-boundary validator both apply underneath.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  normalizeAssignment,
  setSceneLearningObjectives,
} from '@/lib/server/teaching-package/scene-objectives';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    if (!Array.isArray(body.assignments)) {
      throw new TeachingPackageError('INVALID_REQUEST', 'assignments must be an array');
    }
    const now = Date.now();
    const assignments = body.assignments.map((assignment) =>
      normalizeAssignment(assignment as { sceneId: unknown; learningObjectives: unknown }, now),
    );

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await setSceneLearningObjectives(pool, id, { tenantId: parseTenantContext(body) }, assignments);
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to set scene objectives' } },
      { status: 500 },
    );
  }
}
