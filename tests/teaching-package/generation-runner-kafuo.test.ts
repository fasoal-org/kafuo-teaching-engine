import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { AppScene } from '@/lib/types/stage';
import type {
  KafuoContentResource,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  generateClassroom: vi.fn(),
  resolveModel: vi.fn(),
  acquireContentResource: vi.fn(),
  materializeSourceImages: vi.fn(),
}));

vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassroom: mocks.generateClassroom,
}));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/server/teaching-package/content-resource', () => ({
  acquireContentResource: mocks.acquireContentResource,
  ContentResourceAcquisitionError: class extends Error {
    code: string;
    retryable: boolean;
    constructor(code: string, retryable: boolean, message: string) {
      super(message);
      this.code = code;
      this.retryable = retryable;
    }
  },
  recordPdfContentSummary: vi.fn((snapshot) => snapshot),
}));
vi.mock('@/lib/server/teaching-package/source-images', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/server/teaching-package/source-images')
  >()),
  materializeSourceImages: mocks.materializeSourceImages,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
]);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

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

const FLOW: TeachingFlowEntry[] = [
  { stage: 'lesson_introduction', instructions: 'i' },
  { stage: 'outcome_teaching_cards', instructions: 'c' },
];

function flowScene(order: number, flowIndex: number): AppScene {
  return {
    ...makeSlideScene(`scene-f${order}`, 'stage-x', order, 'S'),
    teachingStage: { key: FLOW[flowIndex]!.stage, flowIndex },
  } as AppScene;
}

function flowOutline(order: number, flowIndex: number) {
  return {
    id: `outline-f${order}`,
    type: 'slide' as const,
    title: 'S',
    description: '',
    keyPoints: [],
    order,
    teachingStage: { key: FLOW[flowIndex]!.stage, flowIndex },
  };
}

/** The successful-run mock: reserve → persist → valid flow scenes. */
function mockValidRun(stageId = 'stage-run-1') {
  mocks.generateClassroom.mockImplementation(async (_execution, options) => {
    const reserved = await options.persistence.reserve((id: string) => ({
      id,
      name: 'Generated',
      createdAt: 1,
      updatedAt: 1,
    }));
    const scenes = FLOW.map((_, index) => flowScene(index + 1, index));
    scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
    const outlines = FLOW.map((_, index) => flowOutline(index + 1, index));
    await options.persistence.persist(
      { id: reserved.id, stage: reserved.stage, scenes: scenes as never, outlines: outlines as never },
      options.baseUrl,
    );
    return {
      id: reserved.id,
      url: '',
      stage: reserved.stage,
      scenes: scenes as never,
      outlines: outlines as never,
      scenesCount: scenes.length,
      createdAt: new Date().toISOString(),
    };
  });
}

function kafuoContext(): NonNullable<
  Parameters<
    typeof import('@/lib/server/teaching-package/generation-runner')['runGenerationAttempt']
  >[2]
> {
  return {
    aggregate: { tenantId: 'tenant-k', learningItem: { type: 'lesson', id: `li-k-${randomUUID()}` } },
    teachingFlow: FLOW,
    learningObjectives: [{ objectiveRef: 'o1', snapshot: { statement: 's' } }],
    requirement: 'req',
    contentResource: {
      id: 'cs-1',
      url: 'https://r2.example.test/lesson.pdf?sig=abc',
      mimeType: 'application/pdf',
    } satisfies KafuoContentResource,
    generation: {},
    versionId: null,
  };
}

describe('teaching package generation runner — Kafuo Layer B', () => {
  let pool: PGlitePool;
  let tmp: string;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  async function freshModules() {
    return import('@/lib/server/teaching-package/generation-runner');
  }

  async function startKafuo(context = kafuoContext()) {
    const { startGenerationAttempt } = await import(
      '@/lib/server/teaching-package/generation'
    );
    const runner = await freshModules();
    const started = await startGenerationAttempt(txPool(), {
      tenantId: context.aggregate.tenantId,
      learningItem: context.aggregate.learningItem,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      generation: { requirement: 'req', teachingFlow: FLOW },
      actorRef: 'actor-1',
      requestId: `kafuo-run-${randomUUID()}`,
      requestDigest: 'a'.repeat(64),
      teachingFlow: FLOW,
      contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
    });
    await runner.runGenerationAttempt(started.attempt.id, started.execution, context);
    return started.attempt.id;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tp-kafuo-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kafuo-run-'));
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', tmp);
    mocks.generateClassroom.mockReset();
    mocks.resolveModel.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'm' },
      modelInfo: { capabilities: { vision: true } },
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.materializeSourceImages.mockReset();
    mocks.materializeSourceImages.mockResolvedValue({
      servingMapping: { 'src-1': `/api/classroom-media/stage-x/media/src_1_ab.png` },
      visionMapping: { 'src-1': DATA_URL },
      manifest: [],
    });
    mocks.acquireContentResource.mockReset();
    mocks.acquireContentResource.mockResolvedValue({
      text: 'pdf text',
      images: [DATA_URL],
      normalizedImages: [
        {
          id: 'src-1',
          data: PNG,
          mimeType: 'image/png',
          sha256: '0'.repeat(64),
          pageNumber: 1,
        },
      ],
      visionImages: [{ id: 'src-1', src: DATA_URL, pageNumber: 1 }],
      visionMapping: { 'src-1': DATA_URL },
      measuredBytes: 128,
      measuredSha256: 'b'.repeat(64),
    });
    mockValidRun();

    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('acquires once, runs once for a valid flow, and binds version 1 draft', async () => {
    const attemptId = await startKafuo();
    const { readAttemptById, readVersion } = await import(
      '@/lib/persistence/teaching-package'
    );
    const after = (await readAttemptById(qp(), attemptId))!;
    expect(after.status).toBe('succeeded');
    expect(after.versionId).toMatch(/^tpv-/);
    expect(after.generationRuns).toBe(1);
    expect(mocks.acquireContentResource).toHaveBeenCalledTimes(1);
    expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    const version = (await readVersion(qp(), after.versionId!, {
      tenantId: 'tenant-k',
    }))!;
    expect(version).toMatchObject({ version: 1, status: 'draft' });
    // The snapshot kept the secret-free resource facts — never the URL.
    const raw = await pool.query(`SELECT input_snapshot::text AS s FROM teaching_package_generation_attempts WHERE id = $1`, [attemptId]);
    expect((raw.rows[0] as { s: string }).s).not.toContain('sig=abc');
    // B1.2: Layer A retained the extracted lesson text for question generation after
    // approval — the text and measured identity only, never the URL.
    const retained = await pool.query(
      `SELECT tenant_id, text, measured_sha256, row_to_json(c)::text AS j
         FROM teaching_package_source_contexts c WHERE attempt_id = $1`,
      [attemptId],
    );
    const row = retained.rows[0] as { tenant_id: string; measured_sha256: string; j: string };
    expect(row).toMatchObject({ tenant_id: 'tenant-k', measured_sha256: 'b'.repeat(64) });
    expect(row.j).not.toContain('sig=abc');
    expect(row.j).not.toContain('http');
  });

  it('retries an invalid flow, then succeeds on a later run (only the valid stage binds)', async () => {
    let call = 0;
    mocks.generateClassroom.mockImplementation(async (_execution, options) => {
      call += 1;
      const reserved = await options.persistence.reserve((id: string) => ({
        id,
        name: 'G',
        createdAt: 1,
        updatedAt: 1,
      }));
      // Run 1 omits flow position 1 → invalid; run 2 is valid.
      const indices = call === 1 ? [0] : [0, 1];
      const scenes = indices.map((flowIndex, index) => flowScene(index + 1, flowIndex));
      scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
      const outlines = indices.map((flowIndex, index) => flowOutline(index + 1, flowIndex));
      await options.persistence.persist(
        { id: reserved.id, stage: reserved.stage, scenes: scenes as never, outlines: outlines as never },
        options.baseUrl,
      );
      return {
        id: reserved.id,
        url: '',
        stage: reserved.stage,
        scenes: scenes as never,
        outlines: outlines as never,
        scenesCount: scenes.length,
        createdAt: new Date().toISOString(),
      };
    });

    const attemptId = await startKafuo();
    const { readAttemptById } = await import('@/lib/persistence/teaching-package');
    const after = (await readAttemptById(qp(), attemptId))!;
    expect(after.status).toBe('succeeded');
    expect(after.generationRuns).toBe(2);
    expect(mocks.generateClassroom).toHaveBeenCalledTimes(2);
    // The invalid run's stage was compensated (tombstoned + media removed).
    const live = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
    );
    // One live stage: the valid one (the invalid run's was tombstoned).
    expect((live.rows[0] as { n: number }).n).toBe(1);
  });

  it('fails after exhausting bounded runs on persistent flow mismatch (no version created)', async () => {
    mocks.generateClassroom.mockImplementation(async (_execution, options) => {
      const reserved = await options.persistence.reserve((id: string) => ({
        id,
        name: 'G',
        createdAt: 1,
        updatedAt: 1,
      }));
      const scenes = [flowScene(1, 0)]; // never covers position 1
      scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
      await options.persistence.persist(
        { id: reserved.id, stage: reserved.stage, scenes: scenes as never, outlines: [flowOutline(1, 0)] as never },
        options.baseUrl,
      );
      return {
        id: reserved.id,
        url: '',
        stage: reserved.stage,
        scenes: scenes as never,
        outlines: [flowOutline(1, 0)] as never,
        scenesCount: 1,
        createdAt: new Date().toISOString(),
      };
    });

    const attemptId = await startKafuo();
    const { readAttemptById } = await import('@/lib/persistence/teaching-package');
    const after = (await readAttemptById(qp(), attemptId))!;
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('TEACHING_MODEL_FLOW_MISMATCH');
    expect(after.versionId).toBeNull();
    expect(after.generationRuns).toBeGreaterThanOrEqual(2);
    // No live stage survived compensation.
    const live = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
    );
    expect((live.rows[0] as { n: number }).n).toBe(0);
  });

  it('cleans a thrown run’s media directory after reservation and retries', async () => {
    let calls = 0;
    mocks.generateClassroom.mockImplementation(async (_execution, options) => {
      calls += 1;
      const reserved = await options.persistence.reserve((id: string) => ({
        id,
        name: 'G',
        createdAt: 1,
        updatedAt: 1,
      }));
      // Simulate media written for the reserved stage.
      await fs.mkdir(path.join(tmp, reserved.id, 'media'), { recursive: true });
      await fs.writeFile(path.join(tmp, reserved.id, 'media', 'x.png'), PNG);
      if (calls === 1) throw new Error('model exploded mid-run');
      const scenes = FLOW.map((_, index) => flowScene(index + 1, index));
      scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
      const outlines = FLOW.map((_, index) => flowOutline(index + 1, index));
      await options.persistence.persist(
        { id: reserved.id, stage: reserved.stage, scenes: scenes as never, outlines: outlines as never },
        options.baseUrl,
      );
      return {
        id: reserved.id,
        url: '',
        stage: reserved.stage,
        scenes: scenes as never,
        outlines: outlines as never,
        scenesCount: scenes.length,
        createdAt: new Date().toISOString(),
      };
    });

    const attemptId = await startKafuo();
    const { readAttemptById } = await import('@/lib/persistence/teaching-package');
    const after = (await readAttemptById(qp(), attemptId))!;
    expect(after.status).toBe('succeeded');
    expect(after.generationRuns).toBe(2);
    // The thrown run's stage directory was removed; only the successful one remains.
    const entries = await fs.readdir(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('undefined');
  });

  it('keeps the previous usable stage when a regeneration fails', async () => {
    // First: a valid initial generation.
    const attemptId = await startKafuo();
    const { readAttemptById, readVersion } = await import(
      '@/lib/persistence/teaching-package'
    );
    const first = (await readAttemptById(qp(), attemptId))!;
    const versionId = first.versionId!;
    const before = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
    const stageBefore = before.currentStageId;

    // Then: a regeneration of the same version that always fails.
    mocks.generateClassroom.mockReset();
    mocks.generateClassroom.mockRejectedValue(new Error('regeneration exploded'));
    const { startGenerationAttempt } = await import(
      '@/lib/server/teaching-package/generation'
    );
    const runner = await freshModules();
    const regeneration = await startGenerationAttempt(txPool(), {
      tenantId: 'tenant-k',
      learningItem: first.learningItem,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      generation: { requirement: 'again', teachingFlow: FLOW },
      versionId,
      actorRef: 'actor-2',
      requestId: `kafuo-regen-${randomUUID()}`,
      requestDigest: 'b'.repeat(64),
      teachingFlow: FLOW,
      contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
    });
    const context = kafuoContext();
    await runner.runGenerationAttempt(regeneration.attempt.id, regeneration.execution, {
      ...context,
      aggregate: { tenantId: 'tenant-k', learningItem: first.learningItem },
      versionId,
    });

    const failed = (await readAttemptById(qp(), regeneration.attempt.id))!;
    expect(failed.status).toBe('failed');
    const after = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
    expect(after.currentStageId).toBe(stageBefore);
    expect(after.status).toBe('draft');
  });

  it('fails terminally when Layer A acquisition is non-retryable', async () => {
    const { ContentResourceAcquisitionError } = await import(
      '@/lib/server/teaching-package/content-resource'
    );
    mocks.acquireContentResource.mockRejectedValue(
      new ContentResourceAcquisitionError(
        'CONTENT_RESOURCE_NOT_PDF',
        false,
        'the retrieved resource is not a PDF',
      ),
    );
    const attemptId = await startKafuo();
    const { readAttemptById } = await import('@/lib/persistence/teaching-package');
    const after = (await readAttemptById(qp(), attemptId))!;
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('CONTENT_RESOURCE_NOT_PDF');
    expect(after.versionId).toBeNull();
    expect(mocks.generateClassroom).not.toHaveBeenCalled();
  });
});
