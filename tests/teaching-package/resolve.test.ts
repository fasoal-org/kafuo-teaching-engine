import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import {
  claimStageMeta,
  ensureStageMetaSchema,
  tombstoneStageMeta,
} from '@/lib/persistence/stage-meta';
import {
  ensureTeachingPackageSchema,
  insertVersion,
  listVersionsByItem,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { resolveApprovedTeachingPackage } from '@/lib/server/teaching-package/resolve';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { LearningItemRef, TeachingPackageStatus } from '@/lib/types/teaching-package';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async end() {
    await this.db.close();
  }
}

const ITEM: LearningItemRef = { type: 'lesson', id: 'li-resolve' };

describe('approved teaching package resolver', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;

  async function seedStage(stageId: string): Promise<void> {
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       VALUES ($1, 'Resolver stage', 1, 1, '{}'::jsonb)`,
      [stageId],
    );
    await claimStageMeta(qp(), stageId, TEACHING_PACKAGE_STAGE_OWNER);
  }

  async function seedVersion(
    version: number,
    status: TeachingPackageStatus,
    stageId: string,
  ): Promise<string> {
    const id = `tpv-resolve-${version}`;
    await insertVersion(qp(), {
      id,
      aggregate: { tenantId: 'tenant-test', learningItem: ITEM },
      version,
      status,
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: version,
    });
    return id;
  }

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

  it('resolves none while only non-approved versions exist', async () => {
    // One item per status: the single-active index forbids a draft and a
    // rejected version coexisting for the same item, and a superseded version
    // only ever coexists with an approved one — so each row gets its own item.
    const cases: Array<{ item: LearningItemRef; status: TeachingPackageStatus; n: number }> = [
      { item: ITEM, status: 'draft', n: 1 },
      { item: { type: 'lesson', id: 'li-resolve-rejected' }, status: 'rejected', n: 2 },
      { item: { type: 'section', id: 'li-resolve-discarded' }, status: 'discarded', n: 3 },
      { item: { type: 'lesson', id: 'li-resolve-superseded' }, status: 'superseded', n: 4 },
    ];
    for (const { item, status, n } of cases) {
      const stageId = `stage-resolve-${status}`;
      await seedStage(stageId);
      await insertVersion(qp(), {
        id: `tpv-resolve-${status}`,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        version: n,
        status,
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: n,
      });
    }

    for (const { item } of cases) {
      await expect(resolveApprovedTeachingPackage({ tenantId: 'tenant-test', learningItem: item }, qp())).resolves.toEqual({ kind: 'none' });
    }
  });

  it('resolves the approved version with its stage id', async () => {
    await seedStage('stage-resolve-approved');
    const versionId = await seedVersion(1, 'approved', 'stage-resolve-approved');

    const resolution = await resolveApprovedTeachingPackage({ tenantId: 'tenant-test', learningItem: ITEM }, qp());
    expect(resolution).toMatchObject({
      kind: 'approved',
      stageId: 'stage-resolve-approved',
      version: { id: versionId, status: 'approved', version: 1 },
    });
  });

  it('throws STAGE_NOT_LIVE (422) when the approved stage is tombstoned', async () => {
    await seedStage('stage-resolve-tombstoned');
    await seedVersion(1, 'approved', 'stage-resolve-tombstoned');
    await tombstoneStageMeta(qp(), 'stage-resolve-tombstoned');

    const promise = resolveApprovedTeachingPackage({ tenantId: 'tenant-test', learningItem: ITEM }, qp());
    await expect(promise).rejects.toBeInstanceOf(TeachingPackageError);
    await expect(promise).rejects.toMatchObject({
      code: 'STAGE_NOT_LIVE',
      status: 422,
      details: { stageId: 'stage-resolve-tombstoned' },
    });
  });

  it('lists versions in stable ascending version order', async () => {
    await seedStage('stage-resolve-order-1');
    await seedStage('stage-resolve-order-3');
    await seedStage('stage-resolve-order-2');
    await seedVersion(3, 'superseded', 'stage-resolve-order-3');
    await seedVersion(1, 'approved', 'stage-resolve-order-1');
    await seedVersion(2, 'draft', 'stage-resolve-order-2');

    const versions = await listVersionsByItem(qp(), { tenantId: 'tenant-test', learningItem: ITEM });
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
  });
});
