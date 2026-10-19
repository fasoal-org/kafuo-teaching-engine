/**
 * GET /api/teaching-packages/tts-catalog — the narration catalogue the Kafuo
 * admin panel picks a subject's route from (tts-provider-routing-admin-config-
 * plan §3.1): the routable providers, whether each is usable on THIS server,
 * their Arabic and English catalogue voices (with the model each speaks with),
 * and today's default table per subject code and language.
 *
 * Service key only (the Backend proxies it to superadmins). It sits under
 * `/api/teaching-packages/` because that prefix is already the Backend's
 * service-key entry through the access-code gate. The body is secret-free:
 * availability is reported by the env var NAME, never a key, value or base URL.
 */
import { type NextRequest, NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { buildTeachingTtsCatalog } from '@/lib/server/speech/teaching-route';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    return NextResponse.json(buildTeachingTtsCatalog(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read the narration catalogue' } },
      { status: 500 },
    );
  }
}
