/**
 * GET /api/stages/[id]/content-units — the lesson parts of the grant's
 * version and their slide coverage (reviewer-generated-slide plan §8.3):
 * `{ lineageStatus, units[], positions[], stages[] }`. Editor grants only —
 * the `learner` and `preview` purposes are refused, as for writes. Unit TEXT
 * is never sent to the browser. Never writes.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import { learnerRefusalWithoutAccessCode } from '@/lib/server/teaching-package/editor-grant-tenant-access';
import {
  regenerationErrorResponse,
  resolveRegenerationGrant,
} from '@/lib/server/teaching-package/regeneration-grant';
import { readContentUnitsForGrant } from '@/lib/server/teaching-package/scene-insertion';

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
    if (grant.purpose === 'learner' || grant.purpose === 'preview') {
      return NextResponse.json(
        {
          error: {
            code: 'READ_ONLY_GRANT',
            message: 'lesson parts are listed for editor grants only',
          },
        },
        { status: 403 },
      );
    }
    const body = await readContentUnitsForGrant(pool, {
      tenantId: grant.tenantId,
      versionId: grant.versionId,
      stageId,
    });
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return regenerationErrorResponse(error, 'lesson parts');
  }
}
