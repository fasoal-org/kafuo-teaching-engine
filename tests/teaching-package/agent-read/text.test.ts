/**
 * Agent read API text pass (Kafuo Agent API A3): sub/superscripts become
 * Unicode, simple LaTeX is linearized, nothing is dropped, and numbers are
 * extracted as decimals from Latin and Arabic-Indic digits.
 */
import { describe, expect, it } from 'vitest';

import {
  extractNumbers,
  htmlToPlainText,
  latexToPlainText,
  toSubscript,
  toSuperscript,
} from '@/lib/server/teaching-package/agent-read/text';

describe('htmlToPlainText', () => {
  it('turns <sub>/<sup> into Unicode before the tags are stripped (H₂SO₄, Fe³⁺)', () => {
    const html =
      '<p>حمض الكبريتيك <span style="color:red">H<sub>2</sub>SO<sub>4</sub></span> وأيون Fe<sup>3+</sup></p>';
    expect(htmlToPlainText(html)).toBe('حمض الكبريتيك H₂SO₄ وأيون Fe³⁺');
  });

  it('keeps an unmappable group instead of dropping it', () => {
    expect(htmlToPlainText('س<sub>٢</sub> و x<sup>ab</sup>')).toBe('س_{٢} و x^{ab}');
    expect(toSubscript('٢')).toBe('_{٢}');
    expect(toSuperscript('n+1')).toBe('ⁿ⁺¹');
  });

  it('linearizes inline math and keeps the logical order of figure numbers', () => {
    expect(htmlToPlainText('<p>انظر الشكل 2-9: $6.02 \\times 10^{23}$ جسيم</p>')).toBe(
      'انظر الشكل 2-9: 6.02 × 10²³ جسيم',
    );
  });

  it('decodes entities and keeps line breaks between paragraphs', () => {
    expect(htmlToPlainText('<p>a &amp; b</p><p>c&nbsp;d</p>')).toBe('a & b\nc d');
  });
});

describe('review fixes (A3 L5)', () => {
  it('keeps the braces of a group with no Unicode form, in LaTeX too', () => {
    expect(latexToPlainText('x_{٢} + y^{ab}')).toBe('x_{٢} + y^{ab}');
    expect(htmlToPlainText('$a_{ب}$')).toBe('a_{ب}');
  });

  it('maps o to ° only as a lone superscript', () => {
    expect(htmlToPlainText('25<sup>o</sup>C')).toBe('25°C');
    expect(latexToPlainText('25^o C')).toBe('25° C');
    expect(latexToPlainText('90^\\circ')).toBe('90°');
    expect(htmlToPlainText('x<sup>on</sup>')).toBe('x^{on}');
  });

  it('leaves prices in prose alone; only math-like $…$ is math', () => {
    expect(htmlToPlainText('الكتاب بـ $5 والقلم بـ $3')).toBe('الكتاب بـ $5 والقلم بـ $3');
    expect(htmlToPlainText('costs $5 and $10 total')).toBe('costs $5 and $10 total');
    expect(htmlToPlainText('حيث $x+y=5$ دائمًا')).toBe('حيث x+y=5 دائمًا');
    expect(htmlToPlainText('$E=mc^2$')).toBe('E=mc²');
  });

  it('writes \\ce charges as superscripts', () => {
    expect(latexToPlainText('\\ce{Ca2+ + 2Cl-}')).toBe('Ca²⁺ + 2Cl⁻');
    expect(latexToPlainText('\\ce{Fe^{3+}}')).toBe('Fe³⁺');
  });

  it('NFC-normalizes the output', () => {
    const decomposed = 'é'; // e + combining acute
    expect(htmlToPlainText(`<p>caf${decomposed}</p>`)).toBe('café');
    expect(latexToPlainText(`\\text{caf${decomposed}}`)).toBe('café');
  });
});

describe('latexToPlainText', () => {
  it('handles scripts, symbols, fractions, \\text and mhchem', () => {
    expect(latexToPlainText('\\mathrm{Fe}^{3+} + 3e^- \\rightarrow \\mathrm{Fe}')).toBe(
      'Fe³⁺ + 3e⁻ → Fe',
    );
    expect(latexToPlainText('\\frac{m}{V} = \\frac{a+b}{2}')).toBe('m/V = (a+b)/2');
    expect(latexToPlainText('\\ce{H2SO4 -> 2H+ + SO4^2-}')).toBe('H₂SO₄ → 2H⁺ + SO₄²⁻');
    expect(latexToPlainText('25^\\circ C')).toBe('25° C');
    expect(latexToPlainText('\\sqrt{x} \\leq 3 \\text{ cm}')).toBe('√x ≤ 3 cm');
  });
});

describe('extractNumbers', () => {
  it('reads base-line decimals only (subscripts are not numbers)', () => {
    expect(extractNumbers('H₂SO₄ كتلته 98.08 g')).toEqual([98.08]);
  });

  it('reads Arabic-Indic digits and the Arabic decimal separator', () => {
    expect(extractNumbers('الكتلة ١٠٠٫٥ غ و ۲۵ مل')).toEqual([100.5, 25]);
  });

  it('reads m × 10ⁿ, 10ⁿ and the caret form as one value', () => {
    expect(extractNumbers('عدد أفوجادرو 6.02×10²³ و 1.6 × 10⁻¹⁹ C')).toEqual([6.02e23, 1.6e-19]);
    expect(extractNumbers('10³ و 3 × 10^-2')).toEqual([1000, 0.03]);
  });

  it('is unsigned: the minus of a subtraction is never a sign', () => {
    expect(extractNumbers('100.0 − 8.5 = 91.5 g')).toEqual([100, 8.5, 91.5]);
  });

  it('reads thousands grouping and figure references as written', () => {
    expect(extractNumbers('1,000 جزيء، الشكل 2-9')).toEqual([1000, 2, 9]);
  });
});
