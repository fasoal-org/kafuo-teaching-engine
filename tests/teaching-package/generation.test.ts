import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const TENANT = 'tenant-gen';
const attemptStaleWindow = () => 30 * 60 * 1000;

describe('teaching package generation', () => {
  let pool: PGlitePool;
  let classroomsDir: string;
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
    // Media lands in a per-test temp directory instead of the repo's
    // `data/classrooms`, so stage-media cleanup can be asserted on directly.
    classroomsDir = await fs.mkdtemp(path.join(tmpdir(), 'tp-gen-classrooms-'));
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', classroomsDir);
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
    await fs.rm(classroomsDir, { recursive: true, force: true }).catch(() => undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** The service-owned document store, guard fence included. */
  async function teachingPackageStoreAsync() {
    const { teachingPackageStageGuardFence } =
      await import('@/lib/server/teaching-package/stage-guard');
    const { createOwnerBoundDocumentStore } =
      await import('@/lib/persistence/owner-bound-document-store');
    const { validateAppScene, validateAppStage } = await import('@/lib/document-store/validators');
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: 'service:teaching-package',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  /**
   * Every Stage still live in this test's database. Each test gets a fresh
   * PGlite instance, so this is the whole world: the invariant "exactly one
   * live Stage per draft version" is checkable as a plain list.
   */
  async function liveStageIds(): Promise<string[]> {
    const result = await pool.query(
      'SELECT stage_id FROM stage_meta WHERE deleted_at IS NULL ORDER BY stage_id',
    );
    return (result.rows as Array<{ stage_id: string }>).map((row) => row.stage_id);
  }

  /** Plant a media directory for a Stage, as a real generation run would. */
  async function seedStageMediaDir(stageId: string): Promise<void> {
    await fs.mkdir(path.join(classroomsDir, stageId, 'media'), { recursive: true });
    await fs.writeFile(path.join(classroomsDir, stageId, 'media', 'generated-abc1.png'), 'png');
  }

  async function mediaDirExists(stageId: string): Promise<boolean> {
    return fs
      .stat(path.join(classroomsDir, stageId))
      .then(() => true)
      .catch(() => false);
  }

  function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
      tenantId: TENANT,
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
      ).readAttempt(qp(), attempt.id, { tenantId: TENANT }))!;
      expect(after.status).toBe('succeeded');
      expect(after.kind).toBe('initial');
      expect(after.versionId).toMatch(/^tpv-/);
      expect(after.producedStageId).toBe(after.stageId);
      expect(after.producedStageId).toMatch(/^stage-/);

      const { readVersion } = await import('@/lib/persistence/teaching-package');
      const version = (await readVersion(qp(), after.versionId!, { tenantId: TENANT }))!;
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
      const stageId = (await readAttempt(qp(), attempt.id, { tenantId: TENANT }))!.stageId!;
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
      const after = (await readAttempt(qp(), attempt.id, { tenantId: TENANT }))!;
      const version = (await readVersion(qp(), after.versionId!, { tenantId: TENANT }))!;

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
      const after = (await readAttempt(qp(), attempt.id, { tenantId: TENANT }))!;
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
        aggregate: { tenantId: TENANT, learningItem: request.learningItem },
        version: 1,
        status: 'draft',
        currentStageId: racedStage,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });

      const { runner } = await freshModules();
      await runner.runGenerationAttempt(started.attempt.id, started.execution);

      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttempt(qp(), started.attempt.id, { tenantId: TENANT }))!;
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
      const after = (await readAttempt(qp(), attempt.id, { tenantId: TENANT }))!;
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
          aggregate: { tenantId: TENANT, learningItem: base.learningItem },
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
          aggregate: { tenantId: TENANT, learningItem: base.learningItem },
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
          aggregate: { tenantId: TENANT, learningItem: base.learningItem },
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

    it('replaces the current stage in place and retires the old one, leaving exactly one live stage', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const versionBefore = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;
      const snapshotBefore = JSON.stringify(firstAfter.inputSnapshot);
      const stageA = versionBefore.currentStageId;
      await seedStageMediaDir(stageA);

      const regenerationInput = {
        ...executionInput(),
        requirement: 'Improved version REQMARKER2.',
      };
      delete (regenerationInput as { pdfContent?: unknown }).pdfContent;
      const second = await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: regenerationInput,
        versionId: versionBefore.id,
        actorRef: 'actor-2',
      });

      const secondAfter = (await readAttempt(qp(), second.attempt.id, { tenantId: TENANT }))!;
      const versionAfter = (await readVersion(qp(), versionBefore.id, { tenantId: TENANT }))!;
      expect(versionAfter.version).toBe(1); // same version number (BR-051)
      expect(versionAfter.currentStageId).not.toBe(stageA);
      expect(versionAfter.currentStageId).toBe(secondAfter.stageId);
      expect(versionAfter.currentAttemptId).toBe(second.attempt.id);
      expect(secondAfter.producedStageId).toBe(secondAfter.stageId);

      expect(versionAfter.status).toBe('draft');

      // Lineage survives — the attempt row keeps its stage ids, its displaced
      // marker and its input snapshot — but it no longer RETAINS the stage.
      const firstFinal = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      expect(firstFinal.displacedAt).not.toBeNull();
      expect(firstFinal.stageId).toBe(stageA);
      expect(firstFinal.producedStageId).toBe(stageA);
      expect(firstFinal.stageReleasedAt).not.toBeNull();
      expect(JSON.stringify(firstFinal.inputSnapshot)).toBe(snapshotBefore);

      // The old stage is soft-deleted, not kept as a live displaced stage:
      // neither the document nor its scenes answer any more, and a write is
      // refused as tombstoned rather than merely guard-locked.
      const store = await teachingPackageStoreAsync();
      await expect(store.loadDocument(stageA)).resolves.toBeNull();
      await expect(store.getScene(stageA, 'scene-1')).resolves.toBeNull();
      await expect(
        store.putScene(stageA, makeSlideScene('scene-9', stageA, 9)),
      ).rejects.toMatchObject({ refusal: 'tombstoned' });

      // …while the new one is fully live.
      await expect(store.loadDocument(versionAfter.currentStageId)).resolves.not.toBeNull();

      // Exactly one live stage remains — no retained displaced stage.
      await expect(liveStageIds()).resolves.toEqual([versionAfter.currentStageId]);

      // The retired stage's media directory is gone.
      await expect(mediaDirExists(stageA)).resolves.toBe(false);

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
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const version = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;

      await seedStageMediaDir(version.currentStageId);
      mocks.generateClassroom.mockRejectedValue(new Error('regeneration exploded'));
      await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'again' },
        versionId: version.id,
        actorRef: 'actor-2',
      });

      const versionAfter = (await readVersion(qp(), version.id, { tenantId: TENANT }))!;
      expect(versionAfter.currentStageId).toBe(version.currentStageId);
      expect(versionAfter.status).toBe('draft');
      expect(versionAfter.currentAttemptId).toBe(version.currentAttemptId);

      // The existing stage is untouched and still usable — a failed
      // regeneration must never cost the version the classroom it already has.
      const store = await teachingPackageStoreAsync();
      await expect(store.loadDocument(version.currentStageId)).resolves.not.toBeNull();
      await expect(mediaDirExists(version.currentStageId)).resolves.toBe(true);

      // …and no second live stage is left behind by the failed run.
      await expect(liveStageIds()).resolves.toEqual([version.currentStageId]);
    });

    it('returns a rejected version to draft when regeneration succeeds', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion, updateVersionStatus, listReviewEvents } =
        await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const versionBefore = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;
      const stageA = versionBefore.currentStageId;
      await seedStageMediaDir(stageA);
      // Drive it to `rejected` directly: the review path has its own suite, and
      // what matters here is the status regeneration starts from.
      await updateVersionStatus(qp(), versionBefore.id, { status: 'rejected', now: 2 });

      const second = await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'Rework after rejection REQMARKER3.' },
        versionId: versionBefore.id,
        actorRef: 'actor-3',
      });
      const secondAfter = (await readAttempt(qp(), second.attempt.id, { tenantId: TENANT }))!;
      const versionAfter = (await readVersion(qp(), versionBefore.id, { tenantId: TENANT }))!;

      // Same version identity, now editable again on the new stage.
      expect(versionAfter.id).toBe(versionBefore.id);
      expect(versionAfter.version).toBe(versionBefore.version);
      expect(versionAfter.status).toBe('draft');
      expect(versionAfter.currentStageId).toBe(secondAfter.stageId);

      // The rejected → draft transition is recorded on the replacement event
      // itself, so the audit trail carries it without a new event type.
      const events = await listReviewEvents(qp(), versionBefore.id);
      expect(events.at(-1)).toMatchObject({
        eventType: 'stage_replaced',
        fromStatus: 'rejected',
        toStatus: 'draft',
        data: { previousStageId: stageA, newStageId: secondAfter.stageId },
      });

      // The old stage is retired exactly as in the draft case.
      const store = await teachingPackageStoreAsync();
      await expect(store.loadDocument(stageA)).resolves.toBeNull();
      await expect(store.getScene(stageA, 'scene-1')).resolves.toBeNull();
      await expect(liveStageIds()).resolves.toEqual([versionAfter.currentStageId]);
      await expect(mediaDirExists(stageA)).resolves.toBe(false);
    });

    it('does not relink or retire anything when a stale attempt is reclaimed', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const version = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;
      const stageA = version.currentStageId;
      await seedStageMediaDir(stageA);

      const { generation } = await freshModules();
      const started = await generation.startGenerationAttempt(txPool(), {
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'stale runner' },
        versionId: version.id,
        actorRef: 'actor-4',
      });
      // The runner crashed; a later admission reclaimed the row. Its late
      // completion must be a no-op — this is the path that, if it relinked,
      // would tombstone the live stage the version is still serving.
      await pool.query(
        `UPDATE teaching_package_generation_attempts
            SET status = 'failed', error = 'stale', error_code = 'ATTEMPT_RECLAIMED_STALE'
          WHERE id = $1`,
        [started.attempt.id],
      );

      const orphanStageId = unique('stage-orphan');
      await generation.completeGenerationAttempt(txPool(), started.attempt.id, orphanStageId);

      const versionAfter = (await readVersion(qp(), version.id, { tenantId: TENANT }))!;
      expect(versionAfter.currentStageId).toBe(stageA);
      expect(versionAfter.currentAttemptId).toBe(version.currentAttemptId);

      const store = await teachingPackageStoreAsync();
      await expect(store.loadDocument(stageA)).resolves.not.toBeNull();
      await expect(mediaDirExists(stageA)).resolves.toBe(true);
      await expect(liveStageIds()).resolves.toEqual([stageA]);
    });

    it('invalidates a handoff minted for the replaced stage and admits one for the new stage', async () => {
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'generation-test-service-key');
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const versionBefore = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;
      const stageA = versionBefore.currentStageId;

      await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'replace for grant check' },
        versionId: versionBefore.id,
        actorRef: 'actor-5',
      });
      const versionAfter = (await readVersion(qp(), versionBefore.id, { tenantId: TENANT }))!;

      const { mintEditorHandoffToken } = await import('@/lib/server/teaching-package/editor-grant');
      const { GET } = await import('@/app/api/teaching-packages/editor-handoff/route');
      const { NextRequest } = await import('next/server');
      const redeem = (token: string) =>
        GET(
          new NextRequest(
            `http://localhost/api/teaching-packages/editor-handoff?token=${encodeURIComponent(token)}`,
          ),
        );

      // A preview token minted before the replacement names a Stage the version
      // has left; the redeem route's stage-identity check refuses it. This is
      // the existing invalidation path — regeneration simply makes it fire.
      const stale = mintEditorHandoffToken({
        tenantId: TENANT,
        versionId: versionBefore.id,
        stageId: stageA,
        capability: 'read',
        purpose: 'preview',
      });
      const staleResponse = await redeem(stale.token);
      expect(staleResponse.status).toBe(409);
      await expect(staleResponse.json()).resolves.toMatchObject({
        error: { code: 'STALE_STATE' },
      });

      // A freshly minted one resolves to the new Stage.
      const fresh = mintEditorHandoffToken({
        tenantId: TENANT,
        versionId: versionBefore.id,
        stageId: versionAfter.currentStageId,
        capability: 'read',
        purpose: 'preview',
      });
      const freshResponse = await redeem(fresh.token);
      expect(freshResponse.status).toBe(302);
      expect(freshResponse.headers.get('location')).toContain(
        `/classroom/${versionAfter.currentStageId}`,
      );
    });

    it('persists the replacement stage’s source visuals as concrete media paths', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const versionBefore = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;

      await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'replace and keep resolved visuals' },
        versionId: versionBefore.id,
        actorRef: 'actor-6',
      });
      const versionAfter = (await readVersion(qp(), versionBefore.id, { tenantId: TENANT }))!;

      const store = await teachingPackageStoreAsync();
      const document = await store.loadDocument(versionAfter.currentStageId);
      expect(document).not.toBeNull();
      const serialized = JSON.stringify(document!.scenes);
      // Replacement inherits the resolved-image contract: concrete served paths,
      // never a bare `src-<n>` Teaching Package visual id left unresolved.
      expect(serialized).toContain(`/api/classroom-media/${versionAfter.currentStageId}/media/`);
      expect(serialized).not.toMatch(/"src-\d+"/);
    });

    it('is idempotent when a completed regeneration is completed again', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion, listReviewEvents } =
        await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const versionBefore = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;
      const stageA = versionBefore.currentStageId;

      const second = await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'replace once' },
        versionId: versionBefore.id,
        actorRef: 'actor-7',
      });
      const secondAfter = (await readAttempt(qp(), second.attempt.id, { tenantId: TENANT }))!;
      const eventsAfterFirst = await listReviewEvents(qp(), versionBefore.id);

      // A retried completion for the same attempt must be a no-op: the attempt
      // is no longer `running`, so nothing relinks and the current Stage is not
      // deleted a second time.
      const { generation } = await freshModules();
      await generation.completeGenerationAttempt(txPool(), second.attempt.id, secondAfter.stageId!);

      const versionAfter = (await readVersion(qp(), versionBefore.id, { tenantId: TENANT }))!;
      expect(versionAfter.currentStageId).toBe(secondAfter.stageId);
      expect(versionAfter.status).toBe('draft');
      await expect(liveStageIds()).resolves.toEqual([secondAfter.stageId]);
      // No duplicate replacement event.
      const eventsAfterRetry = await listReviewEvents(qp(), versionBefore.id);
      expect(eventsAfterRetry.length).toBe(eventsAfterFirst.length);
      void stageA;
    });

    it('keeps one live stage across a chain of regenerations', async () => {
      const { request, first } = await seedInitialDraft();
      const { readAttempt, readVersion } = await import('@/lib/persistence/teaching-package');
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const version = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;

      const retired: string[] = [version.currentStageId];
      for (let round = 0; round < 3; round += 1) {
        await startAndRun({
          tenantId: TENANT,
          learningItem: request.learningItem,
          teachingModel: { key: 'g5', version: `g5.v${round + 2}` },
          generation: { requirement: `round ${round}` },
          versionId: version.id,
          actorRef: 'actor-loop',
        });
        const current = (await readVersion(qp(), version.id, { tenantId: TENANT }))!;
        // One live stage after every round, never an accumulating set of
        // displaced ones.
        await expect(liveStageIds()).resolves.toEqual([current.currentStageId]);
        expect(retired).not.toContain(current.currentStageId);
        retired.push(current.currentStageId);
      }

      const finalVersion = (await readVersion(qp(), version.id, { tenantId: TENANT }))!;
      expect(finalVersion.version).toBe(1);
      expect(finalVersion.status).toBe('draft');
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
          aggregate: { tenantId: TENANT, learningItem: item },
          version: 1,
          status,
          currentStageId: stageId,
          teachingModel: { key: 'g5', version: 'g5.v1' },
          now: 1,
        });
        const { generation } = await freshModules();
        const versions = await (
          await import('@/lib/persistence/teaching-package')
        ).listVersionsByItem(qp(), { tenantId: TENANT, learningItem: item });
        await expect(
          generation.startGenerationAttempt(txPool(), {
            tenantId: TENANT,
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
      const firstAfter = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      const version = (await readVersion(qp(), firstAfter.versionId!, { tenantId: TENANT }))!;
      const stageA = version.currentStageId;

      await startAndRun({
        tenantId: TENANT,
        learningItem: request.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v2' },
        generation: { requirement: 'v2' },
        versionId: version.id,
        actorRef: 'actor-2',
      });
      const firstFinal = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
      expect(firstFinal.stageId).toBe(stageA);

      const { releaseDisplacedStage } = await import('@/lib/persistence/teaching-package');
      await releaseDisplacedStage(qp(), first.id, Date.now());
      await pool.query(`DELETE FROM document_stages WHERE id = $1`, [stageA]);

      const released = (await readAttempt(qp(), first.id, { tenantId: TENANT }))!;
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

    it('returns the same attempt for a replayed requestId, marked as a replay', async () => {
      const { generation } = await freshModules();
      const request = baseRequest({ requestId: 'kafuo-req-1' });
      const first = await generation.startGenerationAttempt(txPool(), request);
      const second = await generation.startGenerationAttempt(txPool(), { ...request });
      expect(second.attempt.id).toBe(first.attempt.id);
      // `created` is what the routes gate the runner on: the first call
      // inserted the row, the replay did not.
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
    });

    it('marks a replay of a TERMINAL attempt as a replay and leaves it terminal', async () => {
      const { generation } = await freshModules();
      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const request = baseRequest({ requestId: 'kafuo-req-terminal' });
      const first = await generation.startGenerationAttempt(txPool(), request);
      // Drive it to a terminal state, as a real failed run would.
      await generation.failGenerationAttempt(txPool(), first.attempt.id, 'boom', {
        code: 'CLASSROOM_GENERATION_FAILED',
      });
      const terminal = (await readAttempt(qp(), first.attempt.id, { tenantId: TENANT }))!;

      const replay = await generation.startGenerationAttempt(txPool(), { ...request });

      expect(replay.created).toBe(false);
      expect(replay.attempt.id).toBe(first.attempt.id);
      // Returned unchanged — the replay rewrites nothing.
      expect(replay.attempt.status).toBe('failed');
      expect(replay.attempt.completedAt).toBe(terminal.completedAt);
      expect(replay.attempt.error).toBe(terminal.error);
      expect(replay.attempt.errorCode).toBe(terminal.errorCode);
    });

    it('claims a queued attempt for a run exactly once', async () => {
      const { claimQueuedAttemptForRun, readAttempt } = await import(
        '@/lib/persistence/teaching-package'
      );
      const { generation } = await freshModules();
      const started = await generation.startGenerationAttempt(txPool(), baseRequest());

      const first = await claimQueuedAttemptForRun(qp(), started.attempt.id, 111);
      expect(first).toMatchObject({ status: 'running', startedAt: 111 });

      // A second runner invocation claims nothing — the predicate is in the
      // UPDATE, so this is atomic rather than a read-then-write.
      const second = await claimQueuedAttemptForRun(qp(), started.attempt.id, 222);
      expect(second).toBeNull();
      const after = (await readAttempt(qp(), started.attempt.id, { tenantId: TENANT }))!;
      expect(after.startedAt).toBe(111);
    });

    it.each(['succeeded', 'failed'] as const)(
      'never admits a %s attempt into a run, and rewrites nothing',
      async (status) => {
        const { claimQueuedAttemptForRun, readAttempt } = await import(
          '@/lib/persistence/teaching-package'
        );
        const { generation } = await freshModules();
        const started = await generation.startGenerationAttempt(txPool(), baseRequest());
        await pool.query(
          `UPDATE teaching_package_generation_attempts
              SET status = $2, started_at = 10, completed_at = 20,
                  stage_id = NULL, error = 'recorded', error_code = 'RECORDED'
            WHERE id = $1`,
          [started.attempt.id, status],
        );
        const before = (await readAttempt(qp(), started.attempt.id, { tenantId: TENANT }))!;

        await expect(
          claimQueuedAttemptForRun(qp(), started.attempt.id, 999),
        ).resolves.toBeNull();

        // Terminal stays terminal: status, timings, stage binding and error
        // information are all untouched.
        const after = (await readAttempt(qp(), started.attempt.id, { tenantId: TENANT }))!;
        expect(after).toMatchObject({
          status,
          startedAt: before.startedAt,
          completedAt: before.completedAt,
          stageId: before.stageId,
          producedStageId: before.producedStageId,
          error: before.error,
          errorCode: before.errorCode,
        });
      },
    );

    it('does not re-run a replayed terminal attempt handed to the runner', async () => {
      // End-to-end of the reported failure, minus the routes: a terminal
      // attempt that reaches the runner anyway must stay exactly as it was.
      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      const { generation, runner } = await freshModules();
      const started = await generation.startGenerationAttempt(txPool(), baseRequest());
      await runner.runGenerationAttempt(started.attempt.id, started.execution);
      const succeeded = (await readAttempt(qp(), started.attempt.id, { tenantId: TENANT }))!;
      expect(succeeded.status).toBe('succeeded');

      mocks.generateClassroom.mockClear();
      await runner.runGenerationAttempt(started.attempt.id, started.execution);

      // No second generation, and the attempt is byte-for-byte what it was.
      expect(mocks.generateClassroom).not.toHaveBeenCalled();
      const after = (await readAttempt(qp(), started.attempt.id, { tenantId: TENANT }))!;
      expect(after).toEqual(succeeded);
    });

    it('refuses an empty tenant with TENANT_REQUIRED', async () => {
      const { generation } = await freshModules();
      await expect(
        generation.startGenerationAttempt(txPool(), { ...baseRequest(), tenantId: '' }),
      ).rejects.toMatchObject({ code: 'TENANT_REQUIRED', status: 400 });
    });

    it('refuses a Kafuo-shaped request without a semantic digest', async () => {
      const { generation } = await freshModules();
      await expect(
        generation.startGenerationAttempt(
          txPool(),
          baseRequest({
            contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('returns the same attempt for a same-digest requestId replay', async () => {
      const { generation } = await freshModules();
      const request = baseRequest({
        requestId: 'kafuo-digest-1',
        requestDigest: 'a'.repeat(64),
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      const first = await generation.startGenerationAttempt(txPool(), request);
      const second = await generation.startGenerationAttempt(txPool(), { ...request });
      expect(second.attempt.id).toBe(first.attempt.id);
      expect(second.attempt.requestDigest).toBe('a'.repeat(64));
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
    });

    it('raises IDEMPOTENCY_CONFLICT for a same requestId with a different digest', async () => {
      const { generation } = await freshModules();
      const request = baseRequest({
        requestId: 'kafuo-digest-2',
        requestDigest: 'b'.repeat(64),
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      await generation.startGenerationAttempt(txPool(), request);
      await expect(
        generation.startGenerationAttempt(txPool(), {
          ...request,
          requestDigest: 'c'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    });

    it('raises IDEMPOTENCY_CONFLICT when a digest replay hits a null-digest legacy attempt', async () => {
      const { generation } = await freshModules();
      const item = { type: 'lesson' as const, id: unique('li') };
      await generation.startGenerationAttempt(
        txPool(),
        baseRequest({ learningItem: item, requestId: 'legacy-9' }),
      );
      await expect(
        generation.startGenerationAttempt(
          txPool(),
          baseRequest({
            learningItem: item,
            requestId: 'legacy-9',
            requestDigest: 'd'.repeat(64),
            contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    });

    it('reclaims a stale queued attempt (after() never ran) with ATTEMPT_RECLAIMED_STALE', async () => {
      const item = { type: 'lesson' as const, id: unique('li') };
      const staleAge = 31 * 60 * 1000;
      const { insertAttempt } = await import('@/lib/persistence/teaching-package');
      await insertAttempt(qp(), {
        id: 'tpa-queued-stale',
        aggregate: { tenantId: TENANT, learningItem: item },
        kind: 'initial',
        status: 'queued',
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
        ['tpa-queued-stale', Date.now() - staleAge],
      );

      const { generation } = await freshModules();
      const started = await generation.startGenerationAttempt(
        txPool(),
        baseRequest({ learningItem: item }),
      );
      expect(started.attempt.id).not.toBe('tpa-queued-stale');
      const { readAttempt } = await import('@/lib/persistence/teaching-package');
      expect((await readAttempt(qp(), 'tpa-queued-stale', { tenantId: TENANT }))!).toMatchObject({
        status: 'failed',
        error: 'stale',
        errorCode: 'ATTEMPT_RECLAIMED_STALE',
        errorRetryable: true,
      });
    });

    it('reclaimStaleAttempts with a null scope reclaims across aggregates and returns the rows', async () => {
      const staleAge = 31 * 60 * 1000;
      const { insertAttempt, reclaimStaleAttempts } =
        await import('@/lib/persistence/teaching-package');
      const snapshotFor = (id: string) => ({
        learningItem: { type: 'lesson' as const, id },
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
      });
      await insertAttempt(qp(), {
        id: 'tpa-sweep-1',
        aggregate: { tenantId: 'tenant-one', learningItem: { type: 'lesson', id: 'li-a' } },
        kind: 'initial',
        status: 'running',
        requestedByActorRef: 'actor-1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        inputSnapshot: snapshotFor('li-a'),
        now: 1,
      });
      await insertAttempt(qp(), {
        id: 'tpa-sweep-2',
        aggregate: { tenantId: 'tenant-two', learningItem: { type: 'section', id: 'li-b' } },
        kind: 'initial',
        status: 'queued',
        requestedByActorRef: 'actor-1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        inputSnapshot: snapshotFor('li-b'),
        now: 1,
      });
      await pool.query(
        `UPDATE teaching_package_generation_attempts SET created_at = $1 WHERE id LIKE 'tpa-sweep-%'`,
        [Date.now() - staleAge],
      );

      const reclaimed = await reclaimStaleAttempts(qp(), null, Date.now() - attemptStaleWindow());
      expect(reclaimed.map((attempt) => attempt.id).sort()).toEqual(['tpa-sweep-1', 'tpa-sweep-2']);
      for (const attempt of reclaimed) {
        expect(attempt.errorCode).toBe('ATTEMPT_RECLAIMED_STALE');
        expect(attempt.status).toBe('failed');
      }
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
        aggregate: { tenantId: TENANT, learningItem: item },
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
