import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateAttempts,
  completeAttempt,
  ensureTeachingModelAttemptsSchema,
  heartbeatWorker,
  insertStartedAttempt,
  listIncompleteAttempts,
  markIncompleteAttempts,
  raiseCalibrationRatio,
  readAttempt,
  readCalibration,
  seedCalibration,
  countStartedRowsOlderThan,
  type AttemptCompletionInput,
  type StartedAttemptInput,
} from '@/lib/persistence/teaching-model-attempts';

/**
 * Ledger persistence (Kafuo R1 plan §5.1, §7.7). PGlite is real Postgres, so
 * the CHECK constraints, partial indexes and `percentile_cont` are exercised
 * for real — nothing is stubbed.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<Row>(text, params);
  }
  async end() {
    await this.db.close();
  }
}

const NOW = 1_800_000_000; // epoch seconds

function started(overrides: Partial<StartedAttemptInput> = {}): StartedAttemptInput {
  return {
    id: overrides.id ?? `tma-${Math.random().toString(36).slice(2)}`,
    tenantId: '1',
    capability: 'free_chat',
    subjectCode: 'MATH',
    policyVersion: 'r1-2026-09',
    stage: 'free-chat-turn',
    providerId: 'qwen',
    modelId: 'qwen3.7-flash',
    modelString: 'qwen:qwen3.7-flash',
    thinkingLabel: 'nothink',
    role: 'primary',
    attemptIndex: 1,
    origin: 'openmaic_runtime',
    association: { kind: 'turn', turnId: 'turn-1', conversationId: 'conv-1', studentRef: 'stu' },
    budget: { estimateTokens: 1200, counterKind: 'proxy', effectiveCap: 25_600 },
    workerId: 'host:1:aaaa',
    startedAt: NOW,
    ...overrides,
  };
}

function completion(overrides: Partial<AttemptCompletionInput> = {}): AttemptCompletionInput {
  return {
    outcome: 'succeeded',
    fallbackTriggered: false,
    usage: {
      usageAvailable: true,
      inputTokensTotal: 1300,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      freshInputTokens: 1300,
      outputTokensTotal: 200,
      reasoningTokens: null,
      visibleOutputTokens: 200,
      cacheReadReported: false,
      cacheWriteReported: false,
      reasoningReported: false,
      usageUnavailableReason: null,
      usageInconsistent: false,
    },
    cost: {
      rateCardVersion: 'rc-test',
      costUsd: 0.000065,
      costBasis: 'no_cache_detail',
      costUnavailableReason: null,
    },
    budgetBreach: false,
    ttftMs: 420,
    ttftUnavailableReason: null,
    totalMs: 2100,
    primaryFailureMs: null,
    completedAt: NOW + 3,
    ...overrides,
  };
}

describe('teaching_model_attempts ledger', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureTeachingModelAttemptsSchema(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('DDL is idempotent (runs twice; tables and indexes present once)', async () => {
    await ensureTeachingModelAttemptsSchema(pool);
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE 'teaching_model_%' ORDER BY tablename`,
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      'teaching_model_attempts',
      'teaching_model_calibration',
      'teaching_model_workers',
    ]);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'teaching_model_attempts' AND indexname = 'tma_accounting_idx'`,
    );
    expect(indexes.rows).toHaveLength(1);
  });

  it('CHECK constraints refuse bad capability, role, outcome and a row with no/both associations', async () => {
    await expect(
      insertStartedAttempt(pool, started({ capability: 'chat' as never })),
    ).rejects.toThrow(/check|violates/i);
    await expect(
      insertStartedAttempt(pool, started({ role: 'tertiary' as never })),
    ).rejects.toThrow(/check|violates/i);
    await expect(insertStartedAttempt(pool, started({ attemptIndex: 0 }))).rejects.toThrow(
      /check|violates/i,
    );
    // Exactly one association block (tma_one_association).
    await expect(
      pool.query(
        `INSERT INTO teaching_model_attempts (id, tenant_id, capability, subject_code, policy_version, stage, provider_id, model_id, model_string, role, attempt_index, accounting_status, started_at, origin, worker_id, created_at)
         VALUES ('x', '1', 'help', 'MATH', 'v', 's', 'p', 'm', 'p:m', 'primary', 1, 'started', 1, 'openmaic_runtime', 'w', 1)`,
      ),
    ).rejects.toThrow(/tma_one_association|check/i);
    await expect(
      pool.query(
        `INSERT INTO teaching_model_attempts (id, tenant_id, capability, subject_code, policy_version, stage, provider_id, model_id, model_string, role, attempt_index, accounting_status, started_at, origin, worker_id, created_at, turn_id, generation_attempt_id)
         VALUES ('y', '1', 'help', 'MATH', 'v', 's', 'p', 'm', 'p:m', 'primary', 1, 'started', 1, 'openmaic_runtime', 'w', 1, 't', 'g')`,
      ),
    ).rejects.toThrow(/tma_one_association|check/i);
    // An invalid outcome on completion is refused too.
    const id = 'tma-outcome';
    await insertStartedAttempt(pool, started({ id }));
    await expect(
      completeAttempt(pool, id, completion({ outcome: 'meh' as never })),
    ).rejects.toThrow(/check|violates/i);
  });

  it('started → complete: usage, cost, budget and timing columns land; late_completion false', async () => {
    const id = 'tma-1';
    await insertStartedAttempt(pool, started({ id }));
    let row = await readAttempt(pool, id);
    expect(row).toMatchObject({
      accounting_status: 'started',
      outcome: null,
      usage_available: null,
      cost_usd: null,
      budget_estimate_tokens: 1200,
      budget_counter_kind: 'proxy',
      budget_effective_cap: 25600,
      worker_id: 'host:1:aaaa',
      turn_id: 'turn-1',
      generation_attempt_id: null,
      late_completion: false,
    });

    const result = await completeAttempt(pool, id, completion());
    expect(result).toEqual({ updated: true, lateCompletion: false });
    row = await readAttempt(pool, id);
    expect(row).toMatchObject({
      accounting_status: 'complete',
      outcome: 'succeeded',
      usage_available: true,
      cache_read_tokens: null,
      cache_read_reported: false,
      cost_basis: 'no_cache_detail',
      ttft_ms: 420,
      total_ms: 2100,
      late_completion: false,
      incomplete_reason: null,
    });
    expect(Number(row!.input_tokens_total)).toBe(1300);
    expect(Number(row!.cost_usd)).toBeCloseTo(0.000065, 8);
    expect(Number(row!.completed_at)).toBe(NOW + 3);
  });

  it('generation association: generation block set, turn block NULL, budget NULL', async () => {
    const id = 'tma-gen';
    await insertStartedAttempt(
      pool,
      started({
        id,
        capability: 'package_generation',
        stage: 'scene-content:slide',
        association: {
          kind: 'generation',
          generationAttemptId: 'ga-1',
          generationRun: 2,
          versionId: 'tpv-1',
          learningItemType: 'lesson',
          learningItemId: 'li-9',
        },
        budget: null,
      }),
    );
    const row = await readAttempt(pool, id);
    expect(row).toMatchObject({
      generation_attempt_id: 'ga-1',
      generation_run: 2,
      version_id: 'tpv-1',
      learning_item_type: 'lesson',
      learning_item_id: 'li-9',
      turn_id: null,
      budget_estimate_tokens: null,
      budget_counter_kind: null,
    });
  });

  it('error_message is bounded to 300 chars and scrubbed of bearer tokens', async () => {
    const id = 'tma-err';
    await insertStartedAttempt(pool, started({ id }));
    await completeAttempt(
      pool,
      id,
      completion({
        outcome: 'provider_error',
        error: {
          code: '500',
          status: 500,
          message: `Bearer sk-abcdefghijklmnop ${'x'.repeat(500)}`,
        },
      }),
    );
    const row = await readAttempt(pool, id);
    expect(row!.error_message!.length).toBeLessThanOrEqual(300);
    expect(row!.error_message).not.toContain('sk-abcdefghijklmnop');
    expect(row!.error_status).toBe(500);
  });

  it('started → incomplete after the deadline (completion_write_lost)', async () => {
    await insertStartedAttempt(pool, started({ id: 'old', startedAt: NOW - 2000 }));
    await insertStartedAttempt(pool, started({ id: 'young', startedAt: NOW - 10 }));
    // The worker is alive, so only the deadline rule can fire.
    await heartbeatWorker(pool, 'host:1:aaaa', NOW);
    const marked = await markIncompleteAttempts(pool, {
      now: NOW,
      deadlineS: 1140,
      heartbeatStaleS: 90,
    });
    expect(marked).toEqual({ marked: 1, processExit: [], completionWriteLost: ['old'] });
    expect(await readAttempt(pool, 'old')).toMatchObject({
      accounting_status: 'incomplete',
      incomplete_reason: 'completion_write_lost',
      cost_unavailable_reason: 'accounting_incomplete',
    });
    expect((await readAttempt(pool, 'young'))!.accounting_status).toBe('started');
    // Idempotent: a second pass marks nothing.
    const again = await markIncompleteAttempts(pool, {
      now: NOW,
      deadlineS: 1140,
      heartbeatStaleS: 90,
    });
    expect(again.marked).toBe(0);
  });

  it('started → incomplete when the worker no longer heartbeats (process_exit_before_completion)', async () => {
    await insertStartedAttempt(
      pool,
      started({ id: 'orphan', workerId: 'host:7:dead', startedAt: NOW - 120 }),
    );
    await insertStartedAttempt(
      pool,
      started({ id: 'alive', workerId: 'host:1:aaaa', startedAt: NOW - 120 }),
    );
    // A row younger than the heartbeat window is never judged (its worker may not have heartbeated yet).
    await insertStartedAttempt(
      pool,
      started({ id: 'fresh', workerId: 'host:9:new', startedAt: NOW - 30 }),
    );
    await heartbeatWorker(pool, 'host:1:aaaa', NOW - 20);
    const marked = await markIncompleteAttempts(pool, {
      now: NOW,
      deadlineS: 1140,
      heartbeatStaleS: 90,
    });
    expect(marked.processExit).toEqual(['orphan']);
    expect(marked.completionWriteLost).toEqual([]);
    expect((await readAttempt(pool, 'orphan'))!.incomplete_reason).toBe(
      'process_exit_before_completion',
    );
    expect((await readAttempt(pool, 'alive'))!.accounting_status).toBe('started');
    expect((await readAttempt(pool, 'fresh'))!.accounting_status).toBe('started');
  });

  it('incomplete → complete is admitted with late_completion=true and the reason cleared', async () => {
    await insertStartedAttempt(pool, started({ id: 'late', startedAt: NOW - 5000 }));
    await markIncompleteAttempts(pool, { now: NOW, deadlineS: 1140, heartbeatStaleS: 90 });
    expect((await readAttempt(pool, 'late'))!.accounting_status).toBe('incomplete');
    const result = await completeAttempt(pool, 'late', completion());
    expect(result).toEqual({ updated: true, lateCompletion: true });
    expect(await readAttempt(pool, 'late')).toMatchObject({
      accounting_status: 'complete',
      late_completion: true,
      incomplete_reason: null,
      cost_unavailable_reason: null,
      outcome: 'succeeded',
    });
  });

  it('a row never regresses from complete (neither by the sweeper nor by a second completion)', async () => {
    await insertStartedAttempt(pool, started({ id: 'done', startedAt: NOW - 9000 }));
    await completeAttempt(pool, 'done', completion({ totalMs: 111 }));
    const marked = await markIncompleteAttempts(pool, {
      now: NOW,
      deadlineS: 1140,
      heartbeatStaleS: 90,
    });
    expect(marked.marked).toBe(0);
    const second = await completeAttempt(
      pool,
      'done',
      completion({ totalMs: 999, outcome: 'timeout' }),
    );
    expect(second).toEqual({ updated: false, lateCompletion: false });
    expect(await readAttempt(pool, 'done')).toMatchObject({
      accounting_status: 'complete',
      total_ms: 111,
      outcome: 'succeeded',
    });
    expect(await completeAttempt(pool, 'unknown-id', completion())).toEqual({
      updated: false,
      lateCompletion: false,
    });
  });

  it('countStartedRowsOlderThan and listIncompleteAttempts surface what the sweeper did not', async () => {
    await insertStartedAttempt(pool, started({ id: 's-old', startedAt: NOW - 3000 }));
    await insertStartedAttempt(pool, started({ id: 's-new', startedAt: NOW - 5 }));
    await insertStartedAttempt(pool, started({ id: 'i-1', startedAt: NOW - 4000 }));
    // The worker is alive at sweep time, so only the deadline rule can fire (on i-1).
    await heartbeatWorker(pool, 'host:1:aaaa', NOW - 2500);
    await markIncompleteAttempts(pool, { now: NOW - 2500, deadlineS: 1140, heartbeatStaleS: 90 });
    expect(await countStartedRowsOlderThan(pool, NOW - 1140)).toBe(1);
    const listed = await listIncompleteAttempts(pool, { now: NOW, startedOlderThanS: 1140 });
    expect(listed.map((r) => [r.id, r.accountingStatus, r.incompleteReason])).toEqual([
      ['i-1', 'incomplete', 'completion_write_lost'],
      ['s-old', 'started', null],
    ]);
    expect(listed[0]).toMatchObject({
      capability: 'free_chat',
      subjectCode: 'MATH',
      modelString: 'qwen:qwen3.7-flash',
      role: 'primary',
      turnId: 'turn-1',
      workerId: 'host:1:aaaa',
    });
    const onlyIncomplete = await listIncompleteAttempts(pool);
    expect(onlyIncomplete.map((r) => r.id)).toEqual(['i-1']);
  });

  it('aggregates label completeness, sum only complete rows, and report latency percentiles', async () => {
    // primary failure + fallback success pair sharing turn_id, plus an incomplete row.
    await insertStartedAttempt(pool, started({ id: 'p', role: 'primary', startedAt: NOW - 10 }));
    await completeAttempt(
      pool,
      'p',
      completion({
        outcome: 'rate_limited',
        fallbackTriggered: true,
        fallbackReason: 'rate_limited',
        ttftMs: null,
        ttftUnavailableReason: 'no_visible_delta',
        totalMs: 900,
        usage: {
          ...completion().usage,
          usageAvailable: false,
          inputTokensTotal: null,
          outputTokensTotal: null,
          usageUnavailableReason: 'usage_missing',
        },
        cost: {
          rateCardVersion: null,
          costUsd: null,
          costBasis: null,
          costUnavailableReason: 'usage_missing',
        },
        budgetBreach: null,
      }),
    );
    await insertStartedAttempt(
      pool,
      started({
        id: 'f',
        role: 'fallback',
        attemptIndex: 2,
        providerId: 'openai',
        modelId: 'gpt-5-nano',
        modelString: 'openai:gpt-5-nano',
        startedAt: NOW - 9,
      }),
    );
    await completeAttempt(
      pool,
      'f',
      completion({ ttftMs: 600, totalMs: 3000, primaryFailureMs: 900 }),
    );
    await insertStartedAttempt(pool, started({ id: 'lost', startedAt: NOW - 9000 }));
    await markIncompleteAttempts(pool, { now: NOW, deadlineS: 1140, heartbeatStaleS: 90 });

    const byRole = await aggregateAttempts(pool, { groupBy: ['role'] });
    expect(byRole).toHaveLength(2);
    const primary = byRole.find((r) => r.group.role === 'primary')!;
    const fallback = byRole.find((r) => r.group.role === 'fallback')!;
    expect(primary.completeness).toEqual({
      attempts: 2,
      complete: 1,
      incomplete: 1,
      started: 0,
      lateCompleted: 0,
      lowerBound: true,
    });
    expect(primary.tokens.usageUnavailable).toBe(1);
    expect(primary.cost.unpriced).toBe(1);
    expect(primary.outcomes.fallbackTriggered).toBe(1);
    expect(fallback.completeness.lowerBound).toBe(false);
    expect(fallback.tokens.inputTotal).toBe(1300);
    expect(fallback.cost.usd).toBeCloseTo(0.000065, 8);
    expect(fallback.latency.ttftP50Ms).toBe(600);
    expect(fallback.latency.totalP95Ms).toBe(3000);
    expect(fallback.latency.primaryFailureP50Ms).toBe(900);

    const byTurn = await pool.query<{ turn_id: string; n: number }>(
      `SELECT turn_id, count(*)::int AS n FROM teaching_model_attempts WHERE accounting_status = 'complete' GROUP BY turn_id`,
    );
    expect(byTurn.rows).toEqual([{ turn_id: 'turn-1', n: 2 }]);

    const total = await aggregateAttempts(pool, {
      groupBy: [],
      tenantId: '1',
      since: NOW - 10_000,
    });
    expect(total[0]!.completeness.attempts).toBe(3);
    // `tenant_id` became a legal dimension in P6 (Help spend by origin per
    // tenant); the guard is that an unlisted column is still refused, never
    // interpolated into SQL.
    await expect(
      aggregateAttempts(pool, { groupBy: ['error_message; DROP TABLE x' as never] }),
    ).rejects.toThrow(/groupBy/);
  });

  it('calibration: seed is a floor, breaches only raise the ratio', async () => {
    expect(await readCalibration(pool, 'qwen:qwen3.7-flash')).toBeNull();
    await seedCalibration(pool, 'qwen:qwen3.7-flash', { proxyRatio: 1.2, now: NOW });
    expect(await readCalibration(pool, 'qwen:qwen3.7-flash')).toMatchObject({
      proxyRatio: 1.2,
      sampleCount: 0,
    });
    // A lower seed never lowers an observed ratio.
    await seedCalibration(pool, 'qwen:qwen3.7-flash', { proxyRatio: 1.1, now: NOW + 1 });
    expect((await readCalibration(pool, 'qwen:qwen3.7-flash'))!.proxyRatio).toBe(1.2);
    const raised = await raiseCalibrationRatio(pool, 'qwen:qwen3.7-flash', {
      ratio: 1.35,
      now: NOW + 2,
    });
    expect(raised).toMatchObject({ proxyRatio: 1.35, sampleCount: 1, lastBreachAt: NOW + 2 });
    const lower = await raiseCalibrationRatio(pool, 'qwen:qwen3.7-flash', {
      ratio: 1.0,
      now: NOW + 3,
    });
    expect(lower.proxyRatio).toBe(1.35);
    expect(lower.sampleCount).toBe(2);
  });
});
