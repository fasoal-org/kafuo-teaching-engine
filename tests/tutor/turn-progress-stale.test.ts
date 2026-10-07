import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  insertStudentMessage,
  markMessageGenerating,
  nextMessageSeq,
  readMessageByClientId,
} from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import {
  setTutorRuntimeDepsForTests,
  type TutorRuntimeDeps,
} from '@/lib/server/tutor/runtime-deps';
import type { TurnRunnerDeps } from '@/lib/server/tutor/turn-runner';

import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  ok,
  readSse,
  RecordingPool,
  studentBearer,
  T0_MS,
  textStream,
  type FakeKafuo,
} from './tutor-test-harness';

/**
 * TE-1 / D5 (free-chat-ios-run-fix-plan §5): a turn whose instance died must
 * not hold the conversation for the full 120 s TURN_IN_PROGRESS window.
 *
 * - `progress_at` is set when the stream opens and bumped while it runs; at
 *   admission, a `generating` turn with no progress for 30 s is stale.
 * - 120 s since `generating_at` stays the upper bound; a row without
 *   `progress_at` (written before the column) keeps the 120 s rule.
 * - On SIGTERM the process marks ITS in-flight turns failed / TURN_STALE.
 *
 * PGlite + mocked `@/lib/ai/llm` + a fake Kafuo client, like
 * `conversation-routes.test.ts`. Time is the injected `now`; the progress
 * timer is real but its interval is shortened for the live-turn test.
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

const SERVICE_KEY = 'turn-progress-stale-svc-key';
const T0_S = T0_MS / 1000;
const WORKER = 'host:1:test';
const OTHER_WORKER = 'host:2:other';
let t = T0_MS;
const now = () => t;

type Deps = TutorRuntimeDeps & Pick<TurnRunnerDeps, 'progressIntervalMs'>;

async function routes() {
  return {
    list: await import('@/app/api/tutor/conversations/route'),
    messages: await import('@/app/api/tutor/conversations/[id]/messages/route'),
  };
}

function request(path: string, init: { method?: string; body?: unknown; auth?: string } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.auth ? { authorization: init.auth } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** A model stream that waits for `release()` before answering. */
function gatedStream() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = {
    fullStream: (async function* () {
      await gate;
      yield { type: 'text-delta', text: 'تم' };
      yield { type: 'finish', finishReason: 'stop' };
    })(),
    totalUsage: Promise.resolve(undefined),
  };
  return { stream, release };
}

describe('TE-1: stale turns after a crash (progress_at + SIGTERM)', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let ids: number;
  let baseDeps: Deps;

  async function createConversation(clientRequestId = 'cr-1', subjectCode = 'MATH') {
    const r = await routes();
    const response = await r.list.POST(
      request('/api/tutor/conversations', {
        method: 'POST',
        auth: studentBearer(),
        body: { subjectCode, clientRequestId },
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async function send(conversationId: string, body: Record<string, unknown>) {
    const r = await routes();
    return r.messages.POST(
      request(`/api/tutor/conversations/${conversationId}/messages`, {
        method: 'POST',
        auth: studentBearer(),
        body,
      }),
      params(conversationId),
    );
  }

  /**
   * A student row left `generating` by an instance that is gone: generating
   * since T0, last progress at `progressAtS` (null = a row from before the
   * column, whose instance never wrote progress).
   */
  async function seedDeadTurn(
    conversationId: string,
    clientMessageId: string,
    progressAtS: number | null,
  ) {
    const seq = await nextMessageSeq(pool, conversationId);
    const inserted = (await insertStudentMessage(pool, {
      id: `msg-dead-${clientMessageId}`,
      parentId: conversationId,
      seq,
      clientMessageId,
      turnId: `turn-dead-${clientMessageId}`,
      text: 'س',
      now: T0_S,
    }))!;
    await markMessageGenerating(pool, inserted.id, { turnAttempt: 1, now: T0_S });
    if (progressAtS !== null) {
      await pool.query('UPDATE tutor_messages SET progress_at = $2 WHERE id = $1', [
        inserted.id,
        progressAtS,
      ]);
    }
    return inserted;
  }

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://turn-progress-stale-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    t = T0_MS;
    ids = 0;
    pool = await createTutorPool(mocks.events);
    kafuo = fakeKafuo(mocks.events);
    mocks.callLLM.mockImplementation(async () => ok('التبرير الاستقرائي'));
    baseDeps = {
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now,
      workerId: WORKER,
      idFactory: () => `id-${++ids}`,
      executor: {
        rateCard: BASE_RATE_CARD,
        completionRetryDelaysMs: [0, 0, 0],
        idFactory: () => `tma-${++ids}`,
      },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
    };
    setTutorRuntimeDepsForTests(baseDeps);
  });

  afterEach(async () => {
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  it('dead turn without progress for 30 s is taken over (Retry-After unchanged: the 120 s window)', async () => {
    const conversationId = await createConversation();
    // The dead instance last reported progress 10 s into the turn.
    const dead = await seedDeadTurn(conversationId, 'cm-1', T0_S + 10);

    // 29 s of silence: still in progress. Retry-After stays today's 120 s
    // window (81 s left); the app caps each wait at 30 s, so its replay lands
    // after ≥ 30 s of silence and takes the turn over (below).
    t = T0_MS + 39_000;
    const early = await send(conversationId, { clientMessageId: 'cm-1', text: 'س' });
    expect(early.status).toBe(409);
    expect(early.headers.get('retry-after')).toBe('81');
    await expect(early.json()).resolves.toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });

    // 31 s of silence: stale — taken over under turn_attempt + 1.
    t = T0_MS + 41_000;
    mocks.streamLLM.mockImplementationOnce(() => textStream('نجح'));
    const taken = await send(conversationId, { clientMessageId: 'cm-1', text: 'س' });
    expect(taken.status).toBe(200);
    const frames = await readSse(taken);
    expect(frames.map((f) => f.event)).toContain('done');
    const after = (await readMessageByClientId(pool, conversationId, 'cm-1'))!;
    expect(after).toMatchObject({
      id: dead.id,
      status: 'completed',
      turnId: dead.turnId,
      turnAttempt: 2,
    });
    expect(kafuo.reserve.mock.calls.map((c) => [c[0].turnId, c[0].turnAttempt])).toEqual([
      [dead.turnId, 2],
    ]);
  });

  it('live turn with recent progress still gets 409 (progress_at set at stream open, bumped while running)', async () => {
    // Runtime deps flow into the runner as-is; the progress seam is a runner dep.
    const fastProgress: Deps = { ...baseDeps, progressIntervalMs: 5 };
    setTutorRuntimeDepsForTests(fastProgress);
    const conversationId = await createConversation();
    const gated = gatedStream();
    mocks.streamLLM.mockImplementationOnce(() => gated.stream);
    const first = await send(conversationId, { clientMessageId: 'cm-1', text: 'س' });
    expect(first.status).toBe(200);
    const opened = (await readMessageByClientId(pool, conversationId, 'cm-1'))!;
    expect(opened).toMatchObject({ status: 'generating', progressAt: T0_S });

    // 35 s later the live instance has kept bumping progress_at.
    t = T0_MS + 35_000;
    await vi.waitFor(
      async () => {
        const row = (await readMessageByClientId(pool, conversationId, 'cm-1'))!;
        expect(row.progressAt).toBe(T0_S + 35);
      },
      { timeout: 2_000, interval: 5 },
    );
    const second = await send(conversationId, { clientMessageId: 'cm-1', text: 'س' });
    expect(second.status).toBe(409);
    // Retry-After unchanged: the time left of the 120 s window (120 − 35).
    expect(second.headers.get('retry-after')).toBe('85');
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'TURN_IN_PROGRESS', retryable: true },
    });

    gated.release();
    expect((await readSse(first)).map((f) => f.event)).toContain('done');
    const done = (await readMessageByClientId(pool, conversationId, 'cm-1'))!;
    expect(done).toMatchObject({ status: 'completed', turnAttempt: 1 });
    // The progress timer is gone once the turn ended.
    const { inFlightTurnIds } = await import('@/lib/server/tutor/turn-progress');
    expect(inFlightTurnIds()).not.toContain(opened.id);
  });

  it('NULL progress_at keeps the 120 s rule; 120 s stays the upper bound with progress', async () => {
    const conversationId = await createConversation();
    await seedDeadTurn(conversationId, 'cm-legacy', null);

    t = T0_MS + 41_000;
    const at41 = await send(conversationId, { clientMessageId: 'cm-legacy', text: 'س' });
    expect(at41.status).toBe(409);
    expect(at41.headers.get('retry-after')).toBe('79');

    t = T0_MS + 119_000;
    const at119 = await send(conversationId, { clientMessageId: 'cm-legacy', text: 'س' });
    expect(at119.status).toBe(409);
    expect(at119.headers.get('retry-after')).toBe('1');

    t = T0_MS + 121_000;
    mocks.streamLLM.mockImplementationOnce(() => textStream('نجح'));
    const at121 = await send(conversationId, { clientMessageId: 'cm-legacy', text: 'س' });
    expect(at121.status).toBe(200);
    await readSse(at121);
    expect((await readMessageByClientId(pool, conversationId, 'cm-legacy'))!).toMatchObject({
      status: 'completed',
      turnAttempt: 2,
    });

    // Upper bound: progress 1 s ago, but generating for 126 s → stale.
    await seedDeadTurn(conversationId, 'cm-bound', T0_S + 125);
    t = T0_MS + 126_000;
    mocks.streamLLM.mockImplementationOnce(() => textStream('نجح'));
    const bound = await send(conversationId, { clientMessageId: 'cm-bound', text: 'س' });
    expect(bound.status).toBe(200);
    await readSse(bound);
    expect((await readMessageByClientId(pool, conversationId, 'cm-bound'))!).toMatchObject({
      status: 'completed',
      turnAttempt: 2,
    });
  });

  it("SIGTERM marks in-flight turns of this worker failed/TURN_STALE and leaves other workers' turns", async () => {
    const mine = await createConversation('cr-mine', 'MATH');
    const theirs = await createConversation('cr-theirs', 'CHEMISTRY');
    const gateMine = gatedStream();
    const gateTheirs = gatedStream();
    mocks.streamLLM
      .mockImplementationOnce(() => gateMine.stream)
      .mockImplementationOnce(() => gateTheirs.stream);

    const mineResponse = await send(mine, { clientMessageId: 'cm-1', text: 'س' });
    expect(mineResponse.status).toBe(200);
    setTutorRuntimeDepsForTests({ ...baseDeps, workerId: OTHER_WORKER });
    const theirsResponse = await send(theirs, { clientMessageId: 'cm-1', text: 'س' });
    expect(theirsResponse.status).toBe(200);
    setTutorRuntimeDepsForTests(baseDeps);

    const mineRow = (await readMessageByClientId(pool, mine, 'cm-1'))!;
    const theirsRow = (await readMessageByClientId(pool, theirs, 'cm-1'))!;
    expect([mineRow.status, theirsRow.status]).toEqual(['generating', 'generating']);

    const { inFlightTurnIds, markInFlightTurnsStale } =
      await import('@/lib/server/tutor/turn-progress');
    expect(inFlightTurnIds()).toEqual(expect.arrayContaining([mineRow.id, theirsRow.id]));

    t = T0_MS + 3_000;
    const result = await markInFlightTurnsStale({ workerId: WORKER, now });
    expect(result).toEqual({ marked: 1, timedOut: false });

    expect((await readMessageByClientId(pool, mine, 'cm-1'))!).toMatchObject({
      status: 'failed',
      errorCode: 'TURN_STALE',
      completedAt: T0_S + 3,
    });
    expect((await readMessageByClientId(pool, theirs, 'cm-1'))!).toMatchObject({
      status: 'generating',
      errorCode: null,
    });
    expect(inFlightTurnIds()).not.toContain(mineRow.id);
    expect(inFlightTurnIds()).toContain(theirsRow.id);

    // A marked turn is retried at once (failed → turn_attempt + 1), no 409.
    mocks.streamLLM.mockImplementationOnce(() => textStream('نجح'));
    const retried = await send(mine, { clientMessageId: 'cm-1', text: 'س' });
    expect(retried.status).toBe(200);

    gateTheirs.release();
    await readSse(theirsResponse);
    await readSse(retried);
    gateMine.release();
    await readSse(mineResponse);
  });

  it('SIGTERM marking never throws and is bounded when the database is down or hangs', async () => {
    const { markInFlightTurnsStale, startTurnProgress } =
      await import('@/lib/server/tutor/turn-progress');
    const failing = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const hanging = { query: vi.fn(() => new Promise<never>(() => {})) };

    // The initial progress write fails too: `ready` still resolves (no throw).
    const down = startTurnProgress({
      pool: failing,
      kind: 'conversation',
      messageId: 'msg-down',
      turnAttempt: 1,
      workerId: 'host:9:down',
      now,
    });
    await expect(down.ready).resolves.toBeUndefined();
    await expect(markInFlightTurnsStale({ workerId: 'host:9:down', now })).resolves.toEqual({
      marked: 0,
      timedOut: false,
    });
    down.stop();

    const hang = startTurnProgress({
      pool: hanging,
      kind: 'conversation',
      messageId: 'msg-hang',
      turnAttempt: 1,
      workerId: 'host:9:hang',
      now,
      intervalMs: 60_000,
    });
    const started = Date.now();
    await expect(
      markInFlightTurnsStale({ workerId: 'host:9:hang', now, timeoutMs: 50 }),
    ).resolves.toEqual({ marked: 0, timedOut: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    hang.stop();
  });
});
