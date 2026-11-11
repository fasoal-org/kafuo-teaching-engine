import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { RegenerateOneSceneInput } from '@/lib/server/teaching-package/regenerate-one-scene';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppDocumentOutline, AppStage } from '@/lib/document-store/persistence-types';
import { makeDocument, makeOutline, makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * Reviewer-driven single-slide regeneration over PGlite, through the real
 * routes, store, fences and schema (single-slide-regeneration-plan AT-A,
 * AT-T, AT-F, AT-D, AT-AU, AT-P1, AT-RS). Only the model run is stubbed: the
 * generator itself is covered by `regenerate-one-scene.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  regenerate: vi.fn(),
  createRoute: vi.fn(),
  duringGeneration: null as null | (() => Promise<void>),
  warn: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/regenerate-one-scene', () => ({
  regenerateOneScene: mocks.regenerate,
}));
vi.mock('@/lib/server/teaching-package/routed-regeneration-call', () => ({
  createRegenerationRoute: mocks.createRoute,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
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

const STAGE = 'stage-regen-x';
const OTHER = 'stage-regen-y';
const INSTRUCTION = 'اجعل الشرح أبسط وأضف مثالاً من الحياة اليومية';
const REASON = 'the slide had a wrong formula REASON-MARK';

function cookieFor(
  stageId: string,
  capability: 'read' | 'write',
  options: { purpose?: 'edit' | 'preview' | 'learner'; now?: number; versionId?: string } = {},
): { cookie: string; learnerKey: string } {
  const { token, payload } = buildEditorGrantPayload({
    tenantId: 'tenant-test',
    versionId: options.versionId ?? `tpv-${stageId}`,
    stageId,
    capability,
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return {
    cookie: `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, stageId),
    )}`,
    learnerKey: payload.learnerKey,
  };
}

/** Neither a slide nor a quiz: still not regenerable (3 Oct 2026 added quiz). */
function interactiveScene(id: string, stageId: string, order: number): AppScene {
  return {
    ...makeSlideScene(id, stageId, order, 'Interactive'),
    type: 'interactive',
    content: { type: 'interactive', html: '<div></div>' },
  } as unknown as AppScene;
}

function quizScene(id: string, stageId: string, order: number): AppScene {
  return {
    ...makeSlideScene(id, stageId, order, 'Quiz'),
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
  } as unknown as AppScene;
}

/** The deterministic "generated" slide: the pre-image with one new text element. */
function generatedFrom(pre: AppScene, label = 'regenerated'): AppScene {
  if (pre.content.type !== 'slide') throw new Error('slide only');
  return {
    ...pre,
    updatedAt: (pre.updatedAt ?? 0) + 1,
    content: {
      ...pre.content,
      canvas: {
        ...pre.content.canvas,
        elements: [
          ...pre.content.canvas.elements,
          {
            id: `text-${label}`,
            type: 'text',
            content: `<p>${label}</p>`,
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
    },
  } as unknown as AppScene;
}

describe('slide regeneration routes', () => {
  let pool: PGlitePool;
  let writeCookie: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://regen-route-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'regen-route-key');
    mocks.regenerate.mockReset();
    mocks.createRoute.mockReset();
    mocks.duringGeneration = null;
    mocks.createRoute.mockResolvedValue({
      aiCallFor: () => async () => '',
      assertAvailable: () => {},
      description: { mode: 'test' },
    });
    mocks.regenerate.mockImplementation(async (input: RegenerateOneSceneInput) => {
      await mocks.duringGeneration?.();
      return { ok: true, scene: generatedFrom(input.scene) };
    });

    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);

    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(STAGE, 'Draft package', [
        makeSlideScene('scene-1', STAGE, 1),
        makeSlideScene('scene-2', STAGE, 2),
        quizScene('scene-q', STAGE, 3),
        interactiveScene('scene-i', STAGE, 4),
        { ...quizScene('scene-b', STAGE, 5), questionSource: 'bank' } as AppScene,
      ]),
    );
    await store.saveDocument(
      makeDocument(OTHER, 'Approved package', [makeSlideScene('scene-1', OTHER, 1)]),
    );
    for (const [stageId, status] of [
      [STAGE, 'draft'],
      [OTHER, 'approved'],
    ] as const) {
      await insertVersion(pool as never, {
        id: `tpv-${stageId}`,
        aggregate: {
          tenantId: 'tenant-test',
          learningItem: { type: 'lesson', id: `li-${stageId}` },
        },
        version: 1,
        status,
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
    }
    writeCookie = cookieFor(STAGE, 'write').cookie;
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function post(
    sceneId: string,
    body: Record<string, unknown>,
    cookie = writeCookie,
    stageId = STAGE,
  ): Promise<Response> {
    const { POST } = await import('@/app/api/stages/[id]/scenes/[sceneId]/regenerate/route');
    return POST(
      new NextRequest(`http://localhost/api/stages/${stageId}/scenes/${sceneId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: stageId, sceneId }) },
    );
  }

  const body = (key = `key-${randomUUID()}`, overrides: Record<string, unknown> = {}) => ({
    instruction: INSTRUCTION,
    reason: REASON,
    idempotencyKey: key,
    ...overrides,
  });

  async function rows() {
    return (
      await pool.query('SELECT * FROM teaching_package_scene_regenerations ORDER BY requested_at')
    ).rows as Array<Record<string, unknown>>;
  }

  async function events(eventPrefix = 'scene_regeneration') {
    return (
      await pool.query(
        `SELECT event_type, reason, data, actor_ref, from_status, to_status
           FROM teaching_package_review_events
          WHERE event_type LIKE $1 ORDER BY id`,
        [`${eventPrefix}%`],
      )
    ).rows as Array<{
      event_type: string;
      reason: string | null;
      data: Record<string, unknown>;
      actor_ref: string;
      from_status: string;
      to_status: string;
    }>;
  }

  async function sceneState(sceneId = 'scene-1', stageId = STAGE) {
    const result = await pool.query(
      `SELECT s.data, sr.rev FROM document_scenes s
         LEFT JOIN document_scene_revision sr ON sr.stage_id = s.stage_id AND sr.scene_id = s.id
        WHERE s.stage_id = $1 AND s.id = $2`,
      [stageId, sceneId],
    );
    const row = result.rows[0] as { data: AppScene; rev: number | string } | undefined;
    return row ? { scene: row.data, rev: Number(row.rev) } : null;
  }

  function editorStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  // ------------------------------------------------------------------ AT-A

  it('AI reviewer (plan §4.4): a system actor is recorded on the row and the audit events, with no session', async () => {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    const grant = {
      tenantId: 'tenant-test',
      versionId: `tpv-${STAGE}`,
      stageId: STAGE,
      learnerKey: 'system:package-reviewer',
    };
    const response = await regenerateSlideScene(grant, 'scene-1', body('key-reviewer-1'), {
      pool: pool as never,
      actor: { actorRef: 'system:package-reviewer', sessionRef: null },
    });
    expect(response.status).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({
      status: 'succeeded',
      actor_ref: 'system:package-reviewer',
      session_ref: null,
    });
    const audit = await events();
    expect(audit.map((event) => event.actor_ref)).toEqual(
      audit.map(() => 'system:package-reviewer'),
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  const reviewerGrant = {
    tenantId: 'tenant-test',
    versionId: `tpv-${STAGE}`,
    stageId: STAGE,
    learnerKey: 'system:package-reviewer',
  };
  const reviewerActor = { actorRef: 'system:package-reviewer', sessionRef: null };

  it('MEDIUM-1 (D-13): the signal reaches the model route, and an abort AFTER the paid model calls still commits the slide', async () => {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    const before = await sceneState('scene-1');
    const controller = new AbortController();
    // The review run is evicted once the (paid) slide is written by the model.
    mocks.duringGeneration = async () => controller.abort();
    const response = await regenerateSlideScene(
      reviewerGrant,
      'scene-1',
      body('key-reviewer-late-abort'),
      { pool: pool as never, actor: reviewerActor, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(mocks.createRoute.mock.calls[0]![0]).toMatchObject({ signal: controller.signal });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'succeeded' });
    expect((await sceneState('scene-1'))!.rev).toBe(before!.rev + 1);
  });

  it('LOW-3: an already-aborted reviewer run starts no regeneration — no row, no burnt key', async () => {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    const controller = new AbortController();
    controller.abort();
    await expect(
      regenerateSlideScene(reviewerGrant, 'scene-1', body('key-reviewer-pre-abort'), {
        pool: pool as never,
        actor: reviewerActor,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await rows()).toEqual([]);
    expect(mocks.regenerate).not.toHaveBeenCalled();
    // The same key is still free for the run that resumes the review.
    const response = await regenerateSlideScene(
      reviewerGrant,
      'scene-1',
      body('key-reviewer-pre-abort'),
      { pool: pool as never, actor: reviewerActor },
    );
    expect(response.status).toBe(200);
  });

  it('MEDIUM (default leases): a resume after the evicted run’s regeneration outlived its lease fixes the slide under K-r; a later resume replays K-r for free', async () => {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    const {
      createPackageReviewFixLoop,
      fixIdempotencyKey,
      fixInstruction,
      fixRetryIdempotencyKey,
      PACKAGE_REVIEWER_ACTOR,
    } = await import('@/lib/server/teaching-package/package-review-fix-loop');
    const { reviewSlidesOf } = await import('@/lib/server/teaching-package/package-review-input');
    const review = {
      id: 'tpr-resume',
      tenantId: 'tenant-test',
      learningItem: { type: 'lesson', id: `li-${STAGE}` },
      versionId: `tpv-${STAGE}`,
      attemptId: 'tpa-x',
      stageId: STAGE,
      subjectCode: 'MATH',
      status: 'running',
      provider: 'anthropic',
      model: 'anthropic:claude-opus-5-5',
      summary: 's',
      findings: [],
      fixes: [],
      errorCode: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      bookTruncated: false,
      runAttempts: 2,
      leaseOwner: 'w',
      leaseUntil: 1,
      reviewedAt: 1,
      createdAt: 1,
      startedAt: 1,
      completedAt: null,
    } as never;
    const findings = () => [
      {
        id: 'f1',
        targetId: 'scene-1',
        targetTitle: '',
        targetOrder: 1,
        check: 'S1' as const,
        severity: 'high' as const,
        bookEvidence: { quote: 'q', unitId: null },
        whatIsWrong: 'خطأ',
        fixNote: 'صحح الشريحة',
        status: 'open' as const,
        teacherReason: null,
      },
    ];
    const grant = {
      tenantId: 'tenant-test',
      versionId: `tpv-${STAGE}`,
      stageId: STAGE,
      learnerKey: PACKAGE_REVIEWER_ACTOR,
    };
    const K = fixIdempotencyKey('tpr-resume', 'scene-1');
    const Kr = fixRetryIdempotencyKey('tpr-resume', 'scene-1');
    // The resumed review: the real fix loop over the real regeneration service.
    const resume = async () => {
      const live = (await sceneState('scene-1'))!;
      const loop = createPackageReviewFixLoop({
        regenerateAudio: vi.fn(async (_grant: unknown, sceneId: string) => ({
          sceneId,
          scene: (await sceneState(sceneId))!.scene,
          rev: 0,
          generated: 1,
          missing: 0,
        })) as never,
      });
      return loop({
        pool: pool as never,
        review,
        units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
        slides: reviewSlidesOf([live.scene]),
        scenes: [live.scene],
        findings: findings(),
        heartbeat: async () => true,
        callReviewer: vi.fn(async () => ({
          answer: { summary: 's', findings: [] },
          call: { provider: 'anthropic', modelString: 'anthropic:claude-opus-5-5', usage: null },
        })) as never,
        recordProgress: vi.fn(async () => {}),
        now: Date.now,
      });
    };
    const before = (await sceneState('scene-1'))!;
    const controller = new AbortController();
    let resumed: Awaited<ReturnType<typeof resume>> | null = null;
    // The evicted run's regeneration under K: its model call outlives the
    // regeneration lease; the review is evicted (abort) and resumed meanwhile.
    mocks.regenerate.mockImplementationOnce(async (input: RegenerateOneSceneInput) => {
      controller.abort();
      resumed = await resume();
      return { ok: true, scene: generatedFrom(input.scene, 'stale') };
    });
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    await expect(
      regenerateSlideScene(
        grant,
        'scene-1',
        {
          instruction: fixInstruction(findings()),
          reason: `مراجعة الذكاء الاصطناعي tpr-resume: S1`,
          idempotencyKey: K,
        },
        {
          pool: pool as never,
          actor: { actorRef: PACKAGE_REVIEWER_ACTOR, sessionRef: null },
          signal: controller.signal,
          now: () => tenMinutesAgo,
          leaseSeconds: 60, // its lease ran out nine minutes ago
        },
      ),
    ).rejects.toMatchObject({ code: 'REGENERATION_LEASE_LOST' });
    // The resume found K reclaimed (LEASE_EXPIRED) and fixed the slide under K-r, once.
    expect(resumed!.findings[0]).toMatchObject({ status: 'fixed', teacherReason: null });
    expect(resumed!.fixes[0]).toMatchObject({ outcome: 'fixed' });
    const fixed = (await sceneState('scene-1'))!;
    expect(fixed.rev).toBe(before.rev + 1);
    expect((await rows()).map((row) => [row.idempotency_key, row.status, row.error_code])).toEqual([
      [K, 'failed', 'LEASE_EXPIRED'],
      [Kr, 'succeeded', null],
    ]);
    // A later resume replays K (refused) then K-r (succeeded): no model call, no new commit.
    const modelRuns = mocks.regenerate.mock.calls.length;
    const again = await resume();
    expect(mocks.regenerate.mock.calls.length).toBe(modelRuns);
    expect(again.findings[0]).toMatchObject({ status: 'fixed' });
    expect((await sceneState('scene-1'))!.rev).toBe(fixed.rev);
    expect(await rows()).toHaveLength(2);
  });

  it('LOW-1 / MEDIUM-1: a mid-call abort is stored as ABORTED and replays as ABORTED; the derived key regenerates once', async () => {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    const { fixIdempotencyKey, fixRetryIdempotencyKey } =
      await import('@/lib/server/teaching-package/package-review-fix-loop');
    const key = fixIdempotencyKey('tpr-abort', 'scene-1');
    // The evicted run's model call was aborted mid-call (the route raises ABORTED).
    mocks.regenerate.mockImplementationOnce(async () => {
      throw new TeachingPackageError('ABORTED', 'the regeneration was stopped');
    });
    await expect(
      regenerateSlideScene(reviewerGrant, 'scene-1', body(key), {
        pool: pool as never,
        actor: reviewerActor,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect((await rows())[0]).toMatchObject({ status: 'failed', error_code: 'ABORTED' });
    // The resumed run's replay of the same key reports ABORTED (not a persistence failure).
    await expect(
      regenerateSlideScene(reviewerGrant, 'scene-1', body(key), {
        pool: pool as never,
        actor: reviewerActor,
      }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
      details: { replayed: true, failureCode: 'ABORTED' },
    });
    // The derived key regenerates the slide once (nothing was committed before).
    const before = await sceneState('scene-1');
    const retried = await regenerateSlideScene(
      reviewerGrant,
      'scene-1',
      body(fixRetryIdempotencyKey('tpr-abort', 'scene-1')),
      { pool: pool as never, actor: reviewerActor },
    );
    expect(retried.status).toBe(200);
    expect((await sceneState('scene-1'))!.rev).toBe(before!.rev + 1);
  });

  it('LOW-1: without a signal (the editor) the route gets none and the regeneration runs as before', async () => {
    const { regenerateSlideScene } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    const grant = {
      tenantId: 'tenant-test',
      versionId: `tpv-${STAGE}`,
      stageId: STAGE,
      learnerKey: 'system:package-reviewer',
    };
    const response = await regenerateSlideScene(grant, 'scene-1', body('key-editor-plain'), {
      pool: pool as never,
    });
    expect(response.status).toBe(200);
    expect(mocks.createRoute.mock.calls[0]![0]).not.toHaveProperty('signal');
  });

  it('AT-A: a write grant on a draft regenerates exactly the one slide, atomically with its audit', async () => {
    const before1 = await sceneState('scene-1');
    const before2 = await sceneState('scene-2');
    const response = await post('scene-1', body('key-success-1'));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      regenerationId: string;
      scene: AppScene;
      resultSceneRev: number;
      current: { rev: number; scene: AppScene };
      replayed: boolean;
    };
    expect(result.replayed).toBe(false);
    expect(result.resultSceneRev).toBe(before1!.rev + 1);
    expect(result.current.rev).toBe(result.resultSceneRev);
    const after1 = await sceneState('scene-1');
    expect(after1!.rev).toBe(result.resultSceneRev);
    expect(after1!.scene).toEqual(result.scene);
    expect(JSON.stringify(after1!.scene)).toContain('text-regenerated');
    // Every other Scene is untouched, revision included.
    expect(await sceneState('scene-2')).toEqual(before2);

    const [row] = await rows();
    expect(row).toMatchObject({
      status: 'succeeded',
      instruction: INSTRUCTION,
      reason: REASON,
      actor_ref: `teaching-package-editor:${STAGE}`,
    });
    expect(Number(row!.base_scene_rev)).toBe(before1!.rev);
    expect(Number(row!.result_scene_rev)).toBe(result.resultSceneRev);
    expect(String(row!.session_ref)).toMatch(/^tps:[A-Za-z0-9_-]{22}$/);

    const audit = await events();
    expect(audit.map((event) => event.event_type)).toEqual([
      'scene_regeneration_started',
      'scene_regeneration_completed',
    ]);
    // AT-AU: instruction and reason are separate fields.
    expect(audit[0]!.reason).toBe(REASON);
    expect(audit[0]!.data).toMatchObject({ instruction: INSTRUCTION, sceneId: 'scene-1' });
    expect(JSON.stringify(audit[0]!.data)).not.toContain('REASON-MARK');
    expect(audit[1]!.data).toMatchObject({ resultSceneRev: result.resultSceneRev });
    expect(
      audit.every((event) => event.from_status === 'draft' && event.to_status === 'draft'),
    ).toBe(true);

    // The reason never reaches the generator.
    expect(JSON.stringify(mocks.regenerate.mock.calls[0]![0])).not.toContain('REASON-MARK');
    expect(mocks.regenerate.mock.calls[0]![0].instruction).toBe(INSTRUCTION);
  });

  it('F-7: a g5.v8 version with no attempt keeps the exercise rule on (outline ids, else role scope) and warns with ids only', async () => {
    const V8 = 'stage-regen-v8';
    const outline = {
      ...makeOutline('v8 package'),
      outlines: [
        { id: 'o-ex', contentRole: 'practice', sourceContentUnitIds: ['u-ex'] },
        { id: 'o-exp', contentRole: 'explanation', sourceContentUnitIds: ['u-explain'] },
      ],
    } as unknown as AppDocumentOutline;
    for (const [stageId, docOutline] of [
      [V8, outline],
      [`${V8}-bare`, makeOutline('v8 bare')],
    ] as const) {
      await editorStore().saveDocument(
        makeDocument(stageId, 'v8 package', [makeSlideScene('scene-1', stageId, 1)], docOutline),
      );
      await insertVersion(pool as never, {
        id: `tpv-${stageId}`,
        aggregate: {
          tenantId: 'tenant-test',
          learningItem: { type: 'lesson', id: `li-${stageId}` },
        },
        version: 1,
        status: 'draft',
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v8' },
        now: 1,
      });
    }
    mocks.warn.mockClear();
    const withOutline = await post('scene-1', body(), cookieFor(V8, 'write').cookie, V8);
    expect(withOutline.status).toBe(200);
    expect(mocks.regenerate.mock.calls[0]![0].sacredExerciseUnitIds).toEqual(['u-ex']);
    const bare = `${V8}-bare`;
    expect((await post('scene-1', body(), cookieFor(bare, 'write').cookie, bare)).status).toBe(200);
    // No unit ids anywhere: the role/stage scope (an empty id list), never off.
    expect(mocks.regenerate.mock.calls[1]![0].sacredExerciseUnitIds).toEqual([]);
    const warnings = mocks.warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.filter((line) => line.startsWith('SACRED_EXERCISE_SCOPE_FALLBACK'))).toEqual([
      expect.stringContaining(`version=tpv-${V8} attempt=none scope=outline`),
      expect.stringContaining(`version=tpv-${bare} attempt=none scope=role`),
    ]);
    // A g5.v1 version stays off and silent.
    mocks.warn.mockClear();
    expect((await post('scene-1', body())).status).toBe(200);
    expect(mocks.regenerate.mock.calls[2]![0].sacredExerciseUnitIds).toBeUndefined();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('AT-AU: no grant, cookie, raw learner key or tp: value is stored', async () => {
    const { cookie, learnerKey } = cookieFor(STAGE, 'write');
    expect((await post('scene-1', body(), cookie)).status).toBe(200);
    const stored = JSON.stringify({ rows: await rows(), events: await events() });
    expect(stored).not.toContain(learnerKey);
    expect(stored).not.toContain('teaching_package_grant');
    expect(stored).not.toMatch(/"tp:/);
    expect(stored).not.toContain(decodeURIComponent(cookie.split('=')[1]!).slice(0, 40));
  });

  it('AT-A: read, learner and preview grants → 403 READ_ONLY_GRANT; nothing written, no model run', async () => {
    for (const cookie of [
      cookieFor(STAGE, 'read').cookie,
      cookieFor(STAGE, 'read', { purpose: 'learner' }).cookie,
      cookieFor(STAGE, 'write', { purpose: 'preview' }).cookie,
    ]) {
      const response = await post('scene-1', body(), cookie);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'READ_ONLY_GRANT' } });
    }
    expect(await rows()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('AT-A: another Stage’s grant, an expired grant and a forged cookie → plain 404', async () => {
    const otherStage = cookieFor(OTHER, 'write').cookie;
    const expired = cookieFor(STAGE, 'write', { now: Date.now() - 30 * 24 * 3600 * 1000 }).cookie;
    const forged = `teaching_package_grant=${encodeURIComponent(JSON.stringify(['forged.token']))}`;
    for (const cookie of [otherStage, expired, forged, '']) {
      const response = await post('scene-1', body(), cookie);
      expect(response.status).toBe(404);
    }
    // A grant whose version no longer names this Stage.
    const stale = cookieFor(STAGE, 'write', { versionId: `tpv-${OTHER}` }).cookie;
    expect((await post('scene-1', body(), stale)).status).toBe(404);
    expect(await rows()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('AT-A: an approved version → 423 STAGE_LOCKED with one refused event and no row', async () => {
    const response = await post(
      'scene-1',
      body('key-locked'),
      cookieFor(OTHER, 'write').cookie,
      OTHER,
    );
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'STAGE_LOCKED' } });
    expect(await rows()).toHaveLength(0);
    const audit = await events();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event_type: 'scene_regeneration_refused',
      reason: REASON,
      from_status: 'approved',
      data: { refusalCode: 'STAGE_LOCKED', sceneId: 'scene-1', idempotencyKey: 'key-locked' },
    });
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('AT-A: an unknown scene → 404 SCENE_NOT_FOUND; an interactive scene → 422 SCENE_TYPE_NOT_REGENERABLE', async () => {
    const missing = await post('scene-nope', body());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'SCENE_NOT_FOUND' } });
    const interactive = await post('scene-i', body());
    expect(interactive.status).toBe(422);
    await expect(interactive.json()).resolves.toMatchObject({
      error: { code: 'SCENE_TYPE_NOT_REGENERABLE' },
    });
    expect(await rows()).toHaveLength(0);
    expect((await events()).map((event) => event.event_type)).toEqual([
      'scene_regeneration_refused',
    ]);
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('W6: a bank quiz scene → 422 BANK_QUIZ_NOT_REGENERABLE; nothing generated', async () => {
    const bank = await post('scene-b', body());
    expect(bank.status).toBe(422);
    await expect(bank.json()).resolves.toMatchObject({
      error: { code: 'BANK_QUIZ_NOT_REGENERABLE' },
    });
    expect(await rows()).toHaveLength(0);
    expect((await events()).map((event) => event.event_type)).toEqual([
      'scene_regeneration_refused',
    ]);
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('a malformed body → 400 INVALID_REQUEST {field, rule, limit}; nothing written', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [body(undefined, { instruction: '' }), { field: 'instruction', rule: 'required' }],
      [body(undefined, { instruction: 'short' }), { field: 'instruction', rule: 'min', limit: 10 }],
      [
        body(undefined, { instruction: 'x'.repeat(2001) }),
        { field: 'instruction', rule: 'max', limit: 2000 },
      ],
      [body(undefined, { reason: '   ' }), { field: 'reason', rule: 'required' }],
      [body(undefined, { reason: 'abc' }), { field: 'reason', rule: 'min', limit: 5 }],
      [body('bad key!'), { field: 'idempotencyKey', rule: 'format' }],
    ];
    for (const [request, details] of cases) {
      const response = await post('scene-1', request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_REQUEST', details },
      });
    }
    expect(await rows()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  // ------------------------------------------------------------------ AT-D

  it('AT-D: the same key and body twice → one model run; a replay after a later edit returns the original result', async () => {
    const first = (await (await post('scene-1', body('key-replay'))).json()) as {
      scene: AppScene;
      resultSceneRev: number;
      regenerationId: string;
    };
    // A later editor change to the slide.
    const current = await sceneState('scene-1');
    await editorStore().putScene(STAGE, { ...current!.scene, title: 'edited later' });
    const replay = await post('scene-1', body('key-replay'));
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as {
      replayed: boolean;
      scene: AppScene;
      resultSceneRev: number;
      regenerationId: string;
      current: { rev: number; scene: AppScene };
    };
    expect(replayed).toMatchObject({ replayed: true, regenerationId: first.regenerationId });
    expect(replayed.scene).toEqual(first.scene);
    expect(replayed.resultSceneRev).toBe(first.resultSceneRev);
    expect(replayed.current.scene.title).toBe('edited later');
    expect(replayed.current.rev).toBeGreaterThan(first.resultSceneRev);
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
  });

  it('AT-D: the same key with another body → 409 IDEMPOTENCY_CONFLICT and no run', async () => {
    await post('scene-1', body('key-conflict'));
    const conflict = await post(
      'scene-1',
      body('key-conflict', { instruction: `${INSTRUCTION} مرة ثانية` }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
  });

  it('AT-D: a failed regeneration replays its code without running again; X is unchanged', async () => {
    mocks.regenerate.mockResolvedValue({
      ok: false,
      code: 'ORIENTATION_VISUAL_MISSING',
      message: 'the planned textbook visual is absent',
    });
    const before = await sceneState('scene-1');
    const failed = await post('scene-1', body('key-failed'));
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: 'ORIENTATION_VISUAL_MISSING' },
    });
    const replay = await post('scene-1', body('key-failed'));
    expect(replay.status).toBe(422);
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: 'ORIENTATION_VISUAL_MISSING', details: { replayed: true } },
    });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
    expect(await sceneState('scene-1')).toEqual(before);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', error_code: 'ORIENTATION_VISUAL_MISSING' });
    expect((await events()).map((event) => event.event_type)).toEqual([
      'scene_regeneration_started',
      'scene_regeneration_failed',
    ]);
    expect((await events())[1]).toMatchObject({
      reason: REASON,
      data: { failureCode: 'ORIENTATION_VISUAL_MISSING' },
    });
  });

  // ------------------------------------------------------------------ AT-T

  it('AT-T: an editor write to X between T1 and T2 → 409 SCENE_CHANGED_DURING_REGENERATION; the DB keeps the editor’s X', async () => {
    mocks.duringGeneration = async () => {
      const current = await sceneState('scene-1');
      await editorStore().putScene(STAGE, { ...current!.scene, title: 'editor wins' });
    };
    const response = await post('scene-1', body('key-race'));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SCENE_CHANGED_DURING_REGENERATION' },
    });
    const after = await sceneState('scene-1');
    expect(after!.scene.title).toBe('editor wins');
    expect(JSON.stringify(after!.scene)).not.toContain('text-regenerated');
    const [row] = await rows();
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SCENE_CHANGED_DURING_REGENERATION',
    });
    expect(JSON.stringify(row!.candidate_scene)).toContain('text-regenerated');
  });

  it('AT-T: the version moved to in_review during generation → 423; nothing written', async () => {
    mocks.duringGeneration = async () => {
      await pool.query(`UPDATE teaching_package_versions SET status = 'in_review' WHERE id = $1`, [
        `tpv-${STAGE}`,
      ]);
    };
    const before = await sceneState('scene-1');
    const response = await post('scene-1', body('key-review'));
    expect(response.status).toBe(423);
    expect(await sceneState('scene-1')).toEqual(before);
    expect((await rows())[0]).toMatchObject({ status: 'failed', error_code: 'STAGE_LOCKED' });
  });

  it('AT-T: a late worker after a reclaim, rev unchanged → 409 REGENERATION_LEASE_LOST; no write', async () => {
    mocks.duringGeneration = async () => {
      // A reclaim (lease expiry) happened while the model ran.
      await pool.query(
        `UPDATE teaching_package_scene_regenerations
            SET status = 'failed', error_code = 'LEASE_EXPIRED', completed_at = 1`,
      );
    };
    const before = await sceneState('scene-1');
    const response = await post('scene-1', body('key-late'));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REGENERATION_LEASE_LOST' },
    });
    expect(await sceneState('scene-1')).toEqual(before);
  });

  it('AT-T: a second POST while one is running → 409 SCENE_REGENERATION_IN_PROGRESS (+ refused event)', async () => {
    let second: Response | undefined;
    mocks.duringGeneration = async () => {
      if (second) return;
      mocks.duringGeneration = null;
      second = await post('scene-1', body('key-second'));
    };
    const first = await post('scene-1', body('key-first'));
    expect(first.status).toBe(200);
    expect(second!.status).toBe(409);
    await expect(second!.json()).resolves.toMatchObject({
      error: { code: 'SCENE_REGENERATION_IN_PROGRESS' },
    });
    expect((await rows()).map((row) => row.status)).toEqual(['succeeded']);
    expect((await events()).map((event) => event.event_type)).toEqual([
      'scene_regeneration_started',
      'scene_regeneration_refused',
      'scene_regeneration_completed',
    ]);
  });

  // ------------------------------------------------------------------ AT-F / AT-P1

  it('AT-F / AT-P1 #5: a throw after the upsert (completed event) rolls back scene, rev, row and events', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_block_completed() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'scene_regeneration_completed' THEN
          RAISE EXCEPTION 'injected failure after the upsert';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER test_block_completed BEFORE INSERT ON teaching_package_review_events
      FOR EACH ROW EXECUTE FUNCTION test_block_completed()`);
    const before = await sceneState('scene-1');
    const response = await post('scene-1', body('key-inject'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'REGENERATION_PERSISTENCE_FAILED' },
    });
    expect(await sceneState('scene-1')).toEqual(before);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', error_code: 'REGENERATION_PERSISTENCE_FAILED' });
    expect(row!.candidate_scene).not.toBeNull();
    expect((await events()).map((event) => event.event_type)).toEqual([
      'scene_regeneration_started',
      'scene_regeneration_failed',
    ]);
  });

  it('AT-F: when T3 also fails the row stays running; the status read reclaims it as LEASE_EXPIRED', async () => {
    let now = 1_900_000_000_000;
    const { regenerateSlideScene, readSceneRegenerationForGrant } =
      await import('@/lib/server/teaching-package/scene-regeneration');
    // T2 conflict (editor write) + T3 failure (the row table is unwritable for T3).
    mocks.duringGeneration = async () => {
      const current = await sceneState('scene-1');
      await editorStore().putScene(STAGE, { ...current!.scene, title: 'x' });
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_block_fail() RETURNS trigger AS $$
        BEGIN
          IF NEW.status = 'failed' AND NEW.error_code <> 'LEASE_EXPIRED' THEN
            RAISE EXCEPTION 'injected T3 failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await pool.query(`
        CREATE TRIGGER test_block_fail BEFORE UPDATE ON teaching_package_scene_regenerations
        FOR EACH ROW EXECUTE FUNCTION test_block_fail()`);
    };
    const grant = {
      tenantId: 'tenant-test',
      versionId: `tpv-${STAGE}`,
      stageId: STAGE,
      learnerKey: 'tp:k',
    };
    await expect(
      regenerateSlideScene(grant, 'scene-1', body('key-t3'), {
        pool: pool as never,
        now: () => now,
      } as never),
    ).rejects.toMatchObject({ code: 'SCENE_CHANGED_DURING_REGENERATION' });
    const [running] = await rows();
    expect(running).toMatchObject({ status: 'running' });
    now += 901 * 1000;
    const status = await readSceneRegenerationForGrant(
      pool as never,
      grant,
      { idempotencyKey: 'key-t3' },
      now,
    );
    expect(status).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED' });
  });

  it('AT-P1 #1/#4/#8: one completion per success across both transactions; lineage kept; bytes equal a plain putScene', async () => {
    const { commitSceneRegeneration, startSceneRegeneration } =
      await import('@/lib/server/teaching-package/scene-regeneration-store');
    // Give scene-2 governed lineage the incoming copy omits.
    const stored = (await sceneState('scene-2'))!.scene;
    const lineage = { classification: 'non-instructional' } as never;
    await editorStore().putScene(STAGE, { ...stored, teachingSkills: lineage });
    const started = await startSceneRegeneration(pool as never, {
      tenantId: 'tenant-test',
      versionId: `tpv-${STAGE}`,
      stageId: STAGE,
      sceneId: 'scene-2',
      idempotencyKey: 'key-proof',
      requestDigest: 'd',
      instruction: INSTRUCTION,
      reason: REASON,
      actorRef: `teaching-package-editor:${STAGE}`,
      sessionRef: null,
    });
    if (started.kind !== 'started') throw new Error(started.kind);
    const row = started.regeneration;
    const { teachingSkills: _omitted, ...incoming } = generatedFrom(
      row.previousScene,
    ) as AppScene & {
      teachingSkills?: unknown;
    };
    const committed = await commitSceneRegeneration(
      pool as never,
      {
        regenerationId: row.id,
        attemptToken: row.attemptToken,
        tenantId: 'tenant-test',
        versionId: `tpv-${STAGE}`,
        stageId: STAGE,
        sceneId: 'scene-2',
        baseSceneRev: row.baseSceneRev,
        actorRef: row.actorRef,
        reason: REASON,
      },
      incoming as AppScene,
    );
    expect(committed.state.completions).toBe(1);
    const after = (await sceneState('scene-2'))!;
    expect(after.scene.teachingSkills).toEqual(lineage);
    expect(committed.resultScene).toEqual(after.scene);
    // #8: the same Scene written by the existing store path yields the same row.
    await editorStore().putScene(STAGE, incoming as AppScene);
    expect((await sceneState('scene-2'))!.scene).toEqual(after.scene);
  });

  it('AT-P1 #2: an invalid scene is refused before the write; the row stays running and X is unchanged', async () => {
    mocks.regenerate.mockImplementation(async (input: RegenerateOneSceneInput) => ({
      ok: true,
      scene: { ...input.scene, order: 'not-a-number' },
    }));
    const before = await sceneState('scene-1');
    const response = await post('scene-1', body('key-invalid'));
    expect(response.status).toBe(503);
    expect(await sceneState('scene-1')).toEqual(before);
    expect((await rows())[0]).toMatchObject({ status: 'failed' });
  });

  it('AT-P1 #6: an owner mismatch on stage_meta writes nothing', async () => {
    mocks.duringGeneration = async () => {
      await pool.query(`UPDATE stage_meta SET owner_id = 'anon:someone' WHERE stage_id = $1`, [
        STAGE,
      ]);
    };
    const before = await sceneState('scene-1');
    const response = await post('scene-1', body('key-owner'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await sceneState('scene-1')).toEqual(before);
  });

  // ------------------------------------------------------------------ reads

  it('status GET by id and by key needs a write grant; another Stage’s id is a 404', async () => {
    const result = (await (await post('scene-1', body('key-status'))).json()) as {
      regenerationId: string;
    };
    const { GET } =
      await import('@/app/api/stages/[id]/scene-regenerations/[regenerationId]/route');
    const call = (cookie: string, stageId = STAGE) =>
      GET(
        new NextRequest(
          `http://localhost/api/stages/${stageId}/scene-regenerations/${result.regenerationId}`,
          {
            headers: { cookie },
          },
        ),
        { params: Promise.resolve({ id: stageId, regenerationId: result.regenerationId }) },
      );
    const ok = await call(writeCookie);
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ status: 'succeeded', sceneId: 'scene-1' });
    expect((await call(cookieFor(STAGE, 'read').cookie)).status).toBe(403);
    expect((await call(cookieFor(OTHER, 'write').cookie, OTHER)).status).toBe(404);

    const byKey = await import('@/app/api/stages/[id]/scenes/[sceneId]/regenerate/route');
    const keyed = await byKey.GET(
      new NextRequest(
        `http://localhost/api/stages/${STAGE}/scenes/scene-1/regenerate?key=key-status`,
        {
          headers: { cookie: writeCookie },
        },
      ),
      { params: Promise.resolve({ id: STAGE, sceneId: 'scene-1' }) },
    );
    await expect(keyed.json()).resolves.toMatchObject({ regenerationId: result.regenerationId });
  });

  it('the gate reports capability, editability and running regenerations; no grant → 404', async () => {
    const { GET } = await import('@/app/api/stages/[id]/scene-regeneration/route');
    const gate = (cookie: string, stageId = STAGE) =>
      GET(
        new NextRequest(`http://localhost/api/stages/${stageId}/scene-regeneration`, {
          headers: { cookie },
        }),
        {
          params: Promise.resolve({ id: stageId }),
        },
      );
    await expect((await gate(writeCookie)).json()).resolves.toEqual({
      capability: 'write',
      editable: true,
      versionStatus: 'draft',
      supportedSceneTypes: ['slide', 'quiz'],
      running: [],
    });
    await expect((await gate(cookieFor(STAGE, 'read').cookie)).json()).resolves.toMatchObject({
      capability: 'read',
    });
    await expect(
      (await gate(cookieFor(OTHER, 'write').cookie, OTHER)).json(),
    ).resolves.toMatchObject({ editable: false, versionStatus: 'approved' });
    expect((await gate('')).status).toBe(404);

    let during: unknown;
    mocks.duringGeneration = async () => {
      during = await (await gate(writeCookie)).json();
    };
    await post('scene-1', body('key-gate'));
    expect(during).toMatchObject({ running: [{ sceneId: 'scene-1' }] });
  });

  it('scene-revisions returns the manifest contract to any grant of the Stage, 404 otherwise', async () => {
    const { GET } = await import('@/app/api/stages/[id]/scene-revisions/route');
    const call = (cookie: string) =>
      GET(
        new NextRequest(`http://localhost/api/stages/${STAGE}/scene-revisions`, {
          headers: { cookie },
        }),
        {
          params: Promise.resolve({ id: STAGE }),
        },
      );
    const response = await call(cookieFor(STAGE, 'read').cookie);
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as {
      rev: number;
      scenes: Array<{ id: string; rev: number }>;
    };
    expect(manifest.scenes.map((scene) => scene.id)).toEqual([
      'scene-1',
      'scene-2',
      'scene-q',
      'scene-i',
      'scene-b',
    ]);
    expect(manifest.rev).toBeGreaterThan(0);
    expect((await call('')).status).toBe(404);
    expect((await call(cookieFor(OTHER, 'read').cookie)).status).toBe(404);
  });

  // ------------------------------------------------------------------ AT-RS

  it('AT-RS: restore once → 200 with the pre-image; again → 409; read grant → 403', async () => {
    const before = await sceneState('scene-1');
    const result = (await (await post('scene-1', body('key-restore'))).json()) as {
      regenerationId: string;
    };
    const { POST } =
      await import('@/app/api/stages/[id]/scene-regenerations/[regenerationId]/restore/route');
    const restore = (cookie = writeCookie) =>
      POST(
        new NextRequest(
          `http://localhost/api/stages/${STAGE}/scene-regenerations/${result.regenerationId}/restore`,
          { method: 'POST', headers: { cookie } },
        ),
        { params: Promise.resolve({ id: STAGE, regenerationId: result.regenerationId }) },
      );
    expect((await restore(cookieFor(STAGE, 'read').cookie)).status).toBe(403);
    const first = await restore();
    expect(first.status).toBe(200);
    const after = await sceneState('scene-1');
    expect(after!.scene).toEqual(before!.scene);
    const again = await restore();
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({
      error: { code: 'REGENERATION_NOT_RESTORABLE' },
    });
    expect((await events()).map((event) => event.event_type)).toContain(
      'scene_regeneration_restored',
    );
  });

  it('AT-RS: a restore after a later edit → 409 SCENE_CHANGED_SINCE_REGENERATION', async () => {
    const result = (await (await post('scene-1', body('key-restore-2'))).json()) as {
      regenerationId: string;
    };
    const current = await sceneState('scene-1');
    await editorStore().putScene(STAGE, { ...current!.scene, title: 'edited' });
    const { POST } =
      await import('@/app/api/stages/[id]/scene-regenerations/[regenerationId]/restore/route');
    const response = await POST(
      new NextRequest(
        `http://localhost/api/stages/${STAGE}/scene-regenerations/${result.regenerationId}/restore`,
        { method: 'POST', headers: { cookie: writeCookie } },
      ),
      { params: Promise.resolve({ id: STAGE, regenerationId: result.regenerationId }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SCENE_CHANGED_SINCE_REGENERATION' },
    });
    expect((await sceneState('scene-1'))!.scene.title).toBe('edited');
  });
});

describe('slide regeneration schema evolution (AT-M)', () => {
  it('widens an existing review-event CHECK in place, keeps old rows, and stays append-only', async () => {
    const db = new PGlite();
    await db.waitReady;
    const pool = new PGlitePool(db);
    const { ensureDocumentSchema } = await import('@openmaic/storage/document/pg');
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');
    const { ensureTeachingPackageSchema, appendReviewEvent } =
      await import('@/lib/persistence/teaching-package');
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data) VALUES ('s-m', 'm', 1, 1, '{}'::jsonb)`,
    );
    await insertVersion(pool as never, {
      id: 'tpv-m',
      aggregate: { tenantId: 't', learningItem: { type: 'lesson', id: 'li-m' } },
      version: 1,
      status: 'draft',
      currentStageId: 's-m',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    // Recreate the pre-feature shape with an old row in it.
    await pool.query('DROP TABLE teaching_package_scene_regenerations');
    await pool.query(
      'ALTER TABLE teaching_package_review_events DROP CONSTRAINT teaching_package_review_events_event_type_check',
    );
    await pool.query(
      `ALTER TABLE teaching_package_review_events ADD CONSTRAINT teaching_package_review_events_event_type_check
         CHECK (event_type IN ('created','submitted_for_review','review_edit_started','rejected','resubmitted','approved','superseded','discarded','successor_created','stage_replaced'))`,
    );
    await appendReviewEvent(pool as never, {
      versionId: 'tpv-m',
      eventType: 'created',
      fromStatus: null,
      toStatus: 'draft',
      actorRef: 'kafuo',
      createdAt: 1,
    });
    await ensureTeachingPackageSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    for (const eventType of [
      'scene_regeneration_started',
      'scene_regeneration_completed',
      'scene_regeneration_failed',
      'scene_regeneration_refused',
      'scene_regeneration_restored',
    ] as const) {
      await appendReviewEvent(pool as never, {
        versionId: 'tpv-m',
        eventType,
        fromStatus: 'draft',
        toStatus: 'draft',
        actorRef: 'teaching-package-editor:s-m',
        reason: 'r',
        createdAt: 2,
      });
    }
    await expect(
      appendReviewEvent(pool as never, {
        versionId: 'tpv-m',
        eventType: 'not_a_type' as never,
        fromStatus: 'draft',
        toStatus: 'draft',
        actorRef: 'x',
        createdAt: 3,
      }),
    ).rejects.toThrow();
    const kept = await pool.query(
      `SELECT event_type FROM teaching_package_review_events ORDER BY id`,
    );
    expect((kept.rows as Array<{ event_type: string }>)[0]!.event_type).toBe('created');
    await expect(pool.query('DELETE FROM teaching_package_review_events')).rejects.toThrow(
      /append-only/,
    );
    const table = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'teaching_package_scene_regenerations' ORDER BY indexname`,
    );
    expect((table.rows as Array<{ indexname: string }>).map((row) => row.indexname)).toEqual([
      'teaching_package_scene_regenerations_pkey',
      'tpsr_single_running',
      'tpsr_version_key_unique',
    ]);
    await pool.end();
  });
});
