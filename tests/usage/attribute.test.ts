import { describe, expect, it } from 'vitest';

import { normalizeUsage, type NormalizedUsage } from '@/lib/usage/normalize';
import {
  attributeUsage,
  computeCost,
  deriveTokenClasses,
  providerFamily,
} from '@/lib/usage/attribute';
import { BASE_RATE_CARD, type RateCard } from '@/lib/server/teaching-model/rate-card';

/**
 * Kafuo R1 plan §7.6 (review finding F4): per provider family `fresh`
 * equations, NULL vs 0, the `no_cache_detail` upper bound, no write component
 * unless reported, reasoning never added twice, `usage_inconsistent`, Qwen
 * tiers.
 */

function usage(partial: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): NormalizedUsage {
  return normalizeUsage({
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: partial.cacheReadTokens,
      cacheWriteTokens: partial.cacheWriteTokens,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: partial.reasoningTokens },
  } as never);
}

describe('providerFamily', () => {
  it('maps the registered providers onto the four accounting families', () => {
    expect(providerFamily('openai')).toBe('openai');
    expect(providerFamily('qwen')).toBe('qwen');
    expect(providerFamily('anthropic')).toBe('anthropic');
    expect(providerFamily('deepseek')).toBe('default');
  });
});

describe('deriveTokenClasses — openai family (prompt_tokens ⊇ cached_tokens; no write field)', () => {
  it('fresh = total − read when read is reported', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, reasoningTokens: 50 }),
      'openai',
    );
    expect(classes).toMatchObject({
      usageAvailable: true,
      inputTokensTotal: 1000,
      cacheReadTokens: 600,
      freshInputTokens: 400,
      cacheWriteTokens: null,
      cacheWriteReported: false,
      outputTokensTotal: 200,
      reasoningTokens: 50,
      visibleOutputTokens: 150,
      cacheReadReported: true,
      reasoningReported: true,
      usageInconsistent: false,
      usageUnavailableReason: null,
    });
  });

  it('cached_tokens reported as 0 stores 0 (not NULL) and fresh = total', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 }),
      'openai',
    );
    expect(classes.cacheReadTokens).toBe(0);
    expect(classes.cacheReadReported).toBe(true);
    expect(classes.freshInputTokens).toBe(1000);
  });

  it('a write value the SDK carried is NOT subtracted for openai (no write field exists)', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 300 }),
      'openai',
    );
    expect(classes.cacheWriteReported).toBe(false);
    expect(classes.cacheWriteTokens).toBeNull();
    expect(classes.freshInputTokens).toBe(900);
  });
});

describe('deriveTokenClasses — qwen family (total ⊇ read and ⊇ write when reported)', () => {
  it('fresh = total − read − write when both are reported', () => {
    const classes = deriveTokenClasses(
      usage({
        inputTokens: 5000,
        outputTokens: 400,
        cacheReadTokens: 1000,
        cacheWriteTokens: 2000,
      }),
      'qwen',
    );
    expect(classes.freshInputTokens).toBe(2000);
    expect(classes.cacheWriteTokens).toBe(2000);
    expect(classes.cacheWriteReported).toBe(true);
  });

  it('a DashScope response without cached_tokens stores NULL, fresh = total', () => {
    const classes = deriveTokenClasses(usage({ inputTokens: 5000, outputTokens: 400 }), 'qwen');
    expect(classes.cacheReadTokens).toBeNull();
    expect(classes.cacheReadReported).toBe(false);
    expect(classes.cacheWriteTokens).toBeNull();
    expect(classes.freshInputTokens).toBe(5000);
  });

  it('flags usage_inconsistent and clamps fresh at 0 when read + write exceed the total', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 80, cacheWriteTokens: 50 }),
      'qwen',
    );
    expect(classes.usageInconsistent).toBe(true);
    expect(classes.freshInputTokens).toBe(0);
  });
});

describe('deriveTokenClasses — anthropic family (input_tokens excludes both)', () => {
  it('fresh = total, read and write carried separately', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 300, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 1000 }),
      'anthropic',
    );
    expect(classes.freshInputTokens).toBe(300);
    expect(classes.cacheReadTokens).toBe(5000);
    expect(classes.cacheWriteTokens).toBe(1000);
    expect(classes.usageInconsistent).toBe(false);
  });
});

describe('deriveTokenClasses — unavailable is never zero', () => {
  it('null usage → usage_missing with every column NULL', () => {
    const classes = deriveTokenClasses(null, 'openai');
    expect(classes.usageAvailable).toBe(false);
    expect(classes.usageUnavailableReason).toBe('usage_missing');
    expect(classes.inputTokensTotal).toBeNull();
    expect(classes.outputTokensTotal).toBeNull();
    expect(classes.freshInputTokens).toBeNull();
  });

  it('a usage object that carried neither total (streamed response without usage) → usage_missing', () => {
    const classes = deriveTokenClasses(usage({ cacheReadTokens: 0 }), 'openai');
    expect(classes.usageAvailable).toBe(false);
    expect(classes.usageUnavailableReason).toBe('usage_missing');
  });

  it('reasoning absent → NULL; visible output falls back to the full output', () => {
    const classes = deriveTokenClasses(usage({ inputTokens: 10, outputTokens: 70 }), 'qwen');
    expect(classes.reasoningTokens).toBeNull();
    expect(classes.reasoningReported).toBe(false);
    expect(classes.visibleOutputTokens).toBe(70);
  });
});

describe('computeCost', () => {
  const card: RateCard = {
    version: 'rc-test',
    entries: {
      'openai:gpt-5-nano': {
        inputPerM: 0.05,
        cachedInputPerM: 0.005,
        cacheWritePerM: null,
        outputPerM: 0.4,
      },
      'qwen:qwen3.7-flash': {
        inputPerM: 0.03,
        cachedInputPerM: 0.03,
        cacheWritePerM: null,
        outputPerM: 0.13,
        tiers: [
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
        ],
      },
      'anthropic:claude-x': {
        inputPerM: 3,
        cachedInputPerM: 0.3,
        cacheWritePerM: 3.75,
        outputPerM: 15,
      },
    },
  };

  it('full basis: fresh×in + read×cached + output×out (reasoning inside output, never added twice)', () => {
    const classes = deriveTokenClasses(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 400_000,
        reasoningTokens: 900_000,
      }),
      'openai',
    );
    const cost = computeCost(classes, card, 'openai:gpt-5-nano');
    // fresh 600k × 0.05 + read 400k × 0.005 + out 1M × 0.40 = 0.03 + 0.002 + 0.40
    expect(cost).toEqual({
      rateCardVersion: 'rc-test',
      costUsd: 0.432,
      costBasis: 'full',
      costUnavailableReason: null,
    });
  });

  it('cache read reported as 0 still prices on the full basis', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0 }),
      'openai',
    );
    const cost = computeCost(classes, card, 'openai:gpt-5-nano');
    expect(cost.costBasis).toBe('full');
    expect(cost.costUsd).toBe(0.005);
  });

  it('no_cache_detail: all input at the fresh rate, no write component (upper bound)', () => {
    const classes = deriveTokenClasses(usage({ inputTokens: 1_000_000, outputTokens: 0 }), 'qwen');
    const cost = computeCost(classes, card, 'qwen:qwen3.7-flash');
    expect(cost.costBasis).toBe('no_cache_detail');
    // 1M input selects the second Qwen tier (32K < input ≤ 256K → 0.10 / 0.40).
    expect(cost.costUsd).toBe(0.1);
  });

  it('Qwen tier is selected by input_tokens_total', () => {
    const small = deriveTokenClasses(
      usage({ inputTokens: 20_000, outputTokens: 10_000, cacheReadTokens: 0 }),
      'qwen',
    );
    const large = deriveTokenClasses(
      usage({ inputTokens: 40_000, outputTokens: 10_000, cacheReadTokens: 0 }),
      'qwen',
    );
    expect(computeCost(small, card, 'qwen:qwen3.7-flash').costUsd).toBeCloseTo(
      (20_000 * 0.03 + 10_000 * 0.13) / 1e6,
      10,
    );
    expect(computeCost(large, card, 'qwen:qwen3.7-flash').costUsd).toBeCloseTo(
      (40_000 * 0.1 + 10_000 * 0.4) / 1e6,
      10,
    );
  });

  it('write is priced only when reported AND the rate has a write price', () => {
    const anthropic = deriveTokenClasses(
      usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }),
      'anthropic',
    );
    expect(computeCost(anthropic, card, 'anthropic:claude-x').costUsd).toBe(3.75);
    const qwenWrite = deriveTokenClasses(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000_000,
      }),
      'qwen',
    );
    // fresh = 0 (total − write); write unpriced (cacheWritePerM null) → 0
    expect(computeCost(qwenWrite, card, 'qwen:qwen3.7-flash').costUsd).toBe(0);
  });

  it('usage_missing → cost NULL with reason; rate_card_missing when the model is unpriced', () => {
    expect(computeCost(deriveTokenClasses(null, 'openai'), card, 'openai:gpt-5-nano')).toEqual({
      rateCardVersion: null,
      costUsd: null,
      costBasis: null,
      costUnavailableReason: 'usage_missing',
    });
    const classes = deriveTokenClasses(usage({ inputTokens: 1, outputTokens: 1 }), 'openai');
    expect(computeCost(classes, card, 'openai:unpriced-model')).toEqual({
      rateCardVersion: 'rc-test',
      costUsd: null,
      costBasis: null,
      costUnavailableReason: 'rate_card_missing',
    });
  });

  it('usage_inconsistent still prices with fresh clamped at 0', () => {
    const classes = deriveTokenClasses(
      usage({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 80, cacheWriteTokens: 50 }),
      'qwen',
    );
    expect(classes.usageInconsistent).toBe(true);
    const cost = computeCost(classes, card, 'qwen:qwen3.7-flash');
    expect(cost.costBasis).toBe('full');
    expect(cost.costUsd).toBeCloseTo((80 * 0.03) / 1e6, 12);
  });

  it('attributeUsage prices the seeded acceptance pair (plan P2 acceptance)', () => {
    // OpenAI row with cached_tokens=0 reported → 0 stored, basis full.
    const openai = attributeUsage(
      usage({ inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0 }),
      'openai',
      'openai:gpt-5-nano',
      BASE_RATE_CARD,
    );
    expect(openai.classes.cacheReadTokens).toBe(0);
    expect(openai.cost.costBasis).toBe('full');
    // DashScope row without cached_tokens → NULL stored, basis no_cache_detail.
    const qwen = attributeUsage(
      usage({ inputTokens: 5000, outputTokens: 100 }),
      'qwen',
      'qwen:qwen3.7-flash',
      BASE_RATE_CARD,
    );
    expect(qwen.classes.cacheReadTokens).toBeNull();
    expect(qwen.cost.costBasis).toBe('no_cache_detail');
    expect(qwen.cost.rateCardVersion).toBe(BASE_RATE_CARD.version);
  });
});
