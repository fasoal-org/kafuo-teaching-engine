/**
 * The renderer's public contract (plan §9.1) on hand-picked inputs; the
 * seeded property suite covers the same guarantees on generated inputs.
 */
import { describe, expect, it } from 'vitest';

import { renderScientificSpeech } from '@/lib/speech/scientific';
import {
  MAX_EXPRESSIONS_PER_ACTION,
  MAX_EXPRESSION_SOURCE_CHARS,
  MAX_ORIGINAL_CHARS,
} from '@/lib/speech/scientific/bounds';
import { codes, context, render, TEST_POLICY } from './helpers';

describe('renderScientificSpeech contract', () => {
  it('general path is the identity (subject null) — FR-004, AS-011', () => {
    const text = 'نحسب x² + 1 = \\frac{1}{2}';
    const result = render(text, null);
    expect(result.preparedText).toBe(text);
    expect(result.path).toBe('general');
    expect(result.policyVersion).toBeNull();
    expect(result.spans).toEqual([
      { kind: 'prose', source: { start: 0, end: text.length }, prepared: { start: 0, end: text.length }, atomic: false, fallback: false },
    ]);
  });

  it('never mutates its input and never changes the original text — FR-005, AS-001', () => {
    const ctx = context('إذا كان x² + \\frac{a}{b} = 3');
    const snapshot = JSON.stringify(ctx);
    const result = renderScientificSpeech({ context: ctx }, TEST_POLICY);
    expect(JSON.stringify(ctx)).toBe(snapshot);
    expect(result.preparedText).not.toBe(ctx.originalText);
    expect(result.preparedText).toContain('تربيع');
  });

  it('AS-001: a fraction and an exponent keep numerator, denominator, exponent and order', () => {
    expect(render('نحسب \\frac{x^2}{y} + 1 الآن').preparedText).toBe(
      'نحسب سين تربيع على صاد، زائد 1 الآن',
    );
  });

  it('is deterministic — FR-006', () => {
    const text = 'نحل \\frac{x+1}{2} ≥ √y ثم |z|';
    expect(JSON.stringify(render(text))).toBe(JSON.stringify(render(text)));
  });

  it('inserts a single space where an expression touches text, and none before punctuation', () => {
    expect(render('وx²، ثم').preparedText).toBe('و سين تربيع، ثم');
  });

  it('AS-008: malformed notation stays readable, warns, and never empties the narration', () => {
    const result = render('\\frac{');
    expect(result.preparedText.trim()).not.toBe('');
    expect(result.blocking).toBeNull();
    expect(codes(result)).toEqual(['SATTS_W_MALFORMED_EXPRESSION']);
  });

  it('reports SATTS_E_EMPTY_RESULT only for a non-empty narration that renders empty', () => {
    expect(render('   ').blocking).toBeNull();
    expect(render('').preparedText).toBe('');
  });

  it('enforces the Action, expression and count bounds — FR-033', () => {
    const long = 'x + 1 '.repeat(Math.ceil(MAX_ORIGINAL_CHARS / 6) + 1);
    const tooLong = render(long);
    expect(tooLong.preparedText).toBe(long);
    expect(codes(tooLong)).toEqual(['SATTS_W_BOUND_EXCEEDED']);

    const bigExpression = `$${'x+'.repeat(MAX_EXPRESSION_SOURCE_CHARS / 2)}x$`;
    expect(codes(render(bigExpression))).toContain('SATTS_W_BOUND_EXCEEDED');

    const many = Array.from({ length: MAX_EXPRESSIONS_PER_ACTION + 3 }, () => 'x²').join(' و ');
    const result = render(many);
    expect(result.stats.expressions).toBe(MAX_EXPRESSIONS_PER_ACTION);
    expect(codes(result)).toContain('SATTS_W_BOUND_EXCEEDED');
  });

  it('contains a renderer fault to one expression', () => {
    // A number whose value cannot be represented still reads (digits), never throws.
    const result = render(`نحسب ${'9'.repeat(40)}.5 + x`);
    expect(result.preparedText).toContain('سين');
  });
});
