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
    visualPlan: {
      mode: 'native',
      diagram: { shows: 'two fractions over one denominator', teachingPoint: 'add only the tops' },
    },
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

  describe('P1 free rule fixes before any pause (package-planner-issue-resolve-plan §3b)', () => {
    it('a slide out of stage order is moved into place, recorded, and the run completes with no pause', async () => {
      // The planner put the visual slide (stage 1) before the introduction (stage 0).
      answerWith([visualOutline(), introOutline()]);
      const { attemptId } = await startAndRun({
        flow: flowV4(),
        teachingModel: { key: 'g5', version: 'g5.v4' },
      });

      const row = await attempt(attemptId);
      expect(row.status).toBe('succeeded');
      const { document } = await currentStageOf(attemptId);
      expect(document.scenes.map((scene) => scene.teachingStage?.flowIndex)).toEqual([0, 1]);
      const snapshot = await pool.query<{ input_snapshot: Record<string, unknown> }>(
        `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      const fixes = (snapshot.rows[0]!.input_snapshot.planReview as { fixes: unknown[] }).fixes;
      expect(fixes).toEqual([
        expect.objectContaining({
          op: 'move',
          outlineId: 'o-visual',
          from: 0,
          to: 1,
          actor: 'system:plan-reviewer',
          round: 0,
          generationRun: 1,
        }),
      ]);
      // The attempt record a backend reads carries the fix without its values.
      expect(row.inputSnapshot.planReview?.fixes[0]).not.toHaveProperty('from');
      expect(row.inputSnapshot.planReview?.fixes[0]).not.toHaveProperty('to');
      expect(row.inputSnapshot.planReview?.fixes[0]).toMatchObject({
        op: 'move',
        outlineId: 'o-visual',
        actor: 'system:plan-reviewer',
      });
      // P3: the succeeded webhook carries them too, for Kafuo's Teaching Package tab.
      const delivered = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM teaching_package_webhook_deliveries
          WHERE event_type = 'teaching_package.generation_succeeded'`,
      );
      const event = delivered.rows.at(-1)!.payload as { data?: Record<string, unknown> };
      const sent = ((event.data ?? event) as { attempt: Record<string, unknown> }).attempt
        .planReviewFixes as Array<Record<string, unknown>>;
      expect(sent).toEqual([
        {
          id: expect.stringMatching(/^tpf-/),
          op: 'move',
          outlineId: 'o-visual',
          reason: expect.stringMatching(/[؀-ۿ]/),
          round: 0,
          at: expect.any(Number),
        },
      ]);
    });

    it('what the rules cannot fix still pauses: the move is kept and listed on the pause, without its undo state in the view', async () => {
      answerWith([visualOutline({ contentRole: 'procedure' }), introOutline()]);
      const { attemptId } = await startAndRun({
        flow: flowV4(),
        teachingModel: { key: 'g5', version: 'g5.v4' },
      });

      expect((await attempt(attemptId)).status).toBe('awaiting_admin_correction');
      const { getGenerationCorrection } = await correction();
      const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
      expect(view.blockingIssues.map((issue) => issue.code)).toEqual(['CONTENT_ROLE_NOT_ALLOWED']);
      expect(view.outlines.map((outline) => outline.id)).toEqual(['o-intro', 'o-visual']);
      const paused = view.editLog.find((entry) => entry.event === 'paused')!;
      expect(paused.planFixes).toEqual([
        expect.objectContaining({ op: 'move', outlineId: 'o-visual', round: 0 }),
      ]);
      expect(paused.planFixes![0]).not.toHaveProperty('from');
      expect(paused.planFixes![0]).not.toHaveProperty('to');
      // The checkpoint itself keeps the undo state for a later «تراجع».
      const stored = await pool.query<{ edit_log: Array<{ planFixes?: unknown[] }> }>(
        `SELECT edit_log FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
        [attemptId],
      );
      expect(stored.rows[0]!.edit_log[0]!.planFixes).toEqual([
        expect.objectContaining({ op: 'move', from: 0, to: 1 }),
      ]);

      // A later pause of the same attempt (the ON CONFLICT branch) appends its own
      // entry with its own fixes; a pause with none adds no `planFixes` key.
      const { upsertCheckpointForPause, readCheckpointByAttemptId } =
        await import('@/lib/persistence/generation-checkpoint');
      const checkpoint = (await readCheckpointByAttemptId(qp(), attemptId))!;
      const repause = {
        attemptId,
        tenantId: TENANT,
        phase: checkpoint.phase,
        outlines: checkpoint.outlines,
        courseTitle: checkpoint.courseTitle,
        languageDirective: checkpoint.languageDirective,
        diagnostics: checkpoint.diagnostics,
        repairs: checkpoint.repairs,
        sourceRefs: checkpoint.sourceRefs,
        reservedStageId: null,
        pendingOutlineIds: null,
        actorRef: 'runner',
        now: Date.now(),
      };
      const secondFix = {
        id: 'tpf-second',
        op: 'set' as const,
        outlineId: 'o-visual',
        field: 'teachingStage',
        from: { key: 'x', flowIndex: 0 },
        to: { key: 'outcome_visual_explanations', flowIndex: 1 },
        reason: 'تصحيح',
        actor: 'system:plan-reviewer' as const,
        round: 0,
        generationRun: 1,
        at: Date.now(),
      };
      await upsertCheckpointForPause(qp(), { ...repause, planFixes: [secondFix] });
      await upsertCheckpointForPause(qp(), repause);
      const after = await pool.query<{ edit_log: Array<Record<string, unknown>> }>(
        `SELECT edit_log FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
        [attemptId],
      );
      const pauses = after.rows[0]!.edit_log.filter((entry) => entry.event === 'paused');
      expect(pauses).toHaveLength(3);
      expect(pauses[1]!.planFixes).toEqual([secondFix]);
      expect(pauses[2]).not.toHaveProperty('planFixes');
    });

    it('P2: the rule fixes move the slide, the plan reviewer fixes the role, and the run completes with every fix recorded', async () => {
      // The visual slide is out of order (a rule fix) AND has a role its stage does not
      // allow (only the reviewer can fix it): together they used to pause for a person.
      answerWith([visualOutline({ contentRole: 'procedure' }), introOutline()]);
      // The reviewer's one call (the outline call, on the planning route): a `set`.
      const reviewCalls: string[] = [];
      mocks.callLLM.mockImplementation(
        async (params: { messages: Array<{ role: string; content: unknown }> }) => {
          const system = String(params.messages[0]?.content ?? '');
          if (!system.startsWith('You are the plan reviewer')) {
            throw new Error('no other direct LLM call is expected in this suite');
          }
          reviewCalls.push(String(params.messages[1]?.content ?? ''));
          return {
            text: JSON.stringify({
              ops: [
                {
                  op: 'set',
                  outlineId: 'o-visual',
                  field: 'contentRole',
                  value: 'explanation',
                  reason: 'الدور ده مش مسموح في المرحلة دي',
                },
              ],
            }),
          };
        },
      );

      const { attemptId } = await startAndRun({
        flow: flowV4(),
        teachingModel: { key: 'g5', version: 'g5.v4' },
      });

      expect((await attempt(attemptId)).status).toBe('succeeded');
      expect(reviewCalls).toHaveLength(1);
      // The reviewer saw the plan after the rule fix, with only the role issue open.
      expect(reviewCalls[0]).toContain('CONTENT_ROLE_NOT_ALLOWED');
      expect(reviewCalls[0]).not.toContain('FLOW_SEQUENCE_INVALID');
      const { document } = await currentStageOf(attemptId);
      expect(outlinesOf(document).map((outline) => [outline.id, outline.contentRole])).toEqual([
        ['o-intro', 'explanation'],
        ['o-visual', 'explanation'],
      ]);
      const snapshot = await pool.query<{ input_snapshot: Record<string, unknown> }>(
        `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
        [attemptId],
      );
      const fixes = (snapshot.rows[0]!.input_snapshot.planReview as { fixes: unknown[] }).fixes;
      expect(fixes).toEqual([
        expect.objectContaining({ op: 'move', outlineId: 'o-visual', round: 0 }),
        expect.objectContaining({
          op: 'set',
          outlineId: 'o-visual',
          field: 'contentRole',
          from: 'procedure',
          to: 'explanation',
          reason: 'الدور ده مش مسموح في المرحلة دي',
          actor: 'system:plan-reviewer',
          round: 1,
        }),
      ]);
    });

    describe('P3: what a person sees and undoes (package-plan-review-p3-contract)', () => {
      async function pausedWithMove() {
        answerWith([visualOutline({ contentRole: 'procedure' }), introOutline()]);
        const started = await startAndRun({
          flow: flowV4(),
          teachingModel: { key: 'g5', version: 'g5.v4' },
        });
        expect((await attempt(started.attemptId)).status).toBe('awaiting_admin_correction');
        return started;
      }

      /**
       * Make the paused attempt look like one from before the plan review: no marks and
       * no fixes on the checkpoint or the attempt record, and (by default) the slides
       * back out of order, as the old runner left them.
       */
      async function asOldPause(attemptId: string, options: { reorder?: boolean } = {}) {
        await pool.query(
          `UPDATE teaching_package_generation_checkpoints
              SET edit_log = (SELECT jsonb_agg(entry - 'planReviewed' - 'planFixes')
                                FROM jsonb_array_elements(edit_log) AS entry)
            WHERE attempt_id = $1`,
          [attemptId],
        );
        if (options.reorder !== false) {
          await pool.query(
            `UPDATE teaching_package_generation_checkpoints
                SET outlines = (SELECT jsonb_agg(o ORDER BY (o->>'id') DESC)
                                  FROM jsonb_array_elements(outlines) AS o)
              WHERE attempt_id = $1`,
            [attemptId],
          );
        }
        await pool.query(
          `UPDATE teaching_package_generation_attempts
              SET input_snapshot = input_snapshot - 'planReview'
            WHERE id = $1`,
          [attemptId],
        );
      }

      /** The attempt record's `planReview`, as stored (with the values). */
      async function storedPlanReview(attemptId: string) {
        const result = await pool.query<{ input_snapshot: Record<string, unknown> }>(
          `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
          [attemptId],
        );
        return result.rows[0]!.input_snapshot.planReview as
          | { fixes: Array<Record<string, unknown>>; promptVersion?: string }
          | undefined;
      }

      /** The suite's pool, whose first statement matching `pattern` fails (pool or transaction). */
      function failingOnce(pattern: RegExp) {
        let failures = 0;
        const fails = (text: string) => {
          if (failures > 0 || !pattern.test(text)) return false;
          failures += 1;
          return true;
        };
        const wrapped = {
          query: (text: string, params?: unknown[]) =>
            fails(text) ? Promise.reject(new Error('write failed')) : pool.query(text, params),
          connect: async () => {
            const client = await pool.connect();
            return {
              query: (text: string, params?: unknown[]) =>
                fails(text)
                  ? Promise.reject(new Error('write failed'))
                  : client.query(text, params),
              release: () => client.release(),
            };
          },
        } as unknown as ConnectableQueryable;
        return { pool: wrapped, failures: () => failures };
      }

      async function startReview(attemptId: string) {
        const { getGenerationCorrection, editGenerationCorrection } = await correction();
        const before = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(before.planReview).toEqual({ status: 'not_reviewed' });
        return editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: before.revision,
          operations: [{ op: 'review_plan' }],
        });
      }

      /** The reviewer's answer: the role its stage allows. */
      const roleReviewer = () =>
        vi.fn(async () =>
          JSON.stringify({
            ops: [
              {
                op: 'set',
                outlineId: 'o-visual',
                field: 'contentRole',
                value: 'explanation',
                reason: 'الدور مش مسموح هنا',
              },
            ],
          }),
        );

      it('lists the fixes without their values, and «تراجع» puts one back, once', async () => {
        const { attemptId } = await pausedWithMove();
        const { getGenerationCorrection, editGenerationCorrection } = await correction();
        const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(view.planReview).toEqual({ status: 'reviewed' });
        expect(view.autoFixes).toEqual([
          {
            id: expect.stringMatching(/^tpf-/),
            op: 'move',
            outlineId: 'o-visual',
            reason: expect.stringMatching(/[؀-ۿ]/),
            round: 0,
            at: expect.any(Number),
            reverted: false,
          },
        ]);
        const fixId = view.autoFixes[0]!.id;
        expect((await storedPlanReview(attemptId))?.fixes.map((fix) => fix.id)).toEqual([fixId]);

        const undone = await editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: view.revision,
          operations: [{ op: 'revert_fix', fixId }],
        });
        expect(undone.outlines.map((outline) => outline.id)).toEqual(['o-visual', 'o-intro']);
        expect(undone.autoFixes[0]!.reverted).toBe(true);
        // Re-diagnosed like any edit: the order issue is back.
        expect(undone.blockingIssues.map((issue) => issue.code)).toContain('FLOW_SEQUENCE_INVALID');
        // HIGH 1: the undone fix left the attempt record in the same edit; none is left.
        expect(await storedPlanReview(attemptId)).toBeUndefined();

        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: undone.revision,
            operations: [{ op: 'revert_fix', fixId }],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: undone.revision,
            operations: [{ op: 'revert_fix', fixId: 'tpf-unknown' }],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      });

      it('Agent API E2: a dry-run «تراجع» shows the undo and leaves the plan review untouched', async () => {
        const { attemptId } = await pausedWithMove();
        const { getGenerationCorrection, editGenerationCorrection } = await correction();
        const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        const fixId = view.autoFixes[0]!.id;
        const checkpointBefore = (
          await pool.query(
            `SELECT * FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
            [attemptId],
          )
        ).rows[0];
        const reviewBefore = await storedPlanReview(attemptId);

        const dry = await editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: view.revision,
          operations: [{ op: 'revert_fix', fixId }],
          dryRun: true,
        });
        expect(dry.revision).toBe(view.revision);
        expect(dry.outlines.map((outline) => outline.id)).toEqual(['o-visual', 'o-intro']);
        // Nothing stored: the checkpoint, the attempt's plan review and its fix are as they were.
        const checkpointAfter = (
          await pool.query(
            `SELECT * FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
            [attemptId],
          )
        ).rows[0];
        expect(checkpointAfter).toEqual(checkpointBefore);
        expect(await storedPlanReview(attemptId)).toEqual(reviewBefore);
        expect((await storedPlanReview(attemptId))?.fixes.map((fix) => fix.id)).toEqual([fixId]);
        const reread = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(reread.autoFixes[0]!.reverted).toBe(false);
      });

      it('undoes a removed slide and an added one through the edit', async () => {
        const { attemptId } = await pausedWithMove();
        const extra = { ...visualOutline({ id: 'o-extra', title: 'Extra' }), order: 2 };
        const fix = (entry: Record<string, unknown>) => ({
          reason: 'إصلاح',
          actor: 'system:plan-reviewer',
          round: 1,
          generationRun: 1,
          at: Date.now(),
          ...entry,
        });
        // Two recorded fixes: the reviewer removed `o-extra` at index 1, and (as if
        // later) added it. Undone in that order, the slide comes back, then goes again.
        await pool.query(
          `UPDATE teaching_package_generation_checkpoints
              SET edit_log = edit_log || $2::jsonb
            WHERE attempt_id = $1`,
          [
            attemptId,
            JSON.stringify([
              {
                event: 'edited',
                actorRef: 'system:plan-reviewer',
                at: Date.now(),
                operations: [],
                blockingCount: 1,
                revision: 1,
                planFixes: [
                  fix({
                    id: 'tpf-rm',
                    op: 'remove',
                    outlineId: 'o-extra',
                    from: { index: 1, outline: extra },
                  }),
                  fix({ id: 'tpf-add', op: 'insert_book_slide', outlineId: 'o-extra', to: 1 }),
                ],
              },
            ]),
          ],
        );
        const { getGenerationCorrection, editGenerationCorrection } = await correction();
        const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(view.outlines.map((outline) => outline.id)).toEqual(['o-intro', 'o-visual']);

        const restored = await editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: view.revision,
          operations: [{ op: 'revert_fix', fixId: 'tpf-rm' }],
        });
        expect(restored.outlines.map((outline) => outline.id)).toEqual([
          'o-intro',
          'o-extra',
          'o-visual',
        ]);
        expect(restored.outlines[1]!.title).toBe('Extra');

        const removedAgain = await editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: restored.revision,
          operations: [{ op: 'revert_fix', fixId: 'tpf-add' }],
        });
        expect(removedAgain.outlines.map((outline) => outline.id)).toEqual(['o-intro', 'o-visual']);
        expect(
          removedAgain.autoFixes.filter((entry) => entry.reverted).map((entry) => entry.id),
        ).toEqual(['tpf-rm', 'tpf-add']);
      });

      it('a plan that paused before the review existed is reviewed once, in the background, and edits wait for it', async () => {
        const { attemptId, context } = await pausedWithMove();
        await asOldPause(attemptId);
        const {
          getGenerationCorrection,
          editGenerationCorrection,
          resumeGenerationAttempt,
          runCheckpointPlanReview,
        } = await correction();
        const before = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(before.planReview).toEqual({ status: 'not_reviewed' });
        expect(before.autoFixes).toEqual([]);

        const started = await startReview(attemptId);
        expect(started.planReview).toEqual({ status: 'reviewing' });
        expect(started.canResume).toBe(false);
        // Nothing else may change the plan, or resume it, or start it again, while the
        // review runs.
        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: started.revision,
            operations: [{ op: 'remove', outlineId: 'o-intro' }],
          }),
        ).rejects.toMatchObject({ code: 'STALE_STATE' });
        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: started.revision,
            operations: [{ op: 'review_plan' }],
          }),
        ).rejects.toMatchObject({ code: 'STALE_STATE' });
        await expect(
          resumeGenerationAttempt(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: started.revision,
            requestDigest: DIGEST,
            learningItem: context.aggregate.learningItem,
          }),
        ).rejects.toMatchObject({ code: 'STALE_STATE' });

        // The background half: the rule fix moves the slide; the reviewer sets the role.
        const aiCall = roleReviewer();
        await runCheckpointPlanReview(txPool(), attemptId, { tenantId: TENANT }, { aiCall });
        expect(aiCall).toHaveBeenCalledTimes(1);
        // HIGH 2: no slide is offered for a new working step on this review.
        expect(String((aiCall.mock.calls[0] as unknown[])[1])).toContain('- keyPoints: none');

        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.planReview).toEqual({ status: 'reviewed' });
        expect(after.blockingIssues).toEqual([]);
        expect(after.canResume).toBe(true);
        expect(after.outlines.map((outline) => [outline.id, outline.contentRole])).toEqual([
          ['o-intro', 'explanation'],
          ['o-visual', 'explanation'],
        ]);
        expect(after.autoFixes.map((fix) => [fix.op, fix.outlineId, fix.round])).toEqual([
          ['move', 'o-visual', 0],
          ['set', 'o-visual', 1],
        ]);
        // Once per checkpoint.
        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: after.revision,
            operations: [{ op: 'review_plan' }],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      });

      it('HIGH 1: the background review’s fixes reach the attempt record and the succeeded webhook; an undone one never does', async () => {
        const { attemptId, execution, context } = await pausedWithMove();
        await asOldPause(attemptId);
        const {
          getGenerationCorrection,
          editGenerationCorrection,
          resumeGenerationAttempt,
          runCheckpointPlanReview,
        } = await correction();
        const { PLAN_REVIEW_PROMPT_VERSION } =
          await import('@/lib/server/teaching-package/plan-review');
        await startReview(attemptId);
        await runCheckpointPlanReview(
          txPool(),
          attemptId,
          { tenantId: TENANT },
          { aiCall: roleReviewer() },
        );

        const reviewed = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        const [move, set] = reviewed.autoFixes;
        // The attempt record keeps them as a run's own: with their undo state, the run's
        // number and the reviewer's prompt version.
        expect(await storedPlanReview(attemptId)).toEqual({
          fixes: [
            expect.objectContaining({ id: move!.id, op: 'move', from: 0, to: 1, generationRun: 1 }),
            expect.objectContaining({
              id: set!.id,
              op: 'set',
              field: 'contentRole',
              from: 'procedure',
              to: 'explanation',
              round: 1,
              generationRun: 1,
            }),
          ],
          promptVersion: PLAN_REVIEW_PROMPT_VERSION,
        });

        // «تراجع» on the role: the attempt record drops it in the same edit.
        const undone = await editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: reviewed.revision,
          operations: [{ op: 'revert_fix', fixId: set!.id }],
        });
        expect(undone.outlines.find((outline) => outline.id === 'o-visual')!.contentRole).toBe(
          'procedure',
        );
        expect((await storedPlanReview(attemptId))?.fixes.map((fix) => fix.id)).toEqual([move!.id]);
        const roleIssue = undone.blockingIssues.find(
          (issue) => issue.code === 'CONTENT_ROLE_NOT_ALLOWED',
        )!;
        const ignored = await editGenerationCorrection(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: undone.revision,
          operations: [{ op: 'ignore_issue', issueKey: roleIssue.key }],
        });
        expect(ignored.canResume).toBe(true);

        await resumeGenerationAttempt(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          expectedRevision: ignored.revision,
          requestDigest: DIGEST,
          learningItem: context.aggregate.learningItem,
        });
        const runner = await import('@/lib/server/teaching-package/generation-runner');
        await runner.runGenerationAttempt(attemptId, execution, context, { resume: true });
        expect((await attempt(attemptId)).status).toBe('succeeded');

        const delivered = await pool.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM teaching_package_webhook_deliveries
            WHERE event_type = 'teaching_package.generation_succeeded'`,
        );
        const event = delivered.rows.at(-1)!.payload as { data?: Record<string, unknown> };
        const sent = ((event.data ?? event) as { attempt: Record<string, unknown> }).attempt
          .planReviewFixes as Array<Record<string, unknown>>;
        expect(sent).toEqual([
          {
            id: move!.id,
            op: 'move',
            outlineId: 'o-visual',
            reason: expect.stringMatching(/[؀-ۿ]/),
            round: 0,
            at: expect.any(Number),
          },
        ]);
      });

      it('a review whose route fails keeps only the rule fixes, and still finishes', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId);
        const { getGenerationCorrection, runCheckpointPlanReview } = await correction();
        await startReview(attemptId);
        // No injected call: the stage route (routing is off in this suite) resolves its
        // model on the first call, and that fails.
        mocks.resolveModel.mockRejectedValue(new Error('no model for this stage'));
        await runCheckpointPlanReview(txPool(), attemptId, { tenantId: TENANT });

        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.planReview).toEqual({ status: 'reviewed' });
        // The free move is kept; nothing of the AI review is.
        expect(after.outlines.map((outline) => outline.id)).toEqual(['o-intro', 'o-visual']);
        expect(after.autoFixes.map((fix) => [fix.op, fix.round])).toEqual([['move', 0]]);
        expect(after.blockingIssues.map((issue) => issue.code)).toEqual([
          'CONTENT_ROLE_NOT_ALLOWED',
        ]);
        const stored = await storedPlanReview(attemptId);
        expect(stored?.fixes.map((fix) => fix.op)).toEqual(['move']);
        // No reviewer fix was kept, so no reviewer prompt version is recorded.
        expect(stored).not.toHaveProperty('promptVersion');
      });

      it('a review whose call fails still finishes, with the plan as it was', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId, { reorder: false });
        const { getGenerationCorrection, runCheckpointPlanReview } = await correction();
        await startReview(attemptId);
        await runCheckpointPlanReview(
          txPool(),
          attemptId,
          { tenantId: TENANT },
          {
            aiCall: async () => {
              throw new Error('route down');
            },
          },
        );
        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.planReview).toEqual({ status: 'reviewed' });
        expect(after.blockingIssues.map((issue) => issue.code)).toEqual([
          'CONTENT_ROLE_NOT_ALLOWED',
        ]);
        expect(after.autoFixes).toEqual([]);
        expect(await storedPlanReview(attemptId)).toBeUndefined();
      });

      it('a failure while storing finishes the review unchanged, from the revision it started at', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId);
        const { getGenerationCorrection, runCheckpointPlanReview } = await correction();
        const started = await startReview(attemptId);
        // The attempt-record write inside the finish transaction fails once: the whole
        // transaction rolls back, and the catch finishes the review with the plan as it was.
        const flaky = failingOnce(
          /UPDATE teaching_package_generation_attempts\s+SET input_snapshot/,
        );

        await runCheckpointPlanReview(
          flaky.pool,
          attemptId,
          { tenantId: TENANT },
          { aiCall: roleReviewer() },
        );

        expect(flaky.failures()).toBe(1);
        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.planReview).toEqual({ status: 'reviewed' });
        expect(after.revision).toBe(started.revision + 1);
        expect(after.outlines.map((outline) => outline.id)).toEqual(['o-visual', 'o-intro']);
        expect(after.autoFixes).toEqual([]);
        expect(await storedPlanReview(attemptId)).toBeUndefined();
      });

      it('a failed review never finishes a newer one: the unchanged finish is written against the revision it started at', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId);
        const { getGenerationCorrection, runCheckpointPlanReview } = await correction();
        const started = await startReview(attemptId);
        // While this review waits on its model, the checkpoint moves on: it went stale
        // and a newer review started (a fresh `started` entry at the next revision).
        const aiCall = vi.fn(async () => {
          await pool.query(
            `UPDATE teaching_package_generation_checkpoints
                SET revision = revision + 1,
                    edit_log = edit_log || $2::jsonb
              WHERE attempt_id = $1`,
            [
              attemptId,
              JSON.stringify([
                {
                  event: 'edited',
                  actorRef: 'kafuo:admin-2',
                  at: Date.now(),
                  operations: [{ op: 'review_plan' }],
                  blockingCount: 1,
                  planReview: 'started',
                  revision: started.revision + 1,
                },
              ]),
            ],
          );
          return roleReviewer()();
        });
        // Then this review's own store fails, so it takes the unchanged-finish path.
        const flaky = failingOnce(/UPDATE teaching_package_generation_checkpoints\s+SET outlines/);

        await runCheckpointPlanReview(flaky.pool, attemptId, { tenantId: TENANT }, { aiCall });

        expect(flaky.failures()).toBe(1);
        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        // The newer review is still running: nothing finished it.
        expect(after.revision).toBe(started.revision + 1);
        expect(after.planReview).toEqual({ status: 'reviewing' });
        expect(after.autoFixes).toEqual([]);
      });

      it('a call that fails in round 2 keeps nothing of the AI review, not even round 1', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId, { reorder: false });
        // A second slide with the same role problem: round 1 fixes one, round 2 fails.
        await pool.query(
          `UPDATE teaching_package_generation_checkpoints
              SET outlines = outlines || $2::jsonb
            WHERE attempt_id = $1`,
          [
            attemptId,
            JSON.stringify([
              {
                ...visualOutline({ id: 'o-visual-2', title: 'Second', contentRole: 'procedure' }),
                order: 3,
              },
            ]),
          ],
        );
        const { getGenerationCorrection, runCheckpointPlanReview } = await correction();
        await startReview(attemptId);
        const aiCall = vi
          .fn<() => Promise<string>>()
          .mockImplementationOnce(roleReviewer())
          .mockImplementationOnce(async () => {
            throw new Error('route spent');
          });

        await runCheckpointPlanReview(txPool(), attemptId, { tenantId: TENANT }, { aiCall });

        expect(aiCall).toHaveBeenCalledTimes(2);
        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.planReview).toEqual({ status: 'reviewed' });
        expect(after.autoFixes).toEqual([]);
        expect(after.blockingIssues.map((issue) => [issue.code, issue.outlineId]).sort()).toEqual([
          ['CONTENT_ROLE_NOT_ALLOWED', 'o-visual'],
          ['CONTENT_ROLE_NOT_ALLOWED', 'o-visual-2'],
        ]);
        expect(after.outlines.find((outline) => outline.id === 'o-visual')!.contentRole).toBe(
          'procedure',
        );
        expect(await storedPlanReview(attemptId)).toBeUndefined();
      });

      it("stores the fresh diagnosis's repairs with the checkpoint's, like an edit", async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId, { reorder: false });
        // A structural slide carrying a role its position does not allow: today's
        // diagnosis drops the role and records the repair.
        await pool.query(
          `UPDATE teaching_package_generation_checkpoints
              SET outlines = outlines || $2::jsonb
            WHERE attempt_id = $1`,
          [
            attemptId,
            JSON.stringify([
              {
                ...visualOutline({
                  id: 'o-bridge',
                  title: 'Next up',
                  slideType: 'transition',
                  contentRole: 'procedure',
                }),
                order: 3,
              },
            ]),
          ],
        );
        const { getGenerationCorrection, runCheckpointPlanReview } = await correction();
        const started = await startReview(attemptId);
        expect(started.repairs.map((repair) => repair.code)).not.toContain(
          'STRUCTURAL_CONTENT_ROLE_DROPPED',
        );

        await runCheckpointPlanReview(
          txPool(),
          attemptId,
          { tenantId: TENANT },
          { aiCall: roleReviewer() },
        );

        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.planReview).toEqual({ status: 'reviewed' });
        expect(after.repairs.slice(0, started.repairs.length)).toEqual(started.repairs);
        expect(after.repairs).toContainEqual(
          expect.objectContaining({
            code: 'STRUCTURAL_CONTENT_ROLE_DROPPED',
            outlineId: 'o-bridge',
          }),
        );
      });

      it('review_plan is refused with other ops, and in the scenes phase (which reports reviewed)', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId);
        const { getGenerationCorrection, editGenerationCorrection } = await correction();
        const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(view.planReview).toEqual({ status: 'not_reviewed' });
        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: view.revision,
            operations: [{ op: 'review_plan' }, { op: 'remove', outlineId: 'o-intro' }],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

        await pool.query(
          `UPDATE teaching_package_generation_checkpoints SET phase = 'scenes' WHERE attempt_id = $1`,
          [attemptId],
        );
        const scenes = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(scenes.planReview).toEqual({ status: 'reviewed' });
        await expect(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'kafuo:admin-1',
            expectedRevision: scenes.revision,
            operations: [{ op: 'review_plan' }],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      });

      it('an abandon during the review never shows it running, and the review then stores nothing', async () => {
        const { attemptId } = await pausedWithMove();
        await asOldPause(attemptId);
        const { getGenerationCorrection, abandonGenerationAttempt, runCheckpointPlanReview } =
          await correction();
        const started = await startReview(attemptId);
        expect(started.planReview).toEqual({ status: 'reviewing' });
        await abandonGenerationAttempt(txPool(), attemptId, {
          tenantId: TENANT,
          actorRef: 'kafuo:admin-1',
          reason: 'start over',
        });
        const abandoned = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(abandoned.planReview).toEqual({ status: 'reviewed' });

        const aiCall = roleReviewer();
        await runCheckpointPlanReview(txPool(), attemptId, { tenantId: TENANT }, { aiCall });
        expect(aiCall).not.toHaveBeenCalled();
        const after = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
        expect(after.revision).toBe(abandoned.revision);
        expect(after.autoFixes).toEqual([]);
      });
    });

    // The rollback case (the key's position would break the order, so the run still
    // pauses with the mismatch) is test (d) "flow correction" below, unchanged.
    it('a stage key that names one flow position fixes its index and the run completes', async () => {
      // Key and index disagree; the key names position 1, and moving the index there
      // keeps the order valid, so it is fixed.
      answerWith([
        introOutline(),
        visualOutline({ teachingStage: { key: 'outcome_visual_explanations', flowIndex: 0 } }),
      ]);
      const fixed = await startAndRun({
        flow: flowV4(),
        teachingModel: { key: 'g5', version: 'g5.v4' },
      });
      expect((await attempt(fixed.attemptId)).status).toBe('succeeded');
    });
  });

  it('(b) an ignored issue no longer blocks: the edit, the resume and the resumed run accept it', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: 'procedure' })]);
    const { attemptId, execution, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const { getGenerationCorrection, editGenerationCorrection, resumeGenerationAttempt } =
      await correction();
    const view = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });
    const [issue] = view.blockingIssues;
    expect(issue).toMatchObject({
      code: 'CONTENT_ROLE_NOT_ALLOWED',
      key: expect.any(String),
      ignorable: true,
    });

    // A key that is not open is refused, never stored as a blank waiver.
    await expect(
      editGenerationCorrection(txPool(), attemptId, {
        tenantId: TENANT,
        actorRef: 'kafuo:admin-1',
        expectedRevision: 1,
        operations: [{ op: 'ignore_issue', issueKey: '["NOPE",null,null,"x"]' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const edited = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 1,
      operations: [{ op: 'ignore_issue', issueKey: issue!.key }],
    });
    expect(edited).toMatchObject({ revision: 2, blockingIssues: [], canResume: true });
    expect(edited.ignoredIssues).toEqual([
      expect.objectContaining({
        key: issue!.key,
        code: 'CONTENT_ROLE_NOT_ALLOWED',
        outlineId: 'o-visual',
        // The wording when it was ignored, recorded by the server.
        message: issue!.message,
        actorRef: 'kafuo:admin-1',
      }),
    ]);

    await resumeGenerationAttempt(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'kafuo:admin-1',
      expectedRevision: 2,
      requestDigest: DIGEST,
      learningItem: context.aggregate.learningItem,
    });
    const runner = await import('@/lib/server/teaching-package/generation-runner');
    await runner.runGenerationAttempt(attemptId, execution, context, { resume: true });

    // The resumed run's outline gate did not pause on the ignored issue again.
    const done = await attempt(attemptId);
    expect(done.status).not.toBe('awaiting_admin_correction');
    const { document } = await currentStageOf(attemptId);
    expect(outlinesOf(document).find((outline) => outline.id === 'o-visual')!.contentRole).toBe(
      'procedure',
    );
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

  // -------------------------------------------------------------------------
  // (j) Kafuo Agent API E2: dry runs save nothing
  // -------------------------------------------------------------------------

  it('(j) a dry-run edit returns the view it would produce and saves nothing; a dry-run resume changes nothing', async () => {
    answerWith([introOutline(), visualOutline({ contentRole: undefined })]);
    const { attemptId, context } = await startAndRun({
      flow: flowV4(),
      teachingModel: { key: 'g5', version: 'g5.v4' },
    });
    const { getGenerationCorrection, editGenerationCorrection, resumeGenerationAttempt } =
      await correction();
    const checkpointRow = async () =>
      (
        await pool.query<Record<string, unknown>>(
          `SELECT * FROM teaching_package_generation_checkpoints WHERE attempt_id = $1`,
          [attemptId],
        )
      ).rows[0];
    const attemptRow = async () =>
      (
        await pool.query<Record<string, unknown>>(
          `SELECT * FROM teaching_package_generation_attempts WHERE id = $1`,
          [attemptId],
        )
      ).rows[0];
    const fix = [
      {
        op: 'set' as const,
        outlineId: 'o-visual',
        field: 'contentRole' as const,
        value: 'explanation',
      },
    ];
    const before = { checkpoint: await checkpointRow(), attempt: await attemptRow() };
    const viewBefore = await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT });

    const dry = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'agent:5',
      expectedRevision: 1,
      operations: fix,
      dryRun: true,
    });
    // The view the edit would produce, at the STORED revision.
    expect(dry).toMatchObject({ revision: 1, blockingIssues: [], canResume: true });
    expect(dry.editLog.at(-1)).toMatchObject({ event: 'edited', actorRef: 'agent:5', revision: 2 });
    // Nothing saved: the checkpoint, the attempt and the read view are unchanged.
    expect(await checkpointRow()).toEqual(before.checkpoint);
    expect(await attemptRow()).toEqual(before.attempt);
    expect(await getGenerationCorrection(qp(), attemptId, { tenantId: TENANT })).toEqual(
      viewBefore,
    );

    // Every other agent op as a dry run: the would-be view, and the rows untouched.
    const dryOf = (operations: Parameters<typeof editGenerationCorrection>[2]['operations']) =>
      editGenerationCorrection(txPool(), attemptId, {
        tenantId: TENANT,
        actorRef: 'agent:5',
        expectedRevision: 1,
        operations,
        dryRun: true,
      });
    const issueKey = viewBefore.blockingIssues[0]!.key;
    const ignored = await dryOf([{ op: 'ignore_issue', issueKey }]);
    expect(ignored).toMatchObject({ revision: 1, blockingIssues: [] });
    expect(ignored.ignoredIssues.map((issue) => issue.key)).toEqual([issueKey]);
    const removed = await dryOf([{ op: 'remove', outlineId: 'o-visual' }]);
    expect(removed.revision).toBe(1);
    expect(removed.outlines.map((outline) => outline.id)).not.toContain('o-visual');
    const moved = await dryOf([{ op: 'move', outlineId: 'o-visual', toIndex: 0 }]);
    expect(moved.revision).toBe(1);
    expect(moved.outlines[0]!.id).toBe('o-visual');
    // This attempt has no book map, so the engine refuses the insert, dry run or not.
    expect(
      (await errorOf(dryOf([{ op: 'insert_book_slide', outlineId: 'o-intro', unitId: 'cu-1' }])))
        .code,
    ).toBe('INVALID_REQUEST');
    expect(await checkpointRow()).toEqual(before.checkpoint);
    expect(await attemptRow()).toEqual(before.attempt);

    // A dry run still refuses a stale revision and a plan review.
    expect(
      (
        await errorOf(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'agent:5',
            expectedRevision: 0,
            operations: fix,
            dryRun: true,
          }),
        )
      ).code,
    ).toBe('STALE_STATE');
    expect(
      (
        await errorOf(
          editGenerationCorrection(txPool(), attemptId, {
            tenantId: TENANT,
            actorRef: 'agent:5',
            expectedRevision: 1,
            operations: [{ op: 'review_plan' }],
            dryRun: true,
          }),
        )
      ).code,
    ).toBe('INVALID_REQUEST');

    const resume = (revision: number, dryRun: boolean) =>
      resumeGenerationAttempt(txPool(), attemptId, {
        tenantId: TENANT,
        actorRef: 'agent:5',
        expectedRevision: revision,
        requestDigest: DIGEST,
        learningItem: context.aggregate.learningItem,
        dryRun,
      });
    // Open issues are refused by the dry run as by the real resume.
    expect((await errorOf(resume(1, true))).code).toBe('CORRECTION_INCOMPLETE');

    // The real edit, then a dry-run resume: ready, and nothing changes.
    const edited = await editGenerationCorrection(txPool(), attemptId, {
      tenantId: TENANT,
      actorRef: 'agent:5',
      expectedRevision: 1,
      operations: fix,
    });
    expect(edited).toMatchObject({ revision: 2, canResume: true });
    expect(edited.editLog.at(-1)).toMatchObject({ actorRef: 'agent:5', revision: 2 });
    const ready = { checkpoint: await checkpointRow(), attempt: await attemptRow() };
    const dryResume = await resume(2, true);
    expect(dryResume).toMatchObject({ resumed: false, wouldResume: true });
    expect(dryResume.attempt.status).toBe('awaiting_admin_correction');
    expect(await checkpointRow()).toEqual(ready.checkpoint);
    expect(await attemptRow()).toEqual(ready.attempt);
    expect((await errorOf(resume(1, true))).code).toBe('STALE_STATE');

    // The real resume still resumes once; a later dry run answers as a replay.
    expect((await resume(2, false)).resumed).toBe(true);
    // The audit names the agent on the resume too.
    const resumedLog = (await checkpointRow())!.edit_log as Array<Record<string, unknown>>;
    expect(resumedLog.at(-1)).toMatchObject({ event: 'resumed', actorRef: 'agent:5' });
    const replay = await resume(2, true);
    expect(replay).toMatchObject({ resumed: false });
    expect(replay.wouldResume).toBeUndefined();
  });
});
