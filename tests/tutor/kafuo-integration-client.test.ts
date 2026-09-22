import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isKafuoIntegrationConfigured,
  KafuoIntegrationClient,
  KafuoIntegrationError,
  KafuoUnreachableError,
  kafuoIntegrationTimeoutMs,
  type MeterReserveRequest,
} from '@/lib/server/tutor/kafuo-integration-client';
import { signWebhookDelivery } from '@/lib/server/teaching-package/webhook-delivery';

/**
 * OpenMAIC → Kafuo client (contracts §2). The signature is asserted against
 * the Backend's exact scheme computed here from first principles —
 * `v1=hex(hmac-sha256(secret, "<ts>.<body>"))` — not merely against our own
 * helper, so a drift in either direction fails this suite.
 */

const BASE = 'https://kafuo.test/api/v2/integrations/teaching-engine';
const SECRET = 'whsec-client-test';
const NOW_MS = 1_800_000_000_123;

interface Captured {
  url: string;
  init: RequestInit;
}

function stub(answer: (captured: Captured) => Response | Promise<Response> | Error) {
  const captured: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    captured.push(call);
    const result = await answer(call);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof KafuoIntegrationClient>[0]> = {}) {
  return new KafuoIntegrationClient({ baseUrl: BASE, secret: SECRET, fetchImpl, now: () => NOW_MS, ...extra });
}

const RESERVE: MeterReserveRequest = {
  tenantId: '1',
  studentRef: 'abcdefghijklmnopqrstuvwx',
  capability: 'free_chat',
  meterScope: { conversationId: 'conv-1' },
  turnId: 'turn-1',
  turnAttempt: 1,
  clientMessageId: 'cm-1',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('signing (contracts §2)', () => {
  it('signs "<timestamp>.<raw body>" with the shared secret and the webhook header names', async () => {
    const kafuo = stub(() => new Response(null, { status: 204 }));
    await client(kafuo.fetchImpl).finalize({ reservationId: '12345', outcome: 'delivered', reason: null, turnId: 'turn-1' });
    expect(kafuo.captured).toHaveLength(1);
    const { url, init } = kafuo.captured[0]!;
    expect(url).toBe(`${BASE}/meters/finalize`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    // The exact bytes: no re-serialisation between signing and sending.
    expect(body).toBe(JSON.stringify({ reservationId: '12345', outcome: 'delivered', reason: null, turnId: 'turn-1' }));
    const timestamp = headers['X-Teaching-Engine-Timestamp'];
    expect(timestamp).toBe(String(Math.floor(NOW_MS / 1000)));
    // The Backend verifier's scheme, computed independently of our helper.
    const expected = `v1=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
    expect(headers['X-Teaching-Engine-Signature']).toBe(expected);
    // …and identical to what outbound webhooks sign with, so one secret serves both directions.
    expect(headers['X-Teaching-Engine-Signature']).toBe(signWebhookDelivery(SECRET, timestamp, body));
    expect(headers['content-type']).toBe('application/json');
  });

  it('a trailing slash on the base URL is tolerated', async () => {
    const kafuo = stub(() => new Response(null, { status: 204 }));
    await client(kafuo.fetchImpl, { baseUrl: `${BASE}/` }).finalize({ reservationId: '1', outcome: 'delivered', reason: null, turnId: 't' });
    expect(kafuo.captured[0]!.url).toBe(`${BASE}/meters/finalize`);
  });

  it('is unreachable (not silently unsigned) when unconfigured', async () => {
    const kafuo = stub(() => new Response(null, { status: 204 }));
    expect(isKafuoIntegrationConfigured()).toBe(false);
    await expect(
      new KafuoIntegrationClient({ fetchImpl: kafuo.fetchImpl }).finalize({ reservationId: '1', outcome: 'delivered', reason: null, turnId: 't' }),
    ).rejects.toBeInstanceOf(KafuoUnreachableError);
    expect(kafuo.captured).toHaveLength(0);
    vi.stubEnv('KAFUO_INTEGRATION_BASE_URL', `${BASE}/`);
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', SECRET);
    expect(isKafuoIntegrationConfigured()).toBe(true);
    vi.stubEnv('KAFUO_INTEGRATION_TIMEOUT_MS', '2500');
    expect(kafuoIntegrationTimeoutMs()).toBe(2500);
    vi.stubEnv('KAFUO_INTEGRATION_TIMEOUT_MS', 'nope');
    expect(kafuoIntegrationTimeoutMs()).toBe(10_000);
  });
});

describe('reserve (contracts §2.2)', () => {
  it('parses an allowed decision', async () => {
    const kafuo = stub(() =>
      json(200, {
        allowed: true,
        reservationId: 12345,
        replay: false,
        status: { limit: 30, used: 3, remaining: 27, resetAt: '2026-10-01T00:00:00+03:00' },
      }),
    );
    const decision = await client(kafuo.fetchImpl).reserve(RESERVE);
    expect(decision).toEqual({
      allowed: true,
      reservationId: '12345',
      replay: false,
      status: { limit: 30, used: 3, remaining: 27, resetAt: '2026-10-01T00:00:00+03:00' },
    });
    expect(kafuo.captured[0]!.url).toBe(`${BASE}/meters/reserve`);
    expect(JSON.parse(String(kafuo.captured[0]!.init.body))).toEqual(RESERVE);
  });

  it('parses a refusal — the caller makes no model call on it', async () => {
    const kafuo = stub(() =>
      json(200, { allowed: false, reason: 'tutor_allowance_exhausted', window: 'half_month', resetAt: '2026-10-01T00:00:00+03:00', replay: true }),
    );
    const decision = await client(kafuo.fetchImpl).reserve({ ...RESERVE, capability: 'help', meterScope: { helpSessionId: 'hs-1', lessonId: null } });
    expect(decision).toEqual({
      allowed: false,
      reason: 'tutor_allowance_exhausted',
      window: 'half_month',
      resetAt: '2026-10-01T00:00:00+03:00',
      replay: true,
    });
    const unknownReason = stub(() => json(200, { allowed: false, reason: 'something_new' }));
    expect((await client(unknownReason.fetchImpl).reserve(RESERVE))).toMatchObject({ allowed: false, reason: 'temporarily_unavailable', window: null });
  });

  it('a definitive 4xx is a KafuoIntegrationError carrying Kafuo’s code', async () => {
    const kafuo = stub(() => json(404, { error: { code: 'student_ref_unknown' } }));
    const error = await client(kafuo.fetchImpl).reserve(RESERVE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KafuoIntegrationError);
    expect(error).toMatchObject({ status: 404, code: 'student_ref_unknown' });
    expect(error).not.toBeInstanceOf(KafuoUnreachableError);
    const malformed = stub(() => json(200, { allowed: true }));
    await expect(client(malformed.fetchImpl).reserve(RESERVE)).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('network errors, timeouts and 5xx are KafuoUnreachableError', async () => {
    const network = stub(() => new TypeError('fetch failed'));
    await expect(client(network.fetchImpl).reserve(RESERVE)).rejects.toBeInstanceOf(KafuoUnreachableError);
    const five = stub(() => json(502, { error: 'bad gateway' }));
    const error = await client(five.fetchImpl).reserve(RESERVE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KafuoUnreachableError);
    expect((error as KafuoUnreachableError).status).toBe(502);
    // A hung Kafuo: the AbortSignal.timeout fires and the client reports unreachable.
    const hung = stub(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
        }),
    );
    const start = Date.now();
    await expect(client(hung.fetchImpl, { timeoutMs: 30 }).reserve(RESERVE)).rejects.toBeInstanceOf(KafuoUnreachableError);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('finalize (contracts §2.3)', () => {
  it('maps 204 → delivered (also on identical repeats), 409 → conflict, 404 → not_found', async () => {
    const body = { reservationId: '1', outcome: 'not_delivered' as const, reason: 'model_unavailable' as const, turnId: 't' };
    expect(await client(stub(() => new Response(null, { status: 204 })).fetchImpl).finalize(body)).toEqual({ status: 'delivered' });
    expect(await client(stub(() => json(409, { error: { code: 'finalize_conflict' } })).fetchImpl).finalize(body)).toEqual({ status: 'conflict' });
    expect(await client(stub(() => new Response(null, { status: 404 })).fetchImpl).finalize(body)).toEqual({ status: 'not_found' });
    await expect(client(stub(() => json(422, { error: { code: 'validation' } })).fetchImpl).finalize(body)).rejects.toBeInstanceOf(KafuoIntegrationError);
    await expect(client(stub(() => json(500, {})).fetchImpl).finalize(body)).rejects.toBeInstanceOf(KafuoUnreachableError);
  });
});

describe('grounding search (contracts §2.1)', () => {
  it('parses units and the lesson match; refusals carry Kafuo’s code', async () => {
    const kafuo = stub(() =>
      json(200, {
        units: [
          { contentUnitId: 'cu-1', lessonId: 'l-1', lessonTitle: 'Fractions', unitTitle: 'Intro', text: 'abc', charLength: 3, score: 0.81 },
          { bogus: true },
        ],
        lessonMatch: { lessonId: 'l-1', lessonTitle: 'Fractions', confidence: 0.62 },
        truncated: false,
      }),
    );
    const result = await client(kafuo.fetchImpl).groundingSearch({
      tenantId: '1',
      studentRef: 'abcdefghijklmnopqrstuvwx',
      subjectOfferingId: '13',
      query: 'fractions',
      maxChars: 10_000,
    });
    expect(result).toEqual({
      units: [{ contentUnitId: 'cu-1', lessonId: 'l-1', lessonTitle: 'Fractions', unitTitle: 'Intro', text: 'abc', charLength: 3, score: 0.81 }],
      lessonMatch: { lessonId: 'l-1', lessonTitle: 'Fractions', confidence: 0.62 },
      truncated: false,
    });
    expect(kafuo.captured[0]!.url).toBe(`${BASE}/grounding/search`);
    const none = stub(() => json(200, { units: [], lessonMatch: null, truncated: true }));
    expect(await client(none.fetchImpl).groundingSearch({ tenantId: '1', studentRef: 'x'.repeat(16), subjectOfferingId: '1', query: 'q', maxChars: 1 })).toEqual({ units: [], lessonMatch: null, truncated: true });
    const forbidden = stub(() => json(403, { error: { code: 'offering_not_permitted' } }));
    await expect(client(forbidden.fetchImpl).groundingSearch({ tenantId: '1', studentRef: 'x'.repeat(16), subjectOfferingId: '1', query: 'q', maxChars: 1 })).rejects.toMatchObject({ status: 403, code: 'offering_not_permitted' });
  });
});
