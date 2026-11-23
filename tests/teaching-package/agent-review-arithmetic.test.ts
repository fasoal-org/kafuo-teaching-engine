/**
 * The agent book review's restricted arithmetic (Kafuo Agent API D2a, design §4):
 * no eval, units tracked, the claim compared at half its last significant digit.
 */
import { describe, expect, it } from 'vitest';

import {
  checkComputation,
  claimedWithTolerance,
  parseUnits,
  recompute,
} from '@/lib/server/teaching-package/agent-review-arithmetic';

describe('recompute', () => {
  it('evaluates numbers, ×10ⁿ, operators, powers and parentheses', () => {
    expect(recompute({ expression: '(2 + 3) × 4 ÷ 2' })).toMatchObject({ ok: true, value: 10 });
    const avogadro = recompute({ expression: '6.02×10²³ × 2' });
    expect(avogadro.ok && avogadro.value / 1.204e24).toBeCloseTo(1, 12);
    expect(recompute({ expression: '2^3^2' })).toMatchObject({ ok: true, value: 512 });
    expect(recompute({ expression: '−4 + 10' })).toMatchObject({ ok: true, value: 6 });
    expect(recompute({ expression: '٤٤٥٫٧ + ٠٫٣' })).toMatchObject({ ok: true, value: 446 });
  });

  it('resolves givens and profile constants, and tracks units', () => {
    const result = recompute({
      expression: 'm / M × NA',
      givens: [
        { name: 'm', value: '20', unit: 'g' },
        { name: 'M', value: '83.8', unit: 'g/mol' },
      ],
      constants: { NA: '6.02×10^23 mol^-1' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeCloseTo((20 / 83.8) * 6.02e23, -15);
      expect(result.units).toEqual({});
    }
  });

  it('refuses anything that is not arithmetic: no eval, no calls, no property access', () => {
    for (const expression of [
      'process.exit(1)',
      'constructor.constructor("return 1")()',
      '1; 2',
      '[1]',
      'Math.max(1, 2)',
      'x',
      '',
    ]) {
      expect(recompute({ expression }).ok).toBe(false);
    }
  });

  it('skips one bad profile constant instead of failing every computation (LOW b)', () => {
    const skipped: string[] = [];
    const result = recompute({
      expression: 'NA × 2',
      constants: { broken: 'not a number', NA: '6.02×10^23' },
      onSkippedConstant: (name) => skipped.push(name),
    });
    expect(result.ok).toBe(true);
    expect(skipped).toEqual(['broken']);
    // Only an expression that USES the bad constant fails.
    expect(recompute({ expression: 'broken × 2', constants: { broken: 'x' } })).toMatchObject({
      ok: false,
      reason: 'unknown name broken',
    });
  });

  it('refuses a sum of different units', () => {
    expect(
      recompute({
        expression: 'a + b',
        givens: [
          { name: 'a', value: '1', unit: 'g' },
          { name: 'b', value: '1', unit: 'mol' },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'units do not match in a sum' });
  });

  it('parses unit shapes', () => {
    expect(parseUnits('g/mol')).toEqual({ g: 1, mol: -1 });
    expect(parseUnits('mol·L⁻¹')).toEqual({ mol: 1, L: -1 });
    expect(parseUnits('')).toEqual({});
  });
});

describe('the claim and its significant figures', () => {
  it('derives half the last written digit', () => {
    expect(claimedWithTolerance('7.30×10³')).toMatchObject({ ok: true, value: 7300, tolerance: 5 });
    expect(claimedWithTolerance('446 g')).toMatchObject({ value: 446, tolerance: 0.5, unit: 'g' });
    expect(claimedWithTolerance('445.7')).toMatchObject({ value: 445.7 });
  });

  it('Q28: «7360» disagrees with 7.30×10³ recomputed', () => {
    expect(
      checkComputation({
        expression: 'n × M',
        givens: [
          { name: 'n', value: '40.0', unit: 'mol' },
          { name: 'M', value: '182.5', unit: 'g/mol' },
        ],
        claimed: '7360 g',
      }),
    ).toMatchObject({ verdict: 'disagrees', computed: 7300 });
  });

  it('agrees within half the last significant digit', () => {
    expect(checkComputation({ expression: '445.72', claimed: '446' })).toMatchObject({
      verdict: 'agrees',
    });
    expect(checkComputation({ expression: '445.72', claimed: '445.7' }).verdict).toBe('agrees');
    expect(checkComputation({ expression: '445.72', claimed: '445.6' }).verdict).toBe('disagrees');
  });

  it('a claim in the wrong unit disagrees; an unparsable one is unverifiable', () => {
    expect(
      checkComputation({
        expression: 'm',
        givens: [{ name: 'm', value: '5', unit: 'g' }],
        claimed: '5 mol',
      }).verdict,
    ).toBe('disagrees');
    expect(checkComputation({ expression: 'eval(1)', claimed: '1' }).verdict).toBe('unverifiable');
    expect(checkComputation({ expression: '1', claimed: 'about one' }).verdict).toBe(
      'unverifiable',
    );
  });
});
