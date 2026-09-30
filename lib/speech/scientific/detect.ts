/**
 * Expression boundary detection (plan §9.3). Detectors in priority order:
 * explicit math delimiters, explicit chemistry (`\ce{}`/`\pu{}`), then maximal
 * Latin/math runs bounded by Arabic script or sentence punctuation. Offsets
 * never overlap. Linear scan; no regular expression with nested quantifiers.
 *
 * Mathematics and Physics only: an isolated Arabic letter that sits inside a
 * math expression is a variable (`س = 5`, `2س + 3`, `س²`) and joins the run
 * (D-1, D-10). Everything else in Arabic script stays prose.
 */
import type { ScientificSubjectCode } from './context';
import {
  TATWEEL,
  arabicLetterEnd,
  isArabicIndicDigit,
  isArabicVariableLetter,
  isArabicWordChar,
  isAsciiDigit,
  isBidiControl,
  isDigit,
  isLatinLetter,
} from './normalise';
import {
  DEFERRED_GLYPHS,
  greekKeyForGlyph,
  isArrowGlyph,
  isOperatorGlyph,
  isRelationGlyph,
  isRootGlyph,
  isSubscriptGlyph,
  isSuperscriptGlyph,
  isVulgarFractionGlyph,
  matchBrace,
  FUNCTION_NAMES,
} from './math/tokenize';

export type CandidateKind = 'delimited' | 'ce' | 'run';

export interface ExpressionCandidate {
  kind: CandidateKind;
  /** Offsets of the whole candidate in the original text. */
  start: number;
  end: number;
  /** Offsets of the content to parse (delimiters excluded). */
  innerStart: number;
  innerEnd: number;
  /** `run` only: why it is an expression. */
  reason?: 'structure' | 'symbol' | 'quantity' | 'formula' | 'notation';
  /** `ce` only: which explicit chemistry command (`\\ce{}` or `\\pu{}`). */
  command?: 'ce' | 'pu';
  /**
   * `run` only: the run starts with a binary `+`/`-` whose left term is the
   * text just before it (`1445 هـ - 3`), so it is never read as a sign.
   */
  leadingBinary?: boolean;
  /** `delimited` only: a unit written just after the closing `$` (`$10^{-3}$ kg`). */
  unitSuffix?: { start: number; end: number };
}

export interface DetectHooks {
  /** Physics/Chemistry: is there a unit expression at `pos` of `src`? */
  unitAt?: (src: string, pos: number) => boolean;
  /** The end of a unit expression (with O-7 evidence) at `pos`, or -1. */
  unitEnd?: (src: string, pos: number) => number;
  /**
   * Chemistry: does this run read as a chemical formula or reaction?
   * `'formula'` → chemistry expression; `'ambiguous'` → a lone symbol that
   * parses as a formula but is not promoted (read as letters, with a warning).
   */
  formulaKind?: (run: string) => 'formula' | 'ambiguous' | 'notation' | null;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === ' ';
}

/** Characters that may belong to a Latin/math run. */
function isRunChar(ch: string): boolean {
  return (
    isLatinLetter(ch) ||
    isDigit(ch) ||
    greekKeyForGlyph(ch) !== undefined ||
    isOperatorGlyph(ch) ||
    isRelationGlyph(ch) ||
    isSuperscriptGlyph(ch) ||
    isSubscriptGlyph(ch) ||
    isRootGlyph(ch) ||
    isArrowGlyph(ch) ||
    isVulgarFractionGlyph(ch) ||
    DEFERRED_GLYPHS.has(ch) ||
    ch === '↑' ||
    ch === '↓' ||
    ch === '℉' ||
    // Combining accents after a letter: `x̄`, `F⃗` (P9).
    ch === '\u0304' ||
    ch === '\u0305' ||
    ch === '\u20d7' ||
    ch === '≡' ||
    isBidiControl(ch) ||
    '^_(){}[]|%٪°℃.,:\\٫٬'.includes(ch)
  );
}

/** Characters that make a run structural (plan §9.3 item 4). */
function isStructureChar(ch: string): boolean {
  return (
    isOperatorGlyph(ch) ||
    isRelationGlyph(ch) ||
    isSuperscriptGlyph(ch) ||
    isSubscriptGlyph(ch) ||
    isRootGlyph(ch) ||
    isArrowGlyph(ch) ||
    isVulgarFractionGlyph(ch) ||
    DEFERRED_GLYPHS.has(ch) ||
    ch === '\u0304' ||
    ch === '\u0305' ||
    ch === '\u20d7' ||
    '^_\\%٪°'.includes(ch)
  );
}

// ---------------------------------------------------------------------------
// Arabic-letter variables (Mathematics and Physics)
// ---------------------------------------------------------------------------

/**
 * Letters that are never a variable right after a number: `2024م` / `5 م`
 * (Gregorian marker, metre) and `1445هـ` / `1445 هـ` (Hijri marker).
 */
const NUMBER_MARKER_LETTERS: ReadonlySet<string> = new Set(['م', 'ه']);

/** Arabic letters read as a function with an attached bracket: د(س), هـ(س). */
const ARABIC_FUNCTION_LETTERS: ReadonlySet<string> = new Set(['د', 'ه']);

/** One-letter proclitics written attached to the next word or bracket (ب، ل، ف، ك). */
const PROCLITIC_LETTERS: ReadonlySet<string> = new Set(['ب', 'ل', 'ف', 'ك']);

/** Does the `(…)` group opening at `open` (same line, short) contain an operator or relation? */
function bracketHoldsOperator(text: string, open: number): boolean {
  let depth = 0;
  let operator = false;
  for (let k = open; k < text.length && k < open + 128; k += 1) {
    const ch = text[k]!;
    if (ch === '\n') return false;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return operator;
    } else if (isOperatorOrRelation(ch)) operator = true;
  }
  return false;
}

function isOperatorOrRelation(ch: string | undefined): boolean {
  return ch !== undefined && (isOperatorGlyph(ch) || isRelationGlyph(ch));
}

/** Index of the nearest non-space character before `i`, or -1. */
function prevNonSpace(text: string, i: number): number {
  let k = i - 1;
  while (k >= 0 && isSpace(text[k])) k -= 1;
  return k;
}

/** Index of the nearest non-space character at or after `i` (may be `text.length`). */
function nextNonSpace(text: string, i: number): number {
  let k = i;
  while (k < text.length && isSpace(text[k])) k += 1;
  return k;
}

/** Start of the isolated Arabic letter that ends at `end` (tatweel included), or -1. */
function arabicLetterStartBefore(text: string, end: number): number {
  let k = end - 1;
  while (k >= 0 && text[k] === TATWEEL) k -= 1;
  return k >= 0 && arabicLetterEnd(text, k) === end ? k : -1;
}

/** Is the letter at `start` right after a number (`5م`, `5 م`)? */
function followsNumber(text: string, start: number): boolean {
  return isDigit(text[prevNonSpace(text, start)]);
}

/** An isolated Arabic letter at `start` that may be an operand (not a number marker). */
function isArabicOperandAt(text: string, start: number): boolean {
  return (
    arabicLetterEnd(text, start) > 0 &&
    !(NUMBER_MARKER_LETTERS.has(text[start]!) && followsNumber(text, start))
  );
}

/** Can an operand start at `k` (the far side of an operator)? Signs are skipped iteratively. */
function operandStartsAt(text: string, k: number): boolean {
  let at = k;
  while (text[at] === '-' || text[at] === '−' || text[at] === '+') at = nextNonSpace(text, at + 1);
  const ch = text[at];
  if (ch === undefined) return false;
  return (
    isDigit(ch) ||
    isLatinLetter(ch) ||
    greekKeyForGlyph(ch) !== undefined ||
    isRootGlyph(ch) ||
    isVulgarFractionGlyph(ch) ||
    '([|\\'.includes(ch) ||
    isArabicOperandAt(text, at)
  );
}

/** Can an operand end at `k` (the near side of an operator)? */
function operandEndsAt(text: string, k: number): boolean {
  const ch = text[k];
  if (ch === undefined) return false;
  if (
    isDigit(ch) ||
    isLatinLetter(ch) ||
    greekKeyForGlyph(ch) !== undefined ||
    isSuperscriptGlyph(ch) ||
    isSubscriptGlyph(ch) ||
    isVulgarFractionGlyph(ch) ||
    ')]|}'.includes(ch)
  ) {
    return true;
  }
  const start = arabicLetterStartBefore(text, k + 1);
  return start >= 0 && isArabicOperandAt(text, start);
}

/**
 * End offset of an Arabic-letter variable at `i`, or -1. A one-letter Arabic
 * word is a variable only when it sits inside a math expression:
 * - an operator or relation next to it (spaced or not) with an operand on the
 *   operator's far side: `س = 5`, `2 × س`, `س + ص`;
 * - a coefficient attached before it: `2س`;
 * - a script attached after it: `س²`, `س^2`, `س_1`;
 * - function notation: `د(س)`.
 * Conservative by design: `و` is never a variable, a letter inside a word never
 * is, a lone letter with no math neighbour stays prose (`قيمة س؟`), and a letter
 * right after a number is a unit or date marker unless an operator or a script
 * makes it a term (`1445 هـ`, `2024م`, `5 م/ث` stay prose; `2 س + 3` does not).
 */
export function arabicVariableEnd(text: string, i: number): number {
  const end = arabicLetterEnd(text, i);
  if (end < 0) return -1;
  const letter = text[i]!;
  const prev = text[i - 1];
  const next = text[end];
  const before = prevNonSpace(text, i);
  const after = nextNonSpace(text, end);
  const beforeCh = text[before];
  const afterCh = text[after];
  const opAfter = isOperatorOrRelation(afterCh) && operandStartsAt(text, nextNonSpace(text, after + 1));
  const opBefore = isOperatorOrRelation(beforeCh) && operandEndsAt(text, prevNonSpace(text, before));
  const scriptAfter =
    next !== undefined && (isSuperscriptGlyph(next) || isSubscriptGlyph(next) || next === '^' || next === '_');
  if (isDigit(beforeCh)) {
    if (NUMBER_MARKER_LETTERS.has(letter)) return -1;
    // Attached: coefficient × variable (`2س`).
    if (before === i - 1) return end;
    // Spaced: a unit position (`5 م/ث`) unless an operator or a script follows.
    return scriptAfter || (opAfter && afterCh !== '/' && afterCh !== '·' && afterCh !== '⋅') ? end : -1;
  }
  // The denominator of a unit whose numerator is not a term (`5 م/ث²`, `كم/س`).
  if (!opBefore && (beforeCh === '/' || beforeCh === '·' || beforeCh === '⋅')) return -1;
  if (opAfter || opBefore || scriptAfter) return end;
  // A radicand: `√س`, `∛س`.
  if (prev !== undefined && isRootGlyph(prev)) return end;
  if (next === '(' && ARABIC_FUNCTION_LETTERS.has(letter)) return end;
  // O-5: `ق(س)` — a letter applied to one Arabic-letter argument.
  if (next === '(' && !PROCLITIC_LETTERS.has(letter) && singleLetterBracket(text, end)) return end;
  // A factor before a bracketed expression: `س(س + 1)`. Not a proclitic
  // (`ب(…)`, `ل(…)`), and not a numbered label such as `س(1)`.
  if (next === '(' && !PROCLITIC_LETTERS.has(letter) && bracketHoldsOperator(text, end)) return end;
  // The argument of `د(س)`, `ق(س)`.
  if (prev === '(' && next === ')' && i >= 2) {
    const fn = arabicLetterStartBefore(text, i - 1);
    if (fn >= 0 && !PROCLITIC_LETTERS.has(text[fn]!)) return end;
  }
  return -1;
}

/** `(س)` right at `open`: a bracket holding exactly one Arabic letter. */
function singleLetterBracket(text: string, open: number): boolean {
  if (text[open] !== '(') return false;
  const end = arabicLetterEnd(text, open + 1);
  return end > 0 && text[end] === ')';
}

/** Does the run hold math beyond Arabic letters and brackets (`(أ)` is a list label)? */
function hasMathSignal(run: string): boolean {
  for (const ch of run) {
    if (isArabicWordChar(ch) || isSpace(ch) || '()[]'.includes(ch)) continue;
    return true;
  }
  return false;
}

/** One-letter proclitics that attach to a variable in prose: `وس`, `فس`, `بس`. */
const TERM_PROCLITICS: ReadonlySet<string> = new Set(['و', 'ف', 'ب', 'ل', 'ك']);

/**
 * Can a term end just before `s` (skipping spaces)? Used for a leading `+`/`-`
 * followed by a space, which is then the binary operator, never a sign. A term
 * is a number, a Latin letter, a script, a closing bracket, an isolated Arabic
 * letter (`1445 هـ - 3`) or a proclitic plus one variable letter (`وس + 1`).
 * An ordinary word is not a term: `الناتج هو - 3` keeps «سالب».
 */
function termEndsBefore(text: string, s: number): boolean {
  const k = prevNonSpace(text, s);
  const ch = text[k];
  if (ch === undefined) return false;
  if (
    isDigit(ch) ||
    isLatinLetter(ch) ||
    isSuperscriptGlyph(ch) ||
    isSubscriptGlyph(ch) ||
    ')]|'.includes(ch)
  ) {
    return true;
  }
  if (arabicLetterStartBefore(text, k + 1) >= 0) return true;
  let letter = k;
  while (letter >= 0 && text[letter] === TATWEEL) letter -= 1;
  const proclitic = letter - 1;
  return (
    isArabicVariableLetter(text[letter]) &&
    proclitic >= 0 &&
    TERM_PROCLITICS.has(text[proclitic]!) &&
    !isArabicWordChar(text[proclitic - 1])
  );
}

const SENTENCE_END = new Set(['.', ',', ':', ';', '!', '?', '؟', '،', '؛']);

function hasMathToken(text: string): boolean {
  for (const ch of text) {
    if (isLatinLetter(ch) || isDigit(ch) || isStructureChar(ch) || greekKeyForGlyph(ch)) return true;
  }
  return false;
}

/** Does delimited content end in a value (a number, a power of ten)? */
function hasValue(inner: string): boolean {
  const text = inner.trim();
  return isDigit(text[text.length - 1]) || (/[0-9]/.test(text) && /[}²³⁰-⁹]$/.test(text));
}

/** `$…$`: paired on the same line and containing a math token. */
function matchDollar(text: string, i: number): ExpressionCandidate | null {
  const double = text[i + 1] === '$';
  const open = double ? 2 : 1;
  for (let j = i + open; j < text.length; j += 1) {
    const ch = text[j];
    // `!` may be a factorial (`$n!$`, P4 item 6); `؟` always ends the sentence.
    if (ch === '\n' || (!double && ch === '؟')) return null;
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '$') {
      if (double && text[j + 1] !== '$') continue;
      const inner = text.slice(i + open, j);
      if (!hasMathToken(inner)) return null;
      const end = j + open;
      return { kind: 'delimited', start: i, end, innerStart: i + open, innerEnd: j };
    }
  }
  return null;
}

/** `\(…\)` and `\[…\]`. */
function matchBackslashDelimiter(text: string, i: number): ExpressionCandidate | null {
  const close = text[i + 1] === '(' ? '\\)' : '\\]';
  const j = text.indexOf(close, i + 2);
  if (j < 0) return null;
  const inner = text.slice(i + 2, j);
  if (!hasMathToken(inner)) return null;
  return { kind: 'delimited', start: i, end: j + 2, innerStart: i + 2, innerEnd: j };
}

function matchChemCommand(text: string, i: number): ExpressionCandidate | null {
  const isCe = text.startsWith('\\ce{', i);
  const isPu = text.startsWith('\\pu{', i);
  if (!isCe && !isPu) return null;
  const close = matchBrace(text, i + 3);
  if (close < 0) return null;
  return {
    kind: 'ce',
    start: i,
    end: close,
    innerStart: i + 4,
    innerEnd: close - 1,
    command: isCe ? 'ce' : 'pu',
  };
}

/** Extends a run from `i`, including balanced `{…}` after commands (which may hold Arabic `\text{}`). */
function scanRun(text: string, i: number, arabicVariables: boolean): number {
  const arabicAt = (k: number) => (arabicVariables ? arabicVariableEnd(text, k) : -1);
  let j = i;
  let lastRun = i;
  while (j < text.length) {
    const ch = text[j]!;
    const arabicEnd = arabicAt(j);
    if (arabicEnd > 0) {
      j = arabicEnd;
      lastRun = j;
      continue;
    }
    if (ch === '\\' && isLatinLetter(text[j + 1])) {
      j += 1;
      while (j < text.length && isLatinLetter(text[j])) j += 1;
      // A command's braced arguments belong to the run.
      while (text[j] === '{') {
        const close = matchBrace(text, j);
        if (close < 0) break;
        j = close;
      }
      lastRun = j;
      continue;
    }
    if (ch === '{') {
      const close = matchBrace(text, j);
      if (close > 0) {
        j = close;
        lastRun = j;
        continue;
      }
    }
    if (
      (ch === ',' || ch === '.' || ch === ':' || ch === '٫' || ch === '٬') &&
      !(isDigit(text[j - 1]) && isDigit(text[j + 1])) &&
      text[j - 1] !== '\\'
    ) {
      // Outside a number, these punctuate the sentence: the run ends here.
      break;
    }
    if (isRunChar(ch)) {
      j += 1;
      lastRun = j;
      continue;
    }
    if (isSpace(ch)) {
      // Spaces belong to the run only when more run characters follow.
      let k = j;
      while (isSpace(text[k])) k += 1;
      if (
        k < text.length &&
        (isRunChar(text[k]!) || arabicAt(k) > 0) &&
        !(text[k] === ',' || text[k] === '.')
      ) {
        j = k;
        continue;
      }
      break;
    }
    break;
  }
  return lastRun;
}

/** Drops trailing sentence punctuation and unmatched brackets (the run's context, not its content). */
function trimRun(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  for (let changed = true; changed && e > s; ) {
    changed = false;
    while (e > s && isSpace(text[e - 1])) {
      e -= 1;
      changed = true;
    }
    const last = text[e - 1]!;
    if (SENTENCE_END.has(last) && !(last === '.' && isDigit(text[e]))) {
      e -= 1;
      changed = true;
      continue;
    }
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      if (count(text, s, e, open) < count(text, s, e, last)) {
        e -= 1;
        changed = true;
      }
    }
  }
  for (let changed = true; changed && e > s; ) {
    changed = false;
    while (s < e && isSpace(text[s])) {
      s += 1;
      changed = true;
    }
    const first = text[s]!;
    if (first === '(' || first === '[' || first === '{') {
      const close = first === '(' ? ')' : first === '[' ? ']' : '}';
      if (count(text, s, e, first) > count(text, s, e, close)) {
        s += 1;
        changed = true;
      }
    }
    if (first === ',' || first === '.' || first === ':') {
      s += 1;
      changed = true;
    }
  }
  return [s, e];
}

function count(text: string, s: number, e: number, ch: string): number {
  let n = 0;
  for (let i = s; i < e; i += 1) if (text[i] === ch) n += 1;
  return n;
}

/** A year range such as `2020-2024` is prose, not a subtraction. */
function isYearRange(run: string): boolean {
  const parts = run.split(/\s*[-–]\s*/);
  return (
    parts.length === 2 &&
    parts.every((part) => part.length >= 2 && part.length <= 4 && [...part].every((c) => isAsciiDigit(c) || isArabicIndicDigit(c))) &&
    parts[0]!.length === 4
  );
}

/** `sin`, `log` … followed by a bracket or a spaced number: `sin(x)`, `log 100`. */
function startsFunctionCall(run: string, i: number): boolean {
  for (const name of FUNCTION_NAMES) {
    if (!run.startsWith(name, i) || isLatinLetter(run[i - 1]) || isLatinLetter(run[i + name.length])) continue;
    const after = run[i + name.length];
    if (after === '(') return true;
    if (after === ' ' && isDigit(run[i + name.length + 1])) return true;
  }
  return false;
}

/**
 * Undelimited math that has no operator glyph (P4 item 7): a paired `|x|`,
 * `sin(x)` / `log 100`, a grouped number (`1,000`, `١٬٠٠٠`), or `3 x 4`.
 */
function hasUndelimitedMath(run: string): boolean {
  let bars = 0;
  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i]!;
    if (ch === '|') bars += 1;
    if (startsFunctionCall(run, i)) return true;
    if ((ch === ',' || ch === '٬') && isDigit(run[i - 1]) && isDigit(run[i + 1]) && isDigit(run[i + 2]) && isDigit(run[i + 3]) && !isDigit(run[i + 4])) {
      return true;
    }
    if (ch === 'x' && run[i - 1] === ' ' && run[i + 1] === ' ' && isDigit(run[i - 2]) && isDigit(run[i + 2])) return true;
  }
  return bars >= 2 && bars % 2 === 0;
}

function classifyRun(
  run: string,
  subject: ScientificSubjectCode,
  hooks: DetectHooks,
): ExpressionCandidate['reason'] | null {
  if (isYearRange(run)) return null;
  if (subject !== 'CHEMISTRY' && !hasMathSignal(run)) return null;
  // O-7 in Chemistry (P7 item 2): a value with a unit on evidence (`300 K`,
  // `10 N`) is a quantity, never an element.
  if (subject === 'CHEMISTRY' && hooks.unitAt && isDigit(run[0])) {
    let k = 0;
    while (k < run.length && (isDigit(run[k]) || run[k] === '.' || run[k] === '٫')) k += 1;
    if (hooks.unitAt(run, k)) return 'quantity';
  }
  if (subject === 'CHEMISTRY' && hooks.formulaKind) {
    const kind = hooks.formulaKind(run);
    if (kind === 'formula') return 'formula';
    if (kind === 'ambiguous') return 'symbol';
    if (kind === 'notation') return 'notation';
  }
  // A number with a unit (O-7 evidence) is a quantity; Mathematics too (P6 item 4).
  if (hooks.unitAt && isDigit(run[0])) {
    let k = 0;
    while (k < run.length && (isDigit(run[k]) || run[k] === '.' || run[k] === '٫' || run[k] === ',' || run[k] === '٬')) k += 1;
    if (hooks.unitAt(run, k)) return 'quantity';
  }
  if (hasUndelimitedMath(run)) return 'structure';
  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i]!;
    if (isStructureChar(ch)) return 'structure';
    if (ch === '/') return 'structure';
    if (
      isDigit(ch) &&
      (isLatinLetter(run[i + 1]) ||
        greekKeyForGlyph(run[i + 1] ?? '') !== undefined ||
        arabicLetterEnd(run, i + 1) > 0)
    ) {
      return 'structure';
    }
    if ((ch === '.' || ch === '٫') && isDigit(run[i - 1]) && isDigit(run[i + 1])) return 'structure';
    if (ch === ':' && isDigit(run[i - 1]) && isDigit(run[i + 1])) return 'structure';
  }
  if (subject === 'CHEMISTRY') return null;
  // A lone Latin letter (optionally a Greek letter) is a variable/symbol token.
  if (run.length === 1 && (isLatinLetter(run) || greekKeyForGlyph(run) !== undefined)) return 'symbol';
  // Mathematics: two or three capital letters name points/segments (AB, ABC).
  if (subject === 'MATH' && /^[A-Z]{2,3}$/.test(run)) return 'symbol';
  return null;
}

export function detectExpressions(
  text: string,
  subject: ScientificSubjectCode,
  hooks: DetectHooks = {},
): ExpressionCandidate[] {
  const out: ExpressionCandidate[] = [];
  const arabicVariables = subject === 'MATH' || subject === 'PHYSICS';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '$') {
      const found = matchDollar(text, i);
      if (found) {
        // `$10^{-3}$ kg`: a unit right after a delimited value joins it (P6 item 3).
        const unitStart = found.end + (text[found.end] === ' ' ? 1 : 0);
        const unitEnd = hooks.unitEnd && hasValue(text.slice(found.innerStart, found.innerEnd)) ? hooks.unitEnd(text, unitStart) : -1;
        if (unitEnd > unitStart && isLatinLetter(text[unitStart])) {
          found.unitSuffix = { start: unitStart, end: unitEnd };
          found.end = unitEnd;
        }
        out.push(found);
        i = found.end;
        continue;
      }
    }
    if (ch === '\\' && (text[i + 1] === '(' || text[i + 1] === '[')) {
      const found = matchBackslashDelimiter(text, i);
      if (found) {
        out.push(found);
        i = found.end;
        continue;
      }
    }
    if (ch === '\\' && (text.startsWith('\\ce{', i) || text.startsWith('\\pu{', i))) {
      const found = matchChemCommand(text, i);
      if (found) {
        out.push(found);
        i = found.end;
        continue;
      }
    }
    if (
      (isRunChar(ch) && !SENTENCE_END.has(ch) && ch !== ')' && ch !== ']' && ch !== '}') ||
      (arabicVariables && arabicVariableEnd(text, i) > 0)
    ) {
      const rawEnd = scanRun(text, i, arabicVariables);
      const [s, e] = trimRun(text, i, rawEnd);
      if (e > s) {
        const run = text.slice(s, e);
        const reason = classifyRun(run, subject, hooks);
        if (reason) {
          const candidate: ExpressionCandidate = { kind: 'run', start: s, end: e, innerStart: s, innerEnd: e, reason };
          const first = text[s];
          if (
            arabicVariables &&
            (first === '+' || first === '-' || first === '−') &&
            isSpace(text[s + 1]) &&
            termEndsBefore(text, s)
          ) {
            candidate.leadingBinary = true;
          }
          out.push(candidate);
        }
      }
      i = Math.max(rawEnd, i + 1);
      continue;
    }
    i += 1;
  }
  return out;
}
