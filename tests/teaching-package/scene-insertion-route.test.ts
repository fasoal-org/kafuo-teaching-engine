import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  insertAttempt,
  insertVersion,
  readVersion,
  upsertContentUnits,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { stampGenerationAlignmentBaselines } from '@/lib/server/teaching-package/alignment';
import { deriveSceneAlignment } from '@/lib/server/teaching-package/alignment';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import type { InsertOneSceneInput } from '@/lib/server/teaching-package/insert-one-scene';
import { submitForReview } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeOutline, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * Reviewer-generated slide for an uncovered lesson part over PGlite, through
 * the real routes, insertion store, fences, schema and planner (plan §6, §11,
 * §18 `scene-insertion-route`). Only the model calls are stubbed: the route's
 * `aiCallFor` answers the planner, and the content/actions pipeline is
 * replaced by a deterministic candidate (covered by `insert-one-scene.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  plannerAnswer: null as null | ((prompt: string) => string),
  prompts: [] as string[],
  duringGeneration: null as null | (() => Promise<void>),
  /** Runs between the new-run checks and T1 (the route is resolved there). */
  duringRoute: null as null | (() => Promise<void>),
}));

vi.mock('@/lib/server/teaching-package/insert-one-scene', () => ({
  insertOneScene: mocks.insert,
}));
vi.mock('@/lib/server/teaching-package/routed-insertion-call', () => ({
  INSERTION_PLANNER_STAGE: 'scene-outlines-stream',
  createInsertionRoute: vi.fn(async () => {
    await mocks.duringRoute?.();
    return {
      aiCallFor: () => async (system: string, user: string) => {
        mocks.prompts.push(`${system}\n${user}`);
        return mocks.plannerAnswer!(user);
      },
      assertAvailable: () => {},
      description: { mode: 'test' },
    };
  }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

const TENANT = 'tenant-test';
const REASON = 'unit three has no slide REASON-MARK';
const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };

const POLICY = {
  required: [],
  preferred: [],
  allowed: [FEYNMAN, LECTURE],
  combinationRestrictions: [],
};

function flowFor(governed: boolean): TeachingFlowEntry[] {
  const skills = governed ? { skillPolicy: POLICY } : {};
  return [
    {
      stage: 'lesson_opener',
      instructions: 'open the lesson',
      scenePolicy: {
        sceneTypes: ['slide'],
        slideTypes: ['cover'],
        contentRoles: ['orientation'],
        cardinality: 'exactly_one',
      },
      ...skills,
    },
    {
      stage: 'explain',
      instructions: 'teach the content',
      scenePolicy: {
        sceneTypes: ['slide'],
        contentRoles: ['explanation', 'example'],
        cardinality: 'one_or_more',
      },
      ...skills,
    },
    {
      stage: 'close',
      instructions: 'summarize',
      scenePolicy: { sceneTypes: ['slide'], contentRoles: ['summary'], cardinality: 'one_or_more' },
      ...skills,
    },
  ] as TeachingFlowEntry[];
}

function slide(
  id: string,
  stageId: string,
  order: number,
  stage: { key: string; flowIndex: number },
  semantics: { slideType: string; contentRole: string },
  units: string[],
  governed: boolean,
): AppScene {
  const base = makeSlideScene(id, stageId, order, `title ${id}`);
  return {
    ...base,
    outlineId: `o-${id}`,
    teachingStage: stage,
    sourceContentUnitIds: units,
    ...(governed
      ? {
          teachingSkills:
            semantics.contentRole === 'orientation'
              ? { classification: 'non-instructional' as const }
              : { primary: FEYNMAN, classification: 'instructional' as const },
        }
      : {}),
    content: {
      ...(base.content as Extract<AppScene['content'], { type: 'slide' }>),
      canvas: {
        ...(base.content as Extract<AppScene['content'], { type: 'slide' }>).canvas,
        type: semantics.slideType,
      },
      contentRole: semantics.contentRole,
    },
    actions: [],
  } as unknown as AppScene;
}

function lessonScenes(stageId: string, governed: boolean): AppScene[] {
  const scenes = [
    slide(
      's1',
      stageId,
      1,
      { key: 'lesson_opener', flowIndex: 0 },
      { slideType: 'cover', contentRole: 'orientation' },
      [],
      governed,
    ),
    slide(
      's2',
      stageId,
      2,
      { key: 'explain', flowIndex: 1 },
      { slideType: 'content', contentRole: 'explanation' },
      ['cu_1'],
      governed,
    ),
    slide(
      's3',
      stageId,
      3,
      { key: 'explain', flowIndex: 1 },
      { slideType: 'content', contentRole: 'explanation' },
      ['cu_2'],
      governed,
    ),
    slide(
      's4',
      stageId,
      4,
      { key: 'close', flowIndex: 2 },
      { slideType: 'content', contentRole: 'summary' },
      [],
      governed,
    ),
  ];
  return governed ? stampGenerationAlignmentBaselines(scenes, 1) : scenes;
}

const UNITS = [
  {
    unitId: 'cu_1',
    orderIndex: 1,
    role: 'CONCEPT',
    title: 'Unit one',
    normalizedText: 'UNIT-ONE-TEXT about forces',
  },
  {
    unitId: 'cu_2',
    orderIndex: 2,
    role: 'CONCEPT',
    title: 'Unit two',
    normalizedText: 'UNIT-TWO-TEXT about motion',
  },
  {
    unitId: 'cu_3',
    orderIndex: 3,
    role: 'CONCEPT',
    title: 'Unit three',
    normalizedText: 'UNIT-THREE-TEXT about friction',
  },
  {
    unitId: 'cu_4',
    orderIndex: 4,
    role: 'CONCEPT',
    title: 'Unit four',
    normalizedText: 'UNIT-FOUR-TEXT about drag',
  },
  {
    unitId: 'cu_ref',
    orderIndex: 5,
    role: 'REFERENCE',
    title: 'Glossary',
    normalizedText: 'glossary text',
  },
];

function plannerJson(governed: boolean, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: 'Friction',
    keyPoints: ['friction opposes motion', 'it depends on surfaces', 'it produces heat'],
    description: 'explain friction with one everyday example',
    slideType: 'content',
    contentRole: 'explanation',
    contentKind: 'concept',
    suggestedImageIds: [],
    ...(governed ? { teachingSkills: { primary: FEYNMAN, classification: 'instructional' } } : {}),
    ...overrides,
  });
}

/** The deterministic "generated" slide for a planned outline. */
function candidateFor(input: InsertOneSceneInput): AppScene {
  const base = makeSlideScene(
    input.newSceneId,
    input.stage.id,
    input.outline.order,
    input.outline.title,
  );
  return {
    ...base,
    outlineId: input.outline.id,
    teachingStage: input.outline.teachingStage,
    sourceContentUnitIds: input.outline.sourceContentUnitIds,
    ...(input.outline.teachingSkills ? { teachingSkills: input.outline.teachingSkills } : {}),
    content: {
      ...(base.content as Extract<AppScene['content'], { type: 'slide' }>),
      canvas: {
        ...(base.content as Extract<AppScene['content'], { type: 'slide' }>).canvas,
        type: input.outline.slideType,
        elements: [
          {
            id: 'text-generated',
            type: 'text',
            content: `<p>${input.outline.title}</p>`,
            left: 10,
            top: 10,
            width: 300,
            height: 50,
            rotate: 0,
            defaultFontName: 'Inter',
            defaultColor: '#111111',
          },
        ],
      },
      contentRole: input.outline.contentRole,
      ...(input.outline.contentKind ? { contentKind: input.outline.contentKind } : {}),
    },
    actions: [],
  } as unknown as AppScene;
}

describe('reviewer-generated slide insertion routes', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://insert-route-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'insert-route-key');
    mocks.insert.mockReset();
    mocks.prompts = [];
    mocks.duringGeneration = null;
    mocks.duringRoute = null;
    mocks.plannerAnswer = () => plannerJson(false);
    mocks.insert.mockImplementation(async (input: InsertOneSceneInput) => {
      await mocks.duringGeneration?.();
      return { ok: true, scene: candidateFor(input) };
    });
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function editorStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  interface Seed {
    stageId: string;
    versionId: string;
    cookie: string;
  }

  async function seed(
    options: {
      governed?: boolean;
      status?: 'draft' | 'approved';
      units?: boolean;
      scenes?: (stageId: string) => AppScene[];
    } = {},
  ): Promise<Seed> {
    const governed = options.governed ?? false;
    const stageId = unique('stage-ins');
    const versionId = unique('tpv');
    const attemptId = unique('tpa');
    const item = { type: 'lesson' as const, id: unique('li') };
    await editorStore().saveDocument(
      makeDocument(
        stageId,
        'Insertion package',
        (options.scenes ?? ((id) => lessonScenes(id, governed)))(stageId),
        makeOutline('insertion'),
      ),
    );
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: TENANT, learningItem: item },
      version: 1,
      status: options.status ?? 'draft',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: TENANT, learningItem: item },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      ...(governed ? { teachingSkillsContract: 'kafuo.teaching-skills.v1' } : {}),
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
        subjectCode: 'PHYS',
        teachingFlow: flowFor(governed),
      },
      now: 1,
    });
    await upsertSourceContext(qp(), {
      tenantId: TENANT,
      attemptId,
      contentResourceId: 'cs-1',
      measuredSha256: 'a'.repeat(64),
      text: 'source',
      sourceKind: 'kafuo_normalized',
    });
    if (options.units !== false) {
      await upsertContentUnits(qp(), { tenantId: TENANT, attemptId, units: UNITS });
    }
    const { token } = buildEditorGrantPayload({
      tenantId: TENANT,
      versionId,
      stageId,
      capability: 'write',
    });
    const cookie = `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, stageId),
    )}`;
    return { stageId, versionId, cookie };
  }

  function readCookie(seeded: Seed) {
    const { token } = buildEditorGrantPayload({
      tenantId: TENANT,
      versionId: seeded.versionId,
      stageId: seeded.stageId,
      capability: 'read',
    });
    return `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, seeded.stageId),
    )}`;
  }

  async function post(seeded: Seed, body: Record<string, unknown>, cookie = seeded.cookie) {
    const { POST } = await import('@/app/api/stages/[id]/scene-insertions/route');
    return POST(
      new NextRequest(`http://localhost/api/stages/${seeded.stageId}/scene-insertions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: seeded.stageId }) },
    );
  }

  async function get(route: 'gate' | 'units' | 'byKey' | 'byId', seeded: Seed, arg = '') {
    const headers = { cookie: seeded.cookie };
    if (route === 'gate') {
      const { GET } = await import('@/app/api/stages/[id]/scene-insertion/route');
      return GET(new NextRequest(`http://localhost/x`, { headers }), {
        params: Promise.resolve({ id: seeded.stageId }),
      });
    }
    if (route === 'units') {
      const { GET } = await import('@/app/api/stages/[id]/content-units/route');
      return GET(new NextRequest(`http://localhost/x`, { headers }), {
        params: Promise.resolve({ id: seeded.stageId }),
      });
    }
    if (route === 'byKey') {
      const { GET } = await import('@/app/api/stages/[id]/scene-insertions/route');
      return GET(new NextRequest(`http://localhost/x?key=${arg}`, { headers }), {
        params: Promise.resolve({ id: seeded.stageId }),
      });
    }
    const { GET } = await import('@/app/api/stages/[id]/scene-insertions/[insertionId]/route');
    return GET(new NextRequest(`http://localhost/x`, { headers }), {
      params: Promise.resolve({ id: seeded.stageId, insertionId: arg }),
    });
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    unitIds: ['cu_3'],
    afterSceneId: 's3',
    beforeSceneId: 's4',
    teachingStage: { key: 'explain', flowIndex: 1 },
    instruction: 'use a sliding box example',
    reason: REASON,
    idempotencyKey: `key-${randomUUID()}`,
    ...overrides,
  });

  async function scenesOf(stageId: string) {
    const result = await pool.query(
      `SELECT s.id, s.scene_order, s.data, sr.rev FROM document_scenes s
         LEFT JOIN document_scene_revision sr ON sr.stage_id = s.stage_id AND sr.scene_id = s.id
        WHERE s.stage_id = $1 ORDER BY s.scene_order`,
      [stageId],
    );
    return (
      result.rows as Array<{ id: string; scene_order: number; data: AppScene; rev: number }>
    ).map((row) => ({
      id: row.id,
      order: Number(row.scene_order),
      scene: row.data,
      rev: Number(row.rev),
    }));
  }

  async function outlineOf(stageId: string) {
    const result = await pool.query('SELECT data FROM document_outlines WHERE stage_id = $1', [
      stageId,
    ]);
    return JSON.stringify((result.rows[0] as { data: unknown } | undefined)?.data ?? null);
  }

  async function events(versionId: string) {
    return (
      await pool.query(
        `SELECT event_type, reason, data FROM teaching_package_review_events
          WHERE version_id = $1 AND event_type LIKE 'scene_insertion%' ORDER BY id`,
        [versionId],
      )
    ).rows as Array<{ event_type: string; reason: string | null; data: Record<string, unknown> }>;
  }

  async function insertionRows(stageId: string) {
    return (
      await pool.query(
        'SELECT * FROM teaching_package_scene_insertions WHERE stage_id = $1 ORDER BY requested_at',
        [stageId],
      )
    ).rows as Array<Record<string, unknown>>;
  }

  // -------------------------------------------------------------- success

  it('inserts one grounded slide atomically, shifts only orders, and keeps the outline byte-equal', async () => {
    const seeded = await seed();
    const outlineBefore = await outlineOf(seeded.stageId);
    const before = await scenesOf(seeded.stageId);
    const response = await post(seeded, body({ idempotencyKey: 'key-success-1' }));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      insertion: {
        insertionId: string;
        status: string;
        newSceneId: string;
        resultSceneRev: number;
        scene: AppScene;
        revTransitions: Record<string, { before: number; after: number }>;
      };
      replayed: boolean;
    };
    expect(result.replayed).toBe(false);
    expect(result.insertion.status).toBe('succeeded');
    const after = await scenesOf(seeded.stageId);
    expect(after.map((row) => row.id)).toEqual([
      's1',
      's2',
      's3',
      result.insertion.newSceneId,
      's4',
    ]);
    expect(after.map((row) => row.order)).toEqual([1, 2, 3, 4, 5]);
    const fresh = after[3]!.scene;
    expect(fresh.outlineId).toMatch(/^ins_/);
    expect(fresh.teachingStage).toEqual({ key: 'explain', flowIndex: 1 });
    expect(fresh.sourceContentUnitIds).toEqual(['cu_3']);
    expect(fresh).toEqual(result.insertion.scene);
    // Only the order moved on the existing Scenes.
    for (const id of ['s1', 's2', 's3', 's4']) {
      const was = before.find((row) => row.id === id)!.scene;
      const now = after.find((row) => row.id === id)!.scene;
      expect({ ...now, order: 0 }).toEqual({ ...was, order: 0 });
    }
    // The outline record is untouched (D-6).
    expect(await outlineOf(seeded.stageId)).toBe(outlineBefore);
    // Revision lineage: every rewritten Scene's before/after.
    for (const id of ['s1', 's2', 's3', 's4']) {
      expect(result.insertion.revTransitions[id]).toEqual({
        before: before.find((row) => row.id === id)!.rev,
        after: after.find((row) => row.id === id)!.rev,
      });
    }
    const [row] = await insertionRows(seeded.stageId);
    expect(row).toMatchObject({ status: 'succeeded', reason: REASON });
    expect((await events(seeded.versionId)).map((event) => event.event_type)).toEqual([
      'scene_insertion_started',
      'scene_insertion_completed',
    ]);
    // The reason never reaches a model input; the unit text does reach the planner.
    expect(mocks.prompts.join('\n')).not.toContain('REASON-MARK');
    expect(mocks.prompts[0]).toContain('UNIT-THREE-TEXT');
    expect(mocks.prompts[0]).not.toContain('UNIT-ONE-TEXT');
    expect(mocks.prompts[0]).toContain('<<<INSTRUCTION');
    expect(JSON.stringify(mocks.insert.mock.calls[0]![0])).not.toContain('REASON-MARK');
  });

  it('replays a lost success BEFORE the new-run checks (the units are covered by then)', async () => {
    const seeded = await seed();
    const request = body({ idempotencyKey: 'key-replay-1' });
    const first = await post(seeded, request);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { insertion: { newSceneId: string } };
    const again = await post(seeded, request);
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as {
      replayed: boolean;
      insertion: { newSceneId: string };
    };
    expect(againBody.replayed).toBe(true);
    expect(againBody.insertion.newSceneId).toBe(firstBody.insertion.newSceneId);
    expect(mocks.insert).toHaveBeenCalledOnce();
    // Status by key and by id.
    const byKey = await get('byKey', seeded, 'key-replay-1');
    expect(byKey.status).toBe(200);
    const status = (await byKey.json()) as { insertionId: string; status: string };
    expect(status.status).toBe('succeeded');
    expect((await get('byId', seeded, status.insertionId)).status).toBe(200);
  });

  it('a retry whose earlier run lost its lease answers INSERTION_LEASE_LOST before any new-run check', async () => {
    const seeded = await seed();
    const request = body({ idempotencyKey: 'key-expired-1' });
    const { sceneInsertionRequestDigest } =
      await import('@/lib/server/teaching-package/scene-insertion');
    const { idempotencyKey: _key, ...rest } = request;
    const now = Date.now();
    await pool.query(
      `INSERT INTO teaching_package_scene_insertions
         (id, tenant_id, version_id, stage_id, new_scene_id, new_outline_id, unit_ids, teaching_stage,
          idempotency_key, request_digest, reason, actor_ref, status, attempt_token, lease_expires_at,
          requested_at)
       VALUES ('tpsi_expired', $1, $2, $3, 'n', 'ins_n', '["cu_3"]'::jsonb,
               '{"key":"explain","flowIndex":1}'::jsonb, 'key-expired-1', $4, 'r', 'a', 'running', 't',
               $5, $6)`,
      [
        TENANT,
        seeded.versionId,
        seeded.stageId,
        sceneInsertionRequestDigest(rest as never),
        now - 1,
        now - 1_000_000,
      ],
    );
    // A new-run check would now refuse (the version is locked): the replay
    // must answer first.
    await pool.query(`UPDATE teaching_package_versions SET status = 'approved' WHERE id = $1`, [
      seeded.versionId,
    ]);
    const response = await post(seeded, request);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INSERTION_LEASE_LOST',
    );
    expect(mocks.prompts).toHaveLength(0);
    // The scoped reclaim recorded the lost lease (and nothing was refused).
    expect((await events(seeded.versionId)).map((event) => event.event_type)).toEqual([
      'scene_insertion_failed',
    ]);
    const [row] = await insertionRows(seeded.stageId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'LEASE_EXPIRED' });
  });

  it('a different body with the same key is IDEMPOTENCY_KEY_REUSED', async () => {
    const seeded = await seed();
    expect((await post(seeded, body({ idempotencyKey: 'key-reuse-1' }))).status).toBe(200);
    const response = await post(
      seeded,
      body({ idempotencyKey: 'key-reuse-1', instruction: 'something else' }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('status reads are scoped to tenant + version + Stage', async () => {
    const seeded = await seed();
    const other = await seed();
    const response = await post(seeded, body());
    const { insertion } = (await response.json()) as { insertion: { insertionId: string } };
    const foreign = await get('byId', other, insertion.insertionId);
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe(
      'INSERTION_NOT_FOUND',
    );
    // The owner's read: a terminal row reports no lease.
    const own = await get('byId', seeded, insertion.insertionId);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ status: 'succeeded', leaseRemainingMs: null });
  });

  it('a running row reports its remaining lease, so the editor keeps holding past its budget', async () => {
    const { insertionStatusBody } = await import('@/lib/server/teaching-package/scene-insertion');
    const { readSceneInsertion } =
      await import('@/lib/server/teaching-package/scene-insertion-store');
    const seeded = await seed();
    const now = Date.now();
    await pool.query(
      `INSERT INTO teaching_package_scene_insertions
         (id, tenant_id, version_id, stage_id, new_scene_id, new_outline_id, unit_ids, teaching_stage,
          idempotency_key, request_digest, reason, actor_ref, status, attempt_token, lease_expires_at,
          requested_at)
       VALUES ('tpsi_leased', $1, $2, $3, 'n', 'ins_n', '["cu_3"]'::jsonb,
               '{"key":"explain","flowIndex":1}'::jsonb, 'k-leased', 'd', 'r', 'a', 'running', 't', $4, $5)`,
      [TENANT, seeded.versionId, seeded.stageId, now + 600_000, now],
    );
    const row = await readSceneInsertion(pool as unknown as ConnectableQueryable, 'tpsi_leased');
    expect(row).not.toBeNull();
    expect(insertionStatusBody(row!, now)).toMatchObject({
      status: 'running',
      leaseRemainingMs: 600_000,
    });
    expect(insertionStatusBody(row!, now + 700_000).leaseRemainingMs).toBe(0);
  });

  // -------------------------------------------------------------- refusals

  it.each([
    ['a covered unit', { unitIds: ['cu_1'] }, 409, 'INSERTION_UNIT_ALREADY_COVERED'],
    ['a reference unit', { unitIds: ['cu_ref'] }, 422, 'INSERTION_UNIT_INVALID'],
    ['an unknown unit', { unitIds: ['cu_9'] }, 422, 'INSERTION_UNIT_INVALID'],
    [
      'non-adjacent anchors',
      { afterSceneId: 's1', beforeSceneId: 's4' },
      422,
      'INSERTION_POSITION_NOT_ALLOWED',
    ],
    [
      'a full exactly_one position',
      {
        afterSceneId: 's1',
        beforeSceneId: 's2',
        teachingStage: { key: 'lesson_opener', flowIndex: 0 },
      },
      422,
      'INSERTION_POSITION_NOT_ALLOWED',
    ],
    [
      'a stage outside the boundary',
      { teachingStage: { key: 'lesson_opener', flowIndex: 0 } },
      422,
      'INSERTION_POSITION_NOT_ALLOWED',
    ],
  ])(
    'refuses %s without any model call, and audits it',
    async (_label, overrides, status, code) => {
      const seeded = await seed();
      const response = await post(seeded, body(overrides));
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(mocks.prompts).toHaveLength(0);
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(await insertionRows(seeded.stageId)).toHaveLength(0);
      const audit = await events(seeded.versionId);
      expect(audit.map((event) => event.event_type)).toEqual(['scene_insertion_refused']);
      expect(audit[0]!.data).toMatchObject({ refusalCode: code });
    },
  );

  it('refuses a package that already fails the exact flow (D-20)', async () => {
    const seeded = await seed({
      scenes: (stageId) => [
        ...lessonScenes(stageId, false).slice(0, 3),
        // The closing stage is missing entirely.
      ],
    });
    const response = await post(seeded, body({ afterSceneId: 's2', beforeSceneId: 's3' }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INSERTION_FLOW_INVALID',
    );
    expect(mocks.prompts).toHaveLength(0);
  });

  it('a package without retained lesson parts is not supported', async () => {
    const seeded = await seed({ units: false });
    const response = await post(seeded, body());
    expect(response.status).toBe(422);
    const error = ((await response.json()) as { error: { code: string; details: unknown } }).error;
    expect(error).toMatchObject({
      code: 'INSERTION_NOT_SUPPORTED',
      details: { reason: 'no_content_units' },
    });
    const gate = (await (await get('gate', seeded)).json()) as Record<string, unknown>;
    expect(gate).toMatchObject({ supported: false, unsupportedReason: 'no_content_units' });
  });

  it('a read grant cannot insert; an approved version is locked', async () => {
    const seeded = await seed();
    const readOnly = await post(seeded, body(), readCookie(seeded));
    expect(readOnly.status).toBe(403);
    const approved = await seed({ status: 'approved' });
    const locked = await post(approved, body());
    expect(locked.status).toBe(423);
  });

  // ---------------------------------------------- mutex with regeneration (R2)

  it('refuses while a regeneration runs on the Stage, and the regeneration refuses while an insertion runs (B-3)', async () => {
    const seeded = await seed();
    const now = Date.now();
    await pool.query(
      `INSERT INTO teaching_package_scene_regenerations
         (id, tenant_id, version_id, stage_id, scene_id, scene_order, idempotency_key, request_digest,
          instruction, reason, actor_ref, status, attempt_token, lease_expires_at, base_scene_rev,
          previous_scene, requested_at)
       VALUES ('tsr-running', $1, $2, $3, 's2', 2, 'k-regen', 'd', 'i', 'r', 'a', 'running', 't',
               $4, 1, '{}'::jsonb, $5)`,
      [TENANT, seeded.versionId, seeded.stageId, now + 600_000, now],
    );
    const refused = await post(seeded, body());
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'STAGE_GENERATION_IN_PROGRESS',
    );
    // An EXPIRED regeneration lease is reclaimed by the insertion's T1 instead.
    await pool.query(
      `UPDATE teaching_package_scene_regenerations SET lease_expires_at = $1 WHERE id = 'tsr-running'`,
      [now - 1],
    );
    expect((await post(seeded, body())).status).toBe(200);
    const reclaimed = await pool.query(
      `SELECT status, error_code FROM teaching_package_scene_regenerations WHERE id = 'tsr-running'`,
    );
    expect(reclaimed.rows[0]).toMatchObject({ status: 'failed', error_code: 'LEASE_EXPIRED' });

    // B-3: a running insertion refuses a regeneration start.
    const second = await seed();
    await pool.query(
      `INSERT INTO teaching_package_scene_insertions
         (id, tenant_id, version_id, stage_id, new_scene_id, new_outline_id, unit_ids, teaching_stage,
          idempotency_key, request_digest, reason, actor_ref, status, attempt_token, lease_expires_at,
          requested_at)
       VALUES ('tpsi_running', $1, $2, $3, 'n', 'ins_n', '["cu_3"]'::jsonb,
               '{"key":"explain","flowIndex":1}'::jsonb, 'k-ins', 'd', 'r', 'a', 'running', 't', $4, $5)`,
      [TENANT, second.versionId, second.stageId, now + 600_000, now],
    );
    const { startSceneRegeneration } =
      await import('@/lib/server/teaching-package/scene-regeneration-store');
    const start = await startSceneRegeneration(pool as unknown as ConnectableQueryable, {
      tenantId: TENANT,
      versionId: second.versionId,
      stageId: second.stageId,
      sceneId: 's2',
      idempotencyKey: 'k-regen-2',
      requestDigest: 'd2',
      instruction: 'make it simpler please',
      reason: 'a reason',
      actorRef: 'a',
      sessionRef: null,
      now,
    });
    expect(start).toMatchObject({
      kind: 'refused',
      refusal: { code: 'STAGE_GENERATION_IN_PROGRESS' },
    });
    // …and an EXPIRED insertion lease is reclaimed by the regeneration's T1.
    await pool.query(
      `UPDATE teaching_package_scene_insertions SET lease_expires_at = $1 WHERE id = 'tpsi_running'`,
      [now - 1],
    );
    const retried = await startSceneRegeneration(pool as unknown as ConnectableQueryable, {
      tenantId: TENANT,
      versionId: second.versionId,
      stageId: second.stageId,
      sceneId: 's2',
      idempotencyKey: 'k-regen-3',
      requestDigest: 'd3',
      instruction: 'make it simpler please',
      reason: 'a reason',
      actorRef: 'a',
      sessionRef: null,
      now,
    });
    expect(retried.kind).toBe('started');
    const ins = await pool.query(
      `SELECT status, error_code FROM teaching_package_scene_insertions WHERE id = 'tpsi_running'`,
    );
    expect(ins.rows[0]).toMatchObject({ status: 'failed', error_code: 'LEASE_EXPIRED' });
  });

  // ---------------------------------------------- T2 on the exact snapshot (R1)

  it('an edit of another slide during the run is kept: T2 builds from the new state', async () => {
    const seeded = await seed();
    mocks.duringGeneration = async () => {
      const current = (await scenesOf(seeded.stageId)).find((row) => row.id === 's2')!.scene;
      await editorStore().putScene(seeded.stageId, { ...current, title: 'edited during the run' });
    };
    const response = await post(seeded, body());
    expect(response.status).toBe(200);
    const after = await scenesOf(seeded.stageId);
    expect(after.find((row) => row.id === 's2')!.scene.title).toBe('edited during the run');
    expect(after).toHaveLength(5);
  });

  it('a neighbour deleted between the new-run checks and T1 → 409 INSERTION_POSITION_CHANGED, audited, no run', async () => {
    const seeded = await seed();
    mocks.duringRoute = async () => {
      const document = await editorStore().loadDocument(seeded.stageId);
      await editorStore().saveDocument({
        ...document!,
        scenes: document!.scenes.filter((scene) => scene.id !== 's4'),
      });
    };
    const response = await post(seeded, body());
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INSERTION_POSITION_CHANGED',
    );
    expect(mocks.prompts).toHaveLength(0);
    expect(await insertionRows(seeded.stageId)).toHaveLength(0);
    expect((await events(seeded.versionId)).map((event) => event.event_type)).toEqual([
      'scene_insertion_refused',
    ]);
  });

  it('an unexpected generation error is SCENE_CONTENT_GENERATION_FAILED live AND on replay', async () => {
    const seeded = await seed();
    mocks.insert.mockImplementationOnce(async () => {
      throw new Error('socket hang up');
    });
    const request = body({ idempotencyKey: 'key-unexpected-1' });
    const live = await post(seeded, request);
    expect(live.status).toBe(502);
    expect(((await live.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_CONTENT_GENERATION_FAILED',
    );
    const replay = await post(seeded, request);
    expect(replay.status).toBe(502);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_CONTENT_GENERATION_FAILED',
    );
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it('a neighbour deleted during the run → INSERTION_POSITION_CHANGED, nothing else changes', async () => {
    const seeded = await seed();
    mocks.duringGeneration = async () => {
      const document = await editorStore().loadDocument(seeded.stageId);
      await editorStore().saveDocument({
        ...document!,
        scenes: document!.scenes.filter((scene) => scene.id !== 's4'),
      });
    };
    const response = await post(seeded, body());
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INSERTION_POSITION_CHANGED',
    );
    expect((await scenesOf(seeded.stageId)).map((row) => row.id)).toEqual(['s1', 's2', 's3']);
    const [row] = await insertionRows(seeded.stageId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'INSERTION_POSITION_CHANGED' });
    expect(row!.candidate_scene).toBeTruthy();
    expect((await events(seeded.versionId)).map((event) => event.event_type)).toEqual([
      'scene_insertion_started',
      'scene_insertion_failed',
    ]);
  });

  // ---------------------------------------------- the planner contract (R4)

  it('one corrective re-ask carries only the validation messages, never the reason', async () => {
    const seeded = await seed();
    let calls = 0;
    mocks.plannerAnswer = () => {
      calls += 1;
      // First answer: a role the position does not allow.
      return calls === 1
        ? plannerJson(false, { contentRole: 'summary', contentKind: undefined })
        : plannerJson(false);
    };
    const response = await post(seeded, body());
    expect(response.status).toBe(200);
    expect(mocks.prompts).toHaveLength(2);
    expect(mocks.prompts[1]).toContain('rejected');
    expect(mocks.prompts[1]).not.toContain('REASON-MARK');
  });

  it('a plan that fails twice is INSERTION_PLAN_INVALID / FLOW_POLICY_VIOLATION, and nothing is written', async () => {
    const seeded = await seed();
    mocks.plannerAnswer = () => plannerJson(false, { keyPoints: ['only one'] });
    const response = await post(seeded, body());
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INSERTION_PLAN_INVALID',
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(await scenesOf(seeded.stageId)).toHaveLength(4);
    const [row] = await insertionRows(seeded.stageId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'INSERTION_PLAN_INVALID' });
  });

  // ---------------------------------------------- governed (A-2, A-15)

  it('governed: the slide is born submit-ready (Skills, current alignment), twice in a row', async () => {
    const seeded = await seed({ governed: true });
    mocks.plannerAnswer = () => plannerJson(true);
    const first = await post(seeded, body());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { insertion: { newSceneId: string } };
    const fresh = (await scenesOf(seeded.stageId)).find(
      (row) => row.id === firstBody.insertion.newSceneId,
    )!.scene;
    expect(fresh.teachingSkills).toEqual({ primary: FEYNMAN, classification: 'instructional' });
    expect(deriveSceneAlignment(fresh)).toMatchObject({ aligned: true });
    expect(mocks.prompts[0]).toContain('feynman-learning@v1');
    expect(mocks.insert.mock.calls[0]![0].governed).toBeDefined();
    // A second insertion validates against the first one's OWN Skills (it has
    // no outline entry, V2-1).
    mocks.plannerAnswer = () => plannerJson(true, { title: 'Drag' });
    const second = await post(
      seeded,
      body({
        unitIds: ['cu_4'],
        afterSceneId: firstBody.insertion.newSceneId,
        beforeSceneId: 's4',
      }),
    );
    expect(second.status).toBe(200);
    expect((await scenesOf(seeded.stageId)).map((row) => row.order)).toEqual([1, 2, 3, 4, 5, 6]);
    const submitted = await submitForReview(pool as unknown as ConnectableQueryable, {
      tenantId: TENANT,
      versionId: seeded.versionId,
      actorRef: 'reviewer-1',
    });
    expect(submitted.status).toBe('in_review');
    expect((await readVersion(qp(), seeded.versionId, { tenantId: TENANT }))!.status).toBe(
      'in_review',
    );
  });

  // ---------------------------------------------- read routes

  it('content units: coverage, suggested positions and allowed stages — never the unit text', async () => {
    const seeded = await seed();
    const response = await get('units', seeded);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const text = await response.text();
    expect(text).not.toContain('UNIT-THREE-TEXT');
    const parsed = JSON.parse(text) as {
      lineageStatus: string;
      units: Array<{
        id: string;
        covered: boolean;
        instructional: boolean;
        suggestedPosition: unknown;
      }>;
      positions: Array<{
        afterSceneId: string | null;
        beforeSceneId: string | null;
        allowedStages: unknown[];
      }>;
    };
    expect(parsed.lineageStatus).toBe('own_attempt');
    expect(parsed.units.map((unit) => [unit.id, unit.covered, unit.instructional])).toEqual([
      ['cu_1', true, true],
      ['cu_2', true, true],
      ['cu_3', false, true],
      ['cu_4', false, true],
      ['cu_ref', false, false],
    ]);
    // §9.1: after the last slide citing the nearest preceding covered unit.
    expect(parsed.units[2]!.suggestedPosition).toEqual({ afterSceneId: 's3', beforeSceneId: 's4' });
    expect(parsed.units[4]!.suggestedPosition).toBeNull();
    const boundary = parsed.positions.find((p) => p.afterSceneId === 's3')!;
    expect(boundary.allowedStages).toEqual([
      { key: 'explain', flowIndex: 1 },
      { key: 'close', flowIndex: 2 },
    ]);
    const opening = parsed.positions.find((p) => p.afterSceneId === null)!;
    expect(opening.allowedStages).toEqual([]);
    const gate = (await (await get('gate', seeded)).json()) as Record<string, unknown>;
    expect(gate).toMatchObject({
      capability: 'write',
      editable: true,
      supported: true,
      running: [],
    });
  });
});
