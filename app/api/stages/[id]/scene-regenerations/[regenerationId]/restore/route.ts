/**
 * POST /api/stages/[id]/scene-regenerations/[regenerationId]/restore — put
 * back the slide a regeneration replaced (single-slide-regeneration-plan §13).
 * Write grants only; allowed once, and only while the Scene is still exactly
 * the regenerated one (else 409 SCENE_CHANGED_SINCE_REGENERATION).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { restoreSlideScene } from '@/lib/server/teaching-package/scene-regeneration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; regenerationId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId, regenerationId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const restored = await restoreSlideScene(pool, grant, regenerationId);
    return NextResponse.json(restored, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide regeneration restore');
  }
}
