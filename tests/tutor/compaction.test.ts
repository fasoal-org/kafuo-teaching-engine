import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readAttempt,
  type TeachingModelAttemptRow,
} from '@/lib/persistence/teaching-model-attempts';
import {
  insertStudentMessage,
  insertTutorMessage,
  markMessageCompleted,
  readConversation,
  recordConversationActivity,
} from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { resolveSubjectModelPolicy } from '@/lib/server/teaching-model/resolve-policy';
import {
  COMPACTION_INPUT_TOKEN_CAP,
  COMPACTION_KEEP_RECENT_TURNS,
  COMPACTION_MIN_OLD_TURNS,
  compactConversation,
  isCompactionEnabled,
} from '@/lib/server/tutor/compaction';
import { awaitTutorBackgroundTasks } from '@/lib/server/tutor/conversation-service';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';
import { countTokens } from '@/lib/server/tutor/token-budget';
import { COMPACTION_PROMPT_TEXT, COMPACTION_REQUEST_TEXT } from '@/lib/server/tutor/tutor-rules';

import {
  asConnectable,
  createTutorPool,
  ok,
  readSse,
  RecordingPool,
  studentBearer,
  T0_MS,
  textStream,
  type FakeKafuo,
  fakeKafuo,
} from './tutor-test-harness';

/**
 * Optional compaction (FRD BUD-02, CHAT-03; plan §8.1, §8.5, TD-06, P6/P8
 * leftovers): flag off → never called; flag on → ONE `free-chat-compaction`
 * call through the executor under the subject policy, `context_summary` /
 * `summary_through_seq` written, and never on the request path (the student
 * has `done` before it starts).
 */

const mocks = vi.hoisted(() => ({ callLLM: vi.fn(), streamLLM: vi.fn(), events: [] as string[] }));
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

const SERVICE_KEY = 'compaction-svc-key';
let t = T0_MS;
const now = () => t;

describe('isCompactionEnabled', () => {
  it('is off by default and on only for a truthy flag', () => {
    expect(isCompactionEnabled({})).toBe(false);
    expect(isCompactionEnabled({ TUTOR_COMPACTION_ENABLED: 'false' })).toBe(false);
    expect(isCompactionEnabled({ TUTOR_COMPACTION_ENABLED: '0' })).toBe(false);
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(isCompactionEnabled({ TUTOR_COMPACTION_ENABLED: value })).toBe(true);
    }
  });
});

describe('conversation compaction', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let ids: number;

  async function createConversation() {
    const { POST } = await import('@/app/api/tutor/conversations/route');
    const response = await POST(
      new NextRequest('http://localhost/api/tutor/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: studentBearer() },
        body: JSON.stringify({ subjectCode: 'MATH', clientRequestId: 'cr-compaction' }),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  /** `count` completed turns written straight to the store (seq 1..2·count). */
  async function seedTurns(conversationId: string, count: number) {
    const nowS = T0_MS / 1000;
    for (let i = 1; i <= count; i += 1) {
      const student = (await insertStudentMessage(pool, {
        id: `seed-s-${i}`,
        parentId: conversationId,
        seq: 2 * i - 1,
        clientMessageId: `seed-cm-${i}`,
        turnId: `seed-turn-${i}`,
        text: `سؤال رقم ${i} عن الكسور`,
        now: nowS + i,
      }))!;
      await markMessageCompleted(pool, student.id, { now: nowS + i, accountingComplete: true });
      await insertTutorMessage(pool, {
        id: `seed-t-${i}`,
        parentId: conversationId,
        seq: 2 * i,
        turnId: `seed-turn-${i}`,
        turnAttempt: 1,
        text: `جواب رقم ${i}: البسط فوق والمقام تحت.`,
        servedBy: 'primary',
        groundingMode: 'none',
        accountingComplete: true,
        now: nowS + i,
      });
      await recordConversationActivity(pool, conversationId, {
        messageCountDelta: 2,
        lastMessageAt: nowS + i,
      });
    }
  }

  async function sendTurn(conversationId: string, clientMessageId: string, text: string) {
    const { POST } = await import('@/app/api/tutor/conversations/[id]/messages/route');
    return POST(
      new NextRequest(`http://localhost/api/tutor/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: studentBearer() },
        body: JSON.stringify({ clientMessageId, text }),
      }),
      { params: Promise.resolve({ id: conversationId }) },
    );
  }

  const rowsByStage = async (stage: string) => {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM teaching_model_attempts WHERE stage = $1 ORDER BY attempt_index',
      [stage],
    );
    const rows: TeachingModelAttemptRow[] = [];
    for (const row of result.rows) rows.push((await readAttempt(pool, row.id))!);
    return rows;
  };

  const executorOptions = () => ({
    queryable: pool as never,
    now,
    workerId: 'host:1:test',
    rateCard: BASE_RATE_CARD,
    completionRetryDelaysMs: [0, 0, 0],
    idFactory: () => `tma-${++ids}`,
  });

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://compaction-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    t = T0_MS;
    ids = 0;
    pool = await createTutorPool(mocks.events);
    mocks.events.length = 0;
    kafuo = fakeKafuo(mocks.events);
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now,
      workerId: 'host:1:test',
      idFactory: () => `id-${++ids}`,
      executor: {
        rateCard: BASE_RATE_CARD,
        completionRetryDelaysMs: [0, 0, 0],
        idFactory: () => `tma-${++ids}`,
      },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
    });
  });

  afterEach(async () => {
    await awaitTutorBackgroundTasks();
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  it('flag off: a turn on a long conversation makes no compaction call and writes no summary', async () => {
    const conversationId = await createConversation();
    await seedTurns(conversationId, COMPACTION_MIN_OLD_TURNS + COMPACTION_KEEP_RECENT_TURNS + 2);
    mocks.streamLLM.mockImplementationOnce(() => textStream('الجواب.'));
    mocks.callLLM.mockImplementation(async () => ok('الكسور'));
    const frames = await readSse(await sendTurn(conversationId, 'cm-live', 'وبعدين؟'));
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    await awaitTutorBackgroundTasks();
    expect(mocks.callLLM.mock.calls.map((call) => call[1])).not.toContain('free-chat-compaction');
    expect(await rowsByStage('free-chat-compaction')).toEqual([]);
    expect(await readConversation(pool, conversationId)).toMatchObject({
      contextSummary: null,
      summaryThroughSeq: null,
    });
  });

  it('flag on: exactly one free-chat-compaction call through the executor under the subject policy, after done, never on the request path', async () => {
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'true');
    const conversationId = await createConversation();
    const seeded = COMPACTION_MIN_OLD_TURNS + COMPACTION_KEEP_RECENT_TURNS; // 14 → with the live turn, 9 old + 6 recent
    await seedTurns(conversationId, seeded);
    mocks.streamLLM.mockImplementationOnce(() => textStream('الجواب الحي.'));
    mocks.callLLM.mockImplementation(async (_params: unknown, stage: string) => {
      mocks.events.push(`callLLM:${stage}`);
      return ok(
        stage === 'free-chat-compaction'
          ? 'ملخص: تناولنا الكسور، البسط والمقام، وراجعنا إجابات الطالب.'
          : 'الكسور',
      );
    });
    const frames = await readSse(await sendTurn(conversationId, 'cm-live', 'وبعدين؟'));
    expect(frames.map((f) => f.event)).toEqual([
      'turn_start',
      'grounding',
      'text_delta',
      'done',
      'title',
    ]);
    await awaitTutorBackgroundTasks();

    // One compaction call, and it happened after the turn's finalize (post-`done`, off the request path).
    const compactionCalls = mocks.callLLM.mock.calls.filter(
      (call) => call[1] === 'free-chat-compaction',
    );
    expect(compactionCalls).toHaveLength(1);
    expect(mocks.events.indexOf('callLLM:free-chat-compaction')).toBeGreaterThan(
      mocks.events.indexOf('kafuo:finalize'),
    );
    // The request: the compaction prompt as the rules block, no grounding, the old turns, the request line.
    const params = compactionCalls[0]![0] as { messages: Array<{ role: string; content: string }> };
    expect(params.messages[0]).toEqual({ role: 'system', content: COMPACTION_PROMPT_TEXT });
    expect(params.messages[params.messages.length - 1]).toEqual({
      role: 'user',
      content: COMPACTION_REQUEST_TEXT,
    });
    expect(params.messages.map((m) => m.content).join('\n')).not.toContain('Curriculum grounding');
    expect(countTokens(params.messages, 'exact', 'openai:gpt-5-nano')).toBeLessThanOrEqual(
      COMPACTION_INPUT_TOKEN_CAP,
    );

    // Ledger: one row, capability free_chat, stage free-chat-compaction, the conversation's subject route.
    const policy = await resolveSubjectModelPolicy('MATH');
    const [row] = await rowsByStage('free-chat-compaction');
    expect(row).toMatchObject({
      capability: 'free_chat',
      stage: 'free-chat-compaction',
      origin: 'openmaic_runtime',
      subject_code: 'MATH',
      policy_version: policy.policyVersion,
      model_string: policy.primary.modelString,
      role: 'primary',
      accounting_status: 'complete',
      outcome: 'succeeded',
      conversation_id: conversationId,
    });
    expect(row!.turn_id).toBeTruthy();
    // Written: the summary and the boundary (the reply of the last OLD turn: 9 old turns → seq 18).
    const conversation = (await readConversation(pool, conversationId))!;
    expect(conversation.contextSummary).toBe(
      'ملخص: تناولنا الكسور، البسط والمقام، وراجعنا إجابات الطالب.',
    );
    expect(conversation.summaryThroughSeq).toBe((seeded + 1 - COMPACTION_KEEP_RECENT_TURNS) * 2);
    // Kafuo was reserved/finalized once for the TURN only: compaction is not metered.
    expect(kafuo.reserve).toHaveBeenCalledTimes(1);
    expect(kafuo.finalize).toHaveBeenCalledTimes(1);
  });

  it('compactConversation is a no-op below the minimum of uncompacted old turns and idempotent over a written summary', async () => {
    const conversationId = await createConversation();
    await seedTurns(conversationId, COMPACTION_MIN_OLD_TURNS + COMPACTION_KEEP_RECENT_TURNS - 1);
    const policy = await resolveSubjectModelPolicy('MATH');
    const base = {
      pool: asConnectable(pool),
      conversationId,
      policy,
      academic: null,
      turnId: 'seed-turn-1',
      executor: executorOptions(),
      now: T0_MS / 1000,
    };
    await expect(compactConversation(base)).resolves.toEqual({
      compacted: false,
      summaryThroughSeq: null,
    });
    expect(mocks.callLLM).not.toHaveBeenCalled();
    // One more turn crosses the threshold: compact once, then nothing new to compact.
    const nowS = T0_MS / 1000;
    const student = (await insertStudentMessage(pool, {
      id: 'extra-s',
      parentId: conversationId,
      seq: 27,
      clientMessageId: 'extra',
      turnId: 'extra-turn',
      text: 'سؤال إضافي',
      now: nowS,
    }))!;
    await markMessageCompleted(pool, student.id, { now: nowS, accountingComplete: true });
    await insertTutorMessage(pool, {
      id: 'extra-t',
      parentId: conversationId,
      seq: 28,
      turnId: 'extra-turn',
      turnAttempt: 1,
      text: 'جواب إضافي',
      servedBy: 'primary',
      groundingMode: 'none',
      accountingComplete: true,
      now: nowS,
    });
    mocks.callLLM.mockImplementation(async () => ok('ملخص قصير.'));
    await expect(compactConversation(base)).resolves.toEqual({
      compacted: true,
      summaryThroughSeq: 16,
    });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    await expect(compactConversation(base)).resolves.toEqual({
      compacted: false,
      summaryThroughSeq: 16,
    });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    // A failed model call leaves the stored summary untouched.
    mocks.callLLM.mockImplementation(async () => {
      throw new Error('provider down');
    });
    expect(await readConversation(pool, conversationId)).toMatchObject({
      contextSummary: 'ملخص قصير.',
      summaryThroughSeq: 16,
    });
  });
});
