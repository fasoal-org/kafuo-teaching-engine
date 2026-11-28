/**
 * `submitBlockers()` parity (Kafuo Agent API A3): on the same fixtures, the
 * FIRST blocker the collect-all reader returns is the refusal `submitForReview`
 * throws, an empty list means Submit succeeds, and a package with several
 * problems lists every one. Also the read-only loaders over the same database.
 * PGlite (in-process), the harness of submit-skill-gate.test.ts.
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
import { stampGenerationAlignmentBaselines } from '@/lib/server/teaching-package/alignment';
import { submitBlockers, submitForReview } from '@/lib/server/teaching-package/lifecycle';
import {
  claimReview,
  finishReview,
  insertQueuedReview,
} from '@/lib/server/teaching-package/package-review-store';
import {
  clearAgentSceneProjectionCache,
  loadAgentReadiness,
  loadAgentScenes,
} from '@/lib/server/teaching-package/agent-read/load';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../../agent-runtime/_stage-fixtures';

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };
const TENANT = 'tenant-parity';

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

function rawGovernedScenes(stageId: string): AppScene[] {
  return [
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
  ];
}

const governedScenes = (stageId: string) =>
  stampGenerationAlignmentBaselines(rawGovernedScenes(stageId), 1);

const withIssue = (scenes: AppScene[]) =>
  scenes.map((scene) =>
    scene.id === 's2'
      ? {
          ...scene,
          generationIssues: [{ code: 'ORIENTATION_VISUAL_MISSING', message: 'no visual' }],
        }
      : scene,
  );

/** g5.v5+ shape: each position carries a scene policy, none allows `interactive`. */
const gameFreeFlow: TeachingFlowEntry[] = flow.map((entry) => ({
  ...entry,
  scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
})) as TeachingFlowEntry[];

/** s2 becomes a learning game at a position whose policy permits none. */
const withGame = (stageId: string): AppScene[] =>
  governedScenes(stageId).map((scene) =>
    scene.id === 's2'
      ? ({
          ...scene,
          type: 'interactive',
          content: { type: 'interactive', html: '<p>لعبة</p>', widgetType: 'game' },
        } as unknown as AppScene)
      : scene,
  );

/** A 1×1 PNG no verdict store has ever seen. */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const withUnscreenedImage = (stageId: string): AppScene[] =>
  governedScenes(stageId).map((scene) => {
    if (scene.id !== 's1') return scene;
    const content = scene.content as { canvas: { elements: unknown[] } };
    return {
      ...scene,
      content: {
        ...content,
        canvas: {
          ...content.canvas,
          elements: [
            ...content.canvas.elements,
            {
              id: 'img-1',
              type: 'image',
              src: PNG_1X1,
              left: 100,
              top: 100,
              width: 100,
              height: 100,
              rotate: 0,
              fixedRatio: true,
            },
          ],
        },
      },
    } as AppScene;
  });

describe('submitBlockers parity with submitForReview', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-parity-${(counter += 1)}`;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://parity-${randomUUID()}`);
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
    clearAgentSceneProjectionCache();
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

  interface SeedOptions {
    status?: 'draft' | 'in_review';
    contract?: string | null;
    flow?: TeachingFlowEntry[] | null;
    scenes?: (stageId: string) => AppScene[];
    sectionCoverage?: { essentialContentUnitIds: string[]; gapContentUnitIds: string[] };
    /** The version row's declared model (default g5.v1, the attempt's). */
    versionModel?: string;
    /** Tombstone the Stage's meta row after seeding. */
    tombstone?: boolean;
  }

  async function seedVersion(options: SeedOptions = {}) {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await makeStore().saveDocument(
      makeDocument(stageId, 'Parity', (options.scenes ?? governedScenes)(stageId)),
    );
    const versionId = nextId('tpv');
    const attemptId = nextId('tpa');
    const seededFlow = options.flow === undefined ? flow : options.flow;
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: TENANT, learningItem: item },
      version: 1,
      status: options.status ?? 'draft',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: options.versionModel ?? 'g5.v1' },
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: TENANT, learningItem: item },
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
        ...(options.sectionCoverage ? { sectionCoverage: options.sectionCoverage } : {}),
      },
      now: 1,
    });
    if (options.tombstone) {
      await pool.query('UPDATE stage_meta SET deleted_at = now() WHERE stage_id = $1', [stageId]);
    }
    return { versionId, stageId };
  }

  /** The code `submitForReview` throws, or null when it submits. */
  async function submitOutcome(versionId: string): Promise<string | null> {
    try {
      await submitForReview(txPool(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(TeachingPackageError);
      return (error as TeachingPackageError).code;
    }
  }

  const citing = (stageId: string) =>
    governedScenes(stageId).map((scene) => ({
      ...scene,
      sourceContentUnitIds: scene.id === 's1' ? ['u1'] : ['u2'],
    }));

  const cases: Array<[string, SeedOptions, string | null]> = [
    ['a valid governed package', {}, null],
    [
      'a slide kept with a generation issue',
      { scenes: (s) => withIssue(governedScenes(s)) },
      'SLIDES_NEED_REGENERATION',
    ],
    [
      'an essential section no slide teaches',
      {
        contract: null,
        scenes: citing,
        sectionCoverage: { essentialContentUnitIds: ['u1', 'u3'], gapContentUnitIds: [] },
      },
      'ESSENTIAL_SECTION_UNCOVERED',
    ],
    [
      'governed scenes never validated (no alignment baseline)',
      { scenes: rawGovernedScenes },
      'SKILL_ALIGNMENT_UNRESOLVED',
    ],
    ['a version already in review', { status: 'in_review' }, 'INVALID_TRANSITION'],
    ['a legacy package with no flow', { contract: null, flow: null }, null],
    ['a governed version with no flow', { flow: null }, 'SKILL_POLICY_REQUIRED'],
    ['a tombstoned stage', { tombstone: true }, 'STAGE_NOT_LIVE'],
    [
      'a scene sequence that misses a flow position',
      { scenes: (s) => governedScenes(s).filter((scene) => scene.id === 's1') },
      'TEACHING_MODEL_FLOW_MISMATCH',
    ],
    [
      'a game at a position that allows no game',
      { flow: gameFreeFlow, scenes: withGame },
      'GAME_GENERATION_DEFERRED',
    ],
    ['a declared model that is not the producing one', { versionModel: 'g5.v2' }, 'STALE_STATE'],
  ];

  it.each(cases)('%s', async (_label, options, expected) => {
    const { versionId } = await seedVersion(options);
    const blockers = await submitBlockers(txPool(), versionId, TENANT);
    const thrown = await submitOutcome(versionId);
    expect(thrown).toBe(expected);
    expect(blockers[0]?.code ?? null).toBe(thrown);
    if (thrown === null) expect(blockers).toEqual([]);
  });

  it('lists every blocker, in Submit order, where Submit stops at the first', async () => {
    const { versionId } = await seedVersion({
      contract: null,
      scenes: (stageId) => withIssue(citing(stageId)),
      sectionCoverage: { essentialContentUnitIds: ['u1', 'u3'], gapContentUnitIds: [] },
    });
    const blockers = await submitBlockers(txPool(), versionId, TENANT);
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      'SLIDES_NEED_REGENERATION',
      'ESSENTIAL_SECTION_UNCOVERED',
    ]);
    expect(blockers[1]!.details).toEqual({ unitIds: ['u3'] });
    expect(await submitOutcome(versionId)).toBe('SLIDES_NEED_REGENERATION');
    // Reading the blockers changed nothing.
    expect((await readVersion(qp(), versionId, { tenantId: TENANT }))!.status).toBe('draft');
  });

  it('A-34: a stale AI review is the blocker Submit refuses with, and lists last', async () => {
    const { versionId, stageId } = await seedVersion();
    const version = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    // A finished review whose row records no revision (a legacy row): stale.
    await insertQueuedReview(qp(), {
      id: 'tpr-parity-stale',
      aggregate: { tenantId: TENANT, learningItem: version.learningItem },
      versionId,
      attemptId: 'tpa-parity-review',
      stageId,
      subjectCode: null,
      now: 2,
    });
    await claimReview(qp(), 'tpr-parity-stale', { workerId: 'w', now: 3, leaseMs: 60_000 });
    await finishReview(
      qp(),
      'tpr-parity-stale',
      'w',
      { status: 'passed', findings: [], fixes: [], reviewedStageRev: null },
      4,
    );
    const blockers = await submitBlockers(txPool(), versionId, TENANT);
    expect(blockers.map((blocker) => blocker.code)).toEqual(['PACKAGE_REVIEW_STALE']);
    expect(blockers[0]!.details).toMatchObject({ reviewedStageRev: null });
    expect(await submitOutcome(versionId)).toBe('PACKAGE_REVIEW_STALE');
  });

  it('refuses another tenant with NOT_FOUND', async () => {
    const { versionId } = await seedVersion();
    await expect(submitBlockers(txPool(), versionId, 'tenant-other')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('readiness reads the lock and the blockers without writing', async () => {
    const { versionId } = await seedVersion({ scenes: (s) => withIssue(governedScenes(s)) });
    const version = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    const readiness = await loadAgentReadiness(txPool(), version);
    expect(readiness).toMatchObject({
      version_id: versionId,
      status: 'draft',
      generation_status: 'succeeded',
      editor: { locked: false, lock_reason: null },
      send_for_approval: { allowed: false },
      counts: { scenes: 2, slides: 2, quizzes: 0 },
    });
    expect(readiness.send_for_approval.blocked_by.map((blocker) => blocker.code)).toEqual([
      'SLIDES_NEED_REGENERATION',
    ]);

    const inReview = await seedVersion({ status: 'in_review' });
    const reviewVersion = (await readVersion(qp(), inReview.versionId, { tenantId: TENANT }))!;
    const locked = await loadAgentReadiness(txPool(), reviewVersion);
    expect(locked.editor).toEqual({ locked: true, lock_reason: 'stage_locked:in_review' });
    expect(locked.send_for_approval.blocked_by[0]!.code).toBe('INVALID_TRANSITION');
  });

  it('scenes: projects the live stage and serves a cache hit until the revision moves', async () => {
    const { versionId, stageId } = await seedVersion();
    const version = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    const first = await loadAgentScenes(txPool(), version);
    expect(first.scenes.map((scene) => scene.scene_id)).toEqual(['s1', 's2']);
    expect(first.scenes[0]!.validation).toEqual({
      state: 'current',
      needs_alignment_confirmation: false,
    });
    const hit = await loadAgentScenes(txPool(), version);
    expect(hit.scenes).toBe(first.scenes); // served from the cache
    expect(hit.revision).toBe(first.revision);

    const document = await makeStore().loadDocument(stageId);
    await makeStore().saveDocument({
      ...document!,
      scenes: document!.scenes.map((scene) =>
        scene.id === 's1' ? { ...scene, title: 'Changed' } : scene,
      ),
    });
    const second = await loadAgentScenes(txPool(), version);
    expect(second.scenes).not.toBe(first.scenes);
    expect(second.revision).not.toBe(first.revision);
    expect(second.scenes[0]!.title).toBe('Changed');
  });

  it('scenes: a status change at the same stage revision answers the new status', async () => {
    const { versionId } = await seedVersion();
    const draft = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    const before = await loadAgentScenes(txPool(), draft);
    expect(before.status).toBe('draft');
    await submitForReview(txPool(), { tenantId: TENANT, versionId, actorRef: 'reviewer-1' });
    const inReview = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    const after = await loadAgentScenes(txPool(), inReview);
    expect(after.revision).toBe(before.revision); // same stage revision: a cache hit
    expect(after.scenes).toBe(before.scenes);
    expect(after.status).toBe('in_review');
  });

  it('marks an image with no stored verdict as unscreened (stored verdicts only)', async () => {
    vi.stubEnv('VISUAL_COMPLIANCE_MODEL', '');
    vi.stubEnv('DEFAULT_MODEL', '');
    const { versionId } = await seedVersion({ scenes: withUnscreenedImage });
    const blockers = await submitBlockers(txPool(), versionId, TENANT);
    expect(blockers[0]).toMatchObject({
      code: 'VISUAL_COMPLIANCE_UNAPPROVED',
      details: {
        offendingSceneIds: ['s1'],
        verdict_source: 'stored_only',
        unscreened: true,
        unscreened_count: 1,
      },
    });
    // With no vision service configured, the real Submit refuses with the same code.
    expect(await submitOutcome(versionId)).toBe('VISUAL_COMPLIANCE_UNAPPROVED');
  });
});
