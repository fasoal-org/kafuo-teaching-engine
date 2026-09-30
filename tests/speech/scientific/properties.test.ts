/**
 * Renderer properties G1–G7 (plan §9.1), mode parity (§9.2) and bounds, on
 * seeded generated inputs (plan §17). Seeds are fixed, so failures reproduce.
 */
import { describe, expect, it } from 'vitest';

import { MAX_EXPRESSION_PREPARED_CHARS, MAX_NESTING_DEPTH, MAX_PREPARED_CHARS } from '@/lib/speech/scientific/bounds';
import { parseMath } from '@/lib/speech/scientific/math/parse';
import { verbaliseMath } from '@/lib/speech/scientific/math/verbalise-ar';
import type { ScientificSubjectCode } from '@/lib/speech/scientific/context';
import { context, render, TEST_POLICY } from './helpers';
import {
  arabicMathExpression,
  arabicNoise,
  chemistryExpression,
  mathExpression,
  mulberry32,
  narration,
  noise,
  physicsExpression,
  type Rng,
} from './generator';

const RUNS = 300;

/** Math glyphs and LaTeX that must never survive in scientific output (G6). */
const RESIDUAL = /[\\^_{}√∛∜²³⁰-⁹₀-₉=≠≤≥≈±×÷+<>−|¼-¾⅐-⅞↉⁄]/;

function forAll(seed: number, gen: (rng: Rng) => string, check: (text: string) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < RUNS; i += 1) {
    const text = gen(rng);
    try {
      check(text);
    } catch (error) {
      throw new Error(`seed ${seed} run ${i} input ${JSON.stringify(text)}: ${(error as Error).message}`);
    }
  }
}

function verbalise(node: ReturnType<typeof parseMath>['node'], mode: 'natural' | 'accessible') {
  return verbaliseMath(node, {
    policy: TEST_POLICY,
    mode,
    domain: 'MATH',
    warn: () => {},
    noteProposed: () => {},
  });
}

/**
 * Scope closure (upgrade plan P0): a fraction, power, root, subscript, group
 * or sign whose end is not audible must not be followed by more words. The
 * audit's scope bugs (`\\frac{1}{2}x`, `a/bc`, `(a+b)^2`, `k_B T`, `-x^2` …)
 * violate it.
 */
function scopeViolations(src: string, mode: 'natural' | 'accessible'): string[] {
  return verbalise(parseMath(src, { physics: true }).node, mode).scopeViolations;
}

function checkStructure(text: string, subject: ScientificSubjectCode | null, mode: 'natural' | 'accessible') {
  const result = render(text, subject, mode);
  // G4: spans are ordered, contiguous over the prepared text, monotonic over the source.
  let preparedCursor = 0;
  let sourceCursor = 0;
  for (const span of result.spans) {
    expect(span.prepared.start).toBe(preparedCursor);
    expect(span.source.start).toBeGreaterThanOrEqual(sourceCursor);
    preparedCursor = span.prepared.end;
    sourceCursor = span.source.end;
    // G3: prose is copied verbatim.
    if (span.kind === 'prose') {
      expect(result.preparedText.slice(span.prepared.start, span.prepared.end)).toBe(
        text.slice(span.source.start, span.source.end),
      );
    }
    // G7: every atomic expression fits one provider segment.
    if (span.kind === 'expression' && span.atomic) {
      expect(span.prepared.end - span.prepared.start).toBeLessThanOrEqual(MAX_EXPRESSION_PREPARED_CHARS + 2);
    }
  }
  expect(preparedCursor).toBe(result.preparedText.length);
  // G5: non-empty or blocking.
  if (text.trim()) expect(result.preparedText.trim() !== '' || result.blocking !== null).toBe(true);
  // G7: bounds.
  expect(result.stats.maxDepth).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
  expect(result.preparedText.length).toBeLessThanOrEqual(Math.max(MAX_PREPARED_CHARS, text.length * 8));
  return result;
}

describe('renderer properties (seeded)', () => {
  it('G1 determinism: the same input gives byte-identical results', () => {
    forAll(101, (rng) => narration(rng), (text) => {
      for (const mode of ['natural', 'accessible'] as const) {
        expect(JSON.stringify(render(text, 'MATH', mode))).toBe(JSON.stringify(render(text, 'MATH', mode)));
      }
    });
  });

  it('G2 general-path identity for every input when the subject is null', () => {
    forAll(202, (rng) => (rng() < 0.5 ? narration(rng) : noise(rng)), (text) => {
      const result = render(text, null);
      expect(result.preparedText).toBe(text);
      expect(result.spans).toHaveLength(1);
      expect(result.warnings).toEqual([]);
    });
  });

  it('G3/G4/G5/G7 hold on generated narration in both modes', () => {
    forAll(303, (rng) => narration(rng), (text) => {
      checkStructure(text, 'MATH', 'natural');
      checkStructure(text, 'MATH', 'accessible');
    });
  });

  it('G3/G4/G5/G7 hold on arbitrary noise, and the renderer never throws', () => {
    forAll(404, noise, (text) => {
      checkStructure(text, 'MATH', 'natural');
      checkStructure(text, 'MATH', 'accessible');
    });
  });

  it('G6 no double transformation: render(prepared) === prepared, no residual notation', () => {
    forAll(505, (rng) => narration(rng), (text) => {
      for (const mode of ['natural', 'accessible'] as const) {
        const once = render(text, 'MATH', mode);
        if (once.stats.expressionsFallback > 0) continue;
        expect(render(once.preparedText, 'MATH', mode).preparedText).toBe(once.preparedText);
        for (const span of once.spans.filter((s) => s.kind === 'expression')) {
          expect(once.preparedText.slice(span.prepared.start, span.prepared.end)).not.toMatch(RESIDUAL);
        }
      }
    });
  });

  it('the input context is never mutated', () => {
    forAll(606, (rng) => narration(rng), (text) => {
      const ctx = context(text);
      const before = JSON.stringify(ctx);
      render(ctx.originalText);
      expect(JSON.stringify(ctx)).toBe(before);
    });
  });

  it('mode parity: both readings emit the same ORDERED semantic tokens, scope boundaries included (FR-019, P0)', () => {
    forAll(707, (rng) => mathExpression(rng), (src) => {
      const { node } = parseMath(src);
      // Ordered, not sorted: a reading that reorders operands or moves a
      // group, fraction or power boundary no longer passes.
      expect(verbalise(node, 'accessible').semantic).toEqual(verbalise(node, 'natural').semantic);
    });
  });

  it('the ordered parity detects a reordered reading that the sorted comparison missed', () => {
    const tokens = verbalise(parseMath('\\frac{1}{2}x').node, 'natural').semantic;
    const reordered = [...tokens].reverse();
    expect([...reordered].sort()).toEqual([...tokens].sort());
    expect(reordered).not.toEqual(tokens);
    // Boundaries are part of the stream: the fraction closes before the factor.
    expect(tokens.indexOf('frac>')).toBeLessThan(tokens.indexOf('var:x'));
  });

  it.each([
    ['PHYSICS', physicsExpression, 808],
    ['CHEMISTRY', chemistryExpression, 909],
  ] as const)('%s: G1, G3–G7 on generated narration', (subject, expression, seed) => {
    forAll(seed, (rng) => narration(rng, expression), (text) => {
      for (const mode of ['natural', 'accessible'] as const) {
        const once = checkStructure(text, subject, mode);
        expect(JSON.stringify(render(text, subject, mode))).toBe(JSON.stringify(once));
        if (once.stats.expressionsFallback > 0) continue;
        expect(render(once.preparedText, subject, mode).preparedText).toBe(once.preparedText);
        for (const span of once.spans.filter((s) => s.kind === 'expression')) {
          expect(once.preparedText.slice(span.prepared.start, span.prepared.end)).not.toMatch(RESIDUAL);
        }
      }
    });
  });

  it.each([
    ['MATH', 1010],
    ['PHYSICS', 1111],
  ] as const)('%s: G1, G3–G7 on generated narration with Arabic-letter variables', (subject, seed) => {
    forAll(seed, (rng) => narration(rng, arabicMathExpression), (text) => {
      for (const mode of ['natural', 'accessible'] as const) {
        const once = checkStructure(text, subject, mode);
        expect(JSON.stringify(render(text, subject, mode))).toBe(JSON.stringify(once));
        if (once.stats.expressionsFallback > 0) continue;
        expect(render(once.preparedText, subject, mode).preparedText).toBe(once.preparedText);
        for (const span of once.spans.filter((s) => s.kind === 'expression')) {
          expect(once.preparedText.slice(span.prepared.start, span.prepared.end)).not.toMatch(RESIDUAL);
        }
      }
    });
  });

  it.each(['MATH', 'PHYSICS', 'CHEMISTRY'] as const)(
    '%s: G3/G4/G5/G7 hold on Arabic-script noise, and the renderer never throws',
    (subject) => {
      forAll(1212, arabicNoise, (text) => {
        checkStructure(text, subject, 'natural');
        checkStructure(text, subject, 'accessible');
      });
    },
  );

  describe('scope closure (accessible: P4; natural: P5)', () => {
    it.each(['\\frac{1}{2}x', '½mv²', 'x+\\frac{1}{x}-1', 'x^n y', 'k_B T'])(
      'accessible speaks the end of a silent construct before more words: %s',
      (src) => {
        const w = verbalise(parseMath(src, { physics: true }).node, 'accessible');
        expect(w.scopeViolations).toEqual([]);
        expect(w.toString()).toMatch(/نهاية (?:الكسر|الأس|الدليل)/);
      },
    );

    it.each([
      ['\\frac{a}{b}c', 'ألف على باء، جيم'],
      ['(a+b)^2', 'ألف زائد باء، الكل تربيع'],
      ['k_B T', 'كاف باء، تي'],
      ['-x^2', 'سالب، سين تربيع'],
      ['\\sqrt{2}x', 'الجذر التربيعي لـ2، سين'],
      ['x^n + 1', 'سين أُس نون، زائد 1'],
    ] as const)('natural (O-6) closes a silent construct with a pause or «الكل»: %s', (src, reading) => {
      const w = verbalise(parseMath(src, { physics: true }).node, 'natural');
      expect(w.toString()).toBe(reading);
      expect(w.scopeViolations).toEqual([]);
    });

    it('closed readings are not flagged', () => {
      for (const src of ['x^2 + 1', '\\frac{x+1}{2}', 'x^{n+1}', '\\frac{1}{2}', '2x + 3 = 7']) {
        expect(scopeViolations(src, 'natural'), src).toEqual([]);
      }
      for (const src of ['\\frac{x+1}{x-1}', '(x+1)^2', 'x^{n+1}', '\\frac{1}{2}']) {
        expect(scopeViolations(src, 'accessible'), src).toEqual([]);
      }
    });

    it('accessible: no construct ends silently before more words (P4)', () => {
      forAll(1313, (rng) => mathExpression(rng), (src) => {
        expect(scopeViolations(src, 'accessible')).toEqual([]);
      });
    });

    it('natural: no construct ends silently before more words (P5)', () => {
      forAll(1414, (rng) => mathExpression(rng), (src) => {
        expect(scopeViolations(src, 'natural')).toEqual([]);
      });
    });
  });

  it('stays bounded on long sign and operator chains next to Arabic letters', () => {
    for (const text of ['س = ' + '-'.repeat(7000), 'س' + ' - '.repeat(2500) + '1', 'س + '.repeat(1900)]) {
      expect(() => checkStructure(text, 'MATH', 'natural')).not.toThrow();
    }
  });
});
