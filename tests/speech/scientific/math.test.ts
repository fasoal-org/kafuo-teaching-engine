import { describe, expect, it } from 'vitest';

import { parseMath, ParseFault } from '@/lib/speech/scientific/math/parse';
import { verbaliseMath } from '@/lib/speech/scientific/math/verbalise-ar';
import { MAX_NESTING_DEPTH } from '@/lib/speech/scientific/bounds';
import { codes, prepared, render, TEST_POLICY } from './helpers';

function read(src: string, mode: 'natural' | 'accessible' = 'natural') {
  const { node } = parseMath(src);
  return verbaliseMath(node, {
    policy: TEST_POLICY,
    mode,
    domain: 'MATH',
    warn: () => {},
    noteProposed: () => {},
  });
}

describe('Mathematics parser', () => {
  it('follows precedence: power binds tighter than product, product than sum', () => {
    expect(read('a + b c^2').toString()).toBe('ألف زائد باء جيم تربيع');
    expect(read('-x^2').toString()).toBe('سالب، سين تربيع');
  });

  it('parses a relation chain and a ratio', () => {
    expect(parseMath('a < b ≤ c').node).toMatchObject({ t: 'rel', ops: ['<', '≤'] });
    expect(parseMath('3:4').node).toMatchObject({ t: 'ratio' });
  });

  it('O-5: a letter applied to one symbol reads function-style; a factored product stays a product', () => {
    expect(parseMath('f(x)').node.t).toBe('apply');
    expect(parseMath('p(x)').node.t).toBe('apply');
    expect(parseMath('P(A)').node.t).toBe('apply');
    expect(parseMath('ق(س)', { arabicLetters: true }).node.t).toBe('apply');
    expect(parseMath('د(س)', { arabicLetters: true }).node.t).toBe('apply');
    // A compound argument: only the conventional function letters (DEC-044).
    expect(parseMath('f(x+1)').node.t).toBe('apply');
    expect(parseMath('س(س+1)', { arabicLetters: true }).node).toMatchObject({ t: 'bin', op: 'juxt' });
    expect(parseMath('a(x+1)').node).toMatchObject({ t: 'bin', op: 'juxt' });
    expect(parseMath('x(x-1)').node).toMatchObject({ t: 'bin', op: 'juxt' });
    // A spaced bracket is a factor.
    expect(parseMath('p (x)').node).toMatchObject({ t: 'bin', op: 'juxt' });
  });

  it('P4 item 1: `/` binds looser than an implicit product: dy/dx = (dy)/(dx), a/bc = a/(bc)', () => {
    expect(parseMath('dy/dx').node).toMatchObject({ t: 'bin', op: '/', left: { op: 'juxt' }, right: { op: 'juxt' } });
    expect(parseMath('a/bc').node).toMatchObject({ t: 'bin', op: '/', left: { t: 'var' }, right: { op: 'juxt' } });
    expect(parseMath('a/b \\times c').node).toMatchObject({ t: 'bin', op: '*', left: { op: '/' } });
  });

  it('P4 item 2: mixed numbers are a whole and a proper fraction, never a product', () => {
    for (const src of ['2\\frac{1}{3}', '2⅓', '3 1/4']) expect(parseMath(src).node.t, src).toBe('mixed');
    expect(parseMath('2\\frac{x}{3}').node).toMatchObject({ t: 'bin', op: 'juxt' });
    expect(parseMath('2\\frac{5}{3}').node).toMatchObject({ t: 'bin', op: 'juxt' });
    expect(parseMath('3 1/4x').node.t).not.toBe('mixed');
  });

  it('P4 items 4–6: × and · stay distinct; `3 x 4` is a product; n! and P(A|B) parse', () => {
    expect(read('a \\cdot b').toString()).toBe('ألف نقطة باء');
    expect(read('a · b').toString()).toBe('ألف نقطة باء');
    expect(read('a \\times b').toString()).toBe('ألف في باء');
    expect(read('3 x 4').toString()).toBe('3 في 4');
    expect(read('x 4').toString()).toBe('سين 4');
    expect(read('n!').toString()).toBe('نون مضروب');
    expect(read('(n+1)!').toString()).toBe('مجموع نون و1، مضروب');
    expect(read('P(A|B)').toString()).toBe('بي للمقدار ألف بشرط باء');
    expect(read('2|x|').toString()).toBe('2 القيمة المطلقة لـسين');
  });

  it('classifies failures: unsupported, malformed, unknown command, bound', () => {
    const kind = (src: string) => {
      try {
        parseMath(src);
        return null;
      } catch (error) {
        return (error as ParseFault).kind;
      }
    };
    expect(kind("f'(x)")).toBe('unsupported');
    expect(kind('\\iiint x')).toBe('unsupported');
    expect(kind('x +')).toBe('malformed');
    expect(kind('\\frac{1}')).toBe('malformed');
    expect(kind('\\foo x')).toBe('unknown-command');
    expect(kind('('.repeat(MAX_NESTING_DEPTH + 1) + 'x' + ')'.repeat(MAX_NESTING_DEPTH + 1))).toBe(
      'bound',
    );
    expect(kind('x ' + '+ x '.repeat(250))).toBe('bound');
  });
});

describe('Mathematics verbaliser (§10.1 table rows)', () => {
  it.each([
    ['x^2', 'سين تربيع', 'سين مرفوعة للقوة اثنين'],
    ['x^3', 'سين تكعيب', 'سين مرفوعة للقوة ثلاثة'],
    ['x^n', 'سين أُس نون', 'سين مرفوعة للقوة نون'],
    ['x^{-1}', 'سين أُس سالب واحد', 'سين مرفوعة للقوة سالب واحد'],
    ['a/b', 'ألف على باء', 'كسر، بسطه ألف، ومقامه باء'],
    ['\\frac{1}{2}', 'نصف', 'كسر، بسطه واحد، ومقامه اثنين'],
    ['\\sqrt[3]{x}', 'الجذر التكعيبي لـسين', 'الجذر التكعيبي، بداخله: سين، نهاية الجذر'],
    ['x_1', 'سين واحد', 'سين الدليل واحد'],
    ['-3', 'سالب 3', 'سالب 3'],
    ['a - b', 'ألف ناقص باء', 'ألف ناقص باء'],
    ['a \\times b', 'ألف في باء', 'ألف في باء'],
    ['a ÷ b', 'ألف مقسومًا على باء', 'ألف مقسومًا على باء'],
    ['x \\neq y', 'سين لا يساوي صاد', 'سين، لا يساوي، صاد'],
    ['|x|', 'القيمة المطلقة لـسين', 'القيمة المطلقة، بداخلها سين، نهاية'],
    ['30°', '30 درجة', '30 درجة'],
    ['\\sin x', 'جا سين', 'جا سين'],
    ['\\alpha', 'ألفا', 'ألفا'],
  ])('%s', (src, natural, accessible) => {
    expect(read(src).toString()).toBe(natural);
    expect(read(src, 'accessible').toString()).toBe(accessible);
  });

  it('Unicode scripts behave exactly like ^ and _, spaced or not', () => {
    for (const [unicode, caret] of [
      ['x²', 'x^2'],
      ['x ²', 'x ^2'],
      ['x³', 'x^3'],
      ['x⁻¹', 'x^{-1}'],
      ['x₁', 'x_1'],
    ]) {
      expect(read(unicode!).toString(), unicode).toBe(read(caret!).toString());
      expect(read(unicode!, 'accessible').toString(), unicode).toBe(read(caret!, 'accessible').toString());
    }
  });

  it('reads a vulgar fraction exactly like \\frac', () => {
    for (const [glyph, frac] of [
      ['½', '\\frac{1}{2}'],
      ['¾', '\\frac{3}{4}'],
      ['⅚', '\\frac{5}{6}'],
      ['2½', '2\\frac{1}{2}'],
    ]) {
      expect(read(glyph!).toString(), glyph).toBe(read(frac!).toString());
      expect(read(glyph!, 'accessible').toString(), glyph).toBe(read(frac!, 'accessible').toString());
    }
  });

  it('keeps integers as authored digits and speaks the decimal separator', () => {
    expect(read('12.05').toString()).toBe('12 فاصلة 05');
    expect(read('١٬٠٠٠').toString()).toBe('١٠٠٠');
  });

  it('words mode reads every number with the number-to-words module', () => {
    const words = render('نحسب 2x + 1.5', 'MATH', 'natural', {
      allowProposed: true,
      numbersMode: 'words',
    });
    expect(words.preparedText).toBe('نحسب اثنين سين زائد واحد فاصلة خمسة');
  });
});

describe('renderer warning paths (§14.1)', () => {
  it.each([
    ['نكتب \\foo{x}', 'SATTS_W_UNKNOWN_COMMAND'],
    ['نكتب x^ هنا', 'SATTS_W_MALFORMED_EXPRESSION'],
    ['نكتب \\iiint x هنا', 'SATTS_W_UNSUPPORTED_NOTATION'],
  ])('%s → %s', (text, code) => {
    expect(codes(render(text))).toEqual([code]);
  });

  it('a missing dictionary entry spells the symbol and warns (production policy)', () => {
    const result = render('نحسب x + 1', 'MATH', 'natural', { allowProposed: false });
    expect(result.preparedText).toContain('x');
    expect(codes(result)).toContain('SATTS_W_MISSING_DICTIONARY_ENTRY');
  });

  it('a binary +/- after a term is never read as a sign; a sign after prose stays a sign', () => {
    expect(prepared('المجموع وس + 1 هنا')).toBe('المجموع وس زائد 1 هنا');
    expect(prepared('إذا كانت س = 5 فإن 2س + 3 = 13')).toBe('إذا كانت سين يساوي 5 فإن 2 سين زائد 3 يساوي 13');
    expect(prepared('الناتج هو - 3')).toBe('الناتج هو سالب 3');
    expect(prepared('درجة الحرارة - 5')).toBe('درجة الحرارة سالب 5');
  });

  it('a lone letter is a variable only in Mathematics prose context', () => {
    expect(prepared('قيمة x هي')).toBe('قيمة سين هي');
    expect(prepared('النقطة AB على المستقيم')).toBe('النقطة ألف باء على المستقيم');
  });
});
