import { APICallError } from 'ai';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFinalize } from '@/lib/persistence/meter-finalize-outbox';
import { readAttempt, type TeachingModelAttemptRow } from '@/lib/persistence/teaching-model-attempts';
import {
  readConversation,
  readMessageByClientId,
  readMessagesBySeq,
  readTurnGrounding,
  updateConversationLessonAssociation,
} from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { SAFETY_BOUNDARY_MESSAGE } from '@/lib/server/tutor/experiment-guard';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';
import { countTokens, effectiveCap } from '@/lib/server/tutor/token-budget';

import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  ok,
  OTHER_STUDENT_REF,
  readSse,
  RecordingPool,
  STUDENT_REF,
  streamOf,
  studentBearer,
  SUBJECTS,
  T0_MS,
  textStream,
  type FakeKafuo,
} from './tutor-test-harness';

/**
 * Free Chat routes (contracts §0 H2, §5; plan P6 tests). PGlite + mocked
 * `@/lib/ai/llm` (the EXACT provider request is captured) + a fake Kafuo
 * client. The spy ORDER test pins: assemble → reserve → started row → model
 * → completion transaction → commit → inline finalize.
 */

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  events: [] as string[],
  assembled: [] as Array<{ messages: unknown[]; budget: { estimate: number; counterKind: 'exact' | 'proxy'; effectiveCap: number } }>,
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

vi.mock('@/lib/server/tutor/prompt-assembly', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/tutor/prompt-assembly')>();
  return {
    ...actual,
    assembleTutorPrompt: (input: Parameters<typeof actual.assembleTutorPrompt>[0]) => {
      mocks.events.push('assemble');
      const result = actual.assembleTutorPrompt(input);
      mocks.assembled.push(result);
      return result;
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const SERVICE_KEY = 'conversation-routes-svc-key';
let t = T0_MS;
const now = () => t;

function apiError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.example',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

async function routes() {
  return {
    list: (await import('@/app/api/tutor/conversations/route')),
    one: (await import('@/app/api/tutor/conversations/[id]/route')),
    messages: (await import('@/app/api/tutor/conversations/[id]/messages/route')),
    archive: (await import('@/app/api/tutor/conversations/[id]/archive/route')),
    unarchive: (await import('@/app/api/tutor/conversations/[id]/unarchive/route')),
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

describe('Free Chat conversation routes', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let ids: number;

  async function createConversation(auth = studentBearer(), subjectCode = 'MATH', clientRequestId = 'cr-1') {
    const r = await routes();
    const response = await r.list.POST(request('/api/tutor/conversations', { method: 'POST', auth, body: { subjectCode, clientRequestId } }));
    return { response, json: (await response.json()) as { conversation: { id: string } } };
  }

  async function send(conversationId: string, body: Record<string, unknown>, auth = studentBearer()) {
    const r = await routes();
    return r.messages.POST(request(`/api/tutor/conversations/${conversationId}/messages`, { method: 'POST', auth, body }), params(conversationId));
  }

  const turnRows = async (turnId: string, stage = 'free-chat-turn') => {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM teaching_model_attempts WHERE turn_id = $1 AND stage = $2 ORDER BY attempt_index`,
      [turnId, stage],
    );
    const rows: TeachingModelAttemptRow[] = [];
    for (const row of result.rows) rows.push((await readAttempt(pool, row.id))!);
    return rows;
  };

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://conversation-routes-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    mocks.assembled.length = 0;
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    t = T0_MS;
    ids = 0;
    pool = await createTutorPool(mocks.events);
    mocks.events.length = 0;
    kafuo = fakeKafuo(mocks.events);
    // Titles: one successful topic call by default.
    mocks.callLLM.mockImplementation(async () => ok('التبرير الاستقرائي'));
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now,
      workerId: 'host:1:test',
      idFactory: () => `id-${++ids}`,
      executor: { rateCard: BASE_RATE_CARD, completionRetryDelaysMs: [0, 0, 0], idFactory: () => `tma-${++ids}` },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
    });
  });

  afterEach(async () => {
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  describe('create / list / read / archive', () => {
    it('answers 404 when the Teaching Package API is off and 401 without a grant', async () => {
      const r = await routes();
      vi.stubEnv('DATABASE_URL', '');
      expect((await r.list.GET(request('/api/tutor/conversations', { auth: studentBearer() }))).status).toBe(404);
      vi.stubEnv('DATABASE_URL', 'postgres://conversation-routes-test');
      expect((await r.list.GET(request('/api/tutor/conversations'))).status).toBe(401);
    });

    it('creates a conversation pinned to a granted subject (201), replays the clientRequestId (200)', async () => {
      const first = await createConversation();
      expect(first.response.status).toBe(201);
      expect(first.json.conversation).toMatchObject({
        subjectCode: 'MATH',
        subjectName: 'الرياضيات',
        status: 'active',
        titleSource: 'pending',
        messageCount: 0,
        academic: { curriculumName: 'المنهج الوطني', academicLanguage: 'ar', subjectNameEn: 'Mathematics' },
      });
      const replay = await createConversation();
      expect(replay.response.status).toBe(200);
      expect(replay.json.conversation.id).toBe(first.json.conversation.id);
    });

    it('refuses a subject outside the grant (403 SUBJECT_NOT_ALLOWED) and an unrouted one (422)', async () => {
      const denied = await createConversation(studentBearer(), 'PHYSICS');
      expect(denied.response.status).toBe(403);
      expect(denied.json).toMatchObject({ error: { code: 'SUBJECT_NOT_ALLOWED', retryable: false } });
      const unrouted = await createConversation(
        studentBearer({ subjects: [{ code: 'FRENCH', offeringId: '9', nameAr: 'فرنسي', nameEn: 'French', academicLanguage: 'en' }] }),
        'FRENCH',
      );
      expect(unrouted.response.status).toBe(403);
      // Redeem already dropped the unrouted code, so the grant refuses it; a
      // code that survives the grant but cannot resolve is SUBJECT_ROUTE_UNAVAILABLE.
      const { createConversation: create } = await import('@/lib/server/tutor/conversation-service');
      const { resolveTutorRuntimeDeps } = await import('@/lib/server/tutor/runtime-deps');
      const { verifyStudentGrant } = await import('@/lib/server/tutor/student-grant');
      const grant = verifyStudentGrant(studentBearer());
      grant.allowedSubjects.push({ code: 'FRENCH', offeringId: '9', nameAr: 'فرنسي', nameEn: 'French', academicLanguage: 'en' });
      await expect(create(await resolveTutorRuntimeDeps(), { grant, subjectCode: 'FRENCH', clientRequestId: 'x' })).rejects.toMatchObject({
        code: 'SUBJECT_ROUTE_UNAVAILABLE',
      });
    });

    it('lists only the owner\'s conversations and reads by id with ownership (404 for another student)', async () => {
      const r = await routes();
      const { json } = await createConversation();
      const mine = await r.list.GET(request('/api/tutor/conversations?status=active', { auth: studentBearer() }));
      expect((await mine.json()).items.map((c: { id: string }) => c.id)).toEqual([json.conversation.id]);
      const theirs = await r.list.GET(request('/api/tutor/conversations', { auth: studentBearer({ studentRef: OTHER_STUDENT_REF }) }));
      expect((await theirs.json()).items).toEqual([]);
      const read = await r.one.GET(request(`/api/tutor/conversations/${json.conversation.id}`, { auth: studentBearer() }), params(json.conversation.id));
      expect(read.status).toBe(200);
      await expect(read.json()).resolves.toMatchObject({ conversation: { id: json.conversation.id }, messages: [], hasMore: false });
      const foreign = await r.one.GET(
        request(`/api/tutor/conversations/${json.conversation.id}`, { auth: studentBearer({ studentRef: OTHER_STUDENT_REF }) }),
        params(json.conversation.id),
      );
      expect(foreign.status).toBe(404);
      await expect(foreign.json()).resolves.toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
    });

    it('archives and unarchives under ownership', async () => {
      const r = await routes();
      const { json } = await createConversation();
      const archived = await r.archive.POST(request(`/api/tutor/conversations/${json.conversation.id}/archive`, { method: 'POST', auth: studentBearer() }), params(json.conversation.id));
      await expect(archived.json()).resolves.toMatchObject({ conversation: { status: 'archived' } });
      const foreign = await r.unarchive.POST(
        request(`/api/tutor/conversations/${json.conversation.id}/unarchive`, { method: 'POST', auth: studentBearer({ studentRef: OTHER_STUDENT_REF }) }),
        params(json.conversation.id),
      );
      expect(foreign.status).toBe(404);
      const restored = await r.unarchive.POST(request(`/api/tutor/conversations/${json.conversation.id}/unarchive`, { method: 'POST', auth: studentBearer() }), params(json.conversation.id));
      await expect(restored.json()).resolves.toMatchObject({ conversation: { status: 'active' } });
    });
  });

  describe('POST /messages — the turn', () => {
    it('streams a turn in the spy ORDER assemble → reserve → started row → model → completion tx → commit → finalize; title follows done', async () => {
      const { json } = await createConversation();
      mocks.streamLLM.mockImplementationOnce(() => {
        mocks.events.push('model');
        return textStream('الجواب هو ٤.');
      });
      const response = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ما هو التبرير الاستقرائي؟' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const frames = await readSse(response);
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done', 'title']);
      expect(frames[1]!.data).toEqual({ mode: 'none' });
      expect(frames[3]!.data).toMatchObject({ servedBy: 'primary', accountingComplete: true, safety: { triggered: false } });
      expect(frames[4]!.data).toEqual({ title: 'التبرير الاستقرائي' });

      // The idempotent turn insert is its own transaction before the pipeline starts.
      const order = mocks.events.filter((e) => !e.startsWith('tx:begin'));
      expect(order.slice(order.indexOf('assemble'), order.indexOf('kafuo:finalize') + 1)).toEqual([
        'assemble',
        'kafuo:reserve',
        'ledger:insert',
        'model',
        'ledger:update',
        'outbox:insert',
        'tx:commit',
        'kafuo:finalize',
      ]);
      // The completion transaction wrote the tutor message + ledger completion + outbox row together.
      const student = (await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!;
      expect(student).toMatchObject({ status: 'completed', turnAttempt: 1, accountingComplete: true, meterReservationId: 'res-1' });
      const { messages } = await readMessagesBySeq(pool, { parentId: json.conversation.id, limit: 10 });
      expect(messages.map((m) => [m.role, m.status])).toEqual([['student', 'completed'], ['tutor', 'completed']]);
      expect(messages[1]).toMatchObject({ text: 'الجواب هو ٤.', servedBy: 'primary', groundingMode: 'none', turnId: student.turnId });
      const [row] = await turnRows(student.turnId);
      expect(row).toMatchObject({ accounting_status: 'complete', outcome: 'succeeded', capability: 'free_chat', origin: 'openmaic_runtime', conversation_id: json.conversation.id, student_ref: STUDENT_REF });
      const finalize = await readFinalize(pool, 'res-1');
      expect(finalize).toMatchObject({ status: 'delivered', outcome: 'delivered', reason: null, turn_id: student.turnId, turn_attempt: 1 });
      expect(kafuo.finalize).toHaveBeenCalledTimes(1);
      expect(kafuo.reserve.mock.calls[0]![0]).toMatchObject({ capability: 'free_chat', meterScope: { conversationId: json.conversation.id }, turnId: student.turnId, turnAttempt: 1, clientMessageId: 'cm-1' });
      const grounding = await readTurnGrounding(pool, student.turnId);
      expect(grounding).toMatchObject({ mode: 'none', conversationId: json.conversation.id, budgetCounterKind: 'proxy' });
      // Budget assertion on the captured messages: the exact request handed to streamLLM.
      const sent = mocks.streamLLM.mock.calls[0]![0].messages;
      expect(sent).toEqual(mocks.assembled[0]!.messages);
      expect(countTokens(sent, 'proxy', 'qwen:qwen3.7-flash')).toBeLessThanOrEqual(effectiveCap('proxy'));
      expect(countTokens(sent, 'exact', 'openai:gpt-5-nano')).toBeLessThanOrEqual(effectiveCap('exact'));
      // The title landed and the conversation counts both messages.
      const conversation = (await readConversation(pool, json.conversation.id))!;
      expect(conversation).toMatchObject({ title: 'التبرير الاستقرائي', titleSource: 'topic', messageCount: 2 });
      expect(mocks.callLLM.mock.calls[0]![1]).toBe('free-chat-title');
    });

    it('replays a completed turn idempotently without any model call or reservation', async () => {
      const { json } = await createConversation();
      mocks.streamLLM.mockImplementationOnce(() => textStream('الجواب.'));
      await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      mocks.events.length = 0;
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'text_delta', 'done']);
      expect(frames[1]!.data).toEqual({ delta: 'الجواب.' });
      expect(mocks.events.filter((e) => !e.startsWith('tx:'))).toEqual([]);
      expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
      // A different text under the same clientMessageId is a conflict.
      const conflict = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'نص آخر' });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    });

    it('answers 409 TURN_IN_PROGRESS with Retry-After while the same turn is generating', async () => {
      const { json } = await createConversation();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.streamLLM.mockImplementationOnce(() =>
        streamOf([]) && {
          fullStream: (async function* () {
            await gate;
            yield { type: 'text-delta', text: 'تم' };
            yield { type: 'finish', finishReason: 'stop' };
          })(),
          totalUsage: Promise.resolve(undefined),
        },
      );
      const first = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' });
      expect(first.status).toBe(200);
      t += 5_000;
      const second = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' });
      expect(second.status).toBe(409);
      expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
      await expect(second.json()).resolves.toMatchObject({ error: { code: 'TURN_IN_PROGRESS', retryable: true } });
      release();
      await readSse(first);
    });

    it('a failed turn is retried under the same turn_id with turn_attempt + 1; the reservation key changes', async () => {
      const { json } = await createConversation();
      mocks.streamLLM
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(503) }]))
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(502) }]))
        .mockImplementationOnce(() => textStream('نجح'));
      const failed = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      expect(failed.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'error']);
      expect(failed[2]!.data).toEqual({ code: 'TEACHING_MODEL_UNAVAILABLE', retryable: true });
      const afterFailure = (await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!;
      expect(afterFailure).toMatchObject({ status: 'failed', errorCode: 'TEACHING_MODEL_UNAVAILABLE', turnAttempt: 1 });
      // Both ledger rows completed in the turn transaction; outbox says not_delivered.
      const rows = await turnRows(afterFailure.turnId);
      expect(rows.map((r) => [r.role, r.outcome, r.accounting_status])).toEqual([
        ['primary', 'provider_error', 'complete'],
        ['fallback', 'provider_error', 'complete'],
      ]);
      expect(await readFinalize(pool, 'res-1')).toMatchObject({ outcome: 'not_delivered', reason: 'model_unavailable', status: 'delivered' });

      const retried = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      expect(retried.map((f) => f.event)).toContain('done');
      const afterRetry = (await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!;
      expect(afterRetry).toMatchObject({ status: 'completed', turnId: afterFailure.turnId, turnAttempt: 2 });
      expect(kafuo.reserve.mock.calls.map((c) => [c[0].turnId, c[0].turnAttempt])).toEqual([
        [afterFailure.turnId, 1],
        [afterFailure.turnId, 2],
      ]);
      expect(await readFinalize(pool, 'res-2')).toMatchObject({ outcome: 'delivered', turn_attempt: 2 });
    });

    it('meter refused → 429 ALLOWANCE_EXHAUSTED, no model call, no ledger row', async () => {
      const { json } = await createConversation();
      kafuo.reserve.mockResolvedValueOnce({ allowed: false, reason: 'tutor_allowance_exhausted', window: 'half_month', resetAt: '2026-10-01T00:00:00+03:00', replay: false });
      const response = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' });
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'ALLOWANCE_EXHAUSTED', retryable: false, details: { window: 'half_month', resetAt: '2026-10-01T00:00:00+03:00' } },
      });
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(mocks.events).not.toContain('ledger:insert');
      expect((await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!.status).toBe('failed');
    });

    it('Kafuo unreachable at reserve → 503 METER_UNAVAILABLE, no model call', async () => {
      const { json } = await createConversation();
      const { KafuoUnreachableError } = await import('@/lib/server/tutor/kafuo-integration-client');
      kafuo.reserve.mockRejectedValueOnce(new KafuoUnreachableError('down'));
      const response = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'METER_UNAVAILABLE', retryable: true } });
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(mocks.events).not.toContain('ledger:insert');
    });

    it('REQUEST_TOO_LARGE (422) makes no reservation and no model call', async () => {
      const { json } = await createConversation();
      const response = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ن'.repeat(4_001) });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } });
      expect(kafuo.reserve).not.toHaveBeenCalled();
      expect(mocks.streamLLM).not.toHaveBeenCalled();
    });

    it('resume re-validates the pinned subject under the current grant on send only (403 SUBJECT_NO_LONGER_AVAILABLE)', async () => {
      const r = await routes();
      const { json } = await createConversation();
      const narrower = studentBearer({ subjects: [SUBJECTS[1]!] });
      const read = await r.one.GET(request(`/api/tutor/conversations/${json.conversation.id}`, { auth: narrower }), params(json.conversation.id));
      expect(read.status).toBe(200);
      const response = await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }, narrower);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SUBJECT_NO_LONGER_AVAILABLE' } });
      expect(kafuo.reserve).not.toHaveBeenCalled();
    });

    it('primary failure after deltas → restart, fallback serves; two ledger rows; delivered', async () => {
      const { json } = await createConversation();
      mocks.streamLLM
        .mockImplementationOnce(() => streamOf([{ type: 'text-delta', text: 'بداية' }, { type: 'error', error: apiError(500) }]))
        .mockImplementationOnce(() => textStream('كامل'));
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'restart', 'text_delta', 'done', 'title']);
      expect(frames[3]!.data).toEqual({ servedBy: 'fallback' });
      expect(frames[5]!.data).toMatchObject({ servedBy: 'fallback' });
      const student = (await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!;
      const rows = await turnRows(student.turnId);
      expect(rows.map((r) => [r.role, r.outcome, r.fallback_triggered])).toEqual([
        ['primary', 'provider_error', true],
        ['fallback', 'succeeded', false],
      ]);
      expect(rows[1]!.primary_failure_ms).not.toBeNull();
      const { messages } = await readMessagesBySeq(pool, { parentId: json.conversation.id, limit: 10 });
      expect(messages.filter((m) => m.role === 'tutor')).toHaveLength(1);
      expect(messages[1]).toMatchObject({ text: 'كامل', servedBy: 'fallback' });
    });

    it('safety: the pre-check adds the directive; a violating reply is replaced by the boundary and finalized as delivered/safety_boundary', async () => {
      const { json } = await createConversation(studentBearer(), 'CHEMISTRY', 'cr-chem');
      mocks.streamLLM.mockImplementationOnce(() =>
        textStream('الخطوة 1: اخلط الكلور مع الأمونيا في وعاء.\nالخطوة 2: سخن الخليط على النار.'),
      );
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ممكن أخلط الكلور مع الأمونيا في البيت؟' }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'restart', 'text_delta', 'done', 'title']);
      expect(frames[4]!.data).toEqual({ delta: SAFETY_BOUNDARY_MESSAGE });
      expect(frames[5]!.data).toMatchObject({
        servedBy: 'primary',
        safety: { triggered: true, category: 'chemicals_fumes_mixing', boundary: true, code: 'SAFETY_BOUNDARY', reason: 'operational_sequence' },
      });
      // The directive reached the model, right before the student message.
      const sent = mocks.streamLLM.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;
      expect(sent[sent.length - 2]!.content).toContain('SAFETY DIRECTIVE');
      const student = (await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!;
      const { messages } = await readMessagesBySeq(pool, { parentId: json.conversation.id, limit: 10 });
      expect(messages[1]).toMatchObject({ text: SAFETY_BOUNDARY_MESSAGE, safety: { boundary: true } });
      // Ledger outcome stays the model's; metering counts it as delivered (L1).
      expect((await turnRows(student.turnId))[0]!.outcome).toBe('succeeded');
      expect(await readFinalize(pool, 'res-1')).toMatchObject({ outcome: 'delivered', reason: 'safety_boundary' });
    });

    it('ledger started-row failure → ACCOUNTING_UNAVAILABLE after the reservation, not_delivered outbox row', async () => {
      const { json } = await createConversation();
      pool.failInsert = true;
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      expect(frames[2]!.data).toEqual({ code: 'ACCOUNTING_UNAVAILABLE', retryable: true });
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(await readFinalize(pool, 'res-1')).toMatchObject({ outcome: 'not_delivered', reason: 'internal_error' });
      expect((await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!.status).toBe('failed');
    });

    it('retrieves only on a retrieve decision, snapshots the units, associates the lesson above the threshold and titles from it', async () => {
      const { json } = await createConversation();
      kafuo.groundingSearch.mockResolvedValueOnce({
        units: [
          { contentUnitId: 'cu-1', lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', unitTitle: 'المتفاعلات والنواتج', text: 'كتلة المتفاعلات تساوي كتلة النواتج في التفاعل الكيميائي.', charLength: 60, score: 0.9 },
          { contentUnitId: 'cu-2', lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', unitTitle: 'مثال', text: 'مثال: احتراق الماغنسيوم.', charLength: 25, score: 0.6 },
        ],
        lessonMatch: { lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.7 },
        truncated: false,
      });
      mocks.streamLLM.mockImplementation(() => textStream('شرح.'));
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ما تعريف قانون حفظ الكتلة في الدرس؟' }));
      expect(frames[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'قانون حفظ الكتلة' });
      expect(kafuo.groundingSearch).toHaveBeenCalledTimes(1);
      expect(kafuo.groundingSearch.mock.calls[0]![0]).toMatchObject({ tenantId: '1', studentRef: STUDENT_REF, subjectOfferingId: '10', maxChars: 10_000 });
      const sent = mocks.streamLLM.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;
      expect(sent[2]!.content).toContain('### المتفاعلات والنواتج');
      expect(sent[2]!.content).not.toContain('cu-1');
      const conversation = (await readConversation(pool, json.conversation.id))!;
      expect(conversation.grounding).toMatchObject({ setAtSeq: 1, lastUsedSeq: 1, units: [{ unitId: 'cu-1' }, { unitId: 'cu-2' }] });
      expect(conversation.lessonAssociation).toMatchObject({ learningItemId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.7 });
      expect(conversation).toMatchObject({ title: 'قانون حفظ الكتلة', titleSource: 'lesson' });
      expect(frames[frames.length - 1]!.data).toEqual({ title: 'قانون حفظ الكتلة' });
      const student = (await readMessageByClientId(pool, json.conversation.id, 'cm-1'))!;
      const unitChars = 'كتلة المتفاعلات تساوي كتلة النواتج في التفاعل الكيميائي.'.length + 'مثال: احتراق الماغنسيوم.'.length;
      expect(await readTurnGrounding(pool, student.turnId)).toMatchObject({ mode: 'retrieved', totalChars: unitChars, units: [{ unitId: 'cu-1', orderIndex: 0 }, { unitId: 'cu-2', orderIndex: 1 }] });

      // A continuation reuses the snapshot without another search.
      const follow = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-2', text: 'ليه؟' }));
      expect(follow[1]!.data).toEqual({ mode: 'reuse', lessonTitle: 'قانون حفظ الكتلة' });
      expect(kafuo.groundingSearch).toHaveBeenCalledTimes(1);
      expect((await readConversation(pool, json.conversation.id))!.grounding).toMatchObject({ lastUsedSeq: 3 });
    });

    it('a retrieval that fails or returns nothing yields groundingMode insufficient (never invented evidence)', async () => {
      const { json } = await createConversation();
      const { KafuoUnreachableError } = await import('@/lib/server/tutor/kafuo-integration-client');
      kafuo.groundingSearch.mockRejectedValueOnce(new KafuoUnreachableError('timeout'));
      mocks.streamLLM.mockImplementation(() => textStream('لا أستطيع تأكيد ذلك.'));
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ما تعريف السرعة المتجهة حسب المنهج؟' }));
      expect(frames[1]!.data).toEqual({ mode: 'insufficient' });
      const sent = mocks.streamLLM.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;
      expect(sent[2]!.content).toContain('No curriculum text is available');
    });

    it('applies the per-grant rate limit (429 RATE_LIMITED)', async () => {
      vi.stubEnv('TUTOR_TURNS_PER_MINUTE', '1');
      const { json } = await createConversation();
      mocks.streamLLM.mockImplementation(() => textStream('ج'));
      await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'س' }));
      const limited = await send(json.conversation.id, { clientMessageId: 'cm-2', text: 'س' });
      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } });
    });

    it('a later confident lesson match updates a topic title without touching subject or history', async () => {
      const { json } = await createConversation();
      mocks.streamLLM.mockImplementation(() => textStream('ج'));
      await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ممكن نتكلم عن الرياضيات؟' }));
      expect((await readConversation(pool, json.conversation.id))!).toMatchObject({ titleSource: 'topic' });
      await updateConversationLessonAssociation(pool, json.conversation.id, { learningItemType: 'lesson', learningItemId: 'L9', lessonTitle: 'المتتابعات', confidence: 0.8, associatedAtSeq: 3 }, T0_MS / 1000);
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-2', text: 'كمان' }));
      expect(frames[frames.length - 1]!.data).toEqual({ title: 'المتتابعات' });
      const conversation = (await readConversation(pool, json.conversation.id))!;
      expect(conversation).toMatchObject({ title: 'المتتابعات', titleSource: 'lesson', subjectCode: 'MATH', messageCount: 4 });
    });
  });
});
