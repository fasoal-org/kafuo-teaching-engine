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
import { clarificationText } from '@/lib/server/tutor/grounding/clarification';
import { KafuoIntegrationError } from '@/lib/server/tutor/kafuo-integration-client';
import { setTutorRuntimeDepsForTests, type TutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';
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
import {
  ambiguous,
  candidate,
  EMBEDDING_GROUP,
  fakeGroundingReader,
  found,
  noMatch,
  notReady,
  single,
  unitRow,
  weak,
  type FakeGrounding,
} from './fake-grounding-reader';

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
  let baseDeps: TutorRuntimeDeps;

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
    baseDeps = {
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now,
      workerId: 'host:1:test',
      idFactory: () => `id-${++ids}`,
      executor: { rateCard: BASE_RATE_CARD, completionRetryDelaysMs: [0, 0, 0], idFactory: () => `tma-${++ids}` },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
    };
    setTutorRuntimeDepsForTests(baseDeps);
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
      // kafuo_http writes the rollback-only schema-1 association (a lessons.id, never a learningItemId).
      expect(conversation.lessonAssociation).toEqual({ schema: 1, lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.7, associatedAtSeq: 1 });
      expect(conversation.grounding).toMatchObject({ schema: 2, source: 'kafuo_http', units: [{ source: 'kafuo_http', lessonId: 'L1' }, { source: 'kafuo_http' }] });
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

    it('default config (kafuo_http + r1): the grounding/search request is exactly the pre-P7 body', async () => {
      const { json } = await createConversation();
      kafuo.groundingSearch.mockResolvedValueOnce({
        units: [{ contentUnitId: 'cu-7', lessonId: 'L290', lessonTitle: 'التبرير', unitTitle: 'المفردات', text: 'المثال المضاد يبيّن أن التخمين خاطئ.', charLength: 35, score: 0.8 }],
        lessonMatch: null,
        truncated: false,
      });
      mocks.streamLLM.mockImplementation(() => textStream('شرح.'));
      const first = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'اشرحلي المثال المضاد' }));
      expect(first[1]!.data).toEqual({ mode: 'retrieved' });
      expect(kafuo.groundingSearch.mock.calls[0]![0]).toEqual({
        tenantId: '1',
        studentRef: STUDENT_REF,
        subjectOfferingId: '10',
        query: 'اشرحلي مثال مضاد',
        maxChars: 10_000,
      });
      await readSse(await send(json.conversation.id, { clientMessageId: 'cm-2', text: 'ما تعريف السرعة المتجهة حسب المنهج؟' }));
      expect(kafuo.groundingSearch.mock.calls[1]![0]).toEqual({
        tenantId: '1',
        studentRef: STUDENT_REF,
        subjectOfferingId: '10',
        query: 'تعريف سرعه متجهه حسب منهج',
        maxChars: 10_000,
        preferredContentUnitIds: ['cu-7'],
      });
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
      await updateConversationLessonAssociation(pool, json.conversation.id, { schema: 1, lessonId: 'L9', lessonTitle: 'المتتابعات', confidence: 0.8, associatedAtSeq: 3 }, T0_MS / 1000);
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-2', text: 'كمان' }));
      expect(frames[frames.length - 1]!.data).toEqual({ title: 'المتتابعات' });
      const conversation = (await readConversation(pool, json.conversation.id))!;
      expect(conversation).toMatchObject({ title: 'المتتابعات', titleSource: 'lesson', subjectCode: 'MATH', messageCount: 4 });
    });
  });

  describe('direct grounding through the reader seam (discovery-first P7)', () => {
    let grounding: FakeGrounding;
    const SCOPE = { tenantId: '1', studentRef: STUDENT_REF, subjectOfferingId: '10' };
    const LESSON_155 = candidate('155', 'التبرير والبرهان', 'LESSON', 9);
    const SECTION_612 = candidate('612', 'المثال المضاد', 'SECTION', 8);
    const SAMPLE = 'اشرحلي المثال المضاد';
    const CU_3279 = unitRow('3279', '612', 'المفردات: المثال المضاد مثال واحد يبيّن أن التخمين خاطئ.', {
      itemType: 'SECTION',
      unitTitle: 'المفردات',
      similarity: 0.83,
    });
    const CU_3278 = unitRow('3278', '612', 'إيجاد أمثلة مضادة: المثال الذي ينقض التخمين يُسمى المثال المضاد.', {
      itemType: 'SECTION',
      unitTitle: 'إيجاد أمثلة مضادة',
      similarity: 0.71,
    });
    const CU_5001 = unitRow('5001', '155', 'المتتابعة الحسابية يكون الفرق فيها بين كل حدين متتاليين ثابتًا.', {
      unitTitle: 'المتتابعات',
      similarity: 0.9,
    });

    const sentContent = (call: number) =>
      (mocks.streamLLM.mock.calls[call]![0].messages as Array<{ content: string }>).map((m) => String(m.content));
    const studentOf = async (conversationId: string, clientMessageId: string) =>
      (await readMessageByClientId(pool, conversationId, clientMessageId))!;
    const auditOf = async (conversationId: string, clientMessageId: string) =>
      (await readTurnGrounding(pool, (await studentOf(conversationId, clientMessageId)).turnId))!;

    beforeEach(() => {
      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'direct');
      vi.stubEnv('TUTOR_GROUNDING_DIRECT_TENANTS', '1');
      grounding = fakeGroundingReader(mocks.events);
      setTutorRuntimeDepsForTests({ ...baseDeps, grounding: grounding.deps });
      mocks.streamLLM.mockImplementation(() => {
        mocks.events.push('model');
        return textStream('شرح.');
      });
    });

    it('single → retrieved: association v2 + SECTION title; order resolve → profile → embed → search → assemble → reserve', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279, CU_3278));
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done', 'title']);
      expect(frames[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(frames[4]!.data).toEqual({ title: 'المثال المضاد' });

      const order = mocks.events.filter((e) => !e.startsWith('tx:'));
      expect(order.slice(order.indexOf('reader:resolve'), order.indexOf('model') + 1)).toEqual([
        'reader:resolve',
        'reader:profile',
        'embed',
        'reader:search',
        'assemble',
        'kafuo:reserve',
        'ledger:insert',
        'model',
      ]);
      expect(grounding.mocks.probeItems).not.toHaveBeenCalled();
      expect(kafuo.groundingSearch).not.toHaveBeenCalled();
      expect(grounding.mocks.resolveItems.mock.calls[0]).toEqual([SCOPE, { text: SAMPLE, maxCandidates: 3 }]);
      expect(grounding.mocks.itemEmbeddingProfile.mock.calls[0]).toEqual([SCOPE, { itemIds: ['612'] }]);
      expect(grounding.mocks.embed.mock.calls[0]![0]).toEqual({ ...EMBEDDING_GROUP, text: SAMPLE });
      expect(grounding.mocks.searchUnits.mock.calls[0]![1]).toMatchObject({
        targets: [{ learningItemId: '612', embeddingRunId: 'run-612' }],
        provider: 'openai',
        model: 'text-embedding-3-small',
        limit: 5,
      });

      // The model sees the SECTION header and unit titles, never an id.
      const prompt = sentContent(0);
      expect(prompt[2]).toContain('Section / القسم: المثال المضاد');
      expect(prompt[2]).toContain('### المفردات');
      expect(prompt.join('\n')).not.toMatch(/3279|3278|\b612\b|run-612|b-612|rev-/);

      const conversation = (await readConversation(pool, id))!;
      expect(conversation.lessonAssociation).toEqual({
        schema: 2,
        learningItemType: 'SECTION',
        learningItemId: '612',
        title: 'المثال المضاد',
        confidence: 0.83,
        associatedAtSeq: 1,
        buildId: 'b-612',
      });
      expect(conversation.grounding).toMatchObject({
        schema: 2,
        source: 'direct',
        setAtSeq: 1,
        lastUsedSeq: 1,
        units: [
          { source: 'direct', unitId: '3279', itemId: '612', itemType: 'SECTION', buildId: 'b-612', revisionId: 'rev-3279' },
          { source: 'direct', unitId: '3278', itemId: '612' },
        ],
        items: [{ itemId: '612', itemType: 'SECTION', title: 'المثال المضاد' }],
      });
      expect(conversation).toMatchObject({ title: 'المثال المضاد', titleSource: 'lesson' });
      expect(mocks.callLLM).not.toHaveBeenCalled();

      const audit = await auditOf(id, 'cm-1');
      expect(audit).toMatchObject({
        mode: 'retrieved',
        source: 'direct',
        outcomeReason: null,
        embeddingModel: 'text-embedding-3-small',
        embeddingTokens: 9,
        units: [
          { unitId: '3279', itemId: '612', itemType: 'SECTION', buildId: 'b-612', orderIndex: 0 },
          { unitId: '3278', itemId: '612', orderIndex: 1 },
        ],
        resolution: {
          outcome: 'single',
          candidates: [{ itemId: '612', itemType: 'SECTION', score: 8 }],
          searchedItemIds: ['612'],
          runIds: ['run-612'],
          buildIds: ['b-612'],
          reprofiled: false,
          searchOutcome: 'ok',
          unitCount: 2,
        },
      });
      expect(audit.assessment).toMatchObject({ decision: 'retrieve', rule: 'lesson_discovery', ruleset: 'discovery_v1', source: 'direct', contentKeywordCount: 2 });
      for (const ms of [audit.poolWaitMs, audit.resolveMs, audit.embedMs, audit.searchMs, audit.totalRetrievalMs]) {
        expect(ms).toBeGreaterThanOrEqual(0);
      }
      // RET-07: the resolution audit holds ids, outcomes and scores — no student text, no titles.
      expect(JSON.stringify(audit.resolution)).not.toMatch(/[؀-ۿ]/);
      const delta = await pool.query<{ first_delta_at: number | null }>(
        `SELECT first_delta_at FROM tutor_messages WHERE turn_id = $1 AND role = 'tutor'`,
        [audit.turnId],
      );
      expect(Number(delta.rows[0]!.first_delta_at)).toBe(T0_MS / 1000);
      expect(kafuo.reserve).toHaveBeenCalledTimes(1);
      expect(kafuo.finalize).toHaveBeenCalledTimes(1);
    });

    it('ambiguous → clarification as text_delta: no model call, no meter reserve or finalize (D-8 (a))', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', ambiguous(LESSON_155, SECTION_612));
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done']);
      expect(frames[1]!.data).toEqual({
        mode: 'clarification',
        candidates: [
          { title: 'التبرير والبرهان', itemType: 'LESSON' },
          { title: 'المثال المضاد', itemType: 'SECTION' },
        ],
      });
      const text = (frames[2]!.data as { delta: string }).delta;
      expect(text).toBe(clarificationText(SAMPLE, ['التبرير والبرهان', 'المثال المضاد']));
      expect(text).toContain('1. التبرير والبرهان');
      expect(text).toContain('2. المثال المضاد');
      expect(text).not.toMatch(/155|612/);
      expect(frames[3]!.data).toMatchObject({ servedBy: null, accountingComplete: true, safety: { triggered: false } });

      // D-8 (a): nothing metered, nothing modelled, no embedding.
      expect(kafuo.reserve).not.toHaveBeenCalled();
      expect(kafuo.finalize).not.toHaveBeenCalled();
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(mocks.callLLM).not.toHaveBeenCalled();
      for (const event of ['assemble', 'ledger:insert', 'outbox:insert', 'reader:profile', 'embed', 'reader:search']) {
        expect(mocks.events).not.toContain(event);
      }
      const outbox = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM meter_finalize_outbox`);
      expect(outbox.rows[0]!.n).toBe(0);

      const { messages } = await readMessagesBySeq(pool, { parentId: id, limit: 10 });
      expect(messages.map((m) => [m.role, m.status, m.groundingMode, m.meterReservationId, m.accountingComplete])).toEqual([
        ['student', 'completed', null, null, true],
        ['tutor', 'completed', 'clarification', null, true],
      ]);
      expect(messages[1]!.text).toBe(text);
      const conversation = (await readConversation(pool, id))!;
      expect(conversation.pendingClarification).toEqual({
        candidates: [
          { itemId: '155', itemType: 'LESSON', title: 'التبرير والبرهان' },
          { itemId: '612', itemType: 'SECTION', title: 'المثال المضاد' },
        ],
        questionSeq: 1,
        askedAtSeq: 2,
      });
      expect(conversation).toMatchObject({ lessonAssociation: null, grounding: null, messageCount: 2, titleSource: 'pending' });
      expect(await auditOf(id, 'cm-1')).toMatchObject({
        mode: 'clarification',
        source: 'direct',
        outcomeReason: 'clarification',
        units: [],
        totalChars: 0,
        inputTokenEstimate: 0,
        resolution: { outcome: 'ambiguous' },
      });
    });

    it('weak (lexical fallback) → a one-topic clarification', async () => {
      const { json } = await createConversation();
      grounding.queue('resolveItems', weak(SECTION_612));
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ما معنى "النقض بالمثال" هنا؟' }));
      expect(frames[1]!.data).toEqual({ mode: 'clarification', candidates: [{ title: 'المثال المضاد', itemType: 'SECTION' }] });
      expect((frames[2]!.data as { delta: string }).delta).toContain('«المثال المضاد»');
      expect(kafuo.reserve).not.toHaveBeenCalled();
    });

    it('a completed clarification replays its stored text; a follow-up by ordinal retrieves the chosen item with the ORIGINAL question', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', ambiguous(LESSON_155, SECTION_612));
      const asked = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      const text = (asked[2]!.data as { delta: string }).delta;

      const replay = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(replay.map((f) => f.event)).toEqual(['turn_start', 'text_delta', 'done']);
      expect(replay[1]!.data).toEqual({ delta: text });
      expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(1);
      expect(kafuo.reserve).not.toHaveBeenCalled();

      grounding.queue('searchUnits', found(CU_3279));
      const follow = await readSse(await send(id, { clientMessageId: 'cm-2', text: '٢' }));
      expect(follow.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done', 'title']);
      expect(follow[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(1);
      expect(grounding.mocks.itemEmbeddingProfile.mock.calls[0]![1]).toEqual({ itemIds: ['612'] });
      expect(grounding.mocks.embed.mock.calls[0]![0].text).toBe(SAMPLE);
      expect(kafuo.reserve).toHaveBeenCalledTimes(1);
      const conversation = (await readConversation(pool, id))!;
      expect(conversation.pendingClarification).toBeNull();
      expect(conversation.lessonAssociation).toMatchObject({ schema: 2, learningItemType: 'SECTION', learningItemId: '612', associatedAtSeq: 3 });
      expect(conversation).toMatchObject({ title: 'المثال المضاد', titleSource: 'lesson' });
      const audit = await auditOf(id, 'cm-2');
      expect(audit.assessment).toMatchObject({ clarificationChoice: { by: 'ordinal', index: 2, itemId: '612' } });
      expect(audit.resolution).toMatchObject({ outcome: 'single', selection: 'clarification_choice', searchedItemIds: ['612'] });
    });

    it('a title reply chooses too; any other reply clears the pending clarification and is assessed normally', async () => {
      const first = (await createConversation(studentBearer(), 'MATH', 'cr-a')).json.conversation.id;
      grounding.queue('resolveItems', ambiguous(LESSON_155, SECTION_612));
      await readSse(await send(first, { clientMessageId: 'cm-1', text: SAMPLE }));
      grounding.queue('searchUnits', found(CU_5001));
      const byTitle = await readSse(await send(first, { clientMessageId: 'cm-2', text: 'التبرير والبرهان' }));
      expect(byTitle[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'التبرير والبرهان', itemType: 'LESSON' });
      expect((await auditOf(first, 'cm-2')).assessment).toMatchObject({ clarificationChoice: { by: 'title', index: 1 } });

      const second = (await createConversation(studentBearer(), 'MATH', 'cr-b')).json.conversation.id;
      grounding.queue('resolveItems', ambiguous(LESSON_155, SECTION_612));
      await readSse(await send(second, { clientMessageId: 'cm-1', text: SAMPLE }));
      const moved = await readSse(await send(second, { clientMessageId: 'cm-2', text: 'شكرا' }));
      expect(moved[1]!.data).toEqual({ mode: 'none' });
      expect((await readConversation(pool, second))!.pendingClarification).toBeNull();
      expect((await auditOf(second, 'cm-2')).assessment).toMatchObject({ rule: 'social_meta' });
      expect((await auditOf(second, 'cm-2')).assessment).not.toHaveProperty('clarificationChoice');
    });

    it('no_match → insufficient(no_match): coverage stored, no embedding, no profile, no vector search; model still called and metered', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', noMatch('partial'));
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done', 'title']);
      expect(frames[1]!.data).toEqual({ mode: 'insufficient', reason: 'no_match' });
      for (const mock of [grounding.mocks.itemEmbeddingProfile, grounding.mocks.embed, grounding.mocks.searchUnits]) {
        expect(mock).not.toHaveBeenCalled();
      }
      const audit = await auditOf(id, 'cm-1');
      expect(audit).toMatchObject({
        mode: 'insufficient',
        source: 'direct',
        outcomeReason: 'no_match',
        resolution: { outcome: 'no_match', indexCoverage: 'partial' },
        embeddingModel: null,
        embedMs: 0,
        searchMs: 0,
      });
      const prompt = sentContent(0)[2]!;
      expect(prompt).toContain('No curriculum text is available');
      expect(prompt).toContain('general subject knowledge, not the curriculum wording');
      expect(kafuo.reserve).toHaveBeenCalledTimes(1);
      expect(kafuo.finalize).toHaveBeenCalledTimes(1);
      expect((await readConversation(pool, id))!).toMatchObject({ lessonAssociation: null, grounding: null });
    });

    it('index_not_ready → insufficient(index_not_ready): no association, no embedding or search; CTX-05 instruction; reserve/finalize as any model turn', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', notReady(SECTION_612));
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(frames[1]!.data).toEqual({ mode: 'insufficient', reason: 'index_not_ready' });
      const order = mocks.events.filter((e) => !e.startsWith('tx:'));
      expect(order.slice(order.indexOf('reader:resolve'), order.indexOf('model') + 1)).toEqual([
        'reader:resolve',
        'assemble',
        'kafuo:reserve',
        'ledger:insert',
        'model',
      ]);
      expect(sentContent(0)[2]).toContain('general subject knowledge, not the curriculum wording');
      expect(await auditOf(id, 'cm-1')).toMatchObject({
        outcomeReason: 'index_not_ready',
        resolution: { outcome: 'index_not_ready', candidates: [{ itemId: '612', routable: false }] },
      });
      expect((await readConversation(pool, id))!.lessonAssociation).toBeNull();
      expect(kafuo.finalize).toHaveBeenCalledTimes(1);
      expect(await readFinalize(pool, 'res-1')).toMatchObject({ outcome: 'delivered' });
    });

    it('run_superseded twice → one re-profile, no re-embedding, then insufficient(retrieval_unavailable); once → re-profiled and retrieved', async () => {
      const twice = (await createConversation(studentBearer(), 'MATH', 'cr-a')).json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', { outcome: 'run_superseded' }, { outcome: 'run_superseded' });
      const frames = await readSse(await send(twice, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(frames[1]!.data).toEqual({ mode: 'insufficient', reason: 'retrieval_unavailable' });
      expect(grounding.mocks.itemEmbeddingProfile).toHaveBeenCalledTimes(2);
      expect(grounding.mocks.embed).toHaveBeenCalledTimes(1);
      expect(grounding.mocks.searchUnits).toHaveBeenCalledTimes(2);
      expect(await auditOf(twice, 'cm-1')).toMatchObject({
        outcomeReason: 'retrieval_unavailable',
        resolution: { reprofiled: true, searchOutcome: 'run_superseded' },
      });

      grounding.reset();
      const once = (await createConversation(studentBearer(), 'MATH', 'cr-b')).json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', { outcome: 'run_superseded' }, found(CU_3279));
      grounding.queue('itemEmbeddingProfile', (_scope, input) => ({
        outcome: 'ok',
        items: input.itemIds.map((itemId) => ({ outcome: 'ok' as const, learningItemId: itemId, buildId: `b-${itemId}`, embeddingRunId: `run-${itemId}`, ...EMBEDDING_GROUP })),
      }), (_scope, input) => ({
        outcome: 'ok',
        items: input.itemIds.map((itemId) => ({ outcome: 'ok' as const, learningItemId: itemId, buildId: `b-${itemId}`, embeddingRunId: `run-${itemId}-v2`, ...EMBEDDING_GROUP })),
      }));
      const recovered = await readSse(await send(once, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(recovered[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(grounding.mocks.embed).toHaveBeenCalledTimes(1);
      expect(grounding.mocks.searchUnits.mock.calls[1]![1].targets).toEqual([{ learningItemId: '612', embeddingRunId: 'run-612-v2' }]);
    });

    it('retrieval_busy (pool saturated) and a throwing reader → insufficient with their reasons; the model turn is still metered', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', { outcome: 'retrieval_busy' }, new Error('connection reset'));
      const busy = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(busy[1]!.data).toEqual({ mode: 'insufficient', reason: 'retrieval_busy' });
      expect(await auditOf(id, 'cm-1')).toMatchObject({ outcomeReason: 'retrieval_busy' });
      const broken = await readSse(await send(id, { clientMessageId: 'cm-2', text: 'اشرحلي المتتابعات الحسابية والهندسية' }));
      expect(broken[1]!.data).toEqual({ mode: 'insufficient', reason: 'retrieval_unavailable' });
      expect(kafuo.reserve).toHaveBeenCalledTimes(2);
      expect(kafuo.finalize).toHaveBeenCalledTimes(2);
      expect(grounding.mocks.embed).not.toHaveBeenCalled();
    });

    it('D-10 probe: a bare term (none) with a strong match upgrades to retrieve without a second resolve; a failed probe leaves none', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('probeItems', single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279, CU_3278));
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: 'المثال المضاد' }));
      expect(frames[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(grounding.mocks.probeItems.mock.calls[0]).toEqual([SCOPE, { text: 'المثال المضاد' }]);
      expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();
      expect((await auditOf(id, 'cm-1')).assessment).toMatchObject({
        decision: 'none',
        rule: 'default_none',
        effectiveDecision: 'retrieve',
        probe: { outcome: 'single', itemId: '612', upgraded: true },
      });
      expect((await auditOf(id, 'cm-1')).resolution).toMatchObject({ outcome: 'single', via: 'probe' });

      // The same item again: the probe hits the CURRENT item → the reuse stands (revalidated).
      grounding.queue('probeItems', single(SECTION_612));
      const again = await readSse(await send(id, { clientMessageId: 'cm-2', text: 'المثال المضاد' }));
      expect(again[1]!.data).toEqual({ mode: 'reuse', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect((await auditOf(id, 'cm-2')).assessment).toMatchObject({ probe: { upgraded: false }, revalidation: { outcome: 'valid' } });

      const other = (await createConversation(studentBearer(), 'MATH', 'cr-b')).json.conversation.id;
      grounding.queue('probeItems', { outcome: 'retrieval_busy' });
      const stays = await readSse(await send(other, { clientMessageId: 'cm-1', text: 'المثال المضاد' }));
      expect(stays[1]!.data).toEqual({ mode: 'none' });
      expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();
    });

    it('D-17: a reuse turn revalidates once through validate_units; an invalid unit makes the turn retrieve', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279, CU_3278));
      await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));

      const reuse = await readSse(await send(id, { clientMessageId: 'cm-2', text: 'ليه؟' }));
      expect(reuse[1]!.data).toEqual({ mode: 'reuse', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(grounding.mocks.probeItems).not.toHaveBeenCalled();
      expect(grounding.mocks.validateUnits).toHaveBeenCalledTimes(1);
      expect(grounding.mocks.validateUnits.mock.calls[0]).toEqual([
        SCOPE,
        {
          unitRefs: [
            { contentUnitId: '3279', learningItemId: '612', buildId: 'b-612', contentRevisionId: 'rev-3279', unitUpdatedAt: '2026-09-30T10:00:00+00:00' },
            { contentUnitId: '3278', learningItemId: '612', buildId: 'b-612', contentRevisionId: 'rev-3278', unitUpdatedAt: '2026-09-30T10:00:00+00:00' },
          ],
        },
      ]);
      expect(sentContent(1)[2]).toContain('Section / القسم: المثال المضاد');

      grounding.queue('validateUnits', { outcome: 'ok', validUnitIds: ['3279'] });
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279));
      const invalid = await readSse(await send(id, { clientMessageId: 'cm-3', text: 'ليه تاني؟' }));
      expect(invalid[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(2);
      expect((await auditOf(id, 'cm-3')).assessment).toMatchObject({
        decision: 'reuse',
        effectiveDecision: 'retrieve',
        revalidation: { outcome: 'invalid', valid: 1, total: 2 },
      });
      expect((await readConversation(pool, id))!.grounding).toMatchObject({ setAtSeq: 5, units: [{ unitId: '3279' }] });
    });

    it('ambiguous with a strong spread (configured) searches ≤ 3 items in ONE embedding group: grouped prompt, no item title, no association', async () => {
      vi.stubEnv('TUTOR_GROUNDING_AMBIGUOUS_SEARCH_MIN_SCORE', '5');
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', ambiguous(LESSON_155, SECTION_612, candidate('700', 'الاستدلال', 'LESSON', 7)));
      grounding.queue('itemEmbeddingProfile', {
        outcome: 'ok',
        items: [
          { outcome: 'ok', learningItemId: '155', buildId: 'b-155', embeddingRunId: 'run-155', ...EMBEDDING_GROUP },
          { outcome: 'ok', learningItemId: '612', buildId: 'b-612', embeddingRunId: 'run-612', ...EMBEDDING_GROUP },
          { outcome: 'ok', learningItemId: '700', buildId: 'b-700', embeddingRunId: 'run-700', provider: 'openai', model: 'text-embedding-3-large', dims: 8 },
        ],
      });
      grounding.queue('searchUnits', found(CU_5001, CU_3279));
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(frames[1]!.data).toEqual({ mode: 'retrieved' });
      expect(grounding.mocks.searchUnits.mock.calls[0]![1].targets).toEqual([
        { learningItemId: '155', embeddingRunId: 'run-155' },
        { learningItemId: '612', embeddingRunId: 'run-612' },
      ]);
      const prompt = sentContent(0)[2]!;
      expect(prompt).toContain('Lesson / الدرس: التبرير والبرهان');
      expect(prompt).toContain('Section / القسم: المثال المضاد');
      expect(prompt).not.toMatch(/\b155\b|\b612\b|\b700\b/);
      expect((await readConversation(pool, id))!.lessonAssociation).toBeNull();
      expect(await auditOf(id, 'cm-1')).toMatchObject({
        resolution: { outcome: 'ambiguous', searchedItemIds: ['155', '612'], dropped: [{ itemId: '700', reason: 'dropped_incompatible' }] },
      });
    });

    it('the item title is never shown on insufficient or after a topic shift (direct), nor on a non-confident HTTP retrieval', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612), noMatch(), single(LESSON_155));
      grounding.queue('searchUnits', found(CU_3279), found(CU_5001));
      const first = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(first[1]!.data).toMatchObject({ lessonTitle: 'المثال المضاد' });
      const shifted = await readSse(await send(id, { clientMessageId: 'cm-2', text: 'اشرح الدوال الخطية والدوال التربيعية' }));
      expect(shifted[1]!.data).toEqual({ mode: 'insufficient', reason: 'no_match' });
      expect((await auditOf(id, 'cm-2')).assessment).toMatchObject({ rule: 'topic_shift_retrieve' });
      const other = await readSse(await send(id, { clientMessageId: 'cm-3', text: 'ما هي المتتابعات الحسابية والهندسية' }));
      expect(other[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'التبرير والبرهان', itemType: 'LESSON' });
      expect((await readConversation(pool, id))!.lessonAssociation).toMatchObject({ schema: 2, learningItemId: '155', associatedAtSeq: 5 });

      // kafuo_http (F-T3): a later non-confident retrieval no longer repeats the associated lesson's title.
      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'kafuo_http');
      const http = (await createConversation(studentBearer(), 'MATH', 'cr-http')).json.conversation.id;
      kafuo.groundingSearch
        .mockResolvedValueOnce({
          units: [{ contentUnitId: 'cu-1', lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', unitTitle: 'تعريف', text: 'نص', charLength: 3, score: 0.9 }],
          lessonMatch: { lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.8 },
          truncated: false,
        })
        .mockResolvedValueOnce({
          units: [{ contentUnitId: 'cu-9', lessonId: 'L7', lessonTitle: 'الروابط', unitTitle: 'تعريف', text: 'نص آخر', charLength: 6, score: 0.5 }],
          lessonMatch: { lessonId: 'L7', lessonTitle: 'الروابط', confidence: 0.2 },
          truncated: false,
        });
      const confident = await readSse(await send(http, { clientMessageId: 'cm-1', text: 'ما تعريف قانون حفظ الكتلة في الدرس؟' }));
      expect(confident[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'قانون حفظ الكتلة' });
      const unsure = await readSse(await send(http, { clientMessageId: 'cm-2', text: 'اشرح الروابط التساهمية والأيونية' }));
      expect(unsure[1]!.data).toEqual({ mode: 'retrieved' });
    });

    it('rollback flip direct → kafuo_http → direct: v2 kept and still titles; the kafuo_http snapshot is not reused by direct', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279, CU_3278));
      await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      const v2 = (await readConversation(pool, id))!.lessonAssociation;
      expect(v2).toMatchObject({ schema: 2, learningItemId: '612' });

      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'kafuo_http');
      kafuo.groundingSearch.mockResolvedValueOnce({
        units: [{ contentUnitId: 'cu-1', lessonId: '290', lessonTitle: 'قانون حفظ الكتلة', unitTitle: 'تعريف', text: 'كتلة المتفاعلات تساوي كتلة النواتج.', charLength: 34, score: 0.9 }],
        lessonMatch: { lessonId: '290', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.8 },
        truncated: false,
      });
      const http = await readSse(await send(id, { clientMessageId: 'cm-2', text: 'ما تعريف قانون حفظ الكتلة في الدرس؟' }));
      expect(http[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'قانون حفظ الكتلة' });
      expect(kafuo.groundingSearch.mock.calls[0]![0]).toMatchObject({ preferredContentUnitIds: ['3279', '3278'] });
      const afterHttp = (await readConversation(pool, id))!;
      expect(afterHttp.lessonAssociation).toEqual(v2);
      expect(afterHttp.grounding).toMatchObject({ schema: 2, source: 'kafuo_http' });
      expect(afterHttp).toMatchObject({ title: 'المثال المضاد', titleSource: 'lesson' });
      expect((await auditOf(id, 'cm-2'))).toMatchObject({ source: 'kafuo_http' });
      expect((await auditOf(id, 'cm-2')).assessment).toMatchObject({ ruleset: 'r1', source: 'kafuo_http' });

      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'direct');
      grounding.queue('resolveItems', single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279));
      const back = await readSse(await send(id, { clientMessageId: 'cm-3', text: 'ليه؟' }));
      expect(back[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'المثال المضاد', itemType: 'SECTION' });
      expect(grounding.mocks.validateUnits).not.toHaveBeenCalled();
      expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(2);
      expect((await auditOf(id, 'cm-3')).assessment).toMatchObject({ decision: 'reuse', reuse: 'snapshot_not_direct', effectiveDecision: 'retrieve' });
      expect((await readConversation(pool, id))!.grounding).toMatchObject({ source: 'direct' });
    });

    it('a stored association or snapshot in any other shape is ignored (parsed as none) without error', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      await pool.query(
        `UPDATE tutor_conversations SET lesson_association = $2::jsonb, grounding = $3::jsonb WHERE id = $1`,
        [
          id,
          JSON.stringify({ learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'قديم', confidence: 0.9, associatedAtSeq: 1 }),
          JSON.stringify({ units: [{ unitId: 'u-1', lessonId: 'L1', title: 'x', text: 'قديم', chars: 4 }], keywords: ['قديم'], setAtSeq: 1, lastUsedSeq: 1 }),
        ],
      );
      expect((await readConversation(pool, id))!).toMatchObject({ lessonAssociation: null, grounding: null });
      const frames = await readSse(await send(id, { clientMessageId: 'cm-1', text: 'ليه؟' }));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done', 'title']);
      expect(frames[1]!.data).toEqual({ mode: 'none' });
      expect(grounding.mocks.validateUnits).not.toHaveBeenCalled();
      expect((await readConversation(pool, id))!).toMatchObject({ titleSource: 'topic', title: 'التبرير الاستقرائي' });
    });

    it('D-18: a scope refusal from resolve or the probe refuses with SUBJECT_NO_LONGER_AVAILABLE before any reservation; HTTP 403/404 too', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', { outcome: 'offering_not_permitted' });
      const refused = await send(id, { clientMessageId: 'cm-1', text: SAMPLE });
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({ error: { code: 'SUBJECT_NO_LONGER_AVAILABLE' } });
      expect(await studentOf(id, 'cm-1')).toMatchObject({ status: 'failed', errorCode: 'SUBJECT_NO_LONGER_AVAILABLE' });

      grounding.queue('probeItems', { outcome: 'student_ref_unknown' });
      const probed = await send(id, { clientMessageId: 'cm-2', text: 'المثال المضاد' });
      expect(probed.status).toBe(403);
      await expect(probed.json()).resolves.toMatchObject({ error: { code: 'SUBJECT_NO_LONGER_AVAILABLE' } });

      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'kafuo_http');
      kafuo.groundingSearch
        .mockRejectedValueOnce(new KafuoIntegrationError('refused', 403, 'offering_not_permitted'))
        .mockRejectedValueOnce(new KafuoIntegrationError('refused', 404, 'student_ref_unknown'))
        .mockRejectedValueOnce(new KafuoIntegrationError('refused', 422, 'invalid_query'));
      for (const clientMessageId of ['cm-3', 'cm-4']) {
        const response = await send(id, { clientMessageId, text: 'ما تعريف السرعة المتجهة حسب المنهج؟' });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: 'SUBJECT_NO_LONGER_AVAILABLE' } });
      }
      // A contract refusal is not an access loss: still insufficient, as before.
      const contract = await readSse(await send(id, { clientMessageId: 'cm-5', text: 'ما تعريف السرعة المتجهة حسب المنهج؟' }));
      expect(contract[1]!.data).toEqual({ mode: 'insufficient' });
      expect(kafuo.reserve).toHaveBeenCalledTimes(1);
      expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    });

    it('a failed turn retried under turn_attempt + 1 re-runs resolution and retrieval', async () => {
      const { json } = await createConversation();
      const id = json.conversation.id;
      grounding.queue('resolveItems', single(SECTION_612), single(SECTION_612));
      grounding.queue('searchUnits', found(CU_3279), found(CU_3279));
      mocks.streamLLM
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(503) }]))
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(502) }]))
        .mockImplementationOnce(() => textStream('نجح'));
      const failed = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(failed.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'error']);
      const retried = await readSse(await send(id, { clientMessageId: 'cm-1', text: SAMPLE }));
      expect(retried.map((f) => f.event)).toContain('done');
      expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(2);
      expect(grounding.mocks.embed).toHaveBeenCalledTimes(2);
      expect(grounding.mocks.searchUnits).toHaveBeenCalledTimes(2);
      expect(kafuo.reserve.mock.calls.map((c) => c[0].turnAttempt)).toEqual([1, 2]);
      expect(await studentOf(id, 'cm-1')).toMatchObject({ status: 'completed', turnAttempt: 2 });
    });

    it('direct is effective only for allowlisted tenants with a wired reader; otherwise kafuo_http serves the turn', async () => {
      vi.stubEnv('TUTOR_GROUNDING_DIRECT_TENANTS', '2,3');
      const { json } = await createConversation();
      const frames = await readSse(await send(json.conversation.id, { clientMessageId: 'cm-1', text: 'ما تعريف السرعة المتجهة حسب المنهج؟' }));
      expect(frames[1]!.data).toEqual({ mode: 'insufficient' });
      expect(kafuo.groundingSearch).toHaveBeenCalledTimes(1);
      expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();
      expect(await auditOf(json.conversation.id, 'cm-1')).toMatchObject({ source: 'kafuo_http', outcomeReason: 'below_evidence_floor' });

      vi.stubEnv('TUTOR_GROUNDING_DIRECT_TENANTS', '*');
      setTutorRuntimeDepsForTests(baseDeps);
      await readSse(await send(json.conversation.id, { clientMessageId: 'cm-2', text: 'ما تعريف التسارع حسب المنهج؟' }));
      expect(kafuo.groundingSearch).toHaveBeenCalledTimes(2);
      expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();

      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
      await readSse(await send(json.conversation.id, { clientMessageId: 'cm-3', text: 'ما تعريف الكتلة حسب المنهج؟' }));
      expect(kafuo.groundingSearch).toHaveBeenCalledTimes(3);
      expect(await auditOf(json.conversation.id, 'cm-3')).toMatchObject({ source: 'shadow', resolution: { shadow: 'not_available' } });
    });
  });
});
