/**
 * GET /api/stages/[id]/scene-regenerations/[regenerationId] — the status of
 * one slide regeneration (single-slide-regeneration-plan §9.6): its state, the
 * immutable result snapshot, and what the database holds for the Scene now.
 * Write grants only. Its lazy reclaim of an expired lease locks only the
 * regeneration row (never `stage_meta` or Scenes).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readSceneRegenerationForGrant } from '@/lib/server/teaching-package/scene-regeneration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; regenerationId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId, regenerationId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const status = await readSceneRegenerationForGrant(pool, grant, { id: regenerationId });
    return NextResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide regeneration status');
  }
}
