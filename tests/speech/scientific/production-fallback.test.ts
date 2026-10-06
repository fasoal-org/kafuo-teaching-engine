/**
 * FR-SATTS-030 in production (readiness gap G1.1, 30 Sep): with
 * `allowProposed: false` no dictionary entry is usable today, so every wording
 * falls back to a literal form. No operator, relation, script, fraction, root,
 * arrow or charge may be dropped: for every expression, each symbol class
 * occurs in the prepared text at least as often as in the source.
 */
import { describe, expect, it } from 'vitest';

import type { ScientificSubjectCode } from '@/lib/speech/scientific/context';
import { tokenize, type Token } from '@/lib/speech/scientific/math/tokenize';
import type { PolicyPackOptions } from '@/lib/speech/scientific/policy';
import { chemistryExpression, mathRelation, mulberry32, narration, physicsExpression, type Rng } from './generator';
import { render } from './helpers';

const PRODUCTION: PolicyPackOptions = { allowProposed: false };
const MODES = ['natural', 'accessible'] as const;

type SymbolClass = 'plus' | 'minus' | 'times' | 'div' | 'pm' | 'rel' | 'script' | 'arrow' | 'root';

const RELATION_COMMANDS = new Set(['le', 'leq', 'leqslant', 'ge', 'geq', 'geqslant', 'neq', 'ne', 'approx', 'equiv', 'lt', 'gt']);

function classOf(tok: Token): SymbolClass | null {
  switch (tok.kind) {
    case 'op':
      if (tok.value === '+') return 'plus';
      if (tok.value === '-') return 'minus';
      if (tok.value === '*') return 'times';
      if (tok.value === '±' || tok.value === '∓') return 'pm';
      return 'div';
    case 'rel':
      return 'rel';
    case 'caret':
    case 'sup':
      return 'script';
    case 'arrow':
      return 'arrow';
    case 'root':
      return 'root';
    case 'vfrac':
      return 'div';
    case 'cmd':
      if (['frac', 'dfrac', 'tfrac', 'div'].includes(tok.value)) return 'div';
      if (tok.value === 'sqrt') return 'root';
      if (tok.value === 'times' || tok.value === 'cdot') return 'times';
      if (tok.value === 'pm' || tok.value === 'mp') return 'pm';
      return RELATION_COMMANDS.has(tok.value) ? 'rel' : null;
    default:
      return null;
  }
}

function census(text: string): Record<SymbolClass, number> {
  const counts: Record<SymbolClass, number> = {
    plus: 0,
    minus: 0,
    times: 0,
    div: 0,
    pm: 0,
    rel: 0,
    script: 0,
    arrow: 0,
    root: 0,
  };
  for (const tok of tokenize(text)) {
    const cls = classOf(tok);
    if (cls) counts[cls] += 1;
  }
  return counts;
}

/** Chemistry charges in every spelling (`^{2+}`, `^-`, `²⁻`, `Na+`), counted apart from `+`/`-` (P3). */
const CHARGE = /\^\{?[0-9]?[+-]\}?|[⁰-⁹¹²³]*[⁺⁻]|(?<=[A-Za-z0-9)\]])[0-9]?[+-](?=$|[\s),،.])/g;

function withoutCharges(text: string, subject: ScientificSubjectCode): [string, number] {
  if (subject !== 'CHEMISTRY') return [text, 0];
  const charges = text.match(CHARGE)?.length ?? 0;
  return [text.replace(CHARGE, ' '), charges];
}

/** Source symbols, with `^\circ` (a degree sign, not a script) removed. */
function sourceCensus(source: string, subject: ScientificSubjectCode): Record<SymbolClass | 'charge', number> {
  const [rest, charges] = withoutCharges(source.replace(/\^\{?\\circ\}?/g, '°'), subject);
  return { ...census(rest), charge: charges };
}

/** Prepared symbols; charges are spoken as words or kept as superscript glyphs. */
function preparedCensus(prepared: string, subject: ScientificSubjectCode): Record<SymbolClass | 'charge', number> {
  const [rest, charges] = withoutCharges(prepared, subject);
  const counts = census(rest);
  counts.div += prepared.split(/\bfrac\b/).length - 1;
  return { ...counts, charge: charges + (prepared.match(/بشحنة|الشحنة/g)?.length ?? 0) };
}

/** Brackets of a literal-fallback span: never dropped (P3 item 2). */
function brackets(text: string): number {
  return (text.match(/[()[\]]/g)?.length ?? 0) + (text.match(/قوس/g)?.length ?? 0);
}

function checkNothingDropped(text: string, subject: ScientificSubjectCode): void {
  for (const mode of MODES) {
    const result = render(text, subject, mode, PRODUCTION);
    expect(result.stats.proposedEntriesUsed).toBe(0);
    for (const span of result.spans.filter((s) => s.kind === 'expression')) {
      const source = text.slice(span.source.start, span.source.end);
      const prepared = result.preparedText.slice(span.prepared.start, span.prepared.end);
      const before = sourceCensus(source, subject);
      const after = preparedCensus(prepared, subject);
      for (const cls of Object.keys(before) as Array<SymbolClass | 'charge'>) {
        expect(after[cls], `${mode} ${cls}: ${JSON.stringify(source)} → ${JSON.stringify(prepared)}`).toBeGreaterThanOrEqual(
          before[cls],
        );
      }
      if (span.fallbackReason === 'notation') {
        expect(brackets(prepared), `${mode} brackets: ${JSON.stringify(source)} → ${JSON.stringify(prepared)}`).toBeGreaterThanOrEqual(
          (source.match(/[()[\]]/g) ?? []).length,
        );
      }
    }
  }
}

describe('production policy: a missing dictionary entry never drops content (FR-030)', () => {
  it.each([
    ['$x^2 + \\frac{1}{2} = 4$', 'MATH', 'x ^ 2 + 1 / 2 = 4', 'x ^ 2 + 1 / 2، =، 4'],
    ['9.8 m/s²', 'PHYSICS', '9.8 m/s²', '9.8 m/s²'],
    ['2H₂ + O₂ → 2H₂O', 'CHEMISTRY', '2 H 2 + O 2 → 2 H 2 O', '2 H، 2 + O، 2، →، 2 H، 2، O'],
    ['إذا كانت س = 5 فإن 2س + 3 = 13', 'MATH', 'إذا كانت س = 5 فإن 2 س + 3 = 13', 'إذا كانت س، =، 5 فإن 2 س + 3، =، 13'],
    ['الكسر ½ و ¾', 'MATH', 'الكسر 1 / 2 و 3 / 4', 'الكسر 1 / 2 و 3 / 4'],
  ] as const)('%s (%s)', (text, subject, natural, accessible) => {
    const n = render(text, subject, 'natural', PRODUCTION);
    const a = render(text, subject, 'accessible', PRODUCTION);
    expect(n.preparedText).toBe(natural);
    expect(a.preparedText).toBe(accessible);
    // The missing-entry warnings are still reported.
    expect(n.warnings.map((w) => w.code)).toContain('SATTS_W_MISSING_DICTIONARY_ENTRY');
    expect(n.warnings.map((w) => w.code)).not.toContain('SATTS_W_UNPROMOTED_POLICY_ENTRY');
  });

  it('literal forms for grouping, roots, absolute value, charges, states and the electron', () => {
    const math = (text: string) => render(text, 'MATH', 'natural', PRODUCTION).preparedText;
    expect(math('نحسب \\sqrt{x+1} و |x - 3| و (a+b)^2')).toBe('نحسب √ (x + 1) و |x - 3| و (a + b) ^ 2');
    expect(math('نبسط \\frac{x+1}{x-1} الآن')).toBe('نبسط (x + 1) / (x - 1) الآن');
    expect(math('نحسب \\sqrt[3]{8} و \\sqrt[4]{x}')).toBe('نحسب ∛ 8 و ∜ x');
    expect(math('الحد x^{n+1} و x_1')).toBe('الحد x ^ (n + 1) و x _ 1');
    // P3: element symbols stay whole and charges stay charges (never «أُس»).
    const chem = (text: string) => render(text, 'CHEMISTRY', 'natural', PRODUCTION).preparedText;
    expect(chem('الأيون SO₄²⁻ و Na⁺')).toBe('الأيون S O 4²⁻ و Na⁺');
    expect(chem('\\ce{Cu^{2+} + 2e^- -> Cu}')).toBe('Cu²⁺ + 2 e⁻ → Cu');
    expect(chem('المحلول NaCl(aq) موصل')).toBe('المحلول Na Cl (aq) موصل');
    expect(chem('القاعدة Ca(OH)₂ قوية')).toBe('القاعدة Ca، (O H) 2 قوية');
  });

  it.each([
    ['$x^2 + \\frac{1}{2} = 4$', 'MATH'],
    ['نحسب \\sqrt[3]{8} = 2 و \\sqrt[5]{y} ≥ 1', 'MATH'],
    ['القيمة (a+b)^2 و x^{n+1} و x^{-1} و \\frac{x+1}{x-1}', 'MATH'],
    ['نحسب a ÷ b و x ± 3 و 1 < x ≤ 4 و a \\neq b', 'MATH'],
    ['الدالة f(x) = x^2 + 1 و \\log_2 8 و \\sin^2 x', 'MATH'],
    ['نحسب x² + ½ و x ² و ⅓ + ¼', 'MATH'],
    ['إذا كانت س = 5 فإن 2س + 3 = 13', 'MATH'],
    ['نحسب س² + ص² = 25 و √س و |س - 3|', 'MATH'],
    ['نكتب 5! = 120 و \\sum_{i=1}^{n} i', 'MATH'],
    ['9.8 m/s²', 'PHYSICS'],
    ['سرعة الضوء 3 × 10^8 m/s والشحنة 1.6 × 10^{-19} C', 'PHYSICS'],
    ['السرعة 60 km/h والعزم 20 N·m والمساحة 4 km²', 'PHYSICS'],
    ['نكتب \\vec{v} = \\vec{v}_0 + \\vec{a}t و F_{net} = 0', 'PHYSICS'],
    ['2H₂ + O₂ → 2H₂O', 'CHEMISTRY'],
    ['الاتزان \\ce{N2 + 3H2 <=> 2NH3} و \\ce{2NO2 <- N2O4}', 'CHEMISTRY'],
    ['الأيونات Na+ + Cl- → NaCl و SO₄²⁻ و Fe^{3+}', 'CHEMISTRY'],
    ['البلورة CuSO4·5H2O و \\ce{H2 + 1/2O2 -> H2O}', 'CHEMISTRY'],
  ] as const)('every symbol survives: %s', (text, subject) => {
    checkNothingDropped(text, subject);
  });

  it('counts literal-by-policy spans as fallbacks, with their own reason (P0 item 3)', () => {
    const production = render('نحسب $x^2 + 1$ ثم \\frac{', 'MATH', 'natural', PRODUCTION);
    const expressions = production.spans.filter((span) => span.kind === 'expression');
    expect(expressions.map((span) => [span.fallback, span.fallbackReason])).toEqual([
      [true, 'policy'],
      [true, 'notation'],
    ]);
    expect(production.stats.expressionsFallback).toBe(2);
    expect(production.stats.fallbackReasons).toEqual({ notation: 1, policy: 1, bound: 0, fault: 0 });
    // With the experimental pack the same expression is worded, not a fallback.
    const proposed = render('نحسب $x^2 + 1$', 'MATH', 'natural', { allowProposed: true });
    expect(proposed.spans.find((span) => span.kind === 'expression')?.fallback).toBe(false);
    expect(proposed.stats.fallbackReasons.policy).toBe(0);
  });

  it('an integer never raises a missing `decimal` entry (P0 item 4)', () => {
    const production = render('نحسب $12 + 3 = 15$', 'MATH', 'natural', PRODUCTION);
    const details = production.warnings.map((w) => w.detail);
    expect(details).not.toContain('label:decimal');
    expect(details).toContain('operator:+');
    // A decimal still consults (and reports) the separator word.
    expect(render('نحسب $1.5 + 3$', 'MATH', 'natural', PRODUCTION).warnings.map((w) => w.detail)).toContain(
      'label:decimal',
    );
  });

  const RUNS = 200;
  it.each([
    ['MATH', (rng: Rng) => narration(rng, mathRelation), 1101],
    ['PHYSICS', (rng: Rng) => narration(rng, physicsExpression), 1202],
    ['CHEMISTRY', (rng: Rng) => narration(rng, chemistryExpression), 1303],
  ] as const)('%s: every symbol survives on generated narration (seeded)', (subject, gen, seed) => {
    const rng = mulberry32(seed);
    for (let i = 0; i < RUNS; i += 1) {
      const text = gen(rng);
      try {
        checkNothingDropped(text, subject);
      } catch (error) {
        throw new Error(`seed ${seed} run ${i} input ${JSON.stringify(text)}: ${(error as Error).message}`);
      }
    }
  });
});

describe('P3: the literal fallback is always speakable', () => {
  const NAMED = ['xrightarrow', 'rightarrow', 'to', 'vec', 'hat', 'overline', 'bar', 'binom', 'partial', 'angle', 'emptyset', 'subset', 'uparrow', 'rightleftharpoons'];

  it.each([PRODUCTION, { allowProposed: true }])('never speaks a known LaTeX command name (%o)', (policy) => {
    for (const name of [...NAMED, 'Delta', 'circ']) {
      for (const text of [`نكتب $a \\${name}{b} c$ هنا`, `\\ce{A \\${name} B}`]) {
        for (const subject of ['MATH', 'CHEMISTRY'] as const) {
          const out = render(text, subject, 'natural', policy).preparedText;
          expect(out.split(/[\s،]+/), `${name} ${subject}: ${out}`).not.toContain(name);
        }
      }
    }
  });

  it('`^\\circ` is a degree, never «أُس circ»', () => {
    for (const policy of [PRODUCTION, { allowProposed: true }]) {
      const out = render('الزاوية $(90)^\\circ$ و \\ce{x^{\\circ}}', 'MATH', 'natural', policy).preparedText;
      expect(out).not.toContain('circ');
      expect(out).not.toContain('أُس');
    }
  });

  it('a Greek letter with an unusable entry is its glyph, never its LaTeX key', () => {
    expect(render('$\\Delta T$', 'PHYSICS', 'natural', PRODUCTION).preparedText).toBe('Δ T');
  });

  it('brackets get neutral spoken boundaries in the experimental pack', () => {
    const out = render('$x \\in [2, 5)$', 'MATH', 'natural', { allowProposed: true }).preparedText;
    expect(out).toContain('قوس مربع');
    expect(out).toContain('إغلاق القوس');
  });

  it('an English word stays prose, with a review warning, never spelled letter by letter', () => {
    const result = render('نكتب $\\text{heat}$ هنا', 'PHYSICS', 'natural', { allowProposed: true });
    expect(result.preparedText).toBe('نكتب heat هنا');
    expect(result.warnings.map((w) => `${w.code}:${w.detail}`)).toContain('SATTS_W_UNSUPPORTED_NOTATION:english-word');
    // A unit or a function name is not an English word.
    expect(render('نكتب $\\text{mol}$ هنا', 'PHYSICS', 'natural', { allowProposed: true }).preparedText).not.toContain('mol');
  });
});

