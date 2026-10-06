import type { LanguageModelUsage } from 'ai';

/**
 * Normalized token usage in the four billable classes plus reasoning tokens.
 *
 * This mirrors cc-switch's `TokenUsage` shape (input / output / cacheRead /
 * cacheCreation) so the same per-class pricing model applies. `reasoningTokens`
 * is carried for display/diagnostics; it is part of output tokens for billing.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  /**
   * Per-field presence (Kafuo R1 plan §7.6). `true` when the provider's usage
   * object CARRIED the field, even with value 0. The numeric fields above
   * collapse "not reported" and "reported 0" to the same 0, which is right for
   * the JSONL log but wrong for accounting: a DashScope response without
   * `cached_tokens` must be stored as NULL (cost basis `no_cache_detail`),
   * while an OpenAI response with `cached_tokens: 0` is a real zero (`full`).
   */
  reported: UsageReported;
}

export interface UsageReported {
  inputTokens: boolean;
  outputTokens: boolean;
  cacheReadTokens: boolean;
  cacheCreationTokens: boolean;
  reasoningTokens: boolean;
}

function num(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isReported(value: number | undefined | null): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

const NOTHING_REPORTED: UsageReported = Object.freeze({
  inputTokens: false,
  outputTokens: false,
  cacheReadTokens: false,
  cacheCreationTokens: false,
  reasoningTokens: false,
});

/**
 * Extracts the four-class token shape from an AI SDK v6 `LanguageModelUsage`.
 *
 * Prefers the nested `inputTokenDetails` / `outputTokenDetails` fields and
 * falls back to the deprecated flat `cachedInputTokens` / `reasoningTokens`
 * for providers that only populate those. Any missing field becomes 0, so a
 * partial or absent usage object yields an all-zero record rather than NaN;
 * `reported` says which zeros are real.
 */
export function normalizeUsage(usage: LanguageModelUsage | undefined | null): NormalizedUsage {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      reported: { ...NOTHING_REPORTED },
    };
  }

  const nestedCacheRead = usage.inputTokenDetails?.cacheReadTokens;
  const nestedCacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  const nestedReasoning = usage.outputTokenDetails?.reasoningTokens;

  const cacheRead = num(nestedCacheRead) || num(usage.cachedInputTokens);
  const cacheCreation = num(nestedCacheWrite);
  const reasoning = num(nestedReasoning) || num(usage.reasoningTokens);

  return {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
    reported: {
      inputTokens: isReported(usage.inputTokens),
      outputTokens: isReported(usage.outputTokens),
      cacheReadTokens: isReported(nestedCacheRead) || isReported(usage.cachedInputTokens),
      cacheCreationTokens: isReported(nestedCacheWrite),
      reasoningTokens: isReported(nestedReasoning) || isReported(usage.reasoningTokens),
    },
  };
}

/**
 * Whether the usage has any billable tokens. Used to skip writing empty rows
 * when an OpenAI-compatible upstream omits usage on a streamed response
 * (mirrors cc-switch `parser.rs::has_billable_tokens`).
 */
export function hasBillableTokens(
  // The numeric shape only: `reported` is optional so pre-existing callers and
  // tests that build the five-field record keep compiling.
  usage: Omit<NormalizedUsage, 'reported'> & { reported?: UsageReported },
): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0
  );
}
