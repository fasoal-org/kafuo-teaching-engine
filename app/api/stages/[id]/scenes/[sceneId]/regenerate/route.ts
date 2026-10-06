/**
 * /api/stages/[id]/scenes/[sceneId]/regenerate — reviewer-driven single-slide
 * regeneration (single-slide-regeneration-plan §14).
 *
 * POST `{ instruction, reason, idempotencyKey }`: regenerate ONE slide of the
 * grant's editable Teaching Package Stage. `instruction` is sent to the model;
 * `reason` is an audit field only. The Stage, version, tenant and actor all
 * come from the Editor grant, never from the body. 200 = the slide was
 * replaced (or the replay of a success); 202 = the same request is still
 * running. The run deliberately ignores `req.signal`: a client disconnect
 * never cancels a paid generation half-way.
 *
 * GET `?key=<idempotencyKey>`: the status of the regeneration that key named
 * (write grants only) — how a client that lost the POST response settles.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readJsonObject } from '@/lib/server/teaching-package/route-helpers';
import {
  parseSceneRegenerationRequest,
  readSceneRegenerationForGrant,
  regenerateSlideScene,
} from '@/lib/server/teaching-package/scene-regeneration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; sceneId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId, sceneId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const request = parseSceneRegenerationRequest(await readJsonObject(req));
    const result = await regenerateSlideScene(
      {
        tenantId: grant.tenantId,
        versionId: grant.versionId,
        stageId,
        learnerKey: grant.learnerKey,
      },
      sceneId,
      request,
      { pool },
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide regeneration');
  }
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const key = req.nextUrl.searchParams.get('key');
    if (!key) return new Response('Not found', { status: 404 });
    const status = await readSceneRegenerationForGrant(pool, grant, { idempotencyKey: key });
    return NextResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide regeneration status');
  }
}
