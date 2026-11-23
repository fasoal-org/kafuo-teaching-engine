/**
 * Owner, 23 Nov 2026 (teacher feedback, lessons «1-2 المنطق» / «1-3 العبارات الشرطية»):
 * a MATH lesson's slides keep the book's logic notation — negation `\sim` / ∼ and Latin
 * T / F truth values — after generation.
 */
import { describe, expect, it } from 'vitest';

import {
  detectBookLogicNotation,
  isMathSubject,
  normalizeSceneLogicNotation,
  packageLogicNotation,
  type BookLogicNotation,
} from '@/lib/server/teaching-package/math-logic-notation';

// Lesson 1-2's vocabulary unit as parsed (backend fixture `lessons_291_293_fixture.json`).
const UNIT_TRUTH_VALUES = [
  'وصواب العبارة (T) أو خطؤها (F) يسمى قيمة الصواب لها، ويرمز للعبارة برمز مثل p أو q.',
  'p: المستطيل شكل رباعي قيمة الصواب: T',
  'نفي العبارة p أعلاه هو \\sim p، أو "ليس p"، حيث:',
  '\\sim p: المستطيل ليس شكلاً رباعياً قيمة الصواب: F',
  'تكتب عبارة الوصل p و q بالرموز على الصورة p \\wedge q.',
].join('\n\n');

// A truth table as the parser renders tables (HTML), with no Arabic cue around it.
const UNIT_TRUTH_TABLE =
  '<table><tr><th>p</th><th>q</th><th>p \\wedge q</th></tr>' +
  '<tr><td>T</td><td>T</td><td>T</td></tr><tr><td>T</td><td>F</td><td>F</td></tr></table>';

const BOTH: BookLogicNotation = { tildeNegation: true, latinTruthValues: true };

const cell = (text: string) => ({ id: `c-${text}`, colspan: 1, rowspan: 1, text });

function slide(...elements: Array<Record<string, unknown>>) {
  return {
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'canvas', elements } },
  };
}

function truthTable(header: string[], ...rows: string[][]) {
  return {
    id: 'tt',
    type: 'table',
    data: [header.map(cell), ...rows.map((row) => row.map(cell))],
  };
}

const cellTexts = (element: { data: Array<Array<{ text: string }>> }) =>
  element.data.map((row) => row.map((c) => c.text));

describe('detectBookLogicNotation', () => {
  it("reads the lesson's own `\\sim p` and T / F truth values", () => {
    expect(detectBookLogicNotation([UNIT_TRUTH_VALUES])).toEqual(BOTH);
    expect(detectBookLogicNotation([UNIT_TRUTH_TABLE]).latinTruthValues).toBe(true);
    // Markdown rows count too.
    expect(detectBookLogicNotation(['| p | q |\n| --- | --- |\n| T | F |']).latinTruthValues).toBe(
      true,
    );
    expect(detectBookLogicNotation(['∼p ∨ q', '~ q']).tildeNegation).toBe(true);
  });

  it('never infers a tilde negation the book does not print', () => {
    // The book itself uses ¬ or \neg somewhere: nothing to convert to.
    expect(detectBookLogicNotation(['\\sim p', '\\neg q']).tildeNegation).toBe(false);
    expect(detectBookLogicNotation(['\\sim p', '¬q']).tildeNegation).toBe(false);
    // \simeq, the similarity sign and a LaTeX tie are not negation.
    expect(detectBookLogicNotation(['a \\simeq b']).tildeNegation).toBe(false);
    expect(detectBookLogicNotation(['\\triangle ABC \\sim \\triangle DEF']).tildeNegation).toBe(
      false,
    );
    expect(detectBookLogicNotation(['ABC ∼ DEF']).tildeNegation).toBe(false);
    expect(detectBookLogicNotation(['5~cm']).tildeNegation).toBe(false);
    expect(detectBookLogicNotation([]).tildeNegation).toBe(false);
  });

  it('needs T and F as truth values, not a lone point label', () => {
    expect(detectBookLogicNotation(['النقطة F تقع على المستقيم T']).latinTruthValues).toBe(false);
    expect(detectBookLogicNotation(['قيمة الصواب: T']).latinTruthValues).toBe(false);
    expect(detectBookLogicNotation(['TF FT', 'جدول']).latinTruthValues).toBe(false);
  });
});

describe('normalizeSceneLogicNotation', () => {
  it('writes `\\neg p \\to \\neg q` as `\\sim p \\to \\sim q` and re-renders its KaTeX', () => {
    const latex = {
      id: 'f1',
      type: 'latex',
      latex: '\\neg p \\to \\neg q',
      html: '<span class="katex">¬p→¬q</span>',
    };
    const scene = slide(latex);
    expect(normalizeSceneLogicNotation(scene, BOTH)).toBe(1);
    expect(latex.latex).toBe('{\\sim} p \\to {\\sim} q');
    expect(latex.html).toContain('katex');
    expect(latex.html).toContain('∼');
    expect(latex.html).not.toContain('¬');
  });

  it('handles \\lnot and a Unicode ¬ in LaTeX, and never touches \\negthinspace', () => {
    const latex = { id: 'f2', type: 'latex', latex: '\\lnot(p \\wedge q) \\leftrightarrow ¬p' };
    const spacing = { id: 'f3', type: 'latex', latex: 'a\\negthinspace b' };
    normalizeSceneLogicNotation(slide(latex, spacing), BOTH);
    expect(latex.latex).toBe('{\\sim}(p \\wedge q) \\leftrightarrow {\\sim}p');
    expect(spacing.latex).toBe('a\\negthinspace b');
  });

  it('writes ¬ as ∼ in text, shape text and table cells', () => {
    const text = { id: 't1', type: 'text', content: '<p>نفي العبارة: ¬p و &not;q</p>' };
    const shape = { id: 's1', type: 'shape', text: { content: '<p>¬q</p>' } };
    const table = truthTable(['p', '¬p'], ['T', 'F']);
    normalizeSceneLogicNotation(slide(text, shape, table), BOTH);
    expect(text.content).toBe('<p>نفي العبارة: ∼p و ∼q</p>');
    expect(shape.text.content).toBe('<p>∼q</p>');
    expect(cellTexts(table)[0]).toEqual(['p', '∼p']);
  });

  it('turns «صواب/خطأ» and «ص/خ» truth-table cells into T / F', () => {
    const long = truthTable(
      ['p', 'q', 'p ∧ q'],
      ['صواب', 'صواب', 'صواب'],
      ['صواب', 'خطأ', 'خطأ'],
      [' صائب ', 'خاطئ', 'خَطأ'],
    );
    const short = truthTable(['p', 'q', '∼p → ∼q'], ['ص', 'ص', 'ص'], ['خ', 'ص', 'ص']);
    normalizeSceneLogicNotation(slide(long, short), BOTH);
    expect(cellTexts(long)).toEqual([
      ['p', 'q', 'p ∧ q'],
      ['T', 'T', 'T'],
      ['T', 'F', 'F'],
      ['T', 'F', 'F'],
    ]);
    expect(cellTexts(short)).toEqual([
      ['p', 'q', '∼p → ∼q'],
      ['T', 'T', 'T'],
      ['F', 'T', 'T'],
    ]);
  });

  it('keeps cell markup around the converted value', () => {
    const table = truthTable(['p', '∼p'], ['<p><strong>ص</strong></p>', '&nbsp;خ&nbsp;']);
    normalizeSceneLogicNotation(slide(table), BOTH);
    expect(cellTexts(table)[1]).toEqual(['<p><strong>T</strong></p>', 'F']);
  });

  it('never touches prose, an Arabic-header table or a sentence cell', () => {
    const prose = { id: 't2', type: 'text', content: '<p>صواب</p>' };
    const arabic = truthTable(['العبارة', 'قيمة الصواب'], ['المستطيل شكل رباعي', 'صواب']);
    const sentence = truthTable(['p', '∼p'], ['صواب دائمًا', 'خطأ']);
    normalizeSceneLogicNotation(slide(prose, arabic, sentence), BOTH);
    expect(prose.content).toBe('<p>صواب</p>');
    expect(cellTexts(arabic)[1]).toEqual(['المستطيل شكل رباعي', 'صواب']);
    expect(cellTexts(sentence)[1]).toEqual(['صواب دائمًا', 'F']);
  });

  it('changes nothing the book does not show', () => {
    const latex = { id: 'f4', type: 'latex', latex: '\\neg p' };
    const table = truthTable(['p', '∼p'], ['ص', 'خ']);
    const none = { tildeNegation: false, latinTruthValues: false };
    expect(normalizeSceneLogicNotation(slide(latex, table), none)).toBe(0);
    expect(latex.latex).toBe('\\neg p');
    expect(cellTexts(table)[1]).toEqual(['ص', 'خ']);

    // T/F without a tilde book: the cells change, the LaTeX keeps \neg.
    normalizeSceneLogicNotation(slide(latex, table), {
      tildeNegation: false,
      latinTruthValues: true,
    });
    expect(latex.latex).toBe('\\neg p');
    expect(cellTexts(table)[1]).toEqual(['T', 'F']);
  });

  it('leaves a quiz scene alone', () => {
    const quiz = { type: 'quiz', content: { questions: [{ question: '¬p' }] } };
    expect(normalizeSceneLogicNotation(quiz, BOTH)).toBe(0);
    expect(quiz.content.questions[0].question).toBe('¬p');
  });
});

describe('packageLogicNotation (regeneration)', () => {
  it("reads the notation the package's normalised slides already use", () => {
    const normalised = slide(
      { id: 'f', type: 'latex', latex: '\\sim p \\rightarrow \\sim q' },
      truthTable(['p', '∼p'], ['T', 'F'], ['F', 'T']),
    );
    expect(packageLogicNotation([normalised])).toEqual(BOTH);
  });

  it('reads nothing from a package that mixes \\neg and \\sim or has no T/F table', () => {
    const mixed = slide(
      { id: 'a', type: 'latex', latex: '\\sim p' },
      { id: 'b', type: 'latex', latex: '\\neg q' },
      truthTable(['p', '∼p'], ['ص', 'خ']),
    );
    expect(packageLogicNotation([mixed])).toEqual({
      tildeNegation: false,
      latinTruthValues: false,
    });
  });
});

describe('isMathSubject', () => {
  it('is the MATH subject code only', () => {
    expect(isMathSubject('MATH')).toBe(true);
    expect(isMathSubject('PHYSICS')).toBe(false);
    expect(isMathSubject(null)).toBe(false);
  });
});
