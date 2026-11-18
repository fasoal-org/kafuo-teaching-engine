/**
 * GET /api/teaching-packages/generation-model-catalog — the generation model
 * catalogue the Kafuo admin panel picks a subject's package model from
 * (teaching-generation-model-admin-config-plan-2026-11-18 D-12): the 11
 * catalogue models, whether each is usable on THIS server, each model's
 * thinking values and prefilled default, and today's code table per subject.
 *
 * Service key only (the Backend proxies it to superadmins), under the same
 * `/api/teaching-packages/` prefix as `tts-catalog`. The body is secret-free:
 * availability is reported by the env var NAME, never a key, value or base URL.
 */
import { type NextRequest, NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { buildGenerationModelCatalog } from '@/lib/server/teaching-model/generation-catalog';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    return NextResponse.json(buildGenerationModelCatalog(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'failed to read the generation model catalogue',
        },
      },
      { status: 500 },
    );
  }
}
