import { describe, expect, it } from 'vitest';

import { tokenize } from '@/lib/speech/scientific/math/tokenize';

const kinds = (src: string) => tokenize(src).map((t) => `${t.kind}:${t.value}`);

describe('tokenize (plan §10.1 tokenizer)', () => {
  it('reads numbers with a decimal separator and thousands groups of three', () => {
    const [num] = tokenize('1,234.50');
    expect(num).toMatchObject({ kind: 'num', intDigits: '1234', fracDigits: '50' });
    expect(tokenize('١٬٢٠٠٫٥')[0]).toMatchObject({ intDigits: '١٢٠٠', fracDigits: '٥' });
    // Not a group of three → the comma is its own token.
    expect(kinds('1,23')).toEqual(['num:1', 'comma:,', 'num:23']);
  });

  it('normalises operators, relations and Unicode scripts', () => {
    expect(kinds('a − b × c ÷ d')).toEqual([
      'letter:a',
      'op:-',
      'letter:b',
      'op:*',
      'letter:c',
      'op:÷',
      'letter:d',
    ]);
    expect(kinds('x ≤ 2')).toEqual(['letter:x', 'rel:≤', 'num:2']);
    expect(kinds('x⁻¹')).toEqual(['letter:x', 'sup:-1']);
    expect(kinds('a₁₂')).toEqual(['letter:a', 'sub:12']);
  });

  it('recognises functions, greek letters and commands', () => {
    expect(kinds('sinx')).toEqual(['func:sin', 'letter:x']);
    expect(kinds('\\alpha + β')).toEqual(['greek:alpha', 'op:+', 'greek:beta']);
    expect(kinds('\\frac{1}{2}')).toEqual([
      'cmd:frac',
      'lbrace:{',
      'num:1',
      'rbrace:}',
      'lbrace:{',
      'num:2',
      'rbrace:}',
    ]);
    expect(tokenize('\\text{ متر }')[0]).toMatchObject({ kind: 'text', value: ' متر ' });
  });

  it('drops LaTeX spacing commands and marks the following token as spaced', () => {
    const tokens = tokenize('5\\,m');
    expect(tokens.map((t) => t.kind)).toEqual(['num', 'letter']);
    expect(tokens[1]!.spaced).toBe(true);
  });

  it('reads 3e8 only when scientific notation is enabled (Physics)', () => {
    expect(tokenize('3e8', { scientificE: true })[0]).toMatchObject({ sciExp: '8' });
    expect(kinds('3e8')).toEqual(['num:3', 'letter:e', 'num:8']);
  });

  it('keeps deferred glyphs as symbols and arrows as arrows', () => {
    expect(kinds('∫ x')).toEqual(['sym:∫', 'letter:x']);
    expect(kinds('A -> B')).toEqual(['letter:A', 'arrow:→', 'letter:B']);
  });

  it('reads Unicode vulgar fractions and the fraction slash', () => {
    expect(kinds('½ + ⅚')).toEqual(['vfrac:1/2', 'op:+', 'vfrac:5/6']);
    expect(kinds('1⁄2')).toEqual(['num:1', 'op:/', 'num:2']);
  });

  it('Arabic letters: variables and prose words only when enabled (Mathematics, Physics)', () => {
    const arabic = (src: string) =>
      tokenize(src, { arabicLetters: true }).map((t) => `${t.kind}:${t.value}`);
    expect(arabic('2س + هـ')).toEqual(['num:2', 'letter:س', 'op:+', 'letter:ه']);
    expect(arabic('\\frac{المسافة المقطوعة}{الزمن}')).toEqual([
      'cmd:frac',
      'lbrace:{',
      'text:المسافة المقطوعة',
      'rbrace:}',
      'lbrace:{',
      'text:الزمن',
      'rbrace:}',
    ]);
    // The conjunction is prose, and a word never swallows a variable letter.
    expect(arabic('س و ص')).toEqual(['letter:س', 'text:و', 'letter:ص']);
    // Disabled (Chemistry): Arabic script stays unknown, as before.
    expect(kinds('س')).toEqual(['unknown:س']);
  });

  it('is linear and terminates on arbitrary input', () => {
    const noisy = '\\\\{{((^^__||'.repeat(500);
    expect(() => tokenize(noisy)).not.toThrow();
  });
});
