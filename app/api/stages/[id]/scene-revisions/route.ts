/**
 * GET /api/stages/[id]/scene-revisions — the grant-scoped freshness manifest
 * (single-slide-regeneration-plan §11.2): `{ rev, scenes: [{ id, order, rev }] }`,
 * the existing `readStageFreshnessManifest` reader and response contract behind
 * the Editor grant checks every grant route runs (the agent-runtime
 * `/manifest` route is not grant-scoped). The editor reads it before and
 * after loading the document, and binds a Scene's revision to the content only
 * when the two reads agree. Ids, orders and revisions only — no content.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { readStageFreshnessManifest } from '@openmaic/storage';

import { readEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import { learnerRefusalWithoutAccessCode } from '@/lib/server/teaching-package/editor-grant-tenant-access';
import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    // D-O1-5: the grant `resolveRegenerationGrant` resolves; a learner keeps
    // the middleware's old 401 without the access code.
    const learnerRefusal = learnerRefusalWithoutAccessCode(
      req,
      readEditorGrant(req.headers, stageId),
    );
    if (learnerRefusal) return learnerRefusal;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: false });
    if (!resolved.ok) return resolved.response;
    const manifest = await readStageFreshnessManifest(stageId, resolved.value.pool);
    return NextResponse.json(manifest, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'scene revisions');
  }
}
