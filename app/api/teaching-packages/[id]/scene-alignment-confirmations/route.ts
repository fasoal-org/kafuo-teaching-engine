/**
 * PUT /api/teaching-packages/[id]/scene-alignment-confirmations — record
 * durable reviewer confirmation of per-Scene alignment (Module 2 W15, plan §P
 * Step 16 · FR-TS-045/071 · VAL-TS-010 · AC-TS-032). Body:
 * `{ actorRef, confirmations: [{ sceneId }] }`.
 *
 * Only draft|rejected GOVERNED versions accept confirmations. The confirmation
 * baselines the Scene's current assignment, classification and material
 * fingerprint (identity plus state only — no rationale is persisted); validity
 * is recomputed at read, so any later material edit, Skill change or
 * classification change invalidates it by construction.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  confirmSceneAlignments,
  normalizeConfirmation,
} from '@/lib/server/teaching-package/scene-alignment';
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
    if (typeof body.actorRef !== 'string' || body.actorRef.trim() === '') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a non-empty string');
    }
    if (!Array.isArray(body.confirmations)) {
      throw new TeachingPackageError('INVALID_REQUEST', 'confirmations must be an array');
    }
    const confirmations = body.confirmations.map((confirmation) =>
      normalizeConfirmation(confirmation as { sceneId: unknown }),
    );

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await confirmSceneAlignments(
      pool,
      id,
      { tenantId: parseTenantContext(body), actorRef: body.actorRef },
      confirmations,
    );
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to confirm scene alignment' } },
      { status: 500 },
    );
  }
}
