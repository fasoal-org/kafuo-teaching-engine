import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentVersionError } from '@openmaic/storage';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { carryForwardSceneLineage } from '@/lib/persistence/owner-bound-document-store';
import { putSceneBringingCurrent } from '@/lib/server/agent-runtime/document-writes';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
} from '@/lib/persistence/teaching-package';
import { deriveSceneAlignment } from '@/lib/server/teaching-package/alignment';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { resolveGovernedRegenerationContext } from '@/lib/server/teaching-package/governed-regeneration';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { AppScene, Scene, Stage } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * Module 3/4 W4 (plan §7.4.2): the governed-lineage carry-forward on
 * whole-Scene writes — the owner-bound store's putScene (where the
 * grant-delegated PUT /documents/<stageId>/scenes/<sceneId> and every
 * server-side caller converge) and the not-current whole-document fallback —
 * plus the resolver and W4.4 manual-edit semantics.
 */

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

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'Open by connecting the goal.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN],
      combinationRestrictions: [],
    },
  },
  {
    stage: 'outcome_teaching_cards',
    instructions: 'Consolidate the outcome.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN],
      combinationRestrictions: [],
    },
  },
];

/** A governed Scene at position 0 with all four lineage carriers + baseline. */
function governedScene(id: string, stageId: string, order: number): AppScene {
  const base = makeSlideScene(id, stageId, order);
  return {
    ...base,
    teachingStage: { key: FLOW[0]!.stage, flowIndex: 0 },
    teachingSkills: { classification: 'instructional' as const, primary: FEYNMAN },
    learningObjectives: [],
    alignmentBaseline: {
      primary: FEYNMAN,
      classification: 'instructional',
      fingerprint: 'f'.repeat(64),
      establishedAt: 111,
      origin: 'generation',
    },
  } as AppScene;
}

describe('scene lineage carry-forward (W4.2)', () => {
  describe('the pure helper', () => {
    it('carries all four carriers when the incoming Scene omits them', () => {
      const stored = governedScene('s1', 'st', 1);
      const incoming = makeSlideScene('s1', 'st', 1) as AppScene;
      const merged = carryForwardSceneLineage(stored, incoming);
      expect(merged.teachingStage).toEqual(stored.teachingStage);
      expect(merged.teachingSkills).toEqual(stored.teachingSkills);
      expect(merged.learningObjectives).toEqual(stored.learningObjectives);
      expect(merged.alignmentBaseline).toEqual(stored.alignmentBaseline);
    });

    it('fabricates nothing for a non-governed stored Scene', () => {
      const stored = makeSlideScene('s1', 'st', 1);
      const incoming = makeSlideScene('s1', 'st', 1);
      const merged = carryForwardSceneLineage(stored, incoming);
      for (const key of [
        'teachingStage',
        'teachingSkills',
        'learningObjectives',
        'alignmentBaseline',
      ] as const) {
        expect(key in merged).toBe(false);
      }
    });

    it('an incoming carrier wins over the stored one', () => {
      const stored = governedScene('s1', 'st', 1);
      const incoming = {
        ...makeSlideScene('s1', 'st', 1),
        teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
      } as AppScene;
      const merged = carryForwardSceneLineage(stored, incoming);
      expect(merged.teachingStage).toEqual({ key: 'outcome_teaching_cards', flowIndex: 1 });
    });
  });

  describe('the not-current whole-document fallback (putSceneBringingCurrent)', () => {
    it('preserves carriers identically to the fast path', async () => {
      const stored = governedScene('s1', 'st', 1);
      const lineageLess = makeSlideScene('s1', 'st', 1) as Scene;
      const saved: Scene[] = [];
      const store = {
        putScene: vi.fn(async () => {
          throw new DocumentVersionError('st', 'not-current', '0.9.0', 'stale stored stamp');
        }),
        loadDocument: vi.fn(async () => ({
          stage: { id: 'st', name: 'S', createdAt: 1, updatedAt: 1 },
          scenes: [stored],
          outline: {},
        })),
        saveDocument: vi.fn(async (doc: { scenes: Scene[] }) => {
          saved.push(...doc.scenes);
        }),
      } as never;

      await putSceneBringingCurrent(store, 'st', lineageLess);

      expect(saved).toHaveLength(1);
      expect(saved[0]!.teachingStage).toEqual(stored.teachingStage);
      expect(saved[0]!.teachingSkills).toEqual(stored.teachingSkills);
      expect(saved[0]!.learningObjectives).toEqual(stored.learningObjectives);
      expect(saved[0]!.alignmentBaseline).toEqual(stored.alignmentBaseline);
    });
  });

  describe('putScene on the owner-bound store (the live seam)', () => {
    let pool: PGlitePool;
    let counter = 0;
    const nextId = (prefix: string) => `${prefix}-cf-${(counter += 1)}`;
    const qp = () => pool as never;

    function makeStore() {
      return createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId: TEACHING_PACKAGE_STAGE_OWNER,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence: teachingPackageStageGuardFence(),
      });
    }

    beforeEach(async () => {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv('DATABASE_URL', `postgres://cf-${randomUUID()}`);
      vi.stubEnv('ASSET_S3_BUCKET', '');
      vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
      const db = new PGlite();
      await db.waitReady;
      pool = new PGlitePool(db);
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
      await ensureDocumentSchema(qp());
      await ensureStageMetaSchema(qp());
      await ensureTeachingPackageSchema(qp());
    });

    afterEach(async () => {
      await pool.end();
      vi.unstubAllEnvs();
    });

    /** Seed a governed stage (scene + version + governed attempt). */
    async function seedGovernedStage(): Promise<{ stageId: string; versionId: string }> {
      const stageId = nextId('stage');
      await makeStore().saveDocument(
        makeDocument(stageId, 'CF', [governedScene('s-cf-1', stageId, 1)]),
      );
      const item = { type: 'lesson' as const, id: nextId('li') };
      const versionId = nextId('tpv');
      const attemptId = nextId('tpa');
      await insertVersion(qp(), {
        id: versionId,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        version: 1,
        status: 'draft',
        currentStageId: stageId,
        currentAttemptId: attemptId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
      await insertAttempt(qp(), {
        id: attemptId,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'actor-1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        teachingSkillsContract: 'kafuo.teaching-skills.v1',
        inputSnapshot: {
          learningItem: item,
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
          teachingFlow: FLOW,
        },
        now: 1,
      });
      return { stageId, versionId };
    }

    it('a grant-delegated-style PUT carrying a lineage-less Scene retains all four carriers', async () => {
      const { stageId } = await seedGovernedStage();
      const store = makeStore();
      const before = (await store.loadDocument(stageId))!.scenes[0]!;

      // Exactly what the write-grant PUT delegates to (document-access →
      // owner-bound store putScene): a whole Scene with no lineage fields.
      const lineageLess = makeSlideScene('s-cf-1', stageId, 1) as AppScene;
      await store.putScene(stageId, lineageLess);

      const after = (await store.loadDocument(stageId))!.scenes[0]!;
      expect(after.teachingStage).toEqual(before.teachingStage);
      expect(after.teachingSkills).toEqual(before.teachingSkills);
      expect(after.learningObjectives).toEqual(before.learningObjectives);
      expect(after.alignmentBaseline).toEqual(before.alignmentBaseline);
    });

    it('a manual material edit retains the existing baseline and derives stale (W4.4)', async () => {
      const { stageId } = await seedGovernedStage();
      const store = makeStore();
      const before = (await store.loadDocument(stageId))!.scenes[0]!;

      // A timeline-style edit: new title, same identity, carriers supplied or
      // not — the stored baseline is RETAINED as historical evidence and the
      // Scene derives stale/material-change (§K ladder).
      await store.putScene(stageId, { ...before, title: 'Materially edited' });

      const after = (await store.loadDocument(stageId))!.scenes[0]!;
      expect(after.alignmentBaseline).toEqual(before.alignmentBaseline);
      expect(after.alignmentBaseline?.establishedAt).toBe(111);
      expect(deriveSceneAlignment(after)).toMatchObject({
        state: 'stale',
        aligned: false,
        reason: 'material-change',
      });
    });

    it('resolveGovernedRegenerationContext: governed, legacy, and unresolvable shapes', async () => {
      const { versionId, stageId } = await seedGovernedStage();
      const store = makeStore();
      const scene = (await store.loadDocument(stageId))!.scenes[0]!;

      // Governed: the exact Flow position plus resolved Skill definitions.
      const context = await resolveGovernedRegenerationContext(qp(), versionId, scene);
      expect(context).toBeDefined();
      expect(context!.flowContext).toEqual({
        teachingModelKey: 'g5',
        teachingModelVersion: 'g5.v1',
        stageKey: 'lesson_introduction',
        flowIndex: 0,
        instructions: 'Open by connecting the goal.',
      });
      expect(context!.resolvedSkills.map((skill) => skill.skillId)).toContain('feynman-learning');

      // Legacy (tier B: flow, no marker): undefined, never a throw.
      const tierB = await seedTierBStage();
      expect(
        await resolveGovernedRegenerationContext(qp(), tierB.versionId, tierB.scene),
      ).toBeUndefined();

      // Governed Scene with no teachingStage: fail-closed refusal.
      const bare = makeSlideScene('s-bare', 'st', 1);
      await expect(resolveGovernedRegenerationContext(qp(), versionId, bare)).rejects.toMatchObject(
        { code: 'GOVERNED_FLOW_CONTEXT_UNRESOLVED' },
      );

      // Corrupt governed lineage (no flow): SKILL_POLICY_REQUIRED.
      const noFlow = await seedGovernedStageWithoutFlow();
      await expect(
        resolveGovernedRegenerationContext(qp(), noFlow.versionId, noFlow.scene),
      ).rejects.toMatchObject({ code: 'SKILL_POLICY_REQUIRED' });
      void TeachingPackageError;
    });

    async function seedTierBStage(): Promise<{ versionId: string; scene: AppScene }> {
      const stageId = nextId('stage');
      const scene = governedScene('s-tb', stageId, 1);
      await makeStore().saveDocument(makeDocument(stageId, 'TierB', [scene]));
      const item = { type: 'lesson' as const, id: nextId('li') };
      const versionId = nextId('tpv');
      const attemptId = nextId('tpa');
      await insertVersion(qp(), {
        id: versionId,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        version: 1,
        status: 'draft',
        currentStageId: stageId,
        currentAttemptId: attemptId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
      await insertAttempt(qp(), {
        id: attemptId,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'actor-1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        inputSnapshot: {
          learningItem: item,
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
          teachingFlow: FLOW,
        },
        now: 1,
      });
      return { versionId, scene };
    }

    async function seedGovernedStageWithoutFlow(): Promise<{
      versionId: string;
      scene: AppScene;
    }> {
      const stageId = nextId('stage');
      const scene = governedScene('s-nf', stageId, 1);
      await makeStore().saveDocument(makeDocument(stageId, 'NoFlow', [scene]));
      const item = { type: 'lesson' as const, id: nextId('li') };
      const versionId = nextId('tpv');
      const attemptId = nextId('tpa');
      await insertVersion(qp(), {
        id: versionId,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        version: 1,
        status: 'draft',
        currentStageId: stageId,
        currentAttemptId: attemptId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
      await insertAttempt(qp(), {
        id: attemptId,
        aggregate: { tenantId: 'tenant-test', learningItem: item },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'actor-1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        teachingSkillsContract: 'kafuo.teaching-skills.v1',
        inputSnapshot: {
          learningItem: item,
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
          // No teachingFlow: corrupt governed lineage.
        },
        now: 1,
      });
      return { versionId, scene };
    }
  });
});

void (null as unknown as Stage);
