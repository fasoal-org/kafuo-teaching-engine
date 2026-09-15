import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { claimStageMeta, ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { approve, submitForReview } from '@/lib/server/teaching-package/lifecycle';

const contractUrl = process.env.PG_CONTRACT_URL;

/**
 * True-parallel PostgreSQL concurrency for the lifecycle: PGlite is
 * single-connection, so only a real database can exercise two transactions
 * racing on the same version. Skipped unless PG_CONTRACT_URL is set (the same
 * gate as tests/persistence/owner-materials.pg.test.ts).
 */
describe.skipIf(!contractUrl)('teaching package lifecycle concurrency on PostgreSQL', () => {
  let pool: Pool;
  let counter = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl });
    const queryable = pool as unknown as ConnectableQueryable;
    await ensureDocumentSchema(queryable);
    await ensureStageMetaSchema(queryable);
    await ensureTeachingPackageSchema(queryable);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE teaching_package_generation_attempts, teaching_package_review_events, teaching_package_versions',
    );
    await pool.query(
      `DELETE FROM stage_meta WHERE stage_id LIKE 'stage-pgc-%';
       DELETE FROM document_stages WHERE id LIKE 'stage-pgc-%'`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('two concurrent approves of one version yield exactly one approval', async () => {
    counter += 1;
    const stageId = `stage-pgc-${counter}`;
    const itemId = `li-pgc-${counter}`;
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       VALUES ($1, 'concurrency', 1, 1, '{}'::jsonb)`,
      [stageId],
    );
    await claimStageMeta(pool, stageId, TEACHING_PACKAGE_STAGE_OWNER);
    const versionId = `tpv-pgc-${counter}`;
    await insertVersion(pool, {
      id: versionId,
      learningItem: { type: 'lesson', id: itemId },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await submitForReview(pool, { versionId, actorRef: 'actor-1' });

    // Two independent transactions approve the same version at the same time.
    const results = await Promise.allSettled([
      approve(pool, { versionId, actorRef: 'reviewer-a' }),
      approve(pool, { versionId, actorRef: 'reviewer-b' }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(TeachingPackageError);
    expect(rejected[0].reason).toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });

    // Never two approved rows for one item: query the partial unique index.
    const approved = await pool.query(
      `SELECT id FROM teaching_package_versions
        WHERE learning_item_type = 'lesson' AND learning_item_id = $1 AND status = 'approved'`,
      [itemId],
    );
    expect(approved.rows).toHaveLength(1);
    expect(approved.rows[0].id).toBe(versionId);
    // Exactly one approval event survived.
    const events = await pool.query(
      `SELECT actor_ref FROM teaching_package_review_events
        WHERE version_id = $1 AND event_type = 'approved'`,
      [versionId],
    );
    expect(events.rows).toHaveLength(1);
  });
});
