/**
 * W17 — the assembled Submit gate (teaching-skills plan §P Step 18 · §L ·
 * BR-TS-054 · FR-TS-044/051/052 · VAL-TS-007/010/020 · AC-TS-014/020/032/034).
 *
 * W17 owns checks 2 (discriminator), 10 (alignment) and 11 (lineage) plus the
 * ORDERING; checks 4–9 are the W12 validators, invoked not reimplemented. What
 * is pinned here:
 * - every blocker keeps the package out of `in_review`;
 * - legacy NEVER produces a Skill error, across all three tiers (§B.13);
 * - the existing exact-flow error precedence is preserved (check 3 before 4–11);
 * - check 10 is a recomputation: stale / never-validated blocks; a reviewer
 *   confirmation taken before the submit satisfies it; the package stays out
 *   of review until then.
 */
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
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  confirmSceneAlignments,
  normalizeConfirmation,
} from '@/lib/server/teaching-package/scene-alignment';
import {
  stampGenerationAlignmentBaselines,
  buildSceneAlignmentBaseline,
} from '@/lib/server/teaching-package/alignment';
import { submitForReview } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };

/**
 * LLM boundaries for the pipeline-sourced case below — the only parts of a
 * generation run that are not deterministic code. Every other test in this
 * suite leaves them untouched (they never run a generation), so the partial
 * mocks are inert for them. Scene content parsing, `createSceneWithActions`,
 * `api.scene.create`, the real teaching-package sink (W15 stamping + document
 * save), and the whole submit gate run for real.
 */
const pipelineMocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  generateSceneActions: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/resolve-model')>()),
  resolveModel: pipelineMocks.resolveModel,
}));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: pipelineMocks.isProviderKeyRequired,
}));
vi.mock('@/lib/ai/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/llm')>()),
  callLLM: pipelineMocks.callLLM,
}));
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: pipelineMocks.generateSceneOutlinesFromRequirements,
  generateSceneActions: pipelineMocks.generateSceneActions,
}));

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
  status?: number,
): Promise<TeachingPackageError> {
  const rejection = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(TeachingPackageError);
  expect(rejection).toMatchObject(status ? { code, status } : { code });
  return rejection as TeachingPackageError;
}

describe('W17 submit gate', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-w17-${(counter += 1)}`;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w17-${randomUUID()}`);
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

  function makeStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  const flow: TeachingFlowEntry[] = [
    {
      stage: 'lesson_introduction',
      instructions: 'i',
      skillPolicy: {
        required: [],
        preferred: [],
        allowed: [FEYNMAN, LECTURE],
        combinationRestrictions: [],
      },
    },
    {
      stage: 'outcome_teaching_cards',
      instructions: 'c',
      skillPolicy: {
        required: [],
        preferred: [],
        allowed: [FEYNMAN, LECTURE],
        combinationRestrictions: [],
      },
    },
  ];

  /**
   * The fully valid governed shape: flow-tagged, classified, in-policy
   * selections, generation baselines stamped — the state a governed
   * generation leaves behind and W10's sink produces.
   */
  function governedScenes(stageId: string): AppScene[] {
    return stampGenerationAlignmentBaselines(
      [
        {
          ...makeSlideScene('s1', stageId, 1),
          teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
          teachingSkills: { primary: FEYNMAN, classification: 'instructional' as const },
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

  interface SeedOptions {
    status?: 'draft' | 'in_review';
    contract?: string | null;
    flow?: TeachingFlowEntry[] | null;
    scenes?: (stageId: string) => AppScene[];
  }

  async function seedVersion(options: SeedOptions = {}): Promise<{
    versionId: string;
    stageId: string;
  }> {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await makeStore().saveDocument(
      makeDocument(stageId, 'W17', (options.scenes ?? governedScenes)(stageId)),
    );
    const versionId = nextId('tpv');
    const attemptId = nextId('tpa');
    const seededFlow = options.flow === undefined ? flow : options.flow;
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: options.status ?? 'draft',
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
      ...(options.contract === undefined
        ? { teachingSkillsContract: 'kafuo.teaching-skills.v1' }
        : options.contract !== null
          ? { teachingSkillsContract: options.contract }
          : {}),
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
        ...(seededFlow ? { teachingFlow: seededFlow } : {}),
      },
      now: 1,
    });
    return { versionId, stageId };
  }

  const submit = (versionId: string) =>
    submitForReview(txPool(), { tenantId: 'tenant-test', versionId, actorRef: 'reviewer-1' });

  const statusOf = async (versionId: string) =>
    (await readVersion(qp(), versionId, { tenantId: 'tenant-test' }))!.status;

  // ---- check 10: alignment is a recomputation, not a lookup ----

  it('admits a fully valid governed package (checks 4–10 pass)', async () => {
    const { versionId } = await seedVersion();
    const updated = await submit(versionId);
    expect(updated.status).toBe('in_review');
  });

  // ---- the coverage gap this suite had: no case ever sourced its governed
  // Scenes from the generation pipeline — every hand-built case attached
  // carriers directly, so the gate was only ever tested against Scenes the
  // real pipeline could not produce (the Module 2 P0 defect) ----

  it('admits a governed package whose Scenes came from the REAL generation pipeline', async () => {
    // LLM boundaries only: outlines and actions are stubbed replies, scene
    // content is parsed from a stubbed model reply by the real generator.
    pipelineMocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: { capabilities: { vision: true } },
      modelString: 'vision-model',
      providerId: 'test',
      apiKey: '',
    });
    pipelineMocks.isProviderKeyRequired.mockReturnValue(false);
    pipelineMocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        elements: [
          {
            type: 'text',
            content: 'Pipeline-governed body',
            left: 100,
            top: 100,
            width: 600,
            height: 60,
          },
        ],
        remark: '',
      }),
    });
    pipelineMocks.generateSceneActions.mockResolvedValue([]);
    pipelineMocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'English.',
        outlines: [
          {
            id: 'po1',
            type: 'slide' as const,
            title: 'Opening',
            description: 'Introduce the topic.',
            keyPoints: ['Anchor the goal'],
            order: 1,
            teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
            teachingSkills: { primary: FEYNMAN, classification: 'instructional' as const },
          },
          {
            id: 'po2',
            type: 'slide' as const,
            title: 'Cards',
            description: 'Structural consolidation.',
            keyPoints: ['Recap'],
            order: 2,
            teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
            teachingSkills: { classification: 'non-instructional' as const },
          },
        ],
      },
    });

    // The REAL governed run: real createSceneWithActions, real api.scene.create,
    // and the REAL teaching-package sink — which stamps W15 generation baselines
    // and saves the document through this suite's PGlite-backed store.
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    const { createTeachingPackagePersistenceSink } =
      await import('@/lib/server/teaching-package/stage-persistence-sink');
    const generated = await generateClassroom(
      {
        requirement: 'Pipeline-sourced governed run',
        pdfContent: { text: 'pdf body', images: [] },
        teachingFlow: flow,
        skillPolicy: true,
      },
      { baseUrl: '', persistence: createTeachingPackagePersistenceSink('tpa-pipeline') },
    );

    // The pipeline really delivered the carrier and its baseline — the exact
    // state the hand-built cases used to fabricate.
    expect(generated.scenes.length).toBeGreaterThan(0);
    for (const scene of generated.scenes) {
      expect(scene.teachingSkills).toBeDefined();
      expect(scene.alignmentBaseline?.origin).toBe('generation');
    }

    // Seed the version/attempt around the pipeline-produced Stage — the
    // document itself was already saved by the real sink — then submit.
    const item = { type: 'lesson' as const, id: nextId('li') };
    const versionId = nextId('tpv');
    const attemptId = nextId('tpa');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: generated.id,
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
        teachingFlow: flow,
      },
      now: 1,
    });

    const updated = await submit(versionId);
    expect(updated.status).toBe('in_review');
  });

  it('blocks a governed Scene with no baseline (never validated) with SKILL_ALIGNMENT_UNRESOLVED', async () => {
    const { versionId, stageId } = await seedVersion({
      // Baselines stripped: the pre-W15 state a governed Scene must not submit from.
      scenes: (stageIdArg) =>
        governedScenes(stageIdArg).map((scene) => {
          const { alignmentBaseline: _stripped, ...rest } = scene;
          return rest as AppScene;
        }),
    });
    void stageId;
    const error = await expectTpError(submit(versionId), 'SKILL_ALIGNMENT_UNRESOLVED', 409);
    const details = error.details as { offendingSceneIds: string[]; alignment: unknown[] };
    expect(details.offendingSceneIds).toEqual(['s1', 's2']);
    expect(details.alignment).toEqual([
      { sceneId: 's1', alignmentState: 'validation-required' },
      { sceneId: 's2', alignmentState: 'validation-required' },
    ]);
    expect(await statusOf(versionId)).toBe('draft');
  });

  it('blocks a materially edited governed Scene, and a reviewer confirmation lifts the block', async () => {
    const { versionId, stageId } = await seedVersion();
    const store = makeStore();
    const document = (await store.loadDocument(stageId))!;
    await store.putScene(stageId, {
      ...document.scenes[0]!,
      title: 'Pedagogically different',
    });
    const error = await expectTpError(submit(versionId), 'SKILL_ALIGNMENT_UNRESOLVED', 409);
    expect(
      (error.details as { alignment: Array<{ alignmentState: string; reason?: string }> })
        .alignment,
    ).toEqual([{ sceneId: 's1', alignmentState: 'stale', reason: 'material-change' }]);
    expect(await statusOf(versionId)).toBe('draft');

    // FR-TS-045 / AC-TS-032: the reviewer resolves while editable.
    await confirmSceneAlignments(
      txPool(),
      versionId,
      { tenantId: 'tenant-test', actorRef: 'reviewer-1' },
      [normalizeConfirmation({ sceneId: 's1' })],
      99,
    );
    const updated = await submit(versionId);
    expect(updated.status).toBe('in_review');
  });

  it('blocks a Skill-switched governed Scene until re-confirmed (assignment-change)', async () => {
    const { versionId, stageId } = await seedVersion();
    const store = makeStore();
    const document = (await store.loadDocument(stageId))!;
    await store.putScene(stageId, {
      ...document.scenes[0]!,
      teachingSkills: { primary: LECTURE, classification: 'instructional' as const },
    });
    const error = await expectTpError(submit(versionId), 'SKILL_ALIGNMENT_UNRESOLVED', 409);
    expect((error.details as { alignment: Array<{ reason?: string }> }).alignment[0]!.reason).toBe(
      'assignment-change',
    );
    expect(await statusOf(versionId)).toBe('draft');
  });

  // ---- checks 4–9: invoked, in order ----

  it('blocks a governed Scene with no classification (check 9, VAL-TS-007)', async () => {
    const { versionId } = await seedVersion({
      scenes: (stageIdArg) =>
        governedScenes(stageIdArg).map((scene) => {
          if (scene.id !== 's2') return scene;
          const { teachingSkills: _skills, alignmentBaseline: _baseline, ...rest } = scene;
          return rest as AppScene;
        }),
    });
    await expectTpError(submit(versionId), 'SCENE_CLASSIFICATION_INVALID', 422);
    expect(await statusOf(versionId)).toBe('draft');
  });

  it('blocks an instructional Scene with no Primary (check 8, VAL-TS-006)', async () => {
    const { versionId } = await seedVersion({
      scenes: (stageIdArg) =>
        governedScenes(stageIdArg).map((scene) =>
          scene.id === 's1'
            ? {
                ...scene,
                teachingSkills: { classification: 'instructional' as const },
                alignmentBaseline: buildSceneAlignmentBaseline(
                  { ...scene, teachingSkills: { classification: 'instructional' as const } },
                  { origin: 'generation', now: 1 },
                )!,
              }
            : scene,
        ),
    });
    await expectTpError(submit(versionId), 'SKILL_ASSIGNMENT_INVALID', 422);
  });

  it('blocks an out-of-policy selection (check 8 permission boundary, BR-TS-048)', async () => {
    const { versionId } = await seedVersion({
      scenes: (stageIdArg) =>
        governedScenes(stageIdArg).map((scene) =>
          scene.id === 's1'
            ? {
                ...scene,
                teachingSkills: {
                  primary: { skillId: 'deep-research', version: 'v1' },
                  classification: 'instructional' as const,
                },
                alignmentBaseline: buildSceneAlignmentBaseline(
                  {
                    ...scene,
                    teachingSkills: {
                      primary: { skillId: 'deep-research', version: 'v1' },
                      classification: 'instructional' as const,
                    },
                  },
                  { origin: 'generation', now: 1 },
                )!,
              }
            : scene,
        ),
    });
    await expectTpError(submit(versionId), 'SKILL_ASSIGNMENT_INVALID', 422);
  });

  it('fails closed when a governed version has no resolvable flow (corrupt lineage)', async () => {
    const { versionId } = await seedVersion({ flow: null });
    await expectTpError(submit(versionId), 'SKILL_POLICY_REQUIRED', 400);
  });

  it('check 11 still fires: model-lineage drift refuses an otherwise valid governed package', async () => {
    const { versionId } = await seedVersion();
    await pool.query(
      `UPDATE teaching_package_versions SET teaching_model_version = $2 WHERE id = $1`,
      [versionId, 'g5.v2'],
    );
    const error = await expectTpError(submit(versionId), 'STALE_STATE', 409);
    expect((error.details as { reason?: string }).reason).toBe('teaching_model_lineage_drift');
  });

  // ---- the discriminator: legacy never produces a Skill error (§B.13) ----

  it('tier A (no flow, no attempt): submits with Skill-less Scenes and no Skill error', async () => {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await makeStore().saveDocument(
      makeDocument(stageId, 'Legacy A', [makeSlideScene('s1', stageId, 1)]),
    );
    const versionId = nextId('tpv');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    const updated = await submit(versionId);
    expect(updated.status).toBe('in_review');
  });

  it('tier B (flow, no governance marker): exact-flow applies, the Skill gate skips', async () => {
    const { versionId } = await seedVersion({
      contract: null,
      // Skill-less scenes that would fail checks 9/10 instantly if the gate ran.
      scenes: (stageIdArg) =>
        governedScenes(stageIdArg).map((scene) => {
          const { teachingSkills: _skills, alignmentBaseline: _baseline, ...rest } = scene;
          return rest as AppScene;
        }),
    });
    const updated = await submit(versionId);
    expect(updated.status).toBe('in_review');
  });

  it('tier C (governed) with missing required lineage is blocked, never tolerated (AC-TS-034)', async () => {
    const { versionId } = await seedVersion({
      scenes: (stageIdArg) =>
        governedScenes(stageIdArg).map((scene) => {
          const { teachingSkills: _skills, alignmentBaseline: _baseline, ...rest } = scene;
          return rest as AppScene;
        }),
    });
    await expectTpError(submit(versionId), 'SCENE_CLASSIFICATION_INVALID');
    expect(await statusOf(versionId)).toBe('draft');
  });

  // ---- precedence: existing semantics preserved ----

  it('exact-flow mismatch outranks the Skill checks when both fail', async () => {
    const { versionId } = await seedVersion({
      scenes: (stageIdArg) => {
        const scenes = governedScenes(stageIdArg).map((scene) => {
          const { teachingSkills: _skills, alignmentBaseline: _baseline, ...rest } = scene;
          return rest as AppScene;
        });
        // Break the sequence (position 1 never covered) AND leave the Skill-less
        // scenes that checks 9/10 would refuse: check 3 must win.
        return [
          scenes[0]!,
          {
            ...makeSlideScene('s-again', stageIdArg, 3),
            teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
          },
        ];
      },
    });
    const error = await expectTpError(submit(versionId), 'TEACHING_MODEL_FLOW_MISMATCH', 409);
    expect(error.code).not.toMatch(/^SKILL_|^SCENE_/);
  });

  it('lifecycle eligibility outranks everything: a non-draft governed version answers INVALID_TRANSITION', async () => {
    const { versionId } = await seedVersion({ status: 'in_review' });
    await expectTpError(submit(versionId), 'INVALID_TRANSITION', 409);
  });
});
