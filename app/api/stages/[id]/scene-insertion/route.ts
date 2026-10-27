/**
 * GET /api/stages/[id]/scene-insertion — the editor's gate for "Generate a
 * slide for a lesson part" (reviewer-generated-slide plan §15):
 * `{ capability, editable, versionStatus, supported, unsupportedReason, running }`.
 * Read and write grants may ask (the UI hides the action unless `write`,
 * `editable` and `supported`); no grant → 404. `running` lists the Stage's
 * running insertions and regenerations, for write grants only. Never writes.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import { learnerRefusalWithoutAccessCode } from '@/lib/server/teaching-package/editor-grant-tenant-access';
import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readSceneInsertionGate } from '@/lib/server/teaching-package/scene-insertion';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    const learnerRefusal = learnerRefusalWithoutAccessCode(
      req,
      readEditorGrant(req.headers, stageId),
    );
    if (learnerRefusal) return learnerRefusal;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: false });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const writable =
      grant.capability === 'write' && grant.purpose !== 'learner' && grant.purpose !== 'preview';
    const gate = await readSceneInsertionGate(pool, {
      tenantId: grant.tenantId,
      versionId: grant.versionId,
      stageId,
      capability: writable ? 'write' : 'read',
    });
    return NextResponse.json(gate, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide insertion gate');
  }
}
