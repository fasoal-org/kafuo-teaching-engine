/**
 * The six approved findings of the final `satts-dictionary-review-v2.xlsx`
 * review (30 Sep 2026). SATTS pronounces the notation; OpenMAIC owns its
 * meaning. Finding 1 is superseded by DEC-052 (conventional Chemistry readings).
 */
import { describe, expect, it } from 'vitest';

import { policyEntries } from '@/lib/speech/scientific/policy';
import { prepared } from './helpers';

const both = ['natural', 'accessible'] as const;
const readings = policyEntries().flatMap((e) =>
  [e.natural, e.accessible, e.literal].filter((t): t is string => t !== undefined).map((text) => ({ e, text })),
);

describe('dictionary review v2 findings', () => {
  // Finding 1 (arrows as glyph names) is superseded by DEC-052: see
  // `chemistry-conventional.test.ts`.

  it('2: `+` is «زائد» between reactants and between products', () => {
    const natural = prepared('\\ce{NaOH + HCl -> NaCl + H2O}', 'CHEMISTRY');
    expect(natural).toBe('إن إيه أو إتش زائد إتش سي إل ينتج إن إيه سي إل زائد إتش اثنين أو');
    const keys = new Set(policyEntries().map((e) => e.key));
    expect(keys.has('plus-reactants') || keys.has('plus-products')).toBe(false);
  });

  it('3: states keep their role-based names; (aq) is «محلول مائي»', () => {
    for (const mode of both) {
      const text = prepared('\\ce{AgCl(s) + H2O(l) + CO2(g) + NaCl(aq)}', 'CHEMISTRY', mode);
      for (const state of ['صلب', 'سائل', 'غاز', 'محلول مائي']) expect(text).toContain(state);
      expect(text).not.toContain('في محلول مائي');
    }
  });

  it('4: units keep their canonical name, never inflected for the number', () => {
    expect(prepared('$t = 3 s$', 'PHYSICS')).toBe('تي يساوي 3 ثانية');
    expect(prepared('$d = 2 m$', 'PHYSICS')).toBe('دي يساوي 2 متر');
    expect(prepared('$m = 5 kg$', 'PHYSICS')).toBe('إم يساوي 5 كيلوجرام');
  });

  it('5: π and e are «باي» and «إي», with no name or value added', () => {
    expect(prepared('$\\pi r^2$', 'MATH')).toBe('باي راء تربيع');
    expect(prepared('$e^x$', 'MATH')).toBe('إي أُس سين');
    expect(prepared('$e$', 'PHYSICS')).toBe('إي');
    // The Arabic letter هـ keeps its own name.
    expect(prepared('قيمة هـ = 2.718 تقريبًا.', 'MATH')).toBe('قيمة هاء يساوي 2 فاصلة 718 تقريبًا.');
  });

  it('6: the dictionary holds vocabulary only; the verbaliser composes structure', () => {
    // No entry is a template: no internal pause or colon, no number glued to «للقوة».
    const templates = readings.filter(
      (r) => r.e.key !== ',' && (/[:،]/.test(r.text) || /للقوة \S/.test(r.text)),
    );
    expect(templates.map((r) => `${r.e.key}: ${r.text}`)).toEqual([]);
    expect(prepared('$(x+1)^2$', 'MATH')).toBe('سين زائد 1، الكل تربيع');
    // The accessible power is composed from «مرفوعة للقوة» and the number word.
    expect(prepared('$a = 9.8 m/s^2$', 'PHYSICS', 'accessible')).toBe('إيه، يساوي، 9 فاصلة 8 متر لكل ثانية مرفوعة للقوة اثنين');
    expect(prepared('$x^2$', 'MATH', 'accessible')).toBe('سين مرفوعة للقوة اثنين');
  });
});
