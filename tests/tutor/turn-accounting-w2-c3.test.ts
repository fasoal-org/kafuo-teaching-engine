import { APICallError } from 'ai';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFinalize } from '@/lib/persistence/meter-finalize-outbox';
import { readMessageByClientId } from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import {
  createMeterRefusalCache,
  type MeterRefusalCache,
} from '@/lib/server/tutor/meter-refusal-cache';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';
import { parseSseFrames } from '@/lib/server/tutor/sse';

import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  ok,
  readSse,
  RecordingPool,
  streamOf,
  studentBearer,
  T0_MS,
  textStream,
  USAGE,
  type FakeKafuo,
} from './tutor-test-harness';

/**
 * W2-C3 on the Teaching Engine turn runner (Free Chat route, PGlite, mocked LLM,
 * fake Kafuo):
 *
 * - D-3 (owner charging decision): a turn is charged ONLY when the whole answer
 *   was delivered — `done` was written while the stream was still open. A
 *   partial answer followed by a provider failure, a client hang-up mid-stream,
 *   a disconnect before `done`, or a completion-transaction failure all end
 *   `not_delivered` (released); only the complete answer whose `done` reached
 *   the client is finalized `delivered`.
 * - ET-34: with a refusal cache in the deps, a non-retryable refusal answers the
 *   next turn before `prepare` (no grounding / embedding, no reserve) for the
 *   cache window; `temporarily_unavailable` is never cached; no cache = no change.
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

const SERVICE_KEY = 'turn-accounting-w2-c3-svc-key';
const QUESTION = 'ما هو التبرير الاستقرائي في الرياضيات؟';

function apiError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.example',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode >= 500,
  });
}

let pool: RecordingPool;
let kafuo: FakeKafuo;
let ids = 0;
let clock = T0_MS;

function wire(refusalCache?: MeterRefusalCache) {
  setTutorRuntimeDepsForTests({
    pool: asConnectable(pool),
    kafuo: kafuo.client,
    now: () => clock,
    workerId: 'host:1:test',
    idFactory: () => `id-${++ids}`,
    executor: {
      rateCard: BASE_RATE_CARD,
      completionRetryDelaysMs: [0, 0, 0],
      idFactory: () => `tma-${++ids}`,
    },
    heartbeatMs: 0,
    completionTxRetryDelaysMs: [0, 0],
    ...(refusalCache ? { refusalCache } : {}),
  });
}

async function routes() {
  return {
    list: await import('@/app/api/tutor/conversations/route'),
    messages: await import('@/app/api/tutor/conversations/[id]/messages/route'),
  };
}

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: studentBearer() },
    body: JSON.stringify(body),
  });
}

async function conversation(): Promise<string> {
  const r = await routes();
  const response = await r.list.POST(
    post('/api/tutor/conversations', { subjectCode: 'MATH', clientRequestId: `cr-${++ids}` }),
  );
  return ((await response.json()) as { conversation: { id: string } }).conversation.id;
}

async function send(conversationId: string, clientMessageId = 'cm-1') {
  const r = await routes();
  return r.messages.POST(
    post(`/api/tutor/conversations/${conversationId}/messages`, {
      clientMessageId,
      text: QUESTION,
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

async function settledFinalize(reservationId: string) {
  for (let i = 0; i < 200; i += 1) {
    const row = await readFinalize(pool, reservationId);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no finalize row for ${reservationId}`);
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://turn-accounting-w2-c3-test');
  vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
  mocks.callLLM.mockReset();
  mocks.streamLLM.mockReset();
  mocks.events.length = 0;
  resetLedgerRetryQueueForTests();
  resetTurnRateLimitForTests();
  ids = 0;
  clock = T0_MS;
  pool = await createTutorPool(mocks.events);
  kafuo = fakeKafuo(mocks.events);
  mocks.callLLM.mockImplementation(async () => ok('التبرير الاستقرائي'));
  wire();
});

afterEach(async () => {
  setTutorRuntimeDepsForTests(undefined);
  await pool.end();
});

describe('D-3: a turn is charged only when `done` reached the client', () => {
  it('partial text, then the client hangs up mid-stream: released (not_delivered, reason aborted)', async () => {
    mocks.streamLLM.mockImplementation((params: { abortSignal: AbortSignal }) => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'الجواب يبدأ هنا' };
        await new Promise<void>((resolve) => {
          if (params.abortSignal.aborted) resolve();
          else params.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      })(),
      totalUsage: Promise.resolve(USAGE),
    }));
    const id = await conversation();
    const response = await send(id);
    expect(response.status).toBe(200);

    // Read until the first answer text arrives, then hang up: no `done` ever
    // reaches the client, so the incomplete answer is not charged.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!parseSseFrames(seen).some((f) => f.event === 'text_delta')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    await reader.cancel();

    const outbox = await settledFinalize('res-1');
    expect(outbox).toMatchObject({ outcome: 'not_delivered', reason: 'aborted' });
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1); // an abort is never retried on the fallback
    const student = (await readMessageByClientId(pool, id, 'cm-1'))!;
    expect(student.status).toBe('failed');
  });

  it('partial text from the primary, then both routes fail: released with reason model_unavailable', async () => {
    mocks.streamLLM
      .mockImplementationOnce(() =>
        streamOf([
          { type: 'text-delta', text: 'نص جزئي' },
          { type: 'error', error: apiError(503) },
        ]),
      )
      .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(502) }]));
    const id = await conversation();
    const frames = await readSse(await send(id));
    expect(frames.map((f) => f.event)).toContain('text_delta');
    expect(frames.at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'TEACHING_MODEL_UNAVAILABLE' },
    });
    // D-3: fallbacks exhausted mid-answer → no complete answer, no `done`: released.
    expect(await settledFinalize('res-1')).toMatchObject({
      outcome: 'not_delivered',
      reason: 'model_unavailable',
    });
    expect(kafuo.finalize.mock.calls[0]![0]).toMatchObject({
      reservationId: 'res-1',
      outcome: 'not_delivered',
    });
  });

  it('no answer text at all: not_delivered (released by Kafuo)', async () => {
    mocks.streamLLM
      .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(503) }]))
      .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(502) }]));
    const id = await conversation();
    await readSse(await send(id));
    expect(await settledFinalize('res-1')).toMatchObject({
      outcome: 'not_delivered',
      reason: 'model_unavailable',
    });
  });

  it('a full answer whose `done` reaches the client: delivered', async () => {
    mocks.streamLLM.mockImplementation(() => textStream('الجواب كاملًا هنا.'));
    const id = await conversation();
    const frames = await readSse(await send(id));
    expect(frames.map((f) => f.event)).toContain('done');
    expect(await settledFinalize('res-1')).toMatchObject({ outcome: 'delivered', reason: null });
    expect(kafuo.finalize.mock.calls[0]![0]).toMatchObject({
      reservationId: 'res-1',
      outcome: 'delivered',
      reason: null,
    });
    const student = (await readMessageByClientId(pool, id, 'cm-1'))!;
    expect(student.status).toBe('completed');
  });

  it('a full answer whose client disconnects BEFORE `done`: released', async () => {
    // The model answer completes (text + finish), but the executor is still
    // awaiting usage when the student hangs up: no `done` can ever be written.
    let releaseUsage!: () => void;
    const usageGate = new Promise<unknown>((resolve) => {
      releaseUsage = () => resolve(USAGE);
    });
    mocks.streamLLM.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'الجواب كاملًا' };
        yield { type: 'finish', finishReason: 'stop' };
      })(),
      totalUsage: usageGate,
    }));
    const id = await conversation();
    const response = await send(id);
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!parseSseFrames(seen).some((f) => f.event === 'text_delta')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    await reader.cancel();
    releaseUsage();

    const outbox = await settledFinalize('res-1');
    expect(outbox).toMatchObject({ outcome: 'not_delivered', reason: 'aborted' });
    expect(kafuo.finalize.mock.calls[0]![0]).toMatchObject({
      reservationId: 'res-1',
      outcome: 'not_delivered',
    });
    // The answer itself completed server-side; only the charge was released.
    const student = (await readMessageByClientId(pool, id, 'cm-1'))!;
    expect(student.status).toBe('completed');
  });

  it('a completion transaction that cannot commit releases the reservation directly', async () => {
    mocks.streamLLM.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'الجواب كاملًا' };
        pool.failCommit = true; // from here on every transaction commit fails
        yield { type: 'finish', finishReason: 'stop' };
      })(),
      totalUsage: Promise.resolve(USAGE),
    }));
    const id = await conversation();
    const frames = await readSse(await send(id));
    pool.failCommit = false;
    // No `done` was sent (the turn answers error), so D-3 releases the unit.
    expect(frames.at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'ACCOUNTING_UNAVAILABLE' },
    });
    expect(await readFinalize(pool, 'res-1')).toBeNull(); // no outbox row was committed
    expect(kafuo.finalize).toHaveBeenCalledTimes(1);
    expect(kafuo.finalize.mock.calls[0]![0]).toEqual({
      reservationId: 'res-1',
      outcome: 'not_delivered',
      reason: 'internal_error',
      turnId: expect.any(String),
    });
  });
});

describe('ET-34: a recent refusal answers before prepare', () => {
  const REFUSED = {
    allowed: false as const,
    reason: 'tutor_allowance_exhausted' as const,
    window: 'half_month',
    resetAt: '2099-01-01T00:00:00+03:00',
    replay: false,
  };

  it('the second turn makes no grounding, embedding or reserve call', async () => {
    wire(createMeterRefusalCache(() => 60));
    kafuo.reserve.mockResolvedValue(REFUSED);
    const id = await conversation();
    const first = await send(id, 'cm-1');
    expect(first.status).toBe(429);
    const reserves = kafuo.reserve.mock.calls.length;
    const groundings = kafuo.groundingSearch.mock.calls.length;
    const prepares = mocks.events.length;

    const second = await send(id, 'cm-2');
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        code: 'ALLOWANCE_EXHAUSTED',
        retryable: false,
        details: {
          reason: 'tutor_allowance_exhausted',
          window: 'half_month',
          resetAt: REFUSED.resetAt,
        },
      },
    });
    expect(kafuo.reserve.mock.calls.length).toBe(reserves);
    expect(kafuo.groundingSearch.mock.calls.length).toBe(groundings);
    expect(mocks.events.slice(prepares)).not.toContain('kafuo:grounding');
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    // The student row is not left generating, so a later retry is admitted normally.
    expect((await readMessageByClientId(pool, id, 'cm-2'))!.status).toBe('failed');
  });

  it('the cache window ends and Kafuo is asked again', async () => {
    wire(createMeterRefusalCache(() => 60));
    kafuo.reserve.mockResolvedValueOnce(REFUSED);
    mocks.streamLLM.mockImplementation(() => textStream('الجواب'));
    const id = await conversation();
    expect((await send(id, 'cm-1')).status).toBe(429);
    clock += 61_000;
    const later = await send(id, 'cm-2');
    expect(later.status).toBe(200);
    await readSse(later);
    expect(kafuo.reserve).toHaveBeenCalledTimes(2);
  });

  it('temporarily_unavailable is never cached', async () => {
    wire(createMeterRefusalCache(() => 60));
    kafuo.reserve.mockResolvedValue({
      ...REFUSED,
      reason: 'temporarily_unavailable',
      window: null,
      resetAt: null,
    });
    const id = await conversation();
    expect((await send(id, 'cm-1')).status).toBe(503);
    expect((await send(id, 'cm-2')).status).toBe(503);
    expect(kafuo.reserve).toHaveBeenCalledTimes(2);
  });

  it('deps without a cache keep asking Kafuo on every turn', async () => {
    kafuo.reserve.mockResolvedValue(REFUSED);
    const id = await conversation();
    expect((await send(id, 'cm-1')).status).toBe(429);
    expect((await send(id, 'cm-2')).status).toBe(429);
    expect(kafuo.reserve).toHaveBeenCalledTimes(2);
  });
});
