/**
 * GET /api/stages/[id]/scene-insertions/[insertionId] — the status of one
 * slide insertion (reviewer-generated-slide plan §15): its state, the
 * immutable result snapshot and the per-Scene revision lineage of its write.
 * Write grants only; tenant + version + Stage scoped (any mismatch is a 404).
 * Its lazy reclaim of an expired lease locks only the insertion row.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readSceneInsertionForGrant } from '@/lib/server/teaching-package/scene-insertion';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; insertionId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId, insertionId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const status = await readSceneInsertionForGrant(
      pool,
      { tenantId: grant.tenantId, versionId: grant.versionId, stageId },
      { id: insertionId },
    );
    return NextResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide insertion status');
  }
}
