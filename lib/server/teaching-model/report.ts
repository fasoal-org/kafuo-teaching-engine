/**
 * Teaching-model report builder (Kafuo R1 FRD EFF-04, PERF-02, OPS-03; plan
 * §7.7 step 5, §9.1, P8). Pure over a `Queryable`: the CLI
 * (`scripts/teaching-model-report.ts`) prints what `buildTeachingModelReport`
 * returns, and the PGlite test asserts the same structure.
 *
 * Honesty rules (§7.7 step 5): every aggregate carries a completeness line
 * ("N attempts, M complete, K incomplete, L late-completed") and is labelled
 * a LOWER BOUND when any row is not complete; incomplete rows and every
 * unresolved finalize are listed, never summed away.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  listUnresolvedFinalizes,
  readOutboxStatus,
  type MeterFinalizeOutboxRow,
  type MeterOutboxStatus,
} from '@/lib/persistence/meter-finalize-outbox';
import {
  aggregateAttempts,
  fallbackBreakdown,
  listBudgetBreaches,
  listIncompleteAttempts,
  type AttemptAggregateRow,
  type AttemptReportFilter,
  type BudgetBreachRow,
  type FallbackBreakdownRow,
  type IncompleteAttemptSummary,
} from '@/lib/persistence/teaching-model-attempts';
import { INCOMPLETE_DEADLINE_S } from '@/lib/server/teaching-model/accounting-sweeper';

const CONVERSATIONAL = ['free_chat', 'help'] as const;
const GENERATION = ['package_generation', 'question_generation'] as const;

export interface TeachingModelReport {
  generatedAt: number;
  filter: AttemptReportFilter;
  overall: AttemptAggregateRow | null;
  conversational: {
    perTurn: AttemptAggregateRow[];
    perConversation: AttemptAggregateRow[];
    perStudent: AttemptAggregateRow[];
    perSubject: AttemptAggregateRow[];
    perModel: AttemptAggregateRow[];
  };
  generation: {
    perVersion: AttemptAggregateRow[];
    perAttempt: AttemptAggregateRow[];
  };
  fallback: FallbackBreakdownRow[];
  latency: AttemptAggregateRow[];
  helpByOrigin: AttemptAggregateRow[];
  budgetBreaches: BudgetBreachRow[];
  incomplete: IncompleteAttemptSummary[];
  outbox: MeterOutboxStatus;
  unresolvedFinalizes: MeterFinalizeOutboxRow[];
}

export async function buildTeachingModelReport(
  queryable: Queryable,
  options: AttemptReportFilter & { now?: number; listLimit?: number } = {},
): Promise<TeachingModelReport> {
  const now = options.now ?? Date.now() / 1000;
  const limit = options.listLimit ?? 500;
  const filter: AttemptReportFilter = {
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
  };
  const conv = { ...filter, capability: [...CONVERSATIONAL] };
  const gen = { ...filter, capability: [...GENERATION] };
  const [overall, perTurn, perConversation, perStudent, perSubject, perModel] = await Promise.all([
    aggregateAttempts(queryable, { groupBy: [], ...filter }),
    aggregateAttempts(queryable, { groupBy: ['turn_id'], ...conv }),
    aggregateAttempts(queryable, { groupBy: ['conversation_id'], ...conv }),
    aggregateAttempts(queryable, { groupBy: ['student_ref'], ...conv }),
    aggregateAttempts(queryable, { groupBy: ['subject_code'], ...conv }),
    aggregateAttempts(queryable, { groupBy: ['model_string'], ...conv }),
  ]);
  const [perVersion, perAttempt, fallback, latency, helpByOrigin, budgetBreaches, incomplete, outbox, unresolved] =
    await Promise.all([
      aggregateAttempts(queryable, { groupBy: ['version_id'], ...gen }),
      aggregateAttempts(queryable, { groupBy: ['generation_attempt_id'], ...gen }),
      fallbackBreakdown(queryable, filter),
      aggregateAttempts(queryable, { groupBy: ['model_string', 'role', 'capability'], ...filter }),
      aggregateAttempts(queryable, { groupBy: ['origin', 'subject_code', 'model_string'], ...filter, capability: 'help' }),
      listBudgetBreaches(queryable, filter, limit),
      listIncompleteAttempts(queryable, { limit, now, startedOlderThanS: INCOMPLETE_DEADLINE_S }),
      readOutboxStatus(queryable, now),
      listUnresolvedFinalizes(queryable, limit),
    ]);
  return {
    generatedAt: now,
    filter,
    overall: overall[0] ?? null,
    conversational: { perTurn, perConversation, perStudent, perSubject, perModel },
    generation: { perVersion, perAttempt },
    fallback,
    latency,
    helpByOrigin,
    budgetBreaches,
    incomplete,
    outbox,
    unresolvedFinalizes: unresolved,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function completenessLine(row: AttemptAggregateRow): string {
  const c = row.completeness;
  const started = c.started > 0 ? ` (+${c.started} still started)` : '';
  return `${c.attempts} attempts, ${c.complete} complete, ${c.incomplete} incomplete${started}, ${c.lateCompleted} late-completed${c.lowerBound ? ' — sums are LOWER BOUNDS' : ''}`;
}

function money(value: number): string {
  return `$${value.toFixed(6)}`;
}

function ms(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value)} ms`;
}

function groupLabel(row: AttemptAggregateRow): string {
  const parts = Object.entries(row.group).map(([key, value]) => `${key}=${value ?? '∅'}`);
  return parts.length ? parts.join(' ') : 'all';
}

function renderAggregate(title: string, rows: AttemptAggregateRow[], out: string[]): void {
  out.push(`## ${title}`);
  if (rows.length === 0) {
    out.push('(no rows)', '');
    return;
  }
  for (const row of rows) {
    const t = row.tokens;
    out.push(
      `- ${groupLabel(row)}: cost ${money(row.cost.usd)} (${row.cost.unpriced} unpriced); ` +
        `input ${t.inputTotal} (fresh ${t.freshInput}, cache-read ${t.cacheRead}), output ${t.outputTotal}, reasoning ${t.reasoning}, ` +
        `${t.usageUnavailable} usage-unavailable; succeeded ${row.outcomes.succeeded}, fallback-triggered ${row.outcomes.fallbackTriggered}, ` +
        `budget breaches ${row.outcomes.budgetBreaches}; ${completenessLine(row)}`,
    );
  }
  out.push('');
}

function renderLatency(rows: AttemptAggregateRow[], out: string[]): void {
  out.push('## Latency by model / role / capability (NULL = unavailable, never zero)');
  if (rows.length === 0) out.push('(no rows)');
  for (const row of rows) {
    const l = row.latency;
    out.push(
      `- ${groupLabel(row)}: TTFT p50 ${ms(l.ttftP50Ms)} p95 ${ms(l.ttftP95Ms)}; total p50 ${ms(l.totalP50Ms)} p95 ${ms(l.totalP95Ms)}; ` +
        `primary-failure p50 ${ms(l.primaryFailureP50Ms)}; ${completenessLine(row)}`,
    );
  }
  out.push('');
}

export function renderTeachingModelReport(report: TeachingModelReport): string {
  const out: string[] = [];
  out.push(`# Teaching model report — ${new Date(report.generatedAt * 1000).toISOString()}`);
  const f = report.filter;
  out.push(
    `Filter: tenant=${f.tenantId ?? 'all'} since=${f.since ? new Date(f.since * 1000).toISOString() : '-'} until=${f.until ? new Date(f.until * 1000).toISOString() : '-'}`,
    '',
  );
  out.push('## Completeness');
  out.push(report.overall ? completenessLine(report.overall) : '0 attempts', '');

  renderAggregate('Conversational cost per turn', report.conversational.perTurn, out);
  renderAggregate('Conversational cost per conversation', report.conversational.perConversation, out);
  renderAggregate('Conversational cost per student', report.conversational.perStudent, out);
  renderAggregate('Conversational cost per subject', report.conversational.perSubject, out);
  renderAggregate('Conversational cost per model', report.conversational.perModel, out);
  renderAggregate('Generation cost per version', report.generation.perVersion, out);
  renderAggregate('Generation cost per attempt', report.generation.perAttempt, out);

  out.push('## Fallback rate by subject / primary model');
  if (report.fallback.length === 0) out.push('(no rows)');
  for (const row of report.fallback) {
    const reasons = Object.entries(row.byReason)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    out.push(
      `- ${row.subjectCode} ${row.modelString}: ${row.fallbackTriggered}/${row.primaryAttempts} (${(row.fallbackRate * 100).toFixed(1)} %) ` +
        `[${reasons || 'none'}]; fallback rows succeeded ${row.fallbackSucceeded}, failed ${row.fallbackFailed}`,
    );
  }
  out.push('');

  renderLatency(report.latency, out);
  renderAggregate('Help spend by origin (openmaic_runtime vs kafuo_backend)', report.helpByOrigin, out);

  out.push(`## Budget breaches (${report.budgetBreaches.length})`);
  for (const row of report.budgetBreaches) {
    out.push(
      `- ${row.id} ${row.capability} ${row.subjectCode} ${row.modelString} ${row.role} ${row.stage} ${row.origin} ` +
        `turn=${row.turnId ?? '∅'} estimate=${row.budgetEstimateTokens ?? 'n/a'} (${row.budgetCounterKind ?? '?'}) cap=${row.budgetEffectiveCap ?? 'n/a'} reported=${row.inputTokensTotal ?? 'n/a'}`,
    );
  }
  out.push('');

  out.push(
    `## Meter finalize outbox: pending ${report.outbox.pendingFinalizes} (oldest ${report.outbox.oldestPendingFinalizeAgeS ?? 'n/a'} s), ` +
      `conflict ${report.outbox.conflictFinalizes}, terminal_failed ${report.outbox.terminalFailedFinalizes}`,
  );
  for (const row of report.unresolvedFinalizes) {
    out.push(
      `- ${row.status} reservation=${row.reservation_id} turn=${row.turn_id}#${row.turn_attempt} outcome=${row.outcome} reason=${row.reason ?? '∅'} attempts=${row.attempts} last_status=${row.last_status ?? 'n/a'}`,
    );
  }
  out.push('');

  out.push(`## Incomplete ledger rows (${report.incomplete.length})`);
  for (const row of report.incomplete) {
    out.push(
      `- ${row.id} ${row.accountingStatus}${row.incompleteReason ? ` (${row.incompleteReason})` : ''} ${row.capability} ${row.subjectCode} ${row.modelString} ${row.role} ${row.stage} ${row.origin} ` +
        `gen=${row.generationAttemptId ?? '∅'} turn=${row.turnId ?? '∅'} conv=${row.conversationId ?? '∅'} help=${row.helpSessionId ?? '∅'} worker=${row.workerId} started=${new Date(row.startedAt * 1000).toISOString()}`,
    );
  }
  return out.join('\n');
}
