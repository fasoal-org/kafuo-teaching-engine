/**
 * `POST /api/teaching-model/help-turns` — Backend-originated legacy Help
 * model turn (Kafuo R1 contracts §3.4; plan §6.3, §8.8, P6).
 *
 * Service key, non-streaming, Node runtime, 120 s. Answers
 * `200 { text, servedBy, safety, groundingMode, attemptIds, accountingComplete: true, budget }`
 * or the tutor error envelope (`retryable` present; `Retry-After` on
 * `409 TURN_IN_PROGRESS`). `503 TEACHING_MODEL_UNAVAILABLE |
 * ACCOUNTING_UNAVAILABLE` are retryable. No meter call is made here.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { readJsonObject } from '@/lib/server/teaching-package/route-helpers';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { tutorErrorResponse, tutorInternalErrorResponse } from '@/lib/server/tutor/guards';
import { runLegacyHelpTurn, type LegacyHelpDeps } from '@/lib/server/tutor/legacy-help-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DEPS_KEY = Symbol.for('openmaic.tutor.legacy-help-deps-override');

/** Test seam: PGlite + executor seams instead of the provider pool. */
export function setLegacyHelpDepsForTests(deps: LegacyHelpDeps | undefined): void {
  (globalThis as Record<symbol, LegacyHelpDeps | undefined>)[DEPS_KEY] = deps;
}

async function resolveDeps(): Promise<LegacyHelpDeps> {
  const override = (globalThis as Record<symbol, LegacyHelpDeps | undefined>)[DEPS_KEY];
  if (override) return override;
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return { queryable: pool as unknown as LegacyHelpDeps['queryable'] };
}

export async function POST(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const body = await readJsonObject(req);
    if (!body) throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    const result = await runLegacyHelpTurn(body, await resolveDeps());
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const mapped = tutorErrorResponse(error);
    if (mapped) return mapped;
    console.error('Legacy help turn internal error', JSON.stringify(describeErrorSafely(error)));
    return tutorInternalErrorResponse('legacy help turn failed');
  }
}
