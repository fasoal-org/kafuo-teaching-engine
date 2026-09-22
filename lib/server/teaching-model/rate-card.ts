/**
 * Versioned rate card for the teaching model ledger (Kafuo R1 plan §5.1, §7.6).
 *
 * USD per 1M tokens, per canonical `provider:model` string. Versioned in git:
 * a priced ledger row records the `rate_card_version` it was priced with, so
 * a later price change never silently re-prices history. The optional
 * `MODEL_RATE_CARD_OVERRIDES_JSON` env replaces or adds entries and suffixes
 * the version with `+env`, so a row priced under an override says so.
 *
 * Sources (benchmarks-scripts, 22 Sep 2026):
 *  - Qwen tiers: `qwen_benchmark.py::QWEN_TIERS` — by request input tokens,
 *    ≤32K: 0.03 in / 0.13 out; ≤256K: 0.10 in / 0.40 out. The benchmark
 *    records no cache discount and DashScope reported zero cache in every
 *    run, so cached input is priced AT the fresh rate (an explicit upper
 *    bound, never a silent discount) and cache write is unpriced (`null`).
 *  - gpt-5-nano: `run_gpt5nano.py` PRICE_IN 0.05 / PRICE_CACHED_IN 0.005 / PRICE_OUT 0.40.
 *  - gpt-5.6-luna: `run_addround.py::PRICING` fresh_in 0.20 / cached_in 0.02 /
 *    out 1.20. Its `cache_write_in` 0.25 is recorded here for the record but
 *    the OpenAI family never reports a write field the executor accounts
 *    (plan §7.6: `cache_write_reported=false`, no write component), so it
 *    contributes nothing to a ledger cost.
 */

export const RATE_CARD_VERSION = 'rc-2026-09-22';

export interface RateTier {
  /** Inclusive upper bound on `input_tokens_total` for this tier. */
  maxInputTokens: number;
  inputPerM: number;
  cachedInputPerM: number;
  cacheWritePerM: number | null;
  outputPerM: number;
}

export interface RateEntry {
  inputPerM: number;
  cachedInputPerM: number;
  /** `null` = no write charge / no write field for this provider. */
  cacheWritePerM: number | null;
  outputPerM: number;
  /** Ascending by `maxInputTokens`; the last tier also covers anything larger. */
  tiers?: RateTier[];
}

export interface RateCard {
  version: string;
  entries: Readonly<Record<string, RateEntry>>;
}

export type EffectiveRate = Pick<
  RateEntry,
  'inputPerM' | 'cachedInputPerM' | 'cacheWritePerM' | 'outputPerM'
>;

const QWEN_TIERS: RateTier[] = [
  {
    maxInputTokens: 32_000,
    inputPerM: 0.03,
    cachedInputPerM: 0.03,
    cacheWritePerM: null,
    outputPerM: 0.13,
  },
  {
    maxInputTokens: 256_000,
    inputPerM: 0.1,
    cachedInputPerM: 0.1,
    cacheWritePerM: null,
    outputPerM: 0.4,
  },
];

export const BASE_RATE_CARD: RateCard = Object.freeze({
  version: RATE_CARD_VERSION,
  entries: Object.freeze({
    'qwen:qwen3.7-flash': {
      ...QWEN_TIERS[0]!,
      tiers: QWEN_TIERS,
    },
    'openai:gpt-5-nano': {
      inputPerM: 0.05,
      cachedInputPerM: 0.005,
      cacheWritePerM: null,
      outputPerM: 0.4,
    },
    'openai:gpt-5.6-luna': {
      inputPerM: 0.2,
      cachedInputPerM: 0.02,
      cacheWritePerM: 0.25,
      outputPerM: 1.2,
    },
  }),
});

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTier(raw: unknown): RateTier | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (
    !isFiniteNonNegative(t.maxInputTokens) ||
    !isFiniteNonNegative(t.inputPerM) ||
    !isFiniteNonNegative(t.cachedInputPerM) ||
    !isFiniteNonNegative(t.outputPerM) ||
    !(
      t.cacheWritePerM === null ||
      t.cacheWritePerM === undefined ||
      isFiniteNonNegative(t.cacheWritePerM)
    )
  ) {
    return null;
  }
  return {
    maxInputTokens: t.maxInputTokens,
    inputPerM: t.inputPerM,
    cachedInputPerM: t.cachedInputPerM,
    cacheWritePerM: isFiniteNonNegative(t.cacheWritePerM) ? t.cacheWritePerM : null,
    outputPerM: t.outputPerM,
  };
}

function parseEntry(raw: unknown): RateEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (
    !isFiniteNonNegative(e.inputPerM) ||
    !isFiniteNonNegative(e.cachedInputPerM) ||
    !isFiniteNonNegative(e.outputPerM) ||
    !(
      e.cacheWritePerM === null ||
      e.cacheWritePerM === undefined ||
      isFiniteNonNegative(e.cacheWritePerM)
    )
  ) {
    return null;
  }
  const entry: RateEntry = {
    inputPerM: e.inputPerM,
    cachedInputPerM: e.cachedInputPerM,
    cacheWritePerM: isFiniteNonNegative(e.cacheWritePerM) ? e.cacheWritePerM : null,
    outputPerM: e.outputPerM,
  };
  if (Array.isArray(e.tiers)) {
    const tiers = e.tiers.map(parseTier);
    if (tiers.some((tier) => tier === null)) return null;
    entry.tiers = (tiers as RateTier[]).sort((a, b) => a.maxInputTokens - b.maxInputTokens);
  }
  return entry;
}

/**
 * The rate card in force: the git-versioned base, with any valid entries from
 * `MODEL_RATE_CARD_OVERRIDES_JSON` layered on top. A malformed env value (bad
 * JSON, a negative price) is ignored entry-by-entry and reported through
 * `problems`; it never breaks pricing of the other models.
 */
export function loadRateCard(
  env: Record<string, string | undefined> = process.env,
): RateCard & { problems: string[] } {
  const raw = env.MODEL_RATE_CARD_OVERRIDES_JSON?.trim();
  if (!raw) return { ...BASE_RATE_CARD, problems: [] };
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('MODEL_RATE_CARD_OVERRIDES_JSON is not valid JSON; ignored');
    return { ...BASE_RATE_CARD, problems };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push(
      'MODEL_RATE_CARD_OVERRIDES_JSON must be an object of model string -> rate entry; ignored',
    );
    return { ...BASE_RATE_CARD, problems };
  }
  const entries: Record<string, RateEntry> = { ...BASE_RATE_CARD.entries };
  let applied = 0;
  for (const [modelString, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (!entry) {
      problems.push(`MODEL_RATE_CARD_OVERRIDES_JSON entry "${modelString}" is invalid; ignored`);
      continue;
    }
    entries[modelString] = entry;
    applied += 1;
  }
  return {
    version: applied > 0 ? `${RATE_CARD_VERSION}+env` : RATE_CARD_VERSION,
    entries: Object.freeze(entries),
    problems,
  };
}

/** Pick the tier for a request by its total input tokens (plan §7.6: Qwen tiers). */
export function selectRate(entry: RateEntry, inputTokensTotal: number | null): EffectiveRate {
  if (!entry.tiers?.length) return entry;
  const total = inputTokensTotal ?? 0;
  for (const tier of entry.tiers) {
    if (total <= tier.maxInputTokens) return tier;
  }
  return entry.tiers[entry.tiers.length - 1]!;
}
