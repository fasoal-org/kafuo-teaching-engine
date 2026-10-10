import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFinalize } from '@/lib/persistence/meter-finalize-outbox';
import { readMessageByClientId } from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import {
  KafuoIntegrationClient,
  type MeterReserveDecision,
  type MeterReserveRequest,
} from '@/lib/server/tutor/kafuo-integration-client';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';

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
 * W1-B2b: the TE side of the `POST /meters/reserve` contract (r1-api-contracts
 * §2.2) — ET-04 (an explicit `reservationId: null` is the ungated answer: the
 * turn runs, no outbox row, no finalize), SR-36 (`account_inactive` → 403
 * `ACCOUNT_INACTIVE`, not retryable) and ET-30 (`ai_daily_safety_limit` → 429
 * `ALLOWANCE_EXHAUSTED` with `details.reason/window/resetAt`).
 *
 * THE FIXTURES ARE SHARED WITH THE BACKEND. The same files live in
 * `zakrly-backend/tests/contracts/meter-reserve/` and must stay byte-identical:
 * change both copies together and compare them with `cmp` (or `diff -r` on the
 * two directories). The last test here does that compare when both checkouts
 * sit side by side and skips otherwise. The backend twin of this suite is
 * `tests/unit/entitlements/test_w1_b2b_meter_reserve_contract.py`, which drives
 * the real `openmaic_turn_reserve` into every fixture whose `backend` is set.
 *
 * Fixture fields: `case`, `backend` (scenario or null for TE-only robustness
 * cases), `response` (the exact 200 body), `teDecision` / `teClientError`
 * (what `KafuoIntegrationClient.reserve` returns / throws) and `teTurn` (what
 * the turn answers: 200 with or without a finalize, or the refusal envelope).
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type TeTurn =
  | { httpStatus: 200; finalize: boolean }
  | { httpStatus: number; code: string; retryable: boolean; details: Record<string, unknown> | null };

interface ReserveFixture {
  case: string;
  description: string;
  backend: string | null;
  response: Record<string, unknown>;
  teDecision: MeterReserveDecision | null;
  teClientError: string | null;
  teTurn: TeTurn;
}

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests', 'contracts', 'meter-reserve');
const BACKEND_FIXTURE_DIR = path.resolve(
  process.cwd(),
  '..',
  'zakrly-backend',
  'tests',
  'contracts',
  'meter-reserve',
);

const fixtureFiles = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

const FIXTURES: ReserveFixture[] = fixtureFiles(FIXTURE_DIR).map(
  (name) => JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as ReserveFixture,
);

const BASE = 'https://kafuo.test/api/v2/integrations/teaching-engine';
const RESERVE: MeterReserveRequest = {
  tenantId: '1',
  studentRef: 'abcdefghijklmnopqrstuvwx',
  capability: 'free_chat',
  meterScope: { conversationId: 'conv-1' },
  turnId: 'turn-1',
  turnAttempt: 1,
  clientMessageId: 'cm-1',
};

/** A real client whose `/meters/reserve` answers the fixture's 200 body. */
function clientAnswering(body: unknown): KafuoIntegrationClient {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
  return new KafuoIntegrationClient({
    baseUrl: BASE,
    secret: 'whsec-w1-b2b',
    fetchImpl,
    now: () => T0_MS,
  });
}

describe('meter reserve contract fixtures (shared with the backend)', () => {
  it('covers every reserve case', () => {
    expect(FIXTURES.map((f) => f.case)).toEqual(
      expect.arrayContaining([
        'reserved',
        'reserved-shadow',
        'reserved-replay',
        'ungated',
        'refused-tutor-allowance-exhausted',
        'refused-help-allowance-exhausted',
        'refused-ai-daily-safety-limit',
        'refused-account-inactive',
        'refused-unknown-reason',
      ]),
    );
  });

  it.skipIf(!existsSync(BACKEND_FIXTURE_DIR))(
    'is byte-identical to the backend copy',
    () => {
      const ours = fixtureFiles(FIXTURE_DIR);
      expect(fixtureFiles(BACKEND_FIXTURE_DIR)).toEqual(ours);
      for (const name of ours) {
        const mine = readFileSync(path.join(FIXTURE_DIR, name));
        const theirs = readFileSync(path.join(BACKEND_FIXTURE_DIR, name));
        expect(mine.equals(theirs), name).toBe(true);
      }
    },
  );
});

describe('KafuoIntegrationClient.reserve parses every fixture (contracts §2.2)', () => {
  for (const fixture of FIXTURES) {
    it(fixture.case, async () => {
      const result = clientAnswering(fixture.response).reserve(RESERVE);
      if (fixture.teClientError) {
        await expect(result).rejects.toMatchObject({
          name: 'KafuoIntegrationError',
          code: fixture.teClientError,
        });
      } else {
        await expect(result).resolves.toEqual(fixture.teDecision);
      }
    });
  }

  it('turns a numeric reservationId into a string', async () => {
    const decision = await clientAnswering({ allowed: true, reservationId: 501, replay: false, status: null }).reserve(
      RESERVE,
    );
    expect(decision).toMatchObject({ allowed: true, reservationId: '501' });
  });
});

// ---------------------------------------------------------------------------
// The turn: the runner's mapping of every fixture (Free Chat route)
// ---------------------------------------------------------------------------

const SERVICE_KEY = 'meter-reserve-w1-b2b-svc-key';

describe('Free Chat turn per reserve fixture (turn-runner mapping)', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let ids: number;

  async function routes() {
    return {
      list: await import('@/app/api/tutor/conversations/route'),
      messages: await import('@/app/api/tutor/conversations/[id]/messages/route'),
    };
  }

  function request(urlPath: string, body: unknown) {
    return new NextRequest(`http://localhost${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: studentBearer() },
      body: JSON.stringify(body),
    });
  }

  async function createConversation(): Promise<string> {
    const r = await routes();
    const response = await r.list.POST(
      request('/api/tutor/conversations', { subjectCode: 'MATH', clientRequestId: 'cr-1' }),
    );
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async function send(conversationId: string) {
    const r = await routes();
    return r.messages.POST(
      request(`/api/tutor/conversations/${conversationId}/messages`, {
        clientMessageId: 'cm-1',
        text: 'ما هو التبرير الاستقرائي؟',
      }),
      { params: Promise.resolve({ id: conversationId }) },
    );
  }

  const outboxRows = async () =>
    Number(
      (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM meter_finalize_outbox')).rows[0]!
        .n,
    );

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://meter-reserve-w1-b2b-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    ids = 0;
    pool = await createTutorPool(mocks.events);
    kafuo = fakeKafuo(mocks.events);
    mocks.callLLM.mockImplementation(async () => ok('التبرير الاستقرائي'));
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now: () => T0_MS,
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
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.case} → ${fixture.teTurn.httpStatus}`, async () => {
      const conversationId = await createConversation();
      // The real client parses the fixture's wire body; the runner maps the result.
      const real = clientAnswering(fixture.response);
      kafuo.reserve.mockImplementation((req) => real.reserve(req));
      mocks.streamLLM.mockImplementation(() => textStream('الجواب هو ٤.'));

      const response = await send(conversationId);
      const turn = fixture.teTurn;
      expect(response.status).toBe(turn.httpStatus);
      const student = async () => (await readMessageByClientId(pool, conversationId, 'cm-1'))!;

      if ('finalize' in turn) {
        // The stream settles the turn; read the row after it closes.
        const frames = await readSse(response);
        expect(frames.map((f) => f.event)).toContain('done');
        const settled = await student();
        expect(settled.status).toBe('completed');
        expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
        const reservationId = fixture.teDecision?.allowed ? fixture.teDecision.reservationId : null;
        if (turn.finalize) {
          expect(settled.meterReservationId).toBe(reservationId);
          expect(kafuo.finalize).toHaveBeenCalledTimes(1);
          expect(kafuo.finalize.mock.calls[0]![0]).toMatchObject({ reservationId, outcome: 'delivered' });
          expect(await readFinalize(pool, reservationId!)).toMatchObject({ status: 'delivered' });
        } else {
          // ET-04 ungated: nothing reserved, so nothing enqueued and nothing finalized.
          expect(settled.meterReservationId).toBeNull();
          expect(kafuo.finalize).not.toHaveBeenCalled();
          expect(mocks.events).not.toContain('outbox:insert');
          expect(await outboxRows()).toBe(0);
        }
        return;
      }

      const body = (await response.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({ code: turn.code, retryable: turn.retryable });
      if (turn.details === null) {
        expect(body.error.details).toBeUndefined();
      } else {
        expect(body.error.details).toEqual(turn.details);
      }
      // Refused before any ledger row or model call; the student row is not left generating.
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(mocks.events).not.toContain('ledger:insert');
      expect(kafuo.finalize).not.toHaveBeenCalled();
      expect(await student()).toMatchObject({ status: 'failed', errorCode: turn.code });
    });
  }
});
