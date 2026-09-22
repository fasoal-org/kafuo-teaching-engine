/**
 * Teaching model executor (Kafuo R1 contracts §7, plan §7.3, §7.7, §8.7).
 *
 * The ONLY caller of `callLLM` / `streamLLM` for teaching stages. Per subject
 * policy it runs Primary → (Fallback) with, per provider call:
 *
 *   started ledger row (awaited, BEFORE the call)
 *     → one provider call (`maxRetries: 0`, `AbortSignal.any([caller, timeout])`,
 *       `maxOutputTokens` from the registry, thinking from the policy)
 *     → classification (classify-failure.ts, ROUTE-02)
 *     → completion update (awaited, BEFORE the result is released)
 *
 * There is NO same-model retry: each provider call is one attempt and one
 * ledger row; the fallback is the retry. Failures that are our defect
 * (`request_rejected`), a safety refusal, or a caller abort never fall back.
 *
 * Budget assertion (contracts §0 H1): ONLY for the conversational
 * capabilities (`free_chat`, `help`), the final messages are re-counted with
 * the target's counter; over the effective cap → `budget_assertion_failed`
 * on the started row and `BudgetAssertionError`, no provider call. Generation
 * calls are never budget-asserted and their budget columns stay NULL.
 *
 * Accounting: the started row failing to insert (after one retry) means NO
 * provider call and `AccountingUnavailableError`. The completion goes through
 * the caller's `completeAttempt` hook when supplied (a conversational turn
 * joins its own transaction), else directly with 3 inline retries; a write
 * that still fails is queued in the bounded in-memory retry and the row
 * stays `started` for the sweeper.
 *
 * Nothing here touches the local filesystem, and no prompt or student text is
 * ever logged.
 */
import { randomUUID } from 'node:crypto';

import type { ModelMessage } from 'ai';
import type { Queryable } from '@openmaic/storage/document/pg';

import { callLLM, streamLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  completeAttempt,
  insertStartedAttempt,
  raiseCalibrationRatio,
  readCalibration,
  type AttemptAssociation,
  type AttemptBudgetColumns,
  type AttemptCompletionInput,
  type AttemptOutcome,
  type AttemptRole,
  type TeachingCapability,
  type TeachingOrigin,
} from '@/lib/persistence/teaching-model-attempts';
import { attributeUsage, type AttributedUsage, USAGE_MISSING } from '@/lib/usage/attribute';
import { normalizeUsage } from '@/lib/usage/normalize';
import {
  classifyError,
  classifyResult,
  type Classification,
  type FinishReason,
} from '@/lib/server/teaching-model/classify-failure';
import { enqueueLedgerCompletion } from '@/lib/server/teaching-model/ledger-retry-queue';
import { loadRateCard, type RateCard } from '@/lib/server/teaching-model/rate-card';
import { checkStructuredOutput, isRenderableText } from '@/lib/server/teaching-model/renderability';
import type {
  ResolvedSubjectPolicy,
  ResolvedTarget,
} from '@/lib/server/teaching-model/resolve-policy';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import {
  budgetMessagesOf,
  countExactTokens,
  countTokens,
  effectiveCap,
  HARD_CAP,
  resolveProxyRatio,
  type ProxyRatioReader,
} from '@/lib/server/tutor/token-budget';

const log = createLogger('TeachingModelExecutor');

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type { TeachingCapability, TeachingOrigin };
export type GenerationAssociation = Extract<AttemptAssociation, { kind: 'generation' }>;
export type TurnAssociation = Extract<AttemptAssociation, { kind: 'turn' }>;

export interface TeachingCallContext {
  tenantId: string;
  capability: TeachingCapability;
  /** Ledger `stage` and the `callLLM` source label (contracts §1). */
  stage: string;
  origin: TeachingOrigin;
  association: GenerationAssociation | TurnAssociation;
  /** The assembler's estimate (conversational only); informational — the executor re-counts. */
  budget?: { estimate: number; counterKind: 'exact' | 'proxy'; effectiveCap: number };
  signal?: AbortSignal;
  /**
   * Conversational turns: run the completion UPDATE inside the caller's own
   * transaction (contracts §7). Absent, the executor writes directly.
   */
  completeAttempt?: (attemptId: string, completion: AttemptCompletionInput) => Promise<void>;
}

export type StructuredOutputSpec = { kind: 'json'; validate(text: string): unknown };

export interface TeachingCallParams {
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  maxOutputTokens?: number;
  output?: 'text' | StructuredOutputSpec;
}

export interface TeachingCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Source visuals attached to the call: the target must have vision (AMB-08). */
  images?: ReadonlyArray<unknown>;
  // --- dependency seams (tests, or a caller that already holds a client) ---
  queryable?: Queryable;
  now?: () => number;
  workerId?: string;
  rateCard?: RateCard;
  proxyRatioReader?: ProxyRatioReader;
  idFactory?: () => string;
  completionRetryDelaysMs?: readonly number[];
}

export interface TeachingCallTimings {
  /** Epoch ms when the first attempt started. */
  startedAt: number;
  ttftMs: number | null;
  totalMs: number;
  primaryFailureMs: number | null;
}

export interface TeachingCallResult {
  text: string;
  parsed?: unknown;
  servedBy: AttemptRole;
  attemptIds: string[];
  usage: AttributedUsage | null;
  timings: TeachingCallTimings;
}

export interface TeachingStreamSink {
  onDelta(text: string): void;
  /** A post-delta failure: the client discards partial text; the fallback streams from scratch. */
  onRestart(): void;
  onFinish(result: TeachingCallResult): void | Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 110_000;
const COMPLETION_RETRY_DELAYS_MS = [100, 300, 900] as const;
const CONVERSATIONAL: ReadonlySet<TeachingCapability> = new Set(['free_chat', 'help']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TeachingModelUnavailableError extends Error {
  readonly code = 'TEACHING_MODEL_UNAVAILABLE' as const;
  readonly status = 503;
  readonly retryable: boolean;
  readonly attemptIds: string[];
  readonly outcomes: Array<{ role: AttemptRole; outcome: AttemptOutcome }>;

  constructor(
    message: string,
    options: {
      attemptIds: string[];
      outcomes: Array<{ role: AttemptRole; outcome: AttemptOutcome }>;
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = 'TeachingModelUnavailableError';
    this.attemptIds = options.attemptIds;
    this.outcomes = options.outcomes;
    this.retryable = options.retryable;
  }
}

export class AccountingUnavailableError extends Error {
  readonly code = 'ACCOUNTING_UNAVAILABLE' as const;
  readonly status = 503;
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AccountingUnavailableError';
  }
}

export class BudgetAssertionError extends Error {
  readonly code = 'BUDGET_ASSERTION_FAILED' as const;
  readonly status = 503;
  readonly retryable = true;
  readonly attemptId: string;
  readonly estimate: number;
  readonly effectiveCap: number;
  readonly counterKind: 'exact' | 'proxy';

  constructor(options: {
    attemptId: string;
    estimate: number;
    effectiveCap: number;
    counterKind: 'exact' | 'proxy';
    modelString: string;
  }) {
    super(
      `budget assertion failed: ${options.estimate} ${options.counterKind} tokens > effective cap ${options.effectiveCap} for ${options.modelString}`,
    );
    this.name = 'BudgetAssertionError';
    this.attemptId = options.attemptId;
    this.estimate = options.estimate;
    this.effectiveCap = options.effectiveCap;
    this.counterKind = options.counterKind;
  }
}

export class TeachingCallAbortedError extends Error {
  readonly code = 'ABORTED' as const;
  readonly attemptIds: string[];

  constructor(attemptIds: string[]) {
    super('teaching call aborted by the caller');
    this.name = 'TeachingCallAbortedError';
    this.attemptIds = attemptIds;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Deps {
  queryable: Queryable;
  now: () => number;
  workerId: string;
  rateCard: RateCard;
  proxyRatioReader: ProxyRatioReader;
  newId: () => string;
  completionRetryDelaysMs: readonly number[];
}

async function resolveDeps(opts: TeachingCallOptions): Promise<Deps> {
  const queryable =
    opts.queryable ??
    ((await getServerPersistenceProvider(process.env.DATABASE_URL ?? ''))
      .pool as unknown as Queryable);
  return {
    queryable,
    now: opts.now ?? Date.now,
    workerId: opts.workerId ?? currentWorkerId(),
    rateCard: opts.rateCard ?? loadRateCard(),
    proxyRatioReader:
      opts.proxyRatioReader ??
      (async (modelString) => (await readCalibration(queryable, modelString))?.proxyRatio ?? null),
    newId: opts.idFactory ?? (() => `tma-${randomUUID()}`),
    completionRetryDelaysMs: opts.completionRetryDelaysMs ?? COMPLETION_RETRY_DELAYS_MS,
  };
}

interface PlannedTarget {
  target: ResolvedTarget;
  /** Set when the target was chosen before any call (e.g. the primary lacks vision). */
  preCallFallbackReason: string | null;
}

function needsVision(params: TeachingCallParams, opts: TeachingCallOptions): boolean {
  if (opts.images && opts.images.length > 0) return true;
  for (const message of params.messages ?? []) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content as ReadonlyArray<{ type?: string }>) {
      if (part.type === 'image' || part.type === 'file') return true;
    }
  }
  return false;
}

/**
 * Primary → Fallback, unless the call carries visuals and the primary cannot
 * see them (AMB-08): then the fallback is chosen deterministically before
 * any call, with `fallback_reason = 'primary_lacks_vision'` on its row.
 */
function planTargets(policy: ResolvedSubjectPolicy, vision: boolean): PlannedTarget[] {
  const hasVision = (t: ResolvedTarget) => t.modelInfo.capabilities?.vision === true;
  if (!vision) {
    return [
      { target: policy.primary, preCallFallbackReason: null },
      { target: policy.fallback, preCallFallbackReason: null },
    ];
  }
  const plan: PlannedTarget[] = [];
  if (hasVision(policy.primary)) plan.push({ target: policy.primary, preCallFallbackReason: null });
  if (hasVision(policy.fallback)) {
    plan.push({
      target: policy.fallback,
      preCallFallbackReason: hasVision(policy.primary) ? null : 'primary_lacks_vision',
    });
  }
  return plan;
}

function callerSignalOf(
  ctx: TeachingCallContext,
  opts: TeachingCallOptions,
): AbortSignal | undefined {
  return ctx.signal ?? opts.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Step 1: the started row. One immediate retry, then refuse — no row, no call. */
async function startRow(
  deps: Deps,
  ctx: TeachingCallContext,
  policy: ResolvedSubjectPolicy,
  target: ResolvedTarget,
  attemptIndex: number,
  budget: AttemptBudgetColumns | null,
  fallbackReason: string | null,
  startedAtMs: number,
): Promise<string> {
  const id = deps.newId();
  const row = {
    id,
    tenantId: ctx.tenantId,
    capability: ctx.capability,
    subjectCode: policy.subjectCode,
    policyVersion: policy.policyVersion,
    stage: ctx.stage,
    providerId: target.providerId,
    modelId: target.modelId,
    modelString: target.modelString,
    thinkingLabel: target.thinkingLabel,
    role: target.role,
    attemptIndex,
    origin: ctx.origin,
    association: ctx.association,
    budget,
    fallbackReason,
    workerId: deps.workerId,
    startedAt: startedAtMs / 1000,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await insertStartedAttempt(deps.queryable, row);
      return id;
    } catch (error) {
      lastError = error;
    }
  }
  log.error(
    JSON.stringify({
      event: 'teaching_model.started_row_failed',
      stage: ctx.stage,
      capability: ctx.capability,
    }),
  );
  throw new AccountingUnavailableError(
    'the ledger started row could not be written; no model call was made',
    lastError,
  );
}

/**
 * Step 2: the completion. Through the caller's transaction hook when given
 * (its failure is the caller's turn failure and propagates); else directly
 * with inline retries, then the in-memory queue.
 */
async function finishRow(
  deps: Deps,
  ctx: TeachingCallContext,
  attemptId: string,
  completion: AttemptCompletionInput,
): Promise<void> {
  if (ctx.completeAttempt) {
    await ctx.completeAttempt(attemptId, completion);
    return;
  }
  const write = async () => {
    const result = await completeAttempt(deps.queryable, attemptId, completion);
    if (result.lateCompletion) {
      log.warn(JSON.stringify({ event: 'teaching_model.late_completion', attemptId }));
    }
  };
  let lastError: unknown;
  for (let attempt = 0; attempt <= deps.completionRetryDelaysMs.length; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      lastError = error;
      const delay = deps.completionRetryDelaysMs[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  log.error(
    JSON.stringify({
      event: 'teaching_model.ledger_completion_deferred',
      attemptId,
      error: lastError instanceof Error ? lastError.name : 'Error',
    }),
  );
  enqueueLedgerCompletion(attemptId, write, { now: deps.now() });
}

interface AttemptOutcomeRecord {
  classification: Classification;
  text: string;
  parsed?: unknown;
  usage: AttributedUsage;
  finishReason: FinishReason;
  ttftMs: number | null;
  ttftUnavailableReason: string | null;
  totalMs: number;
  /** Streaming: visible deltas reached the sink before the outcome was known. */
  deltasEmitted: boolean;
}

interface CallPlan {
  target: ResolvedTarget;
  params: TeachingCallParams;
  timeoutMs: number;
  callerSignal: AbortSignal | undefined;
  stage: string;
}

type ProviderCallParams = Parameters<typeof callLLM>[0];

/**
 * The exact provider request: the policy's model, the caller's prompt or
 * messages, the registry's output window, NO SDK retries (the fallback is the
 * retry), and the combined abort signal. The AI SDK's `Prompt` is a union
 * (`prompt` XOR `messages`), hence the two explicit branches.
 */
function providerParams(plan: CallPlan, abortSignal: AbortSignal): ProviderCallParams {
  const { params, target } = plan;
  const settings = {
    model: target.model,
    ...(params.system !== undefined ? { system: params.system } : {}),
    maxOutputTokens: params.maxOutputTokens ?? target.modelInfo.outputWindow,
    maxRetries: 0,
    abortSignal,
  };
  return params.messages
    ? { ...settings, messages: params.messages }
    : { ...settings, prompt: params.prompt ?? '' };
}

function judgeOutput(
  params: TeachingCallParams,
  text: string,
  finishReason: FinishReason,
): {
  classification: Classification;
  parsed?: unknown;
} {
  const structured = params.output && params.output !== 'text' ? params.output : null;
  if (structured) {
    const check = checkStructuredOutput(text, structured.validate);
    const classification = classifyResult({
      text,
      finishReason,
      renderable: true,
      structuredValid: check.ok,
      structuredError: check.ok ? null : check.error,
    });
    return check.ok ? { classification, parsed: check.parsed } : { classification };
  }
  return {
    classification: classifyResult({
      text,
      finishReason,
      renderable: isRenderableText(text),
      structuredValid: null,
    }),
  };
}

function usageFrom(rawUsage: unknown, target: ResolvedTarget, rateCard: RateCard): AttributedUsage {
  const normalized = rawUsage ? normalizeUsage(rawUsage as never) : null;
  return attributeUsage(normalized, target.providerId, target.modelString, rateCard);
}

/** One non-streaming provider call, classified. Never throws for provider failures. */
async function runCall(plan: CallPlan, deps: Deps): Promise<AttemptOutcomeRecord> {
  const startedAt = deps.now();
  const timeoutSignal = AbortSignal.timeout(plan.timeoutMs);
  const abortSignal = plan.callerSignal
    ? AbortSignal.any([plan.callerSignal, timeoutSignal])
    : timeoutSignal;
  const context = () => ({
    timedOut: timeoutSignal.aborted,
    callerAborted: plan.callerSignal?.aborted === true,
  });
  try {
    const result = await callLLM(
      providerParams(plan, abortSignal),
      plan.stage,
      undefined,
      plan.target.thinking,
    );
    const text = typeof result.text === 'string' ? result.text : '';
    const finishReason = result.finishReason as FinishReason;
    const usage = usageFrom(result.totalUsage ?? result.usage, plan.target, deps.rateCard);
    const judged = judgeOutput(plan.params, text, finishReason);
    return {
      classification: judged.classification,
      text,
      parsed: judged.parsed,
      usage,
      finishReason,
      ttftMs: null,
      ttftUnavailableReason: 'non_streaming',
      totalMs: deps.now() - startedAt,
      deltasEmitted: false,
    };
  } catch (error) {
    return {
      classification: classifyError(error, context()),
      text: '',
      usage: attributeUsage(null, plan.target.providerId, plan.target.modelString, deps.rateCard),
      finishReason: 'error',
      ttftMs: null,
      ttftUnavailableReason: 'failed_before_response',
      totalMs: deps.now() - startedAt,
      deltasEmitted: false,
    };
  }
}

interface StreamPartShape {
  type: string;
  text?: string;
  error?: unknown;
  finishReason?: FinishReason;
}

interface StreamResultShape {
  fullStream: AsyncIterable<unknown>;
  totalUsage?: PromiseLike<unknown>;
  usage?: PromiseLike<unknown>;
  finishReason?: PromiseLike<unknown>;
}

/**
 * One streaming provider call. Visible text deltas go to `onDelta` as they
 * arrive; TTFT is the first NON-EMPTY visible text delta (reasoning deltas
 * excluded). "Unrenderable" is judged on the complete text at finish.
 */
async function runStream(
  plan: CallPlan,
  deps: Deps,
  onDelta: (text: string) => void,
): Promise<AttemptOutcomeRecord> {
  const startedAt = deps.now();
  const timeoutSignal = AbortSignal.timeout(plan.timeoutMs);
  const abortSignal = plan.callerSignal
    ? AbortSignal.any([plan.callerSignal, timeoutSignal])
    : timeoutSignal;
  const context = () => ({
    timedOut: timeoutSignal.aborted,
    callerAborted: plan.callerSignal?.aborted === true,
  });

  let text = '';
  let ttftMs: number | null = null;
  let deltasEmitted = false;
  let streamError: unknown;
  let sawError = false;
  let finishReason: FinishReason;
  let stream: StreamResultShape | undefined;

  try {
    stream = streamLLM(
      providerParams(plan, abortSignal) as Parameters<typeof streamLLM>[0],
      plan.stage,
      plan.target.thinking,
    ) as unknown as StreamResultShape;
    for await (const raw of stream.fullStream) {
      const part = raw as StreamPartShape;
      if (part.type === 'text-delta') {
        const delta = part.text ?? '';
        if (delta.length === 0) continue;
        if (!deltasEmitted) {
          deltasEmitted = true;
          ttftMs = deps.now() - startedAt;
        }
        text += delta;
        onDelta(delta);
      } else if (part.type === 'error') {
        sawError = true;
        streamError = part.error;
      } else if (part.type === 'abort') {
        sawError = true;
        streamError =
          streamError ?? Object.assign(new Error('stream aborted'), { name: 'AbortError' });
      } else if (part.type === 'finish') {
        finishReason = part.finishReason;
      }
    }
  } catch (error) {
    sawError = true;
    streamError = error;
  }

  const totalMs = deps.now() - startedAt;
  let rawUsage: unknown;
  if (stream) {
    try {
      rawUsage = await (stream.totalUsage ?? stream.usage);
    } catch {
      rawUsage = undefined;
    }
    if (finishReason === undefined && stream.finishReason) {
      try {
        finishReason = (await stream.finishReason) as FinishReason;
      } catch {
        /* unavailable */
      }
    }
  }
  const usage = usageFrom(rawUsage, plan.target, deps.rateCard);
  const ttftUnavailableReason = deltasEmitted ? null : 'no_visible_delta';

  if (sawError) {
    return {
      classification: classifyError(streamError, context()),
      text,
      usage,
      finishReason: 'error',
      ttftMs,
      ttftUnavailableReason,
      totalMs,
      deltasEmitted,
    };
  }
  const judged = judgeOutput(plan.params, text, finishReason);
  return {
    classification: judged.classification,
    text,
    parsed: judged.parsed,
    usage,
    finishReason,
    ttftMs,
    ttftUnavailableReason,
    totalMs,
    deltasEmitted,
  };
}

/**
 * Budget assertion for conversational calls: the target's counter over the
 * FINAL messages. Returns the columns for the started row and whether the
 * request must be refused.
 */
async function assertBudget(
  deps: Deps,
  ctx: TeachingCallContext,
  target: ResolvedTarget,
  params: TeachingCallParams,
): Promise<{ columns: AttemptBudgetColumns; exactCount: number; overCap: boolean } | null> {
  if (!CONVERSATIONAL.has(ctx.capability)) return null;
  const messages = budgetMessagesOf(params);
  const exactCount = countExactTokens(messages);
  const proxyRatio =
    target.counterKind === 'proxy'
      ? await resolveProxyRatio(target.modelString, deps.proxyRatioReader)
      : undefined;
  const estimate = countTokens(messages, target.counterKind, target.modelString, { proxyRatio });
  const cap = effectiveCap(target.counterKind);
  return {
    columns: { estimateTokens: estimate, counterKind: target.counterKind, effectiveCap: cap },
    exactCount,
    overCap: estimate > cap,
  };
}

/** Post-call verification (plan §8.7): breach → loud log + proxy ratio tightening. */
async function verifyBudget(
  deps: Deps,
  ctx: TeachingCallContext,
  target: ResolvedTarget,
  attemptId: string,
  budget: { exactCount: number } | null,
  usage: AttributedUsage,
): Promise<boolean | null> {
  if (!budget) return null;
  const reported = usage.classes.inputTokensTotal;
  if (reported === null) return null;
  const breach = reported > HARD_CAP;
  if (!breach) return false;
  log.error(
    JSON.stringify({
      event: 'teaching_model.budget_breach',
      attemptId,
      stage: ctx.stage,
      modelString: target.modelString,
      reported,
      hardCap: HARD_CAP,
    }),
  );
  if (target.counterKind === 'proxy' && budget.exactCount > 0) {
    const ratio = (reported / budget.exactCount) * 1.05;
    try {
      await raiseCalibrationRatio(deps.queryable, target.modelString, {
        ratio,
        now: deps.now() / 1000,
      });
    } catch (error) {
      log.error('proxy ratio tightening failed:', error instanceof Error ? error.name : 'Error');
    }
  }
  return true;
}

function completionOf(
  record: AttemptOutcomeRecord,
  options: {
    fallbackTriggered: boolean;
    fallbackReason: string | null;
    primaryFailureMs: number | null;
    budgetBreach: boolean | null;
    completedAtMs: number;
  },
): AttemptCompletionInput {
  const c = record.classification;
  return {
    outcome: c.outcome,
    fallbackTriggered: options.fallbackTriggered,
    fallbackReason: options.fallbackReason,
    error:
      c.outcome === 'succeeded'
        ? null
        : { code: c.errorCode, status: c.errorStatus, message: c.errorMessage },
    usage: record.usage.classes,
    cost: record.usage.cost,
    budgetBreach: options.budgetBreach,
    ttftMs: record.ttftMs,
    ttftUnavailableReason: record.ttftUnavailableReason,
    totalMs: record.totalMs,
    primaryFailureMs: options.primaryFailureMs,
    completedAt: options.completedAtMs / 1000,
  };
}

type AttemptRunner = (plan: CallPlan) => Promise<AttemptOutcomeRecord>;

/**
 * The Primary → Fallback loop shared by both entry points. `run` performs one
 * provider call; `onRestart` is invoked when a streaming attempt failed after
 * visible deltas and another attempt follows.
 */
async function execute(
  policy: ResolvedSubjectPolicy,
  ctx: TeachingCallContext,
  params: TeachingCallParams,
  opts: TeachingCallOptions,
  deps: Deps,
  run: AttemptRunner,
  onRestart?: () => void,
): Promise<TeachingCallResult> {
  const plan = planTargets(policy, needsVision(params, opts));
  if (plan.length === 0) {
    throw new TeachingModelUnavailableError(
      `subject ${policy.subjectCode}: no route in the policy can see the call's source visuals`,
      { attemptIds: [], outcomes: [], retryable: false },
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callerSignal = callerSignalOf(ctx, opts);
  const attemptIds: string[] = [];
  const outcomes: Array<{ role: AttemptRole; outcome: AttemptOutcome }> = [];
  const firstStartedAt = deps.now();
  let primaryFailureMs: number | null = null;

  for (let index = 0; index < plan.length; index += 1) {
    const { target, preCallFallbackReason } = plan[index]!;
    const hasNext = index < plan.length - 1;
    const attemptIndex = index + 1;
    const startedAtMs = deps.now();

    // Budget assertion first (conversational only): a refused request still
    // proves the attempt happened, so it gets a started row and a completion.
    const budget = await assertBudget(deps, ctx, target, params);
    const attemptId = await startRow(
      deps,
      ctx,
      policy,
      target,
      attemptIndex,
      budget?.columns ?? null,
      preCallFallbackReason,
      startedAtMs,
    );
    attemptIds.push(attemptId);

    if (budget?.overCap) {
      const now = deps.now();
      await finishRow(deps, ctx, attemptId, {
        outcome: 'budget_assertion_failed',
        fallbackTriggered: false,
        fallbackReason: preCallFallbackReason,
        error: {
          code: 'budget_assertion_failed',
          status: null,
          message: `${budget.columns.estimateTokens} ${budget.columns.counterKind} tokens > cap ${budget.columns.effectiveCap}`,
        },
        usage: { ...USAGE_MISSING },
        cost: {
          rateCardVersion: null,
          costUsd: null,
          costBasis: null,
          costUnavailableReason: 'usage_missing',
        },
        budgetBreach: null,
        ttftMs: null,
        ttftUnavailableReason: 'not_called',
        totalMs: now - startedAtMs,
        primaryFailureMs,
        completedAt: now / 1000,
      });
      throw new BudgetAssertionError({
        attemptId,
        estimate: budget.columns.estimateTokens,
        effectiveCap: budget.columns.effectiveCap,
        counterKind: budget.columns.counterKind,
        modelString: target.modelString,
      });
    }

    const record = await run({ target, params, timeoutMs, callerSignal, stage: ctx.stage });
    const succeeded = record.classification.outcome === 'succeeded';
    const willFallBack = !succeeded && record.classification.fallbackEligible && hasNext;
    const budgetBreach = await verifyBudget(deps, ctx, target, attemptId, budget, record.usage);
    const completedAtMs = deps.now();

    await finishRow(
      deps,
      ctx,
      attemptId,
      completionOf(record, {
        fallbackTriggered: willFallBack,
        fallbackReason: willFallBack ? record.classification.outcome : preCallFallbackReason,
        primaryFailureMs: target.role === 'fallback' ? primaryFailureMs : null,
        budgetBreach,
        completedAtMs,
      }),
    );
    outcomes.push({ role: target.role, outcome: record.classification.outcome });

    if (succeeded) {
      return {
        text: record.text,
        ...(record.parsed !== undefined ? { parsed: record.parsed } : {}),
        servedBy: target.role,
        attemptIds,
        usage: record.usage.classes.usageAvailable ? record.usage : null,
        timings: {
          startedAt: firstStartedAt,
          ttftMs: record.ttftMs,
          totalMs: completedAtMs - firstStartedAt,
          primaryFailureMs,
        },
      };
    }

    log.warn(
      JSON.stringify({
        event: 'teaching_model.attempt_failed',
        attemptId,
        stage: ctx.stage,
        role: target.role,
        modelString: target.modelString,
        outcome: record.classification.outcome,
        errorCode: record.classification.errorCode,
        errorStatus: record.classification.errorStatus,
        fallback: willFallBack,
      }),
    );

    if (willFallBack) {
      primaryFailureMs = completedAtMs - startedAtMs;
      if (record.deltasEmitted) onRestart?.();
      continue;
    }
    if (record.classification.outcome === 'aborted') throw new TeachingCallAbortedError(attemptIds);
    break;
  }

  const last = outcomes[outcomes.length - 1]!;
  // A safety refusal or our own bad request is not "try again later".
  const retryable = last.outcome !== 'safety_refused' && last.outcome !== 'request_rejected';
  throw new TeachingModelUnavailableError(
    `subject ${policy.subjectCode} (${ctx.stage}): ${outcomes.map((o) => `${o.role}=${o.outcome}`).join(', ')}`,
    { attemptIds, outcomes, retryable },
  );
}

// ---------------------------------------------------------------------------
// Public entry points (contracts §7)
// ---------------------------------------------------------------------------

export async function executeTeachingCall(
  policy: ResolvedSubjectPolicy,
  ctx: TeachingCallContext,
  params: TeachingCallParams,
  opts: TeachingCallOptions = {},
): Promise<TeachingCallResult> {
  const deps = await resolveDeps(opts);
  return execute(policy, ctx, params, opts, deps, (plan) => runCall(plan, deps));
}

export async function executeTeachingStream(
  policy: ResolvedSubjectPolicy,
  ctx: TeachingCallContext,
  params: TeachingCallParams,
  sink: TeachingStreamSink,
  opts: TeachingCallOptions = {},
): Promise<TeachingCallResult> {
  const deps = await resolveDeps(opts);
  const result = await execute(
    policy,
    ctx,
    params,
    opts,
    deps,
    (plan) => runStream(plan, deps, (delta) => sink.onDelta(delta)),
    () => sink.onRestart(),
  );
  await sink.onFinish(result);
  return result;
}
