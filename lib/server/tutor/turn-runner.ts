/**
 * Conversational turn runner (Kafuo R1 contracts §0 H2/M1/M3/L1, §5; plan
 * §4.2, §7.7, §8.4, §8.6, §8.7, §9.1). Shared by Free Chat now and Help
 * later: the capability-specific parts (assessment, retrieval, Scene
 * grounding, titles) arrive through `TurnPlan.prepare` / `afterCommit`; the
 * order below is fixed here and nowhere else.
 *
 *   grant → ownership            (the route / service, before this runner)
 *   → idempotent turn insert     replay `completed` as SSE — free for a
 *                                charged turn, the released reservation
 *                                re-opened under the same key for a
 *                                released turn (M-1); `generating`
 *                                younger than the route deadline → 409
 *                                TURN_IN_PROGRESS + Retry-After; stale
 *                                generating → treated as failed; `failed` →
 *                                new generation under turn_attempt + 1
 *   → guard pre-check            directive + `safety.triggered`; a guard
 *                                exception → boundary reply, no model call
 *   → prepare                    assessment (+ probe / retrieval) / Scene
 *                                grounding; a D-18 SUBJECT_NO_LONGER_AVAILABLE
 *                                refusal fails the student row before any
 *                                reservation
 *   → clarification              Free Chat only (discovery-first P7, D-8 (a)):
 *                                a deterministic template, persisted and
 *                                streamed as text_delta — no model call, no
 *                                reservation, no finalize
 *   → assemble under budget      REQUEST_TOO_LARGE refused BEFORE any reservation
 *   → meter reserve              refused → ALLOWANCE_EXHAUSTED (403
 *                                ACCOUNT_INACTIVE for `account_inactive`);
 *                                unreachable → METER_UNAVAILABLE; all before
 *                                any ledger row or model call. Ungated
 *                                (`reservationId: null`, ET-04) → the turn
 *                                runs with no outbox row and no finalize
 *   → SSE stream opens           turn_start → grounding → executor (started
 *                                row → provider → completion via the hook,
 *                                collected for the turn transaction)
 *   → post-check                 a violating reply is replaced by the boundary
 *   → completion transaction     tutor message + student status + ledger
 *                                completions + tutor_turn_groundings + outbox
 *                                row (provisional `not_delivered` + reason,
 *                                upgraded to `delivered` after `done`; a
 *                                complete SAFETY_BOUNDARY reply is delivered,
 *                                L1; none when ungated)
 *   → commit → done | error      accountingComplete is always true (M1)
 *   → inline finalize            post-commit, best effort (M3); skipped when ungated
 *   → afterCommit                title / compaction, non-blocking for the student
 *
 * Every refusal after a successful reservation still runs the completion
 * transaction with a `not_delivered` outbox row, so nothing is ever left
 * `pending` for the sweeper by a refusal (H2). Nothing here logs prompt or
 * student text (§9.1).
 *
 * D-3 (owner charging decision): an AI turn is charged ONLY when the whole
 * answer was delivered — the server wrote the complete answer INCLUDING its
 * `done` end marker while the stream was still open. Every incomplete answer
 * is released (`not_delivered`): provider failure, fallbacks exhausted, our
 * timeout, a safety cut-off mid-answer, the student pressing stop, a network
 * drop, a commit failure with partial text. A complete safety-boundary reply
 * (the model declines in full) IS a full answer and is charged (L1). The
 * outbox row is therefore enqueued provisionally `not_delivered` inside the
 * completion transaction (nothing is ever left `pending` by the turn, H2) and
 * upgraded to `delivered` only after `done` went out on a live stream. No
 * guard against "stop just before the end": a process death between commit
 * and the upgrade releases a delivered answer.
 * If the completion transaction itself cannot be written, no `done` exists,
 * so the runner sends the `not_delivered` finalize directly (best effort)
 * instead of waiting for Kafuo's stale-window release.
 *
 * M-1 (replay of a released turn): the app's normal retry with the same
 * clientMessageId replays a completed-but-released turn's stored answer in
 * full — D-3's definition of delivered applies to that replay too. The
 * replay therefore goes through the normal meter-reserve path with the
 * turn's OWN key (capability, turnId, turnAttempt) BEFORE streaming the
 * stored answer (byte-identical, no regeneration): the backend re-opens the
 * released reservation and answers its ORIGINAL reservation id (a consumed
 * key answers an allowed replay with no extra charge), and the unit is
 * consumed only when the replay's own `done` goes out live; an exhausted
 * allowance answers the normal refusal instead of the free replay. A replay
 * of a charged (`delivered`) turn — its outbox row says so — changes nothing
 * and charges nothing; a row deleted by retention proves nothing locally, so
 * the reserve decides.
 *
 * ET-34 (W2-C3): a Kafuo refusal that cannot change soon (allowance used, no
 * Package feature, lesson access lost) is remembered for this
 * student, capability and scope for `TUTOR_REFUSAL_CACHE_SECONDS` (60 s) when the
 * deps carry a `refusalCache` (production does). The next turn inside that
 * window is refused BEFORE `prepare`, so an exhausted student no longer costs an
 * embedding / grounding call per message. The H2 order for admitted turns is
 * unchanged.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import {
  enqueueFinalize,
  readFinalize,
  rearmFinalize,
  upgradeProvisionalFinalize,
  type FinalizeReason,
} from '@/lib/persistence/meter-finalize-outbox';
import {
  completeAttempt,
  readCalibration,
  type AttemptCompletionInput,
} from '@/lib/persistence/teaching-model-attempts';
import {
  insertHelpStudentMessage,
  insertHelpTutorMessage,
  insertStudentMessage,
  insertTurnGrounding,
  insertTutorMessage,
  markHelpMessageCompleted,
  markHelpMessageFailed,
  markHelpMessageGenerating,
  markMessageCompleted,
  markMessageFailed,
  markMessageGenerating,
  nextHelpMessageSeq,
  nextMessageSeq,
  readHelpMessageByClientId,
  readHelpMessagesBySeq,
  readHelpTutorReplyByTurnId,
  readMessageByClientId,
  readMessagesBySeq,
  readTutorReplyByTurnId,
  recordConversationActivity,
  type GroundingMode,
  type InsertStudentMessageInput,
  type InsertTutorMessageInput,
  type MessageCompletionInput,
  type MessageFailureInput,
  type MessageWindowOptions,
  type TurnGroundingUnit,
  type TurnRetrievalAudit,
  type TutorMessage,
} from '@/lib/persistence/tutor-runtime';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import {
  executeTeachingStream,
  type TeachingCallOptions,
  type TeachingCallResult,
  type TurnAssociation,
} from '@/lib/server/teaching-model/execute';
import { enqueueLedgerCompletion } from '@/lib/server/teaching-model/ledger-retry-queue';
import { deliverFinalizeInline } from '@/lib/server/teaching-model/meter-outbox-sweeper';
import type { ResolvedSubjectPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { currentWorkerId } from '@/lib/server/teaching-model/worker-id';
import { detectScript } from '@/lib/server/tutor/arabic-text';
import {
  boundaryMessage,
  guardOrBoundary,
  postCheck,
  preCheck,
  replyLanguage,
  safetyRecord,
  type GuardPreCheck,
  type SafetyRecord,
} from '@/lib/server/tutor/experiment-guard';
import { identityReply, namesProvider } from '@/lib/server/tutor/identity-guard';
import {
  moderateTurn,
  moderationReply,
  type ModerationCheck,
} from '@/lib/server/tutor/moderation-guard';
import {
  isKafuoUnreachableError,
  type KafuoIntegrationClient,
  type MeterScope,
} from '@/lib/server/tutor/kafuo-integration-client';
import {
  assembleTutorPrompt,
  type AcademicBlockInput,
  type AssembledTutorPrompt,
  type GroundingInput,
  type HelpIntentHint,
  type HistoryInput,
  type HistoryTurnInput,
} from '@/lib/server/tutor/prompt-assembly';
import { refusalCacheKey, type MeterRefusalCache } from '@/lib/server/tutor/meter-refusal-cache';
import { createTutorSseWriter, type TutorSseWriter } from '@/lib/server/tutor/sse';
import { resolveProxyRatio } from '@/lib/server/tutor/token-budget';
import { startTurnProgress, TURN_PROGRESS_STALE_S } from '@/lib/server/tutor/turn-progress';

const log = createLogger('TutorTurnRunner');

/**
 * Route `maxDuration` (contracts §5): a `generating` row younger than this is
 * in progress — the upper bound. Within it, a row whose `progress_at` is set
 * but older than `TURN_PROGRESS_STALE_S` is stale (TE-1: its instance died);
 * a row without `progress_at` keeps this rule alone.
 */
export const TURN_IN_PROGRESS_WINDOW_S = 120;
/** Newest messages read for history before the assembler reduces them. */
export const HISTORY_WINDOW_MESSAGES = 200;
const COMPLETION_TX_RETRY_DELAYS_MS = [100, 300, 900] as const;

// ---------------------------------------------------------------------------
// Message store adapter (conversation now, help session later)
// ---------------------------------------------------------------------------

export interface TurnMessageStore {
  kind: 'conversation' | 'help_session';
  nextSeq(q: Queryable, parentId: string): Promise<number>;
  insertStudent(q: Queryable, input: InsertStudentMessageInput): Promise<TutorMessage | null>;
  readByClientId(
    q: Queryable,
    parentId: string,
    clientMessageId: string,
  ): Promise<TutorMessage | null>;
  markGenerating(
    q: Queryable,
    id: string,
    options: { turnAttempt: number; meterReservationId?: string | null; now?: number },
  ): Promise<TutorMessage | null>;
  markCompleted(
    q: Queryable,
    id: string,
    options: MessageCompletionInput,
  ): Promise<TutorMessage | null>;
  markFailed(q: Queryable, id: string, options: MessageFailureInput): Promise<TutorMessage | null>;
  insertTutor(q: Queryable, input: InsertTutorMessageInput): Promise<TutorMessage>;
  readTutorReplyByTurnId(
    q: Queryable,
    parentId: string,
    turnId: string,
  ): Promise<TutorMessage | null>;
  readWindow(
    q: Queryable,
    options: MessageWindowOptions,
  ): Promise<{ messages: TutorMessage[]; hasMore: boolean }>;
  /** Parent bookkeeping after a message was written (message_count / last_message_at). */
  recordActivity?(
    q: Queryable,
    parentId: string,
    options: { messageCountDelta: number; lastMessageAt: number },
  ): Promise<void>;
}

export const CONVERSATION_TURN_STORE: TurnMessageStore = {
  kind: 'conversation',
  nextSeq: nextMessageSeq,
  insertStudent: insertStudentMessage,
  readByClientId: readMessageByClientId,
  markGenerating: markMessageGenerating,
  markCompleted: markMessageCompleted,
  markFailed: markMessageFailed,
  insertTutor: insertTutorMessage,
  readTutorReplyByTurnId,
  readWindow: readMessagesBySeq,
  recordActivity: recordConversationActivity,
};

export const HELP_SESSION_TURN_STORE: TurnMessageStore = {
  kind: 'help_session',
  nextSeq: nextHelpMessageSeq,
  insertStudent: insertHelpStudentMessage,
  readByClientId: readHelpMessageByClientId,
  markGenerating: markHelpMessageGenerating,
  markCompleted: markHelpMessageCompleted,
  markFailed: markHelpMessageFailed,
  insertTutor: insertHelpTutorMessage,
  readTutorReplyByTurnId: readHelpTutorReplyByTurnId,
  readWindow: readHelpMessagesBySeq,
};

// ---------------------------------------------------------------------------
// Plan (capability-specific) and deps
// ---------------------------------------------------------------------------

export interface PrepareContext {
  queryable: Queryable;
  studentMessage: TutorMessage;
  turnId: string;
  turnAttempt: number;
  safety: GuardPreCheck;
  /** Completed turns before this message, oldest → newest. */
  history: HistoryTurnInput[];
  /** The raw window the turns were paired from (for seq-based filtering). */
  historyMessages: TutorMessage[];
}

export interface TurnGroundingAudit {
  assessment: Record<string, unknown>;
  units: TurnGroundingUnit[];
  totalChars: number;
  truncated?: boolean;
  lineageStatus?: 'own_attempt' | 'predecessor_attempt' | 'partial' | 'unavailable' | null;
  resolvedAttemptId?: string | null;
  /** Free Chat (P7): retrieval source, outcome reason, resolution and timings. */
  retrieval?: TurnRetrievalAudit | null;
}

/** A deterministic clarification instead of a model reply (discovery-first P7, D-8 (a)). */
export interface PreparedClarification {
  text: string;
  /** Human-readable topics for the `grounding` event (titles only, never ids). */
  candidates: Array<{ title: string; itemType: string }>;
}

export interface PreparedTurn {
  academic: AcademicBlockInput | null;
  grounding: GroundingInput;
  history: HistoryInput;
  helpMode?: boolean;
  audit: TurnGroundingAudit;
  /** Sent on the `grounding` SSE event when associated. */
  lessonTitle?: string | null;
  /**
   * Optional `grounding` event fields (P7, `direct` path only): `itemType`
   * when the grounding is reuse/retrieved, `reason` when it is insufficient.
   */
  groundingEvent?: { itemType?: string | null; reason?: string | null };
  /** When set, the turn answers with this template: no assembly, no reservation, no model. */
  clarification?: PreparedClarification;
  /** Runs INSIDE the completion transaction (snapshot, lesson association). */
  commit?(
    q: Queryable,
    outcome: {
      succeeded: boolean;
      groundingMode: GroundingMode;
      /** `seq` of the tutor message written in this transaction, when one was. */
      tutorMessageSeq: number | null;
    },
  ): Promise<void>;
}

export interface CommittedTurn {
  succeeded: boolean;
  turnId: string;
  turnAttempt: number;
  studentMessage: TutorMessage;
  tutorMessage: TutorMessage | null;
  servedBy: 'primary' | 'fallback' | null;
  groundingMode: GroundingMode;
  assembled: AssembledTutorPrompt | null;
  /** `null` when Kafuo answered ungated (ET-04): nothing reserved, nothing to finalize. */
  reservationId: string | null;
  /** Still open until the runner closes it: `title` may be sent through it. */
  sse: TutorSseWriter;
}

export interface TurnPlan {
  store: TurnMessageStore;
  parent: { id: string; tenantId: string; studentRef: string };
  policy: ResolvedSubjectPolicy;
  capability: 'free_chat' | 'help';
  stage: 'free-chat-turn' | 'help-turn';
  clientMessageId: string;
  text: string;
  localeHint?: string | null;
  /** The subject's academic language (`ar`, `en`, …): the boundary's last language cue (FC-D13). */
  academicLanguage?: string | null;
  /** Help: the visible step the student was on (stored on both message rows). */
  stepRef?: string | null;
  /** Help: quick-action hint, rendered as a soft turn directive only. */
  intentHint?: HelpIntentHint | null;
  meterScope: MeterScope;
  /** Extra ledger association columns (Help: helpSessionId, sceneId, learning item). */
  association?: Partial<Omit<TurnAssociation, 'kind' | 'turnId'>>;
  requestSignal?: AbortSignal;
  prepare(ctx: PrepareContext): Promise<PreparedTurn>;
  /** Post-commit, after `done`, before the stream closes (title, compaction). */
  afterCommit?(info: CommittedTurn): Promise<void>;
}

export interface TurnRunnerDeps {
  pool: ConnectableQueryable;
  kafuo: Pick<KafuoIntegrationClient, 'reserve' | 'finalize'>;
  /** Epoch ms clock. */
  now?: () => number;
  workerId?: string;
  idFactory?: () => string;
  /** Executor seams (tests): rate card, proxy ratio reader, retry delays, timeout. */
  executor?: Pick<
    TeachingCallOptions,
    'rateCard' | 'proxyRatioReader' | 'completionRetryDelaysMs' | 'timeoutMs' | 'idFactory'
  >;
  inProgressWindowS?: number;
  /** TE-1: `progress_at` refresh interval while the stream runs (tests shorten it). */
  progressIntervalMs?: number;
  /** TE-1: no progress for this long → stale at admission. */
  progressStaleS?: number;
  heartbeatMs?: number;
  completionTxRetryDelaysMs?: readonly number[];
  /**
   * ET-34: remembers non-retryable Kafuo refusals so the next turn is refused
   * before `prepare` (no embedding / grounding call). Absent = no caching.
   */
  refusalCache?: MeterRefusalCache;
  /**
   * Input moderation (guardrails review 28 Oct 2026). The production deps carry the
   * process-wide OpenAI check (`null` when `TUTOR_MODERATION_ENABLED=false`); test deps
   * omit it (no check).
   */
  moderation?: ModerationCheck | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

interface TurnFailure {
  code: string;
  retryable: boolean;
  reason: FinalizeReason;
}

/** Map an executor failure onto the wire code and the finalize reason. */
export function classifyTurnFailure(error: unknown): TurnFailure {
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    retryable?: unknown;
    name?: unknown;
  };
  const code = typeof record.code === 'string' ? record.code : null;
  if (code === 'TEACHING_MODEL_UNAVAILABLE') {
    return { code, retryable: record.retryable !== false, reason: 'model_unavailable' };
  }
  if (code === 'ACCOUNTING_UNAVAILABLE') return { code, retryable: true, reason: 'internal_error' };
  if (code === 'BUDGET_ASSERTION_FAILED')
    return { code, retryable: true, reason: 'budget_refused' };
  if (code === 'ABORTED' || record.name === 'TeachingCallAbortedError') {
    return { code: 'ABORTED', retryable: false, reason: 'aborted' };
  }
  return { code: 'INTERNAL_ERROR', retryable: true, reason: 'internal_error' };
}

/** Pair a message window into completed turns (student → its tutor reply). */
export function pairHistoryTurns(messages: readonly TutorMessage[]): HistoryTurnInput[] {
  const replies = new Map<string, TutorMessage>();
  for (const message of messages) {
    if (message.role === 'tutor' && message.status === 'completed')
      replies.set(message.turnId, message);
  }
  const turns: HistoryTurnInput[] = [];
  for (const message of messages) {
    if (message.role !== 'student' || message.status !== 'completed') continue;
    const reply = replies.get(message.turnId);
    turns.push({ student: message.text, tutor: reply ? reply.text : null });
  }
  return turns;
}

/** The turn's error code for a Kafuo refusal reason (contracts §2.2). */
function refusalCode(
  reason: string,
): 'METER_UNAVAILABLE' | 'ACCOUNT_INACTIVE' | 'ALLOWANCE_EXHAUSTED' {
  return reason === 'temporarily_unavailable'
    ? 'METER_UNAVAILABLE'
    : reason === 'account_inactive'
      ? 'ACCOUNT_INACTIVE'
      : 'ALLOWANCE_EXHAUSTED';
}

/** The meter scope part of the refusal-cache key (Help: per learning item). */
function refusalScope(plan: TurnPlan): string {
  const scope = plan.meterScope as { learningItemId?: unknown; lessonId?: unknown };
  const item = scope.learningItemId ?? scope.lessonId;
  return typeof item === 'string' && item !== '' ? `item:${item}` : 'global';
}

// Retry-After stays the 120 s window (unchanged). The app caps each wait at
// 30 s, so a dead turn (TE-1) is replayed after ≥ 30 s of silence and taken over.
function retryAfterS(nowS: number, generatingAt: number, windowS: number): number {
  return Math.max(1, Math.ceil(windowS - (nowS - generatingAt)));
}

type Admission = { kind: 'new'; message: TutorMessage } | { kind: 'replay'; message: TutorMessage };

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run one turn. Returns the SSE response (a replay, a boundary, or a live
 * stream). Throws `TeachingPackageError` for the pre-stream refusals the
 * route maps onto HTTP: TURN_IN_PROGRESS (409 + Retry-After),
 * IDEMPOTENCY_CONFLICT, REQUEST_TOO_LARGE (422), ALLOWANCE_EXHAUSTED (429),
 * ACCOUNT_INACTIVE (403), METER_UNAVAILABLE (503).
 */
export async function runTutorTurn(plan: TurnPlan, deps: TurnRunnerDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const nowS = () => now() / 1000;
  const newId = deps.idFactory ?? (() => randomUUID());
  const workerId = deps.workerId ?? currentWorkerId();
  const withTransaction = nodePostgresTransaction(deps.pool);
  const windowS = deps.inProgressWindowS ?? TURN_IN_PROGRESS_WINDOW_S;
  const progressStaleS = deps.progressStaleS ?? TURN_PROGRESS_STALE_S;
  const { store, parent, policy } = plan;

  // --- 1. idempotent turn insert ---------------------------------------------
  const admission = await withTransaction(async (q): Promise<Admission> => {
    let existing = await store.readByClientId(q, parent.id, plan.clientMessageId);
    if (!existing) {
      const seq = await store.nextSeq(q, parent.id);
      const inserted = await store.insertStudent(q, {
        id: `msg-${newId()}`,
        parentId: parent.id,
        seq,
        clientMessageId: plan.clientMessageId,
        turnId: `turn-${newId()}`,
        text: plan.text,
        stepRef: plan.stepRef ?? null,
        now: nowS(),
      });
      if (inserted) {
        const generating = await store.markGenerating(q, inserted.id, {
          turnAttempt: 1,
          now: nowS(),
        });
        await store.recordActivity?.(q, parent.id, { messageCountDelta: 1, lastMessageAt: nowS() });
        return { kind: 'new', message: generating ?? inserted };
      }
      existing = await store.readByClientId(q, parent.id, plan.clientMessageId);
      if (!existing) throw new Error('student message vanished after an idempotent insert');
    }
    if (existing.text !== plan.text) {
      throw new TeachingPackageError(
        'IDEMPOTENCY_CONFLICT',
        'clientMessageId was already used with a different message',
      );
    }
    if (existing.status === 'completed') return { kind: 'replay', message: existing };
    let attempt = existing.turnAttempt;
    if (existing.status === 'generating') {
      const since = existing.generatingAt ?? existing.createdAt;
      const progressAt = existing.progressAt;
      const at = nowS();
      // TE-1: a liveness mark older than `progressStaleS` means the instance
      // died mid-stream; no mark (before the stream / older rows) → 120 s only.
      const silent = progressAt !== null && at - progressAt >= progressStaleS;
      if (at - since < windowS && !silent) {
        throw new TeachingPackageError('TURN_IN_PROGRESS', 'this turn is still generating', {
          retryAfterS: retryAfterS(at, since, windowS),
        });
      }
      // Stale: the instance that was generating is gone. Treat as failed.
      await store.markFailed(q, existing.id, { now: nowS(), errorCode: 'TURN_STALE' });
      attempt = existing.turnAttempt + 1;
    } else if (existing.status === 'failed') {
      attempt = existing.turnAttempt + 1;
    }
    const generating = await store.markGenerating(q, existing.id, {
      turnAttempt: attempt,
      now: nowS(),
    });
    if (!generating) {
      throw new TeachingPackageError('TURN_IN_PROGRESS', 'this turn is being generated', {
        retryAfterS: windowS,
      });
    }
    return { kind: 'new', message: generating };
  });

  if (admission.kind === 'replay') return replayTurn(plan, deps, admission.message);

  const studentMessage = admission.message;
  const turnId = studentMessage.turnId;
  const turnAttempt = studentMessage.turnAttempt;
  const failBeforeReservation = async (code: string) => {
    await store.markFailed(deps.pool, studentMessage.id, { now: nowS(), errorCode: code });
  };

  // --- 2. guard pre-check ----------------------------------------------------
  const pre = guardOrBoundary(() => preCheck(plan.text), studentBoundary(plan));
  if (!pre.ok) {
    log.warn(
      JSON.stringify({
        event: 'tutor.safety_triggered',
        turnId,
        reason: 'guard_error',
        error: pre.error,
      }),
    );
    return boundaryWithoutModel(plan, deps, studentMessage, pre.boundary);
  }
  const safety = pre.value;
  if (safety.triggered) {
    log.info(
      JSON.stringify({ event: 'tutor.safety_triggered', turnId, categories: safety.categories }),
    );
  }

  // --- 2b. input moderation: a fixed reply, before any reservation or model call --
  const moderation = await moderateTurn(deps.moderation, plan.text, turnId);
  const moderated = moderationReply(
    moderation,
    safety.triggered,
    replyLanguage(detectScript(plan.text), plan.localeHint, plan.academicLanguage),
  );
  if (moderated) {
    return boundaryWithoutModel(
      plan,
      deps,
      studentMessage,
      moderated.text,
      safetyRecord(safety, { applied: true, reason: moderated.reason }),
    );
  }

  // --- 3a. ET-34: a recent non-retryable refusal answers before `prepare` ------
  const cacheKey = refusalCacheKey({
    tenantId: parent.tenantId,
    studentRef: parent.studentRef,
    capability: plan.capability,
    scope: refusalScope(plan),
  });
  const cached = deps.refusalCache?.get(cacheKey, now());
  if (cached) {
    const code = refusalCode(cached.reason);
    log.info(
      JSON.stringify({ event: 'tutor.meter_refused_cached', turnId, reason: cached.reason }),
    );
    await failBeforeReservation(code);
    throw new TeachingPackageError(code, `meter refused: ${cached.reason}`, {
      reason: cached.reason,
      window: cached.window,
      resetAt: cached.resetAt,
    });
  }

  // --- 3. prepare (assessment / retrieval / scene grounding) -----------------
  const window = await store.readWindow(deps.pool, {
    parentId: parent.id,
    beforeSeq: studentMessage.seq,
    limit: HISTORY_WINDOW_MESSAGES,
  });
  let prepared: PreparedTurn;
  try {
    prepared = await plan.prepare({
      queryable: deps.pool,
      studentMessage,
      turnId,
      turnAttempt,
      safety,
      history: pairHistoryTurns(window.messages),
      historyMessages: window.messages,
    });
  } catch (error) {
    // D-18: the student lost access mid-conversation. No reservation exists
    // yet; the row must not stay `generating` (TURN_IN_PROGRESS on a retry).
    if (error instanceof TeachingPackageError && error.code === 'SUBJECT_NO_LONGER_AVAILABLE') {
      await failBeforeReservation(error.code);
    }
    throw error;
  }

  // --- 3b. clarification (Free Chat, D-8 (a)): no model, no reservation -------
  if (prepared.clarification) {
    return clarifyWithoutModel(plan, deps, studentMessage, prepared, safety);
  }

  // --- 4. assemble under the tighter cap (before any reservation) -----------
  const proxyTarget = [policy.primary, policy.fallback].find((t) => t.counterKind === 'proxy');
  const proxyRatio = proxyTarget
    ? await resolveProxyRatio(
        proxyTarget.modelString,
        deps.executor?.proxyRatioReader ??
          (async (modelString) =>
            (await readCalibration(deps.pool, modelString))?.proxyRatio ?? null),
      )
    : null;
  let assembled: AssembledTutorPrompt;
  try {
    assembled = assembleTutorPrompt({
      academic: prepared.academic,
      grounding: prepared.grounding,
      history: prepared.history,
      message: plan.text,
      policy,
      counters: { proxyRatio },
      directives: {
        responseScript: detectScript(plan.text),
        localeHint: plan.localeHint ?? null,
        safetyTriggered: safety.triggered,
        intentHint: plan.intentHint ?? null,
      },
      helpMode: prepared.helpMode === true,
    });
  } catch (error) {
    if (error instanceof TeachingPackageError && error.code === 'REQUEST_TOO_LARGE') {
      await failBeforeReservation('REQUEST_TOO_LARGE');
    }
    throw error;
  }

  // --- 5. meter reserve (before any ledger row / model call) ------------------
  // `null` = ungated (ET-04): the turn runs, nothing is enqueued or finalized.
  let reservationId: string | null;
  try {
    const decision = await deps.kafuo.reserve({
      tenantId: parent.tenantId,
      studentRef: parent.studentRef,
      capability: plan.capability,
      meterScope: plan.meterScope,
      turnId,
      turnAttempt,
      clientMessageId: plan.clientMessageId,
    });
    if (!decision.allowed) {
      // temporarily_unavailable (and any unknown reason) → retryable 503;
      // account_inactive (SR-36) → 403; every allowance / gate reason →
      // 429 with details.reason.
      const code = refusalCode(decision.reason);
      log.info(JSON.stringify({ event: 'tutor.meter_refused', turnId, reason: decision.reason }));
      if (decision.reason !== 'temporarily_unavailable') {
        deps.refusalCache?.remember(
          cacheKey,
          { reason: decision.reason, window: decision.window, resetAt: decision.resetAt },
          now(),
        );
      }
      await failBeforeReservation(code);
      throw new TeachingPackageError(code, `meter refused: ${decision.reason}`, {
        reason: decision.reason,
        window: decision.window,
        resetAt: decision.resetAt,
      });
    }
    reservationId = decision.reservationId;
    if (reservationId === null) {
      log.info(JSON.stringify({ event: 'tutor.meter_ungated', turnId }));
    }
  } catch (error) {
    if (error instanceof TeachingPackageError) throw error;
    log.warn(
      JSON.stringify({
        event: 'tutor.meter_unavailable',
        turnId,
        error: describeErrorSafely(error).name,
      }),
    );
    await failBeforeReservation('METER_UNAVAILABLE');
    throw new TeachingPackageError(
      'METER_UNAVAILABLE',
      isKafuoUnreachableError(error)
        ? 'the entitlement service is unreachable; no model call was made'
        : 'the entitlement service refused the reservation; no model call was made',
    );
  }

  // --- 6. stream --------------------------------------------------------------
  const sse = createTutorSseWriter({
    requestSignal: plan.requestSignal,
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  });
  // TE-1: `progress_at` from the moment the stream opens, refreshed until the
  // turn settles; this worker's registry entry is what SIGTERM marks stale.
  const progress = startTurnProgress({
    pool: deps.pool,
    kind: store.kind,
    messageId: studentMessage.id,
    turnAttempt,
    workerId,
    now,
    ...(deps.progressIntervalMs !== undefined ? { intervalMs: deps.progressIntervalMs } : {}),
  });
  await progress.ready;
  void streamTurn({
    plan,
    deps,
    sse,
    studentMessage,
    turnId,
    turnAttempt,
    safety,
    prepared,
    assembled,
    reservationId,
    workerId,
    newId,
    now,
    withTransaction,
  })
    .catch((error) => {
      log.error(
        JSON.stringify({ event: 'tutor.turn_crashed', turnId, error: describeErrorSafely(error) }),
      );
      sse.error({ code: 'INTERNAL_ERROR', retryable: true });
      void sse.close();
    })
    .finally(() => progress.stop());
  return sse.response;
}

// ---------------------------------------------------------------------------
// Replay and boundary paths
// ---------------------------------------------------------------------------

async function replayTurn(
  plan: TurnPlan,
  deps: TurnRunnerDeps,
  studentMessage: TutorMessage,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const nowS = () => now() / 1000;
  const workerId = deps.workerId ?? currentWorkerId();
  const { store, parent } = plan;
  const reply = await store.readTutorReplyByTurnId(deps.pool, parent.id, studentMessage.turnId);

  // M-1: a replay of a turn whose stored finalize outcome was RELEASED
  // (`not_delivered` — the model answer completed but the client dropped
  // before `done`, so D-3 released the unit) delivers the whole stored
  // answer, so it pays for itself: the turn's OWN key goes through the
  // normal meter-reserve path BEFORE the replay streams, the backend
  // re-opens the released reservation and answers its ORIGINAL reservation
  // id (a consumed key answers an allowed replay with no extra charge), and
  // the unit is consumed only when the replay's own `done` goes out on a
  // live stream (the same D-3 rule as a live turn). A `delivered` outcome is
  // the turn's own record that it was already charged — that replay is free
  // — and so is no reservation at all (ungated ET-04, clarification,
  // boundary). A missing row (retention deleted it) proves nothing: the
  // reserve decides. The replayed bytes are the stored answer — never a
  // regeneration.
  let chargeReservationId: string | null = null;
  if (reply && studentMessage.meterReservationId !== null) {
    const stored = await readFinalize(deps.pool, studentMessage.meterReservationId);
    if (stored === null || stored.outcome === 'not_delivered') {
      chargeReservationId = await reserveReplayUnit(plan, deps, studentMessage);
    }
  }

  const sse = createTutorSseWriter({
    requestSignal: plan.requestSignal,
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  });
  if (chargeReservationId !== null) {
    // The reserve re-opened the RELEASED reservation — its ORIGINAL id, the
    // same one the stored outbox row (if any) is keyed by. Put that row back
    // to the provisional `not_delivered` a live turn's completion transaction
    // writes, inserting it fresh should retention have deleted it: if this
    // instance dies mid-replay the sweeper releases the re-opened unit
    // instead of the student keeping a free full answer, and after the
    // replay's `done` the normal upgrade + inline finalize charges it.
    await rearmFinalize(deps.pool, {
      reservationId: chargeReservationId,
      tenantId: parent.tenantId,
      turnId: studentMessage.turnId,
      turnAttempt: studentMessage.turnAttempt,
      now: nowS(),
    });
  }
  sse.turnStart({ turnId: studentMessage.turnId, turnAttempt: studentMessage.turnAttempt });
  if (reply) {
    sse.textDelta(reply.text);
    sse.done({
      messageId: reply.id,
      servedBy: reply.servedBy,
      ...(reply.safety ? { safety: reply.safety } : {}),
      accountingComplete: true,
    });
  } else {
    sse.error({
      code: 'INTERNAL_ERROR',
      retryable: true,
      message: 'completed turn without a reply',
    });
  }
  if (chargeReservationId !== null) {
    if (!sse.closed && reply) {
      // D-3: the replay's `done` went out on a live stream — consume the unit.
      try {
        await upgradeProvisionalFinalize(deps.pool, chargeReservationId);
      } catch (error) {
        log.warn(
          JSON.stringify({
            event: 'meter.finalize_upgrade_failed',
            turnId: studentMessage.turnId,
            reservationId: chargeReservationId,
            error: describeErrorSafely(error).name,
          }),
        );
      }
    }
    try {
      await deliverFinalizeInline(deps.pool, chargeReservationId, {
        client: deps.kafuo as KafuoIntegrationClient,
        now,
        workerId,
      });
    } catch (error) {
      log.warn(
        JSON.stringify({
          event: 'meter.finalize_deferred',
          turnId: studentMessage.turnId,
          reservationId: chargeReservationId,
          error: describeErrorSafely(error).name,
        }),
      );
    }
  }
  await sse.close();
  return sse.response;
}

/**
 * M-1: the reserve behind a paid replay, made with the turn's OWN key
 * (capability, turnId, turnAttempt). The backend re-opens the RELEASED
 * reservation and answers its ORIGINAL reservation id — never a fresh one
 * (a consumed key answers an allowed replay with no extra charge) — so the
 * caller re-arms that same reservation's outbox row. Refusal mapping,
 * refusal cache and unreachable handling are the normal admission's (H2):
 * an exhausted allowance answers the normal denial instead of the free
 * replay. The completed row is never failed — the stored answer stays;
 * `null` = Kafuo answered ungated (ET-04): nothing to charge.
 */
async function reserveReplayUnit(
  plan: TurnPlan,
  deps: TurnRunnerDeps,
  studentMessage: TutorMessage,
): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const cacheKey = refusalCacheKey({
    tenantId: plan.parent.tenantId,
    studentRef: plan.parent.studentRef,
    capability: plan.capability,
    scope: refusalScope(plan),
  });
  const cached = deps.refusalCache?.get(cacheKey, now());
  if (cached) {
    const code = refusalCode(cached.reason);
    log.info(
      JSON.stringify({
        event: 'tutor.meter_refused_cached',
        turnId: studentMessage.turnId,
        reason: cached.reason,
      }),
    );
    throw new TeachingPackageError(code, `meter refused: ${cached.reason}`, {
      reason: cached.reason,
      window: cached.window,
      resetAt: cached.resetAt,
    });
  }
  try {
    const decision = await deps.kafuo.reserve({
      tenantId: plan.parent.tenantId,
      studentRef: plan.parent.studentRef,
      capability: plan.capability,
      meterScope: plan.meterScope,
      turnId: studentMessage.turnId,
      turnAttempt: studentMessage.turnAttempt,
      clientMessageId: plan.clientMessageId,
    });
    if (!decision.allowed) {
      const code = refusalCode(decision.reason);
      log.info(
        JSON.stringify({
          event: 'tutor.meter_refused',
          turnId: studentMessage.turnId,
          reason: decision.reason,
          replayCharge: true,
        }),
      );
      if (decision.reason !== 'temporarily_unavailable') {
        deps.refusalCache?.remember(
          cacheKey,
          { reason: decision.reason, window: decision.window, resetAt: decision.resetAt },
          now(),
        );
      }
      throw new TeachingPackageError(code, `meter refused: ${decision.reason}`, {
        reason: decision.reason,
        window: decision.window,
        resetAt: decision.resetAt,
      });
    }
    log.info(
      JSON.stringify({
        event: 'tutor.replay_recharged',
        turnId: studentMessage.turnId,
        ...(decision.reservationId !== null ? { reservationId: decision.reservationId } : {}),
      }),
    );
    return decision.reservationId;
  } catch (error) {
    if (error instanceof TeachingPackageError) throw error;
    log.warn(
      JSON.stringify({
        event: 'tutor.meter_unavailable',
        turnId: studentMessage.turnId,
        error: describeErrorSafely(error).name,
      }),
    );
    throw new TeachingPackageError(
      'METER_UNAVAILABLE',
      isKafuoUnreachableError(error)
        ? 'the entitlement service is unreachable; the stored answer was not replayed'
        : 'the entitlement service refused the reservation; the stored answer was not replayed',
    );
  }
}

/**
 * The boundary in the student's language (FC-D13): their script, then the
 * locale hint, then the subject's academic language.
 */
function studentBoundary(plan: TurnPlan, academicLanguage?: string | null): string {
  return boundaryMessage(
    detectScript(plan.text),
    plan.localeHint,
    plan.academicLanguage ?? academicLanguage ?? null,
  );
}

/**
 * A fixed reply before any model call: SAFE-02 (the guard itself failed) or an input
 * moderation outcome (`safety.reason` says which). No reservation, no ledger row.
 */
async function boundaryWithoutModel(
  plan: TurnPlan,
  deps: TurnRunnerDeps,
  studentMessage: TutorMessage,
  boundary: string,
  safety: SafetyRecord = {
    triggered: true,
    category: null,
    categories: [],
    boundary: true,
    code: 'SAFETY_BOUNDARY',
    reason: 'guard_error',
  },
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const nowS = now() / 1000;
  const newId = deps.idFactory ?? (() => randomUUID());
  const withTransaction = nodePostgresTransaction(deps.pool);
  const tutorMessage = await withTransaction(async (q) => {
    const seq = await plan.store.nextSeq(q, plan.parent.id);
    const inserted = await plan.store.insertTutor(q, {
      id: `msg-${newId()}`,
      parentId: plan.parent.id,
      seq,
      turnId: studentMessage.turnId,
      turnAttempt: studentMessage.turnAttempt,
      text: boundary,
      servedBy: null,
      groundingMode: 'none',
      safety: safety as unknown as Record<string, unknown>,
      accountingComplete: true,
      now: nowS,
    });
    await plan.store.markCompleted(q, studentMessage.id, { now: nowS, accountingComplete: true });
    await plan.store.recordActivity?.(q, plan.parent.id, {
      messageCountDelta: 1,
      lastMessageAt: nowS,
    });
    return inserted;
  });
  const sse = createTutorSseWriter({
    requestSignal: plan.requestSignal,
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  });
  sse.turnStart({ turnId: studentMessage.turnId, turnAttempt: studentMessage.turnAttempt });
  sse.grounding({ mode: 'none' });
  sse.textDelta(boundary);
  sse.done({
    messageId: tutorMessage.id,
    servedBy: null,
    safety: safety as unknown as Record<string, unknown>,
    accountingComplete: true,
  });
  await sse.close();
  return sse.response;
}

/**
 * Discovery-first P7 clarification (D-8 (a)): the item resolution was
 * uncertain, so the reply is a deterministic template naming ≤ 3 topics. It
 * is persisted like any reply (tutor message `grounding_mode='clarification'`,
 * the turn grounding row, `pending_clarification` through `prepared.commit`)
 * and streamed as turn_start → grounding → text_delta → done. No model call,
 * no meter reservation, no ledger row, no finalize outbox row, no title call.
 * A replay of the completed turn re-sends the stored text.
 */
async function clarifyWithoutModel(
  plan: TurnPlan,
  deps: TurnRunnerDeps,
  studentMessage: TutorMessage,
  prepared: PreparedTurn,
  pre: GuardPreCheck,
): Promise<Response> {
  const clarification = prepared.clarification!;
  const now = deps.now ?? Date.now;
  const nowS = now() / 1000;
  const newId = deps.idFactory ?? (() => randomUUID());
  const withTransaction = nodePostgresTransaction(deps.pool);
  const { store, parent } = plan;
  const safety = safetyRecord(pre, { applied: false });
  let tutorMessage: TutorMessage;
  try {
    tutorMessage = await withTransaction(async (q) => {
      const seq = await store.nextSeq(q, parent.id);
      const inserted = await store.insertTutor(q, {
        id: `msg-${newId()}`,
        parentId: parent.id,
        seq,
        turnId: studentMessage.turnId,
        turnAttempt: studentMessage.turnAttempt,
        text: clarification.text,
        servedBy: null,
        groundingMode: 'clarification',
        safety: safety as unknown as Record<string, unknown>,
        accountingComplete: true,
        stepRef: plan.stepRef ?? null,
        firstDeltaAt: nowS,
        now: nowS,
      });
      await store.markCompleted(q, studentMessage.id, { now: nowS, accountingComplete: true });
      await store.recordActivity?.(q, parent.id, { messageCountDelta: 1, lastMessageAt: nowS });
      await insertTurnGrounding(q, {
        turnId: studentMessage.turnId,
        ...(store.kind === 'conversation'
          ? { conversationId: parent.id }
          : { helpSessionId: parent.id }),
        mode: 'clarification',
        assessment: { ...prepared.audit.assessment, turnAttempt: studentMessage.turnAttempt },
        units: [],
        totalChars: 0,
        truncated: false,
        inputTokenEstimate: 0,
        budgetEstimateTokens: 0,
        budgetCounterKind: plan.policy.primary.counterKind,
        retrieval: prepared.audit.retrieval ?? null,
        now: nowS,
      });
      await prepared.commit?.(q, {
        succeeded: true,
        groundingMode: 'clarification',
        tutorMessageSeq: seq,
      });
      return inserted;
    });
  } catch (error) {
    await store
      .markFailed(deps.pool, studentMessage.id, { now: now() / 1000, errorCode: 'INTERNAL_ERROR' })
      .catch(() => {});
    throw error;
  }
  const sse = createTutorSseWriter({
    requestSignal: plan.requestSignal,
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  });
  sse.turnStart({ turnId: studentMessage.turnId, turnAttempt: studentMessage.turnAttempt });
  sse.grounding({
    mode: 'clarification',
    ...(clarification.candidates.length ? { candidates: clarification.candidates } : {}),
  });
  sse.textDelta(clarification.text);
  sse.done({
    messageId: tutorMessage.id,
    servedBy: null,
    safety: safety as unknown as Record<string, unknown>,
    accountingComplete: true,
  });
  log.info(
    JSON.stringify({
      event: 'tutor.turn',
      turnId: studentMessage.turnId,
      turnAttempt: studentMessage.turnAttempt,
      capability: plan.capability,
      stage: plan.stage,
      decision: prepared.audit.assessment.rule ?? prepared.audit.assessment.decision ?? null,
      groundingMode: 'clarification',
      candidates: clarification.candidates.length,
      outcome: 'clarification',
    }),
  );
  await sse.close();
  return sse.response;
}

// ---------------------------------------------------------------------------
// The streamed part: executor → post-check → completion transaction → done
// ---------------------------------------------------------------------------

interface StreamTurnArgs {
  plan: TurnPlan;
  deps: TurnRunnerDeps;
  sse: TutorSseWriter;
  studentMessage: TutorMessage;
  turnId: string;
  turnAttempt: number;
  safety: GuardPreCheck;
  prepared: PreparedTurn;
  assembled: AssembledTutorPrompt;
  /** `null` = ungated (ET-04). */
  reservationId: string | null;
  workerId: string;
  newId: () => string;
  now: () => number;
  withTransaction: ReturnType<typeof nodePostgresTransaction>;
}

async function streamTurn(args: StreamTurnArgs): Promise<void> {
  const {
    plan,
    deps,
    sse,
    studentMessage,
    turnId,
    turnAttempt,
    prepared,
    assembled,
    reservationId,
    now,
  } = args;
  const { store, parent, policy } = plan;
  const startedAt = now();
  const nowS = () => now() / 1000;

  sse.turnStart({ turnId, turnAttempt });
  const eventItemType =
    (assembled.groundingMode === 'reuse' || assembled.groundingMode === 'retrieved') &&
    prepared.groundingEvent?.itemType
      ? prepared.groundingEvent.itemType
      : null;
  const eventReason =
    assembled.groundingMode === 'insufficient' &&
    prepared.grounding.mode === 'insufficient' &&
    prepared.groundingEvent?.reason
      ? prepared.groundingEvent.reason
      : null;
  sse.grounding({
    mode: assembled.groundingMode,
    ...(prepared.lessonTitle ? { lessonTitle: prepared.lessonTitle } : {}),
    ...(eventItemType ? { itemType: eventItemType } : {}),
    ...(eventReason ? { reason: eventReason } : {}),
  });
  // Student-perceived time to first streamed content (epoch seconds, P7).
  let firstDeltaAt: number | null = null;

  // Ledger completions are collected here and written in the turn transaction (§7.7 step 2).
  const pendingCompletions: Array<{ attemptId: string; completion: AttemptCompletionInput }> = [];
  const association: TurnAssociation = {
    kind: 'turn',
    turnId,
    studentRef: parent.studentRef,
    ...(store.kind === 'conversation'
      ? { conversationId: parent.id }
      : { helpSessionId: parent.id }),
    ...(plan.association ?? {}),
  };

  let result: TeachingCallResult | null = null;
  let failure: TurnFailure | null = null;
  try {
    result = await executeTeachingStream(
      policy,
      {
        tenantId: parent.tenantId,
        capability: plan.capability,
        stage: plan.stage,
        origin: 'openmaic_runtime',
        association,
        budget: {
          estimate: assembled.budget.estimate,
          counterKind: assembled.budget.counterKind,
          effectiveCap: assembled.budget.effectiveCap,
        },
        signal: sse.signal,
        completeAttempt: async (attemptId, completion) => {
          pendingCompletions.push({ attemptId, completion });
        },
      },
      { messages: assembled.messages },
      {
        onDelta: (delta) => {
          if (firstDeltaAt === null && delta.length > 0) firstDeltaAt = nowS();
          sse.textDelta(delta);
        },
        onRestart: () => sse.restart('fallback'),
        onFinish: () => {},
      },
      {
        queryable: deps.pool,
        now,
        workerId: args.workerId,
        ...(deps.executor ?? {}),
      },
    );
  } catch (error) {
    failure = classifyTurnFailure(error);
    if (failure.code === 'INTERNAL_ERROR') {
      log.error(
        JSON.stringify({
          event: 'tutor.executor_failed',
          turnId,
          error: describeErrorSafely(error),
        }),
      );
    }
  }

  // --- post-check -------------------------------------------------------------
  let text = result?.text ?? '';
  let safety: SafetyRecord = safetyRecord(args.safety, { applied: false });
  let finalizeReason: FinalizeReason | null = failure?.reason ?? null;
  if (result) {
    const boundary = studentBoundary(plan, prepared.academic?.academicLanguage);
    const post = guardOrBoundary(
      () => postCheck(text, { preTriggered: args.safety.triggered }),
      boundary,
    );
    const violated = !post.ok || post.value.violation;
    // Layer 3 (guardrails review 28 Oct 2026): a reply naming the model or provider.
    const disclosed = !violated && namesProvider(text);
    if (violated || disclosed) {
      text = violated
        ? boundary
        : identityReply(
            replyLanguage(
              detectScript(plan.text),
              plan.localeHint,
              plan.academicLanguage ?? prepared.academic?.academicLanguage ?? null,
            ),
          );
      safety = safetyRecord(args.safety, {
        applied: true,
        reason: disclosed
          ? 'identity_disclosure'
          : post.ok
            ? (post.value.rule ?? 'operational_sequence')
            : 'guard_error',
      });
      finalizeReason = 'safety_boundary';
      if (firstDeltaAt === null) firstDeltaAt = nowS();
      log.info(
        JSON.stringify({
          event: 'tutor.safety_triggered',
          turnId,
          boundary: true,
          reason: safety.reason,
        }),
      );
      // The client discards the partial model text and shows the boundary.
      sse.restart('fallback', 'safety_boundary');
      sse.textDelta(text);
    }
  }

  // --- completion transaction --------------------------------------------------
  const succeeded = result !== null;
  // D-3: the meter outcome is decided by `done` being written to a LIVE
  // stream, which can only be observed after the commit. The row is enqueued
  // provisionally released; a complete answer whose `done` goes out is
  // upgraded right after. `not_delivered` is final for every failure, and for
  // a complete answer whose client is already gone (`done` can never be
  // written: writes after close are no-ops).
  let meterDelivered = false;
  const meterReason: FinalizeReason | null = failure
    ? failure.reason
    : sse.closed
      ? 'aborted'
      : finalizeReason;
  const groundingMode = assembled.groundingMode;
  let tutorMessage: TutorMessage | null = null;
  const commit = async () => {
    await args.withTransaction(async (q) => {
      for (const pending of pendingCompletions) {
        await completeAttempt(q, pending.attemptId, pending.completion);
      }
      let tutorMessageSeq: number | null = null;
      if (result) {
        const seq = await store.nextSeq(q, parent.id);
        tutorMessageSeq = seq;
        tutorMessage = await store.insertTutor(q, {
          id: `msg-${args.newId()}`,
          parentId: parent.id,
          seq,
          turnId,
          turnAttempt,
          text,
          servedBy: result.servedBy,
          groundingMode,
          safety: safety as unknown as Record<string, unknown>,
          accountingComplete: true,
          meterReservationId: reservationId,
          stepRef: plan.stepRef ?? null,
          firstDeltaAt,
          now: nowS(),
        });
        await store.markCompleted(q, studentMessage.id, {
          now: nowS(),
          accountingComplete: true,
          meterReservationId: reservationId,
        });
        await store.recordActivity?.(q, parent.id, { messageCountDelta: 1, lastMessageAt: nowS() });
      } else {
        await store.markFailed(q, studentMessage.id, {
          now: nowS(),
          errorCode: failure!.code,
          accountingComplete: true,
          meterReservationId: reservationId,
        });
      }
      await insertTurnGrounding(q, {
        turnId,
        ...(store.kind === 'conversation'
          ? { conversationId: parent.id }
          : { helpSessionId: parent.id }),
        mode: groundingMode,
        assessment: { ...prepared.audit.assessment, reductions: assembled.reductions, turnAttempt },
        units: prepared.audit.units,
        totalChars: Math.min(prepared.audit.totalChars, assembled.grounding.totalChars),
        truncated: prepared.audit.truncated ?? assembled.grounding.truncated,
        inputTokenEstimate: assembled.budget.estimate,
        lineageStatus: prepared.audit.lineageStatus ?? null,
        resolvedAttemptId: prepared.audit.resolvedAttemptId ?? null,
        budgetEstimateTokens: assembled.budget.estimate,
        budgetCounterKind: assembled.budget.counterKind,
        retrieval: prepared.audit.retrieval ?? null,
        now: nowS(),
      });
      // Ungated (ET-04): no reservation, so no outbox row and no finalize.
      // D-3: always the provisional release — `delivered` is only proven by
      // `done` reaching a live stream after the commit.
      if (reservationId !== null) {
        await enqueueFinalize(q, {
          reservationId,
          tenantId: parent.tenantId,
          turnId,
          turnAttempt,
          outcome: 'not_delivered',
          reason: meterReason,
          now: nowS(),
        });
      }
      await prepared.commit?.(q, { succeeded, groundingMode, tutorMessageSeq });
    });
  };

  const delays = deps.completionTxRetryDelaysMs ?? COMPLETION_TX_RETRY_DELAYS_MS;
  let committed = false;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length && !committed; attempt += 1) {
    try {
      await commit();
      committed = true;
    } catch (error) {
      lastError = error;
      tutorMessage = null;
      const delay = delays[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  if (!committed) {
    log.error(
      JSON.stringify({
        event: 'teaching_model.turn_completion_failed',
        turnId,
        turnAttempt,
        reservationId,
        error: describeErrorSafely(lastError),
      }),
    );
    // The ledger can still heal from memory; the turn itself is not completed.
    for (const pending of pendingCompletions) {
      enqueueLedgerCompletion(
        pending.attemptId,
        async () => {
          await completeAttempt(deps.pool, pending.attemptId, pending.completion);
        },
        { now: now() },
      );
    }
    await store
      .markFailed(deps.pool, studentMessage.id, {
        now: nowS(),
        errorCode: 'ACCOUNTING_UNAVAILABLE',
      })
      .catch(() => {});
    // D-3: no outbox row exists and no `done` was (or will be) sent — the
    // answer is incomplete, so release the unit directly (best effort) rather
    // than waiting for Kafuo's stale-window release.
    if (reservationId !== null) {
      try {
        await deps.kafuo.finalize({
          reservationId,
          outcome: 'not_delivered',
          reason: finalizeReason ?? 'internal_error',
          turnId,
        });
      } catch (error) {
        log.warn(
          JSON.stringify({
            event: 'meter.finalize_after_failed_commit_failed',
            turnId,
            reservationId,
            error: describeErrorSafely(error).name,
          }),
        );
      }
    }
    sse.error({ code: 'ACCOUNTING_UNAVAILABLE', retryable: true });
    await sse.close();
    return;
  }

  // --- commit → done | error ---------------------------------------------------
  if (result && tutorMessage) {
    const reply = tutorMessage as TutorMessage;
    sse.done({
      messageId: reply.id,
      servedBy: result.servedBy,
      safety: safety as unknown as Record<string, unknown>,
      accountingComplete: true,
    });
    // D-3: charged only when that `done` was written to a still-open stream.
    // A client that hung up before the end marker leaves the provisional
    // release in place — the turn is not charged.
    if (!sse.closed) {
      meterDelivered = true;
      if (reservationId !== null) {
        try {
          await upgradeProvisionalFinalize(deps.pool, reservationId);
        } catch (error) {
          log.warn(
            JSON.stringify({
              event: 'meter.finalize_upgrade_failed',
              turnId,
              reservationId,
              error: describeErrorSafely(error).name,
            }),
          );
        }
      }
    }
  } else if (failure) {
    sse.error({ code: failure.code, retryable: failure.retryable });
  }

  log.info(
    JSON.stringify({
      event: 'tutor.turn',
      turnId,
      turnAttempt,
      capability: plan.capability,
      stage: plan.stage,
      decision: prepared.audit.assessment.rule ?? prepared.audit.assessment.decision ?? null,
      groundingMode,
      groundingChars: assembled.grounding.totalChars,
      tokenEstimate: assembled.budget.estimate,
      counterKind: assembled.budget.counterKind,
      reductions: assembled.reductions,
      servedBy: result?.servedBy ?? null,
      outcome: failure?.code ?? (safety.boundary ? 'SAFETY_BOUNDARY' : 'completed'),
      meterOutcome: reservationId === null ? null : meterDelivered ? 'delivered' : 'not_delivered',
      totalMs: now() - startedAt,
    }),
  );

  // --- inline finalize (post-commit, best effort; none when ungated) ----------
  if (reservationId !== null) {
    try {
      await deliverFinalizeInline(deps.pool, reservationId, {
        client: deps.kafuo as KafuoIntegrationClient,
        now,
        workerId: args.workerId,
      });
    } catch (error) {
      log.warn(
        JSON.stringify({
          event: 'meter.finalize_deferred',
          turnId,
          reservationId,
          error: describeErrorSafely(error).name,
        }),
      );
    }
  }

  // --- after commit (title, compaction): the student already has `done` ------
  if (plan.afterCommit) {
    try {
      await plan.afterCommit({
        succeeded,
        turnId,
        turnAttempt,
        studentMessage,
        tutorMessage,
        servedBy: result?.servedBy ?? null,
        groundingMode,
        assembled,
        reservationId,
        sse,
      });
    } catch (error) {
      log.warn(
        JSON.stringify({
          event: 'tutor.after_commit_failed',
          turnId,
          error: describeErrorSafely(error),
        }),
      );
    }
  }
  await sse.close();
}
