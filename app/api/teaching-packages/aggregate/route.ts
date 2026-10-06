/**
 * GET /api/teaching-packages/aggregate?tenantId&learningItemType&learningItemId
 * — the lightweight reconciliation read (plan §4.4.4): approvedVersion,
 * workingVersion, latestAttempt, latestAggregateSequence. No Stage/Scene/
 * history document. The state and the sequence watermark are read in ONE
 * transaction under the webhook advisory lock so the watermark can never
 * describe a state the rows do not match.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  readActiveVersion,
  readApprovedVersion,
  readAttemptById,
  readLatestWebhookSequence,
} from '@/lib/persistence/teaching-package';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { nodePostgresTransaction } from '@openmaic/storage/server/reference';
import {
  parseAggregateScope,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const params = req.nextUrl.searchParams;
    const aggregate = parseAggregateScope(
      params.get('tenantId'),
      params.get('learningItemType'),
      params.get('learningItemId'),
    );

    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const withTransaction = nodePostgresTransaction(pool);
    const result = await withTransaction(async (tx) => {
      // Same advisory lock namespace the webhook sequence allocation uses, so
      // a concurrent enqueue waits and the watermark matches the state read.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `teaching-package-webhook:${aggregate.tenantId}:${aggregate.learningItem.type}:${aggregate.learningItem.id}`,
      ]);
      const [approved, working, sequence, latestAttemptRow] = await Promise.all([
        readApprovedVersion(tx, aggregate),
        readActiveVersion(tx, aggregate),
        readLatestWebhookSequence(tx, aggregate),
        tx.query<{ id: string }>(
          `SELECT id
             FROM teaching_package_generation_attempts
            WHERE tenant_id = $1 AND learning_item_type = $2 AND learning_item_id = $3
            ORDER BY created_at DESC, id DESC
            LIMIT 1`,
          [aggregate.tenantId, aggregate.learningItem.type, aggregate.learningItem.id],
        ),
      ]);
      const latestAttemptId = latestAttemptRow.rows[0]?.id ?? null;
      const latestAttempt = latestAttemptId ? await readAttemptById(tx, latestAttemptId) : null;
      return {
        approvedVersion: approved,
        workingVersion: working,
        latestAttempt,
        latestAggregateSequence: sequence,
      };
    });
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to read aggregate' } },
      { status: 500 },
    );
  }
}
