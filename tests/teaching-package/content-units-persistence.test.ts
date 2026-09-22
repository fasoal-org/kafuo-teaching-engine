/**
 * Kafuo R1 P4 — per-attempt Content Unit retention (plan §5.1).
 *
 * `teaching_package_content_units` holds the approved units an attempt was
 * grounded in: idempotent per `(attempt_id, unit_id)`, tenant-scoped on
 * read AND on overwrite, `ON DELETE RESTRICT` against its attempt, and fed by
 * the same skip rule the prompt projection uses.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureTeachingPackageSchema,
  insertAttempt,
  readContentUnitsForAttempt,
  upsertContentUnits,
} from '@/lib/persistence/teaching-package';
import { retainableContentUnits } from '@/lib/server/teaching-package/content-units';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]) {
    return this.db.query<Row>(text, params);
  }
  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-cu';

describe('teaching_package_content_units', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;

  async function seedAttempt(tenantId = TENANT) {
    const attemptId = unique('tpa');
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId, learningItem: { type: 'lesson', id: unique('li') } },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem: { type: 'lesson', id: 'li' },
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
      },
      now: 1,
    });
    return attemptId;
  }

  beforeEach(async () => {
    pool = new PGlitePool(new PGlite());
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('the schema is idempotent and the attempts table gained subject_code', async () => {
    await ensureTeachingPackageSchema(pool as never);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'teaching_package_generation_attempts' AND column_name = 'subject_code'`,
    );
    expect(columns.rows).toHaveLength(1);
    const pk = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'teaching_package_content_units'::regclass AND contype = 'p'`,
    );
    expect(pk.rows).toHaveLength(1);
  });

  it('writes the rows in manifest order and re-runs idempotently for the same attempt', async () => {
    const attemptId = await seedAttempt();
    const units = [
      { unitId: 'cu-2', orderIndex: 2, role: 'EXAMPLE', normalizedText: 'two' },
      {
        unitId: 'cu-1',
        orderIndex: 1,
        role: 'CONCEPT',
        subtype: 'definition',
        title: 'One',
        normalizedText: 'one',
        contentRevisionId: 'rev-1',
      },
    ];
    await upsertContentUnits(qp(), { tenantId: TENANT, attemptId, units });
    // Layer A re-run: the same rows, one of them changed.
    await upsertContentUnits(qp(), {
      tenantId: TENANT,
      attemptId,
      units: [{ ...units[1]!, normalizedText: 'one (revised)' }],
    });
    const rows = await readContentUnitsForAttempt(qp(), attemptId, { tenantId: TENANT });
    expect(
      rows.map((row) => [row.unitId, row.orderIndex, row.normalizedText, row.textLength]),
    ).toEqual([
      ['cu-1', 1, 'one (revised)', 'one (revised)'.length],
      ['cu-2', 2, 'two', 3],
    ]);
    expect(rows[0]).toMatchObject({
      attemptId,
      tenantId: TENANT,
      role: 'CONCEPT',
      subtype: 'definition',
      title: 'One',
      contentRevisionId: 'rev-1',
      approvedSnapshotId: null,
    });
    expect(rows[1]).toMatchObject({ subtype: null, title: null, contentRevisionId: null });
    const count = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM teaching_package_content_units WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(count.rows[0]!.n).toBe(2);
  });

  it('is tenant-scoped: another tenant reads nothing and cannot overwrite the rows', async () => {
    const attemptId = await seedAttempt();
    await upsertContentUnits(qp(), {
      tenantId: TENANT,
      attemptId,
      units: [{ unitId: 'cu-1', orderIndex: 1, role: 'CONCEPT', normalizedText: 'mine' }],
    });
    await upsertContentUnits(qp(), {
      tenantId: 'tenant-other',
      attemptId,
      units: [{ unitId: 'cu-1', orderIndex: 1, role: 'CONCEPT', normalizedText: 'theirs' }],
    });
    expect(await readContentUnitsForAttempt(qp(), attemptId, { tenantId: 'tenant-other' })).toEqual(
      [],
    );
    const mine = await readContentUnitsForAttempt(qp(), attemptId, { tenantId: TENANT });
    expect(mine.map((row) => row.normalizedText)).toEqual(['mine']);
  });

  it('restricts deleting an attempt that still holds retained units', async () => {
    const attemptId = await seedAttempt();
    await upsertContentUnits(qp(), {
      tenantId: TENANT,
      attemptId,
      units: [{ unitId: 'cu-1', orderIndex: 1, role: 'CONCEPT', normalizedText: 'kept' }],
    });
    await expect(
      pool.query(`DELETE FROM teaching_package_generation_attempts WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/violates foreign key constraint/);
  });

  it('refuses an empty unit id and a row for an unknown attempt', async () => {
    const attemptId = await seedAttempt();
    await expect(
      upsertContentUnits(qp(), {
        tenantId: TENANT,
        attemptId,
        units: [{ unitId: '', orderIndex: 1, role: 'CONCEPT', normalizedText: 'x' }],
      }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      upsertContentUnits(qp(), {
        tenantId: TENANT,
        attemptId: 'tpa-missing',
        units: [{ unitId: 'cu-1', orderIndex: 1, role: 'CONCEPT', normalizedText: 'x' }],
      }),
    ).rejects.toThrow(/foreign key constraint/);
  });

  describe('retainableContentUnits — the prompt projection’s skip rule', () => {
    it('keeps every unit with usable text in manifest order and skips figure-only / non-instructional textless units', () => {
      const rows = retainableContentUnits({
        contentRevisionId: 'rev-9',
        contentUnits: [
          { id: '3', orderIndex: 3, role: 'EXAMPLE', normalizedText: 'third' },
          {
            id: '1',
            orderIndex: 1,
            role: 'CONCEPT',
            title: 'T',
            subtype: 'definition',
            normalizedText: '  first  ',
          },
          // figure-only: textless but carries a visual through a block
          { id: 'fig', orderIndex: 2, role: 'FIGURE', blocks: [{ associatedVisualIds: ['v1'] }] },
          // non-instructional: textless, allowed to be
          { id: 'ref', orderIndex: 4, role: 'reference', normalizedText: '   ' },
          { id: 'unc', orderIndex: 5, role: 'UNCLASSIFIED' },
        ],
      });
      expect(rows).toEqual([
        {
          unitId: '1',
          orderIndex: 1,
          role: 'CONCEPT',
          subtype: 'definition',
          title: 'T',
          normalizedText: 'first',
          contentRevisionId: 'rev-9',
          approvedSnapshotId: null,
        },
        {
          unitId: '3',
          orderIndex: 3,
          role: 'EXAMPLE',
          subtype: null,
          title: null,
          normalizedText: 'third',
          contentRevisionId: 'rev-9',
          approvedSnapshotId: null,
        },
      ]);
    });

    it('a figure-only unit that ALSO has text is retained (it was rendered to the model)', () => {
      const rows = retainableContentUnits({
        contentUnits: [
          {
            id: 'fig',
            orderIndex: 1,
            role: 'FIGURE',
            normalizedText: 'Figure 2 shows…',
            blocks: [{ associatedVisualIds: ['v1'] }],
          },
        ],
      });
      expect(rows.map((row) => row.unitId)).toEqual(['fig']);
      expect(rows[0]!.contentRevisionId).toBeNull();
    });
  });
});
