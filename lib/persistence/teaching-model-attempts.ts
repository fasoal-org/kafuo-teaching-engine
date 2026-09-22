/**
 * Teaching model attempt ledger (Kafuo R1 plan §5.1, §7.7; contracts §0 M2).
 *
 * One row per provider attempt, written by the executor's two-write protocol:
 * a `started` row BEFORE the provider call, a completion update AFTER it. The
 * ledger is the only accounting record for teaching calls (EFF-04, PERF-02,
 * OPS-03); the JSONL usage log is not consulted for them.
 *
 * Same pattern as `teaching-package.ts`: idempotent `ensure…Schema` DDL run at
 * boot, raw-row helpers over a `Queryable` so every write can join a caller's
 * transaction (the conversational turn commits its ledger completion together
 * with the tutor message and the meter outbox row). No class, no store.
 *
 * Honesty rules the helpers enforce (plan §7.7 step 4/5):
 *  - a row never regresses from `complete`;
 *  - `incomplete → complete` is allowed and flagged `late_completion`;
 *  - `started → incomplete` is a guarded, idempotent UPDATE, so concurrent
 *    sweepers need no lease;
 *  - usage/cost columns are NULL when unknown, never 0 (0 means "reported 0").
 *
 * Timestamps are DOUBLE PRECISION epoch SECONDS (contracts §1).
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

export type TeachingCapability =
  | 'package_generation'
  | 'question_generation'
  | 'help'
  | 'free_chat';
export type TeachingOrigin = 'openmaic_runtime' | 'kafuo_backend';
export type AttemptRole = 'primary' | 'fallback';
export type AccountingStatus = 'started' | 'complete' | 'incomplete';
export type IncompleteReason = 'completion_write_lost' | 'process_exit_before_completion';
export type AttemptOutcome =
  | 'succeeded'
  | 'empty_output'
  | 'unusable_output'
  | 'provider_error'
  | 'rate_limited'
  | 'timeout'
  | 'provider_content_filter'
  | 'request_rejected'
  | 'safety_refused'
  | 'aborted'
  | 'budget_assertion_failed';
export type CostBasis = 'full' | 'no_cache_detail';
export type CostUnavailableReason = 'usage_missing' | 'rate_card_missing' | 'accounting_incomplete';
export type BudgetCounterKind = 'exact' | 'proxy';

export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'succeeded',
  'empty_output',
  'unusable_output',
  'provider_error',
  'rate_limited',
  'timeout',
  'provider_content_filter',
  'request_rejected',
  'safety_refused',
  'aborted',
  'budget_assertion_failed',
];

const TEACHING_MODEL_ATTEMPT_TABLES = `
CREATE TABLE IF NOT EXISTS teaching_model_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  capability TEXT NOT NULL CHECK (capability IN ('package_generation','question_generation','help','free_chat')),
  subject_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  stage TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_string TEXT NOT NULL,
  thinking_label TEXT,
  role TEXT NOT NULL CHECK (role IN ('primary','fallback')),
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 1),
  accounting_status TEXT NOT NULL CHECK (accounting_status IN ('started','complete','incomplete')),
  incomplete_reason TEXT CHECK (incomplete_reason IN ('completion_write_lost','process_exit_before_completion')),
  outcome TEXT CHECK (outcome IN ('succeeded','empty_output','unusable_output','provider_error','rate_limited','timeout',
                                  'provider_content_filter','request_rejected','safety_refused','aborted','budget_assertion_failed')),
  fallback_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_reason TEXT,
  error_code TEXT,
  error_status INTEGER,
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 300),
  usage_available BOOLEAN,
  input_tokens_total BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  fresh_input_tokens BIGINT,
  output_tokens_total BIGINT,
  reasoning_tokens BIGINT,
  visible_output_tokens BIGINT,
  cache_read_reported BOOLEAN,
  cache_write_reported BOOLEAN,
  reasoning_reported BOOLEAN,
  usage_unavailable_reason TEXT,
  usage_inconsistent BOOLEAN NOT NULL DEFAULT FALSE,
  rate_card_version TEXT,
  cost_usd NUMERIC(14,8),
  cost_basis TEXT CHECK (cost_basis IN ('full','no_cache_detail')),
  cost_unavailable_reason TEXT CHECK (cost_unavailable_reason IN ('usage_missing','rate_card_missing','accounting_incomplete')),
  budget_estimate_tokens INTEGER,
  budget_counter_kind TEXT CHECK (budget_counter_kind IN ('exact','proxy')),
  budget_effective_cap INTEGER,
  budget_breach BOOLEAN,
  started_at DOUBLE PRECISION NOT NULL,
  ttft_ms INTEGER,
  ttft_unavailable_reason TEXT,
  total_ms INTEGER,
  primary_failure_ms INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('openmaic_runtime','kafuo_backend')),
  generation_attempt_id TEXT,
  generation_run INTEGER,
  version_id TEXT,
  learning_item_type TEXT,
  learning_item_id TEXT,
  question_set_ref TEXT,
  conversation_id TEXT,
  turn_id TEXT,
  help_session_id TEXT,
  student_ref TEXT,
  scene_id TEXT,
  legacy_help_link_ref TEXT,
  worker_id TEXT NOT NULL,
  late_completion BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DOUBLE PRECISION NOT NULL,
  completed_at DOUBLE PRECISION,
  CONSTRAINT tma_one_association CHECK ((generation_attempt_id IS NOT NULL) <> (turn_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS teaching_model_workers (
  worker_id TEXT PRIMARY KEY,
  last_seen_at DOUBLE PRECISION NOT NULL,
  started_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS teaching_model_calibration (
  model_string TEXT PRIMARY KEY,
  proxy_ratio DOUBLE PRECISION NOT NULL CHECK (proxy_ratio > 0),
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_breach_at DOUBLE PRECISION,
  updated_at DOUBLE PRECISION NOT NULL
);
`;

const TEACHING_MODEL_ATTEMPT_INDEXES = `
CREATE INDEX IF NOT EXISTS tma_accounting_idx
  ON teaching_model_attempts (accounting_status, started_at)
  WHERE accounting_status <> 'complete';

CREATE INDEX IF NOT EXISTS tma_tenant_started_idx
  ON teaching_model_attempts (tenant_id, started_at);

CREATE INDEX IF NOT EXISTS tma_turn_idx
  ON teaching_model_attempts (turn_id)
  WHERE turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tma_generation_attempt_idx
  ON teaching_model_attempts (generation_attempt_id)
  WHERE generation_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tma_worker_started_idx
  ON teaching_model_attempts (worker_id)
  WHERE accounting_status = 'started';
`;

export const TEACHING_MODEL_ATTEMPTS_SCHEMA = `${TEACHING_MODEL_ATTEMPT_TABLES}
${TEACHING_MODEL_ATTEMPT_INDEXES}`;

/** Idempotent; safe to run at every boot and twice in a row. */
export async function ensureTeachingModelAttemptsSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(TEACHING_MODEL_ATTEMPT_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(TEACHING_MODEL_ATTEMPT_INDEXES)) {
    await queryable.query(statement);
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * Exactly one association block per row (CHECK `tma_one_association`): a
 * generation call names its generation attempt, a conversational turn names
 * its turn. `kafuo_backend` rows use the turn block with the Backend's own
 * keys (plan §5.1).
 */
export type AttemptAssociation =
  | {
      kind: 'generation';
      generationAttemptId: string;
      generationRun?: number | null;
      versionId?: string | null;
      learningItemType?: string | null;
      learningItemId?: string | null;
      questionSetRef?: string | null;
    }
  | {
      kind: 'turn';
      turnId: string;
      conversationId?: string | null;
      helpSessionId?: string | null;
      studentRef?: string | null;
      sceneId?: string | null;
      learningItemType?: string | null;
      learningItemId?: string | null;
      legacyHelpLinkRef?: string | null;
    };

export interface AttemptBudgetColumns {
  estimateTokens: number;
  counterKind: BudgetCounterKind;
  effectiveCap: number;
}

export interface StartedAttemptInput {
  id: string;
  tenantId: string;
  capability: TeachingCapability;
  subjectCode: string;
  policyVersion: string;
  stage: string;
  providerId: string;
  modelId: string;
  modelString: string;
  thinkingLabel: string | null;
  role: AttemptRole;
  attemptIndex: number;
  origin: TeachingOrigin;
  association: AttemptAssociation;
  /** Conversational calls only (contracts §0 H1); NULL for generation. */
  budget?: AttemptBudgetColumns | null;
  /** Set on a fallback row that was chosen before any call (e.g. `primary_lacks_vision`). */
  fallbackReason?: string | null;
  workerId: string;
  /** Epoch seconds. */
  startedAt: number;
}

/** Structurally identical to `TokenClasses` in lib/usage/attribute.ts. */
export interface AttemptUsageColumns {
  usageAvailable: boolean;
  inputTokensTotal: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  freshInputTokens: number | null;
  outputTokensTotal: number | null;
  reasoningTokens: number | null;
  visibleOutputTokens: number | null;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
  reasoningReported: boolean;
  usageUnavailableReason: string | null;
  usageInconsistent: boolean;
}

/** Structurally identical to `CostResult` in lib/usage/attribute.ts. */
export interface AttemptCostColumns {
  rateCardVersion: string | null;
  costUsd: number | null;
  costBasis: CostBasis | null;
  costUnavailableReason: Exclude<CostUnavailableReason, 'accounting_incomplete'> | null;
}

export interface AttemptCompletionInput {
  outcome: AttemptOutcome;
  fallbackTriggered: boolean;
  fallbackReason?: string | null;
  error?: { code?: string | null; status?: number | null; message?: string | null } | null;
  usage: AttemptUsageColumns;
  cost: AttemptCostColumns;
  /** NULL when usage was not reported (plan §8.7). */
  budgetBreach: boolean | null;
  ttftMs: number | null;
  ttftUnavailableReason: string | null;
  totalMs: number | null;
  primaryFailureMs: number | null;
  /** Epoch seconds. */
  completedAt: number;
}

export interface TeachingModelAttemptRow {
  id: string;
  tenant_id: string;
  capability: TeachingCapability;
  subject_code: string;
  policy_version: string;
  stage: string;
  provider_id: string;
  model_id: string;
  model_string: string;
  thinking_label: string | null;
  role: AttemptRole;
  attempt_index: number;
  accounting_status: AccountingStatus;
  incomplete_reason: IncompleteReason | null;
  outcome: AttemptOutcome | null;
  fallback_triggered: boolean;
  fallback_reason: string | null;
  error_code: string | null;
  error_status: number | null;
  error_message: string | null;
  usage_available: boolean | null;
  input_tokens_total: string | number | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  fresh_input_tokens: string | number | null;
  output_tokens_total: string | number | null;
  reasoning_tokens: string | number | null;
  visible_output_tokens: string | number | null;
  cache_read_reported: boolean | null;
  cache_write_reported: boolean | null;
  reasoning_reported: boolean | null;
  usage_unavailable_reason: string | null;
  usage_inconsistent: boolean;
  rate_card_version: string | null;
  cost_usd: string | number | null;
  cost_basis: CostBasis | null;
  cost_unavailable_reason: CostUnavailableReason | null;
  budget_estimate_tokens: number | null;
  budget_counter_kind: BudgetCounterKind | null;
  budget_effective_cap: number | null;
  budget_breach: boolean | null;
  started_at: number;
  ttft_ms: number | null;
  ttft_unavailable_reason: string | null;
  total_ms: number | null;
  primary_failure_ms: number | null;
  origin: TeachingOrigin;
  generation_attempt_id: string | null;
  generation_run: number | null;
  version_id: string | null;
  learning_item_type: string | null;
  learning_item_id: string | null;
  question_set_ref: string | null;
  conversation_id: string | null;
  turn_id: string | null;
  help_session_id: string | null;
  student_ref: string | null;
  scene_id: string | null;
  legacy_help_link_ref: string | null;
  worker_id: string;
  late_completion: boolean;
  created_at: number;
  completed_at: number | null;
}

/** Secret-free, bounded error text (plan §5.1: ≤300 chars). */
export function boundErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const single = message.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  // Strip anything that looks like a bearer token or key before truncating, so
  // a provider error echoing the Authorization header never lands in the ledger.
  const scrubbed = single
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, 'sk-[redacted]');
  return scrubbed.length <= 300 ? scrubbed : `${scrubbed.slice(0, 297)}...`;
}

// ---------------------------------------------------------------------------
// Two-write protocol
// ---------------------------------------------------------------------------

/** Step 1: the started row. Awaited by the executor BEFORE the provider call. */
export async function insertStartedAttempt(
  queryable: Queryable,
  input: StartedAttemptInput,
): Promise<void> {
  const a = input.association;
  const generation = a.kind === 'generation' ? a : null;
  const turn = a.kind === 'turn' ? a : null;
  await queryable.query(
    `INSERT INTO teaching_model_attempts (
       id, tenant_id, capability, subject_code, policy_version, stage,
       provider_id, model_id, model_string, thinking_label, role, attempt_index,
       accounting_status, fallback_reason,
       budget_estimate_tokens, budget_counter_kind, budget_effective_cap,
       started_at, origin,
       generation_attempt_id, generation_run, version_id, learning_item_type, learning_item_id, question_set_ref,
       conversation_id, turn_id, help_session_id, student_ref, scene_id, legacy_help_link_ref,
       worker_id, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       'started', $13,
       $14, $15, $16,
       $17, $18,
       $19, $20, $21, $22, $23, $24,
       $25, $26, $27, $28, $29, $30,
       $31, $17
     )`,
    [
      input.id,
      input.tenantId,
      input.capability,
      input.subjectCode,
      input.policyVersion,
      input.stage,
      input.providerId,
      input.modelId,
      input.modelString,
      input.thinkingLabel,
      input.role,
      input.attemptIndex,
      input.fallbackReason ?? null,
      input.budget?.estimateTokens ?? null,
      input.budget?.counterKind ?? null,
      input.budget?.effectiveCap ?? null,
      input.startedAt,
      input.origin,
      generation?.generationAttemptId ?? null,
      generation?.generationRun ?? null,
      generation?.versionId ?? null,
      generation?.learningItemType ?? turn?.learningItemType ?? null,
      generation?.learningItemId ?? turn?.learningItemId ?? null,
      generation?.questionSetRef ?? null,
      turn?.conversationId ?? null,
      turn?.turnId ?? null,
      turn?.helpSessionId ?? null,
      turn?.studentRef ?? null,
      turn?.sceneId ?? null,
      turn?.legacyHelpLinkRef ?? null,
      input.workerId,
    ],
  );
}

export interface CompleteAttemptResult {
  /** False when no row matched — the id is unknown or the row is already `complete`. */
  updated: boolean;
  /** True when the row had been marked `incomplete` by the sweeper first. */
  lateCompletion: boolean;
}

/**
 * Step 2: the completion update. Takes a `Queryable` so a conversational turn
 * can run it inside its own transaction. Guarded by status: a row never
 * regresses from `complete`; an `incomplete` row is admitted and flagged
 * `late_completion` with its `incomplete_reason` cleared.
 */
export async function completeAttempt(
  queryable: Queryable,
  id: string,
  completion: AttemptCompletionInput,
): Promise<CompleteAttemptResult> {
  const u = completion.usage;
  const c = completion.cost;
  const result = await queryable.query<{ late_completion: boolean }>(
    `UPDATE teaching_model_attempts SET
       accounting_status = 'complete',
       late_completion = (accounting_status = 'incomplete'),
       incomplete_reason = NULL,
       outcome = $2,
       fallback_triggered = $3,
       fallback_reason = COALESCE($4, fallback_reason),
       error_code = $5, error_status = $6, error_message = $7,
       usage_available = $8,
       input_tokens_total = $9, cache_read_tokens = $10, cache_write_tokens = $11, fresh_input_tokens = $12,
       output_tokens_total = $13, reasoning_tokens = $14, visible_output_tokens = $15,
       cache_read_reported = $16, cache_write_reported = $17, reasoning_reported = $18,
       usage_unavailable_reason = $19, usage_inconsistent = $20,
       rate_card_version = $21, cost_usd = $22, cost_basis = $23, cost_unavailable_reason = $24,
       budget_breach = $25,
       ttft_ms = $26, ttft_unavailable_reason = $27, total_ms = $28, primary_failure_ms = $29,
       completed_at = $30
     WHERE id = $1 AND accounting_status <> 'complete'
     RETURNING late_completion`,
    [
      id,
      completion.outcome,
      completion.fallbackTriggered,
      completion.fallbackReason ?? null,
      completion.error?.code ?? null,
      completion.error?.status ?? null,
      boundErrorMessage(completion.error?.message),
      u.usageAvailable,
      u.inputTokensTotal,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.freshInputTokens,
      u.outputTokensTotal,
      u.reasoningTokens,
      u.visibleOutputTokens,
      u.cacheReadReported,
      u.cacheWriteReported,
      u.reasoningReported,
      u.usageUnavailableReason,
      u.usageInconsistent,
      c.rateCardVersion,
      c.costUsd,
      c.costBasis,
      c.costUnavailableReason,
      completion.budgetBreach,
      completion.ttftMs,
      completion.ttftUnavailableReason,
      completion.totalMs,
      completion.primaryFailureMs,
      completion.completedAt,
    ],
  );
  const row = result.rows[0];
  return { updated: Boolean(row), lateCompletion: Boolean(row?.late_completion) };
}

// ---------------------------------------------------------------------------
// Sweeper support (plan §7.7 step 4)
// ---------------------------------------------------------------------------

export interface MarkIncompleteOptions {
  /** Epoch seconds. */
  now: number;
  /** `started` rows older than this are `completion_write_lost` (2×maxDuration + retry horizon). */
  deadlineS: number;
  /** A worker with no heartbeat this recent is presumed exited. */
  heartbeatStaleS: number;
}

export interface MarkIncompleteResult {
  marked: number;
  processExit: string[];
  completionWriteLost: string[];
}

/**
 * Mark `started` rows `incomplete`. Both statements are guarded by status and
 * time and therefore idempotent — two sweepers racing over the same rows mark
 * each row once between them and neither errors (READ COMMITTED re-evaluates
 * the WHERE after the row lock is acquired).
 *
 * The worker check runs first because it is the more specific diagnosis: a row
 * whose worker stopped heartbeating can never be completed by that worker
 * (its in-memory retry queue died with it). A row is only judged against the
 * heartbeat once it is at least `heartbeatStaleS` old, so a call started by a
 * worker that has booted but not yet written its first heartbeat is not
 * misread as orphaned.
 */
export async function markIncompleteAttempts(
  queryable: Queryable,
  options: MarkIncompleteOptions,
): Promise<MarkIncompleteResult> {
  const staleBefore = options.now - options.heartbeatStaleS;
  const exited = await queryable.query<{ id: string }>(
    `UPDATE teaching_model_attempts AS a
        SET accounting_status = 'incomplete',
            incomplete_reason = 'process_exit_before_completion',
            cost_unavailable_reason = 'accounting_incomplete'
      WHERE a.accounting_status = 'started'
        AND a.started_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM teaching_model_workers AS w
           WHERE w.worker_id = a.worker_id AND w.last_seen_at >= $1
        )
      RETURNING a.id`,
    [staleBefore],
  );
  const deadlineBefore = options.now - options.deadlineS;
  const lost = await queryable.query<{ id: string }>(
    `UPDATE teaching_model_attempts
        SET accounting_status = 'incomplete',
            incomplete_reason = 'completion_write_lost',
            cost_unavailable_reason = 'accounting_incomplete'
      WHERE accounting_status = 'started'
        AND started_at < $1
      RETURNING id`,
    [deadlineBefore],
  );
  const processExit = exited.rows.map((row) => row.id);
  const completionWriteLost = lost.rows.map((row) => row.id);
  return {
    marked: processExit.length + completionWriteLost.length,
    processExit,
    completionWriteLost,
  };
}

/** Upsert this worker's heartbeat (every 30 s from the sweeper). */
export async function heartbeatWorker(
  queryable: Queryable,
  workerId: string,
  now: number,
): Promise<void> {
  await queryable.query(
    `INSERT INTO teaching_model_workers (worker_id, last_seen_at, started_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
    [workerId, now],
  );
}

/** Retention: forget workers silent for longer than `olderThanS`. */
export async function pruneStaleWorkers(
  queryable: Queryable,
  options: { now: number; olderThanS: number },
): Promise<number> {
  const result = await queryable.query<{ worker_id: string }>(
    `DELETE FROM teaching_model_workers WHERE last_seen_at < $1 RETURNING worker_id`,
    [options.now - options.olderThanS],
  );
  return result.rows.length;
}

/** Health: `started` rows older than the incomplete deadline (a sweeper that is not running). */
export async function countStartedRowsOlderThan(
  queryable: Queryable,
  before: number,
): Promise<number> {
  const result = await queryable.query<{ n: string | number }>(
    `SELECT count(*)::int AS n FROM teaching_model_attempts
      WHERE accounting_status = 'started' AND started_at < $1`,
    [before],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Calibration (plan §8.7)
// ---------------------------------------------------------------------------

export interface CalibrationRow {
  modelString: string;
  proxyRatio: number;
  sampleCount: number;
  lastBreachAt: number | null;
  updatedAt: number;
}

export async function readCalibration(
  queryable: Queryable,
  modelString: string,
): Promise<CalibrationRow | null> {
  const result = await queryable.query<{
    model_string: string;
    proxy_ratio: number;
    sample_count: number;
    last_breach_at: number | null;
    updated_at: number;
  }>(
    `SELECT model_string, proxy_ratio, sample_count, last_breach_at, updated_at
       FROM teaching_model_calibration WHERE model_string = $1`,
    [modelString],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    modelString: row.model_string,
    proxyRatio: Number(row.proxy_ratio),
    sampleCount: Number(row.sample_count),
    lastBreachAt: row.last_breach_at === null ? null : Number(row.last_breach_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Seed a ratio without ever lowering an observed one: the calibration file's
 * value is the floor, production breaches only raise it.
 */
export async function seedCalibration(
  queryable: Queryable,
  modelString: string,
  options: { proxyRatio: number; now: number },
): Promise<void> {
  await queryable.query(
    `INSERT INTO teaching_model_calibration (model_string, proxy_ratio, sample_count, updated_at)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (model_string) DO UPDATE
       SET proxy_ratio = GREATEST(teaching_model_calibration.proxy_ratio, EXCLUDED.proxy_ratio),
           updated_at = CASE
             WHEN EXCLUDED.proxy_ratio > teaching_model_calibration.proxy_ratio THEN EXCLUDED.updated_at
             ELSE teaching_model_calibration.updated_at
           END`,
    [modelString, options.proxyRatio, options.now],
  );
}

/**
 * Post-call breach tightening: `proxy_ratio = max(current, observed)` where
 * the executor passes `observed = reported / count × 1.05`. Monotonic — a
 * ratio never decreases from a breach.
 */
export async function raiseCalibrationRatio(
  queryable: Queryable,
  modelString: string,
  options: { ratio: number; now: number },
): Promise<CalibrationRow> {
  const result = await queryable.query<{
    proxy_ratio: number;
    sample_count: number;
    last_breach_at: number | null;
    updated_at: number;
  }>(
    `INSERT INTO teaching_model_calibration (model_string, proxy_ratio, sample_count, last_breach_at, updated_at)
     VALUES ($1, $2, 1, $3, $3)
     ON CONFLICT (model_string) DO UPDATE
       SET proxy_ratio = GREATEST(teaching_model_calibration.proxy_ratio, EXCLUDED.proxy_ratio),
           sample_count = teaching_model_calibration.sample_count + 1,
           last_breach_at = EXCLUDED.last_breach_at,
           updated_at = EXCLUDED.updated_at
     RETURNING proxy_ratio, sample_count, last_breach_at, updated_at`,
    [modelString, options.ratio, options.now],
  );
  const row = result.rows[0]!;
  return {
    modelString,
    proxyRatio: Number(row.proxy_ratio),
    sampleCount: Number(row.sample_count),
    lastBreachAt: row.last_breach_at === null ? null : Number(row.last_breach_at),
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Reads and reporting (plan §7.7 step 5)
// ---------------------------------------------------------------------------

export async function readAttempt(
  queryable: Queryable,
  id: string,
): Promise<TeachingModelAttemptRow | null> {
  // `Queryable.query` wants an index-signature row; the declared row shape is
  // the documented contract, so the cast is the one place it is asserted.
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT * FROM teaching_model_attempts WHERE id = $1`,
    [id],
  );
  return (result.rows[0] as unknown as TeachingModelAttemptRow | undefined) ?? null;
}

export interface IncompleteAttemptSummary {
  id: string;
  accountingStatus: AccountingStatus;
  incompleteReason: IncompleteReason | null;
  capability: TeachingCapability;
  subjectCode: string;
  modelString: string;
  role: AttemptRole;
  stage: string;
  origin: TeachingOrigin;
  generationAttemptId: string | null;
  turnId: string | null;
  conversationId: string | null;
  helpSessionId: string | null;
  workerId: string;
  startedAt: number;
}

/**
 * Every row whose accounting is not complete: `incomplete` rows always, plus
 * `started` rows older than `startedOlderThanS` when given (a row younger than
 * that is simply in flight).
 */
export async function listIncompleteAttempts(
  queryable: Queryable,
  options: { limit?: number; now?: number; startedOlderThanS?: number } = {},
): Promise<IncompleteAttemptSummary[]> {
  const limit = options.limit ?? 200;
  const includeStartedBefore =
    options.now !== undefined && options.startedOlderThanS !== undefined
      ? options.now - options.startedOlderThanS
      : null;
  const result = await queryable.query<{
    id: string;
    accounting_status: AccountingStatus;
    incomplete_reason: IncompleteReason | null;
    capability: TeachingCapability;
    subject_code: string;
    model_string: string;
    role: AttemptRole;
    stage: string;
    origin: TeachingOrigin;
    generation_attempt_id: string | null;
    turn_id: string | null;
    conversation_id: string | null;
    help_session_id: string | null;
    worker_id: string;
    started_at: number;
  }>(
    `SELECT id, accounting_status, incomplete_reason, capability, subject_code, model_string, role, stage, origin,
            generation_attempt_id, turn_id, conversation_id, help_session_id, worker_id, started_at
       FROM teaching_model_attempts
      WHERE accounting_status = 'incomplete'
         OR ($2::double precision IS NOT NULL AND accounting_status = 'started' AND started_at < $2)
      ORDER BY started_at ASC
      LIMIT $1`,
    [limit, includeStartedBefore],
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountingStatus: row.accounting_status,
    incompleteReason: row.incomplete_reason,
    capability: row.capability,
    subjectCode: row.subject_code,
    modelString: row.model_string,
    role: row.role,
    stage: row.stage,
    origin: row.origin,
    generationAttemptId: row.generation_attempt_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    helpSessionId: row.help_session_id,
    workerId: row.worker_id,
    startedAt: Number(row.started_at),
  }));
}

export type AttemptGroupBy =
  | 'capability'
  | 'subject_code'
  | 'model_string'
  | 'role'
  | 'accounting_status'
  | 'origin'
  | 'stage'
  | 'outcome'
  | 'tenant_id'
  | 'conversation_id'
  | 'student_ref'
  | 'turn_id'
  | 'version_id'
  | 'generation_attempt_id'
  | 'learning_item_id';

const GROUP_BY_COLUMNS: ReadonlySet<AttemptGroupBy> = new Set([
  'capability',
  'subject_code',
  'model_string',
  'role',
  'accounting_status',
  'origin',
  'stage',
  'outcome',
  'tenant_id',
  'conversation_id',
  'student_ref',
  'turn_id',
  'version_id',
  'generation_attempt_id',
  'learning_item_id',
]);

/** Shared row filter for the reporting queries (all optional). */
export interface AttemptReportFilter {
  tenantId?: string;
  /** Epoch seconds, inclusive lower bound on `started_at`. */
  since?: number;
  /** Epoch seconds, exclusive upper bound on `started_at`. */
  until?: number;
  capability?: TeachingCapability | TeachingCapability[];
  origin?: TeachingOrigin;
}

function filterClause(filter: AttemptReportFilter, params: unknown[]): string {
  const where: string[] = [];
  if (filter.tenantId !== undefined) {
    params.push(filter.tenantId);
    where.push(`tenant_id = $${params.length}`);
  }
  if (filter.since !== undefined) {
    params.push(filter.since);
    where.push(`started_at >= $${params.length}`);
  }
  if (filter.until !== undefined) {
    params.push(filter.until);
    where.push(`started_at < $${params.length}`);
  }
  if (filter.capability !== undefined) {
    const list = Array.isArray(filter.capability) ? filter.capability : [filter.capability];
    params.push(list);
    where.push(`capability = ANY($${params.length}::text[])`);
  }
  if (filter.origin !== undefined) {
    params.push(filter.origin);
    where.push(`origin = $${params.length}`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

export interface AttemptAggregateRow {
  group: Partial<Record<AttemptGroupBy, string | null>>;
  /** Completeness line: N attempts, M complete, K incomplete (+ still started), L late-completed. */
  completeness: {
    attempts: number;
    complete: number;
    incomplete: number;
    started: number;
    lateCompleted: number;
    /** True when any row in the group is not complete: sums below are lower bounds. */
    lowerBound: boolean;
  };
  /** Sums over COMPLETE rows only; NULL-usage rows contribute nothing and are counted in `unpriced`. */
  tokens: {
    inputTotal: number;
    freshInput: number;
    cacheRead: number;
    outputTotal: number;
    reasoning: number;
    usageUnavailable: number;
  };
  cost: { usd: number; unpriced: number };
  outcomes: { succeeded: number; fallbackTriggered: number; budgetBreaches: number };
  latency: {
    ttftP50Ms: number | null;
    ttftP95Ms: number | null;
    totalP50Ms: number | null;
    totalP95Ms: number | null;
    primaryFailureP50Ms: number | null;
  };
}

/**
 * Grouped report with an explicit completeness line per group. Every sum is
 * over `complete` rows only; a group with any non-complete row is flagged
 * `lowerBound`. Percentiles use `percentile_cont` over the rows that carry
 * the timing (NULL = unavailable, never zero).
 */
export async function aggregateAttempts(
  queryable: Queryable,
  options: { groupBy: AttemptGroupBy[] } & AttemptReportFilter,
): Promise<AttemptAggregateRow[]> {
  const groupBy = options.groupBy.filter((column) => GROUP_BY_COLUMNS.has(column));
  if (groupBy.length !== options.groupBy.length) {
    throw new Error(`aggregateAttempts: unsupported groupBy column`);
  }
  const params: unknown[] = [];
  const whereClause = filterClause(options, params);
  const groupSelect = groupBy.length ? `${groupBy.join(', ')},` : '';
  const groupClause = groupBy.length
    ? `GROUP BY ${groupBy.join(', ')} ORDER BY ${groupBy.join(', ')}`
    : '';
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT ${groupSelect}
            count(*)::int AS attempts,
            count(*) FILTER (WHERE accounting_status = 'complete')::int AS complete,
            count(*) FILTER (WHERE accounting_status = 'incomplete')::int AS incomplete,
            count(*) FILTER (WHERE accounting_status = 'started')::int AS started,
            count(*) FILTER (WHERE late_completion)::int AS late_completed,
            COALESCE(sum(input_tokens_total) FILTER (WHERE accounting_status = 'complete'), 0)::bigint AS input_total,
            COALESCE(sum(fresh_input_tokens) FILTER (WHERE accounting_status = 'complete'), 0)::bigint AS fresh_input,
            COALESCE(sum(cache_read_tokens) FILTER (WHERE accounting_status = 'complete'), 0)::bigint AS cache_read,
            COALESCE(sum(output_tokens_total) FILTER (WHERE accounting_status = 'complete'), 0)::bigint AS output_total,
            COALESCE(sum(reasoning_tokens) FILTER (WHERE accounting_status = 'complete'), 0)::bigint AS reasoning,
            count(*) FILTER (WHERE accounting_status = 'complete' AND usage_available IS NOT TRUE)::int AS usage_unavailable,
            COALESCE(sum(cost_usd) FILTER (WHERE accounting_status = 'complete'), 0)::numeric AS cost_usd,
            count(*) FILTER (WHERE accounting_status = 'complete' AND cost_usd IS NULL)::int AS unpriced,
            count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
            count(*) FILTER (WHERE fallback_triggered)::int AS fallback_triggered,
            count(*) FILTER (WHERE budget_breach)::int AS budget_breaches,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p95,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS total_p95,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY primary_failure_ms) AS primary_failure_p50
       FROM teaching_model_attempts
       ${whereClause}
       ${groupClause}`,
    params,
  );
  const num = (value: unknown): number => Number(value ?? 0);
  const nullable = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return result.rows.map((row) => {
    const group: Partial<Record<AttemptGroupBy, string | null>> = {};
    for (const column of groupBy) group[column] = (row[column] as string | null) ?? null;
    const complete = num(row.complete);
    const attempts = num(row.attempts);
    return {
      group,
      completeness: {
        attempts,
        complete,
        incomplete: num(row.incomplete),
        started: num(row.started),
        lateCompleted: num(row.late_completed),
        lowerBound: complete < attempts,
      },
      tokens: {
        inputTotal: num(row.input_total),
        freshInput: num(row.fresh_input),
        cacheRead: num(row.cache_read),
        outputTotal: num(row.output_total),
        reasoning: num(row.reasoning),
        usageUnavailable: num(row.usage_unavailable),
      },
      cost: { usd: num(row.cost_usd), unpriced: num(row.unpriced) },
      outcomes: {
        succeeded: num(row.succeeded),
        fallbackTriggered: num(row.fallback_triggered),
        budgetBreaches: num(row.budget_breaches),
      },
      latency: {
        ttftP50Ms: nullable(row.ttft_p50),
        ttftP95Ms: nullable(row.ttft_p95),
        totalP50Ms: nullable(row.total_p50),
        totalP95Ms: nullable(row.total_p95),
        primaryFailureP50Ms: nullable(row.primary_failure_p50),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Fallback rate and budget breaches (P8)
// ---------------------------------------------------------------------------

export interface FallbackBreakdownRow {
  subjectCode: string;
  /** The PRIMARY model of the rows (the fallback is decided per primary attempt). */
  modelString: string;
  primaryAttempts: number;
  fallbackTriggered: number;
  /** `fallback_triggered / primary_attempts`, 0 when no primary attempt. */
  fallbackRate: number;
  /** Count per `fallback_reason` of the primary rows (incl. `unusable_output`). */
  byReason: Record<string, number>;
  /** Fallback rows that themselves succeeded / failed. */
  fallbackSucceeded: number;
  fallbackFailed: number;
}

/**
 * Fallback rate by subject and primary model (ROUTE-02 reporting). Counts
 * every primary row regardless of accounting status (a `started`/`incomplete`
 * primary still proves the attempt) and breaks the triggered ones down by
 * classification, `unusable_output` included.
 */
export async function fallbackBreakdown(
  queryable: Queryable,
  filter: AttemptReportFilter = {},
): Promise<FallbackBreakdownRow[]> {
  const params: unknown[] = [];
  const whereClause = filterClause(filter, params);
  const primaries = await queryable.query<{
    subject_code: string;
    model_string: string;
    fallback_reason: string | null;
    attempts: unknown;
    triggered: unknown;
  }>(
    `SELECT subject_code, model_string, fallback_reason,
            count(*)::int AS attempts,
            count(*) FILTER (WHERE fallback_triggered)::int AS triggered
       FROM teaching_model_attempts
       ${whereClause ? `${whereClause} AND role = 'primary'` : `WHERE role = 'primary'`}
      GROUP BY subject_code, model_string, fallback_reason
      ORDER BY subject_code, model_string, fallback_reason`,
    params,
  );
  const fallbackParams: unknown[] = [];
  const fallbackWhere = filterClause(filter, fallbackParams);
  const fallbacks = await queryable.query<{
    subject_code: string;
    succeeded: unknown;
    failed: unknown;
  }>(
    `SELECT subject_code,
            count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
            count(*) FILTER (WHERE outcome IS NOT NULL AND outcome <> 'succeeded')::int AS failed
       FROM teaching_model_attempts
       ${fallbackWhere ? `${fallbackWhere} AND role = 'fallback'` : `WHERE role = 'fallback'`}
      GROUP BY subject_code`,
    fallbackParams,
  );
  const fallbackBySubject = new Map(
    fallbacks.rows.map((row) => [row.subject_code, { succeeded: Number(row.succeeded), failed: Number(row.failed) }]),
  );
  const out = new Map<string, FallbackBreakdownRow>();
  for (const row of primaries.rows) {
    const key = `${row.subject_code}\u0000${row.model_string}`;
    let entry = out.get(key);
    if (!entry) {
      const fb = fallbackBySubject.get(row.subject_code) ?? { succeeded: 0, failed: 0 };
      entry = {
        subjectCode: row.subject_code,
        modelString: row.model_string,
        primaryAttempts: 0,
        fallbackTriggered: 0,
        fallbackRate: 0,
        byReason: {},
        fallbackSucceeded: fb.succeeded,
        fallbackFailed: fb.failed,
      };
      out.set(key, entry);
    }
    entry.primaryAttempts += Number(row.attempts);
    const triggered = Number(row.triggered);
    entry.fallbackTriggered += triggered;
    if (triggered > 0 && row.fallback_reason) {
      entry.byReason[row.fallback_reason] = (entry.byReason[row.fallback_reason] ?? 0) + triggered;
    }
  }
  for (const entry of out.values()) {
    entry.fallbackRate = entry.primaryAttempts ? entry.fallbackTriggered / entry.primaryAttempts : 0;
  }
  return [...out.values()];
}

export interface BudgetBreachRow {
  id: string;
  capability: TeachingCapability;
  subjectCode: string;
  modelString: string;
  role: AttemptRole;
  stage: string;
  origin: TeachingOrigin;
  turnId: string | null;
  conversationId: string | null;
  budgetEstimateTokens: number | null;
  budgetCounterKind: BudgetCounterKind | null;
  budgetEffectiveCap: number | null;
  inputTokensTotal: number | null;
  startedAt: number;
}

/** Every row whose reported input exceeded HARD_CAP (`budget_breach = true`), newest first. */
export async function listBudgetBreaches(
  queryable: Queryable,
  filter: AttemptReportFilter = {},
  limit = 200,
): Promise<BudgetBreachRow[]> {
  const params: unknown[] = [];
  const whereClause = filterClause(filter, params);
  params.push(limit);
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT id, capability, subject_code, model_string, role, stage, origin, turn_id, conversation_id,
            budget_estimate_tokens, budget_counter_kind, budget_effective_cap, input_tokens_total, started_at
       FROM teaching_model_attempts
       ${whereClause ? `${whereClause} AND budget_breach` : 'WHERE budget_breach'}
      ORDER BY started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const nullable = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  return result.rows.map((row) => ({
    id: row.id as string,
    capability: row.capability as TeachingCapability,
    subjectCode: row.subject_code as string,
    modelString: row.model_string as string,
    role: row.role as AttemptRole,
    stage: row.stage as string,
    origin: row.origin as TeachingOrigin,
    turnId: (row.turn_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    budgetEstimateTokens: nullable(row.budget_estimate_tokens),
    budgetCounterKind: (row.budget_counter_kind as BudgetCounterKind | null) ?? null,
    budgetEffectiveCap: nullable(row.budget_effective_cap),
    inputTokensTotal: nullable(row.input_tokens_total),
    startedAt: Number(row.started_at),
  }));
}
