/**
 * One AI reviewer call (ai-reviewer-layer plan §4.2, §4.5).
 *
 *   choose route (switch state, O-2 probe claim)
 *     → resolve the reviewer targets (no stage, no operator override)
 *     → the teaching executor, streamed, with the reviewer-only options:
 *         `fallbackOnRefusal` (O-3), `primaryOnly` (on Sol), a long timeout
 *     → settle the switch from the attempts' outcomes
 *
 * Every provider call goes through `executeTeachingStream`, so metering
 * (`teaching_model_attempts`), classification and fallback stay in one place.
 * Prompts, book text and answers are never logged.
 */
import type { ModelMessage } from 'ai';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';
import type { AttributedUsage } from '@/lib/usage/attribute';
import {
  executeTeachingStream,
  TeachingModelUnavailableError,
  type GenerationAssociation,
  type StructuredOutputSpec,
  type TeachingCallOptions,
  type TeachingCallOutcome,
  type TeachingCallResult,
  type TeachingCapability,
} from '@/lib/server/teaching-model/execute';
import {
  REVIEWER_CALL_TIMEOUT_MS,
  REVIEWER_FALLBACK_MODEL,
  REVIEWER_PRIMARY_MODEL,
  resolveReviewerRoute,
  reviewerMaxOutputTokens,
  reviewerProviderOf,
  type ReviewerProvider,
} from '@/lib/server/teaching-model/reviewer-policy';
import {
  chooseReviewerRoute,
  recordSwitchBackToOpus,
  recordSwitchToSol,
  type ReviewerProviderState,
  type ReviewerRouteChoice,
} from '@/lib/server/teaching-model/reviewer-provider-state';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import type { TeachingPackageAggregateKey } from '@/lib/types/teaching-package';

const log = createLogger('ReviewerCall');

export type ReviewerCapability = Extract<
  TeachingCapability,
  'package_review' | 'question_review' | 'outline_review'
>;

export interface ReviewerCallInput {
  pool: ConnectableQueryable;
  tenantId: string;
  /** The reviewed package's subject, for the ledger row only. */
  subjectCode: string;
  capability: ReviewerCapability;
  /** Ledger `stage` (the consumption report's `feature`). */
  stage: string;
  association: GenerationAssociation;
  /** The aggregate a provider-switch event rides on (the reviewed package). */
  aggregate: TeachingPackageAggregateKey;
  system: string;
  /**
   * The stable part of the user turn (the book units). Sent first, as its own
   * block with an Anthropic cache marker, so a re-review with the same book
   * reads it from the prompt cache (plan §4.2). OpenAI caches prefixes itself.
   */
  stablePrompt?: string;
  prompt: string;
  output: StructuredOutputSpec;
  signal?: AbortSignal;
}

/** The user turn: `[stable (cache-marked)] + variable`, or the variable text alone. */
function userTurn(input: ReviewerCallInput): { messages: ModelMessage[] } | { prompt: string } {
  if (!input.stablePrompt) return { prompt: input.prompt };
  return {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: input.stablePrompt,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          },
          { type: 'text', text: input.prompt },
        ],
      },
    ],
  };
}

export interface ReviewerCallDeps {
  now?: () => number;
  chooseRoute?: typeof chooseReviewerRoute;
  resolveRoute?: typeof resolveReviewerRoute;
  executeStream?: typeof executeTeachingStream;
  /** Executor seams (tests): queryable, rate card, ids. */
  executorOptions?: TeachingCallOptions;
}

export interface ReviewerCallResult {
  parsed: unknown;
  provider: ReviewerProvider | null;
  modelString: string | null;
  attemptIds: string[];
  usage: AttributedUsage | null;
  /** This call switched the reviewer (to Sol, or back to Opus). */
  switched: ReviewerProviderState | null;
}

const NOOP_SINK = {
  onDelta() {},
  onRestart() {},
  onFinish() {},
};

/** What the switch event tells the Backend; never a key, a prompt or book text. */
function switchPayload(state: ReviewerProviderState, previous: ReviewerProvider) {
  return {
    switch: {
      activeProvider: state.activeProvider,
      previousProvider: previous,
      model: state.activeProvider === 'openai' ? REVIEWER_FALLBACK_MODEL : REVIEWER_PRIMARY_MODEL,
      reason: state.reason,
      switchedAt: state.switchedAt,
      nextProbeAt: state.nextProbeAt,
    },
  };
}

/**
 * Settle the D-3 switch from this call's attempts. A failure here is logged
 * and never fails the review: the answer already exists, and the next call
 * meets the same exhausted credit and tries again.
 */
async function settleProviderSwitch(
  input: ReviewerCallInput,
  choice: ReviewerRouteChoice,
  outcomes: readonly TeachingCallOutcome[],
  now: number,
): Promise<ReviewerProviderState | null> {
  const opus = outcomes.find((o) => o.modelString === REVIEWER_PRIMARY_MODEL);
  if (!opus) return null;
  const toSol = opus.outcome === 'provider_credit_exhausted';
  const backToOpus = choice.probe && opus.outcome === 'succeeded';
  if (!toSol && !backToOpus) return null;
  try {
    return await nodePostgresTransaction(input.pool)(async (tx: Queryable) => {
      const state = toSol
        ? await recordSwitchToSol(tx, { now, reason: 'credit_exhausted' })
        : await recordSwitchBackToOpus(tx, { now });
      if (!state) return null;
      await enqueueWebhookEvent(
        tx,
        input.aggregate,
        'teaching_engine.reviewer_provider_switched',
        () => switchPayload(state, toSol ? 'anthropic' : 'openai'),
      );
      log.warn(
        JSON.stringify({
          event: 'reviewer.provider_switched',
          activeProvider: state.activeProvider,
          reason: state.reason,
        }),
      );
      return state;
    });
  } catch (error) {
    log.error(
      JSON.stringify({
        event: 'reviewer.provider_switch_write_failed',
        error: error instanceof Error ? error.name : 'Error',
      }),
    );
    return null;
  }
}

export async function runReviewerCall(
  input: ReviewerCallInput,
  deps: ReviewerCallDeps = {},
): Promise<ReviewerCallResult> {
  const now = deps.now ?? Date.now;
  const choice = await (deps.chooseRoute ?? chooseReviewerRoute)(input.pool, now());
  const route = await (deps.resolveRoute ?? resolveReviewerRoute)(input.subjectCode, choice.mode);
  const execute = deps.executeStream ?? executeTeachingStream;
  let result: TeachingCallResult;
  try {
    result = await execute(
      route.policy,
      {
        tenantId: input.tenantId,
        capability: input.capability,
        stage: input.stage,
        origin: 'openmaic_runtime',
        association: input.association,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      {
        system: input.system,
        ...userTurn(input),
        maxOutputTokens: reviewerMaxOutputTokens(route.policy),
        output: input.output,
      },
      NOOP_SINK,
      {
        queryable: input.pool as unknown as Queryable,
        timeoutMs: REVIEWER_CALL_TIMEOUT_MS,
        fallbackOnRefusal: true,
        primaryOnly: route.primaryOnly,
        ...deps.executorOptions,
      },
    );
  } catch (error) {
    if (error instanceof TeachingModelUnavailableError) {
      const outcomes = error.outcomes.map((o) => ({
        role: o.role,
        outcome: o.outcome,
        modelString:
          o.modelString ??
          (o.role === 'primary'
            ? route.policy.primary.modelString
            : route.policy.fallback.modelString),
      }));
      await settleProviderSwitch(input, choice, outcomes, now());
    }
    throw error;
  }
  const switched = await settleProviderSwitch(input, choice, result.outcomes ?? [], now());
  const served =
    result.servedBy === 'primary'
      ? route.policy.primary.modelString
      : route.policy.fallback.modelString;
  return {
    parsed: result.parsed,
    provider: reviewerProviderOf(served),
    modelString: served,
    attemptIds: result.attemptIds,
    usage: result.usage,
    switched,
  };
}
