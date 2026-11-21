/**
 * LABEL_SCRIPT_CHANGED (21 Nov 2026, master prompt D2): the book prints a Latin label run
 * on a slide's cited units (ABCD, WXYZ, △PMQ) while the slide's canvas writes the labels
 * as Arabic letters («ز ي س و» for WXYZ, lesson 3-3 scene 12). Deterministic and pure;
 * the package review states it as a finding so the fix loop regenerates the slide once.
 *
 * Never fires when the book itself prints Arabic labels: the check needs a Latin run of
 * two or more distinct letters on the cited units, and compares it with the canvas. A
 * canvas that repeats the book's Latin labels never matches the Arabic-letter form.
 *
 * Review 21 Nov 2026 (H5 and its MEDIUM): ordinary Arabic maths text is not a label run —
 * «س و ص» is two variables joined by «و», «٣ م و ٤ م» two lengths with their unit, and a
 * run whose letters the cited units print on their own is the book's own. A label glued
 * to △ or ∠, written with harakat or primes, or separated by commas is still read as one.
 * An unspaced «أب» is never read as labels (it is a word of the language).
 */

/** Harakat, the superscript alef and the tatweel: never part of a label letter. */
const ARABIC_MARKS = /[ً-ٰٟـ]/g;
/** Prime marks a label may carry (A′B′C′, أ′). */
const PRIMES = /[′″‴ʹʺ']/g;
/** Geometry symbols a label is glued to («△ز ي س», «∠أ ب ج»): read as a separator. */
const GEOMETRY_SYMBOLS = /[△▵∆Δ∠∡⊿]/g;
/**
 * A word-shaped Latin letter run, as printed: `ABCD`, `WXYZ`, `PMQ`, `A′B′C′`. The edges are
 * the old `\b`'s (no ASCII word character either side).
 */
const LATIN_RUN = /(?<![A-Za-z0-9_])(?:[A-Z][′″‴ʹʺ']*){2,}(?![A-Za-z0-9_])/g;
/** One Arabic letter: «ز». */
const ARABIC_LETTER = /^[ء-ي]$/u;
const HAS_ARABIC_LETTER = /[ء-ي]/u;
const HAS_DIGIT = /[0-9٠-٩۰-۹]/;
const COMMA = /^[،,]$/;
/** What may wrap a lone letter: an opening bracket before it, a closing one or a stop after. */
const LEADING = /^[(\[«]+/;
const TRAILING = /[)\]»،,.:;!?؟؛]+$/;
/** The longest run read as labels (a hexagon's); longer ones are not labels. */
const MAX_RUN = 6;

function distinctLetters(run: string): string {
  return [...new Set(run)].join('');
}

/** The Latin label runs a text prints, as printed and deduplicated (2+ distinct letters). */
export function latinLabelRuns(text: string): string[] {
  const runs = [...(text || '').matchAll(LATIN_RUN)]
    .map((match) => match[0])
    .filter((run) => distinctLetters(run.replace(PRIMES, '')).length >= 2);
  return [...new Set(runs)];
}

type Token =
  | { kind: 'letter'; letter: string; opens: boolean; closes: boolean }
  | { kind: 'number'; closes: boolean }
  | { kind: 'comma' }
  | { kind: 'other' };

/** The text as whitespace tokens: marks and primes dropped, △/∠ and commas set apart. */
function tokensOf(text: string): Token[] {
  const normalized = (text || '')
    .replace(ARABIC_MARKS, '')
    .replace(PRIMES, '')
    .replace(GEOMETRY_SYMBOLS, ' ')
    .replace(/([،,])/g, ' $1 ');
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((raw): Token => {
      if (COMMA.test(raw)) return { kind: 'comma' };
      const lead = LEADING.exec(raw)?.[0] ?? '';
      const rest = raw.slice(lead.length);
      const trail = TRAILING.exec(rest)?.[0] ?? '';
      const core = rest.slice(0, rest.length - trail.length);
      if (ARABIC_LETTER.test(core)) {
        return { kind: 'letter', letter: core, opens: lead !== '', closes: trail !== '' };
      }
      if (HAS_DIGIT.test(core) && !HAS_ARABIC_LETTER.test(core)) {
        return { kind: 'number', closes: trail !== '' };
      }
      return { kind: 'other' };
    });
}

/**
 * The single-Arabic-letter runs a canvas text prints («ز ي س و», «ز، ي، س»), two to six
 * letters. Never a run: a word of the language, a letter right after a number («٣ م»: a
 * unit), or a «و» followed by a letter or a number («س و ص», «٣ م و ٤ م»: the
 * conjunction, which splits the run). A bracket or a stop ends a run.
 */
export function spacedArabicLetterRuns(text: string): string[] {
  const tokens = tokensOf(text);
  const runs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length >= 2 && current.length <= MAX_RUN) runs.push(current.join(''));
    current = [];
  };
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (token.kind === 'comma') {
      // A comma continues a run only between two letters: «ز، ي، س».
      if (current.length === 0 || next?.kind !== 'letter') flush();
      return;
    }
    if (token.kind !== 'letter') {
      flush();
      return;
    }
    const previous = tokens[index - 1];
    const unit = previous?.kind === 'number' && !previous.closes;
    const conjunction =
      token.letter === 'و' && (next?.kind === 'letter' || next?.kind === 'number');
    if (unit || conjunction) {
      flush();
      return;
    }
    if (token.opens) flush();
    current.push(token.letter);
    if (token.closes) flush();
  });
  flush();
  return runs;
}

/** The Arabic letters a text prints on their own (its own labels or variables). */
function standaloneArabicLetters(text: string): Set<string> {
  return new Set(
    tokensOf(text).flatMap((token) => (token.kind === 'letter' ? [token.letter] : [])),
  );
}

/**
 * Whether the canvas rewrote the book's Latin labels in Arabic letters: the cited units
 * print a Latin run of the same length as an Arabic-letter run on the canvas, and the
 * units do not print that run's letters on their own (then they are the book's).
 * Same length, not same letters: the OCR's Latin→Arabic mapping is not a transliteration
 * the check could predict («WXYZ» arrived as «ز ي س و»), but a label run rewritten letter
 * by letter keeps its length.
 */
export function labelScriptChanged(canvasText: string, unitText: string): boolean {
  const latin = latinLabelRuns(unitText);
  if (latin.length === 0) {
    // The book prints no Latin labels here — Arabic labels on the canvas are its own.
    return false;
  }
  const lengths = new Set(latin.map((run) => distinctLetters(run.replace(PRIMES, '')).length));
  const bookLetters = standaloneArabicLetters(unitText);
  return spacedArabicLetterRuns(canvasText).some(
    (run) => lengths.has(run.length) && ![...run].every((letter) => bookLetters.has(letter)),
  );
}

/** The check's stable code, as the review finding names it. */
export const LABEL_SCRIPT_CHANGED = 'LABEL_SCRIPT_CHANGED';
