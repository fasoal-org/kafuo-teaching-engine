/**
 * POST /api/stages/[id]/scenes/[sceneId]/narration-audio — a reviewer's audio
 * repair of ONE Teaching Package Scene (scene-narration-audio-regeneration-plan).
 *
 * Synthesizes the spoken lines that have no audio with the Stage's TTS route
 * and saves the Scene: `{ sceneId, scene, rev, generated, missing }`. No body.
 * The Stage, version and tenant come from the write Editor grant. The run
 * ignores `req.signal`: a client disconnect never cancels a paid synthesis
 * half-way.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { regenerateSceneNarrationAudio } from '@/lib/server/teaching-package/scene-narration-audio';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; sceneId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id: stageId, sceneId } = await params;
    const resolved = await resolveRegenerationGrant(req.headers, stageId, { requireWrite: true });
    if (!resolved.ok) return resolved.response;
    const { grant, pool } = resolved.value;
    const result = await regenerateSceneNarrationAudio(
      {
        tenantId: grant.tenantId,
        versionId: grant.versionId,
        stageId,
        learnerKey: grant.learnerKey,
      },
      sceneId,
      { pool },
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'scene narration audio');
  }
}
