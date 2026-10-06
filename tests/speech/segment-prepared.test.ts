/**
 * Segmentation of prepared text (plan §13.2, FR-028, FR-029, AS-010).
 */
import { describe, expect, it } from 'vitest';

import { countTokens } from '@/lib/server/speech/narration-synthesis';
import { providerCapability, TOKEN_CAP_MARGIN } from '@/lib/server/speech/provider-capabilities';
import { segmentPrepared } from '@/lib/server/speech/segment-prepared';
import { DELIVERY_INSTRUCTIONS_AR_SA_V1 } from '@/lib/server/speech/delivery-instructions';
import { render } from './scientific/helpers';

const openai = providerCapability('openai-tts', 'gpt-4o-mini-tts-2025-12-15')!;
const budget = {
  maxChars: openai.maxReliableSegmentChars,
  maxTokens: openai.maxReliableSegmentTokens,
  kappa: openai.tokenKappa,
  instructionsTokens: countTokens(DELIVERY_INSTRUCTIONS_AR_SA_V1),
  hardTokenCap: openai.maxInputTokens! - TOKEN_CAP_MARGIN,
};

describe('segmentPrepared', () => {
  it('keeps short prepared text as one segment', () => {
    const r = render('نحسب x² + 1 الآن.');
    const result = segmentPrepared(r.preparedText, r.spans, budget, countTokens);
    expect(result).toEqual({ ok: true, segments: [{ text: r.preparedText, start: 0, end: r.preparedText.length }] });
  });

  it('AS-010: original below the limit, prepared above it → split at safe boundaries, order kept', () => {
    // 20 fractions: the original is short, the accessible reading is long.
    const original = Array.from({ length: 20 }, (_, i) => `نحسب \\frac{x+${i}}{y-${i}} ثم`).join(' ');
    expect(original.length).toBeLessThan(budget.maxChars);
    const r = render(original, 'MATH', 'accessible');
    expect(r.preparedText.length).toBeGreaterThan(budget.maxChars);
    const result = segmentPrepared(r.preparedText, r.spans, budget, countTokens);
    if (!result.ok) throw new Error('unexpected block');
    expect(result.segments.length).toBeGreaterThan(1);
    for (const segment of result.segments) {
      expect(segment.text.length).toBeLessThanOrEqual(budget.maxChars);
      expect(budget.kappa * (countTokens(segment.text) + budget.instructionsTokens)).toBeLessThanOrEqual(
        budget.maxTokens!,
      );
      // No cut inside an atomic expression span.
      for (const span of r.spans.filter((s) => s.atomic)) {
        expect(segment.start > span.prepared.start && segment.start < span.prepared.end).toBe(false);
      }
    }
    // Order and completeness: the segments rejoin to the prepared text (whitespace aside).
    const squash = (t: string) => t.replace(/\s+/g, '');
    expect(squash(result.segments.map((s) => s.text).join(''))).toBe(squash(r.preparedText));
  });

  it('prefers sentence ends over clause marks over word boundaries', () => {
    const sentence = `${'أ'.repeat(300)}. ${'ب'.repeat(200)}، ${'ج'.repeat(200)}`;
    const result = segmentPrepared(sentence, [], { ...budget, maxTokens: undefined, hardTokenCap: undefined }, countTokens);
    if (!result.ok) throw new Error('unexpected block');
    expect(result.segments[0]!.text.endsWith('.')).toBe(true);
  });

  it('blocks only when one atomic span alone exceeds the budget', () => {
    const text = 'x'.repeat(700);
    const spans = [{ prepared: { start: 0, end: 700 }, atomic: true }];
    expect(segmentPrepared(text, spans, budget, countTokens)).toEqual({
      ok: false,
      code: 'SATTS_E_SEGMENT_UNSPLITTABLE',
      at: 0,
    });
  });

  it('the documented hard cap can never bind at the reliability budget (invariant)', () => {
    // Worst measured density 0.61 tok/char (Wave 0): 600 chars ≈ 366 tokens.
    const worst = budget.kappa * (Math.ceil(budget.maxChars * 0.61) + budget.instructionsTokens);
    expect(worst).toBeLessThan(budget.hardTokenCap);
    expect(budget.maxTokens!).toBeLessThan(budget.hardTokenCap);
    expect(budget.maxChars).toBeLessThan(openai.maxInputChars);
  });
});
