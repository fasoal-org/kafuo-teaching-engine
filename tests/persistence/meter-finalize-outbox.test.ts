import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  claimDueFinalizes,
  deleteExpiredFinalizes,
  enqueueFinalize,
  ensureMeterFinalizeOutboxSchema,
  markFinalizeConflict,
  markFinalizeDelivered,
  markFinalizeTerminalFailed,
  readFinalize,
  readOutboxStatus,
  releaseLeases,
  type EnqueueFinalizeInput,
} from '@/lib/persistence/meter-finalize-outbox';
import {
  ensureTutorRuntimeSchema,
  insertConversation,
  insertStudentMessage,
  insertTutorMessage,
  markMessageCompleted,
  readMessage,
} from '@/lib/persistence/tutor-runtime';
import { KafuoIntegrationClient } from '@/lib/server/tutor/kafuo-integration-client';

/**
 * Meter finalize outbox (Kafuo R1 plan §8.6, P5 tests, §11 row "Meter
 * finalize outbox"). PGlite is real Postgres: the transaction boundary, the
 * `FOR UPDATE SKIP LOCKED` claim and every guarded update are exercised for
 * real. Kafuo is a fetch stub that counts finalize calls per reservation.
 */

const mocks = vi.hoisted(() => ({
  pool: undefined as unknown,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: mocks.pool }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<Row>(text, params);
  }
  async connect() {
    return { query: (t: string, p?: unknown[]) => this.db.query(t, p), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const OWNER = { tenantId: '1', studentRef: 'abcdefghijklmnopqrstuvwx' };

/** A Kafuo stub: per-reservation call counts and a scriptable answer. */
function kafuoStub(
  answer: (reservationId: string, calls: number) => Response | Promise<Response> | Error,
) {
  const calls = new Map<string, number>();
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { reservationId: string };
    bodies.push(body);
    const n = (calls.get(body.reservationId) ?? 0) + 1;
    calls.set(body.reservationId, n);
    const result = await answer(body.reservationId, n);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, bodies };
}

const ok204 = () => new Response(null, { status: 204 });
const conflict409 = () =>
  new Response(JSON.stringify({ error: { code: 'finalize_conflict' } }), { status: 409 });
const down = () => new TypeError('fetch failed');

function client(fetchImpl: typeof fetch, now: () => number = () => NOW_MS) {
  return new KafuoIntegrationClient({
    baseUrl: 'https://kafuo.test/api/v2/integrations/teaching-engine',
    secret: 'whsec-test',
    fetchImpl,
    now,
  });
}

function row(overrides: Partial<EnqueueFinalizeInput> = {}): EnqueueFinalizeInput {
  const id = overrides.reservationId ?? `res-${Math.random().toString(36).slice(2)}`;
  return {
    reservationId: id,
    tenantId: '1',
    turnId: `turn-${id}`,
    turnAttempt: 1,
    outcome: 'delivered',
    reason: null,
    now: NOW_S,
    ...overrides,
  };
}

describe('meter finalize outbox', () => {
  let pool: PGlitePool;
  const cq = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    mocks.pool = pool;
    await pool.query(`CREATE TABLE teaching_package_versions (id TEXT PRIMARY KEY)`);
    await ensureTutorRuntimeSchema(pool);
    await ensureMeterFinalizeOutboxSchema(pool);
    await ensureMeterFinalizeOutboxSchema(pool); // idempotent
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function sweeper() {
    return import('@/lib/server/teaching-model/meter-outbox-sweeper');
  }

  it('is enqueued in the same transaction as the turn completion — and absent when it rolls back', async () => {
    await insertConversation(pool, {
      id: 'conv-1',
      ...OWNER,
      subjectCode: 'MATH',
      subjectOfferingId: '10',
      subjectName: 'Math',
      academic: { curriculumName: 'N', curriculumVersionLabel: 'v', gradeLabel: 'g', academicLanguage: 'ar' },
      now: NOW_S,
    });
    await insertStudentMessage(pool, {
      id: 'm-1',
      parentId: 'conv-1',
      seq: 1,
      clientMessageId: 'cm-1',
      turnId: 'turn-1',
      text: 'q',
      now: NOW_S,
    });

    const completeTurn = async (tx: { query: PGlitePool['query'] }, reservationId: string) => {
      await markMessageCompleted(tx, 'm-1', { now: NOW_S + 3, accountingComplete: true, meterReservationId: reservationId });
      await insertTutorMessage(tx, {
        id: `m-2-${reservationId}`,
        parentId: 'conv-1',
        seq: 2,
        turnId: 'turn-1',
        turnAttempt: 1,
        text: 'a',
        servedBy: 'primary',
        groundingMode: 'none',
        meterReservationId: reservationId,
        accountingComplete: true,
        now: NOW_S + 3,
      });
      expect(await enqueueFinalize(tx, row({ reservationId, turnId: 'turn-1' }))).toBe(true);
    };

    // Rolled back: nothing of the completion survives, the outbox included.
    await expect(
      pool.db.transaction(async (tx) => {
        await completeTurn(tx, 'res-rollback');
        throw new Error('ledger completion failed');
      }),
    ).rejects.toThrow('ledger completion failed');
    expect(await readFinalize(pool, 'res-rollback')).toBeNull();
    expect((await readMessage(pool, 'm-1'))!.status).toBe('accepted');

    // Committed: all three writes are visible together.
    await pool.db.transaction(async (tx) => {
      await completeTurn(tx, 'res-commit');
    });
    const enqueued = await readFinalize(pool, 'res-commit');
    expect(enqueued).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_attempt_at: NOW_S,
      created_at: NOW_S,
      claimed_by: null,
      payload: { reservationId: 'res-commit', outcome: 'delivered', reason: null, turnId: 'turn-1' },
    });
    expect((await readMessage(pool, 'm-1'))).toMatchObject({
      status: 'completed',
      meterReservationId: 'res-commit',
      meterFinalized: false,
    });
    // A replayed completion for the same reservation is not a second row.
    expect(await enqueueFinalize(pool, row({ reservationId: 'res-commit', outcome: 'not_delivered' }))).toBe(false);
    expect((await readFinalize(pool, 'res-commit'))!.outcome).toBe('delivered');
  });

  it('inline delivery after commit marks the row delivered and flags the message rows', async () => {
    await insertConversation(pool, {
      id: 'conv-1',
      ...OWNER,
      subjectCode: 'MATH',
      subjectOfferingId: '10',
      subjectName: 'Math',
      academic: { curriculumName: 'N', curriculumVersionLabel: 'v', gradeLabel: 'g', academicLanguage: 'ar' },
      now: NOW_S,
    });
    await insertStudentMessage(pool, { id: 'm-1', parentId: 'conv-1', seq: 1, clientMessageId: 'cm-1', turnId: 'turn-1', text: 'q', now: NOW_S });
    await markMessageCompleted(pool, 'm-1', { now: NOW_S, meterReservationId: 'res-1' });
    await enqueueFinalize(pool, row({ reservationId: 'res-1' }));

    const kafuo = kafuoStub(ok204);
    const { deliverFinalizeInline } = await sweeper();
    const outcome = await deliverFinalizeInline(cq(), 'res-1', {
      client: client(kafuo.fetchImpl),
      now: () => NOW_MS + 500,
      workerId: 'host:1:A',
    });
    expect(outcome).toBe('delivered');
    expect(kafuo.calls.get('res-1')).toBe(1);
    expect(kafuo.bodies[0]).toEqual({ reservationId: 'res-1', outcome: 'delivered', reason: null, turnId: 'turn-res-1' });
    expect(await readFinalize(pool, 'res-1')).toMatchObject({
      status: 'delivered',
      attempts: 1,
      last_status: 204,
      delivered_at: NOW_S + 0.5,
      claimed_by: null,
      claimed_until: null,
    });
    expect((await readMessage(pool, 'm-1'))!.meterFinalized).toBe(true);
    // Nothing is pending: a second inline call finds nothing to claim.
    expect(await deliverFinalizeInline(cq(), 'res-1', { client: client(kafuo.fetchImpl) })).toBe('not_claimed');
    expect(kafuo.calls.get('res-1')).toBe(1);
  });

  it('Kafuo down: the row stays pending with 5 s × 2^(attempts−1) backoff and no lease', async () => {
    await enqueueFinalize(pool, row({ reservationId: 'res-1' }));
    const kafuo = kafuoStub(down);
    const { deliverFinalizeInline, runMeterOutboxSweepOnce } = await sweeper();

    expect(
      await deliverFinalizeInline(cq(), 'res-1', { client: client(kafuo.fetchImpl), now: () => NOW_MS }),
    ).toBe('deferred');
    expect(await readFinalize(pool, 'res-1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      next_attempt_at: NOW_S + 5,
      last_status: null,
      last_error: 'KafuoUnreachableError',
      claimed_by: null,
    });
    // Not due yet: a sweep now claims nothing.
    const early = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 1000, workerId: 'host:1:A' });
    expect(early).toEqual({ claimed: 0, delivered: 0 });
    // Due: second failure doubles the backoff.
    const second = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 5000, workerId: 'host:1:A' });
    expect(second).toEqual({ claimed: 1, delivered: 0 });
    expect(await readFinalize(pool, 'res-1')).toMatchObject({ status: 'pending', attempts: 2, next_attempt_at: NOW_S + 5 + 10 });
    // A 5xx is the same as unreachable.
    const five = kafuoStub(() => new Response('oops', { status: 503 }));
    await runMeterOutboxSweepOnce({ pool: cq(), client: client(five.fetchImpl), now: () => NOW_MS + 15_000, workerId: 'host:1:A' });
    expect(await readFinalize(pool, 'res-1')).toMatchObject({ status: 'pending', attempts: 3, next_attempt_at: NOW_S + 15 + 20 });
    // The cap: 5 × 2^9 = 2560 > 300.
    await pool.query(`UPDATE meter_finalize_outbox SET attempts = 9, next_attempt_at = $1 WHERE reservation_id = 'res-1'`, [NOW_S]);
    await runMeterOutboxSweepOnce({ pool: cq(), client: client(five.fetchImpl), now: () => NOW_MS + 100_000, workerId: 'host:1:A' });
    expect(await readFinalize(pool, 'res-1')).toMatchObject({ status: 'pending', attempts: 10, next_attempt_at: NOW_S + 100 + 300 });
    expect(kafuo.calls.get('res-1')).toBe(2);
    expect(five.calls.get('res-1')).toBe(2);
  });

  it('instance replacement: worker A enqueues and exits, worker B claims and delivers', async () => {
    // A completes the turn, enqueues, and dies before the inline delivery.
    await enqueueFinalize(pool, row({ reservationId: 'res-a' }));
    const kafuo = kafuoStub(ok204);
    const { runMeterOutboxSweepOnce } = await sweeper();
    const b = await runMeterOutboxSweepOnce({
      pool: cq(),
      client: client(kafuo.fetchImpl),
      now: () => NOW_MS + 30_000,
      workerId: 'host:2:B',
    });
    expect(b).toEqual({ claimed: 1, delivered: 1 });
    expect(await readFinalize(pool, 'res-a')).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(kafuo.calls.get('res-a')).toBe(1);
  });

  it('two live sweepers over 100 due rows deliver each row exactly once', async () => {
    for (let i = 0; i < 100; i += 1) {
      await enqueueFinalize(pool, row({ reservationId: `res-${String(i).padStart(3, '0')}` }));
    }
    const kafuo = kafuoStub(ok204);
    const { runMeterOutboxSweepOnce } = await sweeper();
    const run = (workerId: string) =>
      runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS, workerId, batch: 30 });
    let claimedA = 0;
    let claimedB = 0;
    for (let round = 0; round < 4; round += 1) {
      const [a, b] = await Promise.all([run('host:1:A'), run('host:2:B')]);
      claimedA += a.claimed;
      claimedB += b.claimed;
    }
    expect(claimedA + claimedB).toBe(100);
    expect(kafuo.calls.size).toBe(100);
    expect([...kafuo.calls.values()].every((n) => n === 1)).toBe(true);
    const delivered = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM meter_finalize_outbox WHERE status = 'delivered'`,
    );
    expect(delivered.rows[0]!.n).toBe(100);
    expect(await readOutboxStatus(pool, NOW_S)).toMatchObject({ pendingFinalizes: 0, oldestPendingFinalizeAgeS: null });
  });

  it('lease expiry: a row abandoned mid-delivery is re-claimed after 60 s, not before', async () => {
    await enqueueFinalize(pool, row({ reservationId: 'res-1' }));
    // Worker A claims (and then hangs / dies) without recording an outcome.
    const claimed = await claimDueFinalizes(pool, { workerId: 'host:1:A', batch: 10, leaseUntil: NOW_S + 60, now: NOW_S });
    expect(claimed.map((r) => r.reservation_id)).toEqual(['res-1']);
    const kafuo = kafuoStub(ok204);
    const { runMeterOutboxSweepOnce } = await sweeper();
    const during = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 59_000, workerId: 'host:2:B' });
    expect(during).toEqual({ claimed: 0, delivered: 0 });
    const after = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 61_000, workerId: 'host:2:B' });
    expect(after).toEqual({ claimed: 1, delivered: 1 });
    expect(kafuo.calls.get('res-1')).toBe(1);
    // A's late outcome write is a no-op against the guarded update.
    await markFinalizeDelivered(pool, 'res-1', NOW_S + 70);
    expect((await readFinalize(pool, 'res-1'))!.delivered_at).toBe(NOW_S + 61);
  });

  it('a lost 204 followed by redelivery is accepted idempotently', async () => {
    await enqueueFinalize(pool, row({ reservationId: 'res-1' }));
    // Kafuo processed the first call but the response never arrived.
    const kafuo = kafuoStub((_id, n) => (n === 1 ? new TypeError('socket hang up') : ok204()));
    const { deliverFinalizeInline, runMeterOutboxSweepOnce } = await sweeper();
    expect(await deliverFinalizeInline(cq(), 'res-1', { client: client(kafuo.fetchImpl), now: () => NOW_MS })).toBe('deferred');
    const redelivered = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 6000, workerId: 'host:1:A' });
    expect(redelivered).toEqual({ claimed: 1, delivered: 1 });
    expect(kafuo.calls.get('res-1')).toBe(2);
    expect(await readFinalize(pool, 'res-1')).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('409 finalize_conflict marks the row conflict and never retries; 404 is terminal_failed', async () => {
    await enqueueFinalize(pool, row({ reservationId: 'res-conflict' }));
    await enqueueFinalize(pool, row({ reservationId: 'res-unknown' }));
    const kafuo = kafuoStub((id) => (id === 'res-conflict' ? conflict409() : new Response(null, { status: 404 })));
    const { runMeterOutboxSweepOnce } = await sweeper();
    const first = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS, workerId: 'host:1:A' });
    expect(first).toEqual({ claimed: 2, delivered: 0 });
    expect(await readFinalize(pool, 'res-conflict')).toMatchObject({
      status: 'conflict',
      attempts: 1,
      last_status: 409,
      terminal_failed_at: NOW_S,
    });
    expect(await readFinalize(pool, 'res-unknown')).toMatchObject({ status: 'terminal_failed', last_status: 404 });
    const again = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 600_000, workerId: 'host:1:A' });
    expect(again).toEqual({ claimed: 0, delivered: 0 });
    expect(kafuo.calls.get('res-conflict')).toBe(1);
    expect(kafuo.calls.get('res-unknown')).toBe(1);
    expect(await readOutboxStatus(pool, NOW_S)).toMatchObject({ conflictFinalizes: 1, terminalFailedFinalizes: 1 });
  });

  it('past the stale window: one last attempt, then terminal_failed', async () => {
    const { MERGE_RESERVATION_STALE_SECONDS, runMeterOutboxSweepOnce } = await sweeper();
    expect(MERGE_RESERVATION_STALE_SECONDS).toBe(3600);
    await enqueueFinalize(pool, row({ reservationId: 'res-old', now: NOW_S - MERGE_RESERVATION_STALE_SECONDS - 1 }));
    await enqueueFinalize(pool, row({ reservationId: 'res-young', now: NOW_S - 10 }));
    const kafuo = kafuoStub(down);
    const result = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS, workerId: 'host:1:A' });
    expect(result).toEqual({ claimed: 2, delivered: 0 });
    expect(kafuo.calls.get('res-old')).toBe(1);
    expect(await readFinalize(pool, 'res-old')).toMatchObject({
      status: 'terminal_failed',
      attempts: 1,
      terminal_failed_at: NOW_S,
      last_error: 'KafuoUnreachableError',
    });
    expect(await readFinalize(pool, 'res-young')).toMatchObject({ status: 'pending', attempts: 1 });
    // Had Kafuo answered on that last attempt, the old row would have been delivered.
    await enqueueFinalize(pool, row({ reservationId: 'res-old-2', now: NOW_S - 2 * MERGE_RESERVATION_STALE_SECONDS }));
    const up = kafuoStub(ok204);
    await runMeterOutboxSweepOnce({ pool: cq(), client: client(up.fetchImpl), now: () => NOW_MS, workerId: 'host:1:A' });
    expect((await readFinalize(pool, 'res-old-2'))!.status).toBe('delivered');
  });

  it('retention: delivered/conflict after 7 days, terminal_failed after 30 days', async () => {
    const day = 24 * 60 * 60;
    for (const [id, status, age] of [
      ['d-old', 'delivered', 8 * day],
      ['d-new', 'delivered', 6 * day],
      ['c-old', 'conflict', 8 * day],
      ['c-new', 'conflict', 6 * day],
      ['t-old', 'terminal_failed', 31 * day],
      ['t-new', 'terminal_failed', 29 * day],
      ['p-old', 'pending', 40 * day],
    ] as const) {
      await enqueueFinalize(pool, row({ reservationId: id, now: NOW_S - age - 5 }));
      const at = NOW_S - age;
      if (status === 'delivered') await markFinalizeDelivered(pool, id, at);
      if (status === 'conflict') await markFinalizeConflict(pool, id, { now: at });
      if (status === 'terminal_failed') await markFinalizeTerminalFailed(pool, id, { now: at, lastStatus: null, lastError: 'x' });
    }
    expect(await deleteExpiredFinalizes(pool, NOW_S)).toEqual({ deleted: 3 });
    const remaining = await pool.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM meter_finalize_outbox ORDER BY reservation_id`,
    );
    expect(remaining.rows.map((r) => r.reservation_id)).toEqual(['c-new', 'd-new', 'p-old', 't-new']);
    // The sweep runs retention as part of every pass (Kafuo up, nothing else due).
    const { runMeterOutboxSweepOnce } = await sweeper();
    const kafuo = kafuoStub(ok204);
    await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 2 * day * 1000, workerId: 'host:1:A' });
    const later = await pool.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM meter_finalize_outbox ORDER BY reservation_id`,
    );
    // Two days on, the 6-day delivered/conflict rows and the 29-day terminal
    // row have all crossed their windows; only the freshly handled row remains.
    expect(later.rows.map((r) => r.reservation_id)).toEqual(['p-old']);
    // p-old was 40 days stale: its one last attempt succeeded, so it is delivered.
    expect((await readFinalize(pool, 'p-old'))!.status).toBe('delivered');
  });

  it('health: pending count, oldest pending age and lastMeterSweepAt', async () => {
    const { readMeterOutboxHealth, resetMeterOutboxSweeperStatusForTests, runMeterOutboxSweepOnce } = await sweeper();
    resetMeterOutboxSweeperStatusForTests();
    await enqueueFinalize(pool, row({ reservationId: 'res-1', now: NOW_S - 120 }));
    await enqueueFinalize(pool, row({ reservationId: 'res-2', now: NOW_S - 30 }));
    expect(await readMeterOutboxHealth({ pool: cq(), now: () => NOW_MS })).toEqual({
      lastMeterSweepAt: null,
      pendingFinalizes: 2,
      oldestPendingFinalizeAgeS: 120,
    });
    const kafuo = kafuoStub(ok204);
    await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS, workerId: 'host:1:A' });
    expect(await readMeterOutboxHealth({ pool: cq(), now: () => NOW_MS })).toEqual({
      lastMeterSweepAt: NOW_MS,
      pendingFinalizes: 0,
      oldestPendingFinalizeAgeS: null,
    });
  });

  it('SIGTERM lease release: a stopped worker’s rows are claimable immediately', async () => {
    await enqueueFinalize(pool, row({ reservationId: 'res-1' }));
    await claimDueFinalizes(pool, { workerId: 'host:1:A', batch: 10, leaseUntil: NOW_S + 60, now: NOW_S });
    expect((await readFinalize(pool, 'res-1'))!.claimed_by).toBe('host:1:A');
    expect(await releaseLeases(pool, 'host:1:A')).toBe(1);
    expect(await releaseLeases(pool, 'host:1:A')).toBe(0);
    const kafuo = kafuoStub(ok204);
    const { runMeterOutboxSweepOnce } = await sweeper();
    const b = await runMeterOutboxSweepOnce({ pool: cq(), client: client(kafuo.fetchImpl), now: () => NOW_MS + 1000, workerId: 'host:2:B' });
    expect(b).toEqual({ claimed: 1, delivered: 1 });
  });

  it('startMeterOutboxSweeper: gated, memoized, registers with the sweep registry, stop releases leases', async () => {
    const { startMeterOutboxSweeper } = await sweeper();
    const { getMeterOutboxSweeper } = await import('@/lib/server/teaching-model/sweep-registry');
    expect(startMeterOutboxSweeper()).toBeUndefined();
    expect(getMeterOutboxSweeper()).toBeUndefined();

    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
    vi.stubEnv('DATABASE_URL', 'postgres://pglite/in-memory');
    vi.stubEnv('KAFUO_INTEGRATION_BASE_URL', 'https://kafuo.test/api/v2/integrations/teaching-engine');
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', 'whsec');
    vi.resetModules();
    // The boot pass runs against the mocked provider with the env client: no
    // network here, so make the row un-due and prove the claim/lease seam alone.
    await enqueueFinalize(pool, row({ reservationId: 'res-1', now: NOW_S }));
    await pool.query(`UPDATE meter_finalize_outbox SET next_attempt_at = $1`, [Date.now() / 1000 + 3600]);
    const configured = await import('@/lib/server/teaching-model/meter-outbox-sweeper');
    const registry = await import('@/lib/server/teaching-model/sweep-registry');
    const handle = configured.startMeterOutboxSweeper();
    expect(handle).toBeDefined();
    expect(configured.startMeterOutboxSweeper()).toBe(handle);
    expect(registry.getMeterOutboxSweeper()).toBeDefined();
    await vi.waitFor(() => {
      expect(configured.meterOutboxSweeperStatus().lastMeterSweepAt).not.toBeNull();
    });
    // The registry hooks route to the same sweep and health.
    const health = await registry.getMeterOutboxSweeper()!.readMeterOutboxHealth();
    expect(health.pendingFinalizes).toBe(1);
    // Simulate a lease this worker holds at SIGTERM time.
    const { currentWorkerId } = await import('@/lib/server/teaching-model/worker-id');
    await pool.query(
      `UPDATE meter_finalize_outbox SET claimed_by = $1, claimed_until = $2 WHERE reservation_id = 'res-1'`,
      [currentWorkerId(), Date.now() / 1000 + 60],
    );
    await handle!.stop();
    expect(registry.getMeterOutboxSweeper()).toBeUndefined();
    expect((await readFinalize(pool, 'res-1'))!.claimed_by).toBeNull();
  });
});
