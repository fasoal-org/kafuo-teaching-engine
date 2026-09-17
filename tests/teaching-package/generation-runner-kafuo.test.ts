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
  TeachingSkillPolicy,
} from '@/lib/types/teaching-package';
import { TEACHING_SKILLS_CONTRACT_V1 } from '@/lib/server/teaching-package/kafuo-request';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  generateClassroom: vi.fn(),
  resolveModel: vi.fn(),
  acquireContentResource: vi.fn(),
  acquireNormalizedContentResource: vi.fn(),
  materializeSourceImages: vi.fn(),
  logWarn: vi.fn(),
  /**
   * Called by the `generateClassroom` mocks at the exact point the real pipeline
   * starts Stage-2 work — after the Stage-1 outline gate, before `reserve`.
   * `not.toHaveBeenCalled()` is therefore the proof that an ungrounded response
   * cost no Stage and no Scene content.
   */
  sceneGenerationReached: vi.fn(),
  /** The outlines each run handed to `persistence.persist`, in order. */
  persistedOutlines: [] as Array<Array<{ sourceContentUnitIds?: unknown }>>,
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
vi.mock('@/lib/server/teaching-package/normalized-content-resource', () => ({
  acquireNormalizedContentResource: mocks.acquireNormalizedContentResource,
  recordNormalizedContentSummary: vi.fn((snapshot) => snapshot),
}));
vi.mock('@/lib/server/teaching-package/source-images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/source-images')>()),
  materializeSourceImages: mocks.materializeSourceImages,
}));
vi.mock('@/lib/logger', () => ({
  // `warn` is captured rather than discarded: the grounding refusal's diagnostics are part
  // of the contract now, because the outlines it rejects are gone by the time anyone reads
  // the stored attempt.
  createLogger: () => ({ info: vi.fn(), warn: mocks.logWarn, error: vi.fn(), debug: vi.fn() }),
}));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3,
  0, 0, 0, 2, 8, 6, 0, 0, 0,
]);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

class PGlitePool {
  constructor(readonly db: PGlite) {}

  /**
   * Generic passthrough: PGlite's own `Row` default renders row fields as
   * `{}` without it, hiding real property accesses from the checker.
   */
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]) {
    return this.db.query<Row>(text, params);
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
    // Pipeline order, faithfully: outlines → Stage-1 gate → reserve → scenes.
    // `sourceContentUnitIds` alone; the happy path deliberately sends NO
    // `sourceBlockIds`, which is the proof that block citation is not required.
    const outlines = FLOW.map((_, index) => ({
      ...flowOutline(index + 1, index),
      ...(_execution.pdfContent?.text?.includes('CONTENT_UNIT')
        ? { sourceContentUnitIds: ['cu-1'] }
        : {}),
    }));
    await options.validateOutlines?.(outlines);
    mocks.sceneGenerationReached();
    const reserved = await options.persistence.reserve((id: string) => ({
      id,
      name: 'Generated',
      createdAt: 1,
      updatedAt: 1,
    }));
    const scenes = FLOW.map((_, index) => flowScene(index + 1, index));
    scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
    mocks.persistedOutlines.push(outlines as never);
    await options.persistence.persist(
      {
        id: reserved.id,
        stage: reserved.stage,
        scenes: scenes as never,
        outlines: outlines as never,
      },
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

/**
 * A run whose outline citations the test dictates.
 *
 * `mockGenerate` above copies `['cu-1']` whenever the adapted text mentions CONTENT_UNIT,
 * which is the happy path and cannot express the failures below: ids of the wrong JSON
 * type, ids absent from the manifest, or no citations at all.
 */
function mockGenerateWithCitations(citations: {
  sourceContentUnitIds?: unknown;
  sourceBlockIds?: unknown;
}) {
  mocks.generateClassroom.mockImplementation(async (_execution, options) => {
    // The gate is injected INTO the pipeline, so the mock must honour where it
    // sits: outlines are validated before anything is reserved or generated. A
    // mock that reserved first would keep passing while proving nothing about
    // the boundary this test exists to pin.
    const outlines = FLOW.map((_, index) => ({
      ...flowOutline(index + 1, index),
      ...citations,
    }));
    await options.validateOutlines?.(outlines);
    mocks.sceneGenerationReached();
    const reserved = await options.persistence.reserve((id: string) => ({
      id,
      name: 'Generated',
      createdAt: 1,
      updatedAt: 1,
    }));
    const scenes = FLOW.map((_, index) => flowScene(index + 1, index));
    scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
    mocks.persistedOutlines.push(outlines as never);
    await options.persistence.persist(
      {
        id: reserved.id,
        stage: reserved.stage,
        scenes: scenes as never,
        outlines: outlines as never,
      },
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

function normalizedSourceWithManifest() {
  return {
    text: '[[CONTENT_UNIT id=2900]] [[BLOCK id=51234]] normalized text',
    images: [DATA_URL],
    normalizedImages: [],
    visionImages: [],
    visionMapping: {},
    measuredBytes: 100,
    measuredSha256: 'b'.repeat(64),
    // Ids are strings in the manifest, exactly as Kafuo exports them (`str(...)`).
    manifest: { contentUnits: [{ id: '2900', blocks: [{ id: '51234' }] }] },
    blockCount: 1,
  };
}

function kafuoContext(): NonNullable<
  Parameters<
    (typeof import('@/lib/server/teaching-package/generation-runner'))['runGenerationAttempt']
  >[2]
> {
  return {
    aggregate: {
      tenantId: 'tenant-k',
      learningItem: { type: 'lesson', id: `li-k-${randomUUID()}` },
    },
    // Tier B by default: Kafuo-shaped, pre-Module-2 (no governance marker).
    // W8 tests override this with the contract string for the governed case.
    teachingSkillsContract: null,
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

function normalizedKafuoContext() {
  return {
    ...kafuoContext(),
    normalizedContentResource: {
      id: 'ncr-1',
      url: 'https://r2.example.test/n.zip?sig=secret',
      mimeType: 'application/zip' as const,
      schemaVersion: 'kafuo.normalized-content.v1' as const,
      contentSourceId: 'cs-1',
      contentRevisionId: 'rev-1',
      parseRunId: 'run-1',
      structureProfile: { id: 'p-1', versionId: 'pv-1' },
      fileSizeBytes: 100,
      checksumSha256: 'b'.repeat(64),
    },
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
    const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
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
    mocks.sceneGenerationReached.mockReset();
    mocks.persistedOutlines.length = 0;
    mocks.logWarn.mockReset();
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
    mocks.acquireNormalizedContentResource.mockReset();
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
    const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');
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
    const raw = await pool.query(
      `SELECT input_snapshot::text AS s FROM teaching_package_generation_attempts WHERE id = $1`,
      [attemptId],
    );
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

  it('uses normalized acquisition exclusively and never calls the PDF path', async () => {
    mocks.acquireNormalizedContentResource.mockResolvedValue({
      text: '[[CONTENT_UNIT id=cu-1]] normalized text',
      images: [DATA_URL],
      normalizedImages: [
        {
          id: 'src-1',
          data: PNG,
          mimeType: 'image/png',
          sha256: '0'.repeat(64),
          pageNumber: 1,
          sourceContentUnitIds: ['cu-1'],
          sourceBlockIds: ['block-1'],
        },
      ],
      visionImages: [
        {
          id: 'src-1',
          src: DATA_URL,
          pageNumber: 1,
          sourceContentUnitIds: ['cu-1'],
          sourceBlockIds: ['block-1'],
        },
      ],
      visionMapping: { 'src-1': DATA_URL },
      measuredBytes: 100,
      measuredSha256: 'b'.repeat(64),
      manifest: { contentUnits: [{ id: 'cu-1', blocks: [{ id: 'block-1' }] }] },
      blockCount: 1,
    });
    const attemptId = await startKafuo(normalizedKafuoContext());
    expect(mocks.acquireNormalizedContentResource).toHaveBeenCalledTimes(1);
    expect(mocks.acquireContentResource).not.toHaveBeenCalled();
    expect(mocks.generateClassroom.mock.calls[0]![0].pdfContent.text).toContain('cu-1');
    const retained = await pool.query(
      `SELECT source_kind, normalized_package_id, content_revision_id, parse_run_id,
              structure_profile_id, structure_profile_version_id
         FROM teaching_package_source_contexts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(retained.rows[0]).toMatchObject({
      source_kind: 'kafuo_normalized',
      normalized_package_id: 'ncr-1',
      content_revision_id: 'rev-1',
      parse_run_id: 'run-1',
      structure_profile_id: 'p-1',
      structure_profile_version_id: 'pv-1',
    });
  });

  it('does not fall back to PDF when normalized acquisition fails', async () => {
    mocks.acquireNormalizedContentResource.mockRejectedValue(
      Object.assign(new Error('safe normalized failure'), {
        name: 'ContentResourceAcquisitionError',
        code: 'NORMALIZED_CONTENT_ARCHIVE_INVALID',
        retryable: false,
      }),
    );
    await startKafuo(normalizedKafuoContext());
    expect(mocks.acquireNormalizedContentResource).toHaveBeenCalledTimes(1);
    expect(mocks.acquireContentResource).not.toHaveBeenCalled();
    expect(mocks.generateClassroom).not.toHaveBeenCalled();
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
        {
          id: reserved.id,
          stage: reserved.stage,
          scenes: scenes as never,
          outlines: outlines as never,
        },
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
        {
          id: reserved.id,
          stage: reserved.stage,
          scenes: scenes as never,
          outlines: [flowOutline(1, 0)] as never,
        },
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
        {
          id: reserved.id,
          stage: reserved.stage,
          scenes: scenes as never,
          outlines: outlines as never,
        },
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
    const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');
    const first = (await readAttemptById(qp(), attemptId))!;
    const versionId = first.versionId!;
    const before = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
    const stageBefore = before.currentStageId;

    // Then: a regeneration of the same version that always fails.
    mocks.generateClassroom.mockReset();
    mocks.generateClassroom.mockRejectedValue(new Error('regeneration exploded'));
    const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
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
    const { ContentResourceAcquisitionError } =
      await import('@/lib/server/teaching-package/content-resource');
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

  describe('normalized outline grounding', () => {
    /**
     * Lesson 282 / Learning Item 121 failed here with
     * `NORMALIZED_CONTENT_LINEAGE_MISMATCH` on a manifest that was provably correct:
     * 18 content units and 93 blocks, checksum verified. Two defects met there. The gate
     * compared the model's citations against `Set<string>` while the projection showed the
     * model bare unquoted ids and asked it to copy them "exactly" -- a model doing exactly
     * that emits JSON numbers. And the code itself blamed the package for what was a model
     * output error; `OUTLINE_CONTENT_UNIT_GROUNDING_INVALID` now says so.
     */
    it('accepts numeric ids that name real manifest entries', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      // What a compliant model returns when it copies `id=2900` out of the source text.
      mockGenerateWithCitations({ sourceContentUnitIds: [2900] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]).toMatchObject({ status: 'succeeded', error_code: null });
      // ...and the accepted numeric id is normalized before it is persisted, so the
      // declared `string[]` stays true through persistence, merge and cloning.
      const persisted = mocks.persistedOutlines.at(-1)!;
      expect(persisted[0]!.sourceContentUnitIds).toEqual(['2900']);
    });

    it('accepts string ids, as it always did', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: ['2900'] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]!.status).toBe('succeeded');
    });

    it('never requires block ids: a Content-Unit-only citation succeeds', async () => {
      /* The model is no longer shown a single `[[BLOCK]]` marker, so it cannot be asked
         to cite one. An outline carrying ONLY `sourceContentUnitIds` is complete. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: ['2900'] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]!.status).toBe('succeeded');
    });

    it('does not ask the model for block ids', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: ['2900'] });

      await startKafuo(normalizedKafuoContext());

      const execution = mocks.generateClassroom.mock.calls[0]![0] as {
        requirement: string;
        normalizedGrounding?: boolean;
      };
      expect(execution.requirement).toContain('sourceContentUnitIds');
      expect(execution.requirement).not.toContain('sourceBlockIds');
      expect(execution.requirement).not.toContain('[[BLOCK');
      // The contract is an explicit generation option, not prose alone: this is what
      // switches the outline templates onto the grounded schema.
      expect(execution.normalizedGrounding).toBe(true);
    });

    it('leaves the non-normalized PDF path without the grounding contract', async () => {
      mockValidRun();

      await startKafuo(kafuoContext());

      const execution = mocks.generateClassroom.mock.calls[0]![0] as {
        normalizedGrounding?: boolean;
      };
      expect(execution.normalizedGrounding).toBeUndefined();
    });

    it('refuses ids that name nothing in the manifest', async () => {
      /* The check the normalization must not throw away: a hallucinated citation is still
         ungrounded, whatever its JSON type. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'failed',
        error_code: 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID',
      });
    });

    it('refuses an outline that cites nothing at all', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'failed',
        error_code: 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID',
      });
    });

    it('refuses an outline with no sourceContentUnitIds field at all', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      // Exactly the real failure: every outline omitted the field.
      mockGenerateWithCitations({});

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'failed',
        error_code: 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID',
      });
    });

    it('does not reuse NORMALIZED_CONTENT_LINEAGE_MISMATCH for a model output error', async () => {
      /* That code is reserved for a genuine package/request lineage mismatch. Reporting a
         bad answer under it is what sent the last diagnosis hunting a correct package. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]!.error_code).not.toBe('NORMALIZED_CONTENT_LINEAGE_MISMATCH');
    });

    it('rejects before any Scene content is generated or any Stage reserved', async () => {
      /* The point of the whole change: this used to be discovered only after
         `generateClassroom` had produced and persisted all 33 Scenes. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
      const stages = await pool.query(`SELECT count(*)::int AS n FROM stage_meta`);
      expect(stages.rows[0]!.n).toBe(0);
      const row = await pool.query(
        `SELECT version_id FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]!.version_id).toBeNull();
    });

    it('spends the existing run budget on a grounding miss, and no more', async () => {
      /* The budget itself is unchanged: the bound is still `maxGenerationRuns()`. Each
         retry is now cheap — it re-rolls the outline call, not 33 Scenes. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT generation_runs FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(Number(row.rows[0]!.generation_runs)).toBe(3);
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(3);
      // ...and not one of those three retries produced Scene content.
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('logs the rejected citations and what the manifest offered', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      await startKafuo(normalizedKafuoContext());

      const logged = mocks.logWarn.mock.calls.flat().join(' ');
      expect(logged).toContain('rejected outline grounding');
      // The offending values, and a sample of the real ones, so the next diagnosis does
      // not need the database.
      expect(logged).toContain('9999');
      expect(logged).toContain('2900');
      // Blocks are internal: the refusal never reports missing block grounding.
      expect(logged).not.toContain('sourceBlockIds');
    });
  });

  describe('teaching skills fail-closed at the Stage-1 gate (Module 2 W8)', () => {
    /**
     * BR-TS-048: a request carrying the governance marker fails closed on
     * missing / unresolvable policy inside `options.validateOutlines` — after
     * outlines, BEFORE `sink.reserve`. The mode arrives on the context as the
     * W6-derived value (`teachingSkillsContract`); the marker is never re-tested.
     */
    const policy = (overrides: Partial<TeachingSkillPolicy> = {}): TeachingSkillPolicy => ({
      required: [],
      preferred: [{ skillId: 'feynman-learning', version: 'v1' }],
      allowed: [
        { skillId: 'feynman-learning', version: 'v1' },
        { skillId: 'learning-to-learn', version: 'v1' },
      ],
      combinationRestrictions: [],
      ...overrides,
    });

    /** Real registry ids at v1, so governed success resolves against the live W1 catalog. */
    const governedFlow = (): TeachingFlowEntry[] => [
      { stage: 'lesson_introduction', instructions: 'i', skillPolicy: policy() },
      { stage: 'outcome_teaching_cards', instructions: 'c', skillPolicy: policy() },
    ];

    function governedContext(flow: TeachingFlowEntry[] = governedFlow()) {
      return {
        ...kafuoContext(),
        teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
        teachingFlow: flow,
      };
    }

    async function attemptRow(attemptId: string) {
      const row = await pool.query<{
        status: string;
        error_code: string | null;
        error_retryable: boolean | null;
        version_id: string | null;
      }>(
        `SELECT status, error_code, error_retryable, version_id
           FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      return row.rows[0]!;
    }

    it('governed + policy MISSING: refuses SKILL_POLICY_REQUIRED with no Stage, Scene, or re-roll', async () => {
      const flow = governedFlow();
      // A governed request that lost a projected policy — the fail-open hole §M
      // closes. It must refuse, never silently degrade to unrestricted selection
      // or reclassify itself legacy.
      delete flow[1]!.skillPolicy;

      const attemptId = await startKafuo(governedContext(flow));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_POLICY_REQUIRED');
      expect(row.error_retryable).toBe(false);
      expect(row.version_id).toBeNull();
      // Nothing past the gate: no Scene content, no reserved Stage.
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
      const stages = await pool.query(`SELECT count(*)::int AS n FROM stage_meta`);
      expect(stages.rows[0]!.n).toBe(0);
      // Configuration faults are terminal — the run budget is not spent re-rolling.
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    });

    it('governed + unresolvable exact version: refuses SKILL_VERSION_UNRESOLVED, never substitutes', async () => {
      const flow: TeachingFlowEntry[] = [
        {
          stage: 'lesson_introduction',
          instructions: 'i',
          skillPolicy: policy({
            preferred: [{ skillId: 'feynman-learning', version: 'v99' }],
            allowed: [
              { skillId: 'feynman-learning', version: 'v99' },
              { skillId: 'learning-to-learn', version: 'v1' },
            ],
          }),
        },
        { stage: 'outcome_teaching_cards', instructions: 'c', skillPolicy: policy() },
      ];

      const attemptId = await startKafuo(governedContext(flow));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_VERSION_UNRESOLVED');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    });

    it('governed + unknown identity: refuses SKILL_NOT_FOUND', async () => {
      const flow: TeachingFlowEntry[] = [
        {
          stage: 'lesson_introduction',
          instructions: 'i',
          skillPolicy: policy({
            preferred: [{ skillId: 'no-such-canonical-skill', version: 'v1' }],
            allowed: [
              { skillId: 'no-such-canonical-skill', version: 'v1' },
              { skillId: 'learning-to-learn', version: 'v1' },
            ],
          }),
        },
        { stage: 'outcome_teaching_cards', instructions: 'c', skillPolicy: policy() },
      ];

      const attemptId = await startKafuo(governedContext(flow));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_NOT_FOUND');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('governed + complete resolvable policy: generates normally — landing is not activation', async () => {
      // W8 lands the enforcement infrastructure only; governed traffic with a
      // valid policy still generates exactly as before until W10 adds selection.
      const attemptId = await startKafuo(governedContext());
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('succeeded');
      expect(row.version_id).toMatch(/^tpv-/);
      expect(mocks.sceneGenerationReached).toHaveBeenCalledTimes(1);
    });

    it('tier B — Kafuo flow WITHOUT the marker still generates with no policy on any entry', async () => {
      // kafuoContext() defaults to tier B: contract null, FLOW carries no policy.
      // Explicitly pin that the absence of the marker keeps the legacy path open.
      const attemptId = await startKafuo(kafuoContext());
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('succeeded');
      expect(mocks.sceneGenerationReached).toHaveBeenCalledTimes(1);
      expect(kafuoContext().teachingFlow.every((entry) => entry.skillPolicy === undefined)).toBe(
        true,
      );
    });

    it('tier A — non-Kafuo legacy generation (no flow, no context) is untouched', async () => {
      const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
      const runner = await freshModules();
      const started = await startGenerationAttempt(txPool(), {
        tenantId: 'tenant-k',
        learningItem: { type: 'lesson', id: `li-a-${randomUUID()}` },
        teachingModel: { key: 'g5', version: 'g5.v1' },
        generation: { requirement: 'legacy requirement, no teaching flow' },
        actorRef: 'actor-1',
      });
      await runner.runGenerationAttempt(started.attempt.id, started.execution);

      const row = await attemptRow(started.attempt.id);
      expect(row.status).toBe('succeeded');
      expect(row.version_id).toMatch(/^tpv-/);
      expect(mocks.sceneGenerationReached).toHaveBeenCalledTimes(1);
    });
  });

  describe('teaching skills selection at the Stage-1 gate (Module 2 W10)', () => {
    /**
     * The W10 prohibitions are enforced by CODE inside `options.validateOutlines`
     * — invented identity, out-of-policy selection, unsatisfied required
     * scope/role — never by prompt wording alone (VAL-TS-001/004/005,
     * BR-TS-048/011). Preferred guides and never binds: omitting a preferred
     * Skill is legal end-to-end.
     */

    const policy = (overrides: Partial<TeachingSkillPolicy> = {}): TeachingSkillPolicy => ({
      required: [],
      preferred: [{ skillId: 'feynman-learning', version: 'v1' }],
      allowed: [
        { skillId: 'feynman-learning', version: 'v1' },
        { skillId: 'learning-to-learn', version: 'v1' },
      ],
      combinationRestrictions: [],
      ...overrides,
    });

    const governedFlow = (flowPolicy: () => TeachingSkillPolicy): TeachingFlowEntry[] => [
      { stage: 'lesson_introduction', instructions: 'i', skillPolicy: flowPolicy() },
      { stage: 'outcome_teaching_cards', instructions: 'c', skillPolicy: flowPolicy() },
    ];

    function governedContext(flow: TeachingFlowEntry[]) {
      return {
        ...kafuoContext(),
        teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
        teachingFlow: flow,
      };
    }

    async function attemptRow(attemptId: string) {
      const row = await pool.query<{
        status: string;
        error_code: string | null;
        error_retryable: boolean | null;
        version_id: string | null;
      }>(
        `SELECT status, error_code, error_retryable, version_id
           FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      return row.rows[0]!;
    }

    /** A run whose outlines carry the `teachingSkills` selections the test dictates. */
    function mockGenerateWithSelections(
      selections: Array<
        | {
            classification?: string;
            primary?: { skillId: string; version: string };
            supporting?: Array<{ skillId: string; version: string }>;
          }
        | undefined
      >,
    ) {
      mocks.generateClassroom.mockImplementation(async (_execution, options) => {
        const outlines = FLOW.map((_, index) => ({
          ...flowOutline(index + 1, index),
          ...(selections[index] ? { teachingSkills: selections[index] } : {}),
        }));
        await options.validateOutlines?.(outlines);
        mocks.sceneGenerationReached();
        const reserved = await options.persistence.reserve((id: string) => ({
          id,
          name: 'Generated',
          createdAt: 1,
          updatedAt: 1,
        }));
        const scenes = FLOW.map((_, index) => flowScene(index + 1, index));
        scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
        mocks.persistedOutlines.push(outlines as never);
        await options.persistence.persist(
          {
            id: reserved.id,
            stage: reserved.stage,
            scenes: scenes as never,
            outlines: outlines as never,
          },
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

    it('governed + out-of-policy selection: refuses SKILL_ASSIGNMENT_INVALID with no Stage, Scene, or re-roll', async () => {
      // lecture-style resolves in the live catalog but is not in the position's
      // permitted set — the unrestricted catalog is never a fallback (BR-TS-048).
      mockGenerateWithSelections([
        {
          classification: 'instructional',
          primary: { skillId: 'lecture-style', version: 'v1' },
        },
        undefined,
      ]);

      const attemptId = await startKafuo(governedContext(governedFlow(() => policy())));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_ASSIGNMENT_INVALID');
      expect(row.error_retryable).toBe(false);
      expect(row.version_id).toBeNull();
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
      const stages = await pool.query(`SELECT count(*)::int AS n FROM stage_meta`);
      expect(stages.rows[0]!.n).toBe(0);
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    });

    it('governed + invented identity: refuses SKILL_NOT_FOUND from the selection itself', async () => {
      mockGenerateWithSelections([
        undefined,
        {
          classification: 'instructional',
          primary: { skillId: 'made-up-pedagogy', version: 'v1' },
        },
      ]);

      const attemptId = await startKafuo(governedContext(governedFlow(() => policy())));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_NOT_FOUND');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('governed + unresolvable exact version on a selection: refuses SKILL_VERSION_UNRESOLVED, never substitutes', async () => {
      mockGenerateWithSelections([
        undefined,
        {
          classification: 'instructional',
          primary: { skillId: 'feynman-learning', version: 'v99' },
        },
      ]);

      const attemptId = await startKafuo(governedContext(governedFlow(() => policy())));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_VERSION_UNRESOLVED');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('governed + required scope/role ignored: refuses SKILL_REQUIREMENT_UNSATISFIED', async () => {
      // Position 1 requires feynman as primary somewhere in the position; the
      // only selection there is learning-to-learn as primary — permitted, but
      // the required rule is unsatisfied (VAL-TS-005: preferred-legal is not
      // required-satisfied).
      mockGenerateWithSelections([
        undefined,
        {
          classification: 'instructional',
          primary: { skillId: 'learning-to-learn', version: 'v1' },
        },
      ]);

      const attemptId = await startKafuo(
        governedContext(
          governedFlow(() =>
            policy({
              required: [
                {
                  skill: { skillId: 'feynman-learning', version: 'v1' },
                  scope: 'flow_position',
                  role: 'primary',
                },
              ],
            }),
          ),
        ),
      );
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('SKILL_REQUIREMENT_UNSATISFIED');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('governed + legal selection with the preferred Skill OMITTED: generates and persists the carriers', async () => {
      // BR-TS-011 pinned end-to-end: preferred guides, it does not bind. The
      // PRIMARY selection at every position is a permitted Skill that is NOT
      // the preferred one, the one required rule (supporting, scoped to
      // position 1 only) is satisfied there, and the run succeeds with the
      // selections on the persisted outlines.
      mockGenerateWithSelections([
        {
          classification: 'instructional',
          primary: { skillId: 'learning-to-learn', version: 'v1' },
        },
        {
          classification: 'instructional',
          primary: { skillId: 'learning-to-learn', version: 'v1' },
          supporting: [{ skillId: 'feynman-learning', version: 'v1' }],
        },
      ]);

      const flow: TeachingFlowEntry[] = [
        { stage: 'lesson_introduction', instructions: 'i', skillPolicy: policy() },
        {
          stage: 'outcome_teaching_cards',
          instructions: 'c',
          skillPolicy: policy({
            required: [
              {
                skill: { skillId: 'feynman-learning', version: 'v1' },
                scope: 'flow_position',
                role: 'supporting',
              },
            ],
          }),
        },
      ];

      const attemptId = await startKafuo(governedContext(flow));
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('succeeded');
      expect(row.version_id).toMatch(/^tpv-/);
      expect(mocks.sceneGenerationReached).toHaveBeenCalledTimes(1);
      const persisted = mocks.persistedOutlines[0] as Array<{
        teachingSkills?: { primary?: { skillId: string } };
      }>;
      expect(persisted?.[1]?.teachingSkills?.primary?.skillId).toBe('learning-to-learn');
    });

    it('tier B — selections without governance pass through untouched (no marker, no gate)', async () => {
      // Without the marker the assembled validator never runs: a tier-B run
      // carrying outline selections is legacy behavior, byte-for-byte.
      mockGenerateWithSelections([
        { classification: 'instructional', primary: { skillId: 'lecture-style', version: 'v1' } },
        undefined,
      ]);

      const attemptId = await startKafuo(kafuoContext());
      const row = await attemptRow(attemptId);

      expect(row.status).toBe('succeeded');
      expect(mocks.sceneGenerationReached).toHaveBeenCalledTimes(1);
    });
  });
});
