/**
 * Teaching Question generation from an APPROVED Teaching Package (Kafuo
 * question-flow closure, B1). TE resolves its own retained context — the
 * objectives, the flow, the final Scenes and the extracted lesson source text —
 * so Kafuo never resends package content and the transient presigned URL is
 * never needed again.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureTeachingModelAttemptsSchema,
  type TeachingModelAttemptRow,
} from '@/lib/persistence/teaching-model-attempts';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readRetainedVersionContext,
  sourceContextMaxChars,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { envelopeViolations } from '@/lib/server/teaching-package/question-envelope';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  expandFlowStages,
  generateTeachingQuestionSet,
  renderSceneText,
  selectSourceExcerpts,
  type QuestionModelPort,
  type QuestionSetGenerationRequest,
} from '@/lib/server/teaching-package/question-generation';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  pool: null as unknown,
  generate: vi.fn(),
  callLLM: vi.fn(),
  resolveModel: vi.fn(),
}));

// The default (production) port: `@/lib/ai/llm` captures the exact provider
// params; `resolveModel` resolves against the REAL registry (vision flags and
// output windows are real) without provider clients, recording its inputs.
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: vi.fn() }));
vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async (params: { modelString?: string; stage?: string }) => {
      mocks.resolveModel(params);
      const modelString = params.modelString ?? 'test:stage-model';
      const { providerId, modelId } = providers.parseModelString(modelString);
      return {
        model: { provider: providerId, modelId, modelString },
        modelInfo: providers.getModelInfo(providerId, modelId) ?? {},
        modelString,
        providerId,
        modelId,
        apiKey: 'k',
        thinkingConfig: undefined,
      };
    },
  };
});

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () =>
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: mocks.pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }),
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

const TENANT = 'tenant-q';
const FLOW_STAGES = [
  { key: 'lesson_introduction', scope: 'item' as const },
  { key: 'outcome_teaching_cards', scope: 'outcome' as const },
  { key: 'outcome_worked_examples', scope: 'outcome' as const },
];
const OBJECTIVES = [
  { objectiveRef: '48', snapshot: { statement: 'Compare two proper fractions.' } },
  { objectiveRef: '49', snapshot: { statement: 'Add fractions with like denominators.' } },
];
const RETAINED_FLOW = [
  { stage: 'lesson_introduction', instructions: 'intro' },
  { stage: 'outcome_teaching_cards', instructions: 'cards 48' },
  { stage: 'outcome_worked_examples', instructions: 'examples 48' },
  { stage: 'outcome_teaching_cards', instructions: 'cards 49' },
  { stage: 'outcome_worked_examples', instructions: 'examples 49' },
];
const SOURCE_TEXT = [
  'Fractions describe equal parts of a whole.',
  'To compare two proper fractions rewrite them with a common denominator, then compare numerators.',
  'Adding fractions with like denominators keeps the denominator and adds the numerators.',
].join('\n\n');

const ENVELOPE = {
  learning_outcome_id: 48,
  slots: [
    {
      teaching_role: 'check_understanding',
      supported: false,
      unsupported_reason: 'x',
      question: null,
    },
  ],
};

function scene(
  id: string,
  stageId: string,
  order: number,
  flowIndex: number,
  speech: string,
): AppScene {
  return {
    ...makeSlideScene(id, stageId, order, `Scene ${id}`),
    teachingStage: { key: RETAINED_FLOW[flowIndex].stage, flowIndex },
    actions: [{ id: `a-${id}`, type: 'speech', text: speech }],
  } as AppScene;
}

describe('teaching question generation from an approved package', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;
  const port: QuestionModelPort = { generate: (s, p) => mocks.generate(s, p) };

  async function seed(
    options: {
      status?: TeachingPackageStatus;
      withSource?: boolean;
      successor?: boolean;
      /** Kafuo R1 P4: the subject the producing attempt ran under (snapshot `subjectCode`). */
      subjectCode?: string;
    } = {},
  ) {
    const itemId = unique('li');
    const learningItem = { type: 'lesson' as const, id: itemId };
    const aggregate = { tenantId: TENANT, learningItem };
    const stageId = unique('stage');
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(stageId, 'Fractions', [
        scene(`${stageId}-intro`, stageId, 1, 0, 'Today we study fractions.'),
        scene(`${stageId}-c48`, stageId, 2, 1, 'Compare fractions using a common denominator.'),
        scene(
          `${stageId}-e48`,
          stageId,
          3,
          2,
          'Worked example: 2/3 versus 3/5 becomes 10/15 versus 9/15.',
        ),
        scene(`${stageId}-c49`, stageId, 4, 3, 'Add like fractions by adding numerators.'),
        scene(`${stageId}-e49`, stageId, 5, 4, 'Worked example: 1/5 plus 2/5 is 3/5.'),
      ]),
    );
    const attemptId = unique('tpa');
    const generatedVersionId = unique('tpv');
    let generatedStageId = stageId;
    if (options.successor) {
      // The superseded predecessor keeps its own Stage; the successor clone holds the new one.
      generatedStageId = unique('stage-old');
      await store.saveDocument(makeDocument(generatedStageId, 'Fractions v1', []));
    }
    await insertVersion(qp(), {
      id: generatedVersionId,
      aggregate,
      version: 1,
      status: options.successor ? 'superseded' : (options.status ?? 'approved'),
      currentStageId: generatedStageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate,
      versionId: generatedVersionId,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: OBJECTIVES,
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: RETAINED_FLOW,
        contentResource: {
          id: 'cs-575',
          mimeType: 'application/pdf',
          measuredSha256: 'a'.repeat(64),
        },
        ...(options.subjectCode
          ? {
              subjectCode: options.subjectCode,
              policyVersion: 'r1-2026-09',
              primaryModel: 'qwen:qwen3.7-flash',
              fallbackModel: 'openai:gpt-5-nano',
            }
          : {}),
      },
      now: 1,
    });
    if (options.withSource !== false) {
      await upsertSourceContext(qp(), {
        tenantId: TENANT,
        attemptId,
        contentResourceId: 'cs-575',
        measuredSha256: 'a'.repeat(64),
        text: SOURCE_TEXT,
      });
    }
    let versionId = generatedVersionId;
    if (options.successor) {
      versionId = unique('tpv-successor');
      await insertVersion(qp(), {
        id: versionId,
        aggregate,
        version: 2,
        status: 'approved',
        currentStageId: stageId,
        currentAttemptId: null,
        predecessorVersionId: generatedVersionId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 2,
      });
    }
    return { versionId, learningItem, stageId };
  }

  function request(
    seeded: { versionId: string; learningItem: { type: 'lesson'; id: string } },
    overrides: Partial<QuestionSetGenerationRequest> = {},
  ): QuestionSetGenerationRequest {
    return {
      versionId: seeded.versionId,
      tenantId: TENANT,
      learningItem: seeded.learningItem,
      requestId: 'b3-initial:item:3:None:tpv:48:b3-v1',
      objectiveRef: '48',
      flowStages: FLOW_STAGES,
      language: 'en',
      targetRole: null,
      findings: [],
      siblingMeasurements: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = new PGlite();
    pool = new PGlitePool(db);
    mocks.pool = pool;
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    await ensureTeachingModelAttemptsSchema(pool as never);
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue({ text: JSON.stringify(ENVELOPE), model: 'openai:test' });
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockReset();
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await pool.end();
  });

  describe('the default port on the subject route (Kafuo R1 P4, plan §7.2/§7.4)', () => {
    const USAGE = {
      inputTokens: 900,
      outputTokens: 120,
      inputTokenDetails: { cacheReadTokens: 0 },
    };
    const ok = (text: string) => ({ text, finishReason: 'stop', usage: USAGE, totalUsage: USAGE });
    const ledger = async () =>
      (
        await pool.query(
          `SELECT * FROM teaching_model_attempts ORDER BY started_at ASC, attempt_index ASC`,
        )
      ).rows as unknown as TeachingModelAttemptRow[];

    it('generates through the subject of the producing attempt’s snapshot: one question_generation row keyed by version/attempt/question set', async () => {
      const seeded = await seed({ subjectCode: 'MATH' });
      mocks.callLLM.mockResolvedValue(ok(JSON.stringify(ENVELOPE)));

      const result = await generateTeachingQuestionSet(qp(), request(seeded));
      expect(result.envelope).toEqual(ENVELOPE);
      expect(result.model).toBe('qwen:qwen3.7-flash');

      // The policy pair, resolved with NO stage — never the question-generation route.
      expect(mocks.resolveModel.mock.calls.map((c) => c[0])).toEqual([
        { modelString: 'qwen:qwen3.7-flash' },
        { modelString: 'openai:gpt-5-nano' },
      ]);
      expect(mocks.callLLM).toHaveBeenCalledTimes(1);
      const [params, source, retryOptions] = mocks.callLLM.mock.calls[0]!;
      expect(params).toMatchObject({
        model: { modelString: 'qwen:qwen3.7-flash' },
        system: expect.stringContaining(''),
        prompt: expect.stringContaining('Compare two proper fractions.'),
        maxRetries: 0,
      });
      expect(source).toBe('question-generation');
      // No same-model retries: the fallback is the retry (plan §7.3).
      expect(retryOptions).toBeUndefined();

      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: TENANT,
        capability: 'question_generation',
        stage: 'question-generation',
        subject_code: 'MATH',
        policy_version: 'r1-2026-09',
        origin: 'openmaic_runtime',
        role: 'primary',
        outcome: 'succeeded',
        accounting_status: 'complete',
        version_id: seeded.versionId,
        generation_run: null,
        question_set_ref: 'b3-initial:item:3:None:tpv:48:b3-v1',
        learning_item_type: 'lesson',
        learning_item_id: seeded.learningItem.id,
        turn_id: null,
        budget_estimate_tokens: null,
        budget_counter_kind: null,
      });
      expect(rows[0]!.generation_attempt_id).toMatch(/^tpa-/);
    });

    it('an unparsable or drifted primary output is unusable_output → the fallback serves the same call', async () => {
      const seeded = await seed({ subjectCode: 'MATH' });
      const drifted = { ...ENVELOPE, slots: [{ ...ENVELOPE.slots[0], confidence: 0.9 }] };
      mocks.callLLM
        .mockResolvedValueOnce(ok(JSON.stringify(drifted)))
        .mockResolvedValueOnce(ok(JSON.stringify(ENVELOPE)));

      const result = await generateTeachingQuestionSet(qp(), request(seeded));
      expect(result.envelope).toEqual(ENVELOPE);
      expect(result.model).toBe('openai:gpt-5-nano');
      expect(
        mocks.callLLM.mock.calls.map(
          (c) => (c[0] as { model: { modelString: string } }).model.modelString,
        ),
      ).toEqual(['qwen:qwen3.7-flash', 'openai:gpt-5-nano']);
      const rows = await ledger();
      expect(
        rows.map((row) => [row.role, row.outcome, row.fallback_triggered, row.fallback_reason]),
      ).toEqual([
        ['primary', 'unusable_output', true, 'unusable_output'],
        ['fallback', 'succeeded', false, null],
      ]);
      for (const row of rows)
        expect(row.question_set_ref).toBe('b3-initial:item:3:None:tpv:48:b3-v1');
    });

    it('both routes unusable → TEACHING_MODEL_UNAVAILABLE (503, retryable); nothing off-shape is handed to Kafuo', async () => {
      const seeded = await seed({ subjectCode: 'MATH' });
      mocks.callLLM.mockResolvedValue(ok('not json at all'));
      await expect(generateTeachingQuestionSet(qp(), request(seeded))).rejects.toMatchObject({
        code: 'TEACHING_MODEL_UNAVAILABLE',
        status: 503,
        details: expect.objectContaining({ subjectCode: 'MATH', retryable: true }),
      });
      expect(mocks.callLLM).toHaveBeenCalledTimes(2);
      expect((await ledger()).map((row) => row.outcome)).toEqual([
        'unusable_output',
        'unusable_output',
      ]);
    });

    it('refuses a version whose snapshot records no subject with SUBJECT_ROUTE_UNAVAILABLE, before any model call', async () => {
      const seeded = await seed();
      await expect(generateTeachingQuestionSet(qp(), request(seeded))).rejects.toMatchObject({
        code: 'SUBJECT_ROUTE_UNAVAILABLE',
        status: 422,
      });
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(mocks.resolveModel).not.toHaveBeenCalled();
      expect(await ledger()).toEqual([]);
    });

    it('an edit-only successor takes its subject from the predecessor’s generated attempt', async () => {
      const seeded = await seed({ successor: true, subjectCode: 'PHYSICS' });
      mocks.callLLM.mockResolvedValue(ok(JSON.stringify(ENVELOPE)));
      const result = await generateTeachingQuestionSet(qp(), request(seeded));
      expect(result.model).toBe('qwen:qwen3.7-flash');
      const rows = await ledger();
      expect(rows[0]).toMatchObject({ subject_code: 'PHYSICS', version_id: seeded.versionId });
    });

    it('TEACHING_SUBJECT_ROUTING=off keeps the stage-routed port: two same-model retries, no ledger', async () => {
      vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'off');
      const seeded = await seed();
      mocks.callLLM.mockResolvedValue({ text: JSON.stringify(ENVELOPE) });
      const result = await generateTeachingQuestionSet(qp(), request(seeded));
      expect(result.model).toBe('test:stage-model');
      expect(mocks.resolveModel).toHaveBeenCalledWith({ stage: 'question-generation' });
      const [params, source, retryOptions] = mocks.callLLM.mock.calls[0]!;
      expect(params).toMatchObject({ model: { modelString: 'test:stage-model' } });
      expect(source).toBe('question-generation');
      expect(retryOptions).toMatchObject({ retries: 2, validate: expect.any(Function) });
      expect(await ledger()).toEqual([]);
    });
  });

  it('generates from the approved version using retained objectives, scenes and source', async () => {
    const seeded = await seed();
    const result = await generateTeachingQuestionSet(qp(), request(seeded), port);

    expect(result.teachingPackageVersionId).toBe(seeded.versionId);
    expect(result.requestId).toBe('b3-initial:item:3:None:tpv:48:b3-v1');
    expect(result.envelope).toEqual(ENVELOPE);
    // Objective 48's scenes (flow indexes 1,2) plus the item intro (0); never objective 49's.
    const sceneIds = result.sections
      .filter((s) => s.kind === 'teaching_scene')
      .map((s) => s.sceneId);
    expect(sceneIds).toEqual([
      `${seeded.stageId}-intro`,
      `${seeded.stageId}-c48`,
      `${seeded.stageId}-e48`,
    ]);
    const anchors = result.sections.map((s) => s.anchor);
    expect(anchors).toContain('C1');
    expect(anchors.some((a) => a.startsWith('S'))).toBe(true);
    const [, prompt] = mocks.generate.mock.calls[0];
    expect(prompt).toContain('Compare two proper fractions.');
    expect(prompt).toContain('common denominator');
    expect(prompt).not.toContain('Add like fractions by adding numerators.');
    // The transient presigned URL is never fetched again.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['draft', 'in_review', 'rejected', 'discarded'] as const)(
    'refuses a %s version as the generation authority',
    async (status) => {
      const seeded = await seed({ status });
      await expect(generateTeachingQuestionSet(qp(), request(seeded), port)).rejects.toMatchObject({
        code: 'TEACHING_PACKAGE_NOT_APPROVED',
        status: 409,
      });
      expect(mocks.generate).not.toHaveBeenCalled();
    },
  );

  it('resolves a successor’s retained context through its predecessor attempt', async () => {
    const seeded = await seed({ successor: true });
    const result = await generateTeachingQuestionSet(qp(), request(seeded), port);
    expect(result.teachingPackageVersionId).toBe(seeded.versionId);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('refuses a version generated before source-context retention', async () => {
    const seeded = await seed({ withSource: false });
    await expect(generateTeachingQuestionSet(qp(), request(seeded), port)).rejects.toMatchObject({
      code: 'QUESTION_SOURCE_CONTEXT_UNAVAILABLE',
    });
  });

  it('refuses another tenant, another learning item, and an objective the package never taught', async () => {
    const seeded = await seed();
    await expect(
      generateTeachingQuestionSet(qp(), request(seeded, { tenantId: 'tenant-other' }), port),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      generateTeachingQuestionSet(
        qp(),
        request(seeded, { learningItem: { type: 'lesson', id: 'li-other' } }),
        port,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      generateTeachingQuestionSet(qp(), request(seeded, { objectiveRef: '999' }), port),
    ).rejects.toMatchObject({ code: 'OBJECTIVE_NOT_IN_PACKAGE' });
  });

  it('refuses flow stages that do not reproduce the retained flow', async () => {
    const seeded = await seed();
    await expect(
      generateTeachingQuestionSet(
        qp(),
        request(seeded, { flowStages: [{ key: 'outcome_teaching_cards', scope: 'outcome' }] }),
        port,
      ),
    ).rejects.toMatchObject({ code: 'TEACHING_MODEL_FLOW_MISMATCH' });
  });

  it('hands the model port an envelope check it can retry on', async () => {
    const seeded = await seed();
    let accept: ((text: string) => boolean) | undefined;
    const checking: QuestionModelPort = {
      generate: async (_system, _prompt, check) => {
        accept = check;
        return { text: JSON.stringify(ENVELOPE), model: 'm' };
      },
    };
    await generateTeachingQuestionSet(qp(), request(seeded), checking);

    expect(accept?.(JSON.stringify(ENVELOPE))).toBe(true);
    expect(accept?.('not json at all')).toBe(false);
    // Parseable JSON that Kafuo's strict envelope would refuse is not acceptable either.
    const drifted = { ...ENVELOPE, slots: [{ ...ENVELOPE.slots[0], confidence: 0.9 }] };
    expect(accept?.(JSON.stringify(drifted))).toBe(false);
  });

  it('refuses unparseable model output', async () => {
    const seeded = await seed();
    mocks.generate.mockResolvedValue({ text: 'not json at all', model: 'm' });
    await expect(generateTeachingQuestionSet(qp(), request(seeded), port)).rejects.toBeInstanceOf(
      TeachingPackageError,
    );
  });
});

describe('source context retention', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    pool = new PGlitePool(new PGlite());
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.end();
  });

  it('caps the retained text and records truncation, and stays tenant-scoped', async () => {
    vi.stubEnv('TEACHING_PACKAGE_SOURCE_CONTEXT_MAX_CHARS', '10');
    expect(sourceContextMaxChars()).toBe(10);
    const aggregate = {
      tenantId: 'tenant-a',
      learningItem: { type: 'lesson' as const, id: 'li-1' },
    };
    await insertAttempt(pool as never, {
      id: 'tpa-cap',
      aggregate,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem: aggregate.learningItem,
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
      now: 1,
    });
    await upsertSourceContext(pool as never, {
      tenantId: 'tenant-a',
      attemptId: 'tpa-cap',
      contentResourceId: 'cs-1',
      measuredSha256: 'b'.repeat(64),
      text: 'x'.repeat(25),
    });
    const row = await pool.query(
      `SELECT text, text_length, truncated FROM teaching_package_source_contexts WHERE attempt_id = 'tpa-cap'`,
    );
    expect(row.rows[0]).toMatchObject({ text: 'x'.repeat(10), text_length: 25, truncated: true });
    // No column can carry a URL or credential.
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'teaching_package_source_contexts'`,
    );
    const names = columns.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names.some((name) => /url|secret|token|signature/.test(name))).toBe(false);
    // A foreign tenant cannot read the retained context through the version walk.
    expect(
      await readRetainedVersionContext(pool as never, 'tpv-none', { tenantId: 'tenant-b' }),
    ).toBeNull();
  });
});

describe('the strict question envelope', () => {
  const QUESTION = {
    question_text: 'q',
    question_type: 'multiple_choice',
    choices: ['A', 'B', 'C', 'D'].map((choice_id) => ({ choice_id, text: choice_id })),
    correct_choice_id: 'A',
    explanation: 'e',
    difficulty: 'easy',
    concept_name: 'c',
    skill_tag: 's',
    cognitive_level: 'apply',
    measurement_structure: { signature: 'sig', description: 'd' },
    diagnostic_hypotheses: ['B', 'C', 'D'].map((choice_id) => ({
      choice_id,
      label: 'l',
      explanation: 'x',
    })),
    evidence_anchors: ['C1'],
    validation_notes: {
      has_exactly_one_correct_answer: true,
      answerable_from_approved_evidence: true,
      is_original_question: true,
    },
  };
  const envelopeWith = (question: Record<string, unknown>) => ({
    learning_outcome_id: 42,
    slots: [
      { teaching_role: 'mastery_check', supported: true, unsupported_reason: null, question },
    ],
  });

  it('accepts a conforming envelope, supported or not', () => {
    expect(envelopeViolations(envelopeWith(QUESTION))).toEqual([]);
    expect(envelopeViolations(ENVELOPE)).toEqual([]);
  });

  it('names every departure with the path Kafuo would report', () => {
    const violations = envelopeViolations(
      envelopeWith({
        ...QUESTION,
        cognitive_level: 'evaluate',
        hint: 'not declared',
        choices: QUESTION.choices.slice(0, 3),
      }),
    );
    expect(violations.map((v) => v.path).sort()).toEqual([
      '$.slots[0].question.choices',
      '$.slots[0].question.cognitive_level',
      '$.slots[0].question.hint',
    ]);
  });

  it('refuses a non-integer outcome echo', () => {
    expect(envelopeViolations({ ...ENVELOPE, learning_outcome_id: 'abc' })).toEqual([
      { path: '$.learning_outcome_id', code: 'invalid_type' },
    ]);
  });
});

describe('pure helpers', () => {
  it('expands a flow exactly like the Kafuo expansion', () => {
    expect(
      expandFlowStages(FLOW_STAGES, ['48', '49']).map((e) => `${e.stage}:${e.objectiveRef}`),
    ).toEqual([
      'lesson_introduction:null',
      'outcome_teaching_cards:48',
      'outcome_worked_examples:48',
      'outcome_teaching_cards:49',
      'outcome_worked_examples:49',
    ]);
  });

  it('renders learner-visible scene text and selects related, bounded source excerpts', () => {
    const rendered = renderSceneText({
      ...makeSlideScene('s', 'st', 1),
      actions: [{ id: 'a', type: 'speech', text: 'Say this.' }],
    } as AppScene);
    expect(rendered).toBe('Say this.');
    const excerpts = selectSourceExcerpts(SOURCE_TEXT, 'compare proper fractions denominator');
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.join(' ')).toContain('common denominator');
  });
});

describe('POST /api/teaching-packages/[id]/question-sets', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
    vi.stubEnv('DATABASE_URL', 'postgres://unused');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@/lib/server/teaching-package/question-generation');
    vi.doUnmock('@/lib/persistence/server-provider');
  });

  async function loadRoute(service: (...args: unknown[]) => unknown) {
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: {} }),
    }));
    vi.doMock('@/lib/server/teaching-package/question-generation', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      generateTeachingQuestionSet: service,
    }));
    return import('@/app/api/teaching-packages/[id]/question-sets/route');
  }

  const body = {
    tenantContext: { tenantId: 'tenant-q' },
    learningItem: { type: 'lesson', id: 'li-1' },
    requestId: 'req-1',
    objective: { objectiveRef: '48' },
    flowStages: FLOW_STAGES,
    policy: { envelopeVersion: 'tqs.v1.strict.20260817', language: 'en' },
  };

  function post(payload: unknown, auth = 'Bearer svc-key') {
    return new NextRequest('http://te.test/api/teaching-packages/tpv-1/question-sets', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('requires the service key', async () => {
    const { POST } = await loadRoute(vi.fn());
    const response = await POST(post(body, 'Bearer wrong'), {
      params: Promise.resolve({ id: 'tpv-1' }),
    });
    expect(response.status).toBe(401);
  });

  it('validates the body and passes identity + policy (never content) to the service', async () => {
    const service = vi.fn().mockResolvedValue({ requestId: 'req-1', envelope: {} });
    const { POST } = await loadRoute(service);
    const bad = await POST(post({ ...body, flowStages: [] }), {
      params: Promise.resolve({ id: 'tpv-1' }),
    });
    expect(bad.status).toBe(400);
    const ok = await POST(post(body), { params: Promise.resolve({ id: 'tpv-1' }) });
    expect(ok.status).toBe(200);
    const [, forwarded] = service.mock.calls[0];
    expect(forwarded).toMatchObject({
      versionId: 'tpv-1',
      tenantId: 'tenant-q',
      objectiveRef: '48',
      requestId: 'req-1',
      targetRole: null,
    });
  });

  it('maps a not-approved refusal to 409', async () => {
    const service = vi.fn();
    const { POST } = await loadRoute(service);
    // The route's module graph was reset; build the error from that same graph.
    const { TeachingPackageError: RouteError } =
      await import('@/lib/server/teaching-package/errors');
    service.mockRejectedValue(new RouteError('TEACHING_PACKAGE_NOT_APPROVED', 'no'));
    const response = await POST(post(body), { params: Promise.resolve({ id: 'tpv-1' }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEACHING_PACKAGE_NOT_APPROVED');
  });
});
