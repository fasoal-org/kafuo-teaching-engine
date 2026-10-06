/**
 * W14 — Material-change detection, derived alignment state, and the
 * Skill/classification mutation route (teaching-skills plan §P Steps 14/15 ·
 * §K · §J · BR-TS-035/036/037 · FR-TS-039/040/041/042/043/054/070 ·
 * VAL-TS-010/016/023 · AC-TS-013/015).
 *
 * The R-6 boundary tests live in successor-model.test.ts (W13, where the one
 * boundary definition landed); what is pinned HERE is the §K derivation over
 * that boundary and the mutation route's behavior: content byte-identical
 * across a Skill switch, flow identity untouched, out-of-policy choices
 * rejected with NO partial assignment, the shared editability guard, and no
 * Skill error ever surfacing for a legacy version.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { readStageFreshnessManifest } from '@openmaic/storage';

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
  deriveSceneAlignment,
  deriveStageAlignment,
  sceneMaterialFingerprint,
} from '@/lib/server/teaching-package/alignment';
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
const DEEP_RESEARCH = { skillId: 'deep-research', version: 'v1' };

function baselineScene(
  scene: AppScene,
  baseline: {
    primary?: typeof FEYNMAN;
    supporting?: (typeof FEYNMAN)[];
    classification: 'instructional' | 'non-instructional';
    origin?: 'generation' | 'reviewer-confirmation';
  },
): AppScene {
  return {
    ...scene,
    teachingSkills: {
      ...(baseline.primary ? { primary: baseline.primary } : {}),
      ...(baseline.supporting ? { supporting: baseline.supporting } : {}),
      classification: baseline.classification,
    },
    alignmentBaseline: {
      ...(baseline.primary ? { primary: baseline.primary } : {}),
      ...(baseline.supporting ? { supporting: baseline.supporting } : {}),
      classification: baseline.classification,
      fingerprint: sceneMaterialFingerprint(scene),
      ...(baseline.origin === 'reviewer-confirmation' ? { actorRef: 'reviewer-1' } : {}),
      establishedAt: 1,
      origin: baseline.origin ?? 'generation',
    },
  };
}

describe('W14 derived alignment state (§K ladder)', () => {
  const base = makeSlideScene('s1', 'stage-a', 1);

  it('no baseline on a governed Scene → validation-required', () => {
    expect(deriveSceneAlignment(base)).toEqual({
      sceneId: 's1',
      state: 'validation-required',
      aligned: false,
    });
  });

  it('a matching baseline derives current (generation) or confirmed (reviewer-confirmation)', () => {
    expect(
      deriveSceneAlignment(
        baselineScene(base, { primary: FEYNMAN, classification: 'instructional' }),
      ),
    ).toMatchObject({ state: 'current', aligned: true, baselineOrigin: 'generation' });
    expect(
      deriveSceneAlignment(
        baselineScene(base, {
          primary: FEYNMAN,
          classification: 'instructional',
          origin: 'reviewer-confirmation',
        }),
      ),
    ).toMatchObject({ state: 'confirmed', aligned: true, baselineOrigin: 'reviewer-confirmation' });
  });

  it('a material edit (content · actions · title) makes the Scene stale', () => {
    const baselined = baselineScene(base, { primary: FEYNMAN, classification: 'instructional' });
    for (const mutate of [
      (scene: AppScene) => ({ ...scene, title: 'New title' }),
      (scene: AppScene) => ({ ...scene, actions: [] as AppScene['actions'] }),
      (scene: AppScene) =>
        ({
          ...scene,
          content: {
            ...scene.content,
            canvas: {
              ...(scene.content as { canvas: { viewportSize: number } }).canvas,
              viewportSize: 999,
            },
          },
        }) as AppScene,
    ]) {
      expect(deriveSceneAlignment(mutate(baselined)), String(mutate)).toMatchObject({
        state: 'stale',
        aligned: false,
        reason: 'material-change',
      });
    }
  });

  it('an assignment change makes the Scene stale — primary, supporting, or removal', () => {
    const baselined = baselineScene(base, {
      primary: FEYNMAN,
      supporting: [LECTURE],
      classification: 'instructional',
    });
    expect(
      deriveSceneAlignment({
        ...baselined,
        teachingSkills: { ...baselined.teachingSkills!, primary: LECTURE, supporting: [LECTURE] },
      }),
    ).toMatchObject({ reason: 'assignment-change' });
    expect(
      deriveSceneAlignment({
        ...baselined,
        teachingSkills: { classification: 'instructional', supporting: [LECTURE] },
      }),
    ).toMatchObject({ reason: 'assignment-change' });
    expect(
      deriveSceneAlignment({
        ...baselined,
        teachingSkills: { ...baselined.teachingSkills!, supporting: [DEEP_RESEARCH] },
      }),
    ).toMatchObject({ reason: 'assignment-change' });
  });

  it('a classification change alone makes the Scene stale', () => {
    const baselined = baselineScene(base, { primary: FEYNMAN, classification: 'instructional' });
    expect(
      deriveSceneAlignment({
        ...baselined,
        teachingSkills: { primary: FEYNMAN, classification: 'non-instructional' },
      }),
    ).toMatchObject({ reason: 'classification-change' });
  });

  it('a metadata-only edit (order · updatedAt · stageId · outlineId) leaves alignment current', () => {
    const baselined = baselineScene(base, { primary: FEYNMAN, classification: 'instructional' });
    const edited = {
      ...baselined,
      order: 77,
      outlineId: 'outline-x',
      updatedAt: (baselined.updatedAt ?? 0) + 9_000,
    };
    expect(sceneMaterialFingerprint(edited)).toBe(sceneMaterialFingerprint(baselined));
    expect(deriveSceneAlignment(edited)).toMatchObject({ state: 'current', aligned: true });
  });

  it('deriveStageAlignment keys every scene by id', () => {
    const one = baselineScene(makeSlideScene('a', 'st', 1), {
      primary: FEYNMAN,
      classification: 'instructional',
    });
    const two = makeSlideScene('b', 'st', 2);
    const map = deriveStageAlignment([one, two]);
    expect(map.get('a')).toMatchObject({ state: 'current' });
    expect(map.get('b')).toMatchObject({ state: 'validation-required' });
  });
});

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

describe('W14 Skill/classification mutation route (Step 15)', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-w14-${(counter += 1)}`;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w14-${randomUUID()}`);
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
        preferred: [FEYNMAN],
        allowed: [FEYNMAN, LECTURE],
        combinationRestrictions: [],
      },
    },
    {
      stage: 'outcome_teaching_cards',
      instructions: 'c',
      skillPolicy: {
        required: [{ skill: FEYNMAN, scope: 'flow_position', role: 'primary' }],
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
        teachingSkills: { primary: FEYNMAN, classification: 'instructional' },
      },
    ];
  }

  async function seedGovernedVersion(options: {
    status?: 'draft' | 'in_review' | 'approved';
    contract?: string | null;
    flow?: TeachingFlowEntry[];
  }): Promise<{ versionId: string; stageId: string }> {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await makeStore().saveDocument(makeDocument(stageId, 'W14', governedScenes(stageId)));
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
        teachingFlow: options.flow ?? flow,
      },
      now: 1,
    });
    return { versionId, stageId };
  }

  const switchSkills = (versionId: string, assignments: unknown[]) =>
    setSceneTeachingSkills(
      txPool(),
      versionId,
      { tenantId: 'tenant-test' },
      assignments.map((assignment) =>
        normalizeSkillAssignment(assignment as { sceneId: unknown; teachingSkills: unknown }),
      ),
    );

  it('switches a Primary within policy: content byte-identical, flow identity untouched', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    const before = (await makeStore().loadDocument(stageId))!;
    await switchSkills(versionId, [
      { sceneId: 's1', teachingSkills: { primary: LECTURE, classification: 'instructional' } },
    ]);
    const after = (await makeStore().loadDocument(stageId))!;
    const beforeScene = before.scenes.find((scene) => scene.id === 's1')!;
    const afterScene = after.scenes.find((scene) => scene.id === 's1')!;
    expect(afterScene.teachingSkills).toEqual({
      primary: LECTURE,
      classification: 'instructional',
    });
    // FR-TS-070 / VAL-TS-023: no silent regeneration — content, actions, title
    // and order are byte-identical.
    expect(afterScene.content).toEqual(beforeScene.content);
    expect(afterScene.actions).toEqual(beforeScene.actions);
    expect(afterScene.title).toBe(beforeScene.title);
    expect(afterScene.order).toBe(beforeScene.order);
    // FR-TS-041: flow identity unchanged — pinned.
    expect(afterScene.teachingStage).toEqual(beforeScene.teachingStage);
    // The other scene is untouched.
    expect(after.scenes.find((scene) => scene.id === 's2')!.teachingSkills).toEqual(
      before.scenes.find((scene) => scene.id === 's2')!.teachingSkills,
    );
  });

  it('rejects an out-of-policy choice with NO partial assignment', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    const before = (await makeStore().loadDocument(stageId))!;
    await expectTpError(
      switchSkills(versionId, [
        {
          sceneId: 's1',
          teachingSkills: { primary: DEEP_RESEARCH, classification: 'instructional' },
        },
      ]),
      'SKILL_ASSIGNMENT_INVALID',
    );
    const after = (await makeStore().loadDocument(stageId))!;
    expect(after.scenes.find((scene) => scene.id === 's1')!.teachingSkills).toEqual(
      before.scenes.find((scene) => scene.id === 's1')!.teachingSkills,
    );
  });

  it('rejects an unresolvable exact version with no partial assignment', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    const before = (await makeStore().loadDocument(stageId))!;
    await expectTpError(
      switchSkills(versionId, [
        {
          sceneId: 's1',
          teachingSkills: {
            primary: { skillId: 'feynman-learning', version: 'v99' },
            classification: 'instructional',
          },
        },
      ]),
      'SKILL_VERSION_UNRESOLVED',
    );
    expect((await makeStore().loadDocument(stageId))!.scenes).toEqual(before.scenes);
  });

  it('validates every assignment before the first write — a bad second assignment leaves the first untouched', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    const before = (await makeStore().loadDocument(stageId))!;
    await expectTpError(
      switchSkills(versionId, [
        { sceneId: 's1', teachingSkills: { primary: LECTURE, classification: 'instructional' } },
        {
          sceneId: 's2',
          teachingSkills: { primary: DEEP_RESEARCH, classification: 'instructional' },
        },
      ]),
      'SKILL_ASSIGNMENT_INVALID',
    );
    expect((await makeStore().loadDocument(stageId))!.scenes).toEqual(before.scenes);
  });

  it('refuses a change that would break a flow_position required rule', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    const before = (await makeStore().loadDocument(stageId))!;
    // s2 is the only scene at position 1 and position 1 REQUIRES feynman as
    // primary somewhere at the position — switching it away must refuse.
    await expectTpError(
      switchSkills(versionId, [
        { sceneId: 's2', teachingSkills: { primary: LECTURE, classification: 'instructional' } },
      ]),
      'SKILL_REQUIREMENT_UNSATISFIED',
    );
    expect((await makeStore().loadDocument(stageId))!.scenes).toEqual(before.scenes);
  });

  it('corrects a classification to non-instructional (the uncertain-case path)', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    // Position 0 has no required rules, so s1 may drop its selection entirely
    // once it is explicitly non-instructional.
    await switchSkills(versionId, [
      { sceneId: 's1', teachingSkills: { classification: 'non-instructional' } },
    ]);
    const after = (await makeStore().loadDocument(stageId))!;
    expect(after.scenes.find((scene) => scene.id === 's1')!.teachingSkills).toEqual({
      classification: 'non-instructional',
    });
  });

  it('refuses instructional without a Primary and non-instructional with a selection', async () => {
    const { versionId, stageId } = await seedGovernedVersion({});
    const before = (await makeStore().loadDocument(stageId))!;
    await expectTpError(
      switchSkills(versionId, [
        { sceneId: 's1', teachingSkills: { classification: 'instructional' } },
      ]),
      'SKILL_ASSIGNMENT_INVALID',
    );
    await expectTpError(
      switchSkills(versionId, [
        {
          sceneId: 's1',
          teachingSkills: { primary: FEYNMAN, classification: 'non-instructional' },
        },
      ]),
      'SKILL_ASSIGNMENT_INVALID',
    );
    expect((await makeStore().loadDocument(stageId))!.scenes).toEqual(before.scenes);
  });

  it('refuses non-editable lifecycle states through the shared guard', async () => {
    const inReview = await seedGovernedVersion({ status: 'in_review' });
    await expectTpError(
      switchSkills(inReview.versionId, [
        { sceneId: 's1', teachingSkills: { primary: LECTURE, classification: 'instructional' } },
      ]),
      'INVALID_TRANSITION',
    );
    const approved = await seedGovernedVersion({ status: 'approved' });
    await expectTpError(
      switchSkills(approved.versionId, [
        { sceneId: 's1', teachingSkills: { primary: LECTURE, classification: 'instructional' } },
      ]),
      'INVALID_TRANSITION',
    );
  });

  it('refuses a LEGACY version with a non-Skill error — legacy never produces a Skill error', async () => {
    const legacy = await seedGovernedVersion({ contract: null });
    const error = await expectTpError(
      switchSkills(legacy.versionId, [
        { sceneId: 's1', teachingSkills: { primary: LECTURE, classification: 'instructional' } },
      ]),
      'INVALID_REQUEST',
    );
    expect(error.code).not.toMatch(/^SKILL_|^SCENE_|^TEACHING_MODEL_/);
  });

  it('refuses an unknown scene id', async () => {
    const { versionId } = await seedGovernedVersion({});
    await expectTpError(
      switchSkills(versionId, [
        {
          sceneId: 'missing',
          teachingSkills: { primary: LECTURE, classification: 'instructional' },
        },
      ]),
      'INVALID_REQUEST',
    );
  });

  it('a no-op save is digest-stable; a metadata-only edit bumps sceneRev yet leaves alignment valid', async () => {
    const { stageId } = await seedGovernedVersion({});
    const store = makeStore();
    const document = (await store.loadDocument(stageId))!;
    const scene = document.scenes[0]!;
    const baselined = baselineScene(scene, { primary: FEYNMAN, classification: 'instructional' });
    await store.putScene(stageId, baselined);
    const manifestBefore = await readStageFreshnessManifest(stageId, qp() as never);

    // No-op save: same material fields, same fingerprint.
    await store.putScene(stageId, { ...baselined, updatedAt: (baselined.updatedAt ?? 0) + 1 });
    const afterNoop = (await store.loadDocument(stageId))!.scenes[0]!;
    expect(sceneMaterialFingerprint(afterNoop)).toBe(
      sceneMaterialFingerprint({ ...baselined, alignmentBaseline: undefined }),
    );

    // Metadata-only edit: order moves, the trigger bumps the scene revision,
    // and the derivation STILL matches — sceneRev is not the semantic signal.
    await store.putScene(stageId, { ...afterNoop, order: 50 });
    const manifestAfter = await readStageFreshnessManifest(stageId, qp() as never);
    const sceneRevBefore = manifestBefore!.scenes.find((entry) => entry.id === 's1')!.rev;
    const sceneRevAfter = manifestAfter!.scenes.find((entry) => entry.id === 's1')!.rev;
    expect(sceneRevAfter).toBeGreaterThan(sceneRevBefore);
    // After the reorder s1 is no longer scenes[0] — resolve it by id.
    const edited = (await store.loadDocument(stageId))!.scenes.find((scene) => scene.id === 's1')!;
    expect(edited.alignmentBaseline).toBeDefined();
    expect(deriveSceneAlignment(edited)).toMatchObject({ state: 'current', aligned: true });
  });

  it('the route uses the shared TEACHING_PACKAGE_EDITABLE_STATUSES guard, not an inline predicate', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'lib/server/teaching-package/scene-skills.ts'),
      'utf8',
    );
    expect(source).toContain('TEACHING_PACKAGE_EDITABLE_STATUSES.includes(version.status)');
    expect(source).not.toMatch(/status\s*!==\s*'draft'/);
    // And the exported constant finally has a consumer (plan §L's complaint).
    const types = readFileSync(path.join(process.cwd(), 'lib/types/teaching-package.ts'), 'utf8');
    expect(types).toContain('export const TEACHING_PACKAGE_EDITABLE_STATUSES');
  });
});
