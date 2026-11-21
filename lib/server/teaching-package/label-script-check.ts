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
/** Geometry symbols a label is glued to («△ز ي س», «∠أ ب ج»): set apart as a cue token. */
const GEOMETRY_SYMBOLS = /[△▵∆Δ∠∡⊿]/g;
const GEOMETRY_SYMBOL = /^[△▵∆Δ∠∡⊿]$/;
/**
 * Words after which comma-separated letters name points («النقاط ز، ي، س»); the
 * two-word «الشكل الرباعي» is matched beside them. Anywhere else a comma list
 * («أجب عن الأسئلة أ، ب، ج») is an ordinary list, not a label run.
 */
const GEOMETRY_CUE_WORDS = new Set(['النقاط', 'الرؤوس', 'المثلث']);
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
  | { kind: 'cue' }
  | { kind: 'other'; word: string };

/** The text as whitespace tokens: marks and primes dropped, △/∠ and commas set apart. */
function tokensOf(text: string): Token[] {
  const normalized = (text || '')
    .replace(ARABIC_MARKS, '')
    .replace(PRIMES, '')
    .replace(GEOMETRY_SYMBOLS, ' $& ')
    .replace(/([،,])/g, ' $1 ');
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((raw): Token => {
      if (COMMA.test(raw)) return { kind: 'comma' };
      if (GEOMETRY_SYMBOL.test(raw)) return { kind: 'cue' };
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
      return { kind: 'other', word: core };
    });
}

/** Whether the run starting at token `start` follows a geometry cue (△, ∠, «النقاط», …). */
function followsGeometryCue(tokens: Token[], start: number): boolean {
  const previous = tokens[start - 1];
  if (previous?.kind === 'cue') return true;
  if (previous?.kind !== 'other') return false;
  if (GEOMETRY_CUE_WORDS.has(previous.word)) return true;
  const before = tokens[start - 2];
  return previous.word === 'الرباعي' && before?.kind === 'other' && before.word === 'الشكل';
}

/** How many letters follow token `index`, space-joined in one run (a comma or bracket ends it). */
function lettersAfter(tokens: Token[], index: number): number {
  let count = 0;
  let token = tokens[index + 1];
  while (token?.kind === 'letter' && !(count > 0 && token.opens)) {
    count += 1;
    if (token.closes) break;
    token = tokens[index + 1 + count];
  }
  return count;
}

/**
 * The single-Arabic-letter runs a canvas text prints («ز ي س و», «النقاط ز، ي، س»), two
 * to six letters. Never a run: a word of the language, a letter right after a number
 * («٣ م»: a unit), or a «و» that is the conjunction, which splits the run — before a
 * number («٣ م و ٤ م») or between single letters («س و ص»). Inside a run of three or
 * more letters «و» is a label letter («و س ي ز», «هـ و ز ح»). A bracket or a stop ends a
 * run. Comma-separated letters are a run only right after a geometry cue (△, ∠,
 * «النقاط», «الرؤوس», «المثلث», «الشكل الرباعي»), and never when bracketed («(س، ص)»:
 * a coordinate pair).
 */
export function spacedArabicLetterRuns(text: string): string[] {
  const tokens = tokensOf(text);
  const runs: string[] = [];
  let current: string[] = [];
  /** The current run's first-letter token, whether a comma joined it, and its bracket. */
  let start = -1;
  let commaJoined = false;
  let opened = false;
  /** Letters space-joined at the end of the current run (a comma restarts the count). */
  let tail = 0;
  const flush = (closed = false) => {
    const list = commaJoined && ((opened && closed) || !followsGeometryCue(tokens, start));
    if (!list && current.length >= 2 && current.length <= MAX_RUN) runs.push(current.join(''));
    current = [];
    start = -1;
    commaJoined = false;
    opened = false;
    tail = 0;
  };
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (token.kind === 'comma') {
      // A comma continues a run only between two letters: «ز، ي، س».
      if (current.length === 0 || next?.kind !== 'letter') flush();
      else {
        commaJoined = true;
        tail = 0;
      }
      return;
    }
    if (token.kind !== 'letter') {
      flush();
      return;
    }
    const previous = tokens[index - 1];
    const unit = previous?.kind === 'number' && !previous.closes;
    const conjunction =
      token.letter === 'و' &&
      (next?.kind === 'number' ||
        (next?.kind === 'letter' && tail <= 1 && lettersAfter(tokens, index) <= 1));
    if (unit || conjunction) {
      flush();
      return;
    }
    if (token.opens) flush();
    if (current.length === 0) {
      start = index;
      opened = token.opens;
    }
    current.push(token.letter);
    tail += 1;
    if (token.closes) flush(true);
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
 * by letter keeps its length. A run is skipped when the canvas itself prints a Latin run
 * of that length: the canvas kept the book's labels, so the Arabic run is something else.
 */
export function labelScriptChanged(canvasText: string, unitText: string): boolean {
  const latin = latinLabelRuns(unitText);
  if (latin.length === 0) {
    // The book prints no Latin labels here — Arabic labels on the canvas are its own.
    return false;
  }
  const lengthsOf = (runs: string[]) =>
    new Set(runs.map((run) => distinctLetters(run.replace(PRIMES, '')).length));
  const lengths = lengthsOf(latin);
  const canvasLatinLengths = lengthsOf(latinLabelRuns(canvasText));
  const bookLetters = standaloneArabicLetters(unitText);
  return spacedArabicLetterRuns(canvasText).some(
    (run) =>
      lengths.has(run.length) &&
      !canvasLatinLengths.has(run.length) &&
      ![...run].every((letter) => bookLetters.has(letter)),
  );
}

/** The check's stable code, as the review finding names it. */
export const LABEL_SCRIPT_CHANGED = 'LABEL_SCRIPT_CHANGED';
