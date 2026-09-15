import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  appendReviewEvent,
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readAttempt,
} from '@/lib/persistence/teaching-package';
import type { GenerationInputSnapshot } from '@/lib/types/teaching-package';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
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

  it('rejects a second approved version for one learning item (23505)', async () => {
    await seedStageRow(pool, 'stage-approved-a');
    await seedStageRow(pool, 'stage-approved-b');
    await insertVersion(qp(), {
      id: 'tpv-approved-1',
      learningItem: { type: 'lesson', id: 'li-approved' },
      version: 1,
      status: 'approved',
      currentStageId: 'stage-approved-a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expect(
      insertVersion(qp(), {
        id: 'tpv-approved-2',
        learningItem: { type: 'lesson', id: 'li-approved' },
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
      learningItem: { type: 'lesson', id: 'li-active' },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-active-a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expect(
      insertVersion(qp(), {
        id: 'tpv-active-2',
        learningItem: { type: 'lesson', id: 'li-active' },
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
      learningItem: { type: 'section', id: 'li-event' },
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
      learningItem: { type: 'lesson', id: 'li-append' },
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
      learningItem: { type: 'lesson', id: 'li-restrict' },
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
      learningItem: { type: 'lesson', id: 'li-displaced' },
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

    const attempt = await readAttempt(qp(), 'tpa-displaced-1');
    expect(attempt).toMatchObject({
      stageId: null,
      producedStageId: 'stage-displaced',
    });
  });
});
