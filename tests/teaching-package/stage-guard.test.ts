import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import type { AppDocument } from '@/lib/document-store/persistence-types';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  releaseDisplacedStage,
} from '@/lib/persistence/teaching-package';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { TeachingPackageStageLockedError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const EDITABLE: TeachingPackageStatus[] = ['draft', 'rejected'];
const LOCKED: TeachingPackageStatus[] = ['in_review', 'approved', 'superseded', 'discarded'];
const ALL_STATUSES = [...EDITABLE, ...LOCKED];

describe('teaching package stage guard', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;

  /** The guarded owner-bound store — the exact fence both construction sites use. */
  function guardedStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  /** Create a live Stage claimed under the service owner (unreferenced → allowed). */
  async function seedStage(stageId: string): Promise<AppDocument> {
    const document = makeDocument(stageId, 'Guarded course', [
      makeSlideScene('scene-1', stageId, 1),
    ]);
    await guardedStore().saveDocument(document);
    return document;
  }

  async function seedVersion(stageId: string, status: TeachingPackageStatus): Promise<string> {
    const versionId = `tpv-${stageId}-${status}`;
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: `li-${stageId}` } },
      version: 1,
      status,
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    return versionId;
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

  it.each(EDITABLE)('allows every content mutation while the version is %s', async (status) => {
    const stageId = `stage-editable-${status}`;
    const document = await seedStage(stageId);
    await seedVersion(stageId, status);
    const store = guardedStore();

    await expect(
      store.saveDocument({ ...document, stage: { ...document.stage, name: 'Overwritten' } }),
    ).resolves.toBeUndefined();
    await expect(
      store.putScene(stageId, makeSlideScene('scene-2', stageId, 2)),
    ).resolves.toBeUndefined();
    await expect(
      store.putStage(stageId, { ...document.stage, name: 'Renamed' }),
    ).resolves.toBeUndefined();
    await expect(store.deleteScene(stageId, 'scene-2')).resolves.toBeUndefined();
  });

  it.each(LOCKED)('refuses every content mutation while the version is %s', async (status) => {
    const stageId = `stage-locked-${status}`;
    const document = await seedStage(stageId);
    await seedVersion(stageId, status);
    const store = guardedStore();

    await expect(
      store.saveDocument({ ...document, stage: { ...document.stage, name: 'Overwritten' } }),
    ).rejects.toBeInstanceOf(TeachingPackageStageLockedError);
    await expect(
      store.putScene(stageId, makeSlideScene('scene-2', stageId, 2)),
    ).rejects.toMatchObject({ name: 'TeachingPackageStageLockedError', reason: status });
    await expect(
      store.putStage(stageId, { ...document.stage, name: 'Renamed' }),
    ).rejects.toBeInstanceOf(TeachingPackageStageLockedError);
    await expect(store.deleteScene(stageId, 'scene-1')).rejects.toMatchObject({
      name: 'TeachingPackageStageLockedError',
      reason: status,
    });
  });

  it.each(ALL_STATUSES)(
    'refuses deleteDocument (tombstone) while the version is %s',
    async (status) => {
      const stageId = `stage-delete-${status}`;
      await seedStage(stageId);
      await seedVersion(stageId, status);

      await expect(guardedStore().deleteDocument(stageId)).rejects.toMatchObject({
        name: 'TeachingPackageStageLockedError',
        reason: 'package-owned',
      });
    },
  );

  it('protects a retained displaced stage (attempt-only reference) until released', async () => {
    const stageId = 'stage-displaced-retained';
    await seedStage(stageId);
    await insertAttempt(qp(), {
      id: 'tpa-displaced-guard',
      aggregate: { tenantId: 'tenant-test', learningItem: { type: 'lesson', id: 'li-displaced-guard' } },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'actor-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem: { type: 'lesson', id: 'li-displaced-guard' },
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
      },
      now: 1,
    });
    await pool.query(
      `UPDATE teaching_package_generation_attempts
          SET stage_id = $2, produced_stage_id = $2, displaced_at = 5
        WHERE id = $1`,
      ['tpa-displaced-guard', stageId],
    );
    const store = guardedStore();

    await expect(
      store.putScene(stageId, makeSlideScene('scene-9', stageId, 9)),
    ).rejects.toMatchObject({ name: 'TeachingPackageStageLockedError', reason: 'displaced' });
    await expect(store.deleteDocument(stageId)).rejects.toMatchObject({
      name: 'TeachingPackageStageLockedError',
      reason: 'package-owned',
    });

    // The future retention policy releases the Stage; from then on it behaves
    // like an unreferenced Stage.
    await releaseDisplacedStage(qp(), 'tpa-displaced-guard', 10);
    await expect(store.deleteDocument(stageId)).resolves.toBeUndefined();
    await expect(store.loadDocument(stageId)).resolves.toBeNull();
  });

  it('allows folder membership changes for an approved stage (scope: library)', async () => {
    const stageId = 'stage-library-approved';
    await seedStage(stageId);
    await seedVersion(stageId, 'approved');
    const store = guardedStore();

    await expect(store.createFolder('folder-1', 'Folder One')).resolves.toBeDefined();
    await expect(store.moveDocumentToFolder(stageId, 'folder-1')).resolves.toBe(true);
    await expect(store.setStageFolder(stageId, null)).resolves.toBe(true);
  });

  it('leaves unreferenced stages completely unaffected', async () => {
    const stageId = 'stage-unreferenced';
    const document = await seedStage(stageId);
    const store = guardedStore();

    await expect(
      store.putScene(stageId, makeSlideScene('scene-2', stageId, 2)),
    ).resolves.toBeUndefined();
    await expect(
      store.saveDocument({ ...document, stage: { ...document.stage, name: 'Still editable' } }),
    ).resolves.toBeUndefined();
    await expect(store.deleteDocument(stageId)).resolves.toBeUndefined();
    await expect(store.loadDocument(stageId)).resolves.toBeNull();
  });
});
