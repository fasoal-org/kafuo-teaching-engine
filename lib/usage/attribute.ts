/**
 * Token-class attribution and cost for the teaching model ledger (Kafuo R1
 * plan §7.6, review finding F4).
 *
 * Providers disagree on whether their input total already INCLUDES the cached
 * portion. Subtracting a cache read that was never inside the total, or
 * charging a cache write the provider never reported, double-charges or
 * under-charges. So the equations are per provider family, and every
 * subtraction uses `x_if_reported = reported.x ? x : 0`, with the stored
 * column NULL (not 0) when the provider did not report the field.
 *
 * | family    | total ⊇ read | total ⊇ write | output ⊇ reasoning | fresh                          |
 * | openai    | yes          | no write field| yes                | total − read_if_reported       |
 * | qwen      | yes          | yes if reported| yes               | total − read − write (if rep.) |
 * | anthropic | no           | no            | yes                | total                          |
 * | default   | as openai (the OpenAI-compatible convention every other registered provider follows) |
 *
 * `usage_inconsistent` flags `fresh < 0` (cost still computed with fresh
 * clamped at 0). `visible_output = output − reasoning_if_reported` is
 * informational only; reasoning is inside `output_total` and never priced
 * twice.
 */
import type { NormalizedUsage } from '@/lib/usage/normalize';
import { selectRate, type RateCard } from '@/lib/server/teaching-model/rate-card';

export type ProviderFamily = 'openai' | 'qwen' | 'anthropic' | 'default';

export function providerFamily(providerId: string): ProviderFamily {
  switch (providerId) {
    case 'openai':
    case 'azure':
      return 'openai';
    case 'qwen':
      return 'qwen';
    case 'anthropic':
    case 'bedrock':
    case 'minimax':
      return 'anthropic';
    default:
      return 'default';
  }
}

export interface TokenClasses {
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

export const USAGE_MISSING: TokenClasses = Object.freeze({
  usageAvailable: false,
  inputTokensTotal: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  freshInputTokens: null,
  outputTokensTotal: null,
  reasoningTokens: null,
  visibleOutputTokens: null,
  cacheReadReported: false,
  cacheWriteReported: false,
  reasoningReported: false,
  usageUnavailableReason: 'usage_missing',
  usageInconsistent: false,
});

/**
 * Derive the ledger's token classes from a normalized usage record. Usage is
 * "available" only when the provider reported the input OR output total; a
 * usage object that carried neither (a streamed response that omitted usage)
 * is `usage_missing`, all columns NULL — unavailable is never zero (EFF-04).
 */
export function deriveTokenClasses(
  normalized: NormalizedUsage | null | undefined,
  providerId: string,
): TokenClasses {
  if (!normalized) return { ...USAGE_MISSING };
  const reported = normalized.reported;
  if (!reported.inputTokens && !reported.outputTokens) return { ...USAGE_MISSING };

  const family = providerFamily(providerId);
  const inputTotal = reported.inputTokens ? normalized.inputTokens : null;
  const outputTotal = reported.outputTokens ? normalized.outputTokens : null;
  const read = reported.cacheReadTokens ? normalized.cacheReadTokens : null;
  const reasoning = reported.reasoningTokens ? normalized.reasoningTokens : null;

  // OpenAI has no write field at all: whatever the SDK carried is not a
  // write the provider bills inside the total, so it is recorded as not
  // reported (plan §7.6) rather than subtracted.
  const writeReported = family === 'openai' ? false : reported.cacheCreationTokens;
  const write = writeReported ? normalized.cacheCreationTokens : null;

  let fresh: number | null = null;
  if (inputTotal !== null) {
    switch (family) {
      case 'anthropic':
        fresh = inputTotal;
        break;
      case 'qwen':
        fresh = inputTotal - (read ?? 0) - (write ?? 0);
        break;
      case 'openai':
      case 'default':
        fresh = inputTotal - (read ?? 0);
        break;
    }
  }
  const inconsistent = fresh !== null && fresh < 0;

  return {
    usageAvailable: true,
    inputTokensTotal: inputTotal,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    freshInputTokens: fresh === null ? null : Math.max(0, fresh),
    outputTokensTotal: outputTotal,
    reasoningTokens: reasoning,
    visibleOutputTokens: outputTotal === null ? null : Math.max(0, outputTotal - (reasoning ?? 0)),
    cacheReadReported: reported.cacheReadTokens,
    cacheWriteReported: writeReported,
    reasoningReported: reported.reasoningTokens,
    usageUnavailableReason: null,
    usageInconsistent: inconsistent,
  };
}

export type CostBasis = 'full' | 'no_cache_detail';
export type CostUnavailableReason = 'usage_missing' | 'rate_card_missing';

export interface CostResult {
  rateCardVersion: string | null;
  costUsd: number | null;
  costBasis: CostBasis | null;
  costUnavailableReason: CostUnavailableReason | null;
}

/**
 * Cost in USD from the token classes and the rate card (plan §7.6):
 *
 *   full:            fresh×in + read×cached + write×cacheWrite + output×out
 *   no_cache_detail: total×in + output×out   (cache read not reported — an
 *                    explicit upper bound, no write component)
 *
 * Reasoning is inside `output_total` and is never added again. The Qwen tier
 * is selected by `input_tokens_total`.
 */
export function computeCost(
  classes: TokenClasses,
  rateCard: RateCard,
  modelString: string,
): CostResult {
  if (!classes.usageAvailable) {
    return {
      rateCardVersion: null,
      costUsd: null,
      costBasis: null,
      costUnavailableReason: 'usage_missing',
    };
  }
  const entry = rateCard.entries[modelString];
  if (!entry) {
    return {
      rateCardVersion: rateCard.version,
      costUsd: null,
      costBasis: null,
      costUnavailableReason: 'rate_card_missing',
    };
  }
  const rate = selectRate(entry, classes.inputTokensTotal);
  const output = (classes.outputTokensTotal ?? 0) * rate.outputPerM;
  let cost: number;
  let basis: CostBasis;
  if (classes.cacheReadReported) {
    const fresh = classes.freshInputTokens ?? 0;
    const read = classes.cacheReadTokens ?? 0;
    const write =
      classes.cacheWriteReported && rate.cacheWritePerM !== null
        ? (classes.cacheWriteTokens ?? 0)
        : 0;
    cost =
      fresh * rate.inputPerM +
      read * rate.cachedInputPerM +
      write * (rate.cacheWritePerM ?? 0) +
      output;
    basis = 'full';
  } else {
    cost = (classes.inputTokensTotal ?? 0) * rate.inputPerM + output;
    basis = 'no_cache_detail';
  }
  // NUMERIC(14,8) in the ledger: round here so the stored value equals the
  // computed one and two rows priced identically compare equal.
  const costUsd = Math.round((cost / 1e6) * 1e8) / 1e8;
  return {
    rateCardVersion: rateCard.version,
    costUsd,
    costBasis: basis,
    costUnavailableReason: null,
  };
}

/** The pair the executor persists on the completion row. */
export interface AttributedUsage {
  classes: TokenClasses;
  cost: CostResult;
}

export function attributeUsage(
  normalized: NormalizedUsage | null | undefined,
  providerId: string,
  modelString: string,
  rateCard: RateCard,
): AttributedUsage {
  const classes = deriveTokenClasses(normalized, providerId);
  return { classes, cost: computeCost(classes, rateCard, modelString) };
}
