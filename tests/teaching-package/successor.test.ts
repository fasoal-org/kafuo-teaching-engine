import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  ensureTeachingPackageSchema,
  insertVersion,
  listVersionsByItem,
  readVersion,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { approve, createSuccessor, submitForReview } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene, ScenePatch } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { SceneTeachingSkills } from '@/lib/types/teaching-package';
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

async function expectTpError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TeachingPackageError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('createSuccessor', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-succ-${(counter += 1)}`;
  /** The row helpers take the pg `Queryable` interface; PGlite satisfies it at runtime. */
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://successor-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function seedStage(stageId: string): Promise<void> {
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(stageId, 'Successor seed', [makeSlideScene('scene-1', stageId, 1)]),
    );
  }

  async function seedApproved(item: { type: 'lesson' | 'section'; id: string }): Promise<string> {
    const stageId = nextId('stage');
    await seedStage(stageId);
    const versionId = nextId('tpv');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: 'approved',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    return versionId;
  }

  async function liveStageCount(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
    );
    return (result.rows[0] as { n: number }).n;
  }

  it('creates a draft successor with a cloned stage and leaves v1 untouched', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const v1 = await seedApproved(item);

    const created = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: v1,
      actorRef: 'actor-1',
    });
    expect(created).toMatchObject({
      version: 2,
      status: 'draft',
      predecessorVersionId: v1,
      currentAttemptId: null,
      learningItem: item,
      teachingModel: { key: 'g5', version: 'g5.v1' },
    });
    expect(created.currentStageId).not.toBe(
      (await readVersion(qp(), v1, { tenantId: 'tenant-test' }))!.currentStageId,
    );

    const unchanged = await readVersion(qp(), v1, { tenantId: 'tenant-test' });
    expect(unchanged).toMatchObject({ status: 'approved', version: 1 });
    // The successor's event names its lineage.
    const events = await pool.query(
      `SELECT event_type, data FROM teaching_package_review_events WHERE version_id = $1`,
      [created.id],
    );
    const eventRow = events.rows[0] as { event_type: string; data: Record<string, unknown> };
    expect(eventRow).toMatchObject({ event_type: 'successor_created' });
    expect(eventRow.data).toMatchObject({
      clonedFromVersionId: v1,
      sourceStageId: unchanged!.currentStageId,
      stageId: created.currentStageId,
    });
  });

  it('stage-clone preserves Scene Teaching Skills lineage by spread, and legacy scenes stay legacy (Module 2 W9)', async () => {
    /* FR-TS-048 / VAL-TS-013: a same-model successor's cloned Scenes retain the
       exact Skill identity/version assignments — automatically, because the
       clone spreads Scenes. A legacy Scene without the carrier must clone
       equally fine, its absence explicit and unfabricated (AC-TS-034). */
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    const governed = makeSlideScene('scene-skills', stageId, 1);
    const teachingSkills: SceneTeachingSkills = {
      primary: { skillId: 'feynman-learning', version: 'v1' },
      supporting: [{ skillId: 'learning-to-learn', version: 'v1' }],
      classification: 'instructional',
    };
    const legacy = makeSlideScene('scene-legacy', stageId, 2);
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    // The write boundary accepts the additive carrier (absent → untouched;
    // present → unvalidated until W12) exactly as it accepts teachingStage.
    await store.saveDocument(
      makeDocument(stageId, 'Skills seed', [{ ...governed, teachingSkills }, legacy]),
    );
    const versionId = nextId('tpv');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: 'approved',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    const created = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId,
      actorRef: 'actor-1',
    });

    const cloned = await store.loadDocument(created.currentStageId!);
    expect(cloned?.scenes).toHaveLength(2);
    const clonedGoverned = cloned!.scenes.find((scene) => scene.id === 'scene-skills')!;
    const clonedLegacy = cloned!.scenes.find((scene) => scene.id === 'scene-legacy')!;
    // Lineage survives the clone byte-for-byte (primary, supporting, classification).
    expect(clonedGoverned.teachingSkills).toEqual(teachingSkills);
    // The legacy Scene clones without the carrier — absence preserved, nothing fabricated.
    expect(clonedLegacy.teachingSkills).toBeUndefined();
    expect('teachingSkills' in clonedLegacy).toBe(false);
    // The approved predecessor keeps its own Stage untouched.
    const original = await store.loadDocument(stageId);
    expect(original!.scenes.find((scene) => scene.id === 'scene-skills')!.teachingSkills).toEqual(
      teachingSkills,
    );
  });

  it('refuses while an active successor exists and leaves no clone behind', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const v1 = await seedApproved(item);
    const v2Stage = nextId('stage');
    await seedStage(v2Stage);
    const v2 = nextId('tpv');
    await insertVersion(qp(), {
      id: v2,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 2,
      status: 'draft',
      currentStageId: v2Stage,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      predecessorVersionId: v1,
      now: 2,
    });
    const liveBefore = await liveStageCount();

    await expectTpError(
      createSuccessor(txPool(), { tenantId: 'tenant-test', versionId: v1, actorRef: 'actor-1' }),
      'ACTIVE_SUCCESSOR_EXISTS',
    );
    // The pre-check fires before any clone: no extra live stage_meta row.
    expect(await liveStageCount()).toBe(liveBefore);
  });

  it('refuses a successor of a non-approved version', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await seedStage(stageId);
    const v1 = nextId('tpv');
    await insertVersion(qp(), {
      id: v1,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });

    await expectTpError(
      createSuccessor(txPool(), { tenantId: 'tenant-test', versionId: v1, actorRef: 'actor-1' }),
      'INVALID_TRANSITION',
    );
    await expectTpError(
      createSuccessor(txPool(), {
        tenantId: 'tenant-test',
        versionId: 'tpv-absent',
        actorRef: 'actor-1',
      }),
      'NOT_FOUND',
    );
  });

  it('tombstones the orphan clone when the version transaction fails', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const v1 = await seedApproved(item);

    // The clone commits through the provider pool; the version transaction
    // (this wrapped pool) fails on the INSERT, so compensation must tombstone
    // the otherwise-orphaned clone.
    const failTxInsert = async (text: string, params?: unknown[]) => {
      if (text.includes('INSERT INTO teaching_package_versions')) {
        throw new Error('injected version insert failure');
      }
      return pool.query(text, params);
    };
    const failingTxPool: ConnectableQueryable = {
      query: failTxInsert,
      connect: async () => ({ query: failTxInsert, release() {} }),
    } as unknown as ConnectableQueryable;

    await expect(
      createSuccessor(failingTxPool, {
        tenantId: 'tenant-test',
        versionId: v1,
        actorRef: 'actor-1',
      }),
    ).rejects.toThrow('injected version insert failure');

    // No version beyond v1 exists, and the orphan clone is invisible: only the
    // v1 stage row is live.
    const versions = await listVersionsByItem(qp(), {
      tenantId: 'tenant-test',
      learningItem: item,
    });
    expect(versions).toHaveLength(1);
    const live = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
    );
    expect((live.rows[0] as { n: number }).n).toBe(1);
  });

  it('uses the next version number after a discard, and chains v2 → v3', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const v1 = await seedApproved(item);

    const v2 = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: v1,
      actorRef: 'actor-1',
    });
    expect(v2.version).toBe(2);
    const { discardSuccessor } = await import('@/lib/server/teaching-package/lifecycle');
    await discardSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: v2.id,
      actorRef: 'actor-1',
    });

    const v3 = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: v1,
      actorRef: 'actor-1',
    });
    expect(v3.version).toBe(3);

    // Full chain: approve v3 → v1 superseded; create v4 from v3.
    await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId: v3.id,
      actorRef: 'actor-1',
    });
    const approved = await approve(txPool(), {
      tenantId: 'tenant-test',
      versionId: v3.id,
      actorRef: 'reviewer-1',
    });
    expect(approved.status).toBe('approved');
    expect((await readVersion(qp(), v1, { tenantId: 'tenant-test' }))!.status).toBe('superseded');

    const v4 = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: v3.id,
      actorRef: 'actor-1',
    });
    expect(v4.version).toBe(4);
    expect(v4.predecessorVersionId).toBe(v3.id);
    const versions = await listVersionsByItem(qp(), {
      tenantId: 'tenant-test',
      learningItem: item,
    });
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3, 4]);
  });
});

describe('ScenePatch stays non-distributive with the Teaching Skills carrier (W9 stop condition)', () => {
  it('accepts a generic content patch spanning all scene kinds', () => {
    // `AppScene` is a discriminated union and `Partial<>` would distribute over
    // it into per-kind partials, making a generic `{ content }` patch match
    // none of them. `ScenePatch` must stay ONE object type — adding the
    // optional `teachingSkills` field must not change that.
    const patch: ScenePatch = { content: makeSlideScene('x', 'y', 1).content };
    expect(patch.content).toBeDefined();
  });

  it('exposes the carrier as an ordinary optional patch field', () => {
    const patch: ScenePatch = { teachingSkills: { classification: 'instructional' } };
    expect(patch.teachingSkills?.classification).toBe('instructional');
  });
});
