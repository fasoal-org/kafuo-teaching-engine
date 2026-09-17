/**
 * PUT /api/stages/[stageId]/scene-alignment-confirmations — the Editor's
 * reviewer confirmation entry (Module 2 W16, plan §P Step 17 · FR-TS-045/071 ·
 * AC-TS-032). Body: `{ confirmations: [{ sceneId }] }`.
 *
 * Authorization reuses the Editor grant (`write` capability) plus the existing
 * status guard underneath — no new machinery. The actor recorded on the
 * baseline is derived server-side from the grant's Stage scope; the browser
 * never supplies reviewer identity.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readVersionById } from '@/lib/persistence/teaching-package';
import { readEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import {
  confirmSceneAlignments,
  normalizeConfirmation,
} from '@/lib/server/teaching-package/scene-alignment';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  try {
    const { stageId } = await params;
    const grant = readEditorGrant(req.headers, stageId);
    if (!grant) return new Response('Not found', { status: 404 });
    if (grant.capability !== 'write') {
      return NextResponse.json(
        {
          error: {
            code: 'READ_ONLY_GRANT',
            message: 'a read grant cannot confirm scene alignment',
          },
        },
        { status: 403 },
      );
    }
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const version = await readVersionById(pool, grant.versionId);
    if (!version || version.tenantId !== grant.tenantId || version.currentStageId !== stageId) {
      return new Response('Not found', { status: 404 });
    }
    const body = (await req.json().catch(() => null)) as { confirmations?: unknown } | null;
    if (!body || !Array.isArray(body.confirmations)) {
      throw new TeachingPackageError('INVALID_REQUEST', 'confirmations must be an array');
    }
    const confirmations = body.confirmations.map((confirmation) =>
      normalizeConfirmation(confirmation as { sceneId: unknown }),
    );
    const result = await confirmSceneAlignments(
      pool,
      version.id,
      // Server-derived actor: the grant carries no reviewer identity, and the
      // browser must not be able to name one.
      { tenantId: grant.tenantId, actorRef: `teaching-package-editor:${stageId}` },
      confirmations,
    );
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('scene alignment confirmation failed', error);
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
