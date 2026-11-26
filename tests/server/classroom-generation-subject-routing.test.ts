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
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api, id) => {
      const created = api.scene.create({
        ...(id !== undefined ? { id } : {}),
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
        // A model other than the policy's own, so a win by the route would show.
        'generate-classroom': 'openai:gpt-5.6-terra',
        'scene-outlines-stream': 'openai:gpt-5.6-terra',
        'scene-content': 'openai:gpt-5.6-terra',
        'scene-content:slide': 'openai:gpt-5.6-terra',
        'scene-actions': 'openai:gpt-5.6-terra',
        'agent-profiles': 'openai:gpt-5.6-terra',
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
      expect(call.model).toBe('openai:gpt-6-luna');
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
        model_string: 'openai:gpt-6-luna',
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
    // S5.5 / S8-O1: the Scene's content and narration rows name the Scene that was
    // persisted (its id minted before the first call); lesson-level rows name none.
    const persistedScenes = mocks.persistClassroom.mock.calls[0]![0].scenes as Array<{
      id: string;
    }>;
    expect(persistedScenes).toHaveLength(1);
    const sceneId = persistedScenes[0]!.id;
    expect(sceneId).toMatch(/^scene_/);
    expect(mocks.createSceneWithActions.mock.calls[0]![4]).toBe(sceneId);
    expect(rows.map((row) => [row.stage, row.scene_id])).toEqual([
      ['scene-outlines-stream', null],
      ['agent-profiles', null],
      ['scene-content:slide', sceneId],
      ['scene-actions', sceneId],
    ]);
  });

  it('S8-O1: concurrently prefetched Scenes each record their own Scene id', async () => {
    const outlines = [1, 2, 3].map((n) => ({
      ...outline,
      id: `outline-${n}`,
      title: `Fractions ${n}`,
      order: n,
    }));
    mocks.generateSceneOutlinesFromRequirements.mockImplementation(
      async (_req, _pdf, images, aiCall) => {
        await aiCall('sys-outline', 'user-outline', images);
        return { success: true, data: { languageDirective: 'Use English.', outlines } };
      },
    );
    // Later Scenes answer first, so their content calls interleave with earlier ones.
    mocks.generateSceneContent.mockImplementation(async (sceneOutline, aiCall, options) => {
      const delay = 30 - Number(String(sceneOutline.order)) * 10;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await aiCall(`sys-content-${sceneOutline.id}`, 'user-content', options?.resolvedVisionImages);
      return slideContent;
    });
    const policy = await policyFor('MATH');
    await generate({ modelPolicy: policy, attribution: ATTRIBUTION, agentMode: 'generate' });

    const persisted = mocks.persistClassroom.mock.calls[0]![0].scenes as Array<{
      id: string;
      outlineId?: string;
    }>;
    expect(persisted).toHaveLength(3);
    const contentRows = (await ledgerRows()).filter((row) => row.stage === 'scene-content:slide');
    expect(contentRows).toHaveLength(3);
    // Each content call's system prompt names its outline; its row names that outline's Scene.
    const sceneOfOutline = new Map(
      mocks.createSceneWithActions.mock.calls.map((call) => [call[0].id as string, call[4]]),
    );
    const contentCalls = mocks.callLLM.mock.calls.filter(
      ([, source]) => source === 'scene-content:slide',
    );
    const sceneByCallOrder = contentCalls.map(([params]) => {
      const system = (params as { messages: Array<{ role: string; content: string }> }).messages[0]!
        .content;
      return sceneOfOutline.get(system.replace('sys-content-', ''));
    });
    expect(new Set(contentRows.map((row) => row.scene_id))).toEqual(
      new Set(persisted.map((scene) => scene.id)),
    );
    expect(contentRows.map((row) => row.scene_id)).toEqual(sceneByCallOrder);
  });

  it('runs the planner, the book repair and the refinement on the planning route, and every scene stage on the generation route (§3c)', async () => {
    // package-planner-issue-resolve-plan-2026-11-22 §3c (owner, 22 Nov 2026).
    const generation = await policyFor('MATH'); // Luna primary → Qwen fallback
    const { resolveConfiguredGenerationPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const planPolicy = await resolveConfiguredGenerationPolicy(
      'MATH',
      {
        primary: { model: 'anthropic:claude-opus-5-5', thinking: 'high' },
        fallback: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
        settingKey: 'teaching_generation.plan_route.MATH',
      },
      'planRoute',
    );
    const repairCalls: string[] = [];
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    const result = await generateClassroom(
      {
        requirement: 'Teach fractions',
        modelPolicy: generation,
        planPolicy,
        attribution: ATTRIBUTION,
        agentMode: 'generate',
      },
      {
        baseUrl: '',
        correction: {
          // One open issue, so the run reaches the book repair before any pause.
          collectOutlineIssues: async () => [
            { code: 'BOOK_COVERAGE_INCOMPLETE', severity: 'error', message: 'gap' } as never,
          ],
          repairOutlines: async (outlines, _blocking, aiCall) => {
            repairCalls.push(await aiCall('sys-repair', 'user-repair'));
            return { outlines, blocking: [] };
          },
          refineOutlines: async (_outlines, aiCall) => {
            repairCalls.push(await aiCall('sys-refine', 'user-refine'));
            return null;
          },
        },
      },
    );
    expect(result.scenesCount).toBe(1);
    expect(repairCalls).toHaveLength(2);

    const calls = callsBySource();
    expect(calls.map((c) => [c.source, c.model])).toEqual([
      ['scene-outlines-stream', 'anthropic:claude-opus-5-5'],
      ['scene-outlines-stream', 'anthropic:claude-opus-5-5'],
      ['scene-outlines-stream', 'anthropic:claude-opus-5-5'],
      ['agent-profiles', 'openai:gpt-6-luna'],
      ['scene-content:slide', 'openai:gpt-6-luna'],
      ['scene-actions', 'openai:gpt-6-luna'],
    ]);

    // Each planning call is metered on its own row, under the planning route.
    const rows = await ledgerRows();
    expect(rows.map((row) => [row.stage, row.model_string, row.policy_version])).toEqual([
      ['scene-outlines-stream', 'anthropic:claude-opus-5-5', 'configured-2026-11'],
      ['scene-outlines-stream', 'anthropic:claude-opus-5-5', 'configured-2026-11'],
      ['scene-outlines-stream', 'anthropic:claude-opus-5-5', 'configured-2026-11'],
      ['agent-profiles', 'openai:gpt-6-luna', 'r1-2026-09'],
      ['scene-content:slide', 'openai:gpt-6-luna', 'r1-2026-09'],
      ['scene-actions', 'openai:gpt-6-luna', 'r1-2026-09'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ subject_code: 'MATH', generation_attempt_id: 'tpa-routed-1' });
    }
  });

  describe('the correction order before any pause (P1, plan §3b)', () => {
    type AICallFnLike = (system: string, user: string) => Promise<string>;
    const issue = (code: string) =>
      ({ code, disposition: 'admin_correctable', message: code }) as never;

    async function runWithCorrection(
      correction: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) {
      const policy = await policyFor('MATH');
      const { generateClassroom } = await import('@/lib/server/classroom-generation');
      return generateClassroom(
        {
          requirement: 'Teach fractions',
          modelPolicy: policy,
          attribution: ATTRIBUTION,
          ...extra,
        } as never,
        { baseUrl: '', correction: correction as never },
      );
    }
    // A governed run plans once (`maxOutlineGateAttempts = 1`): the case the
    // NO_OUTLINES re-plan is for.
    const singleShot = {
      governed: {
        contract: 'kafuo.teaching-skills.v1',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        flow: [{ stage: 'lesson_introduction', instructions: 'Open the lesson.' }],
      },
    };

    it('runs the free rule fixes first, then the book repair on what they left, and does not pause when nothing is left', async () => {
      const order: string[] = [];
      const fixedOutlines = [{ ...outline, title: 'moved into place' }];
      const autoFixOutlines = vi.fn(async (outlines: unknown[], blocking: unknown[]) => {
        order.push('autoFix');
        expect(outlines).toHaveLength(1);
        expect(blocking).toHaveLength(2);
        return { outlines: fixedOutlines, blocking: [issue('BOOK_COVERAGE_INCOMPLETE')] };
      });
      const repairOutlines = vi.fn(async (outlines: unknown[], blocking: unknown[]) => {
        order.push('bookRepair');
        // The book repair sees the fixed plan and only what the fixes left open.
        expect(outlines).toBe(fixedOutlines);
        expect(blocking).toEqual([issue('BOOK_COVERAGE_INCOMPLETE')]);
        return { outlines: outlines as never, blocking: [] };
      });

      const result = await runWithCorrection({
        collectOutlineIssues: async () => [
          issue('FLOW_SEQUENCE_INVALID'),
          issue('BOOK_COVERAGE_INCOMPLETE'),
        ],
        autoFixOutlines,
        repairOutlines,
      });

      expect(order).toEqual(['autoFix', 'bookRepair']);
      expect(result.scenesCount).toBe(1);
    });

    it('P2: the plan review runs after the book repair on what is left, with the outline (planning) call, and nothing pauses when it clears it', async () => {
      const order: string[] = [];
      const reviewed = [{ ...outline, title: 'reviewed' }];
      const result = await runWithCorrection({
        collectOutlineIssues: async () => [issue('TEACHING_SKILL_NOT_ALLOWED')],
        autoFixOutlines: async () => {
          order.push('autoFix');
          return null;
        },
        repairOutlines: async () => {
          order.push('bookRepair');
          return null;
        },
        reviewPlan: async (_outlines: unknown[], blocking: unknown[], aiCall: AICallFnLike) => {
          order.push('review');
          expect(blocking).toEqual([issue('TEACHING_SKILL_NOT_ALLOWED')]);
          await aiCall('sys-review', 'user-review');
          return { outlines: reviewed, blocking: [] };
        },
      });
      expect(order).toEqual(['autoFix', 'bookRepair', 'review']);
      expect(result.scenesCount).toBe(1);
      // The review's call is an outline-stage (planning route) call.
      expect(callsBySource().map((call) => call.source)).toEqual([
        'scene-outlines-stream',
        'scene-outlines-stream',
        'scene-content:slide',
        'scene-actions',
      ]);
    });

    it('P2: when the review clears a stage or order issue, the book repair runs once more on the gaps it could not place', async () => {
      const order: string[] = [];
      const result = await runWithCorrection({
        collectOutlineIssues: async () => [
          issue('TEACHING_STAGE_MISMATCH'),
          issue('BOOK_COVERAGE_INCOMPLETE'),
        ],
        repairOutlines: async (outlines: unknown[], blocking: Array<{ code: string }>) => {
          order.push(`bookRepair:${blocking.map((entry) => entry.code).join('+')}`);
          // Off while the stage issue is open; plans the gap once it is gone.
          return blocking.some((entry) => entry.code === 'TEACHING_STAGE_MISMATCH')
            ? null
            : { outlines: outlines as never, blocking: [] };
        },
        reviewPlan: async (outlines: unknown[]) => {
          order.push('review');
          return { outlines: outlines as never, blocking: [issue('BOOK_COVERAGE_INCOMPLETE')] };
        },
      });
      expect(order).toEqual([
        'bookRepair:TEACHING_STAGE_MISMATCH+BOOK_COVERAGE_INCOMPLETE',
        'review',
        'bookRepair:BOOK_COVERAGE_INCOMPLETE',
      ]);
      expect(result.scenesCount).toBe(1);
    });

    it('P2: a planning route that fails during the review fails the run (re-rolled), never a pause', async () => {
      mocks.callLLM.mockImplementation(
        async (params: { messages: Array<{ content: unknown }> }, source: string) => {
          if (source === 'scene-outlines-stream' && params.messages[0]?.content === 'sys-review') {
            throw apiError(503);
          }
          return ok(source === 'agent-profiles' ? AGENTS_JSON : `generated for ${source}`);
        },
      );
      const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
      const reserveCalls = mocks.reserveClassroom.mock.calls.length;
      await expect(
        runWithCorrection({
          collectOutlineIssues: async () => [issue('TEACHING_SKILL_NOT_ALLOWED')],
          // Like reviewPlan: the failed call is swallowed and nothing is kept.
          reviewPlan: async (_outlines: unknown[], _blocking: unknown[], aiCall: AICallFnLike) => {
            await aiCall('sys-review', 'user-review').catch(() => undefined);
            return null;
          },
        }),
      ).rejects.toBeInstanceOf(TeachingModelUnavailableError);
      // Before any Stage reservation.
      expect(mocks.reserveClassroom.mock.calls.length).toBe(reserveCalls);
    });

    it('P2: a review that keeps nothing leaves the issues to pause with', async () => {
      const { isGenerationCorrectionRequired } =
        await import('@/lib/server/teaching-package/outline-correction');
      const error = await runWithCorrection({
        collectOutlineIssues: async () => [issue('TEACHING_SKILL_NOT_ALLOWED')],
        reviewPlan: async () => null,
      }).catch((caught: unknown) => caught);
      expect(isGenerationCorrectionRequired(error)).toBe(true);
    });

    it('when the free fixes leave nothing open, the book repair is not called and nothing pauses', async () => {
      const repairOutlines = vi.fn();
      const result = await runWithCorrection({
        collectOutlineIssues: async () => [issue('TEACHING_STAGE_MISMATCH')],
        autoFixOutlines: async (outlines: unknown[]) => ({ outlines, blocking: [] }),
        repairOutlines,
      });
      expect(repairOutlines).not.toHaveBeenCalled();
      expect(result.scenesCount).toBe(1);
    });

    it('what is left after both pauses the run, with the fixed plan', async () => {
      const { isGenerationCorrectionRequired } =
        await import('@/lib/server/teaching-package/outline-correction');
      const fixedOutlines = [{ ...outline, title: 'stage fixed' }];
      const error = await runWithCorrection({
        collectOutlineIssues: async () => [
          issue('TEACHING_STAGE_MISMATCH'),
          issue('TEACHING_SKILL_NOT_ALLOWED'),
        ],
        autoFixOutlines: async () => ({
          outlines: fixedOutlines,
          blocking: [issue('TEACHING_SKILL_NOT_ALLOWED')],
        }),
        repairOutlines: async () => null,
      }).catch((caught: unknown) => caught);
      expect(isGenerationCorrectionRequired(error)).toBe(true);
      const candidate = (error as { candidate: { outlines: unknown[]; diagnostics: unknown[] } })
        .candidate;
      expect(candidate.outlines).toEqual([expect.objectContaining({ title: 'stage fixed' })]);
      expect(candidate.diagnostics).toEqual([issue('TEACHING_SKILL_NOT_ALLOWED')]);
    });

    // The outline generator's real answer to an empty plan for an authoritative
    // flow (outline-generator.ts): a failure, not a NO_OUTLINES diagnostic.
    const EMPTY_PLAN = {
      success: false,
      error:
        'OUTLINE_TEACHING_FLOW_INVALID: no outlines were returned for a 1-position Teaching Model Flow',
    };

    it('a plan with no slides is re-planned once on the same outline call, and the run goes on', async () => {
      let outlineCalls = 0;
      mocks.generateSceneOutlinesFromRequirements.mockImplementation(
        async (_req, _pdf, images, aiCall) => {
          outlineCalls += 1;
          await aiCall('sys-outline', 'user-outline', images);
          return outlineCalls === 1
            ? EMPTY_PLAN
            : {
                success: true,
                data: {
                  languageDirective: 'Use English.',
                  outlines: [
                    {
                      ...outline,
                      teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
                      teachingSkills: { classification: 'non-instructional' as const },
                    },
                  ],
                },
              };
        },
      );
      const result = await runWithCorrection(
        { collectOutlineIssues: async () => [] },
        { ...singleShot, teachingFlow: singleShot.governed.flow },
      );
      expect(outlineCalls).toBe(2);
      expect(
        callsBySource().filter((call) => call.source === 'scene-outlines-stream'),
      ).toHaveLength(2);
      // The re-planned slide went on to its scene, with no pause.
      expect(result.scenesCount).toBe(1);
    });

    it('a second empty plan fails the run as before: no third outline call', async () => {
      let outlineCalls = 0;
      mocks.generateSceneOutlinesFromRequirements.mockImplementation(
        async (_req, _pdf, images, aiCall) => {
          outlineCalls += 1;
          await aiCall('sys-outline', 'user-outline', images);
          return EMPTY_PLAN;
        },
      );
      await expect(
        runWithCorrection({ collectOutlineIssues: async () => [] }, singleShot),
      ).rejects.toThrow(/no outlines were returned/);
      expect(outlineCalls).toBe(2);
    });

    it('a run without correction support keeps today’s single outline call', async () => {
      let outlineCalls = 0;
      mocks.generateSceneOutlinesFromRequirements.mockImplementation(
        async (_req, _pdf, images, aiCall) => {
          outlineCalls += 1;
          await aiCall('sys-outline', 'user-outline', images);
          return EMPTY_PLAN;
        },
      );
      const policy = await policyFor('MATH');
      await expect(
        generate({ modelPolicy: policy, attribution: ATTRIBUTION, ...singleShot } as never),
      ).rejects.toThrow(/no outlines were returned/);
      expect(outlineCalls).toBe(1);
    });
  });

  it('without a planning policy, planning stays on the generation policy (D-5 default)', async () => {
    const policy = await policyFor('MATH');
    await generate({ modelPolicy: policy, attribution: ATTRIBUTION, agentMode: 'generate' });
    const calls = callsBySource();
    expect(calls.find((c) => c.source === 'scene-outlines-stream')).toMatchObject({
      model: 'openai:gpt-6-luna',
    });
  });

  it('keeps web-search-query-rewrite on its stage route, off the ledger (contracts §0 L5)', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'web-search-query-rewrite': 'openai:gpt-6-luna' }));
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
    expect(rewrite).toMatchObject({ model: 'openai:gpt-6-luna' });
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
      model: 'openai:gpt-6-luna',
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
      'openai:gpt-6-luna',
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

  // 3 Oct 2026: a NON-retryable refusal for ONE governed slide is that slide's
  // problem — it keeps a marked placeholder and the run continues; refusing
  // every slide is the route's problem and still fails the run.
  describe('governed scene-scoped refusals', () => {
    const flow = [
      { stage: 'lesson_introduction', instructions: 'Open the lesson.' },
      { stage: 'outcome_teaching_cards', instructions: 'Teach the outcome.' },
    ];
    const governedOutlines = [
      {
        ...outline,
        id: 'g1',
        order: 1,
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
        teachingSkills: { classification: 'non-instructional' as const },
      },
      {
        ...outline,
        id: 'g2',
        order: 2,
        title: 'Refused slide',
        teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
        teachingSkills: { classification: 'non-instructional' as const },
      },
    ];
    const governed = {
      contract: 'kafuo.teaching-skills.v1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      flow,
    };
    function refuseContentAfter(okCalls: number) {
      let contentCalls = 0;
      mocks.generateSceneOutlinesFromRequirements.mockImplementation(
        async (_req, _pdf, images, aiCall) => {
          await aiCall('sys-outline', 'user-outline', images);
          return {
            success: true,
            data: { languageDirective: 'Use English.', outlines: governedOutlines },
          };
        },
      );
      mocks.callLLM.mockImplementation(async (_params, source: string) => {
        if (source === 'scene-content:slide') {
          contentCalls += 1;
          if (contentCalls > okCalls) throw apiError(400);
        }
        return ok(source === 'agent-profiles' ? AGENTS_JSON : `generated for ${source}`);
      });
    }

    it('keeps the refused slide as a marked placeholder and completes the run', async () => {
      const policy = await policyFor('MATH');
      refuseContentAfter(1);
      const result = await generate({
        modelPolicy: policy,
        attribution: ATTRIBUTION,
        teachingFlow: flow,
        governed,
      } as never);
      expect(result.scenes).toHaveLength(2);
      expect(result.scenes[0]!.generationIssues).toBeUndefined();
      expect(result.scenes[1]!.generationIssues?.map((issue) => issue.code)).toEqual([
        'TEACHING_MODEL_REFUSED',
      ]);
    });

    it('fails the run when every slide is refused', async () => {
      const policy = await policyFor('MATH');
      refuseContentAfter(0);
      const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
      await expect(
        generate({
          modelPolicy: policy,
          attribution: ATTRIBUTION,
          teachingFlow: flow,
          governed,
        } as never),
      ).rejects.toBeInstanceOf(TeachingModelUnavailableError);
    });
  });

  it('a policy without attribution is refused before any call', async () => {
    const policy = await policyFor('MATH');
    await expect(generate({ modelPolicy: policy })).rejects.toThrow(/attribution/);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('without a policy the unrouted path is byte-identical: stage routes apply and no ledger row is written', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'scene-content:slide': 'openai:gpt-6-luna' }));
    await generate();
    const calls = callsBySource();
    expect(calls.map((c) => c.source)).toEqual([
      'generate-classroom',
      'generate-classroom-scene',
      'generate-classroom-scene',
    ]);
    expect(calls[1]).toMatchObject({ model: 'openai:gpt-6-luna' });
    expect(calls[0]).toMatchObject({ model: 'test:base-model' });
    expect(await ledgerRows()).toEqual([]);
  });

  describe('Stage.subjectCode stamping (SATTS W1-4)', () => {
    const persistedStage = () =>
      (mocks.persistClassroom.mock.calls.at(-1)?.[0] as { stage: Record<string, unknown> }).stage;

    it('stamps a known Kafuo subject code on the Stage beside the language', async () => {
      // An Arabic MATH run validates its narration (register + signposting):
      // a scene must have at least one speech segment, so the stub returns one.
      mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
        await aiCall('sys-actions', 'user-actions');
        return [{ id: 'speech-1', type: 'speech', text: 'طيب، خلونا نبدأ.' }];
      });
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

    it('freezes a configured narration route on the Stage; without one the Stage has none', async () => {
      const ttsRoute = {
        routeId: 'configured' as const,
        providerId: 'cartesia-tts',
        modelId: 'sonic-3.6',
        voiceId: '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72',
        language: 'en' as const,
        settingKey: 'teaching_tts.route.MATH',
      };
      await generate({ subjectCode: 'MATH', language: 'en', ttsRoute });
      expect(persistedStage()).toMatchObject({ subjectCode: 'MATH', ttsRoute });
      await generate({ subjectCode: 'MATH', language: 'en' });
      expect(persistedStage()).not.toHaveProperty('ttsRoute');
    });
  });
});
