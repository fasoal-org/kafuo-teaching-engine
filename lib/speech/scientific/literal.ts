/**
 * Literal fallback reading (plan §10.1, upgrade plan P3): every visible token
 * is spoken in source order and none is ever omitted (FR-030). The output is
 * always speakable:
 * - numbers as authored digits, and letters by their name in the lesson's
 *   domain;
 * - a known LaTeX command by the name of its glyph, never by the command name
 *   (`\xrightarrow` → «سهم», `\Delta` → «دلتا», `^\circ` → «درجة»);
 * - brackets by neutral spoken boundaries («قوس … إغلاق القوس»), never
 *   dropped;
 * - in Chemistry: element symbols kept whole, counts as counts, and charges as
 *   charges, never «أُس»;
 * - an English word inside `\text{}` kept as prose, with a review warning.
 * When an entry is unusable (production before approval), the glyph itself is
 * spoken (`Δ`, `→`, `(`), never a LaTeX name.
 */
import { isElementSymbol } from './chemistry/elements';
import type { Charge } from './chemistry/parse';
import { writeCharge, writeElement } from './chemistry/verbalise-ar';
import { integerValue, structuralWord, writeNumber } from './numbers/read';
import { isArabicLetter, isDigit, isLatinLetter } from './normalise';
import { greekGlyphForKey, tokenize, vulgarFractionParts, type Token } from './math/tokenize';
import { policyTokens } from './policy';
import { label, speak, type VerbaliseContext, Writer } from './writer';

/** Commands spoken by the name of their glyph (fallback: the glyph). */
export const COMMAND_GLYPHS: Readonly<Record<string, string>> = {
  int: '∫',
  iint: '∬',
  oint: '∮',
  sum: '∑',
  prod: '∏',
  in: '∈',
  notin: '∉',
  cup: '∪',
  cap: '∩',
  forall: '∀',
  exists: '∃',
  Rightarrow: '⇒',
  implies: '⇒',
  Leftrightarrow: '⇔',
  iff: '⇔',
  infty: '∞',
  prime: '′',
  to: '→',
  rightarrow: '→',
  longrightarrow: '→',
  xrightarrow: '→',
  leftarrow: '←',
  gets: '←',
  longleftarrow: '←',
  xleftarrow: '←',
  rightleftharpoons: '⇌',
  leftrightharpoons: '⇌',
  rightleftarrows: '⇌',
  leftrightarrow: '↔',
  uparrow: '↑',
  downarrow: '↓',
  partial: '∂',
  nabla: '∇',
  angle: '∠',
  triangle: '△',
  perp: '⊥',
  parallel: '∥',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  emptyset: '∅',
  varnothing: '∅',
  ldots: '…',
  cdots: '…',
  dots: '…',
  circ: '∘',
  degree: '°',
  mapsto: '↦',
};

const OPERATOR_COMMANDS: Readonly<Record<string, string>> = {
  times: '*',
  cdot: '·',
  div: '÷',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  lt: '<',
  gt: '>',
};

/** Display glyphs of the operator keys, spoken when the operator word is unusable. */
const OPERATOR_GLYPHS: Readonly<Record<string, string>> = { '*': '×' };

/** Accents and notations read by a neutral word before their argument (fallback: a glyph). */
const DECORATION_COMMANDS: Readonly<Record<string, [string, string]>> = {
  vec: ['vector', '→'],
  overrightarrow: ['vector', '→'],
  hat: ['hat', '^'],
  bar: ['bar', '¯'],
  overline: ['bar', '¯'],
  dot: ['dot-accent', '˙'],
  ddot: ['double-dot-accent', '¨'],
  tilde: ['tilde', '~'],
  binom: ['binom', 'C'],
  lim: ['lim', 'lim'],
  dbinom: ['binom', 'C'],
  tbinom: ['binom', 'C'],
};

const FRACTION_COMMANDS = new Set(['frac', 'dfrac', 'tfrac']);

const SILENT_COMMANDS = new Set([
  'left',
  'right',
  'mathbf',
  'boldsymbol',
  'bm',
  'mathit',
  'mathbb',
  'mathcal',
  'textbf',
  'emph',
  'operatorname',
  'displaystyle',
  'begin',
  'end',
]);

/** Bracket glyphs spoken as neutral boundaries (`symbol` entries). */
const BRACKETS: Partial<Record<Token['kind'], string>> = {
  lparen: '(',
  rparen: ')',
  lbrack: '[',
  rbrack: ']',
  pipe: '|',
};

export type LiteralContext = VerbaliseContext;

/**
 * An English word or phrase (`heat`, `net force`): Latin words, one of at
 * least three letters, that are not function names or units. Read as prose.
 */
export function isEnglishText(content: string): boolean {
  const text = content.trim();
  const words = text.split(' ');
  if (!words.every((word) => /^[A-Za-z]+$/.test(word))) return false;
  const functions = policyTokens('function');
  const units = policyTokens('unit');
  return words.some((word) => word.length >= 3) && !words.every((word) => functions.has(word) || units.has(word));
}

function writeToken(ctx: LiteralContext, w: Writer, tok: Token): void {
  switch (tok.kind) {
    case 'num':
      writeNumber(ctx, w, tok);
      if (tok.sciExp) {
        w.word(speak(ctx, 'symbol', '^', '^'));
        w.word(tok.sciExp);
      }
      return;
    case 'letter':
      w.sem('var', tok.value);
      w.word(speak(ctx, 'variable', tok.value, tok.value));
      return;
    case 'vfrac': {
      // `½`: the approved unit-fraction word when usable, else `1 / 2`.
      const [num, den] = vulgarFractionParts(tok.value);
      const found = ctx.policy.resolve({ role: 'fraction', token: tok.value, domain: ctx.domain }, ctx.mode);
      if (found) {
        if (found.proposed) ctx.noteProposed();
        w.word(found.text);
        return;
      }
      writeNumber(ctx, w, { intDigits: num, fracDigits: null });
      w.word(label(ctx, '/', '/'));
      writeNumber(ctx, w, { intDigits: den, fracDigits: null });
      return;
    }
    case 'greek':
      w.sem('greek', tok.value);
      w.word(speak(ctx, 'greek', tok.value, greekGlyphForKey(tok.value) ?? tok.value));
      return;
    case 'func':
      w.sem('func', tok.value);
      w.word(speak(ctx, 'function', tok.value, tok.value));
      return;
    case 'op':
    case 'rel':
      w.sem(tok.kind, tok.value);
      w.word(label(ctx, tok.value, OPERATOR_GLYPHS[tok.value] ?? tok.value));
      return;
    case 'caret':
      w.word(speak(ctx, 'symbol', '^', '^'));
      return;
    case 'underscore':
      w.word(speak(ctx, 'symbol', '_', '_'));
      return;
    case 'sup':
      w.word(speak(ctx, 'symbol', '^', '^'));
      writeScriptDigits(ctx, w, tok.value);
      return;
    case 'sub':
      writeScriptDigits(ctx, w, tok.value);
      return;
    case 'root':
      w.word(speak(ctx, 'symbol', '√', '√'));
      return;
    case 'percent':
      w.word(speak(ctx, 'symbol', '%', '%'));
      return;
    case 'degree':
      w.word(speak(ctx, 'symbol', '°', '°'));
      return;
    case 'comma':
      w.pause();
      return;
    case 'colon':
      w.word(speak(ctx, 'symbol', ':', ':'));
      return;
    case 'arrow':
      w.word(speak(ctx, 'symbol', tok.value, tok.value));
      return;
    case 'sym':
      w.sem('sym', tok.value);
      w.word(speak(ctx, 'symbol', tok.value, tok.value));
      return;
    case 'text': {
      const content = tok.value.trim();
      if ([...content].some((ch) => isArabicLetter(ch))) w.word(content);
      else if (isEnglishText(content)) {
        ctx.warn('SATTS_W_UNSUPPORTED_NOTATION', 'english-word');
        w.word(content);
      } else for (const t of tokenize(content)) writeToken(ctx, w, t);
      return;
    }
    case 'cmd': {
      if (SILENT_COMMANDS.has(tok.value)) return;
      if (FRACTION_COMMANDS.has(tok.value)) {
        w.word(label(ctx, 'fraction', '/'));
        return;
      }
      const op = OPERATOR_COMMANDS[tok.value];
      if (op) {
        w.word(label(ctx, op, OPERATOR_GLYPHS[op] ?? op));
        return;
      }
      if (tok.value === 'sqrt') {
        w.word(speak(ctx, 'symbol', '√', '√'));
        return;
      }
      const glyph = COMMAND_GLYPHS[tok.value];
      if (glyph) {
        w.word(speak(ctx, 'symbol', glyph, glyph));
        return;
      }
      const decoration = DECORATION_COMMANDS[tok.value];
      if (decoration) {
        w.word(label(ctx, decoration[0], decoration[1]));
        return;
      }
      // Unknown command (already flagged for review): its name, without the backslash.
      if ([...tok.value].every((ch) => isLatinLetter(ch))) w.word(tok.value);
      return;
    }
    case 'lbrace':
    case 'rbrace':
      // `{ }` only group.
      return;
    case 'lset':
    case 'rset':
      // `\{ \}` are written braces.
      w.word(speak(ctx, 'symbol', tok.value, tok.value));
      return;
    case 'lparen':
    case 'rparen':
    case 'lbrack':
    case 'rbrack':
    case 'pipe': {
      const bracket = BRACKETS[tok.kind]!;
      w.sem('bracket', bracket);
      w.word(speak(ctx, 'symbol', bracket, bracket));
      return;
    }
    case 'unknown':
      if (tok.value.trim() && tok.value !== '\\' && tok.value !== '$') w.word(tok.value);
      return;
  }
}

function writeScriptDigits(ctx: LiteralContext, w: Writer, value: string): void {
  let digits = '';
  const flush = () => {
    if (digits) writeNumber(ctx, w, { intDigits: digits, fracDigits: null });
    digits = '';
  };
  for (const ch of value) {
    if (isDigit(ch)) {
      digits += ch;
      continue;
    }
    flush();
    if (ch === '-' || ch === '+') w.word(label(ctx, ch, ch));
    else if (isLatinLetter(ch)) w.word(speak(ctx, 'variable', ch, ch));
  }
  flush();
}

/** `^\circ` / `^{\circ}` at `i` (a caret): the index after it, or -1. */
function degreeAt(tokens: Token[], i: number): number {
  if (tokens[i]?.kind !== 'caret') return -1;
  const next = tokens[i + 1];
  if (next?.kind === 'cmd' && next.value === 'circ') return i + 2;
  if (next?.kind === 'lbrace' && tokens[i + 2]?.kind === 'cmd' && tokens[i + 2]?.value === 'circ' && tokens[i + 3]?.kind === 'rbrace') {
    return i + 4;
  }
  return -1;
}

/** A charge written after a species: `²⁻`, `^{2+}`, `^+`, `^2-`. Returns it and the index after it. */
function chargeAt(tokens: Token[], i: number): { charge: Charge; next: number } | null {
  const tok = tokens[i];
  if (!tok) return null;
  const parse = (body: string): Charge | null => {
    const match = /^(\d?)([+-])$/.exec(body) ?? /^([+-])(\d)$/.exec(body);
    if (!match) return null;
    const [digits, sign] = /^[+-]/.test(match[1]!) ? [match[2]!, match[1]!] : [match[1]!, match[2]!];
    const magnitude = digits ? Number(digits) : 1;
    return magnitude >= 1 && magnitude <= 9 ? { sign: sign as '+' | '-', magnitude } : null;
  };
  if (tok.kind === 'sup') {
    const charge = parse(tok.value);
    return charge ? { charge, next: i + 1 } : null;
  }
  if (tok.kind !== 'caret') return null;
  let j = i + 1;
  const braced = tokens[j]?.kind === 'lbrace';
  if (braced) j += 1;
  let body = '';
  while (j < tokens.length && (tokens[j]!.kind === 'num' || tokens[j]!.kind === 'op') && body.length < 3) {
    body += tokens[j]!.value;
    j += 1;
    if (!braced && /[+-]$/.test(body)) break;
  }
  if (braced) {
    if (tokens[j]?.kind !== 'rbrace') return null;
    j += 1;
  }
  const charge = parse(body);
  return charge ? { charge, next: j } : null;
}

/**
 * Chemistry literal reading: element symbols whole (`Na`, never `N a`),
 * counts after a species, charges as charges, and the electron.
 */
function chemistryLiteral(ctx: LiteralContext, w: Writer, tokens: Token[]): void {
  let afterSpecies = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const next = tokens[i + 1];
    if (tok.kind === 'letter' && tok.value >= 'A' && tok.value <= 'Z') {
      const two = next?.kind === 'letter' && !next.spaced && next.value >= 'a' && next.value <= 'z' ? tok.value + next.value : '';
      const symbol = two && isElementSymbol(two) ? two : isElementSymbol(tok.value) ? tok.value : '';
      if (symbol) {
        w.sem('el', symbol);
        writeElement(ctx, w, symbol);
        if (symbol.length === 2) i += 1;
        afterSpecies = true;
        continue;
      }
    }
    if (tok.kind === 'letter' && tok.value === 'e') {
      const charge = chargeAt(tokens, i + 1);
      if (charge && charge.charge.sign === '-' && charge.charge.magnitude === 1) {
        w.sem('electron');
        w.word(label(ctx, 'electron', 'e⁻'));
        i = charge.next - 1;
        afterSpecies = false;
        continue;
      }
    }
    if (afterSpecies && !tok.spaced) {
      const charge = chargeAt(tokens, i);
      if (charge) {
        writeCharge(ctx, w, charge.charge);
        i = charge.next - 1;
        afterSpecies = false;
        continue;
      }
      if ((tok.kind === 'num' || tok.kind === 'sub') && /^[0-9]+$/.test(tok.kind === 'num' ? (tok.intDigits ?? '') : tok.value) && !(tok.kind === 'num' && tok.fracDigits)) {
        const value = tok.kind === 'num' ? integerValue(tok)! : Number(tok.value);
        w.sem('count', String(value));
        w.word(structuralWord(ctx, value, 20) ?? String(value));
        continue;
      }
    }
    afterSpecies = tok.kind === 'rparen' || tok.kind === 'rbrack';
    writeToken(ctx, w, tok);
  }
}

export function literalReading(
  source: string,
  ctx: LiteralContext,
  options: { arabicLetters?: boolean } = {},
): Writer {
  const w = new Writer();
  let tokens: Token[];
  try {
    tokens = tokenize(source, { scientificE: false, arabicLetters: options.arabicLetters === true });
  } catch {
    tokens = [];
  }
  // `^\circ` is the degree sign, never «أُس circ».
  const cleaned: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const end = degreeAt(tokens, i);
    if (end > 0) {
      cleaned.push({ ...tokens[i]!, kind: 'degree', value: '°', end: tokens[end - 1]!.end });
      i = end - 1;
      continue;
    }
    cleaned.push(tokens[i]!);
  }
  if (ctx.domain === 'CHEMISTRY') {
    chemistryLiteral(ctx, w, cleaned);
    return w;
  }
  for (let i = 0; i < cleaned.length; i += 1) {
    const tok = cleaned[i]!;
    // `\begin{matrix}` / `\end{matrix}`: the environment name is one word.
    if (tok.kind === 'cmd' && (tok.value === 'begin' || tok.value === 'end') && cleaned[i + 1]?.kind === 'lbrace') {
      let j = i + 2;
      let name = '';
      while (j < cleaned.length && cleaned[j]!.kind === 'letter') {
        name += cleaned[j]!.value;
        j += 1;
      }
      if (cleaned[j]?.kind === 'rbrace' && name) {
        w.word(name);
        i = j;
        continue;
      }
    }
    writeToken(ctx, w, tok);
  }
  return w;
}
