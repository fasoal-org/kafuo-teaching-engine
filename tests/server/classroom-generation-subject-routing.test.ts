/**
 * Kafuo R1 P4 — generation on the subject route (plan §7.2/§7.4, contracts
 * §0 L5, §1, §7).
 *
 * `generateClassroom` is driven for real with the generators mocked at the
 * `@openmaic/generation` seam (each mock calls the AICallFn it is handed, so
 * the routed call path — executor, ledger, fallback — is the code under
 * test), `@/lib/ai/llm` mocked to capture the exact provider params, the
 * registry resolved for real (vision flags matter), and the ledger a PGlite
 * database registered as the server persistence provider.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import type { TeachingModelAttemptRow } from '@/lib/persistence/teaching-model-attempts';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  reserveClassroom: vi.fn(),
  releaseClassroomReservation: vi.fn(),
  persistClassroom: vi.fn(),
  generateClassroomId: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  resolveClassroomWebSearchConfig: vi.fn(),
  searchWeb: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async (params: { modelString?: string; stage?: string }) => {
      mocks.resolveModel(params);
      const { getStageModel } = await import('@/lib/server/model-routes');
      const modelString =
        (params.stage ? getStageModel(params.stage) : undefined) ??
        params.modelString ??
        'test:base-model';
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

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
}));

vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-storage')>()),
  reserveClassroom: mocks.reserveClassroom,
  releaseClassroomReservation: mocks.releaseClassroomReservation,
  persistClassroom: mocks.persistClassroom,
  generateClassroomId: mocks.generateClassroomId,
}));

vi.mock('@/lib/server/classroom-media-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-media-generation')>()),
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
}));

vi.mock('@/lib/server/web-search-config', () => ({
  resolveClassroomWebSearchConfig: mocks.resolveClassroomWebSearchConfig,
}));
vi.mock('@/lib/web-search', () => ({
  searchWeb: mocks.searchWeb,
  formatSearchResultsAsContext: () => '',
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

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Fractions',
  description: 'Compare fractions',
  keyPoints: ['common denominator'],
  order: 1,
} as const;

const slideContent = { elements: [], remark: 'Compare fractions' };
const AGENTS_JSON = JSON.stringify({
  agents: [
    { name: 'Teacher', role: 'teacher', persona: 'Patient. Clear.' },
    { name: 'Learner', role: 'student', persona: 'Curious. Asks.' },
  ],
});
const USAGE = { inputTokens: 500, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 0 } };
const ok = (text: string) => ({ text, finishReason: 'stop', usage: USAGE, totalUsage: USAGE });

function apiError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.example',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

const ATTRIBUTION = {
  tenantId: 'tenant-r',
  generationAttemptId: 'tpa-routed-1',
  generationRun: 2,
  learningItemType: 'lesson',
  learningItemId: '901',
};

describe('generateClassroom on the subject route (Kafuo R1 P4)', () => {
  let pool: PGlitePool;

  async function policyFor(code: string) {
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const policy = await resolveSubjectModelPolicy(code);
    mocks.resolveModel.mockClear();
    return policy;
  }

  async function generate(input: Partial<GenerateClassroomInput> = {}) {
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    return generateClassroom({ requirement: 'Teach fractions', ...input }, { baseUrl: '' });
  }

  const callsBySource = () =>
    mocks.callLLM.mock.calls.map(([params, source]) => ({
      source: source as string,
      model: (params as { model: { modelString: string } }).model.modelString,
      maxRetries: (params as { maxRetries?: number }).maxRetries,
    }));

  async function ledgerRows(): Promise<TeachingModelAttemptRow[]> {
    const result = await pool.query<TeachingModelAttemptRow>(
      `SELECT * FROM teaching_model_attempts ORDER BY started_at ASC, attempt_index ASC`,
    );
    return result.rows;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://routing-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const mock of Object.values(mocks)) mock.mockReset();

    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockImplementation(async (_params, source: string) =>
      ok(source === 'agent-profiles' ? AGENTS_JSON : `generated for ${source}`),
    );
    mocks.generateSceneOutlinesFromRequirements.mockImplementation(
      async (_req, _pdf, images, aiCall) => {
        await aiCall('sys-outline', 'user-outline', images);
        return { success: true, data: { languageDirective: 'Use English.', outlines: [outline] } };
      },
    );
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall, options) => {
      await aiCall('sys-content', 'user-content', options?.resolvedVisionImages);
      return slideContent;
    });
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('sys-actions', 'user-actions');
      return [];
    });
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const created = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return created.success ? (created.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, stage, scenes }) => ({
      id,
      url: `/classroom/${id}`,
      stage,
      scenes,
      createdAt: '2026-09-22T00:00:00.000Z',
    }));
    mocks.reserveClassroom.mockResolvedValue(undefined);
    mocks.releaseClassroomReservation.mockResolvedValue(undefined);
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.replaceMediaPlaceholders.mockImplementation(() => undefined);
    mocks.generateTTSForClassroom.mockResolvedValue(undefined);
    mocks.generateClassroomId.mockReturnValue('stage-routed-1');
    mocks.resolveClassroomWebSearchConfig.mockReturnValue(undefined);
    mocks.searchWeb.mockResolvedValue({ sources: [] });

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

  it('runs every teaching stage through the executor on the subject primary, ignoring MODEL_ROUTES, with one ledger row per call keyed by attempt/run/stage', async () => {
    // Routes for every teaching stage — none may win over the policy.
    vi.stubEnv(
      'MODEL_ROUTES',
      JSON.stringify({
        'generate-classroom': 'openai:gpt-6-luna',
        'scene-outlines-stream': 'openai:gpt-6-luna',
        'scene-content': 'openai:gpt-6-luna',
        'scene-content:slide': 'openai:gpt-6-luna',
        'scene-actions': 'openai:gpt-6-luna',
        'agent-profiles': 'openai:gpt-6-luna',
      }),
    );
    const policy = await policyFor('MATH'); // Luna primary → Qwen fallback

    const result = await generate({
      modelPolicy: policy,
      attribution: ATTRIBUTION,
      agentMode: 'generate',
    });
    expect(result.scenesCount).toBe(1);

    const calls = callsBySource();
    expect(calls.map((c) => c.source)).toEqual([
      'scene-outlines-stream',
      'agent-profiles',
      'scene-content:slide',
      'scene-actions',
    ]);
    for (const call of calls) {
      expect(call.model).toBe('openai:gpt-5.6-luna');
      expect(call.maxRetries).toBe(0);
    }
    // The base model is still resolved for utilities, but no teaching stage
    // route was ever consulted through resolveModel.
    const stagesResolved = mocks.resolveModel.mock.calls.map(
      (c) => (c[0] as { stage?: string }).stage,
    );
    expect(stagesResolved).toEqual(['generate-classroom']);

    const rows = await ledgerRows();
    expect(rows.map((row) => row.stage)).toEqual([
      'scene-outlines-stream',
      'agent-profiles',
      'scene-content:slide',
      'scene-actions',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        tenant_id: 'tenant-r',
        capability: 'package_generation',
        subject_code: 'MATH',
        policy_version: 'r1-2026-09',
        origin: 'openmaic_runtime',
        role: 'primary',
        model_string: 'openai:gpt-5.6-luna',
        accounting_status: 'complete',
        outcome: 'succeeded',
        generation_attempt_id: 'tpa-routed-1',
        generation_run: 2,
        version_id: null,
        learning_item_type: 'lesson',
        learning_item_id: '901',
        turn_id: null,
        // Generation is never budget-asserted (contracts §0 H1).
        budget_estimate_tokens: null,
        budget_counter_kind: null,
        budget_effective_cap: null,
        budget_breach: null,
      });
    }
  });

  it('keeps web-search-query-rewrite on its stage route, off the ledger (contracts §0 L5)', async () => {
    vi.stubEnv(
      'MODEL_ROUTES',
      JSON.stringify({ 'web-search-query-rewrite': 'openai:gpt-5.6-luna' }),
    );
    mocks.resolveClassroomWebSearchConfig.mockReturnValue({ providerId: 'tavily', apiKey: 'k' });
    mocks.callLLM.mockImplementation(async (_params, source: string) =>
      ok(
        source === 'web-search-query-rewrite' ? '{"query":"fractions"}' : `generated for ${source}`,
      ),
    );
    const policy = await policyFor('MATH');

    await generate({
      modelPolicy: policy,
      attribution: ATTRIBUTION,
      enableWebSearch: true,
      // A PDF excerpt makes the rewrite attempt unconditional.
      pdfContent: { text: 'Fractions describe parts of a whole.', images: [] },
    });

    const rewrite = callsBySource().find((c) => c.source === 'web-search-query-rewrite');
    expect(rewrite).toMatchObject({ model: 'openai:gpt-5.6-luna' });
    expect(mocks.resolveModel.mock.calls.map((c) => (c[0] as { stage?: string }).stage)).toContain(
      'web-search-query-rewrite',
    );
    const rows = await ledgerRows();
    expect(rows.map((row) => row.stage)).not.toContain('web-search-query-rewrite');
    expect(rows.map((row) => row.stage)).toEqual([
      'scene-outlines-stream',
      'scene-content:slide',
      'scene-actions',
    ]);
  });

  it('vision-bearing calls are planned onto the vision-capable fallback with fallback_reason=primary_lacks_vision', async () => {
    // No approved R1 route pairs a visionless primary with a vision-capable
    // fallback anymore, so the AMB-08 planning is exercised by overriding the
    // resolved targets' vision flags: primary Luna (no vision) → fallback Qwen
    // (vision). The executor only ever reads these flags from modelInfo.
    const resolved = await policyFor('MATH');
    const withoutVision = (t: typeof resolved.primary) => ({
      ...t,
      modelInfo: {
        ...t.modelInfo,
        capabilities: { ...t.modelInfo.capabilities, vision: false },
      },
    });
    const withVision = (t: typeof resolved.primary) => ({
      ...t,
      modelInfo: {
        ...t.modelInfo,
        capabilities: { ...t.modelInfo.capabilities, vision: true },
      },
    });
    const policy = {
      ...resolved,
      primary: withoutVision(resolved.primary),
      fallback: withVision(resolved.fallback),
    };
    const pdfImages = [{ id: 'src-1', src: 'data:image/png;base64,AAAA', pageNumber: 1 }];
    mocks.generateSceneOutlinesFromRequirements.mockImplementation(
      async (_req, _pdf, images, aiCall) => {
        await aiCall('sys-outline', 'user-outline', images);
        return {
          success: true,
          data: {
            languageDirective: 'Use English.',
            outlines: [{ ...outline, suggestedImageIds: ['src-1'] }],
          },
        };
      },
    );

    await generate({
      modelPolicy: policy,
      attribution: ATTRIBUTION,
      pdfContent: { text: 'lesson', images: [pdfImages[0]!.src], pdfImages },
      sourceVisuals: undefined,
    } as never);

    const calls = callsBySource();
    expect(calls.find((c) => c.source === 'scene-outlines-stream')).toMatchObject({
      model: 'qwen:qwen3.7-flash',
    });
    expect(calls.find((c) => c.source === 'scene-content:slide')).toMatchObject({
      model: 'qwen:qwen3.7-flash',
    });
    // Text-only calls stay on the primary.
    expect(calls.find((c) => c.source === 'scene-actions')).toMatchObject({
      model: 'openai:gpt-5.6-luna',
    });

    const rows = await ledgerRows();
    const outlineRow = rows.find((row) => row.stage === 'scene-outlines-stream')!;
    expect(outlineRow).toMatchObject({
      role: 'fallback',
      attempt_index: 1,
      fallback_reason: 'primary_lacks_vision',
      outcome: 'succeeded',
    });
    // The outline call carried the image parts the unrouted path builds.
    const outlineParams = mocks.callLLM.mock.calls.find(
      (c) => c[1] === 'scene-outlines-stream',
    )![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userContent = outlineParams.messages[1]!.content as Array<{ type: string }>;
    expect(userContent.some((part) => part.type === 'image')).toBe(true);
  });

  it('a primary failure falls back inside ONE call; both routes failing fails the run without a per-call re-roll', async () => {
    const policy = await policyFor('MATH');
    mocks.callLLM.mockImplementation(async (_params, source: string) => {
      if (source === 'scene-content:slide') throw apiError(503);
      if (source === 'scene-outlines-stream' && mocks.callLLM.mock.calls.length === 1) {
        throw apiError(429);
      }
      return ok(`generated for ${source}`);
    });

    const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
    await expect(
      generate({ modelPolicy: policy, attribution: ATTRIBUTION }),
    ).rejects.toBeInstanceOf(TeachingModelUnavailableError);

    const calls = callsBySource();
    // Outline: primary 429 → fallback served (two provider calls, one AICallFn call).
    expect(calls.filter((c) => c.source === 'scene-outlines-stream').map((c) => c.model)).toEqual([
      'openai:gpt-5.6-luna',
      'qwen:qwen3.7-flash',
    ]);
    // Content: primary AND fallback failed → exactly two provider calls, then
    // the run fails. The scene-content retry helper did not re-roll the call.
    expect(calls.filter((c) => c.source === 'scene-content:slide')).toHaveLength(2);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneActions).not.toHaveBeenCalled();
    // The reservation is released like any other failed run.
    expect(mocks.releaseClassroomReservation).toHaveBeenCalledWith('stage-routed-1');

    const rows = await ledgerRows();
    expect(rows.map((row) => [row.stage, row.role, row.outcome, row.fallback_triggered])).toEqual([
      ['scene-outlines-stream', 'primary', 'rate_limited', true],
      ['scene-outlines-stream', 'fallback', 'succeeded', false],
      ['scene-content:slide', 'primary', 'provider_error', true],
      ['scene-content:slide', 'fallback', 'provider_error', false],
    ]);
  });

  it('a policy without attribution is refused before any call', async () => {
    const policy = await policyFor('MATH');
    await expect(generate({ modelPolicy: policy })).rejects.toThrow(/attribution/);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('without a policy the unrouted path is byte-identical: stage routes apply and no ledger row is written', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content:slide': 'openai:gpt-5.6-luna' }));
    await generate();
    const calls = callsBySource();
    expect(calls.map((c) => c.source)).toEqual([
      'generate-classroom',
      'generate-classroom-scene',
      'generate-classroom-scene',
    ]);
    expect(calls[1]).toMatchObject({ model: 'openai:gpt-5.6-luna' });
    expect(calls[0]).toMatchObject({ model: 'test:base-model' });
    expect(await ledgerRows()).toEqual([]);
  });

  describe('Stage.subjectCode stamping (SATTS W1-4)', () => {
    const persistedStage = () =>
      (mocks.persistClassroom.mock.calls.at(-1)?.[0] as { stage: Record<string, unknown> })
        .stage;

    it('stamps a known Kafuo subject code on the Stage beside the language', async () => {
      await generate({ subjectCode: 'MATH', language: 'ar-SA' });
      expect(persistedStage()).toMatchObject({
        subjectCode: 'MATH',
        language: 'ar-SA',
        textDirection: 'rtl',
      });
      expect(persistedStage()).not.toHaveProperty('speechReadingMode');
    });

    it.each([
      ['null', null],
      ['empty', ''],
      ['lower-case', 'math'],
      ['unknown', 'GEOLOGY'],
      ['absent', undefined],
    ])('stamps no subject for a %s code', async (_label, subjectCode) => {
      await generate(subjectCode === undefined ? {} : { subjectCode });
      expect(persistedStage()).not.toHaveProperty('subjectCode');
    });
  });
});
