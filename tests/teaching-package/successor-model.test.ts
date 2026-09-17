/**
 * W13 — Successor Teaching Model identity checks (teaching-skills plan §P
 * Step 13 · §L · §M correction 2 · FR-TS-047/048/049/050/072 · VAL-TS-024 ·
 * AC-TS-018/019/033).
 *
 * Covers:
 * - the three successor cases by (key, version) pair;
 * - the defensive Submit lineage check (governed only — behind the W6
 *   discriminator, so a legacy successor can never see it);
 * - the materially-edited legacy-derived successor refusal (§M correction 2),
 *   including the proof that metadata-only edits and clone-only successors
 *   stay submittable and the approved predecessor stays byte-unchanged;
 * - the model-change ⟹ Stage-replacement invariant over its exactly two
 *   writers, and the source pin that `createSuccessor` / `relinkVersionStage`
 *   keep their original teaching-model call shapes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readVersion,
  relinkVersionStage,
} from '@/lib/persistence/teaching-package';
import { submitForReview } from '@/lib/server/teaching-package/lifecycle';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import {
  compareSuccessorMaterialScenes,
  isCloneOnlySuccessor,
  readProducingAttemptTeachingModel,
  resolveSuccessorTeachingModelCase,
  teachingModelLineageDrift,
} from '@/lib/server/teaching-package/successor-model';
import {
  MATERIAL_SCENE_FIELDS,
  NON_MATERIAL_SCENE_FIELDS,
  sceneMaterialFingerprint,
  stampGenerationAlignmentBaselines,
} from '@/lib/server/teaching-package/alignment';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
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

async function expectTpError(
  promise: Promise<unknown>,
  code: string,
): Promise<TeachingPackageError> {
  const rejection = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(TeachingPackageError);
  expect(rejection).toMatchObject({ code });
  return rejection as TeachingPackageError;
}

const FEYNMAN_REF = { skillId: 'feynman-learning', version: 'v1' };

describe('W13 pure comparisons', () => {
  const g5v1 = { key: 'g5', version: 'g5.v1' };
  const g5v2 = { key: 'g5', version: 'g5.v2' };
  const g6v1 = { key: 'g6', version: 'g6.v1' };

  it('distinguishes the three successor cases by the (key, version) pair', () => {
    expect(resolveSuccessorTeachingModelCase(g5v1, g5v1)).toBe('same-pair');
    expect(resolveSuccessorTeachingModelCase(g5v2, g5v1)).toBe('changed-version');
    expect(resolveSuccessorTeachingModelCase(g6v1, g5v1)).toBe('changed-key');
    // The pair is compared component-wise: a changed key with a same-looking
    // version string is still a changed key, never "same version".
    expect(resolveSuccessorTeachingModelCase({ key: 'g6', version: 'g5.v1' }, g5v1)).toBe(
      'changed-key',
    );
  });

  it('teachingModelLineageDrift fires on either component, and never without an attempt', () => {
    expect(teachingModelLineageDrift(g5v1, g5v1)).toBeNull();
    expect(teachingModelLineageDrift(g5v1, null)).toBeNull();
    expect(teachingModelLineageDrift(g5v2, g5v1)).toEqual({ declared: g5v2, producing: g5v1 });
    expect(teachingModelLineageDrift(g6v1, g5v1)).toEqual({ declared: g6v1, producing: g5v1 });
  });

  it('compareSuccessorMaterialScenes sees exactly the R-6 boundary', () => {
    const base = makeSlideScene('s1', 'stage-a', 1);
    // Every material field, one edit each. (AppScene has no top-level
    // description field today; a defensive description read is pinned below.)
    const mutations: Array<(scene: AppScene) => AppScene> = [
      (scene) => ({ ...scene, title: 'Changed title' }),
      (scene) =>
        ({
          ...scene,
          content: {
            ...scene.content,
            canvas: {
              ...(scene.content as { canvas: { viewportSize: number } }).canvas,
              viewportSize: 800,
            },
          },
        }) as AppScene,
      (scene) => ({ ...scene, actions: [] as AppScene['actions'] }),
    ];
    for (const mutate of mutations) {
      const comparison = compareSuccessorMaterialScenes([mutate(base)], [base]);
      expect(comparison.editedSceneIds, String(mutate)).toEqual(['s1']);
    }
    // A Scene-level description, if the field ever exists, is material (R-6).
    const described = {
      ...base,
      description: 'A materially different framing',
    } as unknown as AppScene;
    expect(compareSuccessorMaterialScenes([described], [base]).editedSceneIds).toEqual(['s1']);
    // Every non-material field: order, outlineId, stageId, updatedAt — plus the
    // clone's own re-stamps. None of these may reach the fingerprint.
    const moved = {
      ...base,
      order: 42,
      outlineId: 'outline-other',
      stageId: 'stage-b',
      updatedAt: (base.updatedAt ?? 0) + 5_000,
    };
    expect(compareSuccessorMaterialScenes([moved], [base]).editedSceneIds).toEqual([]);
    expect(sceneMaterialFingerprint(moved)).toBe(sceneMaterialFingerprint(base));
    // Added and removed scenes are material.
    const withAdded = compareSuccessorMaterialScenes(
      [base, makeSlideScene('s2', 'stage-a', 2)],
      [base],
    );
    expect(withAdded.addedSceneIds).toEqual(['s2']);
    expect(withAdded.removedSceneIds).toEqual([]);
    const withRemoved = compareSuccessorMaterialScenes(
      [base],
      [base, makeSlideScene('s2', 'stage-a', 2)],
    );
    expect(withRemoved.removedSceneIds).toEqual(['s2']);
    expect(isCloneOnlySuccessor(compareSuccessorMaterialScenes([moved], [base]))).toBe(true);
  });

  it('the fingerprint boundary is pinned to the closed R-6 field set', () => {
    expect([...MATERIAL_SCENE_FIELDS]).toEqual(['content', 'actions', 'title', 'description']);
    expect([...NON_MATERIAL_SCENE_FIELDS]).toEqual(['order', 'outlineId', 'stageId', 'updatedAt']);
  });
});

describe('W13 submit-gate successor checks', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-w13-${(counter += 1)}`;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w13-${randomUUID()}`);
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

  function makeStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  async function seedStage(stageId: string, scenes: AppScene[]): Promise<void> {
    await makeStore().saveDocument(makeDocument(stageId, `W13 ${stageId}`, scenes));
  }

  interface SeedVersionOptions {
    status?: 'draft' | 'approved';
    predecessorVersionId?: string;
    currentAttemptId?: string | null;
    versionNumber?: number;
    teachingModel?: { key: string; version: string };
    /** Written onto the attempt row this seed inserts (when attemptId is set). */
    attempt?: {
      id: string;
      contract?: string | null;
      flow?: TeachingFlowEntry[];
      teachingModel?: { key: string; version: string };
    };
  }

  async function seedVersion(
    item: { type: 'lesson' | 'section'; id: string },
    options: SeedVersionOptions & { versionId: string; stageId: string },
  ): Promise<string> {
    const teachingModel = options.teachingModel ?? { key: 'g5', version: 'g5.v1' };
    await insertVersion(qp(), {
      id: options.versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: options.versionNumber ?? 1,
      status: options.status ?? 'draft',
      currentStageId: options.stageId,
      currentAttemptId: options.currentAttemptId ?? null,
      teachingModel,
      predecessorVersionId: options.predecessorVersionId ?? null,
      now: 1,
    });
    if (options.attempt) {
      await insertAttempt(qp(), {
        id: options.attempt.id,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'actor-1',
        teachingModel: options.attempt.teachingModel ?? teachingModel,
        inputSnapshot: {
          learningItem: item,
          teachingModel: options.attempt.teachingModel ?? teachingModel,
          learningObjectives: [],
          contentUnitRefs: [],
          sourceRefs: [],
          generationContext: {},
          generationOptions: {},
          requirementDigest: '0'.repeat(64),
          requirementPreview: 'p',
          pdfContentSummary: null,
          requestedAt: 1,
          ...(options.attempt.flow ? { teachingFlow: options.attempt.flow } : {}),
        },
        ...(options.attempt.contract !== undefined && options.attempt.contract !== null
          ? { teachingSkillsContract: options.attempt.contract }
          : {}),
        now: 1,
      });
    }
    return options.versionId;
  }

  const flow: TeachingFlowEntry[] = [
    { stage: 'lesson_introduction', instructions: 'i' },
    { stage: 'outcome_teaching_cards', instructions: 'c' },
  ];

  /** Flow entries carrying permissive policy, for the governed gate's checks. */
  const governedPolicyFlow: TeachingFlowEntry[] = [
    {
      stage: 'lesson_introduction',
      instructions: 'i',
      skillPolicy: {
        required: [],
        preferred: [],
        allowed: [FEYNMAN_REF, { skillId: 'lecture-style', version: 'v1' }],
        combinationRestrictions: [],
      },
    },
    {
      stage: 'outcome_teaching_cards',
      instructions: 'c',
      skillPolicy: {
        required: [],
        preferred: [],
        allowed: [FEYNMAN_REF, { skillId: 'lecture-style', version: 'v1' }],
        combinationRestrictions: [],
      },
    },
  ];

  function flowScenes(stageId: string): AppScene[] {
    return [
      {
        ...makeSlideScene('s1', stageId, 1),
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      },
      {
        ...makeSlideScene('s2', stageId, 2),
        teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
      },
    ];
  }

  /**
   * The fully valid governed shape (W17): flow-tagged, classified, in-policy
   * selections with generation baselines — the state a governed generation
   * leaves behind. The two defensive-check tests below must reach check 11,
   * which sits AFTER checks 4–10 in the assembled gate.
   */
  function governedFlowScenes(stageId: string): AppScene[] {
    return stampGenerationAlignmentBaselines(
      [
        {
          ...makeSlideScene('s1', stageId, 1),
          teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
          teachingSkills: { primary: FEYNMAN_REF, classification: 'instructional' as const },
        },
        {
          ...makeSlideScene('s2', stageId, 2),
          teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
          teachingSkills: { classification: 'non-instructional' as const },
        },
      ],
      1,
    );
  }

  // ---- the materially-edited legacy-derived successor (§M correction 2) ----

  it('refuses a materially edited tier-A legacy successor at Submit and leaves the predecessor byte-unchanged', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const predecessorStage = nextId('stage');
    await seedStage(predecessorStage, [makeSlideScene('s1', predecessorStage, 1)]);
    const predecessorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: predecessorStage,
      status: 'approved',
    });
    const beforeFingerprint = sceneMaterialFingerprint(
      (await makeStore().loadDocument(predecessorStage))!.scenes[0]!,
    );

    // Successor via the real clone path: createSuccessor copies the Stage.
    const { createSuccessor } = await import('@/lib/server/teaching-package/lifecycle');
    const successor = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: predecessorId,
      actorRef: 'actor-1',
    });

    // A MATERIAL edit on the successor's stage (title is inside R-6).
    const store = makeStore();
    const document = await store.loadDocument(successor.currentStageId);
    await store.putScene(successor.currentStageId, {
      ...document!.scenes[0]!,
      title: 'Materially changed',
    });

    const error = await expectTpError(
      submitForReview(txPool(), {
        tenantId: 'tenant-test',
        versionId: successor.id,
        actorRef: 'reviewer-1',
      }),
      'STALE_STATE',
    );
    expect((error.details as { reason?: string }).reason).toBe(
      'legacy_successor_materially_edited',
    );
    expect((error.details as { offendingSceneIds?: string[] }).offendingSceneIds).toEqual(['s1']);

    // Failure isolation: the predecessor is untouched, byte-for-byte.
    expect((await readVersion(qp(), predecessorId, { tenantId: 'tenant-test' }))!.status).toBe(
      'approved',
    );
    const afterScenes = (await makeStore().loadDocument(predecessorStage))!.scenes;
    expect(afterScenes.map(sceneMaterialFingerprint)).toEqual([beforeFingerprint]);
  });

  it('keeps a clone-only tier-A legacy successor submittable (the §M carve-out)', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const predecessorStage = nextId('stage');
    await seedStage(predecessorStage, [makeSlideScene('s1', predecessorStage, 1)]);
    const predecessorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: predecessorStage,
      status: 'approved',
    });
    const { createSuccessor } = await import('@/lib/server/teaching-package/lifecycle');
    const successor = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: predecessorId,
      actorRef: 'actor-1',
    });
    const updated = await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId: successor.id,
      actorRef: 'reviewer-1',
    });
    expect(updated.status).toBe('in_review');
  });

  it('a metadata-only edit on a tier-A legacy successor does not refuse Submit (R-6)', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const predecessorStage = nextId('stage');
    await seedStage(predecessorStage, [makeSlideScene('s1', predecessorStage, 1)]);
    const predecessorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: predecessorStage,
      status: 'approved',
    });
    const { createSuccessor } = await import('@/lib/server/teaching-package/lifecycle');
    const successor = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: predecessorId,
      actorRef: 'actor-1',
    });
    // Non-material: order and updatedAt move; sceneRev bumps; nothing R-6-material.
    const store = makeStore();
    const document = await store.loadDocument(successor.currentStageId);
    await store.putScene(successor.currentStageId, {
      ...document!.scenes[0]!,
      order: 9,
      updatedAt: (document!.scenes[0]!.updatedAt ?? 0) + 1_000,
    });
    const updated = await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId: successor.id,
      actorRef: 'reviewer-1',
    });
    expect(updated.status).toBe('in_review');
  });

  it('refuses a materially edited tier-B legacy successor (flow present, no governance)', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const predecessorStage = nextId('stage');
    await seedStage(predecessorStage, flowScenes(predecessorStage));
    const attemptId = nextId('tpa');
    const predecessorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: predecessorStage,
      status: 'approved',
      currentAttemptId: attemptId,
      attempt: { id: attemptId, contract: null, flow },
    });
    const { createSuccessor } = await import('@/lib/server/teaching-package/lifecycle');
    const successor = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: predecessorId,
      actorRef: 'actor-1',
    });
    const store = makeStore();
    const document = await store.loadDocument(successor.currentStageId);
    await store.putScene(successor.currentStageId, {
      ...document!.scenes[0]!,
      title: 'A materially different framing',
    });
    await expectTpError(
      submitForReview(txPool(), {
        tenantId: 'tenant-test',
        versionId: successor.id,
        actorRef: 'reviewer-1',
      }),
      'STALE_STATE',
    );
  });

  it('a clone-only tier-B successor still submits', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const predecessorStage = nextId('stage');
    await seedStage(predecessorStage, flowScenes(predecessorStage));
    const attemptId = nextId('tpa');
    const predecessorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: predecessorStage,
      status: 'approved',
      currentAttemptId: attemptId,
      attempt: { id: attemptId, contract: null, flow },
    });
    const { createSuccessor } = await import('@/lib/server/teaching-package/lifecycle');
    const successor = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: predecessorId,
      actorRef: 'actor-1',
    });
    const updated = await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId: successor.id,
      actorRef: 'reviewer-1',
    });
    expect(updated.status).toBe('in_review');
  });

  it('a materially edited tier-A v1 (no predecessor) stays legacy and submittable (§28.5)', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await seedStage(stageId, [makeSlideScene('s1', stageId, 1)]);
    const versionId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId,
      status: 'draft',
    });
    const store = makeStore();
    const document = await store.loadDocument(stageId);
    await store.putScene(stageId, { ...document!.scenes[0]!, title: 'Edited v1' });
    const updated = await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId,
      actorRef: 'reviewer-1',
    });
    expect(updated.status).toBe('in_review');
  });

  // ---- the defensive lineage check (§L) — governed only ----

  it('refuses a governed version whose declared (key, version) drifted from its producing attempt', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await seedStage(stageId, governedFlowScenes(stageId));
    const attemptId = nextId('tpa');
    const versionId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId,
      status: 'draft',
      currentAttemptId: attemptId,
      attempt: { id: attemptId, contract: 'kafuo.teaching-skills.v1', flow: governedPolicyFlow },
    });
    // Break the §B.12 invariant the way a future buggy path would: the version
    // row declares a model the producing attempt never used. This is the
    // guard-fail proof — the check exists precisely for a path that does not
    // exist yet.
    await pool.query(
      `UPDATE teaching_package_versions SET teaching_model_key = $2, teaching_model_version = $3 WHERE id = $1`,
      [versionId, 'g5', 'g5.v2'],
    );
    const error = await expectTpError(
      submitForReview(txPool(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' }),
      'STALE_STATE',
    );
    expect((error.details as { reason?: string }).reason).toBe('teaching_model_lineage_drift');
    expect((error.details as { declaredTeachingModel?: unknown }).declaredTeachingModel).toEqual({
      key: 'g5',
      version: 'g5.v2',
    });
  });

  it('a governed version with an intact pair submits (the check does not over-fire)', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await seedStage(stageId, governedFlowScenes(stageId));
    const attemptId = nextId('tpa');
    const versionId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId,
      status: 'draft',
      currentAttemptId: attemptId,
      attempt: { id: attemptId, contract: 'kafuo.teaching-skills.v1', flow: governedPolicyFlow },
    });
    const updated = await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId,
      actorRef: 'reviewer-1',
    });
    expect(updated.status).toBe('in_review');
  });

  it('never emits the lineage-drift refusal for a LEGACY version — the discriminator precedes it', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await seedStage(stageId, flowScenes(stageId));
    const attemptId = nextId('tpa');
    const versionId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId,
      status: 'draft',
      currentAttemptId: attemptId,
      attempt: { id: attemptId, contract: null, flow },
    });
    // Same tamper as the governed test — but this version is tier-B legacy, so
    // the drift check must stay silent (exact-flow still applies to the flow).
    await pool.query(
      `UPDATE teaching_package_versions SET teaching_model_version = $2 WHERE id = $1`,
      [versionId, 'g5.v9'],
    );
    const updated = await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId,
      actorRef: 'reviewer-1',
    });
    expect(updated.status).toBe('in_review');
  });

  it('resolves the producing attempt model through the predecessor walk', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const attemptId = nextId('tpa');
    const predecessorStage = nextId('stage');
    await seedStage(predecessorStage, flowScenes(predecessorStage));
    const predecessorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: predecessorStage,
      status: 'approved',
      currentAttemptId: attemptId,
      attempt: {
        id: attemptId,
        contract: null,
        flow,
        teachingModel: { key: 'g5', version: 'g5.v3' },
      },
    });
    const successorStage = nextId('stage');
    await seedStage(successorStage, flowScenes(successorStage));
    const successorId = await seedVersion(item, {
      versionId: nextId('tpv'),
      stageId: successorStage,
      status: 'draft',
      versionNumber: 2,
      predecessorVersionId: predecessorId,
      teachingModel: { key: 'g5', version: 'g5.v3' },
    });
    // No attempt of its own: the walk must land on the predecessor's attempt.
    expect(await readProducingAttemptTeachingModel(qp(), successorId)).toEqual({
      key: 'g5',
      version: 'g5.v3',
    });
    // A chain with no attempt anywhere resolves null (tier A).
    const orphanStage = nextId('stage');
    await seedStage(orphanStage, [makeSlideScene('s1', orphanStage, 1)]);
    const orphanId = await seedVersion(
      { type: 'lesson', id: nextId('li') },
      {
        versionId: nextId('tpv'),
        stageId: orphanStage,
        status: 'draft',
      },
    );
    expect(await readProducingAttemptTeachingModel(qp(), orphanId)).toBeNull();
  });
});

describe('W13 model-change ⟹ Stage-replacement invariant (§B.12)', () => {
  it('relinkVersionStage — the only model UPDATE — always carries a new stageId and attemptId', async () => {
    const db = new PGlite();
    await db.waitReady;
    const pool = new PGlitePool(db);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    const item = { type: 'lesson' as const, id: 'li-w13-inv' };
    for (const stageId of ['stage-old', 'stage-new']) {
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ($1, 'seed stage', 1, 1, '{}'::jsonb)`,
        [stageId],
      );
    }
    await insertVersion(pool as never, {
      id: 'tpv-inv',
      aggregate: { tenantId: 't', learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-old',
      currentAttemptId: null,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    const relinked = await relinkVersionStage(pool as never, 'tpv-inv', {
      stageId: 'stage-new',
      attemptId: 'tpa-new',
      teachingModel: { key: 'g5', version: 'g5.v2' },
      now: 2,
    });
    // The UPDATE moves model, stage AND attempt together — a Teaching Model
    // change never leaves the old Stage in place.
    expect(relinked!.teachingModel).toEqual({ key: 'g5', version: 'g5.v2' });
    expect(relinked!.currentStageId).toBe('stage-new');
    expect(relinked!.currentAttemptId).toBe('tpa-new');
    await pool.end();
  });

  it('teaching_model_key/version have exactly two writers — insertVersion INSERT and relinkVersionStage UPDATE', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'lib/persistence/teaching-package.ts'),
      'utf8',
    );
    // The versions table's model columns: one INSERT, one UPDATE, nothing else.
    const versionStatements =
      source.match(
        /(?:INSERT INTO|UPDATE)\s+teaching_package_versions[^;]*teaching_model_key[^;]*/g,
      ) ?? [];
    expect(versionStatements).toHaveLength(2);
    expect(versionStatements[0]).toMatch(/INSERT INTO teaching_package_versions/);
    expect(versionStatements[1]).toMatch(/UPDATE teaching_package_versions/);
    // The UPDATE must set the stage and attempt in the same statement — that is
    // what makes "model changed ⟺ Stage replaced" structural.
    expect(versionStatements[1]).toMatch(/current_stage_id = \$2/);
    expect(versionStatements[1]).toMatch(/current_attempt_id = \$3/);
    expect(versionStatements[1]).toMatch(/teaching_model_key = \$4/);
    expect(versionStatements[1]).toMatch(/teaching_model_version = \$5/);
    // The attempts table's copy is INSERT-only: no UPDATE ever touches it.
    const attemptUpdates =
      source.match(/UPDATE\s+teaching_package_generation_attempts[^;]*teaching_model_key[^;]*/g) ??
      [];
    expect(attemptUpdates).toHaveLength(0);
  });

  it('createSuccessor and replaceStageAfterRegeneration keep their original teaching-model call shapes', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'lib/server/teaching-package/lifecycle.ts'),
      'utf8',
    );
    expect(source).toContain('teachingModel: lockedSource.teachingModel,');
    expect(source).toContain('teachingModel: attempt.teachingModel,');
  });
});
