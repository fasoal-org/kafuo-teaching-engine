import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import type { GenerationInputSnapshot } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  generateClassroom: vi.fn(),
  resolveModel: vi.fn(),
}));

// The runner drives the mocked pipeline; the REAL persistence sink runs inside
// it, so success/failure paths exercise the actual Stage writes.
vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassroom: mocks.generateClassroom,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
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

const OUTLINE = {
  id: 'outline-1',
  type: 'slide',
  title: 'Generated scene',
  description: '',
  keyPoints: [],
  order: 1,
};

function slideSceneWithMedia(stageId: string, order = 1): AppScene {
  const scene = makeSlideScene(`scene-${order}`, stageId, order, 'Generated');
  (scene.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
    id: `el-image-${order}`,
    type: 'image',
    src: `/api/classroom-media/${stageId}/media/generated-abc${order}.png`,
  });
  scene.actions = [
    {
      id: `a${order}`,
      type: 'speech',
      text: 'Welcome to the lesson',
      audioId: `tts_s${order}_a${order}`,
      audioUrl: `/api/classroom-media/${stageId}/audio/tts_s${order}_a${order}.mp3`,
    },
  ] as never;
  return scene;
}

/** The default mock: reserve → persist through the real sink, like the pipeline. */
function mockSuccessfulGeneration(): void {
  mocks.generateClassroom.mockImplementation(async (execution, options) => {
    const reserved = await options.persistence.reserve((id: string) => ({
      id,
      name: 'Generated course',
      createdAt: 1,
      updatedAt: 1,
    }));
    const scenes = [slideSceneWithMedia(reserved.id)];
    const persisted = await options.persistence.persist(
      {
        id: reserved.id,
        stage: reserved.stage,
        scenes,
        outlines: [OUTLINE] as never,
      },
      options.baseUrl,
    );
    return {
      id: persisted.id,
      url: persisted.url,
      stage: persisted.stage,
      scenes: persisted.scenes,
      scenesCount: persisted.scenes.length,
      createdAt: persisted.createdAt,
    };
  });
}

function executionInput() {
  return {
    requirement: 'Teach photosynthesis with examples REQMARKER.',
    pdfContent: { text: 'PDFTEXTMARKERXYZ full pdf body', images: ['data:image/png;base64,AAA'] },
    enableWebSearch: true,
    webSearchProviderId: 'tavily' as const,
    webSearchApiKey: 'sk-super-secret-key-123',
    webSearchModelId: 'search-model-x',
    enableImageGeneration: true,
    enableVideoGeneration: true,
    enableTTS: true,
    agentMode: 'generate' as const,
  };
}

describe('teaching package generation', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-gen-${(counter += 1)}`;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  async function freshModules() {
    const generation = await import('@/lib/server/teaching-package/generation');
    const runner = await import('@/lib/server/teaching-package/generation-runner');
    return { generation, runner };
  }

  async function startAndRun(
    request: Parameters<
      Awaited<ReturnType<typeof freshModules>>['generation']['startGenerationAttempt']
    >[1],
  ) {
    const { generation, runner } = await freshModules();
    const started = await generation.startGenerationAttempt(txPool(), request);
    await runner.runGenerationAttempt(started.attempt.id, started.execution);
    return started;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tp-gen-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    mocks.generateClassroom.mockReset();
    mocks.resolveModel.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mockSuccessfulGeneration();

    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
      learningItem: { type: 'lesson' as const, id: unique('li') },
      teachingModel: { key: 'g5', version: 'g5.v1' },
      generation: executionInput(),
      actorRef: 'actor-1',
      ...overrides,
    };
  }

  describe('initial generation', () => {
    it('creates v1 draft linked to the persisted stage, with the created event', async () => {
      const request = baseRequest();
      const { attempt } = await startAndRun(request);

      const after = (await (
        await import('@/lib/persistence/teaching-package')
      ).readAttempt(qp(), attempt.id))!;
      expect(after.status).toBe('succeeded');
      expect(after.kind).toBe('initial');
      expect(after.versionId).toMatch(/^tpv-/);
      expect(after.producedStageId).toBe(after.stageId);
      expect(after.producedStageId).toMatch(/^stage-/);

      const { readVersion } = await import('@/lib/persistence/teaching-package');
      const version = (await readVersion(qp(), after.versionId!))!;
      expect(version).toMatchObject({
        version: 1,
        status: 'draft',
        currentStageId: after.stageId,
        currentAttemptId: attempt.id,
        teachingModel: { key: 'g5', version: 'g5.v1' },
      });

      const { listReviewEvents } = await import('@/lib/persistence/teaching-package');
      const events = await listReviewEvents(qp(), version.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'created',
        toStatus: 'draft',
        actorRef: 'actor-1',
        data: { attemptId: attempt.id, stageId: after.stageId },
      });
    });

    it('passes Kafuo’s generation object through unchanged with baseUrl empty', async () => {
      const generation = executionInput();
      await startAndRun(baseRequest({ generation }));

      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
      const [input, options] = mocks.generateClassroom.mock.calls[0]!;
      expect(input).toEqual(generation);
      expect(options.baseUrl).toBe('');
      expect(options.persistence).toBeDefined();
    });

    it('normalizes narration so audioId is the concrete media path', async () => {
      const request = baseRequest({ generation: { ...executionInput(), enableTTS: true } });
      const { attempt } = await startAndRun(request);

      const { getOwnerScopedDocumentStore } =
        await import('@/lib/server/agent-runtime/owner-scoped-documents');
      const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const stageId = (await readAttempt(qp(), attempt.id))!.stageId!;
      const document = await store.loadDocument(stageId);
      expect(document).not.toBeNull();
      const action = document!.scenes[0]!.actions![0]! as {
        audioId?: string;
        audioUrl?: string;
      };
      expect(action.audioUrl).toMatch(/^\/api\/classroom-media\/[^/]+\/audio\/.+\.mp3$/);
      expect(action.audioId).toBe(action.audioUrl);
    });

    it('stores media paths verbatim and keeps the model lineage', async () => {
      const { attempt } = await startAndRun(baseRequest());
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttempt(qp(), attempt.id))!;
      const version = (await readVersion(qp(), after.versionId!))!;

      const { getOwnerScopedDocumentStore } =
        await import('@/lib/server/agent-runtime/owner-scoped-documents');
      const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const document = await store.loadDocument(after.stageId!);
      const slide = document!.scenes[0] as {
        content: { canvas: { elements: Array<{ src?: string }> } };
      };
      expect(slide.content.canvas.elements[0]!.src).toBe(
        `/api/classroom-media/${after.stageId}/media/generated-abc1.png`,
      );
      expect(version.teachingModel).toEqual({ key: 'g5', version: 'g5.v1' });
      expect(after.teachingModel).toEqual({ key: 'g5', version: 'g5.v1' });
    });

    it('fails without creating a version or any live stage when generation throws', async () => {
      mocks.generateClassroom.mockRejectedValue(new Error('provider exploded'));
      const request = baseRequest();
      const { attempt } = await startAndRun(request);

      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttempt(qp(), attempt.id))!;
      expect(after.status).toBe('failed');
      expect(after.error).toContain('provider exploded');
      expect(after.versionId).toBeNull();
      expect(after.stageId).toBeNull();
      const live = await pool.query(
        `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
      );
      expect((live.rows[0] as { n: number }).n).toBe(0);
    });

    it('tombstones the stage and fails the attempt when the completion transaction loses', async () => {
      const request = baseRequest();
      const { generation } = await freshModules();
      const started = await generation.startGenerationAttempt(txPool(), request);

      // A racing initial attempt wins v1 while this one is running: the
      // completion transaction then refuses and must tombstone our stage.
      const { insertVersion } = await import('@/lib/persistence/teaching-package');
      const racedStage = unique('stage');
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ($1, 'raced', 1, 1, '{}'::jsonb)`,
        [racedStage],
      );
      const { claimStageMeta } = await import('@/lib/persistence/stage-meta');
      const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
      await claimStageMeta(qp(), racedStage, TEACHING_PACKAGE_STAGE_OWNER);
      await insertVersion(qp(), {
        id: 'tpv-raced',
        learningItem: request.learningItem,
        version: 1,
        status: 'draft',
        currentStageId: racedStage,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });

      const { runner } = await freshModules();
      await runner.runGenerationAttempt(started.attempt.id, started.execution);

      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttempt(qp(), started.attempt.id))!;
      expect(after.status).toBe('failed');
      // Our generated stage was tombstoned; only the racing stage stays live.
      expect(after.stageId).toBeNull();
      const live = await pool.query(
        `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
      );
      expect((live.rows[0] as { n: number }).n).toBe(1);
    });
  });

  describe('lineage and snapshot safety', () => {
    it('persists neither the web-search key nor the pdf text, keeping flags', async () => {
      const { attempt } = await startAndRun(baseRequest());
      const raw = await pool.query(
        `SELECT input_snapshot::text AS snapshot
        FROM teaching_package_generation_attempts WHERE id = $1`,
        [attempt.id],
      );
      const snapshotText = (raw.rows[0] as { snapshot: string }).snapshot;
      expect(snapshotText).not.toContain('sk-super-secret-key-123');
      expect(snapshotText).not.toContain('PDFTEXTMARKERXYZ');
      // The requirement preview IS persisted by design; only the raw PDF body
      // and secrets are excluded.
      expect(snapshotText).toContain('REQMARKER');

      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttempt(qp(), attempt.id))!;
      expect(after.inputSnapshot.generationOptions).toMatchObject({
        enableWebSearch: true,
        webSearchProviderId: 'tavily',
        webSearchModelId: 'search-model-x',
        enableImageGeneration: true,
        enableVideoGeneration: true,
        enableTTS: true,
        agentMode: 'generate',
      });
      expect(after.inputSnapshot.pdfContentSummary).toMatchObject({
        present: true,
        textLength: 'PDFTEXTMARKERXYZ full pdf body'.length,
        imageCount: 1,
      });
      expect(after.inputSnapshot.requirementPreview).toContain('Teach photosynthesis');
      expect(after.inputSnapshot.requirementDigest).toMatch(/^[0-9a-f]{64}$/);
      // The one runner-writable key was patched.
      expect(after.inputSnapshot.resolvedLlmModel).toBe('test:model');
    });

    it('rejects snapshots that carry secrets or raw source content at insert time', async () => {
      const { insertAttempt } = await import('@/lib/persistence/teaching-package');
      const base = {
        learningItem: { type: 'lesson' as const, id: 'li-insert' },
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
      };
      await expect(
        insertAttempt(qp(), {
          id: 'tpa-bad-1',
          learningItem: base.learningItem,
          kind: 'initial',
          status: 'queued',
          requestedByActorRef: 'actor',
          teachingModel: base.teachingModel,
          inputSnapshot: { ...base, webSearchApiKey: 'sk-x' } as GenerationInputSnapshot,
          now: 1,
        }),
      ).rejects.toThrow(/webSearchApiKey/);
      await expect(
        insertAttempt(qp(), {
          id: 'tpa-bad-2',
          learningItem: base.learningItem,
          kind: 'initial',
          status: 'queued',
          requestedByActorRef: 'actor',
          teachingModel: base.teachingModel,
          inputSnapshot: { ...base, pdfContent: { text: 'raw' } } as GenerationInputSnapshot,
          now: 1,
        }),
      ).rejects.toThrow(/pdfContent/);
      await expect(
        insertAttempt(qp(), {
          id: 'tpa-bad-3',
          learningItem: base.learningItem,
          kind: 'initial',
          status: 'queued',
          requestedByActorRef: 'actor',
          teachingModel: base.teachingModel,
          inputSnapshot: {
            ...base,
            generationContext: { apiKey: 'x' },
          } as GenerationInputSnapshot,
          now: 1,
        }),
      ).rejects.toThrow(/secret/);
    });

    it('refuses secret-looking generationContext keys at request validation', async () => {
      const { generation } = await freshModules();
      await expect(
        generation.startGenerationAttempt(
          txPool(),
          baseRequest({ generationContext: { apiToken: 'x' } }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('refuses updateAttempt on producedStageId', async () => {
      const { attempt } = await startAndRun(baseRequest());
      const { updateAttempt } = await import('@/lib/persistence/teaching-package');
      await expect(
        updateAttempt(qp(), attempt.id, { producedStageId: 'stage-forged' } as never),
      ).rejects.toThrow(/producedStageId/);
    });
  });

  describe('regeneration', () => {
    async function seedInitialDraft() {
      const request = baseRequest();
      const started = await startAndRun(request);
      return { request, first: started.attempt };
    }

    it('replaces the current stage in place, retaining and locking the old one', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id))!;
      const versionBefore = (await readVersion(qp(), firstAfter.versionId!))!;
      const snapshotBefore = JSON.stringify(firstAfter.inputSnapshot);
      const stageA = versionBefore.currentStageId;

      const regenerationInput = {
        ...executionInput(),
        requirement: 'Improved version REQMARKER2.',
      };
      delete (regenerationInput as { pdfContent?: unknown }).pdfContent;
      const second = await startAndRun({
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: regenerationInput,
        versionId: versionBefore.id,
        actorRef: 'actor-2',
      });

      const secondAfter = (await readAttempt(qp(), second.attempt.id))!;
      const versionAfter = (await readVersion(qp(), versionBefore.id))!;
      expect(versionAfter.version).toBe(1); // same version number (BR-051)
      expect(versionAfter.currentStageId).not.toBe(stageA);
      expect(versionAfter.currentStageId).toBe(secondAfter.stageId);
      expect(versionAfter.currentAttemptId).toBe(second.attempt.id);
      expect(secondAfter.producedStageId).toBe(secondAfter.stageId);

      // The previous attempt is displaced but retained with its stage.
      const firstFinal = (await readAttempt(qp(), first.id))!;
      expect(firstFinal.displacedAt).not.toBeNull();
      expect(firstFinal.stageId).toBe(stageA);
      expect(firstFinal.producedStageId).toBe(stageA);
      expect(JSON.stringify(firstFinal.inputSnapshot)).toBe(snapshotBefore);

      // The displaced stage is guard-locked.
      const { teachingPackageStageGuardFence } =
        await import('@/lib/server/teaching-package/stage-guard');
      const { createOwnerBoundDocumentStore } =
        await import('@/lib/persistence/owner-bound-document-store');
      const { validateAppScene, validateAppStage } =
        await import('@/lib/document-store/validators');
      const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId: 'service:teaching-package',
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence: teachingPackageStageGuardFence(),
      });
      await expect(
        store.putScene(stageA, makeSlideScene('scene-9', stageA, 9)),
      ).rejects.toMatchObject({ reason: 'displaced' });

      const { listReviewEvents } = await import('@/lib/persistence/teaching-package');
      const events = await listReviewEvents(qp(), versionBefore.id);
      expect(events.at(-1)).toMatchObject({
        eventType: 'stage_replaced',
        data: { previousStageId: stageA, newStageId: secondAfter.stageId },
      });
    });

    it('keeps the previous stage current when regeneration fails', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id))!;
      const version = (await readVersion(qp(), firstAfter.versionId!))!;

      mocks.generateClassroom.mockRejectedValue(new Error('regeneration exploded'));
      await startAndRun({
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'again' },
        versionId: version.id,
        actorRef: 'actor-2',
      });

      const versionAfter = (await readVersion(qp(), version.id))!;
      expect(versionAfter.currentStageId).toBe(version.currentStageId);
    });

    it.each(['in_review', 'approved', 'superseded', 'discarded'] as const)(
      'refuses regeneration on a %s version',
      async (status) => {
        const item = { type: 'lesson' as const, id: unique('li') };
        const stageId = unique('stage');
        await pool.query(
          `INSERT INTO document_stages (id, name, created_at, updated_at, data)
           VALUES ($1, 'seed', 1, 1, '{}'::jsonb)`,
          [stageId],
        );
        const { claimStageMeta } = await import('@/lib/persistence/stage-meta');
        const { TEACHING_PACKAGE_STAGE_OWNER } =
          await import('@/lib/server/teaching-package/owner');
        await claimStageMeta(qp(), stageId, TEACHING_PACKAGE_STAGE_OWNER);
        const { insertVersion } = await import('@/lib/persistence/teaching-package');
        await insertVersion(qp(), {
          id: unique('tpv'),
          learningItem: item,
          version: 1,
          status,
          currentStageId: stageId,
          teachingModel: { key: 'g5', version: 'g5.v1' },
          now: 1,
        });
        const { generation } = await freshModules();
        const versions = await (
          await import('@/lib/persistence/teaching-package')
        ).listVersionsByItem(qp(), item);
        await expect(
          generation.startGenerationAttempt(txPool(), {
            learningItem: item,
            teachingModel: { key: 'g5', version: 'g5.v2' },
            generation: { requirement: 'x' },
            versionId: versions[0]!.id,
            actorRef: 'actor-1',
          }),
        ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      },
    );

    it('supports releasing and hard-deleting a displaced stage with lineage intact', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id))!;
      const version = (await readVersion(qp(), firstAfter.versionId!))!;
      const stageA = version.currentStageId;

      await startAndRun({
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'v2' },
        versionId: version.id,
        actorRef: 'actor-2',
      });
      const firstFinal = (await readAttempt(qp(), first.id))!;
      expect(firstFinal.stageId).toBe(stageA);

      const { releaseDisplacedStage } = await import('@/lib/persistence/teaching-package');
      await releaseDisplacedStage(qp(), first.id, Date.now());
      await pool.query(`DELETE FROM document_stages WHERE id = $1`, [stageA]);

      const released = (await readAttempt(qp(), first.id))!;
      expect(released.stageId).toBeNull();
      expect(released.producedStageId).toBe(stageA);
    });
  });

  describe('attempt admission', () => {
    it('refuses a second in-flight attempt with GENERATION_IN_PROGRESS', async () => {
      const { generation } = await freshModules();
      const request = baseRequest();
      await generation.startGenerationAttempt(txPool(), request);
      await expect(generation.startGenerationAttempt(txPool(), request)).rejects.toMatchObject({
        code: 'GENERATION_IN_PROGRESS',
        status: 409,
      });
    });

    it('returns the same attempt for a replayed requestId', async () => {
      const { generation } = await freshModules();
      const request = baseRequest({ requestId: 'kafuo-req-1' });
      const first = await generation.startGenerationAttempt(txPool(), request);
      const second = await generation.startGenerationAttempt(txPool(), { ...request });
      expect(second.attempt.id).toBe(first.attempt.id);
    });

    it('reclaims a stale running attempt and admits the new one', async () => {
      const item = { type: 'lesson' as const, id: unique('li') };
      const staleAge = 31 * 60 * 1000;
      const { insertAttempt } = await import('@/lib/persistence/teaching-package');
      await insertAttempt(qp(), {
        id: 'tpa-stale',
        learningItem: item,
        kind: 'initial',
        status: 'running',
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
        },
        now: Date.now() - staleAge,
      });
      await pool.query(
        `UPDATE teaching_package_generation_attempts SET created_at = $2 WHERE id = $1`,
        ['tpa-stale', Date.now() - staleAge],
      );

      const { generation } = await freshModules();
      const started = await generation.startGenerationAttempt(
        txPool(),
        baseRequest({
          learningItem: item,
        }),
      );
      expect(started.attempt.id).not.toBe('tpa-stale');
      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      expect((await readAttempt(qp(), 'tpa-stale'))!).toMatchObject({
        status: 'failed',
        error: 'stale',
      });
    });

    it('refuses an initial attempt once any version exists', async () => {
      const item = { type: 'lesson' as const, id: unique('li') };
      const stageId = unique('stage');
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ($1, 'seed', 1, 1, '{}'::jsonb)`,
        [stageId],
      );
      const { claimStageMeta } = await import('@/lib/persistence/stage-meta');
      const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
      await claimStageMeta(qp(), stageId, TEACHING_PACKAGE_STAGE_OWNER);
      const { insertVersion } = await import('@/lib/persistence/teaching-package');
      await insertVersion(qp(), {
        id: 'tpv-existing',
        learningItem: item,
        version: 1,
        status: 'approved',
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
      const { generation } = await freshModules();
      await expect(
        generation.startGenerationAttempt(txPool(), baseRequest({ learningItem: item })),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });
  });

  describe('sink id-collision retry', () => {
    it('re-mints the id, rewrites media paths, and renames the media directory', async () => {
      // The seam mints only on collision; its first answer must be the free id.
      const ids = ['stage-final'];
      const { createTeachingPackagePersistenceSink } =
        await import('@/lib/server/teaching-package/stage-persistence-sink');
      const sink = createTeachingPackagePersistenceSink('tpa-collide', {
        createStageId: () => ids.shift()!,
      });

      // The first minted id exists in document_stages without a meta claim —
      // exactly the `reserved-document` shape.
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ('stage-collide', 'Occupied', 1, 1, '{}'::jsonb)`,
      );
      const rename = vi.spyOn(fs, 'rename').mockResolvedValue(undefined as never);

      const stage = { id: 'stage-collide', name: 'C', createdAt: 1, updatedAt: 1 };
      const scenes = [slideSceneWithMedia('stage-collide')];
      const persisted = await sink.persist(
        {
          id: 'stage-collide',
          stage: stage as never,
          scenes: scenes as never[],
          outlines: [OUTLINE] as never[],
        },
        '',
      );

      expect(persisted.id).toBe('stage-final');
      expect(rename).toHaveBeenCalledTimes(1);
      const [from, to] = rename.mock.calls[0]! as [string, string];
      expect(from).toContain('stage-collide');
      expect(to).toContain('stage-final');

      const { getOwnerScopedDocumentStore } =
        await import('@/lib/server/agent-runtime/owner-scoped-documents');
      const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const document = await store.loadDocument('stage-final');
      expect(document).not.toBeNull();
      const slide = document!.scenes[0] as {
        stageId: string;
        content: { canvas: { elements: Array<{ src?: string }> } };
        actions: Array<{ audioId?: string; audioUrl?: string }>;
      };
      expect(slide.stageId).toBe('stage-final');
      expect(slide.content.canvas.elements[0]!.src).toBe(
        '/api/classroom-media/stage-final/media/generated-abc1.png',
      );
      expect(slide.actions[0]!.audioUrl).toBe(
        '/api/classroom-media/stage-final/audio/tts_s1_a1.mp3',
      );
      expect(slide.actions[0]!.audioId).toBe(slide.actions[0]!.audioUrl);
    });
  });
});
