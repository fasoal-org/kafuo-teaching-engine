/**
 * POST /api/teaching-packages/[id]/editor-handoff — mint a handoff token for
 * one package version (§11). `edit` requires draft|rejected; `preview` works
 * for any status. The token is bound to `{ versionId, stageId, capability }`,
 * lives ≤ 5 minutes, and is redeemed by the browser at
 * `/api/teaching-packages/editor-handoff?token=…`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import { mintEditorHandoffToken } from '@/lib/server/teaching-package/editor-grant';
import {
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    if (typeof body.actorRef !== 'string') {
      throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
    }
    const mode = body.mode;
    if (mode !== 'edit' && mode !== 'preview') {
      throw new TeachingPackageError('INVALID_REQUEST', 'mode must be "edit" or "preview"');
    }

    const version = await getTeachingPackageVersion(id);
    if (mode === 'edit' && version.status !== 'draft' && version.status !== 'rejected') {
      throw new TeachingPackageError(
        'INVALID_TRANSITION',
        `an editor handoff for edit requires a draft or rejected version, not ${version.status}`,
      );
    }
    const capability = mode === 'edit' ? 'write' : 'read';
    const { token, expiresAt } = mintEditorHandoffToken({
      versionId: version.id,
      stageId: version.currentStageId,
      capability,
    });
    return NextResponse.json({
      url: `/api/teaching-packages/editor-handoff?token=${encodeURIComponent(token)}`,
      expiresAt,
      stageId: version.currentStageId,
      capability,
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('[TeachingPackages] Failed to mint editor handoff:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to mint editor handoff' } },
      { status: 500 },
    );
  }
}
