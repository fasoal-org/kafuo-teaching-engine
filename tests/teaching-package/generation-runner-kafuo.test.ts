import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import type { OutlineDiagnostic } from '@openmaic/generation';

import type { AppScene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
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

/**
 * The two Stage-1 gates exactly where the real `generateClassroom` runs them —
 * after outlines, BEFORE `reserve`: the authority gate (`validateOutlines`,
 * throws), then the admin-correction checkpoint (slide-classification-admin-
 * correction-plan §3.2): app-authority findings (Content-Unit grounding,
 * Teaching Skill selections) pause the attempt instead of failing it. The
 * error class is imported here, at call time, so it is the instance the
 * freshly imported runner checks against.
 */
async function outlineGates(
  options: {
    validateOutlines?: (outlines: never) => unknown;
    correction?: { collectOutlineIssues?: (outlines: never) => unknown };
  },
  outlines: unknown[],
) {
  await options.validateOutlines?.(outlines as never);
  const issues = ((await options.correction?.collectOutlineIssues?.(outlines as never)) ??
    []) as import('@openmaic/generation').OutlineDiagnostic[];
  if (issues.length > 0) {
    const { GenerationCorrectionRequiredError } =
      await import('@/lib/server/teaching-package/outline-correction');
    throw new GenerationCorrectionRequiredError({
      phase: 'outline',
      outlines: outlines as never,
      courseTitle: null,
      languageDirective: '',
      diagnostics: issues,
      repairs: [],
    });
  }
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
    await outlineGates(options, outlines);
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
    await outlineGates(options, outlines);
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
    teachingModel: { key: 'g5', version: 'g5.v1' },
    learningObjectives: [{ objectiveRef: 'o1', snapshot: { statement: 's' } }],
    requirement: 'req',
    language: 'ar',
    contentResource: {
      id: 'cs-1',
      url: 'https://r2.example.test/lesson.pdf?sig=abc',
      mimeType: 'application/pdf',
    } satisfies KafuoContentResource,
    generation: {},
    versionId: null,
    // Kafuo R1 P4: the default routing mode is `enforced`, so every Kafuo
    // context carries a routed subject unless a test says otherwise.
    subjectCode: 'MATH',
    subjectOffering: {
      id: '10',
      name: 'Math',
      code: 'MATH',
      nameAr: 'الرياضيات',
      nameEn: 'Math',
      academicLanguage: 'ar',
    },
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

/** The admin-correction checkpoint a paused attempt persisted (plan §3.1). */
async function checkpointOf(
  pool: { query: PGlitePool['query'] },
  attemptId: string,
): Promise<{
  phase: string;
  state: string;
  revision: number;
  diagnostics: Array<{ code: string; field?: string; message: string; allowedValues?: unknown[] }>;
}> {
  const result = await pool.query<{
    phase: string;
    state: string;
    revision: number;
    diagnostics: unknown;
  }>(
    `SELECT phase, state, revision, diagnostics
       FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
    [attemptId],
  );
  const row = result.rows[0]!;
  return { ...row, diagnostics: row.diagnostics as never };
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

  it('hands generation the configured narration route only when the request carried one', async () => {
    const ttsRoute = {
      routeId: 'configured' as const,
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voiceId: '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72',
      language: 'ar' as const,
      settingKey: 'teaching_tts.route.MATH',
    };
    await startKafuo({ ...kafuoContext(), ttsRoute });
    expect(mocks.generateClassroom.mock.calls[0]![0]).toMatchObject({ ttsRoute });
    mocks.generateClassroom.mockClear();
    await startKafuo();
    expect(mocks.generateClassroom.mock.calls[0]![0]).not.toHaveProperty('ttsRoute');
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
    // The runner hands generation the lesson's authoritative language.
    expect(mocks.generateClassroom.mock.calls[0]![0]).toMatchObject({ language: 'ar' });
    // …and its authoritative subject code, which generation stamps on the Stage.
    expect(mocks.generateClassroom.mock.calls[0]![0]).toMatchObject({ subjectCode: 'MATH' });
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

  it('records the server spoken-language register policy on the attempt before generation', async () => {
    const attemptId = await startKafuo();
    const { resolveSpeechRegisterPolicy } = await import('@/lib/server/speech/register-policy');
    const policy = resolveSpeechRegisterPolicy({ language: 'ar', subjectCode: 'MATH' })!;
    const raw = await pool.query(
      `SELECT input_snapshot->'speechRegister' AS r FROM teaching_package_generation_attempts WHERE id = $1`,
      [attemptId],
    );
    const recorded = (raw.rows[0] as { r: unknown }).r;
    expect(typeof recorded === 'string' ? JSON.parse(recorded) : recorded).toEqual({
      policyVersion: policy.version,
      register: 'saudi-white-spoken',
      directiveDigest: createHash('sha256').update(policy.directive, 'utf8').digest('hex'),
    });
  });

  it('D-18: real admission keeps the pin record, so the 202 and its replay echo it', async () => {
    const context = kafuoContext();
    const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
    const { readAttemptByRequestId } = await import('@/lib/persistence/teaching-package');
    const { routePinEchoOf } = await import('@/lib/server/teaching-package/original-route-pin');
    const requestId = `kafuo-pin-${randomUUID()}`;
    const started = await startGenerationAttempt(txPool(), {
      tenantId: context.aggregate.tenantId,
      learningItem: context.aggregate.learningItem,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      generation: { requirement: 'req', teachingFlow: FLOW },
      actorRef: 'actor-1',
      requestId,
      requestDigest: 'a'.repeat(64),
      teachingFlow: FLOW,
      contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      // Admission does not check the pin itself (the route resolved it already).
      routePin: { mode: 'original', sourceAttemptId: 'tpa-x' },
    });
    const echo = { applied: 'original', sourceAttemptId: 'tpa-x' };
    expect(routePinEchoOf(started.attempt)).toEqual(echo);
    // The replay lookup the route answers with reads the same record back.
    const replayed = await readAttemptByRequestId(txPool(), context.aggregate, requestId);
    expect(routePinEchoOf(replayed)).toEqual(echo);
    // An unpinned attempt echoes nothing.
    expect(
      routePinEchoOf({ inputSnapshot: { ...started.attempt.inputSnapshot, routePin: undefined } }),
    ).toBeNull();
  });

  it('records the engine build that ran the attempt (S5.5 / G4), NULL when the image carries none', async () => {
    vi.stubEnv('KAFUO_BUILD_SHA', 'FCE7B150AABBCCDDEEFF00112233445566778899');
    const attemptId = await startKafuo();
    const build = async (id: string) => {
      const raw = await pool.query(
        `SELECT input_snapshot->'engineBuild' AS b, input_snapshot->'resumeEngineBuild' AS r
           FROM teaching_package_generation_attempts WHERE id = $1`,
        [id],
      );
      const row = raw.rows[0] as { b: unknown; r: unknown };
      const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
      return { first: parse(row.b), resumed: parse(row.r) };
    };
    expect(await build(attemptId)).toEqual({
      first: { sha: 'fce7b150aabbccddeeff00112233445566778899' },
      resumed: null,
    });
    const { engineBuildSha } = await import('@/lib/server/teaching-package/generation');
    vi.stubEnv('KAFUO_BUILD_SHA', 'not a sha');
    expect(engineBuildSha()).toBeNull();
    vi.stubEnv('KAFUO_BUILD_SHA', '');
    expect(engineBuildSha()).toBeNull();
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

  it('does not replay the full classroom after an invalid flow', async () => {
    let call = 0;
    mocks.generateClassroom.mockImplementation(async (_execution, options) => {
      call += 1;
      const reserved = await options.persistence.reserve((id: string) => ({
        id,
        name: 'G',
        createdAt: 1,
        updatedAt: 1,
      }));
      // A hypothetical second call would be valid, but the full-classroom
      // budget is exactly one so it must never be reached.
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
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('TEACHING_MODEL_FLOW_MISMATCH');
    expect(after.generationRuns).toBe(1);
    expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    // The invalid run's stage was compensated (tombstoned + media removed).
    const live = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
    );
    expect((live.rows[0] as { n: number }).n).toBe(0);
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
    expect(after.generationRuns).toBe(1);
    // No live stage survived compensation.
    const live = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
    );
    expect((live.rows[0] as { n: number }).n).toBe(0);
  });

  it('cleans a thrown run’s media directory without replaying the classroom', async () => {
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
    expect(after.status).toBe('failed');
    expect(after.generationRuns).toBe(1);
    expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    // The thrown run's stage directory was removed; no replay directory exists.
    const entries = await fs.readdir(tmp);
    expect(entries).toEqual([]);
  });

  it('keeps the previous usable stage when a regeneration fails', async () => {
    // First: a valid initial generation.
    const attemptId = await startKafuo();
    const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');
    const first = (await readAttemptById(qp(), attemptId))!;
    const versionId = first.versionId!;
    const before = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
    const stageBefore = before.currentStageId;
    // W6.6 (TAE-RQ-028/030): snapshot the predecessor document BEFORE the
    // failing regen runs — Scenes, Actions and lineage carriers byte-for-byte.
    // loadDocument migrates on read, so both comparison sides are loads.
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    const documentBefore = (await store.loadDocument(stageBefore))!;
    expect(documentBefore.scenes.length).toBeGreaterThan(0);
    expect(
      documentBefore.scenes.some((scene) => scene.teachingStage !== undefined),
      'the seeded predecessor carries flow lineage to compare against',
    ).toBe(true);

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
    const documentAfter = (await store.loadDocument(stageBefore))!;
    expect(JSON.stringify(documentAfter)).toBe(JSON.stringify(documentBefore));
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

    it('hands Scene generation the retained Content Units’ own text', async () => {
      const source = normalizedSourceWithManifest();
      mocks.acquireNormalizedContentResource.mockResolvedValue({
        ...source,
        manifest: {
          contentUnits: [
            {
              id: '2900',
              orderIndex: 0,
              role: 'CONCEPT_EXPLANATION',
              title: 'Pressure',
              normalizedText: 'Pressure is force per unit area.',
              blocks: [{ id: '51234' }],
            },
          ],
        },
      });
      mockGenerateWithCitations({ sourceContentUnitIds: ['2900'] });

      await startKafuo(normalizedKafuoContext());

      const execution = mocks.generateClassroom.mock.calls[0]![0] as {
        sourceUnits?: Array<{ id: string; title: string | null; text: string }>;
      };
      expect(execution.sourceUnits).toEqual([
        { id: '2900', title: 'Pressure', text: 'Pressure is force per unit area.' },
      ]);
    });

    it('leaves the non-normalized PDF path without the grounding contract', async () => {
      mockValidRun();

      await startKafuo(kafuoContext());

      const execution = mocks.generateClassroom.mock.calls[0]![0] as {
        normalizedGrounding?: boolean;
        sourceUnits?: unknown;
      };
      expect(execution.normalizedGrounding).toBeUndefined();
      expect(execution.sourceUnits).toBeUndefined();
    });

    it('refuses ids that name nothing in the manifest', async () => {
      /* The check the normalization must not throw away: a hallucinated citation is still
         ungrounded, whatever its JSON type. Since the admin-correction plan (§2.4) the
         grounding is admin-correctable: the attempt pauses for a person instead of failing. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]).toMatchObject({ status: 'awaiting_admin_correction', error_code: null });
      const checkpoint = await checkpointOf(pool, attemptId);
      expect(checkpoint).toMatchObject({ phase: 'outline', state: 'awaiting', revision: 1 });
      expect(checkpoint.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'GROUNDING_UNKNOWN',
        'GROUNDING_UNKNOWN',
      ]);
    });

    it('refuses an outline that cites nothing at all', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]).toMatchObject({ status: 'awaiting_admin_correction', error_code: null });
      const checkpoint = await checkpointOf(pool, attemptId);
      expect(checkpoint.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'GROUNDING_MISSING',
        'GROUNDING_MISSING',
      ]);
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
      expect(row.rows[0]).toMatchObject({ status: 'awaiting_admin_correction', error_code: null });
      const checkpoint = await checkpointOf(pool, attemptId);
      expect(
        checkpoint.diagnostics.every(
          (diagnostic) =>
            diagnostic.code === 'GROUNDING_MISSING' &&
            diagnostic.field === 'sourceContentUnitIds' &&
            diagnostic.message.includes('sourceContentUnitIds missing'),
        ),
      ).toBe(true);
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

    it('defaults to one full generation run on a grounding miss', async () => {
      /* A structural model-output miss must not replay the whole classroom by
         default. Cheap corrective outline re-rolls live inside that one run. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const row = await pool.query(
        `SELECT generation_runs FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      expect(Number(row.rows[0]!.generation_runs)).toBe(1);
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
      // ...and the rejected run produced no Scene content.
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('records the rejected citations and what the manifest offered', async () => {
      /* The refusal used to be diagnosable only from a log line because the run's
         compensation discarded the outlines. A paused attempt now KEEPS them: the
         checkpoint carries the offending values and the ids an administrator may choose. */
      mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSourceWithManifest());
      mockGenerateWithCitations({ sourceContentUnitIds: [9999] });

      const attemptId = await startKafuo(normalizedKafuoContext());

      const logged = mocks.logWarn.mock.calls.flat().join(' ');
      expect(logged).toContain('paused for admin correction');
      const checkpoint = await checkpointOf(pool, attemptId);
      const [first] = checkpoint.diagnostics;
      expect(first!.message).toContain('9999');
      expect(first!.allowedValues).toEqual(['2900']);
      // Blocks are internal: the refusal never reports missing block grounding.
      expect(JSON.stringify(checkpoint.diagnostics)).not.toContain('sourceBlockIds');
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

    /** Paused (not failed) with one checkpoint diagnostic of `code` on the Skill field. */
    async function expectPausedFor(attemptId: string, code: string) {
      const row = await attemptRow(attemptId);
      expect(row).toMatchObject({
        status: 'awaiting_admin_correction',
        error_code: null,
        error_retryable: null,
      });
      const checkpoint = await checkpointOf(pool, attemptId);
      expect(checkpoint.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
      expect(
        checkpoint.diagnostics.every((diagnostic) => diagnostic.field === 'teachingSkills'),
      ).toBe(true);
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
        await outlineGates(options, outlines);
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

    it('governed + out-of-policy selection: pauses on SKILL_ASSIGNMENT_INVALID with no Stage, Scene, or re-roll', async () => {
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

      // A Skill SELECTION is the model's answer, not authority data: since the
      // admin-correction plan (§2.4) it pauses for a person instead of failing.
      await expectPausedFor(attemptId, 'SKILL_ASSIGNMENT_INVALID');
      expect(row.version_id).toBeNull();
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
      const stages = await pool.query(`SELECT count(*)::int AS n FROM stage_meta`);
      expect(stages.rows[0]!.n).toBe(0);
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    });

    it('governed + invented identity: pauses on SKILL_NOT_FOUND from the selection itself', async () => {
      mockGenerateWithSelections([
        undefined,
        {
          classification: 'instructional',
          primary: { skillId: 'made-up-pedagogy', version: 'v1' },
        },
      ]);

      const attemptId = await startKafuo(governedContext(governedFlow(() => policy())));
      const row = await attemptRow(attemptId);

      expect(row.version_id).toBeNull();
      await expectPausedFor(attemptId, 'SKILL_NOT_FOUND');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('governed + unresolvable exact version on a selection: pauses on SKILL_VERSION_UNRESOLVED, never substitutes', async () => {
      mockGenerateWithSelections([
        undefined,
        {
          classification: 'instructional',
          primary: { skillId: 'feynman-learning', version: 'v99' },
        },
      ]);

      const attemptId = await startKafuo(governedContext(governedFlow(() => policy())));
      const row = await attemptRow(attemptId);

      expect(row.version_id).toBeNull();
      await expectPausedFor(attemptId, 'SKILL_VERSION_UNRESOLVED');
      expect(mocks.sceneGenerationReached).not.toHaveBeenCalled();
    });

    it('governed + required scope/role ignored: pauses on SKILL_REQUIREMENT_UNSATISFIED', async () => {
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

      expect(row.version_id).toBeNull();
      await expectPausedFor(attemptId, 'SKILL_REQUIREMENT_UNSATISFIED');
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

  describe('Module 3/4 W2 — governed failure codes bind nothing', () => {
    /**
     * Level A (tests/server/classroom-generation-governed-failures.test.ts)
     * proves the REAL pipeline throws these codes under real model failure.
     * This level proves what the runner does with them: compensate every run,
     * re-roll within the bounded budget for the retryable pair, fail the
     * attempt with the code itself, and leave the version's bound Stage
     * untouched.
     */
    async function startFailingRegeneration(
      code:
        | 'GOVERNED_ACTION_GENERATION_FAILED'
        | 'GOVERNED_SCENE_GENERATION_FAILED'
        | 'GOVERNED_FLOW_CONTEXT_UNRESOLVED'
        | 'SPEECH_REGISTER_NONCOMPLIANT',
    ) {
      // First: a valid initial generation binds version 1.
      const attemptId = await startKafuo();
      const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');
      const first = (await readAttemptById(qp(), attemptId))!;
      const versionId = first.versionId!;
      const stageBefore = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!
        .currentStageId;

      // Then: a regeneration whose governed run reserves a Stage, writes
      // media, and refuses with the code under test.
      mocks.generateClassroom.mockReset();
      const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
      mocks.generateClassroom.mockImplementation(async (_execution, options) => {
        const reserved = await options.persistence.reserve((id: string) => ({
          id,
          name: 'G',
          createdAt: 1,
          updatedAt: 1,
        }));
        await fs.mkdir(path.join(tmp, reserved.id, 'media'), { recursive: true });
        await fs.writeFile(path.join(tmp, reserved.id, 'media', 'x.png'), PNG);
        throw new TeachingPackageError(code, `injected ${code} refusal`);
      });
      const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
      const runner = await freshModules();
      const regeneration = await startGenerationAttempt(txPool(), {
        tenantId: 'tenant-k',
        learningItem: first.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        generation: { requirement: 'again', teachingFlow: FLOW },
        versionId,
        actorRef: 'actor-2',
        requestId: `kafuo-w2-${randomUUID()}`,
        requestDigest: 'c'.repeat(64),
        teachingFlow: FLOW,
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      await runner.runGenerationAttempt(regeneration.attempt.id, regeneration.execution, {
        ...kafuoContext(),
        aggregate: { tenantId: 'tenant-k', learningItem: first.learningItem },
        versionId,
      });
      return { versionId, stageBefore, attemptId: regeneration.attempt.id };
    }

    it.each([
      ['GOVERNED_ACTION_GENERATION_FAILED', true],
      ['GOVERNED_SCENE_GENERATION_FAILED', true],
    ] as const)(
      '%s: attempt fails with its own code, compensates the run, keeps the bound Stage',
      async (code, _retryable) => {
        const { versionId, stageBefore, attemptId } = await startFailingRegeneration(code);
        const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');

        const version = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
        const failed = (await readAttemptById(qp(), attemptId))!;
        expect(failed.status).toBe('failed');
        expect(failed.errorCode).toBe(code);
        expect(failed.generationRuns).toBe(1);
        // Nothing new was bound: the version still points at the Stage the
        // valid initial generation bound.
        expect(version.currentStageId).toBe(stageBefore);
        // compensateRun ran on every failed run — no live stage survived
        // beyond the original binding...
        const live = await pool.query(
          `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
        );
        expect((live.rows[0] as { n: number }).n).toBe(1);
        // ...and every failed run's media directory was removed.
        const entries = await fs.readdir(tmp);
        expect(entries).toHaveLength(0);
      },
    );

    it('GOVERNED_FLOW_CONTEXT_UNRESOLVED stays NON-retryable: one run, then the attempt fails', async () => {
      const { versionId, stageBefore, attemptId } = await startFailingRegeneration(
        'GOVERNED_FLOW_CONTEXT_UNRESOLVED',
      );
      const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');

      const version = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
      const failed = (await readAttemptById(qp(), attemptId))!;
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('GOVERNED_FLOW_CONTEXT_UNRESOLVED');
      // An unresolvable authoritative context is a bad request: exactly one
      // run was spent, never re-rolled open.
      expect(failed.generationRuns).toBe(1);
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
      expect(version.currentStageId).toBe(stageBefore);
    });
  });

  describe('spoken-language register policy failures stay scene-scoped', () => {
    it('SPEECH_REGISTER_NONCOMPLIANT is NON-retryable at the attempt level: one run, no package re-roll', async () => {
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      const attemptId = await startKafuo();
      const first = (await readAttemptById(qp(), attemptId))!;
      mocks.generateClassroom.mockReset();
      const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
      mocks.generateClassroom.mockImplementation(async () => {
        throw new TeachingPackageError(
          'SPEECH_REGISTER_NONCOMPLIANT',
          'scene narration still breaks the saudi-white-spoken register policy after 3 attempts',
        );
      });
      const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
      const generationRunner = await freshModules();
      const regeneration = await startGenerationAttempt(txPool(), {
        tenantId: 'tenant-k',
        learningItem: first.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        generation: { requirement: 'again', teachingFlow: FLOW },
        versionId: first.versionId!,
        actorRef: 'actor-2',
        requestId: `kafuo-register-${randomUUID()}`,
        requestDigest: 'd'.repeat(64),
        teachingFlow: FLOW,
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      await generationRunner.runGenerationAttempt(regeneration.attempt.id, regeneration.execution, {
        ...kafuoContext(),
        aggregate: { tenantId: 'tenant-k', learningItem: first.learningItem },
        versionId: first.versionId!,
      });
      const failed = (await readAttemptById(qp(), regeneration.attempt.id))!;
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('SPEECH_REGISTER_NONCOMPLIANT');
      // The scene already spent its bounded re-rolls; the package is never regenerated.
      expect(failed.generationRuns).toBe(1);
      expect(mocks.generateClassroom).toHaveBeenCalledTimes(1);
    });
  });

  describe('Module 3/4 W3 — the canonical Action generation gate', () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

    /**
     * Scenes that pass exact-flow and carry the given actions on scene 1.
     * `scene1Type` picks the carrier: the write barrier's lenient unknown-type
     * path applies to interactive scenes (slide/quiz scenes validate Actions
     * through the strict DSL branch), while reference cases want a real slide
     * canvas to resolve against.
     */
    function scenesWithActions(
      actions: unknown[],
      scene1Type: 'slide' | 'interactive' = 'interactive',
    ): AppScene[] {
      const scenes = FLOW.map((_, index) => flowScene(index + 1, index));
      const first = scenes[0]!;
      (first as { actions?: unknown }).actions = actions;
      if (scene1Type === 'slide') {
        (first.content as { canvas?: { elements?: unknown[] } }).canvas = {
          ...((first.content as { canvas?: object }).canvas ?? {}),
          elements: [
            {
              id: 'el-text-1',
              type: 'text',
              content: 'Body',
              left: 0,
              top: 0,
              width: 100,
              height: 10,
            },
          ],
        };
      } else {
        (first as { type?: unknown }).type = 'interactive';
        (first as { content?: unknown }).content = {
          type: 'interactive',
          url: '',
          html: '<!DOCTYPE html><html><head></head><body></body></html>',
          widgetType: 'simulation',
          widgetConfig: {},
        };
      }
      return scenes;
    }

    /**
     * Bind version 1 with a valid governed generation, then run a governed
     * REGENERATION whose mock persists `runsActions` per run (last repeats).
     * `persist` false returns the result without writing the document — for
     * payloads the write barrier itself refuses (a structurally invalid
     * canonical Action on a slide), so the GATE can still be exercised.
     */
    async function regenerateWithActions(
      runsActions: readonly (readonly unknown[])[],
      caseOptions: { scene1Type?: 'slide' | 'interactive'; persist?: boolean } = {},
    ): Promise<{ versionId: string; stageBefore: string; attemptId: string }> {
      // The governed context's flow must carry Skill Policies — the Stage-1
      // gate (requireCompleteFlowPolicies) refuses a governed attempt without
      // them. Same stage keys as FLOW so the mocked scenes cover it exactly.
      const governedW3Flow: TeachingFlowEntry[] = FLOW.map((entry) => ({
        ...entry,
        skillPolicy: {
          required: [],
          preferred: [],
          allowed: [
            { skillId: 'feynman-learning', version: 'v1' },
            { skillId: 'learning-to-learn', version: 'v1' },
          ],
          combinationRestrictions: [],
        },
      }));
      const governedContext = {
        ...kafuoContext(),
        teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
        teachingFlow: governedW3Flow,
      };
      const attemptId = await startKafuo(governedContext);
      const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');
      const first = (await readAttemptById(qp(), attemptId))!;
      const versionId = first.versionId!;
      const stageBefore = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!
        .currentStageId;

      let call = 0;
      mocks.generateClassroom.mockReset();
      mocks.generateClassroom.mockImplementation(async (_execution, options) => {
        call += 1;
        const reserved = await options.persistence.reserve((id: string) => ({
          id,
          name: 'G',
          createdAt: 1,
          updatedAt: 1,
        }));
        await fs.mkdir(path.join(tmp, reserved.id, 'media'), { recursive: true });
        await fs.writeFile(path.join(tmp, reserved.id, 'media', 'x.png'), PNG);
        const actions = [...runsActions[Math.min(call - 1, runsActions.length - 1)]!];
        const scenes = scenesWithActions(actions, caseOptions.scene1Type ?? 'interactive');
        scenes.forEach((scene) => ((scene as { stageId?: string }).stageId = reserved.id));
        const outlines = FLOW.map((_, index) => flowOutline(index + 1, index));
        if (caseOptions.persist !== false) {
          await options.persistence.persist(
            {
              id: reserved.id,
              stage: reserved.stage,
              scenes: scenes as never,
              outlines: outlines as never,
            },
            options.baseUrl,
          );
        }
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
      const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
      const runner = await freshModules();
      const regeneration = await startGenerationAttempt(txPool(), {
        tenantId: 'tenant-k',
        learningItem: first.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        generation: { requirement: 'again', teachingFlow: FLOW },
        versionId,
        actorRef: 'actor-2',
        requestId: `kafuo-w3-${randomUUID()}`,
        requestDigest: 'd'.repeat(64),
        teachingFlow: FLOW,
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      await runner.runGenerationAttempt(regeneration.attempt.id, regeneration.execution, {
        ...governedContext,
        aggregate: { tenantId: 'tenant-k', learningItem: first.learningItem },
        versionId,
      });
      return { versionId, stageBefore, attemptId: regeneration.attempt.id };
    }

    it.each([
      [
        'an unknown Action type',
        [{ id: 'a-unknown', type: 'legacy_teleport' }],
        'ACTION_TYPE_UNKNOWN',
        // The write barrier's lenient unknown-type path is the interactive
        // branch — the persisted artifact reaches the gate for real.
        { scene1Type: 'interactive' as const },
      ],
      [
        'a structurally invalid canonical Action',
        [{ id: 'a-speech', type: 'speech' }],
        'ACTION_STRUCTURE_INVALID',
        // The write barrier refuses this payload on ANY scene kind (known
        // types run the DSL variant validation everywhere), so the run is
        // returned without persisting — the GATE is still what classifies it.
        { persist: false },
      ],
      [
        'a broken laser.elementId',
        [{ id: 'a-laser', type: 'laser', elementId: 'el-missing' }],
        'ACTION_REFERENCE_INVALID',
        // A variant-valid reference failure persists fine; the gate catches
        // what the barrier was never meant to.
        { scene1Type: 'slide' as const },
      ],
    ] as const)(
      'governed regeneration persisting %s fails the attempt, binds nothing, compensates',
      async (_label, actions, code, caseOptions) => {
        const { versionId, stageBefore, attemptId } = await regenerateWithActions(
          [actions],
          caseOptions,
        );
        const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');

        const failed = (await readAttemptById(qp(), attemptId))!;
        expect(failed.status).toBe('failed');
        expect(failed.errorCode).toBe(code);
        expect(failed.generationRuns).toBe(1);
        // Nothing new bound: the version still points at the valid Stage.
        const version = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
        expect(version.currentStageId).toBe(stageBefore);
        // compensateRun ran on every failed run — no live stage beyond the
        // original binding, and no media directory survived.
        const live = await pool.query(
          `SELECT COUNT(*)::int AS n FROM stage_meta WHERE deleted_at IS NULL`,
        );
        expect((live.rows[0] as { n: number }).n).toBe(1);
        expect(await fs.readdir(tmp)).toHaveLength(0);
      },
    );

    it('does not replay the classroom when a later hypothetical Action answer would be valid', async () => {
      const { versionId, stageBefore, attemptId } = await regenerateWithActions([
        [{ id: 'a-unknown', type: 'legacy_teleport' }],
        [{ id: 'a-ok', type: 'speech', text: 'Canonical.' }],
      ]);
      const { readAttemptById, readVersion } = await import('@/lib/persistence/teaching-package');

      const failed = (await readAttemptById(qp(), attemptId))!;
      expect(failed.status).toBe('failed');
      expect(failed.generationRuns).toBe(1);
      const version = (await readVersion(qp(), versionId, { tenantId: 'tenant-k' }))!;
      expect(version.currentStageId).toBe(stageBefore);
    });

    it('the legacy (non-Kafuo) binding path gained no gate', async () => {
      // Source pin: exactly ONE validateSceneActionStructure call site exists,
      // inside runKafuoAttempt — the legacy branch below runGenerationAttempt
      // never validates.
      const source = readFileSync(
        path.join(repoRoot, 'lib/server/teaching-package/generation-runner.ts'),
        'utf-8',
      );
      const callMatches = source.match(/validateSceneActionStructure\(/g) ?? [];
      expect(callMatches).toHaveLength(1);
      const splitAt = source.indexOf('export function runGenerationAttempt');
      const [kafuoHalf, legacyHalf] = [source.slice(0, splitAt), source.slice(splitAt)];
      expect(kafuoHalf).toContain('validateSceneActionStructure(');
      expect(legacyHalf).not.toContain('validateSceneActionStructure');
    });
  });

  describe('Kafuo R1 P4 — generation on the subject route', () => {
    const POLICY_CALLS = () =>
      mocks.resolveModel.mock.calls.map((call) => call[0] as Record<string, unknown>);

    async function snapshotOf(attemptId: string) {
      const raw = await pool.query<{
        input_snapshot: Record<string, unknown>;
        subject_code: string | null;
      }>(
        `SELECT input_snapshot, subject_code FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      return raw.rows[0]!;
    }

    it('resolves the subject policy ONCE before Layer A, records it on the attempt, and hands generation the policy + attribution', async () => {
      const attemptId = await startKafuo();
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      expect((await readAttemptById(qp(), attemptId))!.status).toBe('succeeded');

      // Exactly the policy pair, with NO stage: the stage route can never win.
      expect(POLICY_CALLS()).toEqual([
        { modelString: 'openai:gpt-6-luna' },
        { modelString: 'qwen:qwen3.7-flash' },
      ]);
      expect(POLICY_CALLS().some((call) => 'stage' in call)).toBe(false);

      // Snapshot: the route, not `resolvedLlmModel`; first-class subject_code.
      const row = await snapshotOf(attemptId);
      expect(row.subject_code).toBe('MATH');
      expect(row.input_snapshot).toMatchObject({
        subjectCode: 'MATH',
        policyVersion: 'r1-2026-09',
        primaryModel: 'openai:gpt-6-luna',
        fallbackModel: 'qwen:qwen3.7-flash',
      });
      expect(row.input_snapshot.resolvedLlmModel).toBeUndefined();
      // A table route freezes no configured route (teaching-generation-model plan D-10).
      expect(row.input_snapshot).not.toHaveProperty('generationRoute');

      // Execution input: the policy value + ledger attribution for run 1.
      const execution = mocks.generateClassroom.mock.calls[0]![0];
      expect(execution.modelPolicy).toMatchObject({
        subjectCode: 'MATH',
        primary: { role: 'primary', modelString: 'openai:gpt-6-luna' },
        fallback: { role: 'fallback', modelString: 'qwen:qwen3.7-flash' },
      });
      expect(execution.attribution).toEqual({
        tenantId: 'tenant-k',
        generationAttemptId: attemptId,
        generationRun: 1,
        learningItemType: 'lesson',
        learningItemId: expect.stringMatching(/^li-k-/),
      });
    });

    it('resolves the policy once per attempt and attributes the single full run', async () => {
      let call = 0;
      mocks.generateClassroom.mockImplementation(async (_execution, options) => {
        call += 1;
        const reserved = await options.persistence.reserve((id: string) => ({
          id,
          name: 'G',
          createdAt: 1,
          updatedAt: 1,
        }));
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
      expect((await readAttemptById(qp(), attemptId))!.generationRuns).toBe(1);
      expect(POLICY_CALLS()).toHaveLength(2);
      const runs = mocks.generateClassroom.mock.calls.map((c) => c[0].attribution.generationRun);
      expect(runs).toEqual([1]);
    });

    it.each([
      ['a null code (unrouted master subject)', null],
      ['a code outside the policy table', 'FRENCH'],
    ])(
      '%s fails the attempt with SUBJECT_ROUTE_UNAVAILABLE: no Layer A, no run, no version',
      async (_label, subjectCode) => {
        const attemptId = await startKafuo({ ...kafuoContext(), subjectCode });
        const { readAttemptById } = await import('@/lib/persistence/teaching-package');
        const after = (await readAttemptById(qp(), attemptId))!;
        expect(after.status).toBe('failed');
        expect(after.errorCode).toBe('SUBJECT_ROUTE_UNAVAILABLE');
        expect(after.errorRetryable).toBe(false);
        expect(after.versionId).toBeNull();
        expect(mocks.acquireContentResource).not.toHaveBeenCalled();
        expect(mocks.generateClassroom).not.toHaveBeenCalled();
        expect(mocks.resolveModel).not.toHaveBeenCalled();
        const versions = await pool.query(
          `SELECT COUNT(*)::int AS n FROM teaching_package_versions`,
        );
        expect((versions.rows[0] as { n: number }).n).toBe(0);
        expect((await snapshotOf(attemptId)).subject_code).toBeNull();
      },
    );

    it('a policy target the registry cannot resolve fails the attempt the same way — never DEFAULT_MODEL', async () => {
      mocks.resolveModel.mockRejectedValue(new Error('qwen: no API key configured'));
      const attemptId = await startKafuo();
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttemptById(qp(), attemptId))!;
      expect(after.status).toBe('failed');
      expect(after.errorCode).toBe('SUBJECT_ROUTE_UNAVAILABLE');
      expect(mocks.acquireContentResource).not.toHaveBeenCalled();
      expect(mocks.generateClassroom).not.toHaveBeenCalled();
    });

    describe('a superadmin-configured route (teaching-generation-model plan D-10, D-11)', () => {
      const ROUTE = {
        primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
        fallback: { model: 'qwen:qwen4-max', thinking: 'on' },
        settingKey: 'teaching_generation.route.MATH',
      };

      it('resolves the configured pair instead of the table, hands it down, and freezes it on the attempt', async () => {
        const attemptId = await startKafuo({ ...kafuoContext(), modelRoute: ROUTE });
        const { readAttemptById, readRetainedVersionContext } =
          await import('@/lib/persistence/teaching-package');
        const attempt = (await readAttemptById(qp(), attemptId))!;
        expect(attempt.status).toBe('succeeded');

        // Exactly the configured pair, still with NO stage.
        expect(POLICY_CALLS()).toEqual([
          { modelString: 'openai:gpt-6.1-terra' },
          { modelString: 'qwen:qwen4-max' },
        ]);

        const execution = mocks.generateClassroom.mock.calls[0]![0];
        expect(execution.modelPolicy).toMatchObject({
          subjectCode: 'MATH',
          policyVersion: 'configured-2026-11',
          primary: {
            modelString: 'openai:gpt-6.1-terra',
            thinking: { mode: 'enabled', effort: 'medium' },
            thinkingLabel: 'medium',
          },
          fallback: {
            modelString: 'qwen:qwen4-max',
            thinking: { mode: 'enabled' },
            thinkingLabel: 'on',
          },
        });

        // Frozen on the snapshot beside the subject route (D-10) ...
        const row = await snapshotOf(attemptId);
        expect(row.subject_code).toBe('MATH');
        expect(row.input_snapshot).toMatchObject({
          subjectCode: 'MATH',
          policyVersion: 'configured-2026-11',
          primaryModel: 'openai:gpt-6.1-terra',
          fallbackModel: 'qwen:qwen4-max',
          generationRoute: ROUTE,
        });
        // ... and it survives the read paths the later steps use (write → read).
        expect(attempt.inputSnapshot.generationRoute).toEqual(ROUTE);
        const retained = await readRetainedVersionContext(qp(), attempt.versionId!, {
          tenantId: 'tenant-k',
        });
        expect(retained?.attemptId).toBe(attemptId);
        expect(retained?.inputSnapshot.generationRoute).toEqual(ROUTE);
      });

      it('a planning route (§3c) is resolved as its own policy, handed down as planPolicy, and frozen beside the generation route', async () => {
        const PLAN = {
          primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
          fallback: { model: 'openai:gpt-6-luna', thinking: 'low' },
          settingKey: 'teaching_generation.plan_route.MATH',
        };
        const attemptId = await startKafuo({
          ...kafuoContext(),
          modelRoute: ROUTE,
          planRoute: PLAN,
        });
        const { readAttemptById, readRetainedVersionContext } =
          await import('@/lib/persistence/teaching-package');
        const attempt = (await readAttemptById(qp(), attemptId))!;
        expect(attempt.status).toBe('succeeded');
        expect(POLICY_CALLS()).toEqual([
          { modelString: 'openai:gpt-6.1-terra' },
          { modelString: 'qwen:qwen4-max' },
          { modelString: 'anthropic:claude-opus-5-5' },
          { modelString: 'openai:gpt-6-luna' },
        ]);
        const execution = mocks.generateClassroom.mock.calls[0]![0];
        expect(execution.modelPolicy.primary.modelString).toBe('openai:gpt-6.1-terra');
        expect(execution.planPolicy).toMatchObject({
          subjectCode: 'MATH',
          policyVersion: 'configured-2026-11',
          primary: {
            modelString: 'anthropic:claude-opus-5-5',
            thinking: { mode: 'enabled', effort: 'high' },
            thinkingLabel: 'high',
          },
          fallback: { modelString: 'openai:gpt-6-luna', thinkingLabel: 'low' },
        });
        const row = await snapshotOf(attemptId);
        expect(row.input_snapshot).toMatchObject({ generationRoute: ROUTE, planRoute: PLAN });
        expect(attempt.inputSnapshot.planRoute).toEqual(PLAN);
        const retained = await readRetainedVersionContext(qp(), attempt.versionId!, {
          tenantId: 'tenant-k',
        });
        expect(retained?.inputSnapshot.planRoute).toEqual(PLAN);
      });

      it('no planning route: no planPolicy is handed down and nothing is frozen (planning follows the generation route)', async () => {
        const attemptId = await startKafuo({ ...kafuoContext(), modelRoute: ROUTE });
        const execution = mocks.generateClassroom.mock.calls[0]![0];
        expect(execution).not.toHaveProperty('planPolicy');
        expect((await snapshotOf(attemptId)).input_snapshot).not.toHaveProperty('planRoute');
      });

      it('a planning target the registry cannot resolve fails the attempt closed, like the generation route', async () => {
        mocks.resolveModel.mockImplementation(async (params: { modelString?: string }) => {
          if (params.modelString === 'anthropic:claude-opus-5-5') {
            throw new Error('anthropic: no API key configured');
          }
          return { model: { id: 'm' }, modelInfo: { capabilities: { vision: true } } };
        });
        const attemptId = await startKafuo({
          ...kafuoContext(),
          planRoute: {
            primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
            fallback: { model: 'openai:gpt-6-luna', thinking: 'low' },
            settingKey: 'teaching_generation.plan_route.MATH',
          },
        });
        const { readAttemptById } = await import('@/lib/persistence/teaching-package');
        const after = (await readAttemptById(qp(), attemptId))!;
        expect(after.status).toBe('failed');
        expect(after.errorCode).toBe('SUBJECT_ROUTE_UNAVAILABLE');
        expect(mocks.generateClassroom).not.toHaveBeenCalled();
        expect((await snapshotOf(attemptId)).input_snapshot).not.toHaveProperty('planRoute');
      });

      it('a stored route of the wrong shape reads as absent with a warning, never a crash', async () => {
        const attemptId = await startKafuo({ ...kafuoContext(), modelRoute: ROUTE });
        await pool.query(
          `UPDATE teaching_package_generation_attempts
              SET input_snapshot = jsonb_set(input_snapshot, '{generationRoute}', '{"primary":"openai:gpt-6-sol"}'::jsonb)
            WHERE id = $1`,
          [attemptId],
        );
        mocks.logWarn.mockClear();
        const { readAttemptById, readRetainedVersionContext } =
          await import('@/lib/persistence/teaching-package');
        const attempt = (await readAttemptById(qp(), attemptId))!;
        expect(attempt.inputSnapshot).not.toHaveProperty('generationRoute');
        expect(attempt.inputSnapshot.subjectCode).toBe('MATH');
        const retained = await readRetainedVersionContext(qp(), attempt.versionId!, {
          tenantId: 'tenant-k',
        });
        expect(retained?.inputSnapshot).not.toHaveProperty('generationRoute');
        expect(mocks.logWarn).toHaveBeenCalledWith(
          expect.stringContaining('generationRoute is malformed'),
        );
      });

      it('a configured target the registry cannot resolve fails the attempt closed — never the table', async () => {
        mocks.resolveModel.mockImplementation(async (params: { modelString?: string }) => {
          if (params.modelString === 'openai:gpt-6.1-terra') {
            throw new Error('openai: no API key configured');
          }
          return { model: { id: 'm' }, modelInfo: { capabilities: { vision: true } } };
        });
        const attemptId = await startKafuo({ ...kafuoContext(), modelRoute: ROUTE });
        const { readAttemptById } = await import('@/lib/persistence/teaching-package');
        const after = (await readAttemptById(qp(), attemptId))!;
        expect(after.status).toBe('failed');
        expect(after.errorCode).toBe('SUBJECT_ROUTE_UNAVAILABLE');
        expect(POLICY_CALLS().map((call) => call.modelString)).not.toContain('openai:gpt-6-luna');
        expect(mocks.acquireContentResource).not.toHaveBeenCalled();
        expect(mocks.generateClassroom).not.toHaveBeenCalled();
        expect((await snapshotOf(attemptId)).input_snapshot).not.toHaveProperty('generationRoute');
      });
    });

    it('TEACHING_SUBJECT_ROUTING=off keeps today’s behaviour: stage route recorded, no policy handed down', async () => {
      vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'off');
      const attemptId = await startKafuo({
        ...kafuoContext(),
        subjectCode: null,
        subjectOffering: null,
      });
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      expect((await readAttemptById(qp(), attemptId))!.status).toBe('succeeded');
      expect(POLICY_CALLS()).toEqual([{ stage: 'generate-classroom' }]);
      const row = await snapshotOf(attemptId);
      expect(row.subject_code).toBeNull();
      expect(row.input_snapshot.resolvedLlmModel).toBe('test:model');
      expect(row.input_snapshot.subjectCode).toBeUndefined();
      const execution = mocks.generateClassroom.mock.calls[0]![0];
      expect(execution.modelPolicy).toBeUndefined();
      expect(execution.attribution).toBeUndefined();
    });

    it('TEACHING_MODEL_UNAVAILABLE ends the attempt after the single full run', async () => {
      const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
      let calls = 0;
      const valid = mocks.generateClassroom.getMockImplementation()!;
      mocks.generateClassroom.mockImplementation(async (execution, options) => {
        calls += 1;
        if (calls === 1) {
          throw new TeachingModelUnavailableError(
            'subject MATH (scene-content:slide): primary=timeout, fallback=rate_limited',
            {
              attemptIds: ['tma-1', 'tma-2'],
              outcomes: [
                { role: 'primary', outcome: 'timeout' },
                { role: 'fallback', outcome: 'rate_limited' },
              ],
              retryable: true,
            },
          );
        }
        return valid(execution, options);
      });
      const attemptId = await startKafuo();
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      const after = (await readAttemptById(qp(), attemptId))!;
      expect(after.status).toBe('failed');
      expect(after.errorCode).toBe('TEACHING_MODEL_UNAVAILABLE');
      expect(after.generationRuns).toBe(1);

      // A safety refusal is not "try again later": one run, then the attempt fails.
      mocks.generateClassroom.mockImplementation(async () => {
        throw new TeachingModelUnavailableError(
          'subject MATH (scene-actions): primary=safety_refused',
          {
            attemptIds: ['tma-3'],
            outcomes: [{ role: 'primary', outcome: 'safety_refused' }],
            retryable: false,
          },
        );
      });
      const refusedId = await startKafuo();
      const refused = (await readAttemptById(qp(), refusedId))!;
      expect(refused.status).toBe('failed');
      expect(refused.errorCode).toBe('TEACHING_MODEL_UNAVAILABLE');
      expect(refused.generationRuns).toBe(1);
      expect(refused.versionId).toBeNull();
    });

    it('retains the manifest’s Content Units for a normalized attempt under the prompt’s skip rule; a PDF attempt retains none', async () => {
      mocks.acquireNormalizedContentResource.mockResolvedValue({
        text: '[[CONTENT_UNIT id=cu-1]] normalized text',
        images: [],
        normalizedImages: [],
        visionImages: [],
        visionMapping: {},
        measuredBytes: 100,
        measuredSha256: 'b'.repeat(64),
        manifest: {
          contentRevisionId: 'rev-1',
          contentUnits: [
            // Out of order on purpose: retention follows the manifest ORDER.
            {
              id: 'cu-2',
              orderIndex: 2,
              role: 'CONCEPT',
              subtype: 'definition',
              title: 'Two',
              normalizedText: 'second text',
              blocks: [],
            },
            {
              id: 'cu-1',
              orderIndex: 1,
              role: 'CONCEPT',
              normalizedText: '  first text  ',
              blocks: [],
            },
            // Figure-only: no text, a visual — skipped from the prompt AND from retention.
            {
              id: 'cu-fig',
              orderIndex: 3,
              role: 'FIGURE',
              blocks: [{ id: 'b1', associatedVisualIds: ['v1'] }],
            },
            // Non-instructional: no text — skipped.
            { id: 'cu-ref', orderIndex: 4, role: 'reference', blocks: [] },
          ],
        },
        blockCount: 1,
      });
      const attemptId = await startKafuo(normalizedKafuoContext());
      const { readAttemptById, readContentUnitsForAttempt } =
        await import('@/lib/persistence/teaching-package');
      expect((await readAttemptById(qp(), attemptId))!.status).toBe('succeeded');
      const units = await readContentUnitsForAttempt(qp(), attemptId, { tenantId: 'tenant-k' });
      expect(units.map((unit) => [unit.unitId, unit.orderIndex, unit.normalizedText])).toEqual([
        ['cu-1', 1, 'first text'],
        ['cu-2', 2, 'second text'],
      ]);
      expect(units[1]).toMatchObject({
        tenantId: 'tenant-k',
        attemptId,
        role: 'CONCEPT',
        subtype: 'definition',
        title: 'Two',
        textLength: 'second text'.length,
        contentRevisionId: 'rev-1',
      });
      // Retained rows are tenant-scoped reads.
      expect(await readContentUnitsForAttempt(qp(), attemptId, { tenantId: 'other' })).toEqual([]);

      const pdfAttemptId = await startKafuo();
      expect(
        await readContentUnitsForAttempt(qp(), pdfAttemptId, { tenantId: 'tenant-k' }),
      ).toEqual([]);
    });
  });

  describe('Kafuo Release 1 defers generated games', () => {
    /** g5.v6's positions for one objective: opener, map, objective slides, native quiz. */
    const V6_FLOW: TeachingFlowEntry[] = [
      {
        stage: 'lesson_opener',
        instructions: 'Open.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
      },
      {
        stage: 'lesson_learning_map',
        instructions: 'Map.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
      },
      {
        stage: 'outcome_visual_explanations',
        instructions: 'Teach o1.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
      },
      {
        stage: 'outcome_check_understanding',
        instructions: 'Check o1.',
        scenePolicy: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
      },
    ];
    /** g5.v5: the same positions plus the final learning game. */
    const V5_FLOW: TeachingFlowEntry[] = [
      ...V6_FLOW,
      {
        stage: 'lesson_learning_game',
        instructions: 'Play.',
        scenePolicy: {
          sceneTypes: ['interactive'],
          widgetTypes: ['game'],
          cardinality: 'exactly_one',
        },
      },
    ];

    function contextFor(flow: TeachingFlowEntry[], version: string) {
      return { ...kafuoContext(), teachingFlow: flow, teachingModel: { key: 'g5', version } };
    }

    async function startWith(context: ReturnType<typeof contextFor>) {
      const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
      const runner = await freshModules();
      const started = await startGenerationAttempt(txPool(), {
        tenantId: context.aggregate.tenantId,
        learningItem: context.aggregate.learningItem,
        teachingModel: context.teachingModel,
        generation: { requirement: 'req', teachingFlow: context.teachingFlow },
        actorRef: 'actor-1',
        requestId: `kafuo-run-${randomUUID()}`,
        requestDigest: 'a'.repeat(64),
        teachingFlow: context.teachingFlow,
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      await runner.runGenerationAttempt(started.attempt.id, started.execution, context);
      return started.attempt.id;
    }

    /** A faithful game-free run over `V6_FLOW`: slides for the slide positions, a quiz for the check. */
    function mockGameFreeRun() {
      mocks.generateClassroom.mockImplementation(async (_execution, options) => {
        const outlines = V6_FLOW.map((entry, index) => ({
          id: `outline-v6-${index}`,
          type: entry.scenePolicy!.sceneTypes[0],
          title: entry.stage,
          description: '',
          keyPoints: [],
          order: index + 1,
          teachingStage: { key: entry.stage, flowIndex: index },
        }));
        await outlineGates(options, outlines);
        mocks.sceneGenerationReached();
        const reserved = await options.persistence.reserve((id: string) => ({
          id,
          name: 'Generated',
          createdAt: 1,
          updatedAt: 1,
        }));
        const scenes = V6_FLOW.map((entry, index) => {
          const slide = makeSlideScene(`scene-v6-${index}`, reserved.id, index + 1, entry.stage);
          const scene =
            entry.stage === 'outcome_check_understanding'
              ? { ...slide, type: 'quiz', content: { type: 'quiz', questions: [] } }
              : slide;
          return { ...scene, teachingStage: { key: entry.stage, flowIndex: index } } as AppScene;
        });
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

    it('generates, submits and approves a game-free g5.v6 package that keeps its native quiz', async () => {
      mockGameFreeRun();
      const attemptId = await startWith(contextFor(V6_FLOW, 'g5.v6'));
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      const attempt = (await readAttemptById(qp(), attemptId))!;
      expect(attempt.status).toBe('succeeded');
      // Every Kafuo run generates with games prohibited.
      expect(mocks.generateClassroom.mock.calls[0]![0]).toMatchObject({
        prohibitedWidgetTypes: ['game'],
        teachingFlow: V6_FLOW,
      });

      const { getOwnerScopedDocumentStore } =
        await import('@/lib/server/agent-runtime/owner-scoped-documents');
      const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
      const { readVersion } = await import('@/lib/persistence/teaching-package');
      const version = (await readVersion(qp(), attempt.versionId!, { tenantId: 'tenant-k' }))!;
      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const document = (await store.loadDocument(version.currentStageId))!;
      expect(document.scenes.map((scene) => scene.type)).toEqual([
        'slide',
        'slide',
        'slide',
        'quiz',
      ]);
      expect(document.scenes.some((scene) => scene.type === 'interactive')).toBe(false);

      const { submitForReview, approve } = await import('@/lib/server/teaching-package/lifecycle');
      const command = { tenantId: 'tenant-k', versionId: version.id, actorRef: 'reviewer-1' };
      expect((await submitForReview(txPool(), command)).status).toBe('in_review');
      expect((await approve(txPool(), command)).status).toBe('approved');
    });

    it('fails a game-bearing g5.v5 attempt before any acquisition or generation', async () => {
      const attemptId = await startWith(contextFor(V5_FLOW, 'g5.v5'));
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      const attempt = (await readAttemptById(qp(), attemptId))!;
      expect(attempt.status).toBe('failed');
      expect(attempt.errorCode).toBe('GAME_GENERATION_DEFERRED');
      expect(attempt.error).toContain('lesson_learning_game');
      expect(mocks.acquireContentResource).not.toHaveBeenCalled();
      expect(mocks.generateClassroom).not.toHaveBeenCalled();
    });
  });

  describe('AI package review (ai-reviewer-layer plan §4.6, Phase 2)', () => {
    const OPUS = 'anthropic:claude-opus-5-5';

    async function queuedReview(attemptId: string) {
      const rows = await pool.query(
        `SELECT id, status, version_id, stage_id, subject_code FROM teaching_package_reviews WHERE attempt_id = $1`,
        [attemptId],
      );
      return rows.rows as Array<{
        id: string;
        status: string;
        version_id: string;
        stage_id: string;
        subject_code: string;
      }>;
    }

    async function events(type: string) {
      const rows = await pool.query(
        `SELECT payload FROM teaching_package_webhook_deliveries WHERE event_type = $1 ORDER BY sequence`,
        [type],
      );
      return (rows.rows as Array<{ payload: Record<string, unknown> }>).map((r) => r.payload);
    }

    function answering(findings: Array<Record<string, unknown>>, summary = 'ملخص') {
      return vi.fn(async () => ({
        answer: { summary, findings: findings as never },
        call: { provider: 'anthropic' as const, modelString: OPUS, usage: null },
      }));
    }

    it('a Kafuo binding queues ONE review in the binding transaction and names it on generation_succeeded', async () => {
      const attemptId = await startKafuo();
      const reviews = await queuedReview(attemptId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ status: 'queued', subject_code: 'MATH' });
      const [succeeded] = await events('teaching_package.generation_succeeded');
      expect(succeeded!.review).toEqual({ id: reviews[0]!.id, status: 'queued' });
      expect((succeeded!.version as { id: string }).id).toBe(reviews[0]!.version_id);
    });

    it('L-5: queuing a review for an attempt that already has one returns the stored id, never a new one', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const { insertQueuedReview } =
        await import('@/lib/server/teaching-package/package-review-store');
      const id = await insertQueuedReview(pool as never, {
        id: 'tpr-never-stored',
        aggregate: { tenantId: 'tenant-k', learningItem: { type: 'lesson', id: 'li-x' } },
        versionId: review!.version_id,
        attemptId,
        stageId: review!.stage_id,
        subjectCode: 'MATH',
        now: 1,
      });
      expect(id).toBe(review!.id);
      expect(await queuedReview(attemptId)).toHaveLength(1);
    });

    it('no findings → passed, one review_completed event with counts; a second run claims nothing', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const callReviewer = answering([], 'لا توجد أخطاء.');
      const done = await runPackageReview(review!.id, { pool: txPool(), callReviewer });
      expect(done).toMatchObject({ status: 'passed', provider: 'anthropic', model: OPUS });
      // The reviewer read the slides as text, and the retained book text (PDF fallback) once.
      const [request] = callReviewer.mock.calls[0] as unknown as [
        { units: Array<{ text: string }>; slides: Array<{ id: string }> },
      ];
      expect(request.units).toEqual([expect.objectContaining({ id: 'book', text: 'pdf text' })]);
      expect(request.slides.map((slide) => slide.id)).toEqual(['scene-f1', 'scene-f2']);
      const [completed] = await events('teaching_package.review_completed');
      expect(completed).toEqual({
        review: expect.objectContaining({
          id: review!.id,
          status: 'passed',
          provider: 'anthropic',
          model: OPUS,
          counts: { findings: 0, open: 0, fixed: 0 },
          openChecks: [],
          errorCode: null,
        }),
      });
      expect(await runPackageReview(review!.id, { pool: txPool(), callReviewer })).toBeNull();
      expect(callReviewer).toHaveBeenCalledTimes(1);
    });

    it('findings → needs_teacher; each open finding names why it waits; the event carries no book text', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: answering([
          {
            targetId: 'scene-f1',
            check: 'S2',
            severity: 'high',
            bookEvidence: { quote: 'BOOKQUOTEMARKER requirement', unitId: null },
            whatIsWrong: 'الناتج خطأ',
            fixNote: 'صحح الناتج إلى ١٢',
          },
          {
            targetId: '',
            check: 'S5',
            severity: 'medium',
            bookEvidence: { quote: 'تأكد', unitId: null },
            whatIsWrong: 'جزء ناقص',
            fixNote: 'أضف الجزء',
          },
        ]),
      });
      expect(done?.status).toBe('needs_teacher');
      expect(done?.findings.map((f) => [f.id, f.check, f.status, f.teacherReason])).toEqual([
        ['f1', 'S2', 'open', 'NOT_ATTEMPTED'],
        ['f2', 'S5', 'open', 'S5_TEACHER_ONLY'],
      ]);
      expect(done?.findings[0]).toMatchObject({ targetTitle: 'S', targetOrder: 1 });
      const [completed] = await events('teaching_package.review_completed');
      expect(completed!.review).toMatchObject({
        status: 'needs_teacher',
        counts: { findings: 2, open: 2, fixed: 0 },
        openChecks: ['S2', 'S5'],
      });
      expect(JSON.stringify(completed)).not.toContain('BOOKQUOTEMARKER');
    });

    it('reviewer unavailable (both routes failed) → unavailable + the event: the Backend gate never waits forever', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: vi.fn(async () => {
          throw new TeachingModelUnavailableError('both failed', {
            attemptIds: [],
            outcomes: [],
            retryable: true,
          });
        }),
      });
      expect(done).toMatchObject({ status: 'unavailable', errorCode: 'REVIEWER_UNAVAILABLE' });
      const [completed] = await events('teaching_package.review_completed');
      expect(completed!.review).toMatchObject({
        status: 'unavailable',
        errorCode: 'REVIEWER_UNAVAILABLE',
      });
    });

    it('Phase 3: the fix loop runs on the stored findings; everything fixed → fixed, with its progress kept', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const fixLoop = vi.fn(async (context: { findings: Array<Record<string, unknown>> }) => ({
        findings: context.findings.map((f) => ({ ...f, status: 'fixed', teacherReason: null })),
        fixes: [{ sceneId: 'scene-f1', findingIds: ['f1'], outcome: 'fixed', code: null }],
      }));
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: answering([
          {
            targetId: 'scene-f1',
            check: 'S3',
            severity: 'high',
            bookEvidence: { quote: 'q', unitId: null },
            whatIsWrong: 'w',
            fixNote: 'n',
          },
        ]),
        fixLoop: fixLoop as never,
      });
      expect(fixLoop).toHaveBeenCalledTimes(1);
      expect(done).toMatchObject({ status: 'fixed' });
      const [completed] = await events('teaching_package.review_completed');
      expect(completed!.review).toMatchObject({
        status: 'fixed',
        counts: { findings: 1, open: 0, fixed: 1 },
        openChecks: [],
      });
    });

    it('the version moved to another Stage → unavailable VERSION_CHANGED, the reviewer is never called', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      await pool.query(
        `UPDATE teaching_package_reviews SET stage_id = 'stage-elsewhere' WHERE id = $1`,
        [review!.id],
      );
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const callReviewer = answering([]);
      const done = await runPackageReview(review!.id, { pool: txPool(), callReviewer });
      expect(done).toMatchObject({ status: 'unavailable', errorCode: 'VERSION_CHANGED' });
      expect(callReviewer).not.toHaveBeenCalled();
    });

    it('a crashed worker’s review is resumed by the sweep and never pays for the first answer twice', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      // A previous worker stored the paid answer, then died holding the lease.
      await pool.query(
        `UPDATE teaching_package_reviews
            SET status = 'running', lease_owner = 'dead', lease_until = 1, run_attempts = 1,
                reviewed_at = 5, summary = 'محفوظ', provider = 'anthropic', model = $2,
                findings = $3::jsonb
          WHERE id = $1`,
        [
          review!.id,
          OPUS,
          JSON.stringify([
            {
              id: 'f1',
              targetId: 'scene-f2',
              targetTitle: 'S',
              targetOrder: 2,
              check: 'S4',
              severity: 'low',
              bookEvidence: { quote: 'q', unitId: null },
              whatIsWrong: 'w',
              fixNote: 'n',
              status: 'open',
              teacherReason: null,
            },
          ]),
        ],
      );
      const { sweepPackageReviews } = await import('@/lib/server/teaching-package/package-review');
      const callReviewer = answering([]);
      // No fix loop here: this case is about the resume (the fix loop has its own file).
      const started = await sweepPackageReviews({
        pool: txPool(),
        callReviewer,
        fixLoop: undefined,
      });
      expect(started).toEqual([review!.id]);
      await vi.waitFor(async () => {
        const [row] = await queuedReview(attemptId);
        expect(row!.status).toBe('needs_teacher');
      });
      expect(callReviewer).not.toHaveBeenCalled();
    });

    /** A reviewer that answers only when the test opens its gate (one per call, in call order). */
    function gatedReviewer() {
      const gates: Array<(answer: { summary: string; findings: unknown[] }) => void> = [];
      const gateOf = new Map<string, (answer: { summary: string; findings: unknown[] }) => void>();
      const callReviewer = vi.fn(
        (request: { review: { id: string } }) =>
          new Promise((resolve) => {
            const open = (answer: { summary: string; findings: unknown[] }) =>
              resolve({
                answer,
                call: { provider: 'anthropic' as const, modelString: OPUS, usage: null },
              });
            gates.push(open);
            gateOf.set(request.review.id, open);
          }),
      );
      return {
        gates,
        gateOf,
        callReviewer: callReviewer as unknown as ReturnType<typeof answering>,
      };
    }

    async function statusOf(id: string) {
      const rows = await pool.query(
        `SELECT status, lease_owner, summary FROM teaching_package_reviews WHERE id = $1`,
        [id],
      );
      return rows.rows[0] as { status: string; lease_owner: string | null; summary: string | null };
    }

    it('D-6: the sweep runs at most 2 reviews at once; the next one starts only after one ends', async () => {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const [queued] = await queuedReview(await startKafuo());
        // A fixed creation order: the sweep takes the oldest first.
        await pool.query(`UPDATE teaching_package_reviews SET created_at = $2 WHERE id = $1`, [
          queued!.id,
          index + 1,
        ]);
        ids.push(queued!.id);
      }
      const { sweepPackageReviews } = await import('@/lib/server/teaching-package/package-review');
      const { gateOf, callReviewer } = gatedReviewer();
      const deps = { pool: txPool(), callReviewer, fixLoop: undefined };
      expect(await sweepPackageReviews(deps)).toEqual([ids[0], ids[1]]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(2));
      // Both slots are taken: nothing else is even listed.
      expect(await sweepPackageReviews(deps)).toEqual([]);
      gateOf.get(ids[0]!)!({ summary: 'لا توجد أخطاء.', findings: [] });
      await vi.waitFor(async () => expect((await statusOf(ids[0]!)).status).toBe('passed'));
      await vi.waitFor(async () => expect(await sweepPackageReviews(deps)).toEqual([ids[2]]));
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(3));
      // One at a time: the test database is a single connection, so two finishing
      // transactions must not interleave.
      gateOf.get(ids[1]!)!({ summary: 's', findings: [] });
      await vi.waitFor(async () => expect((await statusOf(ids[1]!)).status).toBe('passed'));
      gateOf.get(ids[2]!)!({ summary: 's', findings: [] });
      await vi.waitFor(async () => expect((await statusOf(ids[2]!)).status).toBe('passed'));
    });

    it('M-A: an eviction that lands while the lease renewal is in flight still stops the paid call', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const controller = new AbortController();
      // The renewal before the first call succeeds in the database, but the
      // sweep evicts the run while it is in flight.
      const evictingDuringRenewal = {
        query: async (text: string, params?: unknown[]) => {
          const result = await pool.query(text, params);
          if (text.includes('SET lease_until')) controller.abort();
          return result;
        },
        connect: () => pool.connect(),
      } as unknown as ConnectableQueryable;
      const callReviewer = answering([]);
      expect(
        await runPackageReview(review!.id, {
          pool: evictingDuringRenewal,
          callReviewer,
          signal: controller.signal,
        }),
      ).toBeNull();
      expect(callReviewer).not.toHaveBeenCalled();
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    it('M-A / LOW-5: an eviction during a fix-loop renewal stops the regeneration, or the TTS after it; the lease is then released', async () => {
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const { createPackageReviewFixLoop } =
        await import('@/lib/server/teaching-package/package-review-fix-loop');
      const finding = {
        targetId: 'scene-f1',
        check: 'S1',
        severity: 'high',
        bookEvidence: { quote: 'q', unitId: null },
        whatIsWrong: 'w',
        fixNote: 'n',
      };
      /** Aborts the run while its Nth lease renewal is in flight (1 = before the first call). */
      const run = async (abortOnRenewal: number) => {
        const [review] = await queuedReview(await startKafuo());
        const controller = new AbortController();
        let renewals = 0;
        const pooled = {
          query: async (text: string, params?: unknown[]) => {
            const result = await pool.query(text, params);
            if (text.includes('SET lease_until')) {
              renewals += 1;
              if (renewals === abortOnRenewal) controller.abort();
            }
            return result;
          },
          connect: () => pool.connect(),
        } as unknown as ConnectableQueryable;
        const regenerated = {
          id: 'scene-f1',
          order: 1,
          title: 'S',
          content: { type: 'slide', canvas: { elements: [] } },
          actions: [],
        };
        const regenerate = vi.fn(async () => ({
          status: 200,
          body: {
            regenerationId: 'tsr-x',
            status: 'succeeded',
            replayed: false,
            sceneId: 'scene-f1',
            scene: regenerated,
            resultSceneRev: 2,
            current: { rev: 2, scene: regenerated },
          },
        }));
        const regenerateAudio = vi.fn(async () => ({
          sceneId: 'scene-f1',
          scene: regenerated,
          rev: 3,
          generated: 1,
          missing: 0,
        }));
        const done = await runPackageReview(review!.id, {
          pool: pooled,
          signal: controller.signal,
          callReviewer: answering([finding]),
          fixLoop: createPackageReviewFixLoop({
            regenerate: regenerate as never,
            regenerateAudio: regenerateAudio as never,
          }),
        });
        return { review: review!, done, regenerate, regenerateAudio };
      };

      // The renewal right before the paid regeneration (the 2nd) is evicted.
      const beforeRegeneration = await run(2);
      expect(beforeRegeneration.done).toBeNull();
      expect(beforeRegeneration.regenerate).not.toHaveBeenCalled();
      expect(beforeRegeneration.regenerateAudio).not.toHaveBeenCalled();
      await vi.waitFor(async () =>
        expect((await statusOf(beforeRegeneration.review.id)).lease_owner).toBeNull(),
      );

      // The renewal right before the TTS (the 3rd) is evicted.
      const beforeTts = await run(3);
      expect(beforeTts.done).toBeNull();
      expect(beforeTts.regenerate).toHaveBeenCalledTimes(1);
      expect(beforeTts.regenerateAudio).not.toHaveBeenCalled();
      await vi.waitFor(async () =>
        expect((await statusOf(beforeTts.review.id)).lease_owner).toBeNull(),
      );
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    it('LOW-5: an eviction during the finalize ledger read (the 2nd check in end) finalizes nothing', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const controller = new AbortController();
      const evictingDuringFinalizeRead = {
        query: async (text: string, params?: unknown[]) => {
          const result = await pool.query(text, params);
          if (text.includes('review_id = $3')) controller.abort();
          return result;
        },
        connect: () => pool.connect(),
      } as unknown as ConnectableQueryable;
      const callReviewer = answering([]);
      expect(
        await runPackageReview(review!.id, {
          pool: evictingDuringFinalizeRead,
          signal: controller.signal,
          callReviewer,
        }),
      ).toBeNull();
      expect(callReviewer).toHaveBeenCalledTimes(1);
      // The first answer was stored before the abort; the review is not finalized.
      expect(await statusOf(review!.id)).toMatchObject({ status: 'running' });
      expect(await events('teaching_package.review_completed')).toEqual([]);
      await vi.waitFor(async () => expect((await statusOf(review!.id)).lease_owner).toBeNull());
    });

    it('L-A: an eviction that lands during the spend read skips the usage and failed-spend writes', async () => {
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
      const evictingDuringSpendRead = (controller: AbortController) =>
        ({
          query: async (text: string, params?: unknown[]) => {
            const result = await pool.query(text, params);
            if (text.includes('FROM teaching_model_attempts')) controller.abort();
            return result;
          },
          connect: () => pool.connect(),
        }) as unknown as ConnectableQueryable;

      // recordUsage: the first answer is not stored.
      const [answered] = await queuedReview(await startKafuo());
      await ledgerAttempt('tma-la-1', OPUS, { input: 100, output: 10, cost: 0.01 });
      const first = new AbortController();
      const answeredCall = vi.fn(async () => ({
        answer: { summary: 'جديد', findings: [] },
        call: {
          provider: 'anthropic',
          modelString: OPUS,
          usage: null,
          attemptIds: ['tma-la-1'],
        },
      }));
      expect(
        await runPackageReview(answered!.id, {
          pool: evictingDuringSpendRead(first),
          signal: first.signal,
          callReviewer: answeredCall as never,
        }),
      ).toBeNull();
      // LOW-5: the call did run; only its write after the abort was skipped.
      expect(answeredCall).toHaveBeenCalledTimes(1);
      const kept = await pool.query(
        `SELECT summary, reviewed_at, input_tokens FROM teaching_package_reviews WHERE id = $1`,
        [answered!.id],
      );
      expect(kept.rows[0]).toMatchObject({ summary: null, reviewed_at: null, input_tokens: null });

      // recordFailedSpend: a failed call's spend is not added.
      const [failed] = await queuedReview(await startKafuo());
      await ledgerAttempt('tma-la-2', OPUS, { input: 400, output: 0, cost: 0.1 });
      const second = new AbortController();
      const failing = vi.fn(async () => {
        throw new TeachingModelUnavailableError('both failed', {
          attemptIds: ['tma-la-2'],
          outcomes: [],
          retryable: true,
        });
      });
      expect(
        await runPackageReview(failed!.id, {
          pool: evictingDuringSpendRead(second),
          signal: second.signal,
          callReviewer: failing,
        }),
      ).toBeNull();
      expect(failing).toHaveBeenCalledTimes(1);
      const spent = await pool.query(
        `SELECT status, input_tokens FROM teaching_package_reviews WHERE id = $1`,
        [failed!.id],
      );
      expect(spent.rows[0]).toMatchObject({ status: 'running', input_tokens: null });
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    it('L-D / item 5: with no revoke, an answer after the abort is dropped and the run gives its own lease up at once', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const { listClaimableReviewIds } =
        await import('@/lib/server/teaching-package/package-review-store');
      const controller = new AbortController();
      const t = Date.now();
      // The sweep's revoke never ran (or failed): only the run itself can let go.
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        workerId: 'w-evicted',
        signal: controller.signal,
        now: () => t,
        callReviewer: vi.fn(async () => {
          controller.abort();
          return {
            answer: {
              summary: 'قديم',
              findings: [
                {
                  targetId: 'scene-f1',
                  check: 'S1',
                  severity: 'high',
                  bookEvidence: { quote: 'q', unitId: null },
                  whatIsWrong: 'w',
                  fixNote: 'n',
                },
              ],
            },
            call: { provider: 'anthropic', modelString: OPUS, usage: null },
          };
        }) as never,
      });
      expect(done).toBeNull();
      await vi.waitFor(async () => expect((await statusOf(review!.id)).lease_owner).toBeNull());
      expect(await statusOf(review!.id)).toMatchObject({ status: 'running', summary: null });
      // Claimable at once, not 40 minutes later.
      expect(await listClaimableReviewIds(pool as never, t)).toEqual([review!.id]);
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    it('HIGH-1: a run stalled BEFORE its first call whose lease moved on never pays and writes nothing', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      let release!: () => void;
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The reads before the call hang (no pool timeout) …
      const loadScenes = vi.fn(async () => {
        await stalled;
        return [
          {
            id: 'scene-f1',
            order: 1,
            title: 'S',
            content: { type: 'slide', canvas: { elements: [] } },
            actions: [],
          },
        ] as never;
      });
      const callReviewer = answering([]);
      const running = runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer,
        loadScenes,
        workerId: 'stale-worker',
      });
      await vi.waitFor(() => expect(loadScenes).toHaveBeenCalledTimes(1));
      // … meanwhile the lease lapsed and another worker claimed the review.
      await pool.query(
        `UPDATE teaching_package_reviews SET lease_owner = 'other-worker' WHERE id = $1`,
        [review!.id],
      );
      release();
      expect(await running).toBeNull();
      expect(callReviewer).not.toHaveBeenCalled();
      expect(await statusOf(review!.id)).toMatchObject({
        status: 'running',
        lease_owner: 'other-worker',
        summary: null,
      });
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    it('L-10: a run that stops keeping its lease is evicted and resumed; the stale run writes nothing', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { sweepPackageReviews, REVIEW_LEASE_MS } =
        await import('@/lib/server/teaching-package/package-review');
      let t = Date.now();
      const { gates, callReviewer } = gatedReviewer();
      const deps = { pool: txPool(), callReviewer, fixLoop: undefined, now: () => t };
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(1));
      const firstOwner = (await statusOf(review!.id)).lease_owner;
      // Inside the lease: the run is alive, nothing is started twice.
      t += REVIEW_LEASE_MS - 1_000;
      expect(await sweepPackageReviews(deps)).toEqual([]);
      // A whole lease without a renewal: hung → evicted → resumed under a new owner.
      t += 2_000;
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(2));
      // HIGH-1 (c): the evicted run's reviewer call is aborted; the new run's is not.
      const signals = callReviewer.mock.calls.map(
        (args) => (args as unknown as [{ signal?: AbortSignal }])[0].signal,
      );
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      const secondOwner = (await statusOf(review!.id)).lease_owner;
      expect(secondOwner).not.toBeNull();
      expect(secondOwner).not.toBe(firstOwner);
      // The stale run wakes up with an answer: every write is refused by the lease guard.
      gates[0]!({
        summary: 'قديم',
        findings: [
          {
            targetId: 'scene-f1',
            check: 'S1',
            severity: 'high',
            bookEvidence: { quote: 'q', unitId: null },
            whatIsWrong: 'w',
            fixNote: 'n',
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await statusOf(review!.id)).toMatchObject({
        status: 'running',
        lease_owner: secondOwner,
        summary: null,
      });
      gates[1]!({ summary: 'جديد', findings: [] });
      await vi.waitFor(async () => expect((await statusOf(review!.id)).status).toBe('passed'));
      expect((await statusOf(review!.id)).summary).toBe('جديد');
      expect(await events('teaching_package.review_completed')).toHaveLength(1);
    });

    it('HIGH-1: eviction revokes the lease even when no run resumes the review in that sweep', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { sweepPackageReviews, REVIEW_LEASE_MS } =
        await import('@/lib/server/teaching-package/package-review');
      let t = Date.now();
      const { gates, callReviewer } = gatedReviewer();
      const deps = { pool: txPool(), callReviewer, fixLoop: undefined, now: () => t };
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(1));
      // The evicting sweep cannot list what to start (the listing query fails).
      const listingDown = {
        query: (text: string, params?: unknown[]) =>
          text.includes('FROM teaching_package_reviews') && text.includes('LIMIT')
            ? Promise.reject(new Error('listing down'))
            : pool.query(text, params),
        connect: () => pool.connect(),
      } as unknown as ConnectableQueryable;
      t += REVIEW_LEASE_MS + 1_000;
      expect(await sweepPackageReviews({ ...deps, pool: listingDown })).toEqual([]);
      // L-2: the revoke is not awaited by the sweep.
      await vi.waitFor(async () => expect((await statusOf(review!.id)).lease_owner).toBeNull());
      // The evicted run wakes up with an answer: nothing it writes lands.
      gates[0]!({
        summary: 'قديم',
        findings: [
          {
            targetId: 'scene-f1',
            check: 'S1',
            severity: 'high',
            bookEvidence: { quote: 'q', unitId: null },
            whatIsWrong: 'w',
            fixNote: 'n',
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await statusOf(review!.id)).toMatchObject({
        status: 'running',
        lease_owner: null,
        summary: null,
      });
      expect(await events('teaching_package.review_completed')).toEqual([]);
      // A normal sweep then resumes the review.
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(2));
      gates[1]!({ summary: 'جديد', findings: [] });
      await vi.waitFor(async () => expect((await statusOf(review!.id)).status).toBe('passed'));
      expect(await events('teaching_package.review_completed')).toHaveLength(1);
    });

    it('L-2: a revoke that hangs never holds up the sweep', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { sweepPackageReviews, REVIEW_LEASE_MS } =
        await import('@/lib/server/teaching-package/package-review');
      let t = Date.now();
      const { callReviewer } = gatedReviewer();
      let hangRevoke = false;
      const hanging = {
        query: (text: string, params?: unknown[]) =>
          hangRevoke && text.includes('SET lease_owner = NULL')
            ? new Promise(() => {})
            : pool.query(text, params),
        connect: () => pool.connect(),
      } as unknown as ConnectableQueryable;
      const deps = { pool: hanging, callReviewer, fixLoop: undefined, now: () => t };
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(1));
      t += REVIEW_LEASE_MS + 1_000;
      hangRevoke = true;
      // The sweep returns (and resumes the review) although the revoke never settles.
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(2));
    });

    it('HIGH-1: when the revoke of an evicted lease fails, the evicted run still never renews nor finalizes', async () => {
      const [review] = await queuedReview(await startKafuo());
      const { sweepPackageReviews, REVIEW_LEASE_MS } =
        await import('@/lib/server/teaching-package/package-review');
      let t = Date.now();
      // The fix loop stalls (a long TTS, say), then tries to keep its lease.
      let release!: () => void;
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      const kept: boolean[] = [];
      const fixLoop = vi.fn(
        async (context: {
          findings: Array<Record<string, unknown>>;
          heartbeat: () => Promise<boolean>;
        }) => {
          await stalled;
          kept.push(await context.heartbeat());
          return { findings: context.findings, fixes: [] };
        },
      );
      const finding = {
        targetId: 'scene-f1',
        check: 'S1',
        severity: 'high',
        bookEvidence: { quote: 'q', unitId: null },
        whatIsWrong: 'w',
        fixNote: 'n',
      };
      // The revoke and (in the evicting sweep) the listing both fail.
      let listingDown = false;
      const flaky = {
        query: (text: string, params?: unknown[]) =>
          text.includes('SET lease_owner = NULL') ||
          (listingDown && text.includes('FROM teaching_package_reviews') && text.includes('LIMIT'))
            ? Promise.reject(new Error('database blip'))
            : pool.query(text, params),
        connect: () => pool.connect(),
      } as unknown as ConnectableQueryable;
      const deps = {
        pool: flaky,
        callReviewer: answering([finding]),
        fixLoop: fixLoop as never,
        now: () => t,
      };
      expect(await sweepPackageReviews(deps)).toEqual([review!.id]);
      await vi.waitFor(() => expect(fixLoop).toHaveBeenCalledTimes(1));
      const staleOwner = (await statusOf(review!.id)).lease_owner;
      t += REVIEW_LEASE_MS + 1_000;
      listingDown = true;
      expect(await sweepPackageReviews(deps)).toEqual([]);
      listingDown = false;
      // The revoke failed: the row still names the evicted run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await statusOf(review!.id)).lease_owner).toBe(staleOwner);
      release();
      await vi.waitFor(() => expect(kept).toEqual([false]));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Not renewed, not finalized, no event: the review is left to be resumed.
      const row = await pool.query(
        `SELECT status, lease_owner, lease_until FROM teaching_package_reviews WHERE id = $1`,
        [review!.id],
      );
      expect(row.rows[0]).toMatchObject({ status: 'running', lease_owner: staleOwner });
      expect(Number((row.rows[0] as { lease_until: number }).lease_until)).toBeLessThan(t);
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    /** One paid reviewer attempt in the ledger (the authority the row totals read). */
    async function ledgerAttempt(
      id: string,
      modelString: string,
      spend: { input: number; output: number; cost: number },
      tenantId = 'tenant-k',
      link: { reviewId?: string; generationAttemptId?: string } = {},
    ) {
      await pool.query(
        `INSERT INTO teaching_model_attempts
           (id, tenant_id, capability, subject_code, policy_version, stage, provider_id, model_id,
            model_string, role, attempt_index, accounting_status, origin, generation_attempt_id,
            worker_id, created_at, started_at, input_tokens_total, output_tokens_total, cost_usd,
            review_id)
         VALUES ($1, $8, 'package_review', 'MATH', 'reviewer-2026-11', 'package-review',
                 $2, $3, $4, 'primary', 1, 'complete', 'openmaic_runtime', $9, 'w', 1, 1,
                 $5, $6, $7, $10)`,
        [
          id,
          modelString.split(':')[0],
          modelString.split(':')[1],
          modelString,
          spend.input,
          spend.output,
          spend.cost,
          tenantId,
          link.generationAttemptId ?? 'ga-l4',
          link.reviewId ?? null,
        ],
      );
    }

    it('item 5: an aborted call that throws (like the executor) ends nothing and adds no spend', async () => {
      const [review] = await queuedReview(await startKafuo());
      await ledgerAttempt('tma-ab-1', OPUS, { input: 300, output: 0, cost: 0.05 });
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const { TeachingCallAbortedError } = await import('@/lib/server/teaching-model/execute');
      const controller = new AbortController();
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        workerId: 'w-evicted',
        signal: controller.signal,
        callReviewer: vi.fn(async () => {
          controller.abort(); // the sweep evicts the run mid-call
          throw new TeachingCallAbortedError(['tma-ab-1']);
        }),
      });
      expect(done).toBeNull();
      // Not `unavailable` / REVIEW_FAILED, no spend written (recordFailedSpend skipped), no event.
      const row = await pool.query(
        `SELECT status, error_code, input_tokens FROM teaching_package_reviews WHERE id = $1`,
        [review!.id],
      );
      expect(row.rows[0]).toMatchObject({
        status: 'running',
        error_code: null,
        input_tokens: null,
      });
      expect(await events('teaching_package.review_completed')).toEqual([]);
      await vi.waitFor(async () => expect((await statusOf(review!.id)).lease_owner).toBeNull());
    });

    it('item 5 / LOW-3: with its lease still held (failed revoke), an aborted run makes no re-review call and writes no progress', async () => {
      const [review] = await queuedReview(await startKafuo());
      await ledgerAttempt('tma-skip-first', OPUS, { input: 100, output: 10, cost: 0.01 });
      await ledgerAttempt('tma-skip-rereview', OPUS, { input: 50, output: 5, cost: 0.005 });
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const controller = new AbortController();
      let rereviewRefusal: unknown = null;
      const finding = {
        targetId: 'scene-f1',
        check: 'S1',
        severity: 'high',
        bookEvidence: { quote: 'q', unitId: null },
        whatIsWrong: 'w',
        fixNote: 'n',
      };
      const callReviewer = vi
        .fn()
        .mockResolvedValueOnce({
          answer: { summary: 's', findings: [finding] },
          call: {
            provider: 'anthropic',
            modelString: OPUS,
            usage: null,
            attemptIds: ['tma-skip-first'],
          },
        })
        .mockResolvedValueOnce({
          answer: { summary: 's', findings: [] },
          call: {
            provider: 'anthropic',
            modelString: OPUS,
            usage: null,
            attemptIds: ['tma-skip-rereview'],
          },
        });
      const fixLoop = vi.fn(
        async (context: {
          review: unknown;
          units: unknown;
          slides: unknown;
          findings: Array<Record<string, unknown>>;
          callReviewer: (request: unknown) => Promise<unknown>;
          recordProgress: (findings: unknown[], fixes: unknown[]) => Promise<void>;
        }) => {
          controller.abort(); // evicted while fixing; the revoke never landed
          // LOW-3: the re-review is refused before any paid call.
          try {
            await context.callReviewer({
              review: context.review,
              units: context.units,
              slides: context.slides,
              focusIds: new Set(['scene-f1']),
            });
          } catch (error) {
            rereviewRefusal = error;
          }
          const fixed = context.findings.map((f) => ({
            ...f,
            status: 'fixed',
            teacherReason: null,
          }));
          const fixes = [{ sceneId: 'scene-f1', findingIds: ['f1'], outcome: 'fixed', code: null }];
          await context.recordProgress(fixed, fixes);
          return { findings: fixed, fixes };
        },
      );
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        workerId: 'w-evicted',
        signal: controller.signal,
        callReviewer: callReviewer as never,
        fixLoop: fixLoop as never,
      });
      expect(done).toBeNull();
      expect(fixLoop).toHaveBeenCalledTimes(1);
      // Only the first review reached the reviewer; the re-review after the abort never did.
      expect(callReviewer).toHaveBeenCalledTimes(1);
      expect(rereviewRefusal).toMatchObject({ name: 'TeachingCallAbortedError' });
      const row = await pool.query(
        `SELECT status, input_tokens, findings, fixes FROM teaching_package_reviews WHERE id = $1`,
        [review!.id],
      );
      const stored = row.rows[0] as {
        status: string;
        input_tokens: string | number;
        findings: Array<{ status: string }>;
        fixes: unknown[];
      };
      // Only the first answer (before the abort) is on the row.
      expect(stored.status).toBe('running');
      expect(Number(stored.input_tokens)).toBe(100);
      expect(stored.findings.map((f) => f.status)).toEqual(['open']);
      expect(stored.fixes).toEqual([]);
      expect(await events('teaching_package.review_completed')).toEqual([]);
    });

    it('L-B: at the end the row totals are the ledger’s for the review id — an evicted run’s paid attempt included', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const link = { reviewId: review!.id, generationAttemptId: attemptId };
      // An evicted run paid for a call it never recorded on the row …
      await ledgerAttempt(
        'tma-lb-evicted',
        OPUS,
        { input: 500, output: 100, cost: 0.3 },
        'tenant-k',
        link,
      );
      // … the resumed run's own call …
      await ledgerAttempt(
        'tma-lb-served',
        OPUS,
        { input: 200, output: 50, cost: 0.1 },
        'tenant-k',
        link,
      );
      // … and neither another tenant's row nor another review's row counts.
      await ledgerAttempt(
        'tma-lb-foreign',
        OPUS,
        { input: 9_000, output: 9_000, cost: 9 },
        'tenant-other',
        link,
      );
      await ledgerAttempt(
        'tma-lb-other',
        OPUS,
        { input: 7_000, output: 7_000, cost: 7 },
        'tenant-k',
        {
          reviewId: 'tpr-other',
          generationAttemptId: attemptId,
        },
      );
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: vi.fn(async () => ({
          answer: { summary: 's', findings: [] },
          call: {
            provider: 'anthropic',
            modelString: OPUS,
            usage: null,
            attemptIds: ['tma-lb-served'],
          },
        })) as never,
      });
      expect(done).toMatchObject({ status: 'passed' });
      expect(done!.inputTokens).toBe(700);
      expect(done!.outputTokens).toBe(150);
      expect(done!.costUsd).toBeCloseTo(0.4, 8);
    });

    it('L-4: the row sums every paid attempt (a failed one too); provider and model stay the first review’s', async () => {
      const SOL = 'openai:gpt-6-sol';
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      // LOW-5: real ledger rows of this review (review_id set), as the executor writes them.
      const link = { reviewId: review!.id, generationAttemptId: attemptId };
      // First review: Opus answered truncated (paid), then Sol served.
      await ledgerAttempt(
        'tma-l4-opus',
        OPUS,
        { input: 1000, output: 500, cost: 0.5 },
        'tenant-k',
        link,
      );
      await ledgerAttempt(
        'tma-l4-sol',
        SOL,
        { input: 800, output: 300, cost: 0.2 },
        'tenant-k',
        link,
      );
      // The re-review was served by Opus.
      await ledgerAttempt(
        'tma-l4-rereview',
        OPUS,
        { input: 100, output: 50, cost: 0.05 },
        'tenant-k',
        link,
      );
      const finding = {
        targetId: 'scene-f1',
        check: 'S3',
        severity: 'high',
        bookEvidence: { quote: 'q', unitId: null },
        whatIsWrong: 'w',
        fixNote: 'n',
      };
      const callReviewer = vi
        .fn()
        .mockResolvedValueOnce({
          answer: { summary: 's', findings: [finding] },
          call: {
            provider: 'openai',
            modelString: SOL,
            usage: null,
            attemptIds: ['tma-l4-opus', 'tma-l4-sol'],
          },
        })
        .mockResolvedValueOnce({
          answer: { summary: 's', findings: [] },
          call: {
            provider: 'anthropic',
            modelString: OPUS,
            usage: null,
            attemptIds: ['tma-l4-rereview'],
          },
        });
      const fixLoop = vi.fn(
        async (context: {
          findings: Array<Record<string, unknown>>;
          callReviewer: (request: unknown) => Promise<unknown>;
          review: unknown;
          units: unknown;
          slides: unknown;
        }) => {
          await context.callReviewer({
            review: context.review,
            units: context.units,
            slides: context.slides,
            focusIds: new Set(['scene-f1']),
          });
          return {
            findings: context.findings.map((f) => ({ ...f, status: 'fixed', teacherReason: null })),
            fixes: [],
          };
        },
      );
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: callReviewer as never,
        fixLoop: fixLoop as never,
      });
      expect(done).toMatchObject({ status: 'fixed', provider: 'openai', model: SOL });
      expect(done!.inputTokens).toBe(1900);
      expect(done!.outputTokens).toBe(850);
      expect(done!.costUsd).toBeCloseTo(0.75, 8);
      const [completed] = await events('teaching_package.review_completed');
      expect(completed!.review).toMatchObject({ provider: 'openai', model: SOL });
    });

    it('L-4: a reviewer call that failed after paying still adds its spend to the unavailable row', async () => {
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      // LOW-5: real ledger rows of this review (review_id set), as the executor writes them.
      const link = { reviewId: review!.id, generationAttemptId: attemptId };
      await ledgerAttempt(
        'tma-l4-down-1',
        OPUS,
        { input: 400, output: 0, cost: 0.1 },
        'tenant-k',
        link,
      );
      await ledgerAttempt(
        'tma-l4-down-2',
        'openai:gpt-6-sol',
        { input: 300, output: 0, cost: 0.05 },
        'tenant-k',
        link,
      );
      // LOW-3: an attempt id of ANOTHER tenant never counts on this tenant's row.
      await ledgerAttempt(
        'tma-l4-foreign',
        OPUS,
        { input: 9_000, output: 9_000, cost: 9 },
        'tenant-other',
        link,
      );
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
      const done = await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: vi.fn(async () => {
          throw new TeachingModelUnavailableError('both failed', {
            attemptIds: ['tma-l4-down-1', 'tma-l4-down-2', 'tma-l4-foreign'],
            outcomes: [],
            retryable: true,
          });
        }),
      });
      expect(done).toMatchObject({ status: 'unavailable', errorCode: 'REVIEWER_UNAVAILABLE' });
      expect(done!.inputTokens).toBe(700);
      expect(done!.costUsd).toBeCloseTo(0.15, 8);
    });

    it('a review claimed more than 3 times ends unavailable REVIEW_ATTEMPTS_EXHAUSTED without a call', async () => {
      const [review] = await queuedReview(await startKafuo());
      await pool.query(
        `UPDATE teaching_package_reviews
            SET status = 'running', lease_owner = 'dead', lease_until = 1, run_attempts = 3
          WHERE id = $1`,
        [review!.id],
      );
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const callReviewer = answering([]);
      const done = await runPackageReview(review!.id, { pool: txPool(), callReviewer });
      expect(done).toMatchObject({ status: 'unavailable', errorCode: 'REVIEW_ATTEMPTS_EXHAUSTED' });
      expect(callReviewer).not.toHaveBeenCalled();
      const [completed] = await events('teaching_package.review_completed');
      expect(completed!.review).toMatchObject({ errorCode: 'REVIEW_ATTEMPTS_EXHAUSTED' });
    });

    it('the signed GET routes return the review text to the Backend, scoped to the tenant', async () => {
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'review-route-key');
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      await runPackageReview(review!.id, {
        pool: txPool(),
        callReviewer: answering([
          {
            targetId: 'scene-f1',
            check: 'S1',
            severity: 'high',
            bookEvidence: { quote: 'نص الكتاب', unitId: null },
            whatIsWrong: 'يخالف الكتاب',
            fixNote: 'التزم بنص الكتاب',
          },
        ]),
      });
      const { NextRequest } = await import('next/server');
      const one = await import('@/app/api/teaching-packages/[id]/reviews/[reviewId]/route');
      const list = await import('@/app/api/teaching-packages/[id]/reviews/route');
      const auth = { headers: { authorization: 'Bearer review-route-key' } };
      const base = `http://localhost/api/teaching-packages/${review!.version_id}/reviews`;
      const ok = await one.GET(new NextRequest(`${base}/${review!.id}?tenantId=tenant-k`, auth), {
        params: Promise.resolve({ id: review!.version_id, reviewId: review!.id }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { review: Record<string, unknown> };
      expect(body.review).toMatchObject({
        id: review!.id,
        status: 'needs_teacher',
        summary: 'ملخص',
        bookTruncated: false,
        counts: { findings: 1, open: 1, fixed: 0 },
        findings: [
          expect.objectContaining({
            check: 'S1',
            bookEvidence: { quote: 'نص الكتاب', unitId: null },
          }),
        ],
      });
      const other = await one.GET(
        new NextRequest(`${base}/${review!.id}?tenantId=tenant-other`, auth),
        {
          params: Promise.resolve({ id: review!.version_id, reviewId: review!.id }),
        },
      );
      expect(other.status).toBe(404);
      const unsigned = await one.GET(new NextRequest(`${base}/${review!.id}?tenantId=tenant-k`), {
        params: Promise.resolve({ id: review!.version_id, reviewId: review!.id }),
      });
      expect(unsigned.status).toBe(401);
      const listed = await list.GET(new NextRequest(`${base}?tenantId=tenant-k`, auth), {
        params: Promise.resolve({ id: review!.version_id }),
      });
      expect(((await listed.json()) as { reviews: unknown[] }).reviews).toHaveLength(1);
    });

    it('D-8: a book cut to fit the review is recorded (bookTruncated) on the row, the GET and the list, and the reviewer is told', async () => {
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'review-route-key');
      const attemptId = await startKafuo();
      const [review] = await queuedReview(attemptId);
      await pool.query(
        `UPDATE teaching_package_source_contexts SET text = repeat('ك', 120001) WHERE attempt_id = $1`,
        [attemptId],
      );
      const { runPackageReview, callPackageReviewer } =
        await import('@/lib/server/teaching-package/package-review');
      const callReviewer = answering([]);
      const done = await runPackageReview(review!.id, { pool: txPool(), callReviewer });
      expect(done).toMatchObject({ status: 'passed', bookTruncated: true });
      const [request] = callReviewer.mock.calls[0] as unknown as [{ bookTruncated?: boolean }];
      expect(request.bookTruncated).toBe(true);
      const row = await pool.query(
        `SELECT book_truncated FROM teaching_package_reviews WHERE id = $1`,
        [review!.id],
      );
      expect((row.rows[0] as { book_truncated: boolean }).book_truncated).toBe(true);
      // The production call puts the one sentence in the book block it sends.
      const { BOOK_TRUNCATED_NOTE } =
        await import('@/lib/server/teaching-package/package-review-prompt');
      const reviewerCall = await import('@/lib/server/teaching-model/reviewer-call');
      const run = vi.spyOn(reviewerCall, 'runReviewerCall').mockResolvedValue({
        parsed: { summary: 's', findings: [] },
        provider: 'anthropic',
        modelString: OPUS,
        attemptIds: [],
        usage: null,
        switched: null,
      });
      const controller = new AbortController();
      await callPackageReviewer({
        review: done!,
        units: [{ id: 'book', title: null, role: null, text: 'x' }],
        slides: [],
        bookTruncated: true,
        signal: controller.signal,
        pool: txPool(),
      });
      expect(run.mock.calls[0]![0].stablePrompt).toContain(BOOK_TRUNCATED_NOTE);
      // L-5: the run's abort signal reaches the reviewer call (eviction stops it).
      expect(run.mock.calls[0]![0].signal).toBe(controller.signal);
      run.mockRestore();
      const { NextRequest } = await import('next/server');
      const one = await import('@/app/api/teaching-packages/[id]/reviews/[reviewId]/route');
      const list = await import('@/app/api/teaching-packages/[id]/reviews/route');
      const auth = { headers: { authorization: 'Bearer review-route-key' } };
      const base = `http://localhost/api/teaching-packages/${review!.version_id}/reviews`;
      const ok = await one.GET(new NextRequest(`${base}/${review!.id}?tenantId=tenant-k`, auth), {
        params: Promise.resolve({ id: review!.version_id, reviewId: review!.id }),
      });
      expect(
        ((await ok.json()) as { review: { bookTruncated: boolean } }).review.bookTruncated,
      ).toBe(true);
      const listed = await list.GET(new NextRequest(`${base}?tenantId=tenant-k`, auth), {
        params: Promise.resolve({ id: review!.version_id }),
      });
      expect(
        ((await listed.json()) as { reviews: Array<{ bookTruncated: boolean }> }).reviews[0]!
          .bookTruncated,
      ).toBe(true);
    });
  });

  describe('Regenerate only the flagged slides (owner, 15 Nov 2026)', () => {
    const OPUS = 'anthropic:claude-opus-5-5';
    const S2_ON_F1 = {
      targetId: 'scene-f1',
      check: 'S2',
      severity: 'high',
      bookEvidence: { quote: 'q', unitId: null },
      whatIsWrong: 'الناتج خطأ',
      fixNote: 'صحح الناتج إلى ١٢',
    };
    const S5_MISSING = {
      targetId: '',
      check: 'S5',
      severity: 'medium',
      bookEvidence: { quote: 'تأكد', unitId: null },
      whatIsWrong: 'جزء ناقص',
      fixNote: 'أضف الجزء',
    };

    function answering(findings: Array<Record<string, unknown>>) {
      return vi.fn(async () => ({
        answer: { summary: 'ملخص', findings: findings as never },
        call: { provider: 'anthropic' as const, modelString: OPUS, usage: null },
      }));
    }

    /** A Kafuo draft whose first review finished (no fix loop: every open finding waits). */
    async function reviewed(findings: Array<Record<string, unknown>>) {
      const attemptId = await startKafuo();
      const rows = await pool.query(
        `SELECT id, version_id FROM teaching_package_reviews WHERE attempt_id = $1`,
        [attemptId],
      );
      const row = rows.rows[0] as { id: string; version_id: string };
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const done = await runPackageReview(row.id, {
        pool: txPool(),
        callReviewer: answering(findings),
      });
      return { attemptId, done: done!, versionId: row.version_id };
    }

    /** The Admin's real key shape (colons included), forwarded as it is by Kafuo. */
    const adminKey = (n: number) => `learning_item_tp_command:208:regeneration:stamp:${n}:k3j9x2`;
    const REQUEUED_AT = 1_894_715_466_674;

    async function refix(versionId: string, idempotencyKey = adminKey(1)) {
      const { queueFlaggedSlideRefix } =
        await import('@/lib/server/teaching-package/package-review-refix');
      return queueFlaggedSlideRefix(
        txPool(),
        { tenantId: 'tenant-k', versionId, idempotencyKey },
        { now: () => REQUEUED_AT },
      );
    }

    it('re-queues the finished review under a new id, resetting only what a regeneration may fix', async () => {
      const { attemptId, done, versionId } = await reviewed([S2_ON_F1, S5_MISSING]);
      expect(done.findings.map((f) => f.teacherReason)).toEqual([
        'NOT_ATTEMPTED',
        'S5_TEACHER_ONLY',
      ]);
      // A finished review keeps each slide finding's slide as it saw it.
      expect(done.findings[0]!.sceneDigest).toEqual(expect.any(String));
      expect(done.findings[1]!.sceneDigest).toBeUndefined();
      const queued = await refix(versionId);
      expect(queued).toMatchObject({
        previousReviewId: done.id,
        sceneIds: ['scene-f1'],
        replayed: false,
      });
      expect(queued.review.id).not.toBe(done.id);
      expect(queued.review).toMatchObject({
        status: 'queued',
        attemptId,
        fixes: [],
        reviewedAt: done.reviewedAt,
        summary: done.summary,
        completedAt: null,
        // Kafuo's stuck-review guard counts from this (`queued_at`): it must be the re-queue.
        createdAt: REQUEUED_AT,
      });
      expect(queued.review.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
        ['f1', 'open', null],
        ['f2', 'open', 'S5_TEACHER_ONLY'],
      ]);
      // Still one review per attempt: the row was re-queued, not copied.
      const rows = await pool.query(
        `SELECT id FROM teaching_package_reviews WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(rows.rows).toEqual([{ id: queued.review.id }]);
    });

    it('never pays for a whole-package review again: the run goes straight to the fix loop under the new id', async () => {
      const { versionId } = await reviewed([S2_ON_F1, S5_MISSING]);
      const queued = await refix(versionId);
      const { runPackageReview } = await import('@/lib/server/teaching-package/package-review');
      const callReviewer = answering([]);
      const fixLoop = vi.fn(async (context: { findings: Array<Record<string, unknown>> }) => ({
        findings: context.findings.map((f) =>
          f.id === 'f1' ? { ...f, status: 'fixed', teacherReason: null } : f,
        ) as never,
        fixes: [{ sceneId: 'scene-f1', findingIds: ['f1'], outcome: 'fixed' as const, code: null }],
      }));
      const finished = await runPackageReview(queued.review.id, {
        pool: txPool(),
        callReviewer,
        fixLoop: fixLoop as never,
      });
      expect(callReviewer).not.toHaveBeenCalled();
      expect(fixLoop).toHaveBeenCalledTimes(1);
      const [context] = fixLoop.mock.calls[0]! as unknown as [
        { review: { id: string }; findings: Array<{ id: string; teacherReason: string | null }> },
      ];
      expect(context.review.id).toBe(queued.review.id);
      expect(context.findings.find((f) => f.id === 'f1')!.teacherReason).toBeNull();
      expect(finished).toMatchObject({ id: queued.review.id, status: 'needs_teacher' });
      const completed = await pool.query(
        `SELECT payload FROM teaching_package_webhook_deliveries
          WHERE event_type = 'teaching_package.review_completed' ORDER BY sequence`,
      );
      const last = (completed.rows.at(-1) as { payload: { review: Record<string, unknown> } })
        .payload.review;
      expect(last).toMatchObject({
        id: queued.review.id,
        counts: { findings: 2, open: 1, fixed: 1 },
        openChecks: ['S5'],
      });
    });

    it('a retry with the same key returns the review it queued; another press while it runs is refused', async () => {
      const { versionId } = await reviewed([S2_ON_F1]);
      const queued = await refix(versionId, adminKey(1));
      const again = await refix(versionId, adminKey(1));
      expect(again).toMatchObject({ replayed: true, previousReviewId: null });
      expect(again.review.id).toBe(queued.review.id);
      await expect(refix(versionId, adminKey(2))).rejects.toMatchObject({
        code: 'PACKAGE_REVIEW_IN_PROGRESS',
      });
      await expect(refix(versionId, 'has space')).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    });

    it('a slide the teacher edited after the review is never regenerated over their edit', async () => {
      const { done, versionId } = await reviewed([S2_ON_F1]);
      await pool.query(
        `UPDATE document_scenes SET data = jsonb_set(data, '{title}', '"عدّله المعلم"')
          WHERE id = 'scene-f1'`,
      );
      await expect(refix(versionId)).rejects.toMatchObject({ code: 'NO_REGENERABLE_SLIDES' });
      const rows = await pool.query(`SELECT id, status FROM teaching_package_reviews`);
      expect(rows.rows).toEqual([{ id: done.id, status: 'needs_teacher' }]);
    });

    it('only teacher-only issues left: NO_REGENERABLE_SLIDES, and the review is left as it was', async () => {
      const { done, versionId } = await reviewed([S5_MISSING]);
      await expect(refix(versionId)).rejects.toMatchObject({ code: 'NO_REGENERABLE_SLIDES' });
      const rows = await pool.query(`SELECT id, status FROM teaching_package_reviews`);
      expect(rows.rows).toEqual([{ id: done.id, status: 'needs_teacher' }]);
    });

    it('refuses before the first review finished, and on a version that is not a draft', async () => {
      const attemptId = await startKafuo();
      const rows = await pool.query(
        `SELECT version_id FROM teaching_package_reviews WHERE attempt_id = $1`,
        [attemptId],
      );
      const versionId = (rows.rows[0] as { version_id: string }).version_id;
      await expect(refix(versionId)).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_NOT_READY' });
      await pool.query(`UPDATE teaching_package_versions SET status = 'in_review' WHERE id = $1`, [
        versionId,
      ]);
      await expect(refix(versionId)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    it('the signed POST route: 202 with the queued review; a refusal keeps its code', async () => {
      vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'review-route-key');
      const { done, versionId } = await reviewed([S2_ON_F1]);
      const { NextRequest } = await import('next/server');
      const route = await import('@/app/api/teaching-packages/[id]/reviews/route');
      const post = (idempotencyKey: string) =>
        route.POST(
          new NextRequest(`http://localhost/api/teaching-packages/${versionId}/reviews`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer review-route-key',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ tenantContext: { tenantId: 'tenant-k' }, idempotencyKey }),
          }),
          { params: Promise.resolve({ id: versionId }) },
        );
      const accepted = await post(adminKey(1));
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({
        review: { status: 'queued', versionId },
        previousReviewId: done.id,
        sceneIds: ['scene-f1'],
        replayed: false,
      });
      const refused = await post(adminKey(2));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: 'PACKAGE_REVIEW_IN_PROGRESS' } });
    });
  });

  describe('g5.v12: the book-part rules in the run (critical items, 27 Nov 2026)', () => {
    /** Two objectives: each its slides (slides and the engine's attempt quizzes), then its quiz. */
    const BOOK_FLOW: TeachingFlowEntry[] = [
      {
        stage: 'lesson_opener',
        instructions: 'Open.',
        scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
      },
      {
        stage: 'outcome_visual_explanations',
        instructions: 'Teach o1.',
        scenePolicy: { sceneTypes: ['slide', 'quiz'], cardinality: 'one_or_more' },
      },
      {
        stage: 'outcome_check_understanding',
        instructions: 'Check o1.',
        scenePolicy: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
      },
      {
        stage: 'outcome_visual_explanations',
        instructions: 'Teach o2.',
        scenePolicy: { sceneTypes: ['slide', 'quiz'], cardinality: 'one_or_more' },
      },
      {
        stage: 'outcome_check_understanding',
        instructions: 'Check o2.',
        scenePolicy: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
      },
    ];
    const bookUnit = (
      contentUnitId: string,
      element: string | null,
      partIndex: number,
    ): KafuoBookStructure['units'][number] => ({
      contentUnitId,
      kind: element === null ? null : element === 'try_it' ? 'UNDERSTANDING_CHECK' : 'KEY_CONCEPT',
      element,
      required: element === 'key_concept' || element === 'try_it',
      partIndex,
    });
    /** u3 and u6 are kind-less; u8 is an untyped practice unit the runner types as an exercise. */
    const BOOK: KafuoBookStructure = {
      templateVersionId: '4',
      rules: [{ kind: 'GUIDED_PRACTICE', element: 'exercise', required: false }],
      units: [
        bookUnit('u1', 'key_concept', 1),
        bookUnit('u2', 'try_it', 1),
        bookUnit('u3', null, 1),
        bookUnit('u4', 'key_concept', 2),
        bookUnit('u5', 'try_it', 2),
        bookUnit('u6', null, 2),
        bookUnit('u8', null, 2),
      ],
    };
    const UNITS = [
      {
        id: 'u1',
        orderIndex: 1,
        role: 'CONCEPT_EXPLANATION',
        title: 'u1',
        normalizedText: 'نص الوحدة الأولى',
        blocks: [],
      },
      {
        id: 'u2',
        orderIndex: 2,
        role: 'UNDERSTANDING_CHECK',
        title: 'ماذا قرأت؟',
        normalizedText: 'ماذا قرأت؟\n(١) السؤال الأول',
        blocks: [],
      },
      {
        id: 'u3',
        orderIndex: 3,
        role: 'CONCEPT_EXPLANATION',
        title: 'u3',
        normalizedText: 'نص الوحدة الثالثة',
        blocks: [],
      },
      {
        id: 'u4',
        orderIndex: 4,
        role: 'CONCEPT_EXPLANATION',
        title: 'u4',
        normalizedText: 'نص الوحدة الرابعة',
        blocks: [],
      },
      {
        id: 'u5',
        orderIndex: 5,
        role: 'UNDERSTANDING_CHECK',
        title: 'ماذا قرأت؟',
        normalizedText: 'ماذا قرأت؟\n(١) السؤال الثاني',
        blocks: [],
      },
      {
        id: 'u6',
        orderIndex: 6,
        role: 'CONCEPT_EXPLANATION',
        title: 'u6',
        normalizedText: 'نص الوحدة السادسة',
        blocks: [],
      },
      {
        id: 'u8',
        orderIndex: 8,
        role: 'PRACTICE_SET',
        subtype: 'GUIDED_PRACTICE',
        title: 'تأكد',
        normalizedText: 'تأكد\n(١) سؤال',
        blocks: [],
      },
    ];
    const OBJECTIVES = [
      { objectiveRef: 'o1', snapshot: { statement: 's1' }, contentUnitIds: ['u1', 'u2', 'u3'] },
      {
        objectiveRef: 'o2',
        snapshot: { statement: 's2' },
        contentUnitIds: ['u4', 'u5', 'u6', 'u8'],
      },
    ];

    const at = (flowIndex: number) => ({ key: BOOK_FLOW[flowIndex]!.stage, flowIndex });
    const slide = (
      id: string,
      flowIndex: number,
      units: string[],
      extra: Partial<SceneOutline> = {},
    ) =>
      ({
        id,
        type: 'slide',
        title: id,
        description: '',
        keyPoints: [],
        order: 0,
        slideType: 'content',
        contentRole: 'explanation',
        teachingStage: at(flowIndex),
        sourceContentUnitIds: units,
        ...extra,
      }) as SceneOutline;
    const quiz = (id: string, flowIndex: number, units: string[]) =>
      ({
        id,
        type: 'quiz',
        title: id,
        description: '',
        keyPoints: [],
        order: 0,
        teachingStage: at(flowIndex),
        sourceContentUnitIds: units,
      }) as SceneOutline;

    /** A plan with a gap the book repair can close: u6 (essential) has no slide, neither check a solution. */
    const planWithGaps = () => [
      slide('cover', 0, ['u1'], { slideType: 'cover' }),
      slide('c1', 1, ['u1'], { contentKind: 'definition' }),
      slide('c2', 1, ['u3']),
      slide('try1', 1, ['u2'], { contentRole: 'check_understanding' }),
      // (Every outline is grounded: the cover and each objective's quiz cite a unit too.)
      quiz('q1', 2, ['u2']),
      slide('c3', 3, ['u4'], { contentKind: 'definition' }),
      slide('try2', 3, ['u5'], { contentRole: 'check_understanding' }),
      quiz('q2', 4, ['u5']),
    ];
    /** A slide teaching units of two objective blocks, inside the first block: no deterministic fix repairs it. */
    const withMixedSlide = () => [
      ...planWithGaps().slice(0, 3),
      slide('x', 1, ['u2', 'u4']),
      ...planWithGaps().slice(3),
    ];

    interface Seen {
      requirement?: string;
      /** Whether the run was given the re-ask hook at all (g5.v12 with a parts map only). */
      reaskHook?: boolean;
      /** The violation codes the hook returned for the first answer. */
      reask?: string[];
      final?: SceneOutline[];
      /** QZ-1/QZ-6: the execution's book-grounded questions option. */
      bookGroundedQuestions?: unknown;
    }

    /**
     * The runner's hooks, driven in the real pipeline's order (`generateClassroom` is the
     * mock): the re-ask is decided on the first answer before anything else; then the
     * rule fixes with the placement, the book repair (its planner doubles for the model
     * and answers the role its instruction names), the pause check, the final planning
     * step, the cleanup.
     */
    function mockBookRun(
      plans: {
        first: () => SceneOutline[];
        second?: () => SceneOutline[];
        /** A-32: the check quiz the pipeline drops (no Scene; its plan entry marked). */
        dropCheckQuiz?: string;
      },
      seen: Seen,
    ) {
      mocks.generateClassroom.mockImplementation(async (execution, options) => {
        const correction = options.correction!;
        seen.requirement = execution.requirement;
        seen.bookGroundedQuestions = (
          execution as { bookGroundedQuestions?: unknown }
        ).bookGroundedQuestions;
        // A slide plan the planner accepts: a content slide with a title, a description
        // and 3–6 key points, the asked role, and the kind an explanation needs.
        const aiCall = async (_system: string, user: string) => {
          const role = /contentRole (\w+)/.exec(user)?.[1] ?? 'explanation';
          return JSON.stringify({
            slideType: 'content',
            title: 'شريحة من الكتاب',
            description: 'شرح من الكتاب',
            keyPoints: ['النقطة الأولى', 'النقطة الثانية', 'النقطة الثالثة'],
            contentRole: role,
            ...(role === 'explanation' ? { contentKind: 'concept' } : {}),
          });
        };
        const run = async (planned: SceneOutline[]) => {
          let outlines = planned;
          let blocking = (await correction.collectOutlineIssues?.(outlines)) ?? [];
          const fixed = blocking.length
            ? await correction.autoFixOutlines?.(outlines, blocking)
            : null;
          if (fixed) {
            outlines = fixed.outlines;
            blocking = fixed.blocking;
          }
          if (blocking.length && correction.repairOutlines) {
            const repaired = await correction.repairOutlines(outlines, blocking, aiCall);
            if (repaired) {
              outlines = repaired.outlines;
              blocking = repaired.blocking;
            }
          }
          return { outlines, blocking };
        };
        const first = plans.first();
        seen.reaskHook = typeof correction.reaskPlan === 'function';
        const violations: OutlineDiagnostic[] = (await correction.reaskPlan?.(first)) ?? [];
        seen.reask = violations.map((issue) => issue.code);
        const { outlines, blocking } = violations.length
          ? await run(plans.second!())
          : await run(first);
        if (blocking.length > 0) {
          const { GenerationCorrectionRequiredError } =
            await import('@/lib/server/teaching-package/outline-correction');
          throw new GenerationCorrectionRequiredError({
            phase: 'outline',
            outlines,
            courseTitle: null,
            languageDirective: '',
            diagnostics: blocking,
            repairs: [],
          });
        }
        const refined: SceneOutline[] | null = await correction.refineOutlines?.(outlines, aiCall);
        const finalized: SceneOutline[] =
          correction.finalizeOutlines?.(refined ?? outlines) ?? refined ?? outlines;
        // A-32: the dropped check quiz keeps its plan entry, marked, with no Scene.
        const final: SceneOutline[] = finalized.map((outline) =>
          outline.id === plans.dropCheckQuiz
            ? {
                ...outline,
                checkQuizDropped: {
                  reason: 'unverified_answer_key' as const,
                  sceneId: `dropped-${outline.id}`,
                },
              }
            : outline,
        );
        seen.final = final;
        mocks.sceneGenerationReached();
        const reserved = await options.persistence.reserve((id: string) => ({
          id,
          name: 'Generated',
          createdAt: 1,
          updatedAt: 1,
        }));
        const scenes = final.flatMap((outline, index) => {
          if (outline.checkQuizDropped) return [];
          const base = makeSlideScene(
            `scene-b-${index}`,
            reserved.id,
            index + 1,
            outline.title ?? '',
          );
          const scene =
            outline.type === 'quiz'
              ? { ...base, type: 'quiz', content: { type: 'quiz', questions: [] } }
              : base;
          return [
            {
              ...scene,
              outlineId: outline.id,
              teachingStage: outline.teachingStage,
              sourceContentUnitIds: outline.sourceContentUnitIds ?? [],
            } as unknown as AppScene,
          ];
        });
        await options.persistence.persist(
          {
            id: reserved.id,
            stage: reserved.stage,
            scenes: scenes as never,
            outlines: final as never,
          },
          options.baseUrl,
        );
        return {
          id: reserved.id,
          url: '',
          stage: reserved.stage,
          scenes: scenes as never,
          outlines: final as never,
          scenesCount: scenes.length,
          createdAt: new Date().toISOString(),
        };
      });
    }

    function bookContext(version: string) {
      return {
        ...normalizedKafuoContext(),
        teachingFlow: BOOK_FLOW,
        teachingModel: { key: 'g5', version },
        learningObjectives: OBJECTIVES,
        bookStructure: BOOK,
      };
    }

    async function startBook(context: ReturnType<typeof bookContext>) {
      mocks.acquireNormalizedContentResource.mockResolvedValue({
        text: UNITS.map((unit) => `[[CONTENT_UNIT id=${unit.id}]] ${unit.normalizedText}`).join(
          '\n',
        ),
        images: [],
        normalizedImages: [],
        visionImages: [],
        visionMapping: {},
        measuredBytes: 100,
        measuredSha256: 'b'.repeat(64),
        manifest: { contentRevisionId: 'rev-1', contentUnits: UNITS },
        blockCount: 1,
      });
      const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
      const runner = await freshModules();
      const started = await startGenerationAttempt(txPool(), {
        tenantId: context.aggregate.tenantId,
        learningItem: context.aggregate.learningItem,
        teachingModel: context.teachingModel,
        generation: { requirement: 'req', teachingFlow: context.teachingFlow },
        actorRef: 'actor-1',
        requestId: `kafuo-run-${randomUUID()}`,
        requestDigest: 'a'.repeat(64),
        teachingFlow: context.teachingFlow,
        bookStructure: context.bookStructure,
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      });
      await runner.runGenerationAttempt(started.attempt.id, started.execution, context);
      return started.attempt.id;
    }

    /** The attempt's raw snapshot: the runner's own keys, before any reader shapes them. */
    async function snapshotOf(attemptId: string): Promise<Record<string, unknown>> {
      const result = await pool.query<{ input_snapshot: Record<string, unknown> }>(
        `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      return result.rows[0]!.input_snapshot;
    }

    it('EN-3: the planner gets the parts list from the TYPED book, with the rules it is held to', async () => {
      const seen: Seen = {};
      mockBookRun({ first: planWithGaps }, seen);
      const attemptId = await startBook(bookContext('g5.v12'));
      const requirement = seen.requirement!;
      // Kind-less units are listed in their book place…
      expect(requirement).toContain('units u1, u2, u3');
      expect(requirement).toContain('units u4, u5, u6');
      // …the untyped practice unit the runner typed as an exercise is not.
      expect(requirement).not.toMatch(/units [^\n]*\bu8\b/);
      expect(requirement).toContain('ONE CHECK PER SLIDE');
      expect(requirement).toContain('never checks of two parts');
      expect(requirement).toContain('NO TITLE-ONLY SLIDE');
      // The list comes right after the request's own requirement and before the engine's
      // grounding note, where the request parser appended it before.
      expect(requirement.startsWith('req\nLESSON PARTS IN BOOK ORDER')).toBe(true);
      expect(requirement.indexOf('LESSON PARTS IN BOOK ORDER')).toBeLessThan(
        requirement.indexOf('For every outline, return a non-empty'),
      );
      expect((await readAttemptByIdFor(attemptId)).status).toBe('succeeded');
    });

    it('EN-2 / EN-7: the plan is placed inside the repair stage, and a gap the repair taught is no gap at Submit', async () => {
      const seen: Seen = {};
      mockBookRun({ first: planWithGaps }, seen);
      const attemptId = await startBook(bookContext('g5.v12'));
      expect((await readAttemptByIdFor(attemptId)).status).toBe('succeeded');
      const snapshot = await snapshotOf(attemptId);
      // u6 was a gap on the first plan; the repair gave it a slide, so Submit's authority lists none.
      expect(snapshot.sectionCoverage).toEqual({
        essentialContentUnitIds: ['u1', 'u3', 'u4', 'u6'],
        gapContentUnitIds: [],
      });
      expect(snapshot.bookPartPlacement).toMatchObject({
        placed: true,
        restaged: expect.any(Number),
      });
      // Nothing asked the planner again, and nothing is left to warn about but the missing summary.
      expect(snapshot.plannerReask).toEqual({ asked: false, violations: [] });
      expect(
        (snapshot.planWarnings as Array<{ code: string }>).map((warning) => warning.code),
      ).toEqual(['NO_CLOSING_SUMMARY']);
      // Every listed unit is taught, so nothing is recorded as untaught (EN-8).
      expect(snapshot).not.toHaveProperty('untaughtListedUnits');
      // The final plan follows the book: u1, the check u2 and its solution, u3, then the
      // quiz; u4, the check u5 and its solution, u6, then the quiz.
      const position = (id: string) => seen.final!.findIndex((outline) => outline.id === id);
      const firstInsertedAfter = (anchor: string, unitId: string) =>
        seen.final!.findIndex(
          (outline, index) =>
            index > position(anchor) &&
            (outline.sourceContentUnitIds ?? []).includes(unitId) &&
            outline.id !== anchor,
        );
      const solU2 = firstInsertedAfter('try1', 'u2');
      const solU5 = firstInsertedAfter('try2', 'u5');
      const u6 = seen.final!.find((outline) =>
        (outline.sourceContentUnitIds ?? []).includes('u6'),
      )!;
      expect(position('cover')).toBeLessThan(position('c1'));
      expect(position('c1')).toBeLessThan(position('try1'));
      expect(solU2).toBeGreaterThan(position('try1'));
      expect(solU2).toBeLessThan(position('c2'));
      expect(position('c2')).toBeLessThan(position('q1'));
      expect(position('q1')).toBeLessThan(position('c3'));
      expect(position('c3')).toBeLessThan(position('try2'));
      expect(solU5).toBeGreaterThan(position('try2'));
      expect(solU5).toBeLessThan(position(u6.id));
      expect(position(u6.id)).toBeLessThan(position('q2'));
      // Nothing was moved after the plan was placed: the two blocks are the planner's own.
      expect(seen.final!.find((outline) => outline.id === 'c3')!.teachingStage!.flowIndex).toBe(3);
      // Still one full generation run: the re-ask is the planner's, inside the same run.
      expect((await readAttemptByIdFor(attemptId)).generationRuns).toBe(1);
    });

    it('EN-4: a violation no deterministic fix repairs asks the planner once more, and it is recorded', async () => {
      const seen: Seen = {};
      mockBookRun({ first: withMixedSlide, second: planWithGaps }, seen);
      const attemptId = await startBook(bookContext('g5.v12'));
      expect((await readAttemptByIdFor(attemptId)).status).toBe('succeeded');
      expect(seen.reaskHook).toBe(true);
      expect(seen.reask).toEqual(['SLIDE_OUT_OF_BOOK_ORDER']);
      const snapshot = await snapshotOf(attemptId);
      expect(snapshot.plannerReask).toEqual({
        asked: true,
        violations: ['SLIDE_OUT_OF_BOOK_ORDER'],
      });
      // The second plan is the one the package was built from.
      expect(seen.final!.some((outline) => outline.id === 'x')).toBe(false);
      expect(snapshot.sectionCoverage).toMatchObject({ gapContentUnitIds: [] });
    });

    it('QZ-1/QZ-6 (wave 3): a g5.v12 run writes its quizzes and try-its from the book; g5.v11 does not', async () => {
      const v12: Seen = {};
      mockBookRun({ first: planWithGaps }, v12);
      const v12Attempt = await startBook(bookContext('g5.v12'));
      // The book's check units: the only text a try-it slide is given.
      expect(v12.bookGroundedQuestions).toEqual({ checkUnitIds: ['u2', 'u5'] });
      // QZ-4: the number check's record is on the attempt (none here), never a gate.
      expect((await snapshotOf(v12Attempt)).slideNumberFindings).toEqual([]);
      const v11: Seen = {};
      mockBookRun({ first: planWithGaps }, v11);
      const v11Attempt = await startBook(bookContext('g5.v11'));
      expect(v11.bookGroundedQuestions).toBeUndefined();
      expect(await snapshotOf(v11Attempt)).not.toHaveProperty('slideNumberFindings');
    });

    it('A-32: a dropped check quiz passes the exact-flow gate, is recorded, and its check’s try-it stays', async () => {
      const seen: Seen = {};
      mockBookRun({ first: planWithGaps, dropCheckQuiz: 'q1' }, seen);
      const attemptId = await startBook(bookContext('g5.v12'));
      expect((await readAttemptByIdFor(attemptId)).status).toBe('succeeded');
      expect((await snapshotOf(attemptId)).droppedCheckQuizzes).toEqual([
        { sceneId: 'dropped-q1', outlineId: 'q1', flowIndex: 2, reason: 'unverified_answer_key' },
      ]);
      expect(seen.final!.some((outline) => outline.id === 'try1')).toBe(true);
      // The same Stage without the marker fails the exact-flow gate, as before.
      const unmarked: Seen = {};
      mocks.generateClassroom.mockReset();
      mockBookRun({ first: () => planWithGaps().filter((o) => o.id !== 'q1') }, unmarked);
      const refused = await startBook(bookContext('g5.v12'));
      expect((await readAttemptByIdFor(refused)).status).not.toBe('succeeded');
    });

    it('QZ-3 (wave 3): the run asks a title-only try-it’s attempt from the book lines on g5.v12, from the title on g5.v11', async () => {
      // try1 and try2 carry no key point of their own (only their title).
      const attemptOf = (final: SceneOutline[], slideId: string) =>
        final.find((outline) => outline.id === `${slideId}-attempt`);
      const v12: Seen = {};
      mockBookRun({ first: planWithGaps }, v12);
      await startBook(bookContext('g5.v12'));
      expect(attemptOf(v12.final!, 'try1')?.keyPoints).toEqual(['(١) السؤال الأول']);
      expect(attemptOf(v12.final!, 'try2')?.keyPoints).toEqual(['(١) السؤال الثاني']);
      for (const outline of v12.final!.filter((entry) => entry.id.endsWith('-attempt'))) {
        expect(outline.keyPoints).not.toContain(outline.id.replace(/-attempt$/, ''));
      }
      // g5.v11 is unchanged: the attempt keeps the slide's own key points (none here), so
      // the model asks from the title, exactly as before (the defect v12 fixes).
      const v11: Seen = {};
      mockBookRun({ first: planWithGaps }, v11);
      await startBook(bookContext('g5.v11'));
      expect(attemptOf(v11.final!, 'try1')).toBeDefined();
      expect(attemptOf(v11.final!, 'try1')?.keyPoints).toEqual([]);
    });

    it('M4 (wave 1 review): a book map whose parts cannot be laid on the blocks fails closed before any model call', async () => {
      const seen: Seen = {};
      mockBookRun({ first: planWithGaps }, seen);
      const refused = {
        ...bookContext('g5.v12'),
        // o2 lost its unit list: no part of it can be placed or order-gated.
        learningObjectives: [OBJECTIVES[0]!, { objectiveRef: 'o2', snapshot: { statement: 's2' } }],
      };
      const attemptId = await startBook(refused as ReturnType<typeof bookContext>);
      const after = await readAttemptByIdFor(attemptId);
      expect(after.status).toBe('failed');
      expect(after.errorCode).toBe('TEACHING_MODEL_FLOW_MISMATCH');
      expect(mocks.generateClassroom).not.toHaveBeenCalled();

      // g5.v11: the same request runs as before (no parts there at all).
      mocks.generateClassroom.mockClear();
      mockBookRun({ first: planWithGaps }, seen);
      const v11 = await startBook({
        ...refused,
        teachingModel: { key: 'g5', version: 'g5.v11' },
      } as ReturnType<typeof bookContext>);
      expect((await readAttemptByIdFor(v11)).status).toBe('succeeded');
    });

    it('M2 (wave 1 review): a try-it merging the checks of two blocks is split by the repair, never re-asked', async () => {
      // Lesson 227 slide 17: one try-it sets 6767 (part 2) and 6772 (part 3). Here u2
      // (block 1) and u5 (block 2), inside block 1: an order break only the merge made.
      const withMergedTry = () => [
        slide('cover', 0, ['u1'], { slideType: 'cover' }),
        slide('c1', 1, ['u1'], { contentKind: 'definition' }),
        slide('c2', 1, ['u3']),
        slide('tm', 1, ['u2', 'u5'], { contentRole: 'check_understanding' }),
        quiz('q1', 2, ['u2']),
        slide('c3', 3, ['u4'], { contentKind: 'definition' }),
        quiz('q2', 4, ['u5']),
      ];
      const seen: Seen = {};
      mockBookRun({ first: withMergedTry, second: planWithGaps }, seen);
      const attemptId = await startBook(bookContext('g5.v12'));
      expect(seen.reaskHook).toBe(true);
      expect(seen.reask).toEqual([]);
      expect((await readAttemptByIdFor(attemptId)).status).toBe('succeeded');
      expect((await snapshotOf(attemptId)).plannerReask).toEqual({ asked: false, violations: [] });
      // The split put u5's own try-it in the block that owns its part.
      const tryU5 = seen.final!.find(
        (outline) =>
          outline.contentRole === 'check_understanding' &&
          (outline.sourceContentUnitIds ?? []).join() === 'u5',
      );
      expect(tryU5?.teachingStage?.flowIndex).toBe(3);
      expect(
        seen.final!.some((outline) => (outline.sourceContentUnitIds ?? []).join() === 'u2,u5'),
      ).toBe(false);
    });

    it('fails closed: a second plan that still breaks the order pauses with the finding, and is not asked a third time', async () => {
      const seen: Seen = {};
      mockBookRun({ first: withMixedSlide, second: withMixedSlide }, seen);
      const attemptId = await startBook(bookContext('g5.v12'));
      expect((await readAttemptByIdFor(attemptId)).status).toBe('awaiting_admin_correction');
      const checkpoint = await checkpointOf(qp(), attemptId);
      expect(checkpoint.phase).toBe('outline');
      expect(checkpoint.diagnostics.map((issue) => issue.code)).toContain(
        'SLIDE_OUT_OF_BOOK_ORDER',
      );
      // L1 (wave 1 review): the re-ask is on the attempt although the run paused.
      expect((await snapshotOf(attemptId)).plannerReask).toEqual({
        asked: true,
        violations: ['SLIDE_OUT_OF_BOOK_ORDER'],
      });
    });

    it('g5.v11 is unchanged: no parts list, no placement, no re-ask, and a gap stays sticky as before', async () => {
      const seen: Seen = {};
      mockBookRun({ first: planWithGaps, second: planWithGaps }, seen);
      const attemptId = await startBook(bookContext('g5.v11'));
      expect((await readAttemptByIdFor(attemptId)).status).toBe('succeeded');
      const requirement = seen.requirement!;
      expect(requirement.startsWith('req\n\n')).toBe(true);
      expect(requirement).not.toContain('LESSON PARTS IN BOOK ORDER');
      expect(seen.reaskHook).toBe(false);
      expect(seen.reask).toEqual([]);
      const snapshot = await snapshotOf(attemptId);
      expect(snapshot).not.toHaveProperty('bookPartPlacement');
      expect(snapshot).not.toHaveProperty('plannerReask');
      expect(snapshot).not.toHaveProperty('planWarnings');
      // The same repaired gap stays recorded on v11 (F10), exactly as before.
      expect(snapshot.sectionCoverage).toMatchObject({ gapContentUnitIds: ['u6'] });
      expect(
        seen.final!.some((outline) => (outline.sourceContentUnitIds ?? []).includes('u6')),
      ).toBe(true);
    });

    async function readAttemptByIdFor(attemptId: string) {
      const { readAttemptById } = await import('@/lib/persistence/teaching-package');
      return (await readAttemptById(qp(), attemptId))!;
    }
  });
});
