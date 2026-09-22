import { PGlite } from '@electric-sql/pglite';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getModelInfo } from '@/lib/ai/providers';
import {
  ensureTeachingModelAttemptsSchema,
  readAttempt,
  readCalibration,
  type TeachingModelAttemptRow,
} from '@/lib/persistence/teaching-model-attempts';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import {
  ledgerRetryQueueSize,
  resetLedgerRetryQueueForTests,
  tickLedgerRetryQueue,
} from '@/lib/server/teaching-model/ledger-retry-queue';
import { countExactTokens, effectiveCap, HARD_CAP } from '@/lib/server/tutor/token-budget';

/**
 * Executor contract (contracts §7, plan §7.3/§7.7/§8.7, P3 test list).
 *
 * `@/lib/ai/llm` is mocked so the EXACT params handed to callLLM / streamLLM
 * are captured; `@/lib/server/resolve-model` is mocked so the policy resolves
 * against the real registry without provider clients; the ledger is a real
 * PGlite database wrapped to record the ORDER of started-row insert, provider
 * call and completion update.
 */

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  events: [] as string[],
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));

vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return {
        model: { provider: providerId, modelId },
        modelInfo: providers.getModelInfo(providerId, modelId),
        modelString,
        providerId,
        modelId,
        apiKey: 'k',
      };
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** PGlite with an event recorder and fault injection on the two ledger writes. */
class RecordingPool {
  failInsert = false;
  failUpdate = false;
  constructor(
    readonly db: PGlite,
    readonly events: string[],
  ) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    if (/^\s*INSERT INTO teaching_model_attempts/i.test(text)) {
      this.events.push('insert');
      if (this.failInsert) throw new Error('ledger down (insert)');
    }
    if (/^\s*UPDATE teaching_model_attempts SET\s+accounting_status = 'complete'/i.test(text)) {
      this.events.push('update');
      if (this.failUpdate) throw new Error('ledger down (update)');
    }
    return this.db.query<Row>(text, params);
  }
  async end() {
    await this.db.close();
  }
}

const T0 = 1_800_000_000_000;
let t = T0;
const now = () => t;
const tick = (ms: number) => {
  t += ms;
};

function apiError(
  statusCode: number,
  extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {},
) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.example',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
    ...extra,
  });
}

const USAGE = { inputTokens: 1000, outputTokens: 50, inputTokenDetails: { cacheReadTokens: 0 } };

function ok(text: string, overrides: Record<string, unknown> = {}) {
  return { text, finishReason: 'stop', usage: USAGE, totalUsage: USAGE, ...overrides };
}

type Part = { type: string; text?: string; error?: unknown; finishReason?: string; at?: number };
function streamOf(parts: Part[], usage: unknown = USAGE) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        if (part.at) tick(part.at);
        yield part;
      }
    })(),
    totalUsage: Promise.resolve(usage),
  };
}

const turnCtx = {
  tenantId: '1',
  capability: 'free_chat' as const,
  stage: 'free-chat-turn',
  origin: 'openmaic_runtime' as const,
  association: {
    kind: 'turn' as const,
    turnId: 'turn-1',
    conversationId: 'conv-1',
    studentRef: 'stu-1',
  },
};

const generationCtx = {
  tenantId: '1',
  capability: 'package_generation' as const,
  stage: 'scene-content:slide',
  origin: 'openmaic_runtime' as const,
  association: { kind: 'generation' as const, generationAttemptId: 'ga-1', generationRun: 1 },
};

const SMALL = {
  system: 'أنت معلم.',
  messages: [{ role: 'user' as const, content: 'ما هو التبرير الاستقرائي؟' }],
};

describe('executeTeachingCall / executeTeachingStream', () => {
  let pool: RecordingPool;
  let ids: number;
  let policy: Awaited<
    ReturnType<
      typeof import('@/lib/server/teaching-model/resolve-policy').resolveSubjectModelPolicy
    >
  >;
  let execute: typeof import('@/lib/server/teaching-model/execute');

  const opts = () => ({
    queryable: pool,
    now,
    idFactory: () => `tma-${++ids}`,
    completionRetryDelaysMs: [0, 0, 0],
    rateCard: BASE_RATE_CARD,
    workerId: 'host:1:test',
  });

  const rows = async (...idList: string[]) => {
    const out: TeachingModelAttemptRow[] = [];
    for (const id of idList) out.push((await readAttempt(pool, id))!);
    return out;
  };

  beforeEach(async () => {
    vi.resetModules();
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    resetLedgerRetryQueueForTests();
    t = T0;
    ids = 0;
    const db = new PGlite();
    await db.waitReady;
    pool = new RecordingPool(db, mocks.events);
    await ensureTeachingModelAttemptsSchema(pool);
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    policy = await resolveSubjectModelPolicy('MATH'); // primary qwen (proxy, no vision) → fallback gpt-5-nano (exact, vision)
    execute = await import('@/lib/server/teaching-model/execute');
  });

  afterEach(async () => {
    resetLedgerRetryQueueForTests();
    await pool.end();
  });

  it('primary 429 → fallback: two rows sharing turn_id, maxRetries 0, per-target thinking, primary_failure_ms', async () => {
    mocks.callLLM
      .mockImplementationOnce(async () => {
        mocks.events.push('call');
        tick(300);
        throw apiError(429);
      })
      .mockImplementationOnce(async () => {
        mocks.events.push('call');
        tick(500);
        return ok('الجواب الصحيح هو ٤.');
      });

    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());

    expect(result).toMatchObject({
      text: 'الجواب الصحيح هو ٤.',
      servedBy: 'fallback',
      attemptIds: ['tma-1', 'tma-2'],
    });
    expect(result.timings.primaryFailureMs).toBe(300);
    expect(result.usage?.classes.inputTokensTotal).toBe(1000);
    expect(result.usage?.cost.costBasis).toBe('full');

    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    const [primaryParams, primarySource, , primaryThinking] = mocks.callLLM.mock.calls[0]!;
    const [fallbackParams, , , fallbackThinking] = mocks.callLLM.mock.calls[1]!;
    expect(primaryParams).toMatchObject({
      model: { provider: 'qwen', modelId: 'qwen3.7-flash' },
      system: SMALL.system,
      messages: SMALL.messages,
      maxRetries: 0,
      maxOutputTokens: getModelInfo('qwen', 'qwen3.7-flash')!.outputWindow,
    });
    expect(primaryParams.abortSignal).toBeInstanceOf(AbortSignal);
    expect(primarySource).toBe('free-chat-turn');
    expect(primaryThinking).toEqual({ mode: 'disabled' });
    expect(fallbackParams).toMatchObject({
      model: { provider: 'openai', modelId: 'gpt-5-nano' },
      maxRetries: 0,
      maxOutputTokens: getModelInfo('openai', 'gpt-5-nano')!.outputWindow,
    });
    expect(fallbackThinking).toEqual({ mode: 'enabled', effort: 'minimal' });

    const [primary, fallback] = await rows('tma-1', 'tma-2');
    expect(primary).toMatchObject({
      role: 'primary',
      attempt_index: 1,
      accounting_status: 'complete',
      outcome: 'rate_limited',
      fallback_triggered: true,
      fallback_reason: 'rate_limited',
      error_status: 429,
      usage_available: false,
      cost_unavailable_reason: 'usage_missing',
      total_ms: 300,
      primary_failure_ms: null,
      turn_id: 'turn-1',
      worker_id: 'host:1:test',
      budget_counter_kind: 'proxy',
      budget_effective_cap: 25_600,
      thinking_label: 'nothink',
    });
    expect(fallback).toMatchObject({
      role: 'fallback',
      attempt_index: 2,
      accounting_status: 'complete',
      outcome: 'succeeded',
      fallback_triggered: false,
      primary_failure_ms: 300,
      total_ms: 500,
      turn_id: 'turn-1',
      cache_read_reported: true,
      cost_basis: 'full',
      budget_counter_kind: 'exact',
      budget_effective_cap: 30_080,
      budget_breach: false,
      thinking_label: 'minimal',
      ttft_unavailable_reason: 'non_streaming',
    });
    expect(Number(fallback!.cache_read_tokens)).toBe(0);
    expect(Number(fallback!.cost_usd)).toBeGreaterThan(0);
  });

  it('ORDER: started row → provider call → completion, and the completion is awaited before return', async () => {
    mocks.callLLM.mockImplementationOnce(async () => {
      mocks.events.push('call');
      return ok('نعم.');
    });
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect(mocks.events).toEqual(['insert', 'call', 'update']);
    expect((await rows('tma-1'))[0]!.accounting_status).toBe('complete');
    expect(result.servedBy).toBe('primary');
    expect(result.attemptIds).toEqual(['tma-1']);
  });

  it('primary empty output → fallback', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('   ')).mockResolvedValueOnce(ok('الشرح.'));
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect(result.servedBy).toBe('fallback');
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'empty_output',
      fallback_triggered: true,
    });
  });

  it('primary unparsable JSON → fallback, NO same-model retry; fallback parsable → parsed result', async () => {
    mocks.callLLM
      .mockResolvedValueOnce(ok('{"scenes": ['))
      .mockResolvedValueOnce(ok('{"scenes": [1]}'));
    const result = await execute.executeTeachingCall(
      policy,
      generationCtx,
      { ...SMALL, output: { kind: 'json', validate: (text) => JSON.parse(text) } },
      opts(),
    );
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    expect(mocks.callLLM.mock.calls[0]![0].model.modelId).toBe('qwen3.7-flash');
    expect(mocks.callLLM.mock.calls[1]![0].model.modelId).toBe('gpt-5-nano');
    expect(result.parsed).toEqual({ scenes: [1] });
    const [primary, fallback] = await rows('tma-1', 'tma-2');
    expect(primary).toMatchObject({
      outcome: 'unusable_output',
      error_code: 'unparsable',
      fallback_triggered: true,
    });
    expect(fallback).toMatchObject({
      outcome: 'succeeded',
      generation_attempt_id: 'ga-1',
      turn_id: null,
    });
    // Generation calls are never budget-asserted: budget columns NULL.
    expect(primary!.budget_estimate_tokens).toBeNull();
    expect(primary!.budget_breach).toBeNull();
  });

  it('parsable-but-weak output → success on the primary, no fallback (never a quality comparison)', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('نعم.'));
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect(result.servedBy).toBe('primary');
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('fallback unparsable too → TEACHING_MODEL_UNAVAILABLE (retryable) with both rows complete', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('<div></div>')).mockResolvedValueOnce(ok('```\n```'));
    await expect(execute.executeTeachingCall(policy, turnCtx, SMALL, opts())).rejects.toMatchObject(
      {
        name: 'TeachingModelUnavailableError',
        code: 'TEACHING_MODEL_UNAVAILABLE',
        status: 503,
        retryable: true,
        attemptIds: ['tma-1', 'tma-2'],
        outcomes: [
          { role: 'primary', outcome: 'unusable_output' },
          { role: 'fallback', outcome: 'unusable_output' },
        ],
      },
    );
    const [primary, fallback] = await rows('tma-1', 'tma-2');
    expect(primary!.accounting_status).toBe('complete');
    expect(fallback).toMatchObject({
      accounting_status: 'complete',
      fallback_triggered: false,
      primary_failure_ms: 0,
    });
  });

  it('output content-filter → safety_refused, no fallback, non-retryable', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('', { finishReason: 'content-filter' }));
    await expect(execute.executeTeachingCall(policy, turnCtx, SMALL, opts())).rejects.toMatchObject(
      {
        code: 'TEACHING_MODEL_UNAVAILABLE',
        retryable: false,
        outcomes: [{ role: 'primary', outcome: 'safety_refused' }],
      },
    );
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'safety_refused',
      fallback_triggered: false,
    });
  });

  it('request_rejected (400 context too long) → no fallback, non-retryable', async () => {
    mocks.callLLM.mockRejectedValueOnce(apiError(400, { message: 'context length exceeded' }));
    await expect(execute.executeTeachingCall(policy, turnCtx, SMALL, opts())).rejects.toMatchObject(
      {
        code: 'TEACHING_MODEL_UNAVAILABLE',
        retryable: false,
      },
    );
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'request_rejected',
      error_status: 400,
    });
  });

  it('DashScope input inspection → provider_content_filter → fallback', async () => {
    mocks.callLLM
      .mockRejectedValueOnce(
        apiError(400, { responseBody: '{"error":{"code":"DataInspectionFailed"}}' }),
      )
      .mockResolvedValueOnce(ok('الكيمياء العضوية...'));
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect(result.servedBy).toBe('fallback');
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'provider_content_filter',
      error_code: 'DataInspectionFailed',
      fallback_triggered: true,
      fallback_reason: 'provider_content_filter',
    });
  });

  it('caller abort → aborted, no fallback, TeachingCallAbortedError', async () => {
    const controller = new AbortController();
    mocks.callLLM.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    await expect(
      execute.executeTeachingCall(policy, { ...turnCtx, signal: controller.signal }, SMALL, opts()),
    ).rejects.toMatchObject({
      name: 'TeachingCallAbortedError',
      code: 'ABORTED',
      attemptIds: ['tma-1'],
    });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'aborted',
      accounting_status: 'complete',
    });
  });

  it('timeout: our AbortSignal.timeout fired → timeout → fallback', async () => {
    mocks.callLLM
      .mockImplementationOnce(async (params: { abortSignal: AbortSignal }) => {
        // Wait for the executor's own timeout signal, as the SDK would.
        await new Promise<void>((resolve) =>
          params.abortSignal.addEventListener('abort', () => resolve()),
        );
        throw Object.assign(new Error('timeout'), { name: 'AbortError' });
      })
      .mockResolvedValueOnce(ok('الجواب.'));
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, {
      ...opts(),
      timeoutMs: 20,
    });
    expect(result.servedBy).toBe('fallback');
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'timeout',
      fallback_triggered: true,
    });
  });

  it('started-row insert failure (after one retry) → no provider call, ACCOUNTING_UNAVAILABLE', async () => {
    pool.failInsert = true;
    await expect(execute.executeTeachingCall(policy, turnCtx, SMALL, opts())).rejects.toMatchObject(
      {
        name: 'AccountingUnavailableError',
        code: 'ACCOUNTING_UNAVAILABLE',
        status: 503,
        retryable: true,
      },
    );
    expect(mocks.events).toEqual(['insert', 'insert']);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('completion write failure → in-memory retry queue, row stays started, result still released', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('الجواب.'));
    pool.failUpdate = true;
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect(result.servedBy).toBe('primary');
    expect(mocks.events.filter((e) => e === 'update')).toHaveLength(4); // 1 + 3 inline retries
    expect((await rows('tma-1'))[0]!.accounting_status).toBe('started');
    expect(ledgerRetryQueueSize()).toBe(1);
    // The ledger recovers: the queued write completes the row.
    pool.failUpdate = false;
    const tickResult = await tickLedgerRetryQueue();
    expect(tickResult.succeeded).toEqual(['tma-1']);
    expect((await rows('tma-1'))[0]).toMatchObject({
      accounting_status: 'complete',
      outcome: 'succeeded',
      late_completion: false,
    });
  });

  it('completeAttempt hook: the completion joins the caller transaction instead of a direct write', async () => {
    mocks.callLLM.mockImplementationOnce(async () => {
      mocks.events.push('call');
      return ok('الجواب.');
    });
    const hook = vi.fn(async (_attemptId: string, _completion: unknown) => {
      mocks.events.push('hook');
    });
    const result = await execute.executeTeachingCall(
      policy,
      { ...turnCtx, completeAttempt: hook },
      SMALL,
      opts(),
    );
    expect(result.attemptIds).toEqual(['tma-1']);
    expect(mocks.events).toEqual(['insert', 'call', 'hook']);
    expect(hook).toHaveBeenCalledWith(
      'tma-1',
      expect.objectContaining({ outcome: 'succeeded', fallbackTriggered: false }),
    );
    // The hook owns the write: the executor did not update the row itself.
    expect((await rows('tma-1'))[0]!.accounting_status).toBe('started');
  });

  it('budget assertion refuses an over-cap conversational request WITHOUT calling the provider', async () => {
    let big = 'الاستنتاج المنطقي من الملاحظات المتكررة يسمى تبريراً استقرائياً. ';
    while (countExactTokens([{ role: 'user', content: big }]) < effectiveCap('proxy') + 1000)
      big += big;
    const params = { system: SMALL.system, messages: [{ role: 'user' as const, content: big }] };
    await expect(
      execute.executeTeachingCall(policy, turnCtx, params, opts()),
    ).rejects.toMatchObject({
      name: 'BudgetAssertionError',
      code: 'BUDGET_ASSERTION_FAILED',
      retryable: true,
      attemptId: 'tma-1',
      counterKind: 'proxy',
      effectiveCap: 25_600,
    });
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    const [row] = await rows('tma-1');
    expect(row).toMatchObject({
      accounting_status: 'complete',
      outcome: 'budget_assertion_failed',
      budget_counter_kind: 'proxy',
      budget_effective_cap: 25_600,
      usage_available: false,
      ttft_unavailable_reason: 'not_called',
    });
    expect(row!.budget_estimate_tokens).toBeGreaterThan(25_600);
    expect(mocks.events).toEqual(['insert', 'update']);
  });

  it('a generation-capability call over 32K is NOT refused (H1: budget is per conversational request)', async () => {
    let big = 'نص الدرس الكامل مع كل الأمثلة والتمارين. ';
    while (countExactTokens([{ role: 'user', content: big }]) < HARD_CAP + 2000) big += big;
    mocks.callLLM.mockResolvedValueOnce(ok('المخطط.'));
    const result = await execute.executeTeachingCall(
      policy,
      generationCtx,
      { system: SMALL.system, messages: [{ role: 'user' as const, content: big }] },
      opts(),
    );
    expect(result.servedBy).toBe('primary');
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'succeeded',
      budget_estimate_tokens: null,
      budget_counter_kind: null,
      budget_breach: null,
    });
  });

  it('post-call budget breach → budget_breach=true, loud, proxy ratio tightened', async () => {
    const reported = HARD_CAP + 1000;
    mocks.callLLM.mockResolvedValueOnce(
      ok('الجواب.', {
        usage: { inputTokens: reported, outputTokens: 5 },
        totalUsage: { inputTokens: reported, outputTokens: 5 },
      }),
    );
    await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect((await rows('tma-1'))[0]).toMatchObject({ outcome: 'succeeded', budget_breach: true });
    const calibration = await readCalibration(pool, 'qwen:qwen3.7-flash');
    const exact = countExactTokens([{ role: 'system', content: SMALL.system }, ...SMALL.messages]);
    expect(calibration?.proxyRatio).toBeCloseTo((reported / exact) * 1.05, 6);
    expect(calibration?.sampleCount).toBe(1);
  });

  it('primary lacks vision + images → pre-call fallback with fallback_reason=primary_lacks_vision', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('وصف الصورة.'));
    const result = await execute.executeTeachingCall(policy, generationCtx, SMALL, {
      ...opts(),
      images: [{}],
    });
    expect(result.servedBy).toBe('fallback');
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0]![0].model.modelId).toBe('gpt-5-nano');
    const [row] = await rows('tma-1');
    expect(row).toMatchObject({
      role: 'fallback',
      attempt_index: 1,
      outcome: 'succeeded',
      fallback_reason: 'primary_lacks_vision',
      fallback_triggered: false,
    });
    expect(await readAttempt(pool, 'tma-2')).toBeNull();
  });

  it('usage missing on a succeeded call → usage NULL columns, result.usage null', async () => {
    mocks.callLLM.mockResolvedValueOnce({ text: 'الجواب.', finishReason: 'stop' });
    const result = await execute.executeTeachingCall(policy, turnCtx, SMALL, opts());
    expect(result.usage).toBeNull();
    expect((await rows('tma-1'))[0]).toMatchObject({
      outcome: 'succeeded',
      usage_available: false,
      input_tokens_total: null,
      cost_unavailable_reason: 'usage_missing',
      budget_breach: null,
    });
  });

  describe('streaming', () => {
    const sink = () => ({ onDelta: vi.fn(), onRestart: vi.fn(), onFinish: vi.fn() });

    it('pre-delta failure → transparent fallback (no restart)', async () => {
      mocks.streamLLM
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(503) }]))
        .mockImplementationOnce(() =>
          streamOf([
            { type: 'text-delta', text: 'الجواب ', at: 120 },
            { type: 'text-delta', text: 'هو ٤.' },
            { type: 'finish', finishReason: 'stop' },
          ]),
        );
      const s = sink();
      const result = await execute.executeTeachingStream(policy, turnCtx, SMALL, s, opts());
      expect(result).toMatchObject({ text: 'الجواب هو ٤.', servedBy: 'fallback' });
      expect(s.onRestart).not.toHaveBeenCalled();
      expect(s.onDelta.mock.calls.map((c) => c[0])).toEqual(['الجواب ', 'هو ٤.']);
      expect(s.onFinish).toHaveBeenCalledWith(result);
      expect(mocks.streamLLM.mock.calls[0]![0]).toMatchObject({ maxRetries: 0 });
      expect(mocks.streamLLM.mock.calls[0]![2]).toEqual({ mode: 'disabled' });
      const [primary, fallback] = await rows('tma-1', 'tma-2');
      expect(primary).toMatchObject({
        outcome: 'provider_error',
        error_status: 503,
        ttft_unavailable_reason: 'no_visible_delta',
        fallback_triggered: true,
      });
      expect(fallback).toMatchObject({ outcome: 'succeeded', ttft_ms: 120 });
      expect(result.timings.ttftMs).toBe(120);
    });

    it('post-delta failure → onRestart, then the fallback streams from scratch', async () => {
      mocks.streamLLM
        .mockImplementationOnce(() =>
          streamOf([
            { type: 'text-delta', text: 'بداية', at: 80 },
            {
              type: 'error',
              error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
            },
          ]),
        )
        .mockImplementationOnce(() =>
          streamOf([
            { type: 'text-delta', text: 'كامل', at: 90 },
            { type: 'finish', finishReason: 'stop' },
          ]),
        );
      const s = sink();
      const result = await execute.executeTeachingStream(policy, turnCtx, SMALL, s, opts());
      expect(result.text).toBe('كامل');
      expect(s.onRestart).toHaveBeenCalledTimes(1);
      expect(s.onDelta.mock.calls.map((c) => c[0])).toEqual(['بداية', 'كامل']);
      const [primary] = await rows('tma-1');
      // The partial delta still gives the failed primary a TTFT; its outcome is technical.
      expect(primary).toMatchObject({
        outcome: 'provider_error',
        error_code: 'ECONNRESET',
        ttft_ms: 80,
        fallback_triggered: true,
      });
    });

    it('stream completing with unrenderable text → restart + fallback', async () => {
      mocks.streamLLM
        .mockImplementationOnce(() =>
          streamOf([
            { type: 'text-delta', text: '<br/>' },
            { type: 'finish', finishReason: 'stop' },
          ]),
        )
        .mockImplementationOnce(() =>
          streamOf([
            { type: 'text-delta', text: 'الشرح.' },
            { type: 'finish', finishReason: 'stop' },
          ]),
        );
      const s = sink();
      const result = await execute.executeTeachingStream(policy, turnCtx, SMALL, s, opts());
      expect(result.servedBy).toBe('fallback');
      expect(s.onRestart).toHaveBeenCalledTimes(1);
      expect((await rows('tma-1'))[0]).toMatchObject({
        outcome: 'unusable_output',
        error_code: 'unrenderable',
      });
    });

    it('TTFT is the first NON-EMPTY visible text delta; reasoning deltas are excluded', async () => {
      mocks.streamLLM.mockImplementationOnce(() =>
        streamOf([
          { type: 'reasoning-delta', text: 'thinking…', at: 100 },
          { type: 'text-delta', text: '', at: 50 },
          { type: 'text-delta', text: 'الجواب', at: 100 },
          { type: 'finish', finishReason: 'stop' },
        ]),
      );
      const s = sink();
      const result = await execute.executeTeachingStream(policy, turnCtx, SMALL, s, opts());
      expect(result.timings.ttftMs).toBe(250);
      expect(s.onDelta.mock.calls.map((c) => c[0])).toEqual(['الجواب']);
      expect((await rows('tma-1'))[0]).toMatchObject({ ttft_ms: 250, outcome: 'succeeded' });
    });

    it('both streams fail → TEACHING_MODEL_UNAVAILABLE and onFinish is never called', async () => {
      mocks.streamLLM
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(500) }]))
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(502) }]));
      const s = sink();
      await expect(
        execute.executeTeachingStream(policy, turnCtx, SMALL, s, opts()),
      ).rejects.toMatchObject({
        code: 'TEACHING_MODEL_UNAVAILABLE',
        retryable: true,
      });
      expect(s.onFinish).not.toHaveBeenCalled();
    });

    it('budget assertion applies to streams too: over-cap help turn → no streamLLM call', async () => {
      let big = 'نص طويل جداً. ';
      while (countExactTokens([{ role: 'user', content: big }]) < effectiveCap('proxy') + 500)
        big += big;
      const s = sink();
      await expect(
        execute.executeTeachingStream(
          policy,
          { ...turnCtx, capability: 'help', stage: 'help-turn' },
          { messages: [{ role: 'user' as const, content: big }] },
          s,
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'BUDGET_ASSERTION_FAILED' });
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(s.onDelta).not.toHaveBeenCalled();
    });
  });
});
