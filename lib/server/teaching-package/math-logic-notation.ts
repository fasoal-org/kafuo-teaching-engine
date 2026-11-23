/**
 * The textbook's logic notation on a MATH lesson's slides (teacher feedback on the
 * Saudi grade-10 lessons «1-2 المنطق» and «1-3 العبارات الشرطية», owner approval
 * 23 Nov 2026).
 *
 * The book writes negation with a tilde (`\sim p`, «∼p») and truth values as Latin
 * `T` / `F`; the generated slides drifted to `\neg p \to \neg q` (¬) and to truth-table
 * cells «صواب/خطأ» or «ص/خ» although the math Skill already says to keep the book's
 * notation. This is the deterministic repair, run after generation like the digit
 * style (`learner-first-source.ts`): pure string work, no model call, nothing stored
 * outside the scene. It changes a slide only when the book itself shows the notation:
 *
 * 1. The book negates with `\sim` / ∼ / ~ and never with `\neg` / ¬ → `\neg` (and
 *    `\lnot`) become `\sim` in LaTeX elements (their KaTeX snapshot is re-rendered),
 *    and ¬ becomes ∼ in text, shape text and table cells.
 * 2. The book prints Latin truth values → in a TABLE whose header row is Latin/symbol
 *    text (`isLatinSymbolHeaderTable`, the renderers' left-to-right rule), a body cell
 *    that is only «ص»/«صواب»/«صائب» becomes `T` and «خ»/«خطأ»/«خاطئ» becomes `F`. Prose
 *    text is never touched by this rule.
 */
import { isLatinSymbolHeaderTable, tableCellPlainText } from '@openmaic/dsl';
import { renderLatexElementHtml } from '@/lib/edit/slide-edit-elements';

/** What the lesson's textbook source shows about its logic notation. */
export interface BookLogicNotation {
  /** Negation is `\sim` / ∼ / ~ in the book, and `\neg` / ¬ never appears. */
  readonly tildeNegation: boolean;
  /** The book writes truth values as Latin `T` / `F`. */
  readonly latinTruthValues: boolean;
}

export const NO_BOOK_LOGIC_NOTATION: BookLogicNotation = Object.freeze({
  tildeNegation: false,
  latinTruthValues: false,
});

/** `\neg`, `\lnot` — never `\negthinspace`, `\negmedspace`, `\negthickspace`. */
const NEG_COMMAND = /\\(?:neg|lnot)(?![A-Za-z])/g;
const NOT_SIGN = /¬|&not;|&#172;|&#x0*ac;/gi;
/** Any negation the book could print with ¬ (non-global: safe for `.test`). */
const HAS_NOT_NEGATION = /\\(?:neg|lnot)(?![A-Za-z])|¬|&not;|&#172;|&#x0*ac;/i;
/**
 * A tilde that negates a statement: `\sim p`, `\sim(p ∧ q)`, `∼p`, `~ q`. Never
 * `\simeq`, the similarity sign between named figures (`△ABC \sim △DEF`, `ABC ∼ DEF`),
 * or a LaTeX tie after a letter or digit (`5~cm`).
 */
const TILDE_NEGATION = /(?:\\sim(?![A-Za-z])|∼|(?<![A-Za-z0-9\\])~)\s*(?:[a-z](?![A-Za-z])|\()/;
const LATIN_T = /(?<![A-Za-z0-9_\\])T(?![A-Za-z0-9_])/;
const LATIN_F = /(?<![A-Za-z0-9_\\])F(?![A-Za-z0-9_])/;
/** «قيمة الصواب», «قيم الصواب», «جدول الصواب». */
const TRUTH_VALUE_CUE = /(?:قيمة|قيم|جدول)\s+(?:ال)?صواب/;

/** Harakat, the superscript alef and the tatweel. */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;
const ARABIC_TRUE = new Set(['ص', 'صواب', 'صائب']);
const ARABIC_FALSE = new Set(['خ', 'خطأ', 'خاطئ']);

/** Whether a line of a table (HTML or Markdown) holds only T/F values, two or more. */
function hasTruthValueRow(text: string): boolean {
  const rows = text
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<\/?tr\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n');
  return rows.some((row) => {
    const tokens = row.split(/[|\s]+/).filter(Boolean);
    return tokens.length >= 2 && tokens.every((token) => token === 'T' || token === 'F');
  });
}

/** The lesson's logic notation, read from its source Content Units' text. */
export function detectBookLogicNotation(texts: readonly string[]): BookLogicNotation {
  const all = texts.filter((text) => typeof text === 'string').join('\n');
  if (!all) return NO_BOOK_LOGIC_NOTATION;
  const plain = all.replace(/<[^>]*>/g, ' ');
  return {
    tildeNegation: TILDE_NEGATION.test(all) && !HAS_NOT_NEGATION.test(all),
    latinTruthValues:
      LATIN_T.test(plain) &&
      LATIN_F.test(plain) &&
      (TRUTH_VALUE_CUE.test(plain) || hasTruthValueRow(all)),
  };
}

function tildeLatex(latex: string): string {
  return latex.replace(NEG_COMMAND, '\\sim').replace(/¬\s*/g, '\\sim ');
}

function tildeText(html: string): string {
  return html.replace(NOT_SIGN, '∼');
}

/** The cell's HTML with its visible text set to `value` (tags kept). */
function withVisibleText(html: string, value: string): string {
  if (!/[<&]/.test(html)) return value;
  let placed = false;
  return html
    .split(/(<[^>]*>)/g)
    .map((part) => {
      if (part.startsWith('<') || !tableCellPlainText(part)) return part;
      if (placed) return '';
      placed = true;
      return value;
    })
    .join('');
}

function latinTruthValue(text: unknown): 'T' | 'F' | null {
  const plain = tableCellPlainText(text).replace(ARABIC_MARKS, '');
  if (ARABIC_TRUE.has(plain)) return 'T';
  if (ARABIC_FALSE.has(plain)) return 'F';
  return null;
}

type Cell = { text?: unknown } & Record<string, unknown>;

function tableCells(element: Record<string, unknown>): Cell[][] {
  if (!Array.isArray(element.data)) return [];
  return (element.data as unknown[]).map((row) =>
    Array.isArray(row)
      ? (row as unknown[]).filter((cell): cell is Cell => !!cell && typeof cell === 'object')
      : [],
  );
}

interface NotationScene {
  type?: string;
  content?: unknown;
}

function slideElements(scene: NotationScene): Array<Record<string, unknown>> {
  if (scene.type !== 'slide') return [];
  const content = scene.content as { canvas?: { elements?: unknown } } | undefined;
  const elements = content?.canvas?.elements;
  return Array.isArray(elements)
    ? (elements as unknown[]).filter(
        (element): element is Record<string, unknown> => !!element && typeof element === 'object',
      )
    : [];
}

/**
 * Normalise one generated slide scene's logic notation in place to the book's. Returns
 * how many elements or cells changed (0 for a quiz, or when the book shows nothing).
 */
export function normalizeSceneLogicNotation(
  scene: NotationScene,
  notation: BookLogicNotation,
): number {
  if (!notation.tildeNegation && !notation.latinTruthValues) return 0;
  let changed = 0;
  for (const element of slideElements(scene)) {
    if (notation.tildeNegation) {
      if (element.type === 'latex' && typeof element.latex === 'string') {
        const latex = tildeLatex(element.latex);
        if (latex !== element.latex) {
          // The renderer draws the stored KaTeX snapshot, so it is rendered again.
          const html = renderLatexElementHtml(latex);
          if (html !== null) {
            element.latex = latex;
            element.html = html;
            changed += 1;
          }
        }
      } else if (element.type === 'text' && typeof element.content === 'string') {
        const content = tildeText(element.content);
        if (content !== element.content) {
          element.content = content;
          changed += 1;
        }
      } else if (element.type === 'shape') {
        const text = element.text as { content?: unknown } | undefined;
        if (text && typeof text.content === 'string') {
          const content = tildeText(text.content);
          if (content !== text.content) {
            text.content = content;
            changed += 1;
          }
        }
      }
    }
    if (element.type !== 'table') continue;
    const rows = tableCells(element);
    if (notation.tildeNegation) {
      for (const cell of rows.flat()) {
        if (typeof cell.text !== 'string') continue;
        const text = tildeText(cell.text);
        if (text !== cell.text) {
          cell.text = text;
          changed += 1;
        }
      }
    }
    if (notation.latinTruthValues && isLatinSymbolHeaderTable(element.data)) {
      for (const cell of rows.slice(1).flat()) {
        if (typeof cell.text !== 'string') continue;
        const value = latinTruthValue(cell.text);
        if (value) {
          cell.text = withVisibleText(cell.text, value);
          changed += 1;
        }
      }
    }
  }
  return changed;
}

/**
 * A regeneration has no book text: the notation the package's other slides already
 * use (the run normalised them to the book's), like `packageDigitStyle`. A package
 * whose slides mix `\neg` and `\sim`, or show no T/F table, changes nothing.
 */
export function packageLogicNotation(scenes: ReadonlyArray<NotationScene>): BookLogicNotation {
  const texts: string[] = [];
  for (const scene of scenes) {
    for (const element of slideElements(scene)) {
      if (element.type === 'latex' && typeof element.latex === 'string') {
        texts.push(element.latex);
      } else if (element.type === 'text' && typeof element.content === 'string') {
        texts.push(element.content);
      } else if (element.type === 'shape') {
        const text = element.text as { content?: unknown } | undefined;
        if (text && typeof text.content === 'string') texts.push(text.content);
      } else if (element.type === 'table') {
        for (const row of tableCells(element)) {
          texts.push(row.map((cell) => tableCellPlainText(cell.text)).join(' | '));
        }
      }
    }
  }
  return detectBookLogicNotation(texts);
}

/** The subject whose slides get this repair (`subjectOffering.code`, upper-cased). */
export function isMathSubject(subjectCode: string | null | undefined): boolean {
  return subjectCode === 'MATH';
}
