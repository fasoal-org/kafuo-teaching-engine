/**
 * Flexible slide classification + admin-correction pause/resume, end to end
 * (docs/frds/slide-classification-admin-correction-plan.md).
 *
 * The REAL runner, the REAL `generateClassroom` pipeline (outline analysis,
 * correction checkpoint, reservation, Scene loop, persistence sink) and the
 * REAL correction service run on PGlite. Only the model-facing edges are
 * replaced: the outline model call (a counted fake `aiCall` handed to the real
 * `generateSceneOutlinesFromRequirements`), Scene content/Action generation,
 * and source acquisition. Every run is governed (Teaching Skills marker), so
 * outline generation is single-shot and a count of 1 means exactly one model
 * call.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeachingScenePolicy } from '@openmaic/generation';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type {
  KafuoContentResource,
  TeachingFlowEntry,
  TeachingSkillPolicy,
} from '@/lib/types/teaching-package';
import { TEACHING_SKILLS_CONTRACT_V1 } from '@/lib/server/teaching-package/kafuo-request';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
  acquireContentResource: vi.fn(),
  acquireNormalizedContentResource: vi.fn(),
  /** The outline MODEL call — the only thing that stands in for the LLM. */
  outlineAiCall: vi.fn(),
  /** Every call of the (real) outline generator and what it resolved to. */
  outlineGeneratorCalls: [] as Array<{ options: unknown; result: unknown }>,
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: () => false,
}));
vi.mock('@openmaic/generation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/generation')>();
  return {
    ...actual,
    // The REAL outline generator (prompt, parse, analysis, repair, diagnostics)
    // with the model call replaced by the counted fake.
    generateSceneOutlinesFromRequirements: async (
      ...args: Parameters<typeof actual.generateSceneOutlinesFromRequirements>
    ) => {
      const [requirements, pdfText, pdfImages, , options] = args;
      const result = await actual.generateSceneOutlinesFromRequirements(
        requirements,
        pdfText,
        pdfImages,
        mocks.outlineAiCall,
        options,
      );
      mocks.outlineGeneratorCalls.push({ options, result });
      return result;
    },
    generateSceneContent: mocks.generateSceneContent,
    generateSceneActions: mocks.generateSceneActions,
    applyOutlineFallbacks: (outline: unknown) => outline,
  };
});
vi.mock('@/lib/server/scene-generation', () => ({
  // The real adapter's carrier contract (outlineId, teachingStage, grounding),
  // without the slide-semantics element assertions of a full generated slide.
  createSceneWithActions: (
    outline: {
      id: string;
      type: string;
      title: string;
      order: number;
      teachingStage?: unknown;
      sourceContentUnitIds?: string[];
    },
    _content: unknown,
    actions: unknown[],
    api: {
      scene: {
        create: (input: Record<string, unknown>) => { success: boolean; data?: string };
      };
    },
  ) => {
    const result = api.scene.create({
      type: outline.type,
      title: outline.title,
      order: outline.order,
      content: {
        type: 'slide',
        canvas: {
          id: `canvas-${outline.id}`,
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          theme: {
            backgroundColor: '#ffffff',
            themeColors: ['#2563eb'],
            fontColor: '#111827',
            fontName: 'Inter',
          },
          elements: [],
        },
      },
      actions,
      outlineId: outline.id,
      ...(outline.teachingStage ? { teachingStage: outline.teachingStage } : {}),
      ...(outline.sourceContentUnitIds
        ? { sourceContentUnitIds: outline.sourceContentUnitIds }
        : {}),
    });
    return result.success ? (result.data ?? null) : null;
  },
}));
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
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = 'tenant-corr';
const OTHER_TENANT = 'tenant-other';
const DIGEST = 'a'.repeat(64);
const SOURCE_SHA = 'b'.repeat(64);

/** Real registry ids at v1, so the governed authority resolves against the live catalog. */
const SKILL_POLICY: TeachingSkillPolicy = {
  required: [],
  preferred: [{ skillId: 'feynman-learning', version: 'v1' }],
  allowed: [
    { skillId: 'feynman-learning', version: 'v1' },
    { skillId: 'learning-to-learn', version: 'v1' },
  ],
  combinationRestrictions: [],
};

/** The g5.v5 machine-readable policy of `outcome_visual_explanations` (plan §2.2). */
const V5_VISUAL_POLICY: TeachingScenePolicy = {
  sceneTypes: ['slide'],
  slideTypes: ['content'],
  contentRoles: ['explanation', 'procedure', 'worked_example', 'example', 'activity'],
  visual: 'source_grounded',
  cardinality: 'one_or_more',
};

/** g5.v4 shape: no scenePolicy — position 1 keeps the legacy explanation-only rule. */
function flowV4(): TeachingFlowEntry[] {
  return [
    { stage: 'lesson_introduction', instructions: 'Introduce.', skillPolicy: SKILL_POLICY },
    {
      stage: 'outcome_visual_explanations',
      instructions: 'Explain visually.',
      skillPolicy: SKILL_POLICY,
    },
  ];
}

/** g5.v5 shape: every position carries its own scenePolicy. */
function flowV5(): TeachingFlowEntry[] {
  return [
    {
      stage: 'lesson_introduction',
      instructions: 'Introduce.',
      skillPolicy: SKILL_POLICY,
      scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
    },
    {
      stage: 'outcome_visual_explanations',
      instructions: 'Explain visually.',
      skillPolicy: SKILL_POLICY,
      scenePolicy: structuredClone(V5_VISUAL_POLICY),
    },
  ];
}

/** A flow whose second position is a quiz (legacy `outcome_check_understanding`). */
function flowWithQuiz(): TeachingFlowEntry[] {
  return [
    { stage: 'lesson_introduction', instructions: 'Introduce.', skillPolicy: SKILL_POLICY },
    {
      stage: 'outcome_check_understanding',
      instructions: 'Check.',
      skillPolicy: SKILL_POLICY,
    },
  ];
}

type OutlineFixture = Record<string, unknown> & { id: string };

function introOutline(extra: Record<string, unknown> = {}): OutlineFixture {
  return {
    id: 'o-intro',
    type: 'slide',
    title: 'Welcome',
    description: 'What we will learn.',
    keyPoints: ['Fractions name parts of a whole.'],
    slideType: 'content',
    contentRole: 'explanation',
    contentKind: 'concept',
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    ...extra,
  };
}

function visualOutline(extra: Record<string, unknown> = {}): OutlineFixture {
  return {
    id: 'o-visual',
    type: 'slide',
    title: 'Adding fractions step by step',
    description: 'Walk through the steps.',
    keyPoints: ['Find a common denominator.', 'Add the numerators.'],
    slideType: 'content',
    contentRole: 'explanation',
    teachingStage: { key: 'outcome_visual_explanations', flowIndex: 1 },
    visualPlan: { mode: 'native' },
    ...extra,
  };
}

/** The outline model's JSON answer. */
function answerWith(outlines: OutlineFixture[]): void {
  mocks.outlineAiCall.mockResolvedValue(
    JSON.stringify({ languageDirective: 'Use English.', courseTitle: 'Fractions', outlines }),
  );
}

function pdfSource() {
  return {
    text: 'Fractions name parts of a whole.',
    images: [],
    normalizedImages: [],
    visionImages: [],
    visionMapping: {},
    measuredBytes: 128,
    measuredSha256: SOURCE_SHA,
  };
}

function normalizedSource() {
  return {
    text: '[[CONTENT_UNIT id=cu-1]] Fractions. [[CONTENT_UNIT id=cu-2]] Adding fractions.',
    images: [],
    normalizedImages: [],
    visionImages: [],
    visionMapping: {},
    measuredBytes: 100,
    measuredSha256: SOURCE_SHA,
    manifest: {
      contentUnits: [
        { id: 'cu-1', orderIndex: 0, title: 'Fractions', role: 'concept', blocks: [] },
        { id: 'cu-2', orderIndex: 1, title: 'Adding fractions', role: 'procedure', blocks: [] },
      ],
    },
    blockCount: 0,
  };
}

interface Scenario {
  flow: TeachingFlowEntry[];
  teachingModel: { key: string; version: string };
  normalized?: boolean;
  learningItemId?: string;
  versionId?: string | null;
  tenantId?: string;
}

function kafuoContext(scenario: Scenario, learningItemId: string) {
  return {
    aggregate: {
      tenantId: scenario.tenantId ?? TENANT,
      learningItem: { type: 'lesson' as const, id: learningItemId },
    },
    teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
    teachingFlow: scenario.flow,
    teachingModel: scenario.teachingModel,
    learningObjectives: [{ objectiveRef: 'o1', snapshot: { statement: 's' } }],
    requirement: 'Teach adding fractions.',
    language: 'en',
    contentResource: {
      id: 'cs-1',
      url: 'https://r2.example.test/lesson.pdf?sig=abc',
      mimeType: 'application/pdf',
    } satisfies KafuoContentResource,
    generation: {},
    versionId: scenario.versionId ?? null,
    subjectCode: 'MATH',
    subjectOffering: {
      id: '10',
      name: 'Math',
      code: 'MATH',
      nameAr: 'الرياضيات',
      nameEn: 'Math',
      academicLanguage: 'en',
    },
    ...(scenario.normalized
      ? {
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
            checksumSha256: SOURCE_SHA,
          },
        }
      : {}),
  };
}

/** The outlines a persisted package Stage carries (`outline` is untyped on the document). */
function outlinesOf(document: { outline?: unknown }): Array<Record<string, unknown>> {
  return (document.outline as { outlines: Array<Record<string, unknown>> }).outlines;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('admin-correction pause / resume (real runner + real generateClassroom on PGlite)', () => {
  let pool: PGlitePool;
  let tmp: string;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  async function initProvider() {
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  }

  /** Admit the attempt exactly as the Kafuo route does: flow + contract on the row. */
  async function start(scenario: Scenario) {
    const learningItemId = scenario.learningItemId ?? `li-${randomUUID()}`;
    const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
    const started = await startGenerationAttempt(txPool(), {
      tenantId: scenario.tenantId ?? TENANT,
      learningItem: { type: 'lesson', id: learningItemId },
      teachingModel: scenario.teachingModel,
      generation: { requirement: 'Teach adding fractions.', teachingFlow: scenario.flow },
      ...(scenario.versionId ? { versionId: scenario.versionId } : {}),
      actorRef: 'kafuo:admin-1',
      requestId: `kafuo-${randomUUID()}`,
      requestDigest: DIGEST,
      teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
      teachingFlow: scenario.flow,
      contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
    });
    return { started, context: kafuoContext(scenario, learningItemId) };
  }

  /** Start + run once; returns everything a resume needs (the re-sent request). */
  async function startAndRun(scenario: Scenario) {
    const { started, context } = await start(scenario);
    const runner = await import('@/lib/server/teaching-package/generation-runner');
    await runner.runGenerationAttempt(started.attempt.id, started.execution, context);
    return { attemptId: started.attempt.id, execution: started.execution, context };
  }

  async function attempt(attemptId: string) {
    const { readAttemptById } = await import('@/lib/persistence/teaching-package');
    return (await readAttemptById(qp(), attemptId))!;
  }

  async function stageCount(): Promise<number> {
    const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM stage_meta`);
    return result.rows[0]!.n;
  }

  async function loadStage(stageId: string) {
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    return (await store.loadDocument(stageId))!;
  }

  async function currentStageOf(attemptId: string) {
    const { readVersion } = await import('@/lib/persistence/teaching-package');
    const row = await attempt(attemptId);
    const version = (await readVersion(qp(), row.versionId!, { tenantId: row.tenantId }))!;
    return { version, document: await loadStage(version.currentStageId) };
  }

  async function correction() {
    return import('@/lib/server/teaching-package/generation-correction');
  }

  async function errorOf(promise: Promise<unknown>): Promise<{ code?: string }> {
    try {
      await promise;
    } catch (error) {
      return error as { code?: string };
    }
    throw new Error('expected the call to throw');
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tp-correction-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    // Stage routes, not the subject executor: the model edges are mocked above.
    vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'off');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tp-correction-'));
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', tmp);

    mocks.outlineGeneratorCalls.length = 0;
    mocks.outlineAiCall.mockReset();
    mocks.callLLM.mockReset();
    mocks.callLLM.mockRejectedValue(new Error('no direct LLM call is expected in this suite'));
    mocks.resolveModel.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'm' },
      modelInfo: { capabilities: { vision: true } },
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.generateSceneContent.mockReset();
    mocks.generateSceneContent.mockResolvedValue({ elements: [], remark: '' });
    mocks.generateSceneActions.mockReset();
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.acquireContentResource.mockReset();
    mocks.acquireContentResource.mockResolvedValue(pdfSource());
    mocks.acquireNormalizedContentResource.mockReset();
    mocks.acquireNormalizedContentResource.mockResolvedValue(normalizedSource());

    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await initProvider();
  });

  afterEach(async () => {
    await pool.end();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // (b) position policy
  // -------------------------------------------------------------------------

  it('(b) a procedure slide at outcome_visual_explanations completes under a g5.v5 scenePolicy', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: 'procedure' })]);

    const { attemptId } = await startAndRun({
      flow: flowV5(),
      teachingModel: { key: 'g5', version: 'g5.v5' },
    });

    const row = await attempt(attemptId);
    expect(row.status).toBe('succeeded');
    expect(row.errorCode).toBeNull();
    expect(mocks.outlineAiCall).toHaveBeenCalledTimes(1);
    // The wire policy survived admission verbatim — the resume would read it back.
    expect(row.inputSnapshot.teachingFlow?.[1]?.scenePolicy).toEqual(V5_VISUAL_POLICY);
    const { document } = await currentStageOf(attemptId);
    const persisted = outlinesOf(document).find((outline) => outline.id === 'o-visual')!;
    expect(persisted.contentRole).toBe('procedure');
  });

  it('(b) the same procedure slide under a policy-less g5.v4 flow pauses with CONTENT_ROLE_NOT_ALLOWED', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: 'procedure' })]);

    const { attemptId } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });

    const row = await attempt(attemptId);
    expect(row.status).toBe('awaiting_admin_correction');
    const { getGenerationCorrection } = await correction();
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(view.blockingIssues).toEqual([
      expect.objectContaining({
        code: 'CONTENT_ROLE_NOT_ALLOWED',
        disposition: 'admin_correctable',
        outlineId: 'o-visual',
        field: 'contentRole',
        // The legacy stage rule — never widened for an old Teaching Model version.
        allowedValues: ['explanation'],
        flowIndex: 1,
        stage: 'outcome_visual_explanations',
      }),
    ]);
    // The role is reported, never rewritten from the kind or the position.
    expect(view.outlines.find((outline) => outline.id === 'o-visual')!.contentRole).toBe(
      'procedure',
    );
    expect(view.flow[1]).toMatchObject({
      policySource: 'legacy_stage_rule',
      policy: { contentRoles: ['explanation'] },
    });
  });

  // -------------------------------------------------------------------------
  // (a) the reported case
  // -------------------------------------------------------------------------

  it('(a) explanation + contentKind "procedure" is repaired — kind dropped, role kept — and the attempt completes', async () => {
    answerWith([introOutline(), visualOutline({ contentKind: 'procedure' })]);

    const { attemptId } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });

    const row = await attempt(attemptId);
    expect(row.status).toBe('succeeded');
    expect(row.errorCode).toBeNull();
    expect(row.generationRuns).toBe(1);
    expect(mocks.outlineAiCall).toHaveBeenCalledTimes(1);
    // Neither failed nor paused: no checkpoint exists.
    const checkpoints = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teaching_package_generation_checkpoints`,
    );
    expect(checkpoints.rows[0]!.n).toBe(0);
    // The repair is recorded on the outline answer (repaired, never blocking).
    const outlineResult = mocks.outlineGeneratorCalls[0]!.result as {
      success: boolean;
      data: { diagnostics: Array<Record<string, unknown>> };
    };
    expect(outlineResult.success).toBe(true);
    expect(outlineResult.data.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CONTENT_KIND_DROPPED',
        disposition: 'repaired',
        outlineId: 'o-visual',
        field: 'contentKind',
        previousValue: 'procedure',
      }),
    ]);
    const { document } = await currentStageOf(attemptId);
    const persisted = outlinesOf(document).find((outline) => outline.id === 'o-visual')!;
    expect(persisted.contentRole).toBe('explanation');
    expect(persisted).not.toHaveProperty('contentKind');
    // …and stays visible on the attempt after the clean run.
    expect(row.inputSnapshot.outlineRepairs).toEqual([
      expect.objectContaining({
        code: 'CONTENT_KIND_DROPPED',
        outlineId: 'o-visual',
        field: 'contentKind',
        previousValue: 'procedure',
      }),
    ]);
  });

  // -------------------------------------------------------------------------
  // (c) pause → edit → resume the SAME attempt
  // -------------------------------------------------------------------------

  it('(c) a missing role pauses before any Stage; an edit fixes it; the SAME attempt resumes with no second outline call', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);

    const { attemptId, execution, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });

    // Paused, not failed — before reservation, Scene generation, media or TTS.
    const paused = await attempt(attemptId);
    expect(paused).toMatchObject({
      status: 'awaiting_admin_correction',
      errorCode: null,
      versionId: null,
      generationRuns: 1,
    });
    expect(await stageCount()).toBe(0);
    expect(mocks.generateSceneContent).not.toHaveBeenCalled();
    expect(mocks.outlineAiCall).toHaveBeenCalledTimes(1);

    const { getGenerationCorrection, editGenerationCorrection, resumeGenerationAttempt } =
      await correction();
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(view).toMatchObject({
      attemptStatus: 'awaiting_admin_correction',
      phase: 'outline',
      state: 'awaiting',
      revision: 1,
      canResume: false,
      pendingOutlineIds: null,
    });
    expect(view.blockingIssues).toEqual([
      expect.objectContaining({
        code: 'CONTENT_ROLE_MISSING',
        outlineId: 'o-visual',
        field: 'contentRole',
        allowedValues: ['explanation'],
      }),
    ]);
    const stored = await pool.query<{ reserved_stage_id: string | null }>(
      `SELECT reserved_stage_id FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(stored.rows[0]!.reserved_stage_id).toBeNull();

    // The pause webhook — identity only, in the pause transaction.
    const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM teaching_package_webhook_deliveries
        WHERE learning_item_id = $1 ORDER BY sequence`,
      [context.aggregate.learningItem.id],
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      'teaching_package.generation_awaiting_correction',
    ]);
    expect(events.rows[0]!.payload).toMatchObject({
      attempt: { id: attemptId, status: 'awaiting_admin_correction' },
      correction: { phase: 'outline', revision: 1, blockingIssueCount: 1 },
    });
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain('Adding fractions');

    const edited = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [
        { op: 'set', outlineId: 'o-visual', field: 'contentRole', value: 'explanation' },
      ],
    });
    expect(edited).toMatchObject({ revision: 2, blockingIssues: [], canResume: true });
    expect(edited.editLog.at(-1)).toMatchObject({ event: 'edited', revision: 2 });

    const resumed = await resumeGenerationAttempt(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 2,
      requestDigest: DIGEST,
      learningItem: context.aggregate.learningItem,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.attempt).toMatchObject({ id: attemptId, status: 'queued' });

    const runner = await import('@/lib/server/teaching-package/generation-runner');
    await runner.runGenerationAttempt(attemptId, execution, context, { resume: true });

    const done = await attempt(attemptId);
    expect(done.status).toBe('succeeded');
    expect(done.versionId).toMatch(/^tpv-/);
    // ONE outline call across pause + resume, and the resume is not a new run.
    expect(mocks.outlineAiCall).toHaveBeenCalledTimes(1);
    expect(mocks.outlineGeneratorCalls).toHaveLength(1);
    expect(done.generationRuns).toBe(1);
    // Layer A re-acquired through the re-sent request (same measured source).
    expect(mocks.acquireContentResource).toHaveBeenCalledTimes(2);
    const { document } = await currentStageOf(attemptId);
    expect(outlinesOf(document).find((outline) => outline.id === 'o-visual')!.contentRole).toBe(
      'explanation',
    );
    expect(document.scenes).toHaveLength(2);
    const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(after).toMatchObject({ state: 'resumed', revision: 2, canResume: false });
    const allEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM teaching_package_webhook_deliveries
        WHERE learning_item_id = $1 ORDER BY sequence`,
      [context.aggregate.learningItem.id],
    );
    expect(allEvents.rows.map((event) => event.event_type)).toEqual([
      'teaching_package.generation_awaiting_correction',
      'teaching_package.generation_succeeded',
    ]);
  });

  // -------------------------------------------------------------------------
  // (d) the correction kinds
  // -------------------------------------------------------------------------

  it('(d) flow correction: a wrong teachingStage is fixed by flow index and the run completes', async () => {
    answerWith([
      introOutline(),
      visualOutline({ teachingStage: { key: 'lesson_introduction', flowIndex: 1 } }),
    ]);
    const { attemptId, execution, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const { getGenerationCorrection, editGenerationCorrection, resumeGenerationAttempt } =
      await correction();
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(view.blockingIssues).toEqual([
      expect.objectContaining({
        code: 'TEACHING_STAGE_MISMATCH',
        outlineId: 'o-visual',
        field: 'teachingStage',
        allowedValues: [0, 1],
      }),
    ]);

    const edited = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [{ op: 'set', outlineId: 'o-visual', field: 'teachingStage', value: 1 }],
    });
    expect(edited).toMatchObject({ revision: 2, blockingIssues: [], canResume: true });
    expect(edited.outlines.find((outline) => outline.id === 'o-visual')!.teachingStage).toEqual({
      key: 'outcome_visual_explanations',
      flowIndex: 1,
    });

    await resumeGenerationAttempt(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 2,
      requestDigest: DIGEST,
      learningItem: context.aggregate.learningItem,
    });
    const runner = await import('@/lib/server/teaching-package/generation-runner');
    await runner.runGenerationAttempt(attemptId, execution, context, { resume: true });
    expect((await attempt(attemptId)).status).toBe('succeeded');
    const { document } = await currentStageOf(attemptId);
    expect(document.scenes.map((scene) => scene.teachingStage?.flowIndex)).toEqual([0, 1]);
  });

  it('(d) grounding correction: an unknown Content Unit is replaced by an approved one and the normalized run completes', async () => {
    answerWith([
      introOutline({ sourceContentUnitIds: ['cu-1'] }),
      visualOutline({ sourceContentUnitIds: ['cu-404'] }),
    ]);
    const { attemptId, execution, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
      normalized: true,
    });
    expect((await attempt(attemptId)).status).toBe('awaiting_admin_correction');
    const { getGenerationCorrection, editGenerationCorrection, resumeGenerationAttempt } =
      await correction();
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(view.blockingIssues).toEqual([
      expect.objectContaining({
        code: 'GROUNDING_UNKNOWN',
        outlineId: 'o-visual',
        field: 'sourceContentUnitIds',
        allowedValues: ['cu-1', 'cu-2'],
      }),
    ]);
    // The choices are the exact unit set the grounding gate used — ids and titles, no text.
    expect(view.choices.contentUnits.map((unit) => unit.id)).toEqual(['cu-1', 'cu-2']);

    // Only units of the approved source can be chosen.
    const refused = await errorOf(
      editGenerationCorrection(txPool(), attemptId, {
        tenantId: TENANT,
        actorRef: 'kafuo:admin-1',
        expectedRevision: 1,
        operations: [
          { op: 'set', outlineId: 'o-visual', field: 'sourceContentUnitIds', value: ['cu-999'] },
        ],
      }),
    );
    expect(refused.code).toBe('INVALID_REQUEST');

    const edited = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [
        { op: 'set', outlineId: 'o-visual', field: 'sourceContentUnitIds', value: ['cu-2'] },
      ],
    });
    expect(edited).toMatchObject({ revision: 2, blockingIssues: [], canResume: true });

    await resumeGenerationAttempt(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 2,
      requestDigest: DIGEST,
      learningItem: context.aggregate.learningItem,
    });
    const runner = await import('@/lib/server/teaching-package/generation-runner');
    await runner.runGenerationAttempt(attemptId, execution, context, { resume: true });
    expect((await attempt(attemptId)).status).toBe('succeeded');
    expect(mocks.acquireNormalizedContentResource).toHaveBeenCalledTimes(2);
    expect(mocks.acquireContentResource).not.toHaveBeenCalled();
    expect(mocks.outlineAiCall).toHaveBeenCalledTimes(1);
    const { document } = await currentStageOf(attemptId);
    expect(
      outlinesOf(document).find((outline) => outline.id === 'o-visual')!.sourceContentUnitIds,
    ).toEqual(['cu-2']);
  });

  it('(d) runtime/scene-type correction: a slide at a quiz position is re-typed by an edit operation', async () => {
    answerWith([
      introOutline(),
      {
        id: 'o-check',
        type: 'slide',
        title: 'Check your understanding',
        description: 'Quick check.',
        keyPoints: ['1/2 + 1/4 = 3/4'],
        slideType: 'content',
        contentRole: 'check_understanding',
        teachingStage: { key: 'outcome_check_understanding', flowIndex: 1 },
      },
    ]);
    const { attemptId } = await startAndRun({
      flow: flowWithQuiz(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const { getGenerationCorrection, editGenerationCorrection } = await correction();
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(view.blockingIssues).toEqual([
      expect.objectContaining({
        code: 'SCENE_TYPE_NOT_ALLOWED',
        outlineId: 'o-check',
        field: 'type',
        allowedValues: ['quiz'],
      }),
    ]);

    const edited = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [{ op: 'set', outlineId: 'o-check', field: 'type', value: 'quiz' }],
    });
    expect(edited).toMatchObject({ revision: 2, blockingIssues: [], canResume: true });
    // Slide-only semantics do not survive on a quiz outline.
    expect(edited.outlines.find((outline) => outline.id === 'o-check')).toMatchObject({
      type: 'quiz',
      slideType: null,
      contentRole: null,
    });
  });

  // -------------------------------------------------------------------------
  // (e) tenant isolation
  // -------------------------------------------------------------------------

  it('(e) another tenant can neither read, edit, resume nor abandon a paused attempt', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);
    const { attemptId, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const {
      getGenerationCorrection,
      editGenerationCorrection,
      resumeGenerationAttempt,
      abandonGenerationAttempt,
    } = await correction();

    const results = [
      await errorOf(getGenerationCorrection(qp(), attemptId, { tenantId: OTHER_TENANT })),
      await errorOf(
        editGenerationCorrection(txPool(), attemptId, {
          tenantId: OTHER_TENANT,
          actorRef: 'kafuo:intruder',
          expectedRevision: 1,
          operations: [
            { op: 'set', outlineId: 'o-visual', field: 'contentRole', value: 'explanation' },
          ],
        }),
      ),
      await errorOf(
        resumeGenerationAttempt(txPool(), attemptId, {
          tenantId: OTHER_TENANT,
          actorRef: 'kafuo:intruder',
          expectedRevision: 1,
          requestDigest: DIGEST,
          learningItem: context.aggregate.learningItem,
        }),
      ),
      await errorOf(
        abandonGenerationAttempt(txPool(), attemptId, {
          tenantId: OTHER_TENANT,
          actorRef: 'kafuo:intruder',
          reason: 'not mine',
        }),
      ),
    ];
    expect(results.map((error) => error.code)).toEqual([
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
    // Nothing changed for the owner.
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    expect(view).toMatchObject({ revision: 1, state: 'awaiting' });
    expect((await attempt(attemptId)).status).toBe('awaiting_admin_correction');
  });

  // -------------------------------------------------------------------------
  // (f) guards and the resume race
  // -------------------------------------------------------------------------

  it('(f) stale revision, wrong digest and open issues are refused; one revision resumes exactly once', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);
    const { attemptId, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const { editGenerationCorrection, resumeGenerationAttempt } = await correction();
    const resume = (revision: number, requestDigest = DIGEST) =>
      resumeGenerationAttempt(txPool(), attemptId, {
        tenantId: TENANT,
        actorRef: 'kafuo:admin-1',
        expectedRevision: revision,
        requestDigest,
        learningItem: context.aggregate.learningItem,
      });
    const edit = (expectedRevision: number) =>
      editGenerationCorrection(txPool(), attemptId, {
        tenantId: TENANT,
        actorRef: 'kafuo:admin-1',
        expectedRevision,
        operations: [
          { op: 'set', outlineId: 'o-visual', field: 'contentRole', value: 'explanation' },
        ],
      });

    // Open issues: never resumed on stored diagnostics alone.
    expect((await errorOf(resume(1))).code).toBe('CORRECTION_INCOMPLETE');
    // A stale edit.
    expect((await errorOf(edit(0))).code).toBe('STALE_STATE');
    await edit(1);
    expect((await errorOf(edit(1))).code).toBe('STALE_STATE');
    // The re-sent request must be the attempt's own.
    expect((await errorOf(resume(2, 'c'.repeat(64)))).code).toBe('CORRECTION_REQUEST_MISMATCH');
    // The revision the administrator validated, not an older one.
    expect((await errorOf(resume(1))).code).toBe('STALE_STATE');

    // Two resumes of one revision: exactly one starts a worker. PGlite has one
    // connection, so the two transactions run back to back — the row lock and
    // the CAS make the second one the replay path either way.
    const first = await resume(2);
    const second = await resume(2);
    expect([first.resumed, second.resumed]).toEqual([true, false]);
    expect(second.attempt.id).toBe(attemptId);
    expect((await attempt(attemptId)).status).toBe('queued');
    // A resumed candidate can no longer be edited.
    expect((await errorOf(edit(2))).code).toBe('CORRECTION_NOT_AWAITING');
  });

  // -------------------------------------------------------------------------
  // (g) process restart + stale reclaim
  // -------------------------------------------------------------------------

  it('(g) a pause survives a process restart: only the DB and the re-sent request are needed to resume', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);
    const scenario: Scenario = {
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
      learningItemId: `li-restart-${randomUUID()}`,
    };
    const { attemptId } = await startAndRun(scenario);
    expect((await attempt(attemptId)).status).toBe('awaiting_admin_correction');

    // A paused attempt waits for a person, never for a runner: no reclaim, at any age.
    const { reclaimStaleAttempts } = await import('@/lib/persistence/teaching-package');
    expect(await reclaimStaleAttempts(qp(), null, Date.now() + 3_600_000)).toEqual([]);
    expect((await attempt(attemptId)).status).toBe('awaiting_admin_correction');

    // "Restart": every module (and in-memory map) is gone; the same database stays.
    vi.resetModules();
    await initProvider();
    const { editGenerationCorrection, resumeGenerationAttempt } = await correction();
    await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [
        { op: 'set', outlineId: 'o-visual', field: 'contentRole', value: 'explanation' },
      ],
    });
    // Kafuo re-sends the stored request (fresh URL, same semantics).
    const resent = kafuoContext(scenario, scenario.learningItemId!);
    await resumeGenerationAttempt(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 2,
      requestDigest: DIGEST,
      learningItem: resent.aggregate.learningItem,
    });

    // The resumed attempt is measured from last_resumed_at, not created_at.
    await pool.query(
      `UPDATE teaching_package_generation_attempts SET created_at = 1 WHERE id = $1`,
      [attemptId],
    );
    const resumedAt = await pool.query<{ last_resumed_at: number }>(
      `SELECT last_resumed_at FROM teaching_package_generation_attempts WHERE id = $1`,
      [attemptId],
    );
    const lastResumedAt = Number(resumedAt.rows[0]!.last_resumed_at);
    expect(lastResumedAt).toBeGreaterThan(1);
    const reclaim = await import('@/lib/persistence/teaching-package');
    expect(await reclaim.reclaimStaleAttempts(qp(), null, lastResumedAt - 1)).toEqual([]);

    const runner = await import('@/lib/server/teaching-package/generation-runner');
    await runner.runGenerationAttempt(
      attemptId,
      { requirement: 'Teach adding fractions.' },
      resent,
      {
        resume: true,
      },
    );
    const done = await attempt(attemptId);
    expect(done.status).toBe('succeeded');
    expect(done.generationRuns).toBe(1);
    expect(mocks.outlineAiCall).toHaveBeenCalledTimes(1);
  });

  it('(g) a resumed attempt that never ran is reclaimed relative to last_resumed_at', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);
    const { attemptId, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const { editGenerationCorrection, resumeGenerationAttempt } = await correction();
    await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [
        { op: 'set', outlineId: 'o-visual', field: 'contentRole', value: 'explanation' },
      ],
    });
    await resumeGenerationAttempt(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 2,
      requestDigest: DIGEST,
      learningItem: context.aggregate.learningItem,
    });
    const resumedAt = await pool.query<{ last_resumed_at: number }>(
      `SELECT last_resumed_at FROM teaching_package_generation_attempts WHERE id = $1`,
      [attemptId],
    );
    const lastResumedAt = Number(resumedAt.rows[0]!.last_resumed_at);
    const { reclaimStaleAttempts } = await import('@/lib/persistence/teaching-package');
    const reclaimed = await reclaimStaleAttempts(qp(), null, lastResumedAt + 1);
    expect(reclaimed.map((row) => row.id)).toEqual([attemptId]);
    expect(await attempt(attemptId)).toMatchObject({
      status: 'failed',
      errorCode: 'ATTEMPT_RECLAIMED_STALE',
    });
  });

  // -------------------------------------------------------------------------
  // (h) regeneration pause + abandon
  // -------------------------------------------------------------------------

  it('(h) a paused regeneration leaves the current Stage untouched; abandon fails it retryably and frees the slot', async () => {
    // A valid initial package first.
    answerWith([introOutline(), visualOutline()]);
    const learningItemId = `li-regen-${randomUUID()}`;
    const initial = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
      learningItemId,
    });
    const { version: before, document: documentBefore } = await currentStageOf(initial.attemptId);
    const versionId = before.id;
    const stagesBefore = await stageCount();

    // The regeneration's outline answer needs a person.
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);
    const regeneration = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
      learningItemId,
      versionId,
    });
    const paused = await attempt(regeneration.attemptId);
    expect(paused).toMatchObject({
      kind: 'regeneration',
      status: 'awaiting_admin_correction',
      versionId,
    });
    const { readVersion } = await import('@/lib/persistence/teaching-package');
    const during = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    expect(during.currentStageId).toBe(before.currentStageId);
    expect(await stageCount()).toBe(stagesBefore);
    expect(JSON.stringify(await loadStage(before.currentStageId))).toBe(
      JSON.stringify(documentBefore),
    );

    // The paused attempt holds the in-flight slot.
    const { startGenerationAttempt } = await import('@/lib/server/teaching-package/generation');
    const blocked = await errorOf(
      startGenerationAttempt(txPool(), {
        tenantId: TENANT,
        learningItem: { type: 'lesson', id: learningItemId },
        teachingModel: { key: 'g5', version: 'g5.v4' },
        generation: { requirement: 'again', teachingFlow: flowV4() },
        versionId,
        actorRef: 'kafuo:admin-1',
        requestId: `kafuo-${randomUUID()}`,
        requestDigest: DIGEST,
        teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
        teachingFlow: flowV4(),
        contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
      }),
    );
    expect(blocked.code).toBe('GENERATION_IN_PROGRESS');

    const { abandonGenerationAttempt, getGenerationCorrection } = await correction();
    expect(
      (
        await errorOf(
          abandonGenerationAttempt(txPool(), regeneration.attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            reason: '   ',
          }),
        )
      ).code,
    ).toBe('REASON_REQUIRED');
    const abandoned = await abandonGenerationAttempt(txPool(), regeneration.attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      reason: 'The source lesson will be revised first.',
    });
    expect(abandoned.abandoned).toBe(true);
    expect(await attempt(regeneration.attemptId)).toMatchObject({
      status: 'failed',
      errorCode: 'ADMIN_CORRECTION_ABANDONED',
      errorRetryable: true,
    });
    const view = await getGenerationCorrection(qp(), regeneration.attemptId, { tenantId: TENANT });
    expect(view.state).toBe('abandoned');
    // Idempotent.
    const again = await abandonGenerationAttempt(txPool(), regeneration.attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      reason: 'The source lesson will be revised first.',
    });
    expect(again.abandoned).toBe(false);
    const failedEvent = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM teaching_package_webhook_deliveries
        WHERE learning_item_id = $1 AND event_type = 'teaching_package.generation_failed'`,
      [learningItemId],
    );
    expect(failedEvent.rows).toHaveLength(1);
    expect(failedEvent.rows[0]!.payload).toMatchObject({
      attempt: { id: regeneration.attemptId, status: 'failed' },
      error: { code: 'ADMIN_CORRECTION_ABANDONED', retryable: true },
    });

    // The previous version's current Stage is still current and untouched.
    const after = (await readVersion(qp(), versionId, { tenantId: TENANT }))!;
    expect(after.currentStageId).toBe(before.currentStageId);
    expect(JSON.stringify(await loadStage(before.currentStageId))).toBe(
      JSON.stringify(documentBefore),
    );

    // The slot is free again.
    const next = await startGenerationAttempt(txPool(), {
      tenantId: TENANT,
      learningItem: { type: 'lesson', id: learningItemId },
      teachingModel: { key: 'g5', version: 'g5.v4' },
      generation: { requirement: 'again', teachingFlow: flowV4() },
      versionId,
      actorRef: 'kafuo:admin-1',
      requestId: `kafuo-${randomUUID()}`,
      requestDigest: DIGEST,
      teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
      teachingFlow: flowV4(),
      contentResource: { id: 'cs-1', mimeType: 'application/pdf' },
    });
    expect(next.created).toBe(true);
  });

  // -------------------------------------------------------------------------
  // scenes phase: a retained Stage, only the offending Scene regenerated
  // -------------------------------------------------------------------------

  it('scenes phase: an invalid Action is removed and its Scene marked; the package completes without an admin pause', async () => {
    // 3 Oct 2026: a reviewer can regenerate any slide, so an invalid Action no
    // longer pauses the attempt — it is removed, the Scene is marked, and the
    // package binds for review.
    answerWith([introOutline(), visualOutline()]);
    mocks.generateSceneActions.mockImplementation(async (outline: { id: string }) =>
      outline.id === 'o-visual'
        ? [{ id: 'act-bad', type: 'spotlight', elementId: 'el-missing' }]
        : [],
    );
    const { attemptId, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });

    const done = await attempt(attemptId);
    expect(done.status).toBe('succeeded');
    // The succeeded event carries the marked-scene count (never the messages).
    const succeeded = await pool.query<{
      payload: { data?: { attempt?: Record<string, unknown> } };
    }>(
      `SELECT payload FROM teaching_package_webhook_deliveries
        WHERE learning_item_id = $1 AND event_type = 'teaching_package.generation_succeeded'`,
      [context.aggregate.learningItem.id],
    );
    const payload = succeeded.rows[0]!.payload as unknown as Record<string, unknown>;
    const attemptData = ((payload.data ?? payload) as { attempt?: Record<string, unknown> })
      .attempt;
    expect(attemptData?.scenesNeedingReview).toBe(1);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
    const { document } = await currentStageOf(attemptId);
    expect(document.scenes).toHaveLength(2);
    const visual = document.scenes.find((scene) => scene.outlineId === 'o-visual')!;
    expect(visual.actions ?? []).toEqual([]);
    expect(visual.generationIssues?.map((issue) => issue.code)).toEqual([
      'ACTION_REFERENCE_INVALID',
    ]);
    const intro = document.scenes.find((scene) => scene.outlineId === 'o-intro')!;
    expect(intro.generationIssues).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (i) schema evolution
  // -------------------------------------------------------------------------

  it('(i) evolves a database with the OLD status CHECK and in-flight index, idempotently', async () => {
    const db = new PGlite();
    await db.waitReady;
    const old = new PGlitePool(db);
    const { ensureDocumentSchema } = await import('@openmaic/storage/document/pg');
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');
    const { ensureTeachingPackageSchema } = await import('@/lib/persistence/teaching-package');
    await ensureDocumentSchema(old as never);
    await ensureStageMetaSchema(old as never);
    await ensureTeachingPackageSchema(old as never);

    // Recreate the pre-feature shape.
    await old.query('DROP TABLE teaching_package_generation_checkpoints');
    await old.query('DROP INDEX tpa_tenant_single_inflight_v2');
    await old.query(
      'ALTER TABLE teaching_package_generation_attempts DROP CONSTRAINT teaching_package_generation_attempts_status_check',
    );
    await old.query(
      `ALTER TABLE teaching_package_generation_attempts ADD CONSTRAINT teaching_package_generation_attempts_status_check
         CHECK (status IN ('queued','running','succeeded','failed'))`,
    );
    await old.query('ALTER TABLE teaching_package_generation_attempts DROP COLUMN last_resumed_at');
    await old.query(
      `CREATE UNIQUE INDEX tpa_tenant_single_inflight
         ON teaching_package_generation_attempts (tenant_id, learning_item_type, learning_item_id)
         WHERE status IN ('queued','running')`,
    );
    await old.query(
      'ALTER TABLE teaching_package_webhook_deliveries DROP CONSTRAINT teaching_package_webhook_deliveries_event_type_check',
    );
    await old.query(
      `ALTER TABLE teaching_package_webhook_deliveries ADD CONSTRAINT teaching_package_webhook_deliveries_event_type_check
         CHECK (event_type IN ('teaching_package.generation_succeeded','teaching_package.generation_failed','teaching_package.status_changed'))`,
    );
    const insert = (id: string, status: string) =>
      old.query(
        `INSERT INTO teaching_package_generation_attempts
           (id, tenant_id, learning_item_type, learning_item_id, kind, status,
            requested_by_actor_ref, teaching_model_key, teaching_model_version,
            input_snapshot, created_at)
         VALUES ($1, 't', 'lesson', 'li-old', 'initial', $2, 'actor', 'g5', 'g5.v4', '{}'::jsonb, 1)`,
        [id, status],
      );
    await insert('tpa-old-running', 'running');
    // The old CHECK really is the old one.
    await expect(
      old.query(
        `UPDATE teaching_package_generation_attempts SET status = 'awaiting_admin_correction' WHERE id = 'tpa-old-running'`,
      ),
    ).rejects.toThrow();

    await expect(ensureTeachingPackageSchema(old as never)).resolves.toBeUndefined();
    await expect(ensureTeachingPackageSchema(old as never)).resolves.toBeUndefined();

    await old.query(
      `UPDATE teaching_package_generation_attempts SET status = 'awaiting_admin_correction' WHERE id = 'tpa-old-running'`,
    );
    await expect(
      old.query(
        `UPDATE teaching_package_generation_attempts SET status = 'junk' WHERE id = 'tpa-old-running'`,
      ),
    ).rejects.toThrow();
    // The paused row holds the in-flight slot under the widened index.
    await expect(insert('tpa-old-second', 'queued')).rejects.toThrow();

    const indexes = await old.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'teaching_package_generation_attempts'`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('tpa_tenant_single_inflight_v2');
    expect(names).not.toContain('tpa_tenant_single_inflight');
    const columns = await old.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'teaching_package_generation_attempts' AND column_name = 'last_resumed_at'`,
    );
    expect(columns.rows).toHaveLength(1);
    const checkpoints = await old.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teaching_package_generation_checkpoints`,
    );
    expect(checkpoints.rows[0]!.n).toBe(0);
    const eventCheck = await old.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'teaching_package_webhook_deliveries_event_type_check'`,
    );
    expect(eventCheck.rows[0]!.def).toContain('teaching_package.generation_awaiting_correction');
    await old.end();
  });
});
