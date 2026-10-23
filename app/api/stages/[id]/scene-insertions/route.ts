/**
 * /api/stages/[id]/scene-insertions — a reviewer-generated slide for an
 * uncovered lesson part (reviewer-generated-slide plan §6, §15).
 *
 * POST `{ unitIds, afterSceneId, beforeSceneId, teachingStage, instruction,
 * reason, idempotencyKey }`: generate ONE new slide grounded in the units'
 * retained text and insert it atomically at that position, or change nothing.
 * The Stage, version, tenant and actor come from the Editor grant, never from
 * the body. `instruction` (optional) is the only reviewer text a model sees;
 * `reason` is audit-only. 200 = inserted (or the replay of a success), 202 =
 * the same request is still running. The run ignores `req.signal`: a client
 * disconnect never cancels a paid generation half-way.
 *
 * GET `?key=<idempotencyKey>`: the status of the insertion that key named
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
  insertGeneratedSlide,
  parseSceneInsertionRequest,
  readSceneInsertionForGrant,
} from '@/lib/server/teaching-package/scene-insertion';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const request = parseSceneInsertionRequest(await readJsonObject(req));
    const result = await insertGeneratedSlide(
      {
        tenantId: grant.tenantId,
        versionId: grant.versionId,
        stageId,
        learnerKey: grant.learnerKey,
      },
      request,
      { pool },
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide insertion');
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
    const status = await readSceneInsertionForGrant(
      pool,
      { tenantId: grant.tenantId, versionId: grant.versionId, stageId },
      { idempotencyKey: key },
    );
    return NextResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'slide insertion status');
  }
}
