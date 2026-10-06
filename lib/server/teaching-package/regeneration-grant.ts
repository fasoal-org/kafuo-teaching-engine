/**
 * Grant resolution for the slide-regeneration and scene-revision routes
 * (single-slide-regeneration-plan §6). The order is fixed and nothing
 * security-relevant comes from the request body:
 *
 * 1. no valid grant cookie for the path's Stage (absent, expired, forged) →
 *    plain `404`, non-enumerating;
 * 2. the grant's version must still exist in the grant's tenant and still name
 *    this Stage as its current one → else `404`;
 * 3. writes additionally require `capability === 'write'` on an editing grant
 *    (preview and learner grants are read-only) → else `403 READ_ONLY_GRANT`.
 *
 * Editability is decided later, under the regeneration's own locks.
 */
import { NextResponse } from 'next/server';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readVersionById } from '@/lib/persistence/teaching-package';
import {
  readEditorGrant,
  type VerifiedEditorGrant,
} from '@/lib/server/teaching-package/editor-grant';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';

export interface ResolvedRegenerationGrant {
  grant: VerifiedEditorGrant;
  pool: ConnectableQueryable;
}

export function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

export async function resolveRegenerationGrant(
  headers: Headers,
  stageId: string,
  options: { requireWrite: boolean },
): Promise<{ ok: true; value: ResolvedRegenerationGrant } | { ok: false; response: Response }> {
  if (!isServerPersistenceConfigured()) return { ok: false, response: notFound() };
  const grant = readEditorGrant(headers, stageId);
  if (!grant) return { ok: false, response: notFound() };
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const queryable = pool as unknown as ConnectableQueryable;
  const version = await readVersionById(queryable, grant.versionId);
  if (!version || version.tenantId !== grant.tenantId || version.currentStageId !== stageId) {
    return { ok: false, response: notFound() };
  }
  if (
    options.requireWrite &&
    (grant.capability !== 'write' || grant.purpose === 'learner' || grant.purpose === 'preview')
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'READ_ONLY_GRANT',
            message: 'this editor grant is read-only; the slide cannot be regenerated',
          },
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true, value: { grant, pool: queryable } };
}

/** The shared error tail of every route in this family. */
export function regenerationErrorResponse(error: unknown, label: string): Response {
  const mapped = teachingPackageErrorResponse(error);
  if (mapped) return mapped;
  console.error(`${label} failed`, error);
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
}
