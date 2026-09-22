import { describe, expect, it } from 'vitest';

import {
  BASE_RATE_CARD,
  loadRateCard,
  RATE_CARD_VERSION,
  selectRate,
} from '@/lib/server/teaching-model/rate-card';
import { policyModelStrings } from '@/lib/server/teaching-model/subject-policy';
import { computeCost, deriveTokenClasses } from '@/lib/usage/attribute';
import { normalizeUsage } from '@/lib/usage/normalize';

describe('rate card', () => {
  it('prices every model the subject policy names', () => {
    for (const modelString of policyModelStrings()) {
      expect(BASE_RATE_CARD.entries[modelString], modelString).toBeDefined();
      const classes = deriveTokenClasses(
        normalizeUsage({ inputTokens: 1000, outputTokens: 100 } as never),
        modelString.split(':')[0]!,
      );
      const cost = computeCost(classes, BASE_RATE_CARD, modelString);
      expect(cost.costUnavailableReason, modelString).toBeNull();
      expect(cost.costUsd, modelString).toBeGreaterThan(0);
      expect(cost.rateCardVersion).toBe(RATE_CARD_VERSION);
    }
  });

  it('carries the benchmark constants', () => {
    expect(BASE_RATE_CARD.entries['openai:gpt-5-nano']).toMatchObject({
      inputPerM: 0.05,
      cachedInputPerM: 0.005,
      outputPerM: 0.4,
      cacheWritePerM: null,
    });
    expect(BASE_RATE_CARD.entries['openai:gpt-5.6-luna']).toMatchObject({
      inputPerM: 0.2,
      cachedInputPerM: 0.02,
      outputPerM: 1.2,
    });
    const qwen = BASE_RATE_CARD.entries['qwen:qwen3.7-flash']!;
    expect(qwen.tiers).toEqual([
      expect.objectContaining({ maxInputTokens: 32_000, inputPerM: 0.03, outputPerM: 0.13 }),
      expect.objectContaining({ maxInputTokens: 256_000, inputPerM: 0.1, outputPerM: 0.4 }),
    ]);
  });

  it('selectRate picks the Qwen tier by input tokens (last tier covers overflow)', () => {
    const qwen = BASE_RATE_CARD.entries['qwen:qwen3.7-flash']!;
    expect(selectRate(qwen, 32_000).inputPerM).toBe(0.03);
    expect(selectRate(qwen, 32_001).inputPerM).toBe(0.1);
    expect(selectRate(qwen, 999_999).inputPerM).toBe(0.1);
    expect(selectRate(qwen, null).inputPerM).toBe(0.03);
    // Flat entries return themselves.
    const nano = BASE_RATE_CARD.entries['openai:gpt-5-nano']!;
    expect(selectRate(nano, 5_000_000)).toBe(nano);
  });

  it('MODEL_RATE_CARD_OVERRIDES_JSON layers entries and suffixes the version with +env', () => {
    const card = loadRateCard({
      MODEL_RATE_CARD_OVERRIDES_JSON: JSON.stringify({
        'qwen:qwen3.7-flash': {
          inputPerM: 0.02,
          cachedInputPerM: 0.004,
          cacheWritePerM: null,
          outputPerM: 0.1,
        },
        'openai:gpt-5.7': { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 4 },
      }),
    });
    expect(card.version).toBe(`${RATE_CARD_VERSION}+env`);
    expect(card.entries['qwen:qwen3.7-flash']).toEqual({
      inputPerM: 0.02,
      cachedInputPerM: 0.004,
      cacheWritePerM: null,
      outputPerM: 0.1,
    });
    expect(card.entries['openai:gpt-5.7']?.cacheWritePerM).toBeNull();
    // Untouched entries survive.
    expect(card.entries['openai:gpt-5-nano']).toEqual(BASE_RATE_CARD.entries['openai:gpt-5-nano']);
    expect(card.problems).toEqual([]);
  });

  it('a malformed override is ignored entry-by-entry and the version stays unsuffixed', () => {
    const invalidEntry = loadRateCard({
      MODEL_RATE_CARD_OVERRIDES_JSON: JSON.stringify({ 'openai:gpt-5-nano': { inputPerM: -1 } }),
    });
    expect(invalidEntry.version).toBe(RATE_CARD_VERSION);
    expect(invalidEntry.entries['openai:gpt-5-nano']).toEqual(
      BASE_RATE_CARD.entries['openai:gpt-5-nano'],
    );
    expect(invalidEntry.problems).toHaveLength(1);

    const badJson = loadRateCard({ MODEL_RATE_CARD_OVERRIDES_JSON: '{nope' });
    expect(badJson.version).toBe(RATE_CARD_VERSION);
    expect(badJson.problems[0]).toContain('not valid JSON');

    expect(loadRateCard({})).toMatchObject({ version: RATE_CARD_VERSION, problems: [] });
  });
});
