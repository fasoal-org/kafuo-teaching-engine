import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFinalize } from '@/lib/persistence/meter-finalize-outbox';
import { readConversation, readMessagesBySeq } from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { signWebhookDelivery } from '@/lib/server/teaching-package/webhook-delivery';
import { KafuoIntegrationClient } from '@/lib/server/tutor/kafuo-integration-client';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';

import { asConnectable, createTutorPool, ok, readSse, RecordingPool, STUDENT_REF, studentBearer, T0_MS, textStream } from './tutor-test-harness';

/**
 * End-to-end Free Chat (plan §11 row "Free Chat", P6 `e2e-free-chat`): the
 * routes, the real `KafuoIntegrationClient` signing against a fake Kafuo
 * integration server on an ephemeral port (which VERIFIES every signature),
 * PGlite, and a mocked LLM. Retrieval happens only on rule hits, the
 * snapshot is reused, the lesson is associated above the threshold, titles
 * land, and every reservation is finalized exactly once.
 */

const mocks = vi.hoisted(() => ({ callLLM: vi.fn(), streamLLM: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return { model: { provider: providerId, modelId }, modelInfo: providers.getModelInfo(providerId, modelId), modelString, providerId, modelId, apiKey: 'k' };
    },
  };
});
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const SERVICE_KEY = 'e2e-svc-key';
const WEBHOOK_SECRET = 'whsec-e2e';

interface FakeKafuoServer {
  server: Server;
  baseUrl: string;
  calls: Array<{ path: string; body: Record<string, unknown>; verified: boolean }>;
  finalizeCounts: Map<string, number>;
  close(): Promise<void>;
}

async function startFakeKafuo(): Promise<FakeKafuoServer> {
  const calls: FakeKafuoServer['calls'] = [];
  const finalizeCounts = new Map<string, number>();
  let reservations = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const timestamp = String(req.headers['x-teaching-engine-timestamp'] ?? '');
      const signature = String(req.headers['x-teaching-engine-signature'] ?? '');
      const verified = signature === signWebhookDelivery(WEBHOOK_SECRET, timestamp, raw);
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = req.url ?? '';
      calls.push({ path, body, verified });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!verified) return json(401, { error: { code: 'invalid_signature' } });
      if (path.endsWith('/meters/reserve')) {
        reservations += 1;
        return json(200, { allowed: true, reservationId: String(1000 + reservations), replay: false, status: { limit: 30, used: reservations, remaining: 30 - reservations, resetAt: '2026-10-01T00:00:00+03:00' } });
      }
      if (path.endsWith('/meters/finalize')) {
        const id = String(body.reservationId);
        finalizeCounts.set(id, (finalizeCounts.get(id) ?? 0) + 1);
        res.writeHead(204);
        return res.end();
      }
      if (path.endsWith('/grounding/search')) {
        return json(200, {
          units: [
            { contentUnitId: 'cu-1', lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', unitTitle: 'المتفاعلات والنواتج', text: 'كتلة المواد المتفاعلة تساوي كتلة المواد الناتجة في أي تفاعل كيميائي.', charLength: 66, score: 0.91 },
            { contentUnitId: 'cu-2', lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', unitTitle: 'تطبيق', text: 'عند احتراق الماغنسيوم تبقى الكتلة الكلية محفوظة.', charLength: 45, score: 0.7 },
          ],
          lessonMatch: { lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.66 },
          truncated: false,
        });
      }
      return json(404, { error: { code: 'unknown_route' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/api/v2/integrations/teaching-engine`,
    calls,
    finalizeCounts,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('Free Chat end to end (routes + real Kafuo client + fake Kafuo server)', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuoServer;
  let ids = 0;

  async function createConversation(subjectCode = 'CHEMISTRY') {
    const { POST } = await import('@/app/api/tutor/conversations/route');
    const response = await POST(new NextRequest('http://localhost/api/tutor/conversations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: studentBearer() }, body: JSON.stringify({ subjectCode, clientRequestId: 'cr-e2e' }) }));
    expect(response.status).toBe(201);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async function turn(conversationId: string, clientMessageId: string, text: string) {
    const { POST } = await import('@/app/api/tutor/conversations/[id]/messages/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tutor/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: studentBearer() }, body: JSON.stringify({ clientMessageId, text, localeHint: 'ar' }) }),
      params(conversationId),
    );
    expect(response.status).toBe(200);
    return readSse(response);
  }

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://e2e-free-chat-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    ids = 0;
    pool = await createTutorPool();
    kafuo = await startFakeKafuo();
    mocks.callLLM.mockImplementation(async () => ok('حفظ الكتلة'));
    mocks.streamLLM.mockImplementation(() => textStream('كتلة المتفاعلات تساوي كتلة النواتج.'));
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: new KafuoIntegrationClient({ baseUrl: kafuo.baseUrl, secret: WEBHOOK_SECRET, timeoutMs: 5_000 }),
      now: () => T0_MS + ids * 1000,
      workerId: 'host:1:e2e',
      idFactory: () => `id-${++ids}`,
      executor: { rateCard: BASE_RATE_CARD, completionRetryDelaysMs: [0, 0, 0], idFactory: () => `tma-${++ids}` },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
    });
  });

  afterEach(async () => {
    setTutorRuntimeDepsForTests(undefined);
    await kafuo.close();
    await pool.end();
  });

  it('retrieves only on rule hits, reuses the snapshot, associates the lesson, titles, and finalizes each reservation exactly once', async () => {
    const conversationId = await createConversation();

    // Turn 1: explicit curriculum signal without grounding → retrieve.
    const first = await turn(conversationId, 'cm-1', 'ما تعريف قانون حفظ الكتلة في الدرس؟');
    expect(first.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done', 'title']);
    expect(first[1]!.data).toEqual({ mode: 'retrieved', lessonTitle: 'قانون حفظ الكتلة' });
    expect(first[4]!.data).toEqual({ title: 'قانون حفظ الكتلة' });
    expect(kafuo.calls.filter((c) => c.path.endsWith('/grounding/search'))).toHaveLength(1);
    expect(kafuo.calls.find((c) => c.path.endsWith('/grounding/search'))!.body).toMatchObject({ tenantId: '1', studentRef: STUDENT_REF, subjectOfferingId: '11', maxChars: 10_000 });

    // Turn 2: continuation → reuse, no search.
    const second = await turn(conversationId, 'cm-2', 'ليه؟ بسّط أكتر');
    expect(second[1]!.data).toEqual({ mode: 'reuse', lessonTitle: 'قانون حفظ الكتلة' });
    expect(kafuo.calls.filter((c) => c.path.endsWith('/grounding/search'))).toHaveLength(1);

    // Turn 3: social → none, still no search.
    const third = await turn(conversationId, 'cm-3', 'شكرا');
    expect(third[1]!.data).toEqual({ mode: 'none' });
    expect(kafuo.calls.filter((c) => c.path.endsWith('/grounding/search'))).toHaveLength(1);

    // Every request to Kafuo carried a valid signature; nothing was refused.
    expect(kafuo.calls.every((c) => c.verified)).toBe(true);
    expect(kafuo.calls.filter((c) => c.path.endsWith('/meters/reserve'))).toHaveLength(3);
    expect(kafuo.calls.filter((c) => c.path.endsWith('/meters/reserve')).map((c) => c.body.turnAttempt)).toEqual([1, 1, 1]);

    // Finalize: exactly once per reservation, outbox rows delivered, messages flagged.
    expect([...kafuo.finalizeCounts.entries()].sort()).toEqual([['1001', 1], ['1002', 1], ['1003', 1]]);
    for (const id of ['1001', '1002', '1003']) {
      expect(await readFinalize(pool, id)).toMatchObject({ status: 'delivered', outcome: 'delivered', attempts: 1 });
    }
    const { messages } = await readMessagesBySeq(pool, { parentId: conversationId, limit: 20 });
    expect(messages.map((m) => [m.role, m.status, m.groundingMode])).toEqual([
      ['student', 'completed', null],
      ['tutor', 'completed', 'retrieved'],
      ['student', 'completed', null],
      ['tutor', 'completed', 'reuse'],
      ['student', 'completed', null],
      ['tutor', 'completed', 'none'],
    ]);
    expect(messages.filter((m) => m.role === 'tutor').every((m) => m.meterFinalized && m.accountingComplete)).toBe(true);

    const conversation = (await readConversation(pool, conversationId))!;
    expect(conversation).toMatchObject({
      title: 'قانون حفظ الكتلة',
      titleSource: 'lesson',
      messageCount: 6,
      lessonAssociation: { learningItemId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.66, associatedAtSeq: 1 },
      grounding: { setAtSeq: 1, lastUsedSeq: 3 },
    });
    expect(conversation.grounding!.units.map((u) => u.unitId)).toEqual(['cu-1', 'cu-2']);

    // The model saw the units by title, never by id; the title call ran once on the lesson path (no topic call needed).
    const firstRequest = mocks.streamLLM.mock.calls[0]![0].messages as Array<{ content: string }>;
    expect(firstRequest[2]!.content).toContain('### المتفاعلات والنواتج');
    expect(firstRequest.map((m) => m.content).join('\n')).not.toMatch(/cu-1|L1|1001/);
    expect(mocks.callLLM).not.toHaveBeenCalled();
    // Turn 2 carried turn 1 as history.
    const secondRequest = mocks.streamLLM.mock.calls[1]![0].messages as Array<{ role: string; content: string }>;
    expect(secondRequest.some((m) => m.role === 'assistant' && m.content === 'كتلة المتفاعلات تساوي كتلة النواتج.')).toBe(true);
  });

  it('a signature the server rejects surfaces as METER_UNAVAILABLE before any model call', async () => {
    const conversationId = await createConversation();
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: new KafuoIntegrationClient({ baseUrl: kafuo.baseUrl, secret: 'wrong-secret', timeoutMs: 5_000 }),
      now: () => T0_MS,
      heartbeatMs: 0,
      executor: { rateCard: BASE_RATE_CARD },
    });
    const { POST } = await import('@/app/api/tutor/conversations/[id]/messages/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tutor/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: studentBearer() }, body: JSON.stringify({ clientMessageId: 'cm-x', text: 'ما هي الكتلة؟' }) }),
      params(conversationId),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'METER_UNAVAILABLE', retryable: true } });
    expect(kafuo.calls.some((c) => !c.verified)).toBe(true);
    expect(mocks.streamLLM).not.toHaveBeenCalled();
  });
});
