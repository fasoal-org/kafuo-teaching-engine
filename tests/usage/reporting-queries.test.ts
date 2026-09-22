import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enqueueFinalize,
  ensureMeterFinalizeOutboxSchema,
  markFinalizeConflict,
  markFinalizeTerminalFailed,
} from '@/lib/persistence/meter-finalize-outbox';
import {
  completeAttempt,
  ensureTeachingModelAttemptsSchema,
  fallbackBreakdown,
  insertStartedAttempt,
  listBudgetBreaches,
  markIncompleteAttempts,
  type AttemptCompletionInput,
  type StartedAttemptInput,
} from '@/lib/persistence/teaching-model-attempts';
import {
  buildTeachingModelReport,
  completenessLine,
  renderTeachingModelReport,
} from '@/lib/server/teaching-model/report';

/**
 * Reporting queries (plan §7.7 step 5, §9.1, P8 `reporting-queries`): cost
 * per turn / conversation / student / subject / model, generation cost per
 * version / attempt, fallback rate incl. `unusable_output`, latency
 * percentiles, Help spend by origin, budget breaches, outbox counts, and
 * the honest completeness line with incomplete and late-completed rows.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
    return this.db.query<Row>(text, params);
  }
  async end() {
    await this.db.close();
  }
}

const NOW = 1_800_000_000;
let seq = 0;

function started(overrides: Partial<StartedAttemptInput> & { association: StartedAttemptInput['association'] }): StartedAttemptInput {
  seq += 1;
  return {
    id: `tma-${seq}`,
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
    budget: { estimateTokens: 5000, counterKind: 'proxy', effectiveCap: 25_600 },
    workerId: 'host:1:test',
    startedAt: NOW - 600,
    ...overrides,
  };
}

function completion(overrides: Partial<AttemptCompletionInput> = {}): AttemptCompletionInput {
  return {
    outcome: 'succeeded',
    fallbackTriggered: false,
    error: null,
    usage: {
      usageAvailable: true,
      inputTokensTotal: 4000,
      cacheReadTokens: 1000,
      cacheWriteTokens: null,
      freshInputTokens: 3000,
      outputTokensTotal: 200,
      reasoningTokens: 0,
      visibleOutputTokens: 200,
      cacheReadReported: true,
      cacheWriteReported: false,
      reasoningReported: true,
      usageUnavailableReason: null,
      usageInconsistent: false,
    },
    cost: { rateCardVersion: 'v1', costUsd: 0.0012, costBasis: 'full', costUnavailableReason: null },
    budgetBreach: false,
    ttftMs: 300,
    ttftUnavailableReason: null,
    totalMs: 1200,
    primaryFailureMs: null,
    completedAt: NOW - 590,
    ...overrides,
  };
}

const turn = (turnId: string, conversationId: string, studentRef = 'student-a') =>
  ({ kind: 'turn', turnId, conversationId, studentRef }) as const;

describe('teaching-model report', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    seq = 0;
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureTeachingModelAttemptsSchema(pool);
    await ensureMeterFinalizeOutboxSchema(pool);

    // Conversation A, student a: turn 1 primary ok; turn 2 primary unusable → fallback ok (with primary_failure_ms).
    await insertStartedAttempt(pool, started({ association: turn('t1', 'conv-A') }));
    await completeAttempt(pool, 'tma-1', completion());
    await insertStartedAttempt(pool, started({ association: turn('t2', 'conv-A') }));
    await completeAttempt(pool, 'tma-2', completion({ outcome: 'unusable_output', fallbackTriggered: true, fallbackReason: 'unusable_output', error: { code: 'unrenderable' }, ttftMs: null, ttftUnavailableReason: 'no_visible_delta', totalMs: 800 }));
    await insertStartedAttempt(pool, started({ association: turn('t2', 'conv-A'), role: 'fallback', attemptIndex: 2, providerId: 'openai', modelId: 'gpt-5-nano', modelString: 'openai:gpt-5-nano', thinkingLabel: 'minimal', budget: { estimateTokens: 4200, counterKind: 'exact', effectiveCap: 30_080 } }));
    await completeAttempt(pool, 'tma-3', completion({ primaryFailureMs: 800, totalMs: 1500, ttftMs: 500, cost: { rateCardVersion: 'v1', costUsd: 0.0005, costBasis: 'full', costUnavailableReason: null } }));
    // Conversation B, student b, CHEMISTRY: primary rate limited → fallback ok.
    await insertStartedAttempt(pool, started({ association: turn('t3', 'conv-B', 'student-b'), subjectCode: 'CHEMISTRY' }));
    await completeAttempt(pool, 'tma-4', completion({ outcome: 'rate_limited', fallbackTriggered: true, fallbackReason: 'rate_limited', error: { code: '429', status: 429 }, usage: { ...completion().usage, usageAvailable: false, inputTokensTotal: null, cacheReadTokens: null, freshInputTokens: null, outputTokensTotal: null, reasoningTokens: null, visibleOutputTokens: null, usageUnavailableReason: 'failed_before_response' }, cost: { rateCardVersion: null, costUsd: null, costBasis: null, costUnavailableReason: 'usage_missing' }, ttftMs: null, ttftUnavailableReason: 'failed_before_response' }));
    await insertStartedAttempt(pool, started({ association: turn('t3', 'conv-B', 'student-b'), subjectCode: 'CHEMISTRY', role: 'fallback', attemptIndex: 2, providerId: 'openai', modelId: 'gpt-5.6-luna', modelString: 'openai:gpt-5.6-luna', thinkingLabel: 'low' }));
    await completeAttempt(pool, 'tma-5', completion({ primaryFailureMs: 200 }));
    // Help: one openmaic_runtime, one kafuo_backend (legacy).
    await insertStartedAttempt(pool, started({ association: { kind: 'turn', turnId: 'h1', helpSessionId: 'hs-1', studentRef: 'student-a' }, capability: 'help', stage: 'help-turn', subjectCode: 'PHYSICS' }));
    await completeAttempt(pool, 'tma-6', completion());
    await insertStartedAttempt(pool, started({ association: { kind: 'turn', turnId: 'kafuo:conv:9:cm', conversationId: 'kafuo:9', studentRef: 'student-c', legacyHelpLinkRef: 'link:1' }, capability: 'help', stage: 'help-turn', subjectCode: 'PHYSICS', origin: 'kafuo_backend' }));
    await completeAttempt(pool, 'tma-7', completion({ cost: { rateCardVersion: 'v1', costUsd: 0.002, costBasis: 'full', costUnavailableReason: null } }));
    // Generation: two attempts of one version, one with a fallback.
    await insertStartedAttempt(pool, started({ association: { kind: 'generation', generationAttemptId: 'ga-1', generationRun: 1, versionId: 'v-1' }, capability: 'package_generation', stage: 'scene-content:slide', budget: null }));
    await completeAttempt(pool, 'tma-8', completion({ cost: { rateCardVersion: 'v1', costUsd: 0.05, costBasis: 'full', costUnavailableReason: null } }));
    await insertStartedAttempt(pool, started({ association: { kind: 'generation', generationAttemptId: 'ga-2', generationRun: 2, versionId: 'v-1' }, capability: 'package_generation', stage: 'scene-content:slide', budget: null }));
    await completeAttempt(pool, 'tma-9', completion({ cost: { rateCardVersion: 'v1', costUsd: 0.04, costBasis: 'full', costUnavailableReason: null } }));
    // Budget breach on a free_chat row.
    await insertStartedAttempt(pool, started({ association: turn('t4', 'conv-A') }));
    await completeAttempt(pool, 'tma-10', completion({ budgetBreach: true, usage: { ...completion().usage, inputTokensTotal: 33_000, freshInputTokens: 33_000 } }));
    // Incomplete: an old started row whose worker is gone (sweeper marks it); a late completion afterwards.
    await insertStartedAttempt(pool, started({ association: turn('t5', 'conv-C', 'student-b'), startedAt: NOW - 3600, workerId: 'host:dead' }));
    await insertStartedAttempt(pool, started({ association: turn('t6', 'conv-C', 'student-b'), startedAt: NOW - 3600, workerId: 'host:dead' }));
    await markIncompleteAttempts(pool, { now: NOW, deadlineS: 19 * 60, heartbeatStaleS: 90 });
    await completeAttempt(pool, 'tma-12', completion({ completedAt: NOW - 10 }));
    // Outbox: pending (old), conflict, terminal_failed, delivered.
    await enqueueFinalize(pool, { reservationId: 'r-pending', tenantId: '1', turnId: 't7', turnAttempt: 1, outcome: 'delivered', now: NOW - 900 });
    await enqueueFinalize(pool, { reservationId: 'r-conflict', tenantId: '1', turnId: 't8', turnAttempt: 1, outcome: 'not_delivered', reason: 'model_unavailable', now: NOW - 500 });
    await markFinalizeConflict(pool, 'r-conflict', { now: NOW - 400 });
    await enqueueFinalize(pool, { reservationId: 'r-terminal', tenantId: '1', turnId: 't9', turnAttempt: 2, outcome: 'delivered', now: NOW - 5000 });
    await markFinalizeTerminalFailed(pool, 'r-terminal', { now: NOW - 100, lastStatus: null, lastError: 'TypeError' });
  });

  afterEach(async () => {
    await pool.end();
  });

  it('aggregates cost per turn / conversation / student / subject / model with an honest completeness line', async () => {
    const report = await buildTeachingModelReport(pool, { now: NOW });
    expect(report.overall).toMatchObject({ completeness: { attempts: 12, complete: 11, incomplete: 1, started: 0, lateCompleted: 1, lowerBound: true } });
    expect(completenessLine(report.overall!)).toBe('12 attempts, 11 complete, 1 incomplete, 1 late-completed — sums are LOWER BOUNDS');

    const byConversation = Object.fromEntries(report.conversational.perConversation.map((r) => [r.group.conversation_id, r]));
    expect(byConversation['conv-A']!.cost.usd).toBeCloseTo(0.0012 + 0.0012 + 0.0005 + 0.0012, 8);
    expect(byConversation['conv-A']!.completeness).toMatchObject({ attempts: 4, complete: 4, lowerBound: false });
    expect(byConversation['conv-C']!.completeness).toMatchObject({ attempts: 2, complete: 1, incomplete: 1, lateCompleted: 1, lowerBound: true });
    expect(byConversation['kafuo:9']!.cost.usd).toBeCloseTo(0.002, 8);

    const byStudent = Object.fromEntries(report.conversational.perStudent.map((r) => [r.group.student_ref, r]));
    expect(byStudent['student-a']!.completeness.attempts).toBe(5);
    expect(byStudent['student-b']!.completeness.attempts).toBe(4);
    expect(byStudent['student-c']!.cost.usd).toBeCloseTo(0.002, 8);

    const bySubject = Object.fromEntries(report.conversational.perSubject.map((r) => [r.group.subject_code, r]));
    expect(Object.keys(bySubject).sort()).toEqual(['CHEMISTRY', 'MATH', 'PHYSICS']);
    expect(bySubject['CHEMISTRY']!.tokens.usageUnavailable).toBe(1);
    expect(bySubject['CHEMISTRY']!.cost.unpriced).toBe(1);

    const byModel = Object.fromEntries(report.conversational.perModel.map((r) => [r.group.model_string, r]));
    expect(byModel['openai:gpt-5-nano']!.completeness.attempts).toBe(1);
    expect(byModel['qwen:qwen3.7-flash']!.outcomes.budgetBreaches).toBe(1);

    const perTurn = Object.fromEntries(report.conversational.perTurn.map((r) => [r.group.turn_id, r]));
    expect(perTurn['t2']!.completeness.attempts).toBe(2);
    expect(perTurn['t2']!.outcomes.fallbackTriggered).toBe(1);
  });

  it('reports generation cost per version and attempt, separate from conversational spend', async () => {
    const report = await buildTeachingModelReport(pool, { now: NOW });
    expect(report.generation.perVersion).toHaveLength(1);
    expect(report.generation.perVersion[0]).toMatchObject({ group: { version_id: 'v-1' }, completeness: { attempts: 2, complete: 2 } });
    expect(report.generation.perVersion[0]!.cost.usd).toBeCloseTo(0.09, 8);
    expect(report.generation.perAttempt.map((r) => r.group.generation_attempt_id)).toEqual(['ga-1', 'ga-2']);
    const conversationalTotal = report.conversational.perSubject.reduce((sum, r) => sum + r.cost.usd, 0);
    expect(conversationalTotal).toBeLessThan(0.09);
  });

  it('fallback rate by subject and primary model includes unusable_output; latency percentiles by model / role / capability', async () => {
    const fallback = await fallbackBreakdown(pool);
    const math = fallback.find((r) => r.subjectCode === 'MATH' && r.modelString === 'qwen:qwen3.7-flash')!;
    // 5 conversational + 2 generation primary rows on the MATH route; one fell back (unusable output).
    expect(math).toMatchObject({ primaryAttempts: 7, fallbackTriggered: 1, byReason: { unusable_output: 1 }, fallbackSucceeded: 1, fallbackFailed: 0 });
    expect(math.fallbackRate).toBeCloseTo(1 / 7, 6);
    const chemistry = fallback.find((r) => r.subjectCode === 'CHEMISTRY')!;
    expect(chemistry).toMatchObject({ primaryAttempts: 1, fallbackTriggered: 1, fallbackRate: 1, byReason: { rate_limited: 1 } });

    const report = await buildTeachingModelReport(pool, { now: NOW });
    const nanoFallback = report.latency.find((r) => r.group.model_string === 'openai:gpt-5-nano' && r.group.role === 'fallback')!;
    expect(nanoFallback.latency).toMatchObject({ ttftP50Ms: 500, totalP50Ms: 1500, primaryFailureP50Ms: 800 });
    const qwenPrimaryChat = report.latency.find((r) => r.group.model_string === 'qwen:qwen3.7-flash' && r.group.role === 'primary' && r.group.capability === 'free_chat')!;
    expect(qwenPrimaryChat.latency.ttftP50Ms).toBe(300);
    expect(qwenPrimaryChat.latency.primaryFailureP50Ms).toBeNull();
  });

  it('splits Help spend by origin, lists budget breaches, outbox counts with the oldest pending age, and every incomplete row / unresolved finalize', async () => {
    const report = await buildTeachingModelReport(pool, { now: NOW });
    const help = Object.fromEntries(report.helpByOrigin.map((r) => [r.group.origin, r]));
    expect(help['openmaic_runtime']!.cost.usd).toBeCloseTo(0.0012, 8);
    expect(help['kafuo_backend']!.cost.usd).toBeCloseTo(0.002, 8);
    expect(help['kafuo_backend']!.group).toMatchObject({ subject_code: 'PHYSICS', model_string: 'qwen:qwen3.7-flash' });

    expect(await listBudgetBreaches(pool)).toEqual([
      expect.objectContaining({ id: 'tma-10', turnId: 't4', conversationId: 'conv-A', budgetEstimateTokens: 5000, budgetCounterKind: 'proxy', budgetEffectiveCap: 25_600, inputTokensTotal: 33_000 }),
    ]);
    expect(report.budgetBreaches).toHaveLength(1);

    expect(report.outbox).toEqual({ pendingFinalizes: 1, oldestPendingFinalizeAgeS: 900, conflictFinalizes: 1, terminalFailedFinalizes: 1 });
    expect(report.unresolvedFinalizes.map((r) => [r.reservation_id, r.status])).toEqual([
      ['r-conflict', 'conflict'],
      ['r-terminal', 'terminal_failed'],
    ]);
    expect(report.incomplete).toEqual([
      expect.objectContaining({ id: 'tma-11', accountingStatus: 'incomplete', incompleteReason: 'process_exit_before_completion', turnId: 't5', conversationId: 'conv-C', workerId: 'host:dead' }),
    ]);
  });

  it('renders every section as text with the completeness line on each aggregate', async () => {
    const report = await buildTeachingModelReport(pool, { now: NOW });
    const text = renderTeachingModelReport(report);
    expect(text).toContain('# Teaching model report');
    expect(text).toContain('12 attempts, 11 complete, 1 incomplete, 1 late-completed — sums are LOWER BOUNDS');
    expect(text).toContain('## Conversational cost per turn');
    expect(text).toContain('## Generation cost per version');
    expect(text).toContain('MATH qwen:qwen3.7-flash: 1/7 (14.3 %) [unusable_output=1]');
    expect(text).toContain('## Latency by model / role / capability');
    expect(text).toContain('origin=kafuo_backend');
    expect(text).toContain('## Budget breaches (1)');
    expect(text).toContain('## Meter finalize outbox: pending 1 (oldest 900 s), conflict 1, terminal_failed 1');
    expect(text).toContain('conflict reservation=r-conflict');
    expect(text).toContain('## Incomplete ledger rows (1)');
    expect(text).toContain('tma-11 incomplete (process_exit_before_completion)');
  });

  it('applies the tenant / since / until filter', async () => {
    const none = await buildTeachingModelReport(pool, { now: NOW, tenantId: 'other' });
    expect(none.overall?.completeness.attempts ?? 0).toBe(0);
    const recent = await buildTeachingModelReport(pool, { now: NOW, since: NOW - 1000 });
    expect(recent.overall!.completeness.attempts).toBe(10);
    expect(recent.filter).toEqual({ since: NOW - 1000 });
  });
});
