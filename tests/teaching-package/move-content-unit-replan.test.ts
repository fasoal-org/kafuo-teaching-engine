import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  insertAttempt,
  insertVersion,
  upsertContentUnits,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { RegenerateOneSceneInput } from '@/lib/server/teaching-package/regenerate-one-scene';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeOutline, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * A moved lesson part re-plans its slide (owner, 14 Nov 2026) over PGlite,
 * through the real regeneration service, Content Units, flow and planner. Only
 * the model answers and the slide generator are stubbed (the generator's
 * re-plan path is covered by `regenerate-one-scene.test.ts`).
 */

const mocks = vi.hoisted(() => ({
  regenerate: vi.fn(),
  calls: [] as Array<{ stage: string; text: string }>,
  plannerAnswer: '' as string,
}));

vi.mock('@/lib/server/teaching-package/regenerate-one-scene', () => ({
  regenerateOneScene: mocks.regenerate,
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
const STAGE = 'stage-move';
const VERSION = 'tpv-move';
const ATTEMPT = 'tpa-move';
const INSTRUCTION = 'انقل الجزء إلى الشريحة الأخرى وأعد كتابتها REVIEWER-MARK';

const FLOW = [
  {
    stage: 'lesson_opener',
    instructions: 'open the lesson',
    scenePolicy: {
      sceneTypes: ['slide'],
      slideTypes: ['cover'],
      contentRoles: ['orientation'],
      cardinality: 'exactly_one',
    },
  },
  {
    stage: 'explain',
    instructions: 'teach the content',
    scenePolicy: {
      sceneTypes: ['slide'],
      contentRoles: ['explanation', 'example'],
      cardinality: 'one_or_more',
    },
  },
] as TeachingFlowEntry[];

const UNITS = [
  { unitId: 'cu_1', orderIndex: 1, role: 'CONCEPT', title: 'One', normalizedText: 'UNIT-ONE-TEXT' },
  { unitId: 'cu_2', orderIndex: 2, role: 'CONCEPT', title: 'Two', normalizedText: 'UNIT-TWO-TEXT' },
  {
    unitId: 'cu_3',
    orderIndex: 3,
    role: 'CONCEPT',
    title: 'Three',
    normalizedText: 'UNIT-THREE-TEXT',
  },
  {
    unitId: 'cu_4',
    orderIndex: 4,
    role: 'CONCEPT',
    title: 'Four',
    normalizedText: 'UNIT-FOUR-TEXT',
  },
];

function slide(
  id: string,
  order: number,
  units: string[],
  options: { role?: string; stage?: { key: string; flowIndex: number } | null } = {},
): AppScene {
  const base = makeSlideScene(id, STAGE, order, `title ${id}`);
  const stage = options.stage === undefined ? { key: 'explain', flowIndex: 1 } : options.stage;
  return {
    ...base,
    outlineId: `o-${id}`,
    ...(stage ? { teachingStage: stage } : {}),
    sourceContentUnitIds: units,
    content: {
      ...(base.content as Extract<AppScene['content'], { type: 'slide' }>),
      contentRole: options.role ?? 'explanation',
    },
    actions: [],
  } as unknown as AppScene;
}

function plannerJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: 'Re-planned slide',
    keyPoints: ['the first point', 'the second point', 'the third point'],
    description: 'teach the parts the slide now holds',
    slideType: 'content',
    contentRole: 'explanation',
    contentKind: 'concept',
    suggestedImageIds: [],
    ...overrides,
  });
}

describe('a moved lesson part re-plans its slide (owner, 14 Nov 2026)', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://move-replan-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    mocks.regenerate.mockReset();
    mocks.calls = [];
    mocks.plannerAnswer = plannerJson();
    mocks.regenerate.mockImplementation(async (input: RegenerateOneSceneInput) => ({
      ok: true,
      scene: {
        ...input.scene,
        updatedAt: (input.scene.updatedAt ?? 0) + 1,
        ...(input.sourceContentUnitIds
          ? { sourceContentUnitIds: [...input.sourceContentUnitIds] }
          : {}),
      },
    }));
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

  async function seed(scenes: AppScene[]) {
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    }).saveDocument(makeDocument(STAGE, 'Move package', scenes, makeOutline('move')));
    const item = { type: 'lesson' as const, id: 'li-move' };
    const model = { key: 'g5', version: 'g5.v1' };
    await insertVersion(pool as never, {
      id: VERSION,
      aggregate: { tenantId: TENANT, learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      currentAttemptId: ATTEMPT,
      teachingModel: model,
      now: 1,
    });
    await insertAttempt(pool as never, {
      id: ATTEMPT,
      aggregate: { tenantId: TENANT, learningItem: item },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: model,
      inputSnapshot: {
        learningItem: item,
        teachingModel: model,
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
        teachingFlow: FLOW,
      },
      now: 1,
    });
    // Content Units count only on a Kafuo-normalized source.
    await upsertSourceContext(pool as never, {
      tenantId: TENANT,
      attemptId: ATTEMPT,
      contentResourceId: 'cs-1',
      measuredSha256: 'a'.repeat(64),
      text: 'source',
      sourceKind: 'kafuo_normalized',
    });
    await upsertContentUnits(pool as never, { tenantId: TENANT, attemptId: ATTEMPT, units: UNITS });
  }

  const lesson = () => [
    slide('s1', 1, [], { role: 'orientation', stage: { key: 'lesson_opener', flowIndex: 0 } }),
    slide('s2', 2, ['cu_1', 'cu_3']),
    slide('s3', 3, ['cu_2', 'cu_3']),
  ];

  async function move(sceneId: string, change: { op: 'add' | 'remove'; unitId: string }) {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    return regenerateSlideScene(
      { tenantId: TENANT, versionId: VERSION, stageId: STAGE, learnerKey: 'learner-move' },
      sceneId,
      {
        instruction: INSTRUCTION,
        reason: 'the part belongs on the other slide',
        idempotencyKey: `key-${randomUUID()}`,
        contentUnitChange: change,
      },
      {
        pool: pool as never,
        createRoute: (async () => ({
          aiCallFor: (stage: string) => async (system: string, user: string) => {
            mocks.calls.push({ stage, text: `${system}\n${user}` });
            return mocks.plannerAnswer;
          },
          assertAvailable: () => {},
          description: { mode: 'test' },
        })) as never,
      },
    );
  }

  const regenerateInput = () => mocks.regenerate.mock.calls[0]?.[0] as RegenerateOneSceneInput;

  it('a slide that gives up a part is planned from the parts it keeps; the moved-out text reaches no model', async () => {
    await seed(lesson());
    const response = await move('s3', { op: 'remove', unitId: 'cu_3' });
    expect(response.status).toBe(200);
    expect(mocks.calls.map((call) => call.stage)).toEqual(['scene-outlines-stream']);
    expect(mocks.calls[0]!.text).toContain('UNIT-TWO-TEXT');
    expect(mocks.calls[0]!.text).toContain('REVIEWER-MARK');
    // The slide keeps its own Skills, so the planner is never offered any.
    expect(mocks.calls[0]!.text).not.toContain('Teaching Skills this position allows');
    for (const call of mocks.calls) expect(call.text).not.toContain('UNIT-THREE-TEXT');
    const input = regenerateInput();
    expect(input.sourceContentUnitIds).toEqual(['cu_2']);
    expect(input.replannedOutline?.title).toBe('Re-planned slide');
    expect(input.replannedOutline?.sourceContentUnitIds).toEqual(['cu_2']);
    expect(input.instruction).toBe(INSTRUCTION);
    expect(input.instruction).not.toContain('UNIT-THREE-TEXT');
    if (response.status !== 200) return;
    expect(response.body.scene.sourceContentUnitIds).toEqual(['cu_2']);
  });

  it('a slide that takes a part is planned from all its parts, the moved-in one included', async () => {
    await seed(lesson());
    const response = await move('s2', { op: 'add', unitId: 'cu_4' });
    expect(response.status).toBe(200);
    const planner = mocks.calls[0]!.text;
    for (const text of ['UNIT-ONE-TEXT', 'UNIT-THREE-TEXT', 'UNIT-FOUR-TEXT']) {
      expect(planner).toContain(text);
    }
    expect(planner).not.toContain('UNIT-TWO-TEXT');
    expect(regenerateInput().sourceContentUnitIds).toEqual(['cu_1', 'cu_3', 'cu_4']);
    expect(regenerateInput().replannedOutline).toBeDefined();
  });

  it('the slide keeps its own classification: the planner is told it, and its own guess cannot fail the move', async () => {
    await seed(lesson());
    // The first live move (lesson 311) failed on exactly this guess.
    mocks.plannerAnswer = plannerJson({ contentRole: 'activity', contentKind: 'guided_practice' });
    const response = await move('s3', { op: 'remove', unitId: 'cu_3' });
    expect(response.status).toBe(200);
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]!.text).toContain('its classification is fixed');
    expect(mocks.calls[0]!.text).toContain('contentRole "explanation"');
    expect(regenerateInput().replannedOutline?.contentRole).toBe('explanation');
    expect(regenerateInput().replannedOutline?.contentKind).toBeUndefined();
  });

  it('an unusable plan fails the regeneration as a content failure and writes nothing', async () => {
    await seed(lesson());
    mocks.plannerAnswer = 'not json at all';
    await expect(move('s3', { op: 'remove', unitId: 'cu_3' })).rejects.toMatchObject({
      code: 'SCENE_CONTENT_GENERATION_FAILED',
      details: { planCode: 'INSERTION_PLAN_INVALID' },
    });
    expect(mocks.regenerate).not.toHaveBeenCalled();
    const rows = (
      await pool.query('SELECT status, error_code FROM teaching_package_scene_regenerations')
    ).rows as Array<{ status: string; error_code: string }>;
    expect(rows).toEqual([{ status: 'failed', error_code: 'SCENE_CONTENT_GENERATION_FAILED' }]);
  });

  it('a slide with no flow position keeps the directive-only rewrite, with no planner call', async () => {
    await seed([
      slide('s1', 1, [], { role: 'orientation', stage: { key: 'lesson_opener', flowIndex: 0 } }),
      slide('s2', 2, ['cu_1', 'cu_3']),
      slide('s3', 3, ['cu_2', 'cu_3'], { stage: null }),
    ]);
    const response = await move('s3', { op: 'remove', unitId: 'cu_3' });
    expect(response.status).toBe(200);
    expect(mocks.calls).toEqual([]);
    const input = regenerateInput();
    expect(input.replannedOutline).toBeUndefined();
    expect(input.sourceContentUnitIds).toEqual(['cu_2']);
    expect(input.instruction).toContain('LESSON PART MOVED OUT');
  });
});
