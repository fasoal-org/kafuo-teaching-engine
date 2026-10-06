import { describe, expect, it } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { normalizeUsage, hasBillableTokens } from '@/lib/usage/normalize';

/**
 * Builds a minimal AI SDK v6 LanguageModelUsage object. Any field left
 * undefined exercises the "missing → 0" normalization path.
 */
function makeUsage(partial: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): LanguageModelUsage {
  return {
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    totalTokens: partial.totalTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: partial.cacheReadTokens,
      cacheWriteTokens: partial.cacheWriteTokens,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: partial.reasoningTokens,
    },
  } as LanguageModelUsage;
}

describe('normalizeUsage', () => {
  it('extracts the v6 four-class token shape', () => {
    const result = normalizeUsage(
      makeUsage({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
      }),
    );
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      reasoningTokens: 5,
      reported: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheCreationTokens: true,
        reasoningTokens: true,
      },
    });
  });

  it('fills missing fields with 0', () => {
    const result = normalizeUsage(makeUsage({ inputTokens: 9 }));
    expect(result).toEqual({
      inputTokens: 9,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      reported: {
        inputTokens: true,
        outputTokens: false,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('handles a fully empty usage object', () => {
    const result = normalizeUsage(makeUsage({}));
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      reported: {
        inputTokens: false,
        outputTokens: false,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });

  it('falls back to deprecated cachedInputTokens / reasoningTokens flat fields', () => {
    // Some providers populate the deprecated flat fields rather than the nested details.
    const usage = {
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      cachedInputTokens: 7,
      reasoningTokens: 3,
    } as LanguageModelUsage;
    const result = normalizeUsage(usage);
    expect(result.cacheReadTokens).toBe(7);
    expect(result.reasoningTokens).toBe(3);
  });

  it('tolerates a null/undefined usage object', () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      reported: {
        inputTokens: false,
        outputTokens: false,
        cacheReadTokens: false,
        cacheCreationTokens: false,
        reasoningTokens: false,
      },
    });
  });
});

describe('hasBillableTokens', () => {
  it('returns false when every class is 0', () => {
    expect(
      hasBillableTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(false);
  });

  it('returns true when any billable class is non-zero', () => {
    expect(
      hasBillableTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(true);
  });
});

/**
 * Kafuo R1 plan §7.6: the numeric fields collapse "not reported" and
 * "reported 0" to 0 (right for the JSONL log); `reported` keeps them apart
 * for the ledger, where an absent cache field must be stored as NULL.
 */
describe('normalizeUsage — reported flags (reported-zero vs absent, per field)', () => {
  it('a field carried with value 0 is reported; an absent field is not', () => {
    const result = normalizeUsage(
      makeUsage({ inputTokens: 40, outputTokens: 0, cacheReadTokens: 0 }),
    );
    expect(result.cacheReadTokens).toBe(0);
    expect(result.reported).toEqual({
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: false,
      reasoningTokens: false,
    });
  });

  it('a DashScope-style usage without cached_tokens reports cache read absent', () => {
    const result = normalizeUsage(makeUsage({ inputTokens: 1200, outputTokens: 300 }));
    expect(result.cacheReadTokens).toBe(0);
    expect(result.reported.cacheReadTokens).toBe(false);
    expect(result.reported.cacheCreationTokens).toBe(false);
  });

  it('a DashScope-style usage with cache_write_tokens reports the write', () => {
    const result = normalizeUsage(
      makeUsage({
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 900,
      }),
    );
    expect(result.cacheCreationTokens).toBe(900);
    expect(result.reported.cacheCreationTokens).toBe(true);
    expect(result.reported.cacheReadTokens).toBe(true);
  });

  it('the deprecated flat fields count as reported', () => {
    const usage = {
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cachedInputTokens: 0,
      reasoningTokens: 3,
    } as LanguageModelUsage;
    const result = normalizeUsage(usage);
    expect(result.reported.cacheReadTokens).toBe(true);
    expect(result.reported.reasoningTokens).toBe(true);
    expect(result.reported.cacheCreationTokens).toBe(false);
  });

  it('reasoning reported as 0 stays distinguishable from reasoning absent', () => {
    const zero = normalizeUsage(makeUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }));
    const absent = normalizeUsage(makeUsage({ inputTokens: 1, outputTokens: 1 }));
    expect(zero.reasoningTokens).toBe(absent.reasoningTokens);
    expect(zero.reported.reasoningTokens).toBe(true);
    expect(absent.reported.reasoningTokens).toBe(false);
  });

  it('hasBillableTokens ignores the flags entirely (unchanged behaviour)', () => {
    const absent = normalizeUsage(makeUsage({}));
    expect(hasBillableTokens(absent)).toBe(false);
    const reportedZero = normalizeUsage(makeUsage({ inputTokens: 0, outputTokens: 0 }));
    expect(hasBillableTokens(reportedZero)).toBe(false);
    expect(hasBillableTokens(normalizeUsage(makeUsage({ outputTokens: 1 })))).toBe(true);
  });
});
