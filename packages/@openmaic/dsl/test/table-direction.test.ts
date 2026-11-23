import { describe, expect, it } from 'vitest';

import {
  isLatinSymbolHeaderTable,
  isLatinSymbolText,
  isTruthTableHeader,
  tableCellPlainText,
} from '../src/index.js';

const cell = (text: string, extra: Record<string, unknown> = {}) => ({
  id: text || 'empty',
  colspan: 1,
  rowspan: 1,
  text,
  ...extra,
});

const table = (header: unknown[], ...rows: unknown[][]) => [header, ...rows];

describe('isLatinSymbolHeaderTable', () => {
  it('is true for the textbook truth tables of lessons 1-2 and 1-3', () => {
    expect(
      isLatinSymbolHeaderTable(
        table([cell('p'), cell('q'), cell('p ∧ q')], [cell('T'), cell('T'), cell('T')]),
      ),
    ).toBe(true);
    expect(
      isLatinSymbolHeaderTable(
        table([cell('p'), cell('q'), cell('∼p'), cell('∼q'), cell('∼p → ∼q')]),
      ),
    ).toBe(true);
    expect(isLatinSymbolHeaderTable(table([cell('p'), cell('~p'), cell('¬p')]))).toBe(true);
    expect(isLatinSymbolHeaderTable(table([cell('p'), cell('q'), cell('p ⇔ q')]))).toBe(true);
    expect(isLatinSymbolHeaderTable(table([cell('p'), cell('q'), cell('p ∨ (∼q)')]))).toBe(true);
    expect(isLatinSymbolHeaderTable(table([cell('x'), cell('2x − 1'), cell('y = x + 2')]))).toBe(
      true,
    );
  });

  it('reads the cell HTML the renderers draw (tags and entities)', () => {
    expect(
      isLatinSymbolHeaderTable(
        table([cell('<p><strong>p</strong></p>'), cell('p&nbsp;&amp;&nbsp;q')]),
      ),
    ).toBe(true);
  });

  it('keeps the page direction for an Arabic or mixed header', () => {
    expect(isLatinSymbolHeaderTable(table([cell('العبارة'), cell('قيمة الصواب')]))).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell('p'), cell('q'), cell('p و q')]))).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell('p'), cell('ص')]))).toBe(false);
    // Arabic-Indic digits are Arabic numbering.
    expect(isLatinSymbolHeaderTable(table([cell('س'), cell('١')]))).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell('x'), cell('١')]))).toBe(false);
  });

  it('is false for an empty, missing or malformed header', () => {
    expect(isLatinSymbolHeaderTable(undefined)).toBe(false);
    expect(isLatinSymbolHeaderTable([])).toBe(false);
    expect(isLatinSymbolHeaderTable([[]])).toBe(false);
    expect(isLatinSymbolHeaderTable(['p'])).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell(''), cell('  ')]))).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell('p'), cell('')]))).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell('p'), null]))).toBe(false);
    expect(isLatinSymbolHeaderTable(table([cell('( )'), cell('p')]))).toBe(true);
    expect(isLatinSymbolHeaderTable(table([cell('<br/>')]))).toBe(false);
  });

  it('skips header cells a merge covers', () => {
    // The parser's convention keeps only top-left cells.
    expect(isLatinSymbolHeaderTable(table([cell('p', { colspan: 2 }), cell('q')]))).toBe(true);
    // A full grid with the covered cell left empty.
    expect(isLatinSymbolHeaderTable(table([cell('p', { colspan: 2 }), cell(''), cell('q')]))).toBe(
      true,
    );
    // The model's convention marks a covered cell with a span of 0.
    expect(
      isLatinSymbolHeaderTable(table([cell('p', { colspan: 2 }), cell('', { colspan: 0 })])),
    ).toBe(true);
  });
});

describe('isTruthTableHeader', () => {
  it('is true only when a Latin/symbol header has a logic connective', () => {
    expect(isTruthTableHeader(table([cell('p'), cell('q'), cell('∼p → ∼q')]))).toBe(true);
    expect(isTruthTableHeader(table([cell('p'), cell('~p')]))).toBe(true);
    expect(isTruthTableHeader(table([cell('p'), cell('q'), cell('p ∧ q')]))).toBe(true);
    // A physics, data or function table keeps the page direction.
    expect(isTruthTableHeader(table([cell('t (s)'), cell('v (m/s)')]))).toBe(false);
    expect(isTruthTableHeader(table([cell('2020'), cell('2021')]))).toBe(false);
    expect(isTruthTableHeader(table([cell('x'), cell('y = x + 2')]))).toBe(false);
    expect(isTruthTableHeader(table([cell('p'), cell('q')]))).toBe(false);
    expect(isTruthTableHeader(table([cell('p'), cell('p و q')]))).toBe(false);
    expect(isTruthTableHeader(undefined)).toBe(false);
  });
});

describe('isLatinSymbolText', () => {
  it('needs at least one letter, digit or symbol and no other script', () => {
    expect(isLatinSymbolText('p → q')).toBe(true);
    expect(isLatinSymbolText('θ')).toBe(true);
    expect(isLatinSymbolText('   ')).toBe(false);
    expect(isLatinSymbolText('ص')).toBe(false);
    expect(isLatinSymbolText('p، q')).toBe(false);
  });
});

describe('tableCellPlainText', () => {
  it('drops tags, decodes common entities and trims', () => {
    expect(tableCellPlainText('<p> T&nbsp;</p>')).toBe('T');
    expect(tableCellPlainText('&#8764;p')).toBe('∼p');
    expect(tableCellPlainText(undefined)).toBe('');
  });
});
