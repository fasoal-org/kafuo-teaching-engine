/**
 * Linear, single-pass tokenizer for the V1 expression grammar (plan §10.1).
 * No backtracking and no regular expression over the whole input. Offsets are
 * relative to the expression source it is given.
 */
import {
  arabicLetterEnd,
  isArabicIndicDigit,
  isArabicWordChar,
  isAsciiDigit,
  isDigit,
  isLatinLetter,
} from '../normalise';
import { policyTokens } from '../policy';

export type TokenKind =
  | 'num'
  | 'letter'
  | 'greek'
  | 'func'
  | 'op'
  | 'rel'
  | 'caret'
  | 'underscore'
  | 'sup'
  | 'sub'
  | 'root'
  | 'cmd'
  | 'text'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbrack'
  | 'rbrack'
  | 'pipe'
  | 'percent'
  | 'colon'
  | 'degree'
  | 'comma'
  | 'arrow'
  | 'sym'
  | 'vfrac'
  /** `\{` / `\}`: written set braces (P9), never grouping. */
  | 'lset'
  | 'rset'
  | 'unknown';

export interface Token {
  kind: TokenKind;
  /** Normalised value (operator symbol, letter, greek key, command name …). */
  value: string;
  start: number;
  end: number;
  /** `num` only: integer digits without group separators, as authored. */
  intDigits?: string;
  /** `num` only: fractional digits as authored, or `null`. */
  fracDigits?: string | null;
  /** `num` only: scientific-notation exponent digits (`3e8`), Physics only. */
  sciExp?: string | null;
  /** `num` only: sign of the scientific exponent. */
  sciSign?: '+' | '-' | null;
  /** True when whitespace separates this token from the previous one. */
  spaced: boolean;
}

export interface TokenizeOptions {
  /** Recognise `3e8` (e only between digits). Physics. */
  scientificE?: boolean;
  /**
   * Mathematics and Physics: an isolated Arabic letter (`س`, `هـ`) is a
   * variable `letter` token (D-1, D-10); an Arabic word is a `text` token
   * (prose inside the expression). Chemistry leaves Arabic script untouched.
   */
  arabicLetters?: boolean;
}

/**
 * Function names come from `functions.json` (upgrade plan P2 item 4), so a
 * function added to the dictionary is recognised without a code change.
 */
export const FUNCTION_NAMES: readonly string[] = [...policyTokens('function')];

const GREEK_GLYPHS: Readonly<Record<string, string>> = {
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  ε: 'epsilon',
  ϵ: 'epsilon',
  ζ: 'zeta',
  η: 'eta',
  θ: 'theta',
  ι: 'iota',
  κ: 'kappa',
  λ: 'lambda',
  μ: 'mu',
  µ: 'mu',
  ν: 'nu',
  ξ: 'xi',
  ο: 'omicron',
  π: 'pi',
  ρ: 'rho',
  σ: 'sigma',
  τ: 'tau',
  υ: 'upsilon',
  φ: 'phi',
  ϕ: 'phi',
  χ: 'chi',
  ψ: 'psi',
  ω: 'omega',
  Γ: 'Gamma',
  Δ: 'Delta',
  Θ: 'Theta',
  Λ: 'Lambda',
  Ξ: 'Xi',
  Π: 'Pi',
  Σ: 'Sigma',
  Υ: 'Upsilon',
  Φ: 'Phi',
  Ψ: 'Psi',
  Ω: 'Omega',
};

export const GREEK_KEYS: ReadonlySet<string> = new Set(Object.values(GREEK_GLYPHS));

export function greekKeyForGlyph(ch: string): string | undefined {
  return GREEK_GLYPHS[ch];
}

const GREEK_KEY_GLYPHS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GREEK_GLYPHS)
    .reverse()
    .map(([glyph, key]) => [key, glyph]),
);

/** The glyph of a greek key (`Delta` → `Δ`): the literal form of an unusable entry (P3). */
export function greekGlyphForKey(key: string): string | undefined {
  return GREEK_KEY_GLYPHS[key];
}

const OPS: Readonly<Record<string, string>> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '–': '-',
  '×': '*',
  // O-8: the dot product glyphs keep their own reading («نقطة»).
  '·': '·',
  '⋅': '·',
  '*': '*',
  '÷': '÷',
  '/': '/',
  '⁄': '/',
  '±': '±',
  '∓': '∓',
  // P9: set and composition operators, read by their names.
  '∪': '∪',
  '∩': '∩',
  '∘': '∘',
};

const RELS: Readonly<Record<string, string>> = {
  '=': '=',
  '≠': '≠',
  '<': '<',
  '>': '>',
  '≤': '≤',
  '⩽': '≤',
  '≥': '≥',
  '⩾': '≥',
  '≈': '≈',
  '≡': '≡',
  // P9: set, logic and geometry relations.
  '∈': '∈',
  '∉': '∉',
  '⊂': '⊂',
  '⊆': '⊆',
  '⊃': '⊃',
  '⇒': '⇒',
  '⇔': '⇔',
  '∥': '∥',
  '⊥': '⊥',
};

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  ⁿ: 'n',
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
  '₊': '+',
  '₋': '-',
};

/** Unicode vulgar fractions, read exactly like `\frac{a}{b}` (plan §10.1). */
const VULGAR_FRACTIONS: Readonly<Record<string, string>> = {
  '½': '1/2',
  '⅓': '1/3',
  '⅔': '2/3',
  '¼': '1/4',
  '¾': '3/4',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅐': '1/7',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⅑': '1/9',
  '⅒': '1/10',
  '↉': '0/3',
};

export function isVulgarFractionGlyph(ch: string): boolean {
  return ch in VULGAR_FRACTIONS;
}

/** `[numerator, denominator]` digit strings of a `vfrac` token value (`'1/2'`). */
export function vulgarFractionParts(value: string): [string, string] {
  const [num = '', den = ''] = value.split('/');
  return [num, den];
}

export function superscriptValue(ch: string): string | undefined {
  return SUPERSCRIPTS[ch];
}

export function subscriptValue(ch: string): string | undefined {
  return SUBSCRIPTS[ch];
}

const ROOTS: Readonly<Record<string, string>> = { '√': 'sqrt', '∛': 'cbrt', '∜': '4rt' };

const ARROWS: Readonly<Record<string, string>> = {
  '→': '→',
  '⟶': '→',
  '←': '←',
  '⟵': '←',
  '⇌': '⇌',
  '⇄': '⇌',
  '↔': '↔',
};

/** Deferred glyphs (plan §10.1): recognised so they can be named and flagged. */
export const DEFERRED_GLYPHS = new Set([
  '∫',
  '∑',
  '∏',
  '∀',
  '∃',
  '∞',
  '∅',
  '∠',
  '△',
  '!',
  '′',
  '″',
  "'",
  ';',
]);

/** Combining marks after a letter: macron and overline (`x̄`), the vector arrow (`F⃗`). */
const COMBINING_ACCENTS: Readonly<Record<string, string>> = {
  '\u0304': 'bar',
  '\u0305': 'bar',
  '\u20d7': 'vec',
};

/** Spacing commands dropped by the tokenizer. */
const SPACING_COMMANDS = new Set([',', ';', ':', '!', ' ', 'quad', 'qquad', 'enspace', 'thinspace']);

export function isSuperscriptGlyph(ch: string): boolean {
  return ch in SUPERSCRIPTS;
}

export function isSubscriptGlyph(ch: string): boolean {
  return ch in SUBSCRIPTS;
}

export function isOperatorGlyph(ch: string): boolean {
  return ch in OPS;
}

export function isRelationGlyph(ch: string): boolean {
  return ch in RELS;
}

export function isRootGlyph(ch: string): boolean {
  return ch in ROOTS;
}

export function isArrowGlyph(ch: string): boolean {
  return ch in ARROWS;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ';
}

/** Reads a balanced `{…}` starting at `open` (which must be `{`). Returns the index after `}` or -1. */
export function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function tokenize(src: string, options: TokenizeOptions = {}): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let spaced = false;
  const push = (kind: TokenKind, value: string, start: number, end: number, extra?: Partial<Token>) => {
    tokens.push({ kind, value, start, end, spaced, ...extra });
    spaced = false;
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (isWhitespace(ch)) {
      spaced = true;
      i += 1;
      continue;
    }

    // Numbers: digits, one decimal separator, thousands groups of exactly 3.
    if (isDigit(ch)) {
      const start = i;
      const arabic = isArabicIndicDigit(ch);
      const sameDigit = (c: string | undefined) => (arabic ? isArabicIndicDigit(c) : isAsciiDigit(c));
      let intDigits = '';
      let grouped = false;
      while (i < src.length) {
        const c = src[i];
        if (sameDigit(c)) {
          intDigits += c;
          i += 1;
          continue;
        }
        const groupSep = arabic ? '٬' : ',';
        if (
          c === groupSep &&
          sameDigit(src[i + 1]) &&
          sameDigit(src[i + 2]) &&
          sameDigit(src[i + 3]) &&
          !sameDigit(src[i + 4]) &&
          (grouped || intDigits.length <= 3)
        ) {
          intDigits += src.slice(i + 1, i + 4);
          grouped = true;
          i += 4;
          continue;
        }
        break;
      }
      let fracDigits: string | null = null;
      const decSep = arabic ? '٫' : '.';
      if ((src[i] === decSep || (arabic && src[i] === '.')) && sameDigit(src[i + 1])) {
        i += 1;
        fracDigits = '';
        while (i < src.length && sameDigit(src[i])) {
          fracDigits += src[i];
          i += 1;
        }
      }
      let sciExp: string | null = null;
      let sciSign: '+' | '-' | null = null;
      if (options.scientificE && !arabic && (src[i] === 'e' || src[i] === 'E')) {
        let j = i + 1;
        let sign: '+' | '-' | null = null;
        if (src[j] === '+' || src[j] === '-' || src[j] === '−') {
          sign = src[j] === '+' ? '+' : '-';
          j += 1;
        }
        if (isAsciiDigit(src[j])) {
          let exp = '';
          while (j < src.length && isAsciiDigit(src[j])) {
            exp += src[j];
            j += 1;
          }
          sciExp = exp;
          sciSign = sign;
          i = j;
        }
      }
      push('num', src.slice(start, i), start, i, { intDigits, fracDigits, sciExp, sciSign });
      continue;
    }

    if (isLatinLetter(ch)) {
      // A maximal letter run: a known function prefix is one token, the rest letters.
      const start = i;
      let end = i;
      while (end < src.length && isLatinLetter(src[end])) end += 1;
      const run = src.slice(start, end);
      const fn = FUNCTION_NAMES.filter((name) => run.startsWith(name)).sort(
        (a, b) => b.length - a.length,
      )[0];
      let k = start;
      if (fn && (run.length === fn.length || !FUNCTION_NAMES.includes(run))) {
        push('func', fn, start, start + fn.length);
        k = start + fn.length;
      }
      for (; k < end; k += 1) {
        // `x̄`, `F⃗`: a combining accent is read like `\bar{x}` / `\vec{F}` (P9).
        const accent = COMBINING_ACCENTS[src[k + 1] ?? ''];
        if (accent && k + 1 === end) {
          push('cmd', accent, k, k);
          push('letter', src[k]!, k, k + 2);
          end += 1;
          break;
        }
        push('letter', src[k]!, k, k + 1);
      }
      i = end;
      continue;
    }

    if (options.arabicLetters && isArabicWordChar(ch)) {
      const start = i;
      const letterEnd = arabicLetterEnd(src, i);
      if (letterEnd > 0) {
        // `هـ` → the letter `ه`: tatweel is typography, not part of the name.
        push('letter', ch, start, letterEnd);
        i = letterEnd;
        continue;
      }
      // Arabic words (`\frac{المسافة}{الزمن}`) are prose inside the expression;
      // consecutive words form one token, an isolated letter never joins them.
      let end = i;
      for (;;) {
        while (end < src.length && isArabicWordChar(src[end])) end += 1;
        let k = end;
        while (src[k] === ' ' || src[k] === '\u00a0') k += 1;
        if (k > end && isArabicWordChar(src[k]) && arabicLetterEnd(src, k) < 0) {
          end = k;
          continue;
        }
        break;
      }
      push('text', src.slice(start, end), start, end);
      i = end;
      continue;
    }

    const greek = GREEK_GLYPHS[ch];
    if (greek) {
      push('greek', greek, i, i + 1);
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const start = i;
      const next = src[i + 1];
      if (next === undefined) {
        push('unknown', '\\', i, i + 1);
        i += 1;
        continue;
      }
      if (!isLatinLetter(next)) {
        i += 2;
        if (SPACING_COMMANDS.has(next)) {
          spaced = true;
          continue;
        }
        if (next === '%') push('percent', '%', start, i);
        else if (next === '{') push('lset', '{', start, i);
        else if (next === '}') push('rset', '}', start, i);
        else if (next === '|') push('pipe', '|', start, i);
        else push('cmd', next, start, i);
        continue;
      }
      let end = i + 1;
      while (end < src.length && isLatinLetter(src[end])) end += 1;
      const name = src.slice(i + 1, end);
      i = end;
      if (SPACING_COMMANDS.has(name)) {
        spaced = true;
        continue;
      }
      if (name === 'text' || name === 'mathrm' || name === 'textrm' || name === 'mbox') {
        let j = i;
        while (isWhitespace(src[j])) j += 1;
        if (src[j] === '{') {
          const close = matchBrace(src, j);
          if (close > 0) {
            push('text', src.slice(j + 1, close - 1), start, close);
            i = close;
            continue;
          }
        }
      }
      if (GREEK_KEYS.has(name) || name === 'varepsilon' || name === 'varphi' || name === 'vartheta') {
        const key = name.startsWith('var') ? name.slice(3) : name;
        push('greek', key, start, i);
        continue;
      }
      if (FUNCTION_NAMES.includes(name)) {
        push('func', name, start, i);
        continue;
      }
      push('cmd', name, start, i);
      continue;
    }

    const single = (kind: TokenKind, value: string) => {
      push(kind, value, i, i + 1);
      i += 1;
    };
    if (ch === '-' && src[i + 1] === '>') {
      push('arrow', '→', i, i + 2);
      i += 2;
      continue;
    }
    if (OPS[ch]) {
      single('op', OPS[ch]!);
      continue;
    }
    if (RELS[ch]) {
      // `->` and `<=>`/`<-` arrows are chemistry syntax; `<=`/`>=` are relations.
      if (ch === '<' && src[i + 1] === '=') {
        if (src[i + 2] === '>') {
          push('arrow', '⇌', i, i + 3);
          i += 3;
          continue;
        }
        push('rel', '≤', i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '>' && src[i + 1] === '=') {
        push('rel', '≥', i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '<' && src[i + 1] === '-') {
        push('arrow', '←', i, i + 2);
        i += 2;
        continue;
      }
      single('rel', RELS[ch]!);
      continue;
    }
    if (ARROWS[ch]) {
      single('arrow', ARROWS[ch]!);
      continue;
    }
    if (SUPERSCRIPTS[ch] !== undefined) {
      const start = i;
      let value = '';
      while (i < src.length && SUPERSCRIPTS[src[i]!] !== undefined) {
        value += SUPERSCRIPTS[src[i]!];
        i += 1;
      }
      push('sup', value, start, i);
      continue;
    }
    if (SUBSCRIPTS[ch] !== undefined) {
      const start = i;
      let value = '';
      while (i < src.length && SUBSCRIPTS[src[i]!] !== undefined) {
        value += SUBSCRIPTS[src[i]!];
        i += 1;
      }
      push('sub', value, start, i);
      continue;
    }
    if (ROOTS[ch]) {
      single('root', ROOTS[ch]!);
      continue;
    }
    if (VULGAR_FRACTIONS[ch]) {
      single('vfrac', VULGAR_FRACTIONS[ch]!);
      continue;
    }
    switch (ch) {
      case '^':
        single('caret', '^');
        continue;
      case '_':
        single('underscore', '_');
        continue;
      case '{':
        single('lbrace', '{');
        continue;
      case '}':
        single('rbrace', '}');
        continue;
      case '(':
        single('lparen', '(');
        continue;
      case ')':
        single('rparen', ')');
        continue;
      case '[':
        single('lbrack', '[');
        continue;
      case ']':
        single('rbrack', ']');
        continue;
      case '|':
        single('pipe', '|');
        continue;
      case '%':
      case '٪':
        single('percent', '%');
        continue;
      case ':':
        single('colon', ':');
        continue;
      case '°':
        single('degree', '°');
        continue;
      case ',':
      case '،':
        single('comma', ',');
        continue;
      default:
        break;
    }
    if (DEFERRED_GLYPHS.has(ch)) {
      single('sym', ch === "'" ? '′' : ch);
      continue;
    }
    single('unknown', ch);
  }
  return timesBetweenNumbers(tokens);
}

/**
 * `3 x 4`, `3 x 10^8`: a spaced lower-case `x` between two numbers is the
 * multiplication sign (P4 item 5), read «في».
 */
function timesBetweenNumbers(tokens: Token[]): Token[] {
  for (let i = 1; i + 1 < tokens.length; i += 1) {
    const [prev, tok, next] = [tokens[i - 1]!, tokens[i]!, tokens[i + 1]!];
    if (tok.kind === 'letter' && tok.value === 'x' && tok.spaced && next.spaced && prev.kind === 'num' && next.kind === 'num') {
      tokens[i] = { ...tok, kind: 'op', value: '*' };
    }
  }
  return tokens;
}
