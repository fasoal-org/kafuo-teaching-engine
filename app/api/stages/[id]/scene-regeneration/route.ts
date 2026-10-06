/**
 * GET /api/stages/[id]/scene-regeneration — the editor's gate for the
 * "Regenerate slide" action (single-slide-regeneration-plan §12.1):
 * `{ capability, editable, versionStatus, supportedSceneTypes, running }`.
 * Read and write grants may ask (the UI hides the action unless `write` and
 * `editable`); no grant → 404 and the action stays hidden. Never writes.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readSceneRegenerationGate } from '@/lib/server/teaching-package/scene-regeneration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: false });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const writable =
      grant.capability === 'write' && grant.purpose !== 'learner' && grant.purpose !== 'preview';
    const gate = await readSceneRegenerationGate(pool, {
      versionId: grant.versionId,
      stageId,
      capability: writable ? 'write' : 'read',
    });
    return NextResponse.json(gate, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide regeneration gate');
  }
}
