/**
 * Pratt parser for the V1 Mathematics grammar (plan §10.1), shared by Physics
 * (§10.2), which adds quantities with units, vectors and scientific notation.
 * Linear in the token count; nesting is bounded (plan §15).
 *
 * Precedence, lowest to highest: relation chain → ratio → additive →
 * multiplicative (incl. implicit juxtaposition `2x`) → unary sign → postfix
 * (% °) → power / subscript (right-associative) → primary.
 */
import { MAX_EXPRESSION_TOKENS, MAX_NESTING_DEPTH } from '../bounds';
import { tokenize, vulgarFractionParts, type Token } from './tokenize';

export type MathNode =
  | { t: 'num'; tok: Token }
  | { t: 'var'; name: string }
  | { t: 'greek'; key: string }
  | { t: 'text'; content: string }
  | { t: 'group'; kind: 'paren' | 'bracket' | 'brace'; body: MathNode }
  | { t: 'abs'; body: MathNode }
  | { t: 'frac'; num: MathNode; den: MathNode }
  | { t: 'pow'; base: MathNode; exp: MathNode }
  | { t: 'sub'; base: MathNode; index: MathNode }
  | { t: 'root'; degree: MathNode | null; body: MathNode }
  | { t: 'func'; name: string; power: MathNode | null; base: MathNode | null; arg: MathNode }
  | { t: 'apply'; fn: MathNode; arg: MathNode }
  | { t: 'unary'; op: 'neg' | 'pos' | '±' | '∓'; arg: MathNode }
  | {
      t: 'bin';
      op: '+' | '-' | '*' | '·' | '/' | '÷' | '±' | '∓' | '∪' | '∩' | '∘' | 'juxt';
      left: MathNode;
      right: MathNode;
    }
  /** P9: `\int_a^b`, `\sum_{i=1}^{n}`, `\prod` with their body. */
  | { t: 'bigop'; op: 'int' | 'iint' | 'oint' | 'sum' | 'prod'; lower: MathNode | null; upper: MathNode | null; body: MathNode }
  /** P9: `\lim_{x \to 0} f(x)`. */
  | { t: 'lim'; under: MathNode | null; body: MathNode }
  /** P9: a tuple, an interval `[2, 5)` or a set `\{1, 2\}`, read with its written brackets. */
  | { t: 'list'; open: string; close: string; items: MathNode[] }
  /** P9: `\bar{x}`, `x̄`, `\hat{i}`, `\dot{x}`: the symbol, then the accent's name. */
  | { t: 'accent'; accent: 'bar' | 'hat' | 'dot' | 'ddot' | 'tilde'; body: MathNode }
  /** P9: `\binom{n}{k}`. */
  | { t: 'binom'; n: MathNode; k: MathNode }
  /** P9: `∠ABC`, `△ABC`, `∀x`, `∃x`: a symbol read before its argument. */
  | { t: 'prefix'; glyph: '∠' | '△' | '∀' | '∃'; arg: MathNode }
  /** P9: `∅`, `∞`. */
  | { t: 'symbol'; glyph: string }
  /** `2\frac{1}{3}`, `2⅓`, `3 1/4`: a whole number and a proper fraction (P4 item 2). */
  | { t: 'mixed'; whole: MathNode; frac: Extract<MathNode, { t: 'frac' }> }
  /** `n!` (P4 item 6). */
  | { t: 'factorial'; arg: MathNode }
  /** `P(A|B)`: the bar inside a function argument (P4 item 6). */
  | { t: 'given'; left: MathNode; right: MathNode }
  | { t: 'rel'; items: MathNode[]; ops: string[] }
  | { t: 'percent'; arg: MathNode }
  | { t: 'degree'; arg: MathNode }
  | { t: 'ratio'; left: MathNode; right: MathNode }
  | { t: 'vec'; body: MathNode }
  | { t: 'qty'; value: MathNode; unit: UnitNode }
  | { t: 'sci'; mantissa: MathNode; exponent: MathNode };

/** Physics unit expression (see `physics/units.ts`). */
export interface UnitNode {
  /** Numerator factors, in order. */
  num: UnitFactor[];
  /** Denominator factors, in order (`/`). */
  den: UnitFactor[];
  /** Authored source text of the unit. */
  source: string;
}

export interface UnitFactor {
  /** Dictionary key of the unit (`m`, `s`, `°C`, `Wh` …). */
  unit: string;
  /** Prefix key (`k`, `m`, `μ` …) or `null`. */
  prefix: string | null;
  /** Integer power (1 when absent; negative allowed). */
  power: number;
}

export type ParseFaultKind =
  | 'unsupported'
  | 'malformed'
  | 'unknown-command'
  | 'unknown-element'
  | 'bound';

export class ParseFault extends Error {
  constructor(
    public readonly kind: ParseFaultKind,
    public readonly detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'ParseFault';
  }
}

export interface UnitMatch {
  end: number;
  unit: UnitNode;
  /** O-7: a unit-shaped letter without evidence (`5s`); read as the letter. */
  ambiguous?: boolean;
}

export interface MathParseOptions {
  /** Physics: quantities, vectors, `3e8`. */
  physics?: boolean;
  /** Physics and Mathematics: matches a unit expression in `src` at `pos` (after a number). */
  matchUnit?: (src: string, pos: number) => UnitMatch | null;
  /** O-7: called with the source of a unit-shaped symbol that lacks evidence. */
  onAmbiguousUnit?: (source: string) => void;
  /** Mathematics and Physics: Arabic-letter variables (see `TokenizeOptions`). */
  arabicLetters?: boolean;
  /**
   * The expression starts with a binary `+`/`-` whose left term is the prose
   * just before it (`… هـ - 3`): the operator is read as binary, never as a
   * unary sign.
   */
  leadingBinary?: boolean;
}

/**
 * O-5 (P4 item 3): a letter with an attached bracket holding ONE symbol is
 * read function-style for every letter (`p(x)` → «بي لسين», `P(A)`, `ق(س)`).
 * With a compound argument only the conventional function letters are; for
 * any other letter the bracket is a factor, so a factored product keeps its
 * meaning (`x(x+1)`, `a(b+c)`: R1, DEC-044).
 */
const FUNCTION_LETTERS: ReadonlySet<string> = new Set(['f', 'g', 'h', 'p', 'q', 'F', 'G', 'P', 'E', 'د', 'ه', 'ق']);

/** The elided left operand of a leading binary operator (spoken as nothing). */
const LEADING_HOLE: MathNode = { t: 'text', content: '' };

/** Commands of the V1 subset, other than greek letters and functions. */
const RELATION_COMMANDS: Readonly<Record<string, string>> = {
  // P9: sets, logic, geometry, and the limit arrow.
  in: '∈',
  notin: '∉',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  Rightarrow: '⇒',
  implies: '⇒',
  Leftrightarrow: '⇔',
  iff: '⇔',
  parallel: '∥',
  perp: '⊥',
  to: '→',
  rightarrow: '→',
  le: '≤',
  leq: '≤',
  leqslant: '≤',
  ge: '≥',
  geq: '≥',
  geqslant: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  lt: '<',
  gt: '>',
};

const OPERATOR_COMMANDS: Readonly<Record<string, string>> = {
  times: '*',
  // O-8: `·` keeps its own reading («نقطة»), never merged with `×`.
  cdot: '·',
  cup: '∪',
  cap: '∩',
  circ: '∘',
  div: '÷',
  pm: '±',
  mp: '∓',
};

/** Deferred LaTeX constructs (plan §10.1): literal reading + warning. */
export const DEFERRED_COMMANDS = new Set([
  // Chemistry commands outside a Chemistry lesson.
  'ce',
  'pu',
  'iiint',
  'begin',
  'end',
  'choose',
  'underline',
  'prime',
  'partial',
  'nabla',
  'det',
  'max',
  'min',
  'lfloor',
  'rfloor',
  'lceil',
  'rceil',
  'mathcal',
  'mapsto',
]);

/** P9 commands with a reading of their own. */
const BIG_OPERATORS: Readonly<Record<string, 'int' | 'iint' | 'oint' | 'sum' | 'prod'>> = {
  int: 'int',
  iint: 'iint',
  oint: 'oint',
  sum: 'sum',
  prod: 'prod',
  '∫': 'int',
  '∬': 'iint',
  '∮': 'oint',
  '∑': 'sum',
  '∏': 'prod',
};
const ACCENT_COMMANDS: Readonly<Record<string, 'bar' | 'hat' | 'dot' | 'ddot' | 'tilde'>> = {
  bar: 'bar',
  overline: 'bar',
  hat: 'hat',
  widehat: 'hat',
  dot: 'dot',
  ddot: 'ddot',
  tilde: 'tilde',
};
const PREFIX_SYMBOLS: Readonly<Record<string, '∠' | '△' | '∀' | '∃'>> = {
  angle: '∠',
  triangle: '△',
  forall: '∀',
  exists: '∃',
  '∠': '∠',
  '△': '△',
  '∀': '∀',
  '∃': '∃',
};
const ATOM_SYMBOLS: Readonly<Record<string, string>> = {
  infty: '∞',
  emptyset: '∅',
  varnothing: '∅',
  '∞': '∞',
  '∅': '∅',
};

/** Commands that only wrap their argument (bold vector, font). */
const TRANSPARENT_COMMANDS = new Set(['mathbf', 'boldsymbol', 'bm', 'mathit', 'mathbb', 'displaystyle']);

const FRAC_COMMANDS = new Set(['frac', 'dfrac', 'tfrac']);

class Parser {
  private pos = 0;
  private depth = 0;
  /** >0 while parsing an exponent/index: units never attach inside a script. */
  private scriptDepth = 0;
  /** >0 inside `|…|`: a bar there closes the absolute value. */
  private absDepth = 0;
  maxDepth = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: Token[],
    private readonly options: MathParseOptions,
  ) {}

  parse(): MathNode {
    if (this.tokens.length === 0) throw new ParseFault('malformed', 'empty expression');
    const node = this.relation();
    if (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!;
      throw new ParseFault('malformed', `unexpected ${tok.kind} '${tok.value}'`);
    }
    return node;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new ParseFault('malformed', 'unexpected end of expression');
    this.pos += 1;
    return tok;
  }

  private expect(kind: Token['kind']): Token {
    const tok = this.next();
    if (tok.kind !== kind) throw new ParseFault('malformed', `expected ${kind}, got ${tok.kind}`);
    return tok;
  }

  private enter(): void {
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    if (this.depth > MAX_NESTING_DEPTH) throw new ParseFault('bound', 'nesting depth');
  }

  private leave(): void {
    this.depth -= 1;
  }

  private relation(): MathNode {
    const first = this.ratio();
    const items = [first];
    const ops: string[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok?.kind === 'rel') {
        this.next();
        ops.push(tok.value);
      } else if (tok?.kind === 'cmd' && RELATION_COMMANDS[tok.value]) {
        this.next();
        ops.push(RELATION_COMMANDS[tok.value]!);
      } else break;
      items.push(this.ratio());
    }
    return ops.length === 0 ? first : { t: 'rel', items, ops };
  }

  private ratio(): MathNode {
    const left = this.additive();
    if (this.peek()?.kind === 'colon') {
      this.next();
      const right = this.additive();
      return { t: 'ratio', left, right };
    }
    return left;
  }

  private additive(): MathNode {
    const lead = this.pos === 0 && this.options.leadingBinary ? this.binaryOp(this.peek()) : null;
    let left =
      lead === '+' || lead === '-' || lead === '±' || lead === '∓' ? LEADING_HOLE : this.multiplicative();
    for (;;) {
      const tok = this.peek();
      const op = this.binaryOp(tok);
      if (op !== '+' && op !== '-' && op !== '±' && op !== '∓') break;
      this.next();
      const right = this.multiplicative();
      left = { t: 'bin', op, left, right };
    }
    return left;
  }

  private binaryOp(tok: Token | undefined): string | null {
    if (!tok) return null;
    if (tok.kind === 'op') return tok.value;
    if (tok.kind === 'cmd' && OPERATOR_COMMANDS[tok.value]) return OPERATOR_COMMANDS[tok.value]!;
    return null;
  }

  private startsPrimary(tok: Token | undefined): boolean {
    if (!tok) return false;
    switch (tok.kind) {
      case 'num':
      case 'letter':
      case 'greek':
      case 'func':
      case 'lparen':
      case 'lbrack':
      case 'root':
      case 'text':
      case 'vfrac':
      case 'lset':
        return true;
      case 'cmd':
        return (
          FRAC_COMMANDS.has(tok.value) ||
          tok.value === 'sqrt' ||
          tok.value === 'vec' ||
          tok.value === 'overrightarrow' ||
          tok.value === 'left' ||
          TRANSPARENT_COMMANDS.has(tok.value) ||
          DEFERRED_COMMANDS.has(tok.value) ||
          !(tok.value in RELATION_COMMANDS || tok.value in OPERATOR_COMMANDS || tok.value === 'right')
        );
      case 'sym':
        return true;
      case 'pipe':
        // `2|x|`: only outside another `|…|`, when a second bar follows.
        return this.absDepth === 0 && this.pipeOpensAbs();
      default:
        return false;
    }
  }

  /** Is the bar at the cursor the first of a `|…|` pair before its group closes? */
  private pipeOpensAbs(): boolean {
    let depth = 0;
    for (let i = this.pos + 1; i < this.tokens.length; i += 1) {
      const kind = this.tokens[i]!.kind;
      if (kind === 'lparen' || kind === 'lbrack' || kind === 'lbrace') depth += 1;
      else if (kind === 'rparen' || kind === 'rbrack' || kind === 'rbrace') {
        if (depth === 0) return false;
        depth -= 1;
      } else if (kind === 'pipe' && depth === 0) return true;
    }
    return false;
  }

  /**
   * Explicit `×`, `·`, `/`, `÷`, left-associative, between implicit products:
   * `dy/dx` is (dy)/(dx) and `a/bc` is a/(bc) (P4 item 1).
   */
  private multiplicative(): MathNode {
    let left = this.product();
    for (;;) {
      const op = this.binaryOp(this.peek());
      if (op === '*' || op === '·' || op === '/' || op === '÷' || op === '∪' || op === '∩' || op === '∘') {
        this.next();
        const right = this.product();
        left = { t: 'bin', op, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  /** Implicit juxtaposition (`2x`, `dy`, `mv²`): binds tighter than `/`. */
  private product(): MathNode {
    let left = this.unary();
    for (;;) {
      const tok = this.peek();
      if (this.binaryOp(tok) !== null || !this.startsPrimary(tok)) break;
      // `(f∘g)(x)`: a bracketed composition applied to an argument (P9).
      if (tok?.kind === 'lparen' && !tok.spaced && left.t === 'group' && left.body.t === 'bin' && left.body.op === '∘') {
        left = { t: 'apply', fn: left, arg: this.primary() };
        continue;
      }
      // `3 1/4`: a whole number, a space, a proper fraction.
      const spacedMixed = left.t === 'num' ? this.spacedMixedFraction() : null;
      if (spacedMixed) {
        left = { t: 'mixed', whole: left, frac: spacedMixed };
        continue;
      }
      const right = this.postfix();
      if (left.t === 'num' && isProperIntegerFraction(right) && isInteger(left)) {
        left = { t: 'mixed', whole: left, frac: right };
        continue;
      }
      left = { t: 'bin', op: 'juxt', left, right };
    }
    return left;
  }

  /** `1/4` after a spaced whole number (`3 1/4`), when proper: consumes it. */
  private spacedMixedFraction(): Extract<MathNode, { t: 'frac' }> | null {
    const [num, slash, den, after] = [this.peek(), this.peek(1), this.peek(2), this.peek(3)];
    if (!num || num.kind !== 'num' || !num.spaced || slash?.kind !== 'op' || slash.value !== '/') return null;
    if (!den || den.kind !== 'num' || den.spaced || num.fracDigits || den.fracDigits || slash.spaced) return null;
    if (after && !after.spaced && (after.kind === 'letter' || after.kind === 'num')) return null;
    const node: Extract<MathNode, { t: 'frac' }> = { t: 'frac', num: { t: 'num', tok: num }, den: { t: 'num', tok: den } };
    if (!isProperIntegerFraction(node)) return null;
    this.pos += 3;
    return node;
  }

  private unary(): MathNode {
    const tok = this.peek();
    const op = this.binaryOp(tok);
    if (op === '-' || op === '+' || op === '±' || op === '∓') {
      this.next();
      this.enter();
      const arg = this.unary();
      this.leave();
      return { t: 'unary', op: op === '-' ? 'neg' : op === '+' ? 'pos' : op, arg };
    }
    return this.postfix();
  }

  private postfix(): MathNode {
    let node = this.power();
    // Physics: a power of ten is also in unit position (`3 × 10^8 m/s`).
    if (this.options.matchUnit && this.scriptDepth === 0 && isPowerOfTen(node) && this.pos > 0) {
      const match = this.unitAt(this.tokens[this.pos - 1]!.end);
      if (match) {
        while (this.pos < this.tokens.length && this.tokens[this.pos]!.start < match.end) this.pos += 1;
        node = { t: 'qty', value: node, unit: match.unit };
      }
    }
    for (;;) {
      const tok = this.peek();
      if (tok?.kind === 'percent') {
        this.next();
        node = { t: 'percent', arg: node };
        continue;
      }
      if (tok?.kind === 'degree' || (tok?.kind === 'cmd' && tok.value === 'degree')) {
        this.next();
        node = { t: 'degree', arg: node };
        continue;
      }
      if (tok?.kind === 'sym' && tok.value === '!') {
        this.next();
        node = { t: 'factorial', arg: node };
        continue;
      }
      if (tok?.kind === 'sym' && (tok.value === '′' || tok.value === '″')) {
        throw new ParseFault('unsupported', 'prime');
      }
      break;
    }
    return node;
  }

  /** Power and subscript, right-associative; Unicode scripts attach here too. */
  private power(): MathNode {
    let base = this.primary();
    for (;;) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.kind === 'caret') {
        this.next();
        // `^\circ` is the degree sign.
        const after = this.peek();
        if (after?.kind === 'cmd' && after.value === 'circ') {
          this.next();
          base = { t: 'degree', arg: base };
          continue;
        }
        if (after?.kind === 'lbrace' && this.peek(1)?.kind === 'cmd' && this.peek(1)?.value === 'circ') {
          this.next();
          this.next();
          this.expect('rbrace');
          base = { t: 'degree', arg: base };
          continue;
        }
        this.enter();
        // `10^23` (ASCII scientific notation, P6 item 9): the whole number is the exponent.
        const exp = this.scriptArgument(isTen(base));
        this.leave();
        base = { t: 'pow', base, exp };
        continue;
      }
      if (tok.kind === 'underscore') {
        this.next();
        this.enter();
        const index = this.scriptArgument();
        this.leave();
        base = { t: 'sub', base, index };
        continue;
      }
      // Unicode scripts behave exactly like `^` and `_`, spaced or not.
      if (tok.kind === 'sup') {
        this.next();
        base = { t: 'pow', base, exp: scriptText(tok.value) };
        continue;
      }
      if (tok.kind === 'sub') {
        this.next();
        base = { t: 'sub', base, index: scriptText(tok.value) };
        continue;
      }
      break;
    }
    return base;
  }

  /** A script argument: a braced group, or a single (possibly signed) token. */
  private scriptArgument(multiDigit = false): MathNode {
    this.scriptDepth += 1;
    try {
      return this.scriptArgumentInner(multiDigit);
    } finally {
      this.scriptDepth -= 1;
    }
  }

  private scriptArgumentInner(multiDigit = false): MathNode {
    const tok = this.peek();
    if (!tok) throw new ParseFault('malformed', 'missing script argument');
    if (tok.kind === 'lbrace') return this.braced();
    if (tok.kind === 'op' && (tok.value === '-' || tok.value === '+')) {
      this.next();
      const arg = this.scriptArgumentInner(multiDigit);
      return { t: 'unary', op: tok.value === '-' ? 'neg' : 'pos', arg };
    }
    if (tok.kind === 'num' && tok.intDigits && tok.intDigits.length > 1 && tok.fracDigits === null && !multiDigit) {
      // `x^23` in LaTeX is `x^{2}3`; read only the first digit as the script.
      throw new ParseFault('malformed', 'ambiguous multi-digit script without braces');
    }
    return this.primary();
  }

  private braced(): MathNode {
    this.expect('lbrace');
    this.enter();
    const body = this.peek()?.kind === 'rbrace' ? null : this.relation();
    this.leave();
    this.expect('rbrace');
    if (!body) throw new ParseFault('malformed', 'empty group');
    return body;
  }

  private primary(): MathNode {
    const tok = this.next();
    switch (tok.kind) {
      case 'num':
        return this.number(tok);
      case 'letter': {
        const node: MathNode = { t: 'var', name: tok.value };
        // O-5: function application when the bracket is attached.
        const after = this.peek();
        if (after?.kind === 'lparen' && !after.spaced && (FUNCTION_LETTERS.has(tok.value) || this.singleSymbolBracket())) {
          const arg = this.primary();
          return { t: 'apply', fn: node, arg };
        }
        return node;
      }
      case 'greek':
        return { t: 'greek', key: tok.value };
      case 'text':
        return { t: 'text', content: tok.value };
      case 'vfrac': {
        // `½` is `\frac{1}{2}`.
        const [num, den] = vulgarFractionParts(tok.value);
        return { t: 'frac', num: digitsNode(num, tok), den: digitsNode(den, tok) };
      }
      case 'func':
        return this.func(tok.value);
      case 'lparen':
      case 'lbrack': {
        const close = tok.kind === 'lparen' ? 'rparen' : 'rbrack';
        this.enter();
        if (this.peek()?.kind === close) throw new ParseFault('malformed', 'empty group');
        let body = this.relation();
        // `P(A|B)`: a single bar inside the bracket separates two parts.
        if (tok.kind === 'lparen' && this.peek()?.kind === 'pipe') {
          this.next();
          body = { t: 'given', left: body, right: this.relation() };
        }
        this.leave();
        // `(1, 2)`, `[2, 5)`: a tuple or an interval, read with its brackets (P9).
        if (this.peek()?.kind === 'comma') return this.listRest(tok.kind === 'lparen' ? '(' : '[', body);
        const end = this.next();
        if (end.kind !== close) throw new ParseFault('malformed', 'unbalanced group');
        const group: MathNode = { t: 'group', kind: tok.kind === 'lparen' ? 'paren' : 'bracket', body };
        // `(5.0 ± 0.1) m`: a unit after a bracketed value belongs to it (P6 item 7).
        if (this.scriptDepth === 0 && hasNumber(body)) {
          const match = this.unitAt(end.end);
          if (match) {
            while (this.pos < this.tokens.length && this.tokens[this.pos]!.start < match.end) this.pos += 1;
            return { t: 'qty', value: group, unit: match.unit };
          }
        }
        return group;
      }
      case 'lbrace': {
        this.pos -= 1;
        const body = this.braced();
        return { t: 'group', kind: 'brace', body };
      }
      case 'pipe': {
        this.enter();
        this.absDepth += 1;
        const body = this.additive();
        this.absDepth -= 1;
        this.leave();
        this.expect('pipe');
        return { t: 'abs', body };
      }
      case 'root': {
        this.enter();
        const body = this.power();
        this.leave();
        const degree = tok.value === 'sqrt' ? null : scriptText(tok.value === 'cbrt' ? '3' : '4');
        return { t: 'root', degree, body };
      }
      case 'cmd':
        return this.command(tok);
      case 'lset':
        return this.list('{', 'rset', '}');
      case 'sym': {
        const special = this.symbolPrimary(tok.value);
        if (special) return special;
        throw new ParseFault('unsupported', `symbol ${tok.value}`);
      }
      case 'comma':
        throw new ParseFault('unsupported', 'list or tuple');
      case 'arrow':
        throw new ParseFault('unsupported', 'arrow');
      default:
        throw new ParseFault('malformed', `unexpected ${tok.kind} '${tok.value}'`);
    }
  }

  /** `∫ ∑ ∏ ∠ △ ∀ ∃ ∅ ∞` written as glyphs (P9). */
  private symbolPrimary(glyph: string): MathNode | null {
    const big = BIG_OPERATORS[glyph];
    if (big) return this.bigOperator(big);
    const prefix = PREFIX_SYMBOLS[glyph];
    if (prefix) return this.prefixSymbol(prefix);
    const atom = ATOM_SYMBOLS[glyph];
    return atom ? { t: 'symbol', glyph: atom } : null;
  }

  /** `\int_a^b f(x)\,dx`, `\sum_{i=1}^{n} i`: limits, then the body (P9). */
  private bigOperator(op: 'int' | 'iint' | 'oint' | 'sum' | 'prod'): MathNode {
    let lower: MathNode | null = null;
    let upper: MathNode | null = null;
    for (;;) {
      const tok = this.peek();
      if (tok?.kind === 'underscore' && lower === null) {
        this.next();
        lower = this.scriptArgument();
      } else if (tok?.kind === 'caret' && upper === null) {
        this.next();
        upper = this.scriptArgument();
      } else if (tok?.kind === 'sub' && lower === null) {
        this.next();
        lower = scriptText(tok.value);
      } else if (tok?.kind === 'sup' && upper === null) {
        this.next();
        upper = scriptText(tok.value);
      } else break;
    }
    this.enter();
    const body = this.product();
    this.leave();
    return { t: 'bigop', op, lower, upper, body };
  }

  /** `∠ABC`, `△ABC`, `∀x`, `∃x`: the symbol applies to the product after it. */
  private prefixSymbol(glyph: '∠' | '△' | '∀' | '∃'): MathNode {
    this.enter();
    const arg = this.product();
    this.leave();
    return { t: 'prefix', glyph, arg };
  }

  /** `\{1, 2\}`: items separated by commas up to `close`. */
  private list(open: string, close: Token['kind'], closeGlyph: string): MathNode {
    this.enter();
    const items: MathNode[] = [];
    if (this.peek()?.kind !== close) {
      items.push(this.relation());
      while (this.peek()?.kind === 'comma') {
        this.next();
        items.push(this.relation());
      }
    }
    this.leave();
    this.expect(close);
    return { t: 'list', open, close: closeGlyph, items };
  }

  /** The rest of `(a, b…)` / `[a, b…)` after its first item; either bracket may close it. */
  private listRest(open: string, first: MathNode): MathNode {
    const items = [first];
    while (this.peek()?.kind === 'comma') {
      this.next();
      items.push(this.relation());
    }
    const end = this.next();
    if (end.kind !== 'rparen' && end.kind !== 'rbrack') throw new ParseFault('malformed', 'unbalanced list');
    return { t: 'list', open, close: end.kind === 'rparen' ? ')' : ']', items };
  }

  /** `(x)`, `(2)`, `(-a)`, `(س)` at the cursor: a bracket holding exactly one symbol. */
  private singleSymbolBracket(): boolean {
    let i = this.pos + 1;
    if (this.tokens[i]?.kind === 'op' && (this.tokens[i]!.value === '-' || this.tokens[i]!.value === '+')) i += 1;
    const inner = this.tokens[i];
    if (!inner || !['letter', 'num', 'greek'].includes(inner.kind)) return false;
    return this.tokens[i + 1]?.kind === 'rparen';
  }

  /** A unit with evidence at `pos` (O-7); an ambiguous one is reported and not taken. */
  private unitAt(pos: number): UnitMatch | null {
    const match = this.options.matchUnit?.(this.src, pos) ?? null;
    if (match?.ambiguous) {
      this.options.onAmbiguousUnit?.(match.unit.source);
      return null;
    }
    return match;
  }

  private number(tok: Token): MathNode {
    let node: MathNode = { t: 'num', tok };
    if (this.options.physics && tok.sciExp) {
      const mantissa: MathNode = {
        t: 'num',
        tok: { ...tok, sciExp: null, sciSign: null, value: tok.value.split(/[eE]/)[0]! },
      };
      const expTok: Token = {
        kind: 'num',
        value: tok.sciExp,
        start: tok.end - tok.sciExp.length,
        end: tok.end,
        intDigits: tok.sciExp,
        fracDigits: null,
        spaced: false,
      };
      const exponent: MathNode =
        tok.sciSign === '-' ? { t: 'unary', op: 'neg', arg: { t: 'num', tok: expTok } } : { t: 'num', tok: expTok };
      node = { t: 'sci', mantissa, exponent };
    }
    if (this.options.matchUnit && this.scriptDepth === 0) {
      const match = this.unitAt(tok.end);
      if (match) {
        while (this.pos < this.tokens.length && this.tokens[this.pos]!.start < match.end) this.pos += 1;
        return { t: 'qty', value: node, unit: match.unit };
      }
    }
    return node;
  }

  private func(name: string): MathNode {
    let power: MathNode | null = null;
    let base: MathNode | null = null;
    for (;;) {
      const tok = this.peek();
      if (tok?.kind === 'caret' && power === null) {
        this.next();
        power = this.scriptArgument();
        continue;
      }
      if (tok?.kind === 'sup' && power === null) {
        this.next();
        power = scriptText(tok.value);
        continue;
      }
      if (tok?.kind === 'underscore' && base === null && name === 'log') {
        this.next();
        base = this.scriptArgument();
        continue;
      }
      if (tok?.kind === 'sub' && base === null && name === 'log') {
        this.next();
        base = scriptText(tok.value);
        continue;
      }
      break;
    }
    this.enter();
    const arg = this.peek()?.kind === 'lparen' ? this.primary() : this.unaryForFunction();
    this.leave();
    return { t: 'func', name, power, base, arg };
  }

  /** `sin 2x` takes `2x`; `sin x + 1` stops before `+`. */
  private unaryForFunction(): MathNode {
    let left = this.unary();
    while (this.binaryOp(this.peek()) === null && this.startsPrimary(this.peek()) && this.peek()?.kind !== 'func') {
      left = { t: 'bin', op: 'juxt', left, right: this.postfix() };
    }
    return left;
  }

  private command(tok: Token): MathNode {
    const name = tok.value;
    if (FRAC_COMMANDS.has(name)) {
      this.enter();
      const num = this.fracArgument();
      const den = this.fracArgument();
      this.leave();
      return { t: 'frac', num, den };
    }
    if (name === 'sqrt') {
      let degree: MathNode | null = null;
      if (this.peek()?.kind === 'lbrack') {
        this.next();
        degree = this.relation();
        this.expect('rbrack');
      }
      this.enter();
      const body = this.peek()?.kind === 'lbrace' ? this.braced() : this.primary();
      this.leave();
      return { t: 'root', degree, body };
    }
    if (name === 'left') {
      // `\left( … \right)` — the delimiter pair is an ordinary group.
      const open = this.peek();
      if (!open) throw new ParseFault('malformed', 'dangling \\left');
      if (open.kind === 'pipe' || (open.kind === 'cmd' && open.value === '|')) {
        this.next();
        this.enter();
        const body = this.additive();
        this.leave();
        this.expectRight();
        return { t: 'abs', body };
      }
      const close = open.kind === 'lparen' ? 'rparen' : open.kind === 'lbrack' ? 'rbrack' : null;
      if (!close) throw new ParseFault('malformed', 'unsupported \\left delimiter');
      this.next();
      this.enter();
      const body = this.relation();
      this.leave();
      this.expectRight();
      return { t: 'group', kind: open.kind === 'lparen' ? 'paren' : 'bracket', body };
    }
    const big = BIG_OPERATORS[name];
    if (big) return this.bigOperator(big);
    const prefix = PREFIX_SYMBOLS[name];
    if (prefix) return this.prefixSymbol(prefix);
    const atom = ATOM_SYMBOLS[name];
    if (atom) return { t: 'symbol', glyph: atom };
    if (name === 'lim') {
      let under: MathNode | null = null;
      if (this.peek()?.kind === 'underscore') {
        this.next();
        under = this.scriptArgument();
      }
      this.enter();
      const body = this.peek()?.kind === 'lparen' ? this.primary() : this.unaryForFunction();
      this.leave();
      return { t: 'lim', under, body };
    }
    const accent = ACCENT_COMMANDS[name];
    if (accent) {
      this.enter();
      const body = this.peek()?.kind === 'lbrace' ? this.braced() : this.primary();
      this.leave();
      return { t: 'accent', accent, body };
    }
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      this.enter();
      const n = this.fracArgument();
      const k = this.fracArgument();
      this.leave();
      return { t: 'binom', n, k };
    }
    if (name === 'vec' || name === 'overrightarrow') {
      if (!this.options.physics) throw new ParseFault('unsupported', `\\${name}`);
      this.enter();
      const body = this.peek()?.kind === 'lbrace' ? this.braced() : this.primary();
      this.leave();
      return { t: 'vec', body };
    }
    if (TRANSPARENT_COMMANDS.has(name)) {
      return this.peek()?.kind === 'lbrace' ? this.braced() : this.primary();
    }
    if (DEFERRED_COMMANDS.has(name)) throw new ParseFault('unsupported', `\\${name}`);
    throw new ParseFault('unknown-command', name);
  }

  private expectRight(): void {
    const right = this.next();
    if (right.kind !== 'cmd' || right.value !== 'right') {
      throw new ParseFault('malformed', 'missing \\right');
    }
    const delim = this.next();
    if (!['rparen', 'rbrack', 'pipe'].includes(delim.kind) && !(delim.kind === 'cmd' && delim.value === '|')) {
      throw new ParseFault('malformed', 'unsupported \\right delimiter');
    }
  }

  /** `\frac{a}{b}` argument, or the single-character form `\frac12`. */
  private fracArgument(): MathNode {
    const tok = this.peek();
    if (!tok) throw new ParseFault('malformed', 'missing fraction argument');
    if (tok.kind === 'lbrace') return this.braced();
    if (tok.kind === 'num' && tok.intDigits && tok.intDigits.length > 1 && tok.fracDigits === null) {
      // `\frac12` → 1 over 2: split the first digit off the number token.
      const first = tok.intDigits[0]!;
      const rest = tok.intDigits.slice(1);
      this.tokens[this.pos] = {
        ...tok,
        value: rest,
        intDigits: rest,
        start: tok.start + 1,
      };
      return {
        t: 'num',
        tok: { ...tok, value: first, intDigits: first, end: tok.start + 1 },
      };
    }
    return this.primary();
  }
}

function isInteger(node: MathNode): boolean {
  return node.t === 'num' && !node.tok.fracDigits && !node.tok.sciExp && Boolean(node.tok.intDigits);
}

/** A fraction of two integers whose numerator is smaller than its denominator. */
function isProperIntegerFraction(node: MathNode): node is Extract<MathNode, { t: 'frac' }> {
  if (node.t !== 'frac') return false;
  const num = node.num.t === 'group' && node.num.kind === 'brace' ? node.num.body : node.num;
  const den = node.den.t === 'group' && node.den.kind === 'brace' ? node.den.body : node.den;
  if (!isInteger(num) || !isInteger(den)) return false;
  const a = Number(toAsciiDigits((num as Extract<MathNode, { t: 'num' }>).tok.intDigits!));
  const b = Number(toAsciiDigits((den as Extract<MathNode, { t: 'num' }>).tok.intDigits!));
  return a > 0 && a < b;
}

function toAsciiDigits(digits: string): string {
  return digits.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function digitsNode(digits: string, at: Token): MathNode {
  return {
    t: 'num',
    tok: { kind: 'num', value: digits, start: at.start, end: at.end, intDigits: digits, fracDigits: null, spaced: false },
  };
}

function isTen(node: MathNode): boolean {
  return node.t === 'num' && node.tok.intDigits === '10' && !node.tok.fracDigits;
}

function hasNumber(node: MathNode): boolean {
  switch (node.t) {
    case 'num':
      return true;
    case 'bin':
      return hasNumber(node.left) || hasNumber(node.right);
    case 'unary':
      return hasNumber(node.arg);
    case 'group':
      return hasNumber(node.body);
    default:
      return false;
  }
}

function isPowerOfTen(node: MathNode): boolean {
  if (node.t === 'sci') return true;
  if (node.t !== 'pow') return false;
  const base = node.base.t === 'group' ? node.base.body : node.base;
  return base.t === 'num' && base.tok.intDigits === '10' && !base.tok.fracDigits;
}

/** A script given as plain text (`²`, `⁻¹`, `₁₂`) → its AST. */
export function scriptText(value: string): MathNode {
  const negative = value.startsWith('-');
  const positive = value.startsWith('+');
  const body = negative || positive ? value.slice(1) : value;
  let node: MathNode;
  if (/^[0-9]+$/.test(body)) {
    node = {
      t: 'num',
      tok: {
        kind: 'num',
        value: body,
        start: 0,
        end: body.length,
        intDigits: body,
        fracDigits: null,
        spaced: false,
      },
    };
  } else if (body === 'n') {
    node = { t: 'var', name: 'n' };
  } else if (body === '') {
    throw new ParseFault('unsupported', 'bare sign script');
  } else {
    throw new ParseFault('malformed', `script ${value}`);
  }
  return negative ? { t: 'unary', op: 'neg', arg: node } : positive ? { t: 'unary', op: 'pos', arg: node } : node;
}

export interface MathParseResult {
  node: MathNode;
  tokens: Token[];
  maxDepth: number;
}

export function parseMath(src: string, options: MathParseOptions = {}): MathParseResult {
  const tokens = tokenize(src, {
    scientificE: options.physics === true,
    arabicLetters: options.arabicLetters === true,
  });
  if (tokens.length > MAX_EXPRESSION_TOKENS) throw new ParseFault('bound', 'token count');
  const parser = new Parser(src, tokens, options);
  const node = parser.parse();
  return { node, tokens, maxDepth: parser.maxDepth };
}
