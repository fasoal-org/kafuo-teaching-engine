import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureTeachingModelAttemptsSchema,
  insertStartedAttempt,
  readAttempt,
  type StartedAttemptInput,
} from '@/lib/persistence/teaching-model-attempts';

/**
 * Accounting sweeper (Kafuo R1 plan §7.7 step 4, P2 tests): instance
 * replacement, concurrent sweeps, and the internal sweep route doing the
 * same work. PGlite plays Postgres; `getServerPersistenceProvider` is
 * redirected at it so the route path is the production path.
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

const NOW_MS = 1_800_000_000_000;

function started(overrides: Partial<StartedAttemptInput>): StartedAttemptInput {
  return {
    id: overrides.id ?? `tma-${Math.random().toString(36).slice(2)}`,
    tenantId: '1',
    capability: 'help',
    subjectCode: 'PHYSICS',
    policyVersion: 'r1-2026-09',
    stage: 'help-turn',
    providerId: 'qwen',
    modelId: 'qwen3.7-flash',
    modelString: 'qwen:qwen3.7-flash',
    thinkingLabel: 'nothink',
    role: 'primary',
    attemptIndex: 1,
    origin: 'openmaic_runtime',
    association: { kind: 'turn', turnId: `turn-${overrides.id ?? 'x'}` },
    workerId: 'host:1:aaaa',
    startedAt: NOW_MS / 1000,
    ...overrides,
  };
}

describe('accounting sweeper', () => {
  let pool: PGlitePool;
  const cq = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    mocks.pool = pool;
    await ensureTeachingModelAttemptsSchema(pool);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('instance replacement: worker A vanishes, fresh worker B marks its row process_exit_before_completion', async () => {
    const { runAccountingSweepOnce, HEARTBEAT_STALE_S, accountingSweeperStatus } =
      await import('@/lib/server/teaching-model/accounting-sweeper');
    // Worker A boots, heartbeats, starts a call, and disappears.
    const t0 = NOW_MS;
    await runAccountingSweepOnce({ pool: cq(), now: () => t0, workerId: 'host:1:A' });
    await insertStartedAttempt(
      pool,
      started({ id: 'orphan', workerId: 'host:1:A', startedAt: t0 / 1000 + 1 }),
    );
    // (A exits here: no more heartbeats.)

    // Worker B replaces it. Before A's heartbeat is stale, B must NOT judge the row.
    const t1 = t0 + (HEARTBEAT_STALE_S - 10) * 1000;
    const early = await runAccountingSweepOnce({ pool: cq(), now: () => t1, workerId: 'host:1:B' });
    expect(early.marked).toBe(0);
    expect((await readAttempt(pool, 'orphan'))!.accounting_status).toBe('started');

    // Once A has been silent for the stale window (and the row is that old too), B marks it.
    const t2 = t0 + (HEARTBEAT_STALE_S + 5) * 1000;
    const marked = await runAccountingSweepOnce({
      pool: cq(),
      now: () => t2,
      workerId: 'host:1:B',
    });
    expect(marked.marked).toBe(1);
    expect(await readAttempt(pool, 'orphan')).toMatchObject({
      accounting_status: 'incomplete',
      incomplete_reason: 'process_exit_before_completion',
      cost_unavailable_reason: 'accounting_incomplete',
    });
    expect(accountingSweeperStatus().lastLedgerSweepAt).toBe(t2);

    // B's own in-flight row is protected by B's heartbeat.
    await insertStartedAttempt(
      pool,
      started({ id: 'b-live', workerId: 'host:1:B', startedAt: t2 / 1000 }),
    );
    const t3 = t2 + (HEARTBEAT_STALE_S + 5) * 1000;
    await runAccountingSweepOnce({ pool: cq(), now: () => t3 - 1000, workerId: 'host:1:B' }); // heartbeat
    const later = await runAccountingSweepOnce({ pool: cq(), now: () => t3, workerId: 'host:1:B' });
    expect(later.marked).toBe(0);
    expect((await readAttempt(pool, 'b-live'))!.accounting_status).toBe('started');
  });

  it('two concurrent sweeps over the same rows mark each row once and neither errors', async () => {
    const { runAccountingSweepOnce, INCOMPLETE_DEADLINE_S } =
      await import('@/lib/server/teaching-model/accounting-sweeper');
    const nowS = NOW_MS / 1000;
    for (let i = 0; i < 5; i += 1) {
      await insertStartedAttempt(
        pool,
        started({
          id: `lost-${i}`,
          workerId: 'host:1:gone',
          startedAt: nowS - INCOMPLETE_DEADLINE_S - 60,
        }),
      );
    }
    const [a, b] = await Promise.all([
      runAccountingSweepOnce({ pool: cq(), now: () => NOW_MS, workerId: 'host:1:X' }),
      runAccountingSweepOnce({ pool: cq(), now: () => NOW_MS, workerId: 'host:2:Y' }),
    ]);
    expect(a.marked + b.marked).toBe(5);
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teaching_model_attempts WHERE accounting_status = 'incomplete'`,
    );
    expect(rows.rows[0]!.n).toBe(5);
    // Both workers are now registered.
    const workers = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM teaching_model_workers ORDER BY worker_id`,
    );
    expect(workers.rows.map((r) => r.worker_id)).toEqual(['host:1:X', 'host:2:Y']);
  });

  it('POST /api/internal/sweep performs the same work (service key, 404 when unconfigured)', async () => {
    const { INCOMPLETE_DEADLINE_S } =
      await import('@/lib/server/teaching-model/accounting-sweeper');
    await insertStartedAttempt(
      pool,
      started({
        id: 'route-lost',
        workerId: 'host:1:gone',
        startedAt: Date.now() / 1000 - INCOMPLETE_DEADLINE_S - 60,
      }),
    );

    // Unconfigured: 404 before any auth or work.
    const unconfigured = await import('@/app/api/internal/sweep/route');
    const nf = await unconfigured.POST(
      new Request('http://localhost/api/internal/sweep', { method: 'POST' }) as never,
    );
    expect(nf.status).toBe(404);

    vi.resetModules();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
    vi.stubEnv('DATABASE_URL', 'postgres://pglite/in-memory');
    const { POST } = await import('@/app/api/internal/sweep/route');

    const unauthorized = await POST(
      new Request('http://localhost/api/internal/sweep', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      }) as never,
    );
    expect(unauthorized.status).toBe(401);
    expect((await readAttempt(pool, 'route-lost'))!.accounting_status).toBe('started');

    const response = await POST(
      new Request('http://localhost/api/internal/sweep', {
        method: 'POST',
        headers: { authorization: 'Bearer svc-key' },
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ledger: { marked: 1 }, meter: null });
    // Past the deadline AND its worker never heartbeated: the more specific
    // process-exit diagnosis wins over the deadline one.
    expect(await readAttempt(pool, 'route-lost')).toMatchObject({
      accounting_status: 'incomplete',
      incomplete_reason: 'process_exit_before_completion',
    });

    // With a meter outbox sweeper registered (P5), the route runs it too.
    const { registerMeterOutboxSweeper } =
      await import('@/lib/server/teaching-model/sweep-registry');
    const meter = vi.fn(async () => ({ claimed: 3, delivered: 2 }));
    registerMeterOutboxSweeper({
      runMeterOutboxSweepOnce: meter,
      readMeterOutboxHealth: async () => ({
        lastMeterSweepAt: null,
        pendingFinalizes: 0,
        oldestPendingFinalizeAgeS: null,
      }),
    });
    try {
      const again = await POST(
        new Request('http://localhost/api/internal/sweep', {
          method: 'POST',
          headers: { authorization: 'Bearer svc-key' },
        }) as never,
      );
      expect(await again.json()).toEqual({
        ledger: { marked: 0 },
        meter: { claimed: 3, delivered: 2 },
      });
      expect(meter).toHaveBeenCalledTimes(1);
    } finally {
      registerMeterOutboxSweeper(undefined);
    }
  });

  it('GET /api/health reports the accounting block (nulls until the sweepers ran)', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
    vi.stubEnv('DATABASE_URL', 'postgres://pglite/in-memory');
    const { INCOMPLETE_DEADLINE_S, runAccountingSweepOnce, resetAccountingSweeperStatusForTests } =
      await import('@/lib/server/teaching-model/accounting-sweeper');
    // The status is process-global (Symbol.for): earlier cases in this file swept.
    resetAccountingSweeperStatusForTests();
    await insertStartedAttempt(
      pool,
      started({
        id: 'stuck',
        workerId: 'host:1:gone',
        startedAt: Date.now() / 1000 - INCOMPLETE_DEADLINE_S - 60,
      }),
    );
    const { GET } = await import('@/app/api/health/route');
    const before = await (await GET()).json();
    expect(before.accounting).toEqual({
      lastLedgerSweepAt: null,
      lastMeterSweepAt: null,
      pendingFinalizes: null,
      oldestPendingFinalizeAgeS: null,
      startedRowsOlderThanDeadline: 1,
    });
    const t = Date.now();
    await runAccountingSweepOnce({ pool: cq(), now: () => t, workerId: 'host:1:H' });
    const after = await (await GET()).json();
    expect(after.accounting.lastLedgerSweepAt).toBe(t);
    expect(after.accounting.startedRowsOlderThanDeadline).toBe(0);
  });

  it('startAccountingSweeper is gated on the Teaching Package API and memoized', async () => {
    const { startAccountingSweeper } =
      await import('@/lib/server/teaching-model/accounting-sweeper');
    expect(startAccountingSweeper()).toBeUndefined();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
    vi.stubEnv('DATABASE_URL', 'postgres://pglite/in-memory');
    vi.resetModules();
    const configured = await import('@/lib/server/teaching-model/accounting-sweeper');
    const handle = configured.startAccountingSweeper();
    expect(handle).toBeDefined();
    expect(configured.startAccountingSweeper()).toBe(handle);
    await handle!.stop();
    // Boot pass ran against the PGlite pool: this worker is registered.
    await vi.waitFor(async () => {
      const workers = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM teaching_model_workers`,
      );
      expect(workers.rows[0]!.n).toBe(1);
    });
  });
});
