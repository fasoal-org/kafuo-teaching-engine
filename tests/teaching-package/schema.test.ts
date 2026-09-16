import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema, splitSqlStatements } from '@openmaic/storage/document/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  appendReviewEvent,
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readAttempt,
} from '@/lib/persistence/teaching-package';
import type { GenerationInputSnapshot } from '@/lib/types/teaching-package';

/** The pre-tenant DDL exactly as an already-populated database holds it. */
const PRE_TENANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS teaching_package_versions (
  id TEXT PRIMARY KEY,
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','rejected','approved','superseded','discarded')),
  current_stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE RESTRICT,
  current_attempt_id TEXT,
  teaching_model_key TEXT NOT NULL,
  teaching_model_version TEXT NOT NULL,
  predecessor_version_id TEXT REFERENCES teaching_package_versions(id),
  superseded_by_version_id TEXT REFERENCES teaching_package_versions(id),
  submitted_stage_rev BIGINT,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  submitted_at DOUBLE PRECISION,
  approved_at DOUBLE PRECISION,
  superseded_at DOUBLE PRECISION,
  discarded_at DOUBLE PRECISION
);
CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_item_version_unique
  ON teaching_package_versions (learning_item_type, learning_item_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_single_approved
  ON teaching_package_versions (learning_item_type, learning_item_id) WHERE status = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_single_active
  ON teaching_package_versions (learning_item_type, learning_item_id)
  WHERE status IN ('draft','in_review','rejected');
CREATE TABLE IF NOT EXISTS teaching_package_generation_attempts (
  id TEXT PRIMARY KEY,
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  version_id TEXT REFERENCES teaching_package_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('initial','regeneration')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  request_id TEXT,
  requested_by_actor_ref TEXT NOT NULL,
  teaching_model_key TEXT NOT NULL,
  teaching_model_version TEXT NOT NULL,
  input_snapshot JSONB NOT NULL,
  produced_stage_id TEXT,
  stage_id TEXT REFERENCES document_stages(id) ON DELETE SET NULL,
  displaced_at DOUBLE PRECISION,
  stage_released_at DOUBLE PRECISION,
  progress JSONB,
  error TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  started_at DOUBLE PRECISION,
  completed_at DOUBLE PRECISION
);
CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_attempts_single_inflight
  ON teaching_package_generation_attempts (learning_item_type, learning_item_id)
  WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_attempts_request_id_unique
  ON teaching_package_generation_attempts (learning_item_type, learning_item_id, request_id)
  WHERE request_id IS NOT NULL;
`;

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<T>(text, params);
  }

  async end() {
    await this.db.close();
  }
}

async function seedStageRow(pool: PGlitePool, stageId: string): Promise<void> {
  await pool.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, data)
     VALUES ($1, 'seed stage', 1, 1, '{}'::jsonb)`,
    [stageId],
  );
}

function snapshot(): GenerationInputSnapshot {
  return {
    learningItem: { type: 'lesson', id: 'li-schema' },
    teachingModel: { key: 'g5', version: 'g5.v1' },
    learningObjectives: [],
    contentUnitRefs: [],
    sourceRefs: [],
    generationContext: {},
    generationOptions: {},
    requirementDigest: '0'.repeat(64),
    requirementPreview: 'preview',
    pdfContentSummary: null,
    requestedAt: 1,
  };
}

function expectPgErrorCode(code: string) {
  return expect.objectContaining({ code });
}

describe('teaching package schema', () => {
  let pool: PGlitePool;
  /** The row helpers take the pg `Queryable` interface; PGlite satisfies it at runtime. */
  const qp = () => pool as never;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
  });

  it('is idempotent: ensuring every schema twice succeeds', async () => {
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await expect(ensureTeachingPackageSchema(qp())).resolves.toBeUndefined();
  });

  it('creates only tenant-scoped unique indexes on a fresh database', async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename IN ('teaching_package_versions', 'teaching_package_generation_attempts')
        ORDER BY indexname`,
    );
    const names = result.rows.map((row) => row.indexname);
    for (const canonical of [
      'tpv_tenant_item_version_unique',
      'tpv_tenant_single_approved',
      'tpv_tenant_single_active',
      'tpa_tenant_single_inflight',
      'tpa_tenant_request_id_unique',
    ]) {
      expect(names).toContain(canonical);
    }
    for (const obsolete of [
      'teaching_package_versions_item_version_unique',
      'teaching_package_versions_single_approved',
      'teaching_package_versions_single_active',
      'teaching_package_versions_item_version_idx',
      'teaching_package_attempts_single_inflight',
      'teaching_package_attempts_request_id_unique',
    ]) {
      expect(names).not.toContain(obsolete);
    }
  });

  it('allows the same (type, id) approved version under two tenants', async () => {
    await seedStageRow(pool, 'stage-two-tenant-a');
    await seedStageRow(pool, 'stage-two-tenant-b');
    await insertVersion(qp(), {
      id: 'tpv-two-tenant-a',
      aggregate: { tenantId: 'tenant-a', learningItem: { type: 'lesson', id: 'li-shared' } },
      version: 1,
      status: 'approved',
      currentStageId: 'stage-two-tenant-a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await expect(
      insertVersion(qp(), {
        id: 'tpv-two-tenant-b',
        aggregate: { tenantId: 'tenant-b', learningItem: { type: 'lesson', id: 'li-shared' } },
        version: 1,
        status: 'approved',
        currentStageId: 'stage-two-tenant-b',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 2,
      }),
    ).resolves.toBeDefined();
  });

  it('returns null for a by-id read under a foreign tenant (non-enumerating)', async () => {
    await seedStageRow(pool, 'stage-scope');
    const { readVersion } = await import('@/lib/persistence/teaching-package');
    const created = await insertVersion(qp(), {
      id: 'tpv-scope-1',
      aggregate: { tenantId: 'tenant-a', learningItem: { type: 'lesson', id: 'li-scope' } },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-scope',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    expect(await readVersion(qp(), created.id, { tenantId: 'tenant-a' })).not.toBeNull();
    expect(await readVersion(qp(), created.id, { tenantId: 'tenant-b' })).toBeNull();
  });

  it('evolves a populated pre-tenant database: legacy backfill, obsolete indexes dropped, idempotent', async () => {
    // A separate database seeded with the PRE-change DDL, indexes and rows.
    const db = new PGlite();
    await db.waitReady;
    const oldPool = new PGlitePool(db);
    const oldQp = () => oldPool as never;
    await ensureDocumentSchema(oldQp());
    await ensureStageMetaSchema(oldQp());
    for (const statement of splitSqlStatements(PRE_TENANT_SCHEMA)) {
      await oldPool.query(statement);
    }
    await seedStageRow(oldPool, 'stage-old-1');
    await oldPool.query(
      `INSERT INTO teaching_package_versions
         (id, learning_item_type, learning_item_id, version, status, current_stage_id,
          teaching_model_key, teaching_model_version, created_at, updated_at)
       VALUES ('tpv-old-1', 'lesson', 'li-old', 1, 'approved', 'stage-old-1', 'g5', 'g5.v1', 1, 1)`,
    );

    await expect(ensureTeachingPackageSchema(oldQp())).resolves.toBeUndefined();

    const tenants = await oldPool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM teaching_package_versions WHERE id = 'tpv-old-1'`,
    );
    expect(tenants.rows[0]!.tenant_id).toBe('__legacy__');

    const indexes = await oldPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename IN ('teaching_package_versions', 'teaching_package_generation_attempts')
        ORDER BY indexname`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('tpv_tenant_item_version_unique');
    expect(names).toContain('tpa_tenant_request_id_unique');
    for (const obsolete of [
      'teaching_package_versions_item_version_unique',
      'teaching_package_versions_single_approved',
      'teaching_package_versions_single_active',
      'teaching_package_versions_item_version_idx',
      'teaching_package_attempts_single_inflight',
      'teaching_package_attempts_request_id_unique',
    ]) {
      expect(names).not.toContain(obsolete);
    }

    // The NOT NULL + CHECK floor holds: an empty tenant cannot be written.
    await expect(
      oldPool.query(
        `INSERT INTO teaching_package_versions
           (id, tenant_id, learning_item_type, learning_item_id, version, status,
            current_stage_id, teaching_model_key, teaching_model_version, created_at, updated_at)
         VALUES ('tpv-old-2', '', 'lesson', 'li-old', 2, 'draft', 'stage-old-1', 'g5', 'g5.v1', 1, 1)`,
      ),
    ).rejects.toMatchObject(expect.objectContaining({ code: '23514' }));

    // Idempotent second run, and legacy rows stay reachable under __legacy__.
    await expect(ensureTeachingPackageSchema(oldQp())).resolves.toBeUndefined();
    const { readVersion } = await import('@/lib/persistence/teaching-package');
    const legacyRow = await readVersion(oldQp(), 'tpv-old-1', { tenantId: '__legacy__' });
    expect(legacyRow?.learningItem.id).toBe('li-old');
    expect(await readVersion(oldQp(), 'tpv-old-1', { tenantId: 'tenant-a' })).toBeNull();

    await oldPool.end();
  });

  it('rejects a second approved version for one learning item (23505)', async () => {
    await seedStageRow(pool, 'stage-approved-a');
    await seedStageRow(pool, 'stage-approved-b');
    await insertVersion(qp(), {
      id: 'tpv-approved-1',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-approved' } },
      version: 1,
      status: 'approved',
      currentStageId: 'stage-approved-a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expect(
      insertVersion(qp(), {
        id: 'tpv-approved-2',
        aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-approved' } },
        version: 2,
        status: 'approved',
        currentStageId: 'stage-approved-b',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 2,
      }),
    ).rejects.toMatchObject(expectPgErrorCode('23505'));
  });

  it('rejects a second active version for one learning item (23505)', async () => {
    await seedStageRow(pool, 'stage-active-a');
    await seedStageRow(pool, 'stage-active-b');
    await insertVersion(qp(), {
      id: 'tpv-active-1',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-active' } },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-active-a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expect(
      insertVersion(qp(), {
        id: 'tpv-active-2',
        aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-active' } },
        version: 2,
        status: 'rejected',
        currentStageId: 'stage-active-b',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 2,
      }),
    ).rejects.toMatchObject(expectPgErrorCode('23505'));
  });

  it('rejects a rejected event without a reason (CHECK)', async () => {
    await seedStageRow(pool, 'stage-event');
    await insertVersion(qp(), {
      id: 'tpv-event-1',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'section', id: 'li-event' } },
      version: 1,
      status: 'in_review',
      currentStageId: 'stage-event',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expect(
      appendReviewEvent(qp(), {
        versionId: 'tpv-event-1',
        eventType: 'rejected',
        fromStatus: 'in_review',
        toStatus: 'rejected',
        actorRef: 'actor-1',
        reason: null,
        createdAt: 2,
      }),
    ).rejects.toMatchObject(expect.objectContaining({ code: '23514' }));
  });

  it('makes review events append-only (UPDATE and DELETE both raise)', async () => {
    await seedStageRow(pool, 'stage-append-only');
    await insertVersion(qp(), {
      id: 'tpv-append-1',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-append' } },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-append-only',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await appendReviewEvent(qp(), {
      versionId: 'tpv-append-1',
      eventType: 'created',
      fromStatus: null,
      toStatus: 'draft',
      actorRef: 'actor-1',
      createdAt: 2,
    });

    await expect(
      pool.query(`UPDATE teaching_package_review_events SET actor_ref = 'x' WHERE id = 1`),
    ).rejects.toMatchObject(expect.objectContaining({ code: 'P0001' }));
    await expect(
      pool.query(`DELETE FROM teaching_package_review_events WHERE id = 1`),
    ).rejects.toMatchObject(expect.objectContaining({ code: 'P0001' }));
  });

  it('restricts hard delete of a stage referenced by versions.current_stage_id', async () => {
    await seedStageRow(pool, 'stage-restrict');
    await insertVersion(qp(), {
      id: 'tpv-restrict-1',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-restrict' } },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-restrict',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expect(
      pool.query(`DELETE FROM document_stages WHERE id = 'stage-restrict'`),
    ).rejects.toMatchObject(expect.objectContaining({ code: '23503' }));
  });

  it('hard delete of a stage referenced only by attempts.stage_id succeeds and keeps produced_stage_id', async () => {
    await seedStageRow(pool, 'stage-displaced');
    await insertAttempt(qp(), {
      id: 'tpa-displaced-1',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-displaced' } },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'actor-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: snapshot(),
      now: 1,
    });
    // The success path is the only setter of the Stage identity columns.
    await pool.query(
      `UPDATE teaching_package_generation_attempts
          SET produced_stage_id = 'stage-displaced', stage_id = 'stage-displaced'
        WHERE id = 'tpa-displaced-1'`,
    );

    await expect(
      pool.query(`DELETE FROM document_stages WHERE id = 'stage-displaced'`),
    ).resolves.toBeDefined();

    const attempt = await readAttempt(qp(), 'tpa-displaced-1', { tenantId: 'tenant-test' });
    expect(attempt).toMatchObject({
      stageId: null,
      producedStageId: 'stage-displaced',
    });
  });
});
