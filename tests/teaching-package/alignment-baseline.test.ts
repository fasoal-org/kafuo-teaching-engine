/**
 * W15 — Durable reviewer confirmation / the alignment baseline (teaching-skills
 * plan §P Step 16 · §K · §F · BR-TS-032/038 · FR-TS-037/044/045/071 ·
 * VAL-TS-010 · AC-TS-032).
 *
 * Pins the two baseline origins (generation via the persistence sink, reviewer
 * via the confirmation route), the §K invalidation semantics (material edit,
 * Skill change, classification change — each separately; metadata-only edits
 * never), the inertness of a stale baseline, survival through stage-clone, the
 * freeze at approved, and the write-barrier shape validation.
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
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  buildSceneAlignmentBaseline,
  deriveSceneAlignment,
  sceneMaterialFingerprint,
  stampGenerationAlignmentBaselines,
} from '@/lib/server/teaching-package/alignment';
import {
  confirmSceneAlignments,
  normalizeConfirmation,
} from '@/lib/server/teaching-package/scene-alignment';
import {
  normalizeSkillAssignment,
  setSceneTeachingSkills,
} from '@/lib/server/teaching-package/scene-skills';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };

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

describe('W15 baseline construction (pure)', () => {
  const scene: AppScene = {
    ...makeSlideScene('s1', 'stage-a', 1),
    teachingSkills: { primary: FEYNMAN, supporting: [LECTURE], classification: 'instructional' },
  };

  it('builds the same shape for both origins; actorRef rides only reviewer confirmations', () => {
    const generation = buildSceneAlignmentBaseline(scene, { origin: 'generation', now: 5 });
    expect(generation).toEqual({
      primary: FEYNMAN,
      supporting: [LECTURE],
      classification: 'instructional',
      fingerprint: sceneMaterialFingerprint(scene),
      establishedAt: 5,
      origin: 'generation',
    });
    expect('actorRef' in generation!).toBe(false);

    const confirmed = buildSceneAlignmentBaseline(scene, {
      origin: 'reviewer-confirmation',
      actorRef: 'reviewer-9',
      now: 6,
    });
    expect(confirmed).toMatchObject({
      origin: 'reviewer-confirmation',
      actorRef: 'reviewer-9',
      establishedAt: 6,
      fingerprint: generation!.fingerprint,
    });
  });

  it('constructs NO baseline for a Scene that carries no classification — nothing is fabricated', () => {
    // The defect this pins: the constructor once substituted 'instructional'
    // for an absent classification, producing a baseline the Scene could never
    // match — stale/classification-change from birth, unconfirmable. The
    // construction point now refuses instead of fabricating.
    const unclassified: AppScene = {
      ...makeSlideScene('s-unclassified', 'stage-a', 3),
      teachingSkills: { primary: FEYNMAN },
    };
    expect(buildSceneAlignmentBaseline(unclassified, { origin: 'generation', now: 1 })).toBeNull();
    expect(
      buildSceneAlignmentBaseline(unclassified, {
        origin: 'reviewer-confirmation',
        actorRef: 'reviewer-1',
        now: 1,
      }),
    ).toBeNull();
    // A value outside the closed vocabulary is refused the same way — the
    // barrier never validated the carrier's classification, so construction
    // must (the write barrier owns the BASELINE's shape, not the carrier's).
    const garbage: AppScene = {
      ...makeSlideScene('s-garbage', 'stage-a', 4),
      teachingSkills: { primary: FEYNMAN, classification: 'maybe' } as never,
    };
    expect(buildSceneAlignmentBaseline(garbage, { origin: 'generation', now: 1 })).toBeNull();
  });

  it('stamps generation baselines only on governed Scenes', () => {
    const legacy = makeSlideScene('legacy', 'stage-a', 2);
    const stamped = stampGenerationAlignmentBaselines([scene, legacy], 9);
    expect(stamped[0]!.alignmentBaseline).toMatchObject({ origin: 'generation', establishedAt: 9 });
    expect(stamped[0]!.alignmentBaseline!.fingerprint).toBe(sceneMaterialFingerprint(scene));
    expect('alignmentBaseline' in stamped[1]!).toBe(false);
  });

  it('stamps NO baseline on an unclassified Scene — validation-required, never a self-invalidating stale', () => {
    const unclassified: AppScene = {
      ...makeSlideScene('s-unclassified', 'stage-a', 5),
      teachingSkills: { primary: FEYNMAN },
    };
    const stamped = stampGenerationAlignmentBaselines([unclassified, scene], 9);
    // The carrier survives; the baseline does not exist; the honest derivation
    // is validation-required — not stale, since nothing changed.
    expect(stamped[0]!.teachingSkills).toEqual({ primary: FEYNMAN });
    expect('alignmentBaseline' in stamped[0]!).toBe(false);
    expect(deriveSceneAlignment(stamped[0]!)).toMatchObject({
      state: 'validation-required',
      aligned: false,
    });
    expect(stamped[1]!.alignmentBaseline).toBeDefined();
  });
});

describe('W15 durable confirmation', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-w15-${(counter += 1)}`;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w15-${randomUUID()}`);
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

  function governedScenes(stageId: string): AppScene[] {
    return [
      {
        ...makeSlideScene('s1', stageId, 1),
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
        teachingSkills: { primary: FEYNMAN, classification: 'instructional' },
      },
      {
        ...makeSlideScene('s2', stageId, 2),
        teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
        teachingSkills: { classification: 'non-instructional' },
      },
    ];
  }

  async function seedGovernedVersion(options: {
    status?: 'draft' | 'in_review' | 'approved';
    contract?: string | null;
  }): Promise<{ versionId: string; stageId: string }> {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await makeStore().saveDocument(makeDocument(stageId, 'W15', governedScenes(stageId)));
    const versionId = nextId('tpv');
    const attemptId = nextId('tpa');
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
      teachingSkillsContract:
        options.contract === undefined ? 'kafuo.teaching-skills.v1' : options.contract,
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
    return { versionId, stageId };
  }

  const confirm = (versionId: string, sceneIds: string[]) =>
    confirmSceneAlignments(
      txPool(),
      versionId,
      { tenantId: 'tenant-test', actorRef: 'reviewer-1' },
      sceneIds.map((sceneId) => normalizeConfirmation({ sceneId })),
      1234,
    );

  const scene = (stageId: string, sceneId: string) =>
    makeStore()
      .loadDocument(stageId)
      .then((document) => document!.scenes.find((candidate) => candidate.id === sceneId)!);

  it('records a confirmation that derives confirmed, binding the current state', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    await confirm(versionId, ['s1']);
    const confirmed = await scene(stageId, 's1');
    expect(confirmed.alignmentBaseline).toMatchObject({
      origin: 'reviewer-confirmation',
      actorRef: 'reviewer-1',
      establishedAt: 1234,
      primary: FEYNMAN,
      classification: 'instructional',
    });
    expect(deriveSceneAlignment(confirmed)).toMatchObject({
      state: 'confirmed',
      aligned: true,
      baselineOrigin: 'reviewer-confirmation',
    });
    expect(deriveSceneAlignment(await scene(stageId, 's2'))).toMatchObject({
      state: 'validation-required',
    });
  });

  it('invalidates the confirmation on a later MATERIAL edit (and the old baseline is inert)', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    await confirm(versionId, ['s1']);
    const store = makeStore();
    await store.putScene(stageId, { ...(await scene(stageId, 's1'))!, title: 'Edited pedagogy' });
    const edited = await scene(stageId, 's1');
    // The stale baseline cannot make the edited content look aligned.
    expect(deriveSceneAlignment(edited)).toMatchObject({
      state: 'stale',
      reason: 'material-change',
      aligned: false,
    });
    // Re-confirming baselines the NEW state — that is the resolution path.
    await confirm(versionId, ['s1']);
    expect(deriveSceneAlignment(await scene(stageId, 's1'))).toMatchObject({
      state: 'confirmed',
      aligned: true,
    });
  });

  it('invalidates the confirmation on a later SKILL change', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    await confirm(versionId, ['s1']);
    await setSceneTeachingSkills(txPool(), versionId, { tenantId: 'tenant-test' }, [
      normalizeSkillAssignment({
        sceneId: 's1',
        teachingSkills: { primary: LECTURE, classification: 'instructional' },
      }),
    ]);
    expect(deriveSceneAlignment(await scene(stageId, 's1'))).toMatchObject({
      state: 'stale',
      reason: 'assignment-change',
      aligned: false,
    });
  });

  it('invalidates the confirmation on a later CLASSIFICATION change', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    await confirm(versionId, ['s1']);
    // A raw write flips ONLY the classification (the W14 route refuses this
    // combination structurally, so we bypass it the way an unsanctioned writer
    // would): the assignment still matches, so the §K ladder — assignment
    // before classification — isolates the classification signal.
    const store = makeStore();
    const confirmed = await scene(stageId, 's1');
    await store.putScene(stageId, {
      ...confirmed,
      teachingSkills: { primary: FEYNMAN, classification: 'non-instructional' },
    });
    expect(deriveSceneAlignment(await scene(stageId, 's1'))).toMatchObject({
      state: 'stale',
      reason: 'classification-change',
      aligned: false,
    });
  });

  it('a METADATA-ONLY edit does not invalidate the confirmation (FR-TS-043)', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    await confirm(versionId, ['s1']);
    const store = makeStore();
    const before = await scene(stageId, 's1');
    await store.putScene(stageId, {
      ...before,
      order: 99,
      updatedAt: (before.updatedAt ?? 0) + 1_000,
    });
    expect(deriveSceneAlignment(await scene(stageId, 's1'))).toMatchObject({
      state: 'confirmed',
      aligned: true,
    });
  });

  it('the baseline travels with a same-model clone and freezes with approval', async () => {
    const seeded = await seedGovernedVersion({ status: 'draft' });
    const { submitForReview, approve, createSuccessor } =
      await import('@/lib/server/teaching-package/lifecycle');
    await confirm(seeded.versionId, ['s1', 's2']);
    await submitForReview(txPool(), {
      tenantId: 'tenant-test',
      versionId: seeded.versionId,
      actorRef: 'reviewer-1',
    });
    await approve(txPool(), {
      tenantId: 'tenant-test',
      versionId: seeded.versionId,
      actorRef: 'reviewer-1',
    });

    // Frozen: the stage guard refuses ANY scene write on the approved version.
    const approvedScene = await scene(seeded.stageId, 's1');
    await expect(
      makeStore().putScene(seeded.stageId, { ...approvedScene, title: 'Nope' }),
    ).rejects.toThrow();
    await expectTpError(confirm(seeded.versionId, ['s1']), 'INVALID_TRANSITION');

    // Travels: the clone copies the baselines by spread.
    const successor = await createSuccessor(txPool(), {
      tenantId: 'tenant-test',
      versionId: seeded.versionId,
      actorRef: 'reviewer-1',
    });
    const cloned = await scene(successor.currentStageId, 's1');
    expect(cloned.alignmentBaseline).toEqual(approvedScene.alignmentBaseline);
    expect(cloned.teachingSkills).toEqual(approvedScene.teachingSkills);
    expect(deriveSceneAlignment(cloned)).toMatchObject({ state: 'confirmed', aligned: true });
  });

  it('refuses non-editable states, legacy versions, and unconfirmable scenes', async () => {
    const inReview = await seedGovernedVersion({ status: 'in_review' });
    await expectTpError(confirm(inReview.versionId, ['s1']), 'INVALID_TRANSITION');

    const legacy = await seedGovernedVersion({ contract: null });
    const legacyError = await confirm(legacy.versionId, ['s1']).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );
    expect(legacyError).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(String((legacyError as TeachingPackageError).code)).not.toMatch(
      /^SKILL_|^SCENE_|^TEACHING_MODEL_/,
    );

    const governed = await seedGovernedVersion({});
    await expectTpError(confirm(governed.versionId, ['missing']), 'INVALID_REQUEST');
  });

  it('refuses to confirm an unclassified Scene and writes NOTHING — a confirmation must yield aligned', async () => {
    // The gap that let the defect through W15: no test ever confirmed a Scene
    // without a classification. Confirming one used to write a fabricated
    // baseline the Scene could never match — `aligned` stayed false after a
    // "successful" confirmation. Now the route refuses before the first
    // putScene, mirroring its missing-carrier refusal.
    const { versionId, stageId } = await seedGovernedVersion({});
    // s1 loses only its classification, via a raw putScene the carrier
    // validator does not gate (the baseline validator owns the baseline's
    // shape, not the carrier's).
    const store = makeStore();
    const seeded = (await store.loadDocument(stageId))!;
    await store.putScene(stageId, {
      ...seeded.scenes.find((candidate) => candidate.id === 's1')!,
      teachingSkills: { primary: FEYNMAN },
    });
    const before = await store.loadDocument(stageId);
    await expectTpError(confirm(versionId, ['s1']), 'INVALID_REQUEST');
    // Nothing was written — not for the refused scene, and no partial state
    // anywhere else in the document.
    expect((await store.loadDocument(stageId))!.scenes).toEqual(before!.scenes);

    // The well-formed sibling still confirms and derives aligned (the
    // non-negotiable affirmative behavior, exercised beside the refusal).
    await confirm(versionId, ['s2']);
    const confirmed = (await store.loadDocument(stageId))!.scenes.find(
      (candidate) => candidate.id === 's2',
    )!;
    expect(deriveSceneAlignment(confirmed)).toMatchObject({ state: 'confirmed', aligned: true });
  });

  it('the persistence sink stamps generation baselines on the final scene set', async () => {
    const stageId = nextId('stage');
    const governed = governedScenes(stageId)[0]!;
    const legacyScene = makeSlideScene('legacy', stageId, 3);
    // A carrier without a classification (malformed model output the Stage-1
    // gate would normally refuse): the sink must SKIP it, not stamp a
    // fabricated baseline that derives stale from birth.
    const unclassified: AppScene = {
      ...makeSlideScene('s-unclassified', stageId, 4),
      teachingSkills: { primary: FEYNMAN },
    };
    const { createTeachingPackagePersistenceSink } =
      await import('@/lib/server/teaching-package/stage-persistence-sink');
    const sink = createTeachingPackagePersistenceSink('tpa-w15');
    await sink.persist(
      {
        id: stageId,
        stage: { id: stageId, name: 'Sink', createdAt: 1, updatedAt: 1 } as never,
        scenes: [governed, legacyScene, unclassified] as never[],
        outlines: [] as never[],
      },
      '',
    );
    const document = await makeStore().loadDocument(stageId);
    const savedGoverned = document!.scenes.find((candidate) => candidate.id === 's1')!;
    const savedLegacy = document!.scenes.find((candidate) => candidate.id === 'legacy')!;
    const savedUnclassified = document!.scenes.find(
      (candidate) => candidate.id === 's-unclassified',
    )!;
    // The baseline's fingerprint is over the SAVED material bytes — content and
    // actions as persisted, after narration normalization.
    expect(savedGoverned.alignmentBaseline).toMatchObject({
      origin: 'generation',
      primary: FEYNMAN,
      classification: 'instructional',
    });
    expect(savedGoverned.alignmentBaseline!.fingerprint).toBe(
      sceneMaterialFingerprint(savedGoverned),
    );
    expect(deriveSceneAlignment(savedGoverned)).toMatchObject({ state: 'current', aligned: true });
    expect('alignmentBaseline' in savedLegacy).toBe(false);
    // Unclassified: no baseline, honest validation-required — never a
    // self-invalidating stale/classification-change.
    expect(savedUnclassified.teachingSkills).toEqual({ primary: FEYNMAN });
    expect('alignmentBaseline' in savedUnclassified).toBe(false);
    expect(deriveSceneAlignment(savedUnclassified)).toMatchObject({
      state: 'validation-required',
      aligned: false,
    });
  });

  it('the write barrier accepts a well-formed baseline and refuses a malformed one', () => {
    const base = makeSlideScene('s1', 'st', 1);
    const wellFormed = buildSceneAlignmentBaseline(
      { ...base, teachingSkills: { primary: FEYNMAN, classification: 'instructional' } },
      { origin: 'generation', now: 1 },
    );
    expect(validateAppScene({ ...base, alignmentBaseline: wellFormed } as never)).toEqual({
      valid: true,
    });
    for (const malformed of [
      { ...wellFormed, origin: 'somewhere-else' },
      { ...wellFormed, classification: 'ambiguous' },
      { ...wellFormed, fingerprint: '' },
      { ...wellFormed, establishedAt: 'yesterday' },
    ]) {
      const result = validateAppScene({ ...base, alignmentBaseline: malformed } as never);
      expect(result.valid, JSON.stringify(malformed)).toBe(false);
    }
  });
});
