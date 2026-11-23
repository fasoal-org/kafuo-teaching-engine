/**
 * Plain-text and number extraction for the agent read API (Kafuo Agent API plan
 * §1.5, spec §1.4). Pure: no I/O.
 *
 * - `htmlToPlainText`: HTML → plain Unicode in logical (stored) order. `<sub>` /
 *   `<sup>` become Unicode sub/superscripts before the tags are stripped (the
 *   shared `stripTags` would otherwise turn `H<sub>2</sub>` into «H 2»); inline
 *   formatting tags are removed without a space; inline math (`$…$`, `\(…\)`,
 *   `\[…\]`) is linearized by `latexToPlainText`.
 * - A group with any character that has no Unicode sub/superscript form (Arabic-
 *   Indic digits, most letters) is kept as `_{…}` / `^{…}`, so nothing is dropped.
 * - `extractNumbers`: base-line decimals only (Latin, Arabic-Indic ٠-٩ and
 *   Extended ۰-۹; `.` or `٫` as the decimal point; `٬` or `,`+3 digits as
 *   grouping), `m × 10ⁿ` / `10ⁿ` as one value. Unsigned: `−` is never a sign.
 */
import { stripTags } from '@/lib/server/teaching-package/package-review-input';

const SUB: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  o: 'ₒ',
  x: 'ₓ',
  h: 'ₕ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  p: 'ₚ',
  s: 'ₛ',
  t: 'ₜ',
  i: 'ᵢ',
  r: 'ᵣ',
  u: 'ᵤ',
  v: 'ᵥ',
};

const SUP: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
  x: 'ˣ',
};

/** A lone superscript that means "degree" (`<sup>o</sup>`, `^o`, `^\circ`). */
const DEGREE_MARKS = new Set(['o', '∘', '°', '\\circ']);

// Braces of a kept `_{…}` / `^{…}` group travel as private-use sentinels, so the
// LaTeX pass's final brace cleanup can never strip them; `restoreBraces` puts
// them back in every public output.
const OPEN = '';
const CLOSE = '';

function restoreBraces(text: string): string {
  return text.replaceAll(OPEN, '{').replaceAll(CLOSE, '}');
}

function mapAll(text: string, table: Record<string, string>): string | null {
  let out = '';
  for (const char of text) {
    const mapped = table[char];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

function sub(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  return mapAll(trimmed, SUB) ?? `_${OPEN}${trimmed}${CLOSE}`;
}

function sup(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (DEGREE_MARKS.has(trimmed)) return '°';
  return mapAll(trimmed, SUP) ?? `^${OPEN}${trimmed}${CLOSE}`;
}

/** `2` → `₂`; a group with an unmappable character stays `_{…}` (never dropped). */
export function toSubscript(text: string): string {
  return restoreBraces(sub(text));
}

/** `3+` → `³⁺`; a lone `o` / `\circ` → `°`; unmappable → `^{…}`. */
export function toSuperscript(text: string): string {
  return restoreBraces(sup(text));
}

const LATEX_SYMBOLS: Array<[RegExp, string]> = [
  [/\\times\b/g, '×'],
  [/\\cdot\b/g, '·'],
  [/\\div\b/g, '÷'],
  [/\\pm\b/g, '±'],
  [/\\mp\b/g, '∓'],
  [/\\rightleftharpoons\b/g, '⇌'],
  [/\\leftrightarrow\b/g, '↔'],
  [/\\longrightarrow\b/g, '→'],
  [/\\rightarrow\b/g, '→'],
  [/\\to\b/g, '→'],
  [/\\leftarrow\b/g, '←'],
  [/\\Rightarrow\b/g, '⇒'],
  [/\\leq?\b/g, '≤'],
  [/\\geq?\b/g, '≥'],
  [/\\neq?\b/g, '≠'],
  [/\\approx\b/g, '≈'],
  [/\\infty\b/g, '∞'],
  [/\\degree\b/g, '°'],
  [/\\circ\b/g, '∘'],
  [/\\Delta\b/g, 'Δ'],
  [/\\delta\b/g, 'δ'],
  [/\\alpha\b/g, 'α'],
  [/\\beta\b/g, 'β'],
  [/\\gamma\b/g, 'γ'],
  [/\\theta\b/g, 'θ'],
  [/\\lambda\b/g, 'λ'],
  [/\\mu\b/g, 'μ'],
  [/\\pi\b/g, 'π'],
  [/\\sigma\b/g, 'σ'],
  [/\\omega\b/g, 'ω'],
  [/\\Omega\b/g, 'Ω'],
  [/\\%/g, '%'],
  [/\\[,;:! ]/g, ' '],
  [/\\quad\b|\\qquad\b/g, ' '],
  [/~/g, ' '],
];

/** One brace group starting at `open` (`{`), or null when unbalanced. */
function braceGroup(source: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1;
    else if (source[at] === '}') {
      depth -= 1;
      if (depth === 0) return { inner: source.slice(open + 1, at), end: at + 1 };
    }
  }
  return null;
}

/** Replace `\cmd{a}` (or `\cmd{a}{b}`) groups, innermost first by recursion. */
function replaceCommand(
  source: string,
  command: string,
  arity: 1 | 2,
  render: (...args: string[]) => string,
): string {
  let out = '';
  let at = 0;
  const needle = `\\${command}`;
  for (;;) {
    const found = source.indexOf(needle, at);
    if (found < 0) return out + source.slice(at);
    let cursor = found + needle.length;
    while (source[cursor] === ' ') cursor += 1;
    const args: string[] = [];
    for (let n = 0; n < arity; n += 1) {
      if (source[cursor] !== '{') break;
      const group = braceGroup(source, cursor);
      if (!group) break;
      args.push(group.inner);
      cursor = group.end;
      while (n + 1 < arity && source[cursor] === ' ') cursor += 1;
    }
    if (args.length !== arity || /[A-Za-z]/.test(source[found + needle.length] ?? '')) {
      // Not this command (e.g. `\textbf` for `\text`) or malformed: keep as is.
      out += source.slice(at, found + needle.length);
      at = found + needle.length;
      continue;
    }
    out += source.slice(at, found) + render(...args);
    at = cursor;
  }
}

/**
 * mhchem `\ce{…}`: `^{…}` / `^3+` and a species' trailing charge (`H+`, `Cl-`,
 * `Ca2+`, as mhchem reads them) are superscripts; other digits after an element
 * or `)` are subscripts; `->` / `<=>` are arrows.
 */
function chemistryToPlain(inner: string): string {
  return inner
    .replace(/<=>/g, '⇌')
    .replace(/->/g, '→')
    .replace(/\^\{([^}]*)\}|\^([0-9]*[+\-−])/g, (_, braced: string, bare: string) =>
      sup(braced ?? bare),
    )
    .replace(
      /([A-Za-z)\]])(\d*[+\-−])(?=\s|$|[)\],])/g,
      (_, before: string, charge: string) => before + sup(charge),
    )
    .replace(/([A-Za-z)\]])(\d+)/g, (_, before: string, digits: string) => before + sub(digits));
}

/**
 * Linearize one LaTeX math source: symbols → Unicode, `\frac{a}{b}` → `a/b`
 * (parenthesized when compound), `\sqrt{x}` → `√x`, `\text{…}` → its text,
 * `_x` / `_{…}` → subscripts, `^x` / `^{…}` → superscripts. Unknown commands keep
 * their name without the backslash, so nothing is dropped.
 */
export function latexToPlainText(latex: string): string {
  let text = latex;
  text = replaceCommand(text, 'ce', 1, chemistryToPlain);
  for (const command of [
    'text',
    'mathrm',
    'textrm',
    'mathbf',
    'textbf',
    'mathit',
    'operatorname',
  ]) {
    text = replaceCommand(text, command, 1, (inner) => inner);
  }
  // `\left(` / `\right)` sizing only — never `\leftarrow` / `\rightarrow`.
  text = text.replace(/\\(?:left|right)(?![A-Za-z])/g, '');
  for (const [pattern, symbol] of LATEX_SYMBOLS) text = text.replace(pattern, symbol);
  const wrap = (part: string) =>
    /^[\p{L}\p{N}.,٫]+$/u.test(part.trim()) ? part.trim() : `(${part.trim()})`;
  // Fractions and roots may nest: repeat until stable.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = text;
    text = replaceCommand(text, 'frac', 2, (a, b) => `${wrap(a)}/${wrap(b)}`);
    text = replaceCommand(text, 'dfrac', 2, (a, b) => `${wrap(a)}/${wrap(b)}`);
    text = replaceCommand(text, 'sqrt', 1, (a) => `√${wrap(a)}`);
    if (text === before) break;
  }
  // Scripts: braced first (innermost groups were already flattened), then one char.
  text = text.replace(/\^\{([^{}]*)\}/g, (_, inner: string) => sup(inner));
  text = text.replace(/_\{([^{}]*)\}/g, (_, inner: string) => sub(inner));
  text = text.replace(/\^(∘|[^\s{}\\])/g, (_, one: string) => sup(one));
  text = text.replace(/_([^\s{}\\])/g, (_, one: string) => sub(one));
  // Remaining unknown commands keep their name; bare grouping braces go (a kept
  // `_{…}` group's braces are sentinels here and survive).
  text = text.replace(/\\([A-Za-z]+)/g, '$1').replace(/[{}]/g, '');
  return restoreBraces(text.replace(/[ \t]+/g, ' ').trim()).normalize('NFC');
}

/**
 * Whether a single-`$` span is math rather than prose with prices: it holds a
 * LaTeX command or a script (`\`, `^`, `_`), or it is a tight (no padding)
 * formula of variables, digits and operators with at least one operator.
 */
export function looksLikeMath(content: string): boolean {
  if (/[\\^_]/.test(content)) return true;
  return (
    /^\S(?:.*\S)?$/.test(content) &&
    /^[\p{L}\d\s.,+\-−×÷=<>()/*·]+$/u.test(content) &&
    /[=+\-−×÷<>*/·]/.test(content)
  );
}

/** `$$…$$`, `\(…\)`, `\[…\]` and math-like `$…$` inside plain text → linearized math. */
export function inlineMathToPlainText(text: string): string {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, math: string) => latexToPlainText(math))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => latexToPlainText(math))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, math: string) => latexToPlainText(math))
    .replace(/\$([^$\n]+?)\$/g, (whole: string, math: string) =>
      looksLikeMath(math) ? latexToPlainText(math) : whole,
    );
}

const INLINE_TAGS = /<\/?(?:span|b|strong|i|em|u|s|strike|font|a|mark|small|big|code)\b[^>]*>/gi;

/**
 * HTML → plain Unicode. `<sub>`/`<sup>` first (inner tags stripped), then
 * inline tags without a space, then the shared `stripTags`, then inline math.
 */
export function htmlToPlainText(html: string): string {
  const scripts = html
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, inner: string) =>
      sub(stripTags(inner.replace(INLINE_TAGS, ''))),
    )
    .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, inner: string) =>
      sup(stripTags(inner.replace(INLINE_TAGS, ''))),
    )
    .replace(INLINE_TAGS, '');
  return restoreBraces(inlineMathToPlainText(stripTags(scripts))).normalize('NFC');
}

const DIGIT_BASES = [0x0660, 0x06f0];

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits → Latin. */
export function latinDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = DIGIT_BASES.find((start) => code >= start && code <= start + 9)!;
    return String(code - base);
  });
}

const SUP_TO_ASCII: Record<string, string> = {
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
  '⁻': '-',
  '⁺': '',
};

// Alternative 1: a bare power of ten (`10²³`); alternative 2: a decimal with an
// optional `× 10ⁿ` / `× 10^n` exponent.
const NUMBER =
  /10([⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)|(\d+(?:(?:,|٬)\d{3}(?!\d))*(?:[.٫]\d+)?)(?:\s*[×·⋅]\s*10(?:([⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)|\^\{?([-−+]?\d+)\}?))?/g;

/**
 * The numeric values in a text, in order, as decimals. Base-line digits only:
 * a subscript (H₂SO₄) is not a number; a superscript counts only as the
 * exponent of 10 (`6.02×10²³`, `10⁻³`, `× 10^23`).
 */
export function extractNumbers(text: string): number[] {
  const latin = latinDigits(text);
  const values: number[] = [];
  for (const match of latin.matchAll(NUMBER)) {
    const [, bareTenExponent, mantissa, supExponent, caretExponent] = match;
    let value: number;
    if (mantissa === undefined) {
      const exponent = [...bareTenExponent!].map((char) => SUP_TO_ASCII[char]).join('');
      value = 10 ** Number(exponent);
    } else {
      const base = Number(mantissa.replace(/[,٬]/g, '').replace('٫', '.'));
      const exponentText =
        supExponent !== undefined
          ? [...supExponent].map((char) => SUP_TO_ASCII[char]).join('')
          : caretExponent?.replace('−', '-');
      value = exponentText !== undefined ? Number(`${base}e${exponentText}`) : base;
    }
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}
