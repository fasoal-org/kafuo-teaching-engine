/**
 * R1 guard (upgrade plan P0 item 6): SATTS changes pronunciation, not meaning.
 * No expression reading may contain a compound, ion or physical-quantity
 * name, or another semantic expansion («ضرب اتجاهي», «احتمال» …), unless that
 * word is already in the authored text. The conventional Chemistry readings
 * («ينتج», «بالتسخين», «رابطة …») are allowed only in a CHEMISTRY lesson
 * (DEC-052).
 *
 * `PENDING` lists the cases that still violate R1 today; the phase that
 * removes the violation empties its entries. New violations always fail.
 */
import { describe, expect, it } from 'vitest';

import { chemistryExpression, mathRelation, mulberry32, narration, physicsExpression, type Rng } from './generator';
import { loadAudit, loadGolden } from './helpers';
import { r1Violations, words } from './r1';

/**
 * Cases that still violate R1, keyed by case id → the forbidden words. Empty
 * since Phase 1 removed the compound and ion names (O-2): R1 is enforced.
 */
const PENDING: Readonly<Record<string, readonly string[]>> = {};

describe('R1 guard: no semantic expansion', () => {
  const golden = loadGolden();
  const audit = loadAudit();

  it('the golden and audit readings add no forbidden meaning (except the pending list)', () => {
    const violations: Record<string, string[]> = {};
    for (const c of golden) {
      for (const mode of ['natural', 'accessible'] as const) {
        const found = r1Violations(c.original, c.subject, mode);
        if (found.length > 0) violations[c.id] = [...new Set([...(violations[c.id] ?? []), ...found])].sort();
      }
    }
    for (const c of audit) {
      const found = r1Violations(c.original, c.subject, c.mode);
      if (found.length > 0) violations[c.id] = [...new Set([...(violations[c.id] ?? []), ...found])].sort();
    }
    expect(violations).toEqual(PENDING);
  });

  it.each([
    ['MATH', (rng: Rng) => narration(rng, mathRelation), 2101],
    ['PHYSICS', (rng: Rng) => narration(rng, physicsExpression), 2202],
    ['CHEMISTRY', (rng: Rng) => narration(rng, chemistryExpression), 2303],
  ] as const)('%s: generated narration adds no forbidden meaning (seeded)', (subject, gen, seed) => {
    const rng = mulberry32(seed);
    const pendingWords = new Set(Object.values(PENDING).flat());
    for (let i = 0; i < 200; i += 1) {
      const text = gen(rng);
      for (const mode of ['natural', 'accessible'] as const) {
        const found = r1Violations(text, subject, mode).filter((word) => !pendingWords.has(word));
        expect(found, `seed ${seed} run ${i} ${mode}: ${JSON.stringify(text)}`).toEqual([]);
      }
    }
  });

  it('the guard itself sees an added name', () => {
    // A reading that invents a name is caught; one that repeats the author's word is not.
    expect(words('ماء، إتش اثنين أو').includes(' ماء ')).toBe(true);
    expect(r1Violations('نسخن الماء H2O', 'CHEMISTRY', 'natural')).not.toContain('الماء');
  });
});
