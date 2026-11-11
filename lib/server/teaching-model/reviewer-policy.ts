/**
 * The AI reviewer's model policy (ai-reviewer-layer plan D-2, D-3, §4.2, §4.5).
 *
 * Separate from the per-subject generation table (`subject-policy.ts`): the
 * reviewer has ONE route for every subject, primary Claude Opus 5.5 and
 * fallback GPT-6 Sol, both code-owned. No operator config (`MODEL_ROUTES`,
 * `DEFAULT_MODEL`) can shadow it, because both targets are resolved by model
 * string with no stage, exactly like the subject policy (ROUTE-01).
 *
 * The owner decisions still open are built as defaults, one constant each
 * (implementation prompt "Owner decisions still open"):
 *  - O-2 `REVIEWER_PROBE_INTERVAL_MS`: after 24 h on Sol the next review tries
 *    Opus once (see `reviewer-provider-state.ts`).
 *  - O-3 `REVIEWER_SERVER_SIDE_REFUSAL_FALLBACK`: Anthropic's server-side
 *    refusal fallback stays OFF; a `refusal` stop reason is retried on Sol
 *    through the executor's `fallbackOnRefusal`.
 * O-1 (may the teacher approve an `unavailable` review) is the Backend's gate.
 */
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveModel } from '@/lib/server/resolve-model';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type {
  ResolvedSubjectPolicy,
  ResolvedTarget,
  TargetRole,
} from '@/lib/server/teaching-model/resolve-policy';
import type { SubjectCode } from '@/lib/server/teaching-model/subject-policy';
import { counterKindForProvider } from '@/lib/server/teaching-model/subject-policy';

export const REVIEWER_POLICY_VERSION = 'reviewer-2026-11';

/** D-2: the primary while the Anthropic credit lasts. */
export const REVIEWER_PRIMARY_MODEL = 'anthropic:claude-opus-5-5';
/**
 * D-2: the fallback. Official id from OpenAI's model page (10 Nov 2026).
 * `gpt-6.1-sol` also exists; switching to it is the owner's call.
 */
export const REVIEWER_FALLBACK_MODEL = 'openai:gpt-6-sol';

export type ReviewerProvider = 'anthropic' | 'openai';
export const REVIEWER_PRIMARY_PROVIDER: ReviewerProvider = 'anthropic';
export const REVIEWER_FALLBACK_PROVIDER: ReviewerProvider = 'openai';

/** O-2 default: how long the reviewer stays on Sol before it tries Opus once. */
export const REVIEWER_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** O-3 default: Anthropic's server-side refusal fallback is not switched on. */
export const REVIEWER_SERVER_SIDE_REFUSAL_FALLBACK = false;

/**
 * One reviewer call may take minutes at effort `high` (a whole package in one
 * call). The executor's 110 s default would time both routes out, so reviewer
 * calls stream with this bound instead.
 */
export const REVIEWER_CALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * D-4: reviewer output bound (adaptive thinking at effort `high` plus the JSON
 * findings, never the slides themselves). Each call is further capped by the
 * real output window of the models it may run on (`reviewerMaxOutputTokens`).
 */
export const REVIEWER_MAX_OUTPUT_TOKENS = 64_000;

/**
 * The output bound of one reviewer call: `REVIEWER_MAX_OUTPUT_TOKENS`, never
 * above the registry's `outputWindow` of either resolved target (one bound is
 * sent to both the primary and the fallback).
 */
export function reviewerMaxOutputTokens(
  policy: Pick<ResolvedSubjectPolicy, 'primary' | 'fallback'>,
): number {
  const windows = [policy.primary, policy.fallback]
    .map((target) => target.modelInfo?.outputWindow)
    .filter((window): window is number => typeof window === 'number' && window > 0);
  return Math.min(REVIEWER_MAX_OUTPUT_TOKENS, ...windows);
}

interface ReviewerTarget {
  readonly model: string;
  readonly thinking: ThinkingConfig;
  readonly label: string;
}

/**
 * Opus 5.5: adaptive thinking (the API rejects `disabled`; the metadata makes
 * it non-toggleable) with `output_config.effort: "high"` set explicitly — the
 * API default `medium` is too low for re-solving worked examples (§4.2).
 */
const OPUS_HIGH: ReviewerTarget = Object.freeze({
  model: REVIEWER_PRIMARY_MODEL,
  thinking: Object.freeze({ mode: 'enabled', effort: 'high' }) as ThinkingConfig,
  label: 'high',
});

const SOL_HIGH: ReviewerTarget = Object.freeze({
  model: REVIEWER_FALLBACK_MODEL,
  thinking: Object.freeze({ mode: 'enabled', effort: 'high' }) as ThinkingConfig,
  label: 'high',
});

export const REVIEWER_POLICY = Object.freeze({ primary: OPUS_HIGH, fallback: SOL_HIGH });

/** Which provider a reviewer model string belongs to. */
export function reviewerProviderOf(modelString: string): ReviewerProvider | null {
  if (modelString === REVIEWER_PRIMARY_MODEL) return REVIEWER_PRIMARY_PROVIDER;
  if (modelString === REVIEWER_FALLBACK_MODEL) return REVIEWER_FALLBACK_PROVIDER;
  return null;
}

async function resolveTarget(role: TargetRole, target: ReviewerTarget): Promise<ResolvedTarget> {
  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    resolved = await resolveModel({ modelString: target.model });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `reviewer ${role} model ${target.model} cannot be resolved (${detail})`,
      { role, model: target.model },
    );
  }
  if (!resolved.modelInfo) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `reviewer ${role} model ${target.model} is not registered in the provider catalog`,
      { role, model: target.model },
    );
  }
  return {
    role,
    modelString: target.model,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    model: resolved.model,
    modelInfo: resolved.modelInfo,
    thinking: target.thinking,
    thinkingLabel: target.label,
    counterKind: counterKindForProvider(resolved.providerId),
  };
}

export interface ResolvedReviewerRoute {
  policy: ResolvedSubjectPolicy;
  /** True when only Sol runs (the switch is active and no probe is due). */
  primaryOnly: boolean;
}

/**
 * The reviewer route for one call.
 *
 *  - `opus`: primary Opus, fallback Sol (the normal route, and the O-2 probe).
 *  - `sol`:  Sol alone (D-3: after the switch every review goes to Sol).
 *
 * Each target resolves on its own: a missing Anthropic key still leaves Sol,
 * and a missing Sol key still leaves Opus. Only when nothing resolves does
 * this throw `SUBJECT_ROUTE_UNAVAILABLE`; the review then ends `unavailable`.
 *
 * `subjectCode` is the reviewed package's subject, recorded on the ledger row
 * only (its `subject_code` column is free text; the executor does not route
 * on it).
 */
export async function resolveReviewerRoute(
  subjectCode: string,
  mode: 'opus' | 'sol',
  resolve: typeof resolveTarget = resolveTarget,
): Promise<ResolvedReviewerRoute> {
  const [opus, sol] = await Promise.allSettled([
    mode === 'opus' ? resolve('primary', OPUS_HIGH) : Promise.reject(new Error('not used')),
    resolve(mode === 'opus' ? 'fallback' : 'primary', SOL_HIGH),
  ]);
  const code = (subjectCode || 'UNKNOWN') as SubjectCode;
  const policy = (primary: ResolvedTarget, fallback: ResolvedTarget): ResolvedSubjectPolicy => ({
    subjectCode: code,
    policyVersion: REVIEWER_POLICY_VERSION,
    primary,
    fallback,
  });
  if (opus.status === 'fulfilled' && sol.status === 'fulfilled') {
    return { policy: policy(opus.value, sol.value), primaryOnly: false };
  }
  if (opus.status === 'fulfilled') {
    return { policy: policy(opus.value, opus.value), primaryOnly: true };
  }
  if (sol.status === 'fulfilled') {
    const asPrimary: ResolvedTarget = { ...sol.value, role: 'primary' };
    return { policy: policy(asPrimary, asPrimary), primaryOnly: true };
  }
  const reason = sol.reason instanceof Error ? sol.reason.message : String(sol.reason);
  throw new TeachingPackageError(
    'SUBJECT_ROUTE_UNAVAILABLE',
    `no reviewer route resolves (${reason})`,
    {},
  );
}
