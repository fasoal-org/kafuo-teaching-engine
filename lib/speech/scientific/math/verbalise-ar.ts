/**
 * Arabic verbaliser for the Mathematics (and inherited Physics) AST, in the
 * `natural` and `accessible` modes (plan §10.1 table). One AST, two readings:
 * both walk the same nodes and emit the same semantic tokens, which is what
 * makes FR-019 structural. Wordings come from the policy pack only.
 */
import { integerValue, writeNumber } from '../numbers/read';
import { isArabicLetter, isDigit, isLatinLetter } from '../normalise';
import { label, labelOrNull, speak, type VerbaliseContext, Writer } from '../writer';
import { isElementSymbol } from '../chemistry/elements';
import { isEnglishText } from '../literal';
import type { MathNode, UnitNode } from './parse';
import { greekGlyphForKey } from './tokenize';

export interface MathVerbaliseContext extends VerbaliseContext {
  /** Physics: speaks a unit expression (see `physics/verbalise-ar.ts`). */
  writeUnit?: (unit: UnitNode, w: Writer) => void;
}

const OP_KEYS: Readonly<Record<string, string>> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '·': '·',
  '÷': '÷',
  '±': '±',
  '∓': '∓',
};

/**
 * Literal forms spoken when an operator entry is unusable (production before
 * curriculum approval). The AST normalises `× * \times` to `*`, written with
 * its display glyph; `· ⋅ \cdot` stay `·` (O-8).
 */
const OP_SYMBOLS: Readonly<Record<string, string>> = {
  '*': '×',
  '·': '·',
};

const BIGOP_LABELS = { int: 'integral', iint: 'double-integral', oint: 'contour-integral', sum: 'sum', prod: 'product' } as const;
const BIGOP_GLYPHS = { int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏' } as const;
const ACCENT_LABELS = { bar: 'bar', hat: 'hat', dot: 'dot-accent', ddot: 'double-dot-accent', tilde: 'tilde' } as const;
const ACCENT_GLYPHS = { bar: '¯', hat: '^', dot: '˙', ddot: '¨', tilde: '~' } as const;
/** The closing word of a written bracket (`symbol` entries). */
const CLOSING: Readonly<Record<string, string>> = { ')': ')', ']': ']', '}': '}' };

function isAtomic(node: MathNode): boolean {
  switch (node.t) {
    case 'num':
    case 'var':
    case 'greek':
    case 'text':
    case 'symbol':
      return true;
    case 'sub':
      return isAtomic(node.base) && isAtomic(node.index);
    default:
      return false;
  }
}

/**
 * A term a teacher reads as one unit: a symbol, a symbol with a one-word
 * script (`x²`, `x_1`), or an implicit product of those (`dy`, `2x`, `mv²`).
 */
function isTerm(node: MathNode): boolean {
  const n = unbrace(node);
  if (isAtomic(n)) return true;
  if (n.t === 'pow' || n.t === 'sub') {
    const script = unbrace(n.t === 'pow' ? n.exp : n.index);
    const simpleScript =
      script.t === 'num' || script.t === 'var' || script.t === 'greek' || (script.t === 'unary' && script.arg.t === 'num');
    return isAtomic(unbrace(n.base)) && simpleScript;
  }
  return n.t === 'bin' && n.op === 'juxt' && isTerm(n.left) && isTerm(n.right);
}

/** Unwraps invisible `{…}` groups. */
function unbrace(node: MathNode): MathNode {
  return node.t === 'group' && node.kind === 'brace' ? unbrace(node.body) : node;
}

function isAdditive(node: MathNode): boolean {
  const n = unbrace(node);
  return n.t === 'bin' && (n.op === '+' || n.op === '-' || n.op === '±' || n.op === '∓');
}

/** True when the node is spoken starting with a bracketed factor (`(a−b)²`). */
function startsWithGroup(node: MathNode): boolean {
  const n = unbrace(node);
  if (n.t === 'group') return n.kind !== 'brace';
  if (n.t === 'pow' || n.t === 'sub') return startsWithGroup(n.base);
  return false;
}

/** `x²`, `x_1`, `\frac{1}{2}`-like operands whose first word is only part of them. */
function startsWithScriptedAtom(node: MathNode): boolean {
  const n = unbrace(node);
  return (n.t === 'pow' || n.t === 'sub') && isAtomic(unbrace(n.base));
}

function isLowPrecedence(node: MathNode): boolean {
  const n = unbrace(node);
  return isAdditive(n) || n.t === 'rel' || n.t === 'ratio';
}

export class MathVerbaliser {
  /**
   * Inside a general chemical formula (`C_nH_{2n+2}`), a subscript is an atom
   * count, never «تحت» (DEC-053).
   */
  private inFormula = false;

  constructor(private readonly ctx: MathVerbaliseContext) {}

  write(node: MathNode, w: Writer): void {
    this.node(node, w);
  }

  private get accessible(): boolean {
    return this.ctx.mode === 'accessible';
  }

  private op(key: string, fallback: string): string {
    return label(this.ctx, key, fallback);
  }

  /** A variable, resolved by role and subject: `x` → «سين» (MATH), «إكس» (PHYSICS). */
  letter(name: string, w: Writer): void {
    w.sem('var', name);
    w.word(speak(this.ctx, 'variable', name, name));
  }

  private node(node: MathNode, w: Writer): void {
    switch (node.t) {
      case 'num':
        writeNumber(this.ctx, w, node.tok);
        return;
      case 'var':
        this.letter(node.name, w);
        return;
      case 'greek':
        w.sem('greek', node.key);
        w.word(speak(this.ctx, 'greek', node.key, greekGlyphForKey(node.key) ?? node.key));
        return;
      case 'text':
        this.text(node.content, w);
        return;
      case 'group':
        this.group(node, w, node.kind !== 'brace' && this.accessible);
        return;
      case 'abs':
        this.abs(node.body, w);
        return;
      case 'frac':
        this.frac(node.num, node.den, w);
        return;
      case 'pow':
        this.pow(node.base, node.exp, w);
        return;
      case 'sub':
        this.sub(node.base, node.index, w);
        return;
      case 'root':
        this.root(node.degree, node.body, w);
        return;
      case 'func':
        this.func(node, w);
        return;
      case 'apply':
        w.sem('apply');
        this.node(node.fn, w);
        this.argument(node.arg, w, 'function-of');
        return;
      case 'unary':
        this.unary(node, w);
        return;
      case 'bin':
        this.bin(node, w);
        return;
      case 'mixed':
        // `2⅓` → «2 وثلث» (P4 item 2): never a product.
        w.sem('mixed');
        this.node(node.whole, w);
        w.prefix(label(this.ctx, 'and', '+'));
        this.frac(node.frac.num, node.frac.den, w);
        return;
      case 'factorial':
        this.operand(node.arg, w, true);
        w.sem('!');
        w.word(label(this.ctx, 'factorial', '!'));
        return;
      case 'bigop':
        this.bigop(node, w);
        return;
      case 'lim':
        // `\lim_{x \to 0} f(x)` → «نهاية إف لسين، عندما سين تقترب من 0» (P9).
        w.sem('lim');
        w.word(label(this.ctx, 'lim', 'lim'));
        this.node(node.body, w);
        if (node.under) {
          w.pause();
          w.boundary(label(this.ctx, 'when', '_'));
          this.node(node.under, w);
        }
        return;
      case 'list':
        // A tuple, an interval or a set: its written brackets, never a meaning (P9).
        w.sem('list', `${node.open}${node.close}`);
        w.word(speak(this.ctx, 'symbol', node.open, node.open));
        node.items.forEach((item, i) => {
          if (i > 0) w.pause();
          else if (this.accessible) w.pause();
          this.node(item, w);
        });
        w.pause();
        w.boundary(speak(this.ctx, 'symbol', CLOSING[node.close] ?? node.close, node.close));
        return;
      case 'accent':
        // `x̄` → «سين بار», `\hat{i}` → «آي هات» (P9): the notation, no meaning.
        this.operand(node.body, w, true);
        w.sem('accent', node.accent);
        w.word(label(this.ctx, ACCENT_LABELS[node.accent], ACCENT_GLYPHS[node.accent]));
        return;
      case 'binom':
        w.sem('binom');
        w.word(label(this.ctx, 'binom', 'C'));
        this.node(node.n, w);
        w.pause();
        this.node(node.k, w);
        return;
      case 'prefix':
        w.sem('prefix', node.glyph);
        w.word(this.op(node.glyph, node.glyph));
        this.node(node.arg, w);
        return;
      case 'symbol':
        w.sem('sym', node.glyph);
        w.word(speak(this.ctx, 'symbol', node.glyph, node.glyph));
        return;
      case 'given':
        // `P(A|B)`: the bar is read by its name (P4 item 6).
        w.sem('given');
        this.node(node.left, w);
        w.boundary(label(this.ctx, 'given', '|'));
        this.node(node.right, w);
        return;
      case 'rel':
        this.rel(node, w);
        return;
      case 'percent':
        this.operand(node.arg, w, true);
        w.sem('%');
        w.word(this.op('%', '%'));
        return;
      case 'degree':
        this.operand(node.arg, w, true);
        w.sem('deg');
        w.word(this.op('°', '°'));
        return;
      case 'ratio':
        w.sem('ratio');
        if (this.accessible) w.word(label(this.ctx, 'ratio'));
        this.operand(node.left, w, true);
        // The accessible entry holds the label; the connective is always the natural word.
        w.boundary(
          this.ctx.policy.resolve({ role: 'label', token: 'ratio', domain: this.ctx.domain }, 'natural')?.text ?? ':',
        );
        this.operand(node.right, w, true);
        return;
      case 'vec':
        w.sem('vec');
        // Literal form: the vector arrow glyph, never the command name (P3).
        w.word(label(this.ctx, 'vector', '→'));
        this.node(node.body, w);
        if (this.accessible) {
          w.pause();
          w.word(label(this.ctx, 'vector-arrow'));
        }
        return;
      case 'sci':
        w.sem('sci');
        this.node(node.mantissa, w);
        w.word(this.op('*', '×'));
        w.sem('num', '10');
        w.word('10');
        // Scientific notation always says «أُس» (never «تربيع»/«تكعيب»).
        this.powerSuffix(node.exponent, w, true);
        return;
      case 'qty':
        w.sem('qty');
        // `(5.0 ± 0.1) m`: the bracketed value is spoken as one quantity.
        if (node.value.t === 'group') this.group(node.value, w, true);
        else this.node(node.value, w);
        if (this.ctx.writeUnit) this.ctx.writeUnit(node.unit, w);
        else w.word(node.unit.source);
        return;
    }
  }

  /** `\text{…}`: Arabic content is prose; anything else is read symbol by symbol. */
  private text(content: string, w: Writer): void {
    const trimmed = content.trim();
    if (!trimmed) return;
    if ([...trimmed].some((ch) => isArabicLetter(ch))) {
      w.sem('text');
      w.word(trimmed);
      return;
    }
    // An English word is prose, never spelled letter by letter (P3).
    if (isEnglishText(trimmed)) {
      this.ctx.warn('SATTS_W_UNSUPPORTED_NOTATION', 'english-word');
      w.sem('text');
      w.word(trimmed);
      return;
    }
    for (const ch of trimmed) {
      if (isLatinLetter(ch)) this.letter(ch, w);
      else if (isDigit(ch)) {
        w.sem('num', ch);
        w.word(ch);
      } else if (ch.trim()) {
        w.sem('sym', ch);
        w.word(speak(this.ctx, 'symbol', ch, ch));
      }
    }
  }

  /** Writes `node` as an operand, grouping it when precedence requires it. */
  private operand(node: MathNode, w: Writer, needsGrouping: boolean): void {
    const n = unbrace(node);
    if (needsGrouping && (isLowPrecedence(n) || (n.t === 'group' && isLowPrecedence(n.body)))) {
      this.group({ t: 'group', kind: 'paren', body: n.t === 'group' ? n.body : n }, w, true);
      return;
    }
    this.node(node, w);
  }

  /**
   * A grouped sub-expression. Accessible mode always names the brackets.
   * Natural mode speaks the grouping only when `force` (precedence needs it).
   */
  private group(
    node: Extract<MathNode, { t: 'group' }>,
    w: Writer,
    force: boolean,
  ): void {
    if (node.kind === 'brace' && !force) {
      this.node(unbrace(node.body), w);
      return;
    }
    w.beginScope('group');
    w.endScope('group', this.groupBody(node, w, force), () => label(this.ctx, 'close-paren'));
  }

  /** Speaks a group; returns whether its end is audible. */
  private groupBody(node: Extract<MathNode, { t: 'group' }>, w: Writer, force: boolean): boolean {
    const body = unbrace(node.body);
    if (this.accessible && (force || node.kind !== 'brace')) {
      const open = labelOrNull(this.ctx, 'open-paren');
      if (open === null) {
        this.parens(body, w);
        return true;
      }
      w.word(open);
      w.pause();
      this.node(body, w);
      w.pause();
      w.boundary(label(this.ctx, 'close-paren', ')'));
      return true;
    }
    if (!force) {
      // A silent group: precedence alone keeps its reading unambiguous.
      this.node(body, w);
      return true;
    }
    // Natural: «مجموع أ وب» / «الفرق بين أ وب» for a simple sum/difference,
    // otherwise «المقدار …،». The sum/difference words carry the operator, so
    // they are used only when both entries are usable (FR-030).
    if (body.t === 'bin' && (body.op === '+' || body.op === '-') && isAtomic(body.left) && isAtomic(body.right)) {
      const lead = labelOrNull(this.ctx, body.op === '+' ? 'sum-of' : 'difference-of');
      const and = lead === null ? null : labelOrNull(this.ctx, 'and');
      if (lead !== null && and !== null) {
        w.sem(body.op);
        w.word(lead);
        this.node(body.left, w);
        w.prefix(and);
        this.node(body.right, w);
        return false;
      }
    }
    const quantity = labelOrNull(this.ctx, 'quantity');
    if (quantity === null) {
      this.parens(body, w);
      return true;
    }
    w.word(quantity);
    this.node(body, w);
    w.pause();
    return true;
  }

  /** The natural reading of a bracket it does not speak: scope tokens only (mode parity). */
  private silentGroup(body: MathNode, w: Writer): void {
    w.beginScope('group');
    this.node(body, w);
    w.endScope('group', true);
  }

  /** Literal grouping `(…)`: the form spoken when a grouping label is unusable. */
  private parens(body: MathNode, w: Writer): void {
    w.prefix('(');
    this.node(body, w);
    w.suffix(')');
  }

  /**
   * «لـ‹x›» for an atomic argument, «للمقدار …،» otherwise. Returns whether
   * the argument's end is audible.
   */
  private argument(arg: MathNode, w: Writer, ofKey: 'of' | 'function-of'): boolean {
    const a = unbrace(arg);
    const inner = a.t === 'group' ? unbrace(a.body) : a;
    if (this.accessible && a.t === 'group') {
      this.group(a, w, true);
      return true;
    }
    const traced = a.t === 'group' && a.kind !== 'brace';
    if (traced) w.beginScope('group');
    const closed = this.argumentBody(inner, w, ofKey);
    if (traced) w.endScope('group', true);
    return closed;
  }

  private argumentBody(inner: MathNode, w: Writer, ofKey: 'of' | 'function-of'): boolean {
    if (isAtomic(inner)) {
      const of = labelOrNull(this.ctx, ofKey);
      // Literal `f(x)`: the application keeps its brackets.
      if (of === null && ofKey === 'function-of') {
        this.parens(inner, w);
        return true;
      }
      w.prefix(of ?? '');
      this.node(inner, w);
      return false;
    }
    const ofQuantity = labelOrNull(this.ctx, 'of-quantity');
    if (ofQuantity === null) {
      this.parens(inner, w);
      return true;
    }
    w.word(ofQuantity);
    this.node(inner, w);
    w.pause();
    return true;
  }

  private abs(body: MathNode, w: Writer): void {
    w.sem('abs');
    w.beginScope('abs');
    w.endScope('abs', this.absBody(body, w), () => label(this.ctx, 'abs-end'));
  }

  private absBody(body: MathNode, w: Writer): boolean {
    const abs = labelOrNull(this.ctx, 'abs');
    if (abs === null) {
      // Literal `|x|`.
      w.prefix('|');
      this.node(unbrace(body), w);
      w.suffix('|');
      return true;
    }
    w.word(abs);
    if (this.accessible) {
      w.pause();
      w.word(label(this.ctx, 'abs-inside'));
      this.node(body, w);
      w.pause();
      w.boundary(label(this.ctx, 'abs-end'));
      return true;
    }
    return this.argument(body, w, 'of');
  }

  private frac(num: MathNode, den: MathNode, w: Writer): void {
    w.sem('frac');
    w.beginScope('frac');
    w.endScope('frac', this.fracBody(num, den, w), () => label(this.ctx, 'fraction-end'));
  }

  /** Speaks a fraction; returns whether its end is audible. */
  private fracBody(num: MathNode, den: MathNode, w: Writer): boolean {
    const n = unbrace(num);
    const d = unbrace(den);
    // A school fraction (`½`, `\frac{2}{3}`): «نصف» in natural mode; in
    // accessible mode its parts are read as number words (P4 item 9: the
    // structure lives here, not in the dictionary sentence).
    let schoolFraction = false;
    if (n.t === 'num' && d.t === 'num') {
      const a = integerValue(n.tok);
      const b = integerValue(d.tok);
      if (a !== null && b !== null) {
        const found = this.ctx.policy.resolve(
          { role: 'fraction', token: `${a}/${b}`, domain: this.ctx.domain },
          'natural',
        );
        if (found && !this.accessible) {
          if (found.proposed) this.ctx.noteProposed();
          w.sem('num', String(a)).sem('num', String(b));
          w.word(found.text);
          return true;
        }
        schoolFraction = found !== null;
      }
    }
    const simple = isAtomic(n) && isAtomic(d);
    const part = (x: MathNode) => {
      if (schoolFraction && x.t === 'num') writeNumber(this.ctx, w, x.tok, true);
      else this.node(x, w);
    };
    if (this.accessible) {
      const fraction = labelOrNull(this.ctx, 'fraction');
      if (fraction === null) return this.literalFraction(n, d, w);
      w.word(fraction);
      w.pause();
      w.word(label(this.ctx, 'numerator'));
      if (!simple) w.colon();
      part(n);
      w.pause();
      if (!simple) {
        w.boundary(label(this.ctx, 'numerator-end'));
        w.pause();
      }
      w.boundary(label(this.ctx, 'denominator'));
      if (!simple) w.colon();
      part(d);
      if (!simple) {
        w.pause();
        w.boundary(label(this.ctx, 'denominator-end'));
        return true;
      }
      return false;
    }
    // A term on each side (`dy/dx`, `a/bc`, `x²/y`): «دال صاد على دال سين»,
    // as a teacher reads it (P4 item 1, O-6).
    if (simple || (isTerm(n) && isTerm(d))) {
      this.node(n, w);
      w.word(this.op('/', '/'));
      this.node(d, w);
      return false;
    }
    // O-6 (P5): a compound numerator ends with «، الكل على»; a compound
    // denominator is announced by «المقدار» and closed by a pause.
    const all = labelOrNull(this.ctx, 'whole');
    const quantity = all === null ? null : labelOrNull(this.ctx, 'quantity');
    if (all !== null && quantity !== null) {
      this.node(n, w);
      if (!isTerm(n)) {
        w.pause();
        w.boundary(all);
      }
      w.word(this.op('/', '/'));
      if (isTerm(d)) {
        this.node(d, w);
        return false;
      }
      w.word(quantity);
      this.node(d, w);
      w.pause();
      return true;
    }
    const fraction = labelOrNull(this.ctx, 'fraction');
    if (fraction === null) return this.literalFraction(n, d, w);
    w.word(fraction);
    w.colon();
    this.node(n, w);
    w.pause();
    w.word(this.op('/', '/'));
    w.pause();
    this.node(d, w);
    w.pause();
    return true;
  }

  /** Literal `(n) / (d)`: the form spoken when the fraction label is unusable. */
  private literalFraction(n: MathNode, d: MathNode, w: Writer): boolean {
    const side = (x: MathNode) => (isAtomic(x) ? this.node(x, w) : this.parens(x, w));
    side(n);
    w.word(this.op('/', '/'));
    side(d);
    // A symbol reading needs no spoken scope end.
    return true;
  }

  private pow(base: MathNode, exp: MathNode, w: Writer): void {
    const b = unbrace(base);
    w.beginScope('pow');
    if (isAtomic(b) || b.t === 'func') this.node(b, w);
    else if (!this.accessible && this.wholePowerBase(b, w)) {
      // O-6: «سين زائد واحد، الكل تربيع».
    } else if (b.t === 'group') this.group(b, w, true);
    else this.group({ t: 'group', kind: 'paren', body: b }, w, true);
    w.endScope('pow', this.powerSuffix(exp, w), () => label(this.ctx, 'power-end'));
  }

  /**
   * Natural mode (O-6): a compound base is read plainly, then «، الكل» before
   * its power. Returns `false` when the label is unusable (literal brackets).
   */
  private wholePowerBase(base: MathNode, w: Writer): boolean {
    const body = base.t === 'group' ? unbrace(base.body) : base;
    const all = isAtomic(body) ? '' : labelOrNull(this.ctx, 'whole');
    if (all === null) return false;
    // After an operator (`3(a−b)²`, `x + (a+b)²`) «المقدار» marks where «الكل» starts.
    const opening = all && w.afterOperator ? labelOrNull(this.ctx, 'quantity') : null;
    w.beginScope('group');
    if (opening) w.word(opening);
    this.node(body, w);
    w.endScope('group', true);
    if (all) {
      w.pause();
      w.boundary(all);
    }
    return true;
  }

  /**
   * «تربيع» / «تكعيب» / «أُس ‹n›» (natural); «مرفوعة للقوة …» (accessible).
   * Returns whether the exponent's end is audible.
   */
  private powerSuffix(exp: MathNode, w: Writer, plain = false): boolean {
    const e = unbrace(exp);
    w.sem('pow');
    const whole = e.t === 'num' ? integerValue(e.tok) : null;
    if (!plain && !this.accessible && (whole === 2 || whole === 3) && e.t === 'num') {
      const word = labelOrNull(this.ctx, whole === 2 ? 'squared' : 'cubed');
      if (word !== null) {
        w.sem('num', String(whole));
        w.word(word);
        return true;
      }
      // Unusable «تربيع»/«تكعيب»: the general power reading below.
    }
    const simple =
      e.t === 'num' ||
      e.t === 'var' ||
      e.t === 'greek' ||
      (e.t === 'unary' && (e.arg.t === 'num' || e.arg.t === 'var'));
    const power = labelOrNull(this.ctx, 'power');
    if (power === null) {
      // Literal `^n` / `^(n + 1)`: the script is never dropped (FR-030). A
      // symbol reading needs no spoken scope end.
      w.word('^');
      if (simple) this.scriptValue(e, w);
      else this.parens(e, w);
      return true;
    }
    w.word(power);
    if (simple) {
      this.scriptValue(e, w);
      return false;
    }
    if (this.accessible) w.colon();
    else w.pause();
    this.node(e, w);
    w.pause();
    if (this.accessible) w.boundary(label(this.ctx, 'power-end'));
    return true;
  }

  /** A script value: small integers are words, the rest read normally. */
  private scriptValue(node: MathNode, w: Writer): void {
    if (node.t === 'num') {
      writeNumber(this.ctx, w, node.tok, true);
      return;
    }
    if (node.t === 'unary' && node.arg.t === 'num') {
      w.sem(node.op === 'neg' ? 'neg' : node.op);
      w.word(this.op(node.op, node.op === 'neg' ? '-' : node.op === 'pos' ? '+' : node.op));
      writeNumber(this.ctx, w, node.arg.tok, true);
      return;
    }
    this.node(node, w);
  }

  private sub(base: MathNode, index: MathNode, w: Writer): void {
    w.beginScope('sub');
    this.subBody(base, index, w);
    const i = unbrace(index);
    // A number index ends on its own; a letter index runs into the next symbol (`k_B T`).
    const numeric = i.t === 'num' || (i.t === 'unary' && i.arg.t === 'num');
    w.endScope('sub', numeric, () => label(this.ctx, 'index-end'));
  }

  /**
   * A letter subscript in Physics or Chemistry is part of a symbol's identity
   * (`k_B`, `E_k`, `K_c`): natural mode says «تحت» so it is not heard as a
   * product (DEC-053). A number index (`v_0`, `m_1`), every Math index
   * (`a_n`, `x_i`) and a Chemistry count (`C_nH_{2n+2}`, `(CH_2)_n`) keep the
   * positional reading («ڤي صفر», «ألف نون», «سي إن»).
   */
  private identitySubscript(base: MathNode, index: MathNode): boolean {
    const domain = this.ctx.domain;
    if (this.accessible || this.inFormula || (domain !== 'PHYSICS' && domain !== 'CHEMISTRY')) return false;
    const b = unbrace(base);
    if (b.t !== 'var' && b.t !== 'greek') return false;
    const i = unbrace(index);
    return !(i.t === 'num' || (i.t === 'unary' && i.arg.t === 'num'));
  }

  /** Does `node` end with an identity subscript (`k_B`, `2 k_B`)? */
  private endsWithIdentitySub(node: MathNode): boolean {
    const n = unbrace(node);
    if (n.t === 'sub') return this.identitySubscript(n.base, n.index);
    return n.t === 'bin' && n.op === 'juxt' && this.endsWithIdentitySub(n.right);
  }

  /** Element symbols side by side (`C_nH_{2n+2}`): a general chemical formula. */
  private isFormulaChain(node: MathNode): boolean {
    if (this.ctx.domain !== 'CHEMISTRY') return false;
    const factors: MathNode[] = [];
    const collect = (n: MathNode): void => {
      const u = unbrace(n);
      if (u.t === 'bin' && u.op === 'juxt') {
        collect(u.left);
        collect(u.right);
      } else factors.push(u);
    };
    collect(node);
    return (
      factors.length > 1 &&
      factors.every((f) => {
        const b = f.t === 'sub' ? unbrace(f.base) : f;
        return b.t === 'var' && isElementSymbol(b.name);
      })
    );
  }

  private subBody(base: MathNode, index: MathNode, w: Writer): void {
    this.node(base, w);
    w.sem('sub');
    const under = this.identitySubscript(base, index) ? labelOrNull(this.ctx, 'subscript') : null;
    if (under !== null) w.word(under);
    else if (this.accessible) w.word(label(this.ctx, 'index', '_'));
    else if (this.ctx.policy.resolve({ role: 'label', token: 'index', domain: this.ctx.domain }, 'natural') === null) {
      // Natural reading marks the subscript by position only («سين واحد»); that
      // convention is itself a policy entry. Without it, the literal `_` keeps
      // `x_1` distinct from the product `x 1` (FR-030).
      this.ctx.warn('SATTS_W_MISSING_DICTIONARY_ENTRY', 'label:index');
      w.word('_');
    }
    const i = unbrace(index);
    if (isAtomic(i) || i.t === 'unary') this.scriptValue(i, w);
    else {
      // «تحت» already marks where a compound index starts: «ڤي تحت إم إيه إكس».
      if (under === null) w.pause();
      this.node(i, w);
      w.pause();
    }
  }

  private root(degree: MathNode | null, body: MathNode, w: Writer): void {
    const d = degree ? unbrace(degree) : null;
    const value = d?.t === 'num' ? integerValue(d.tok) : null;
    w.sem('root', value === null && d === null ? '2' : String(value ?? '?'));
    w.beginScope('root');
    if (!d || value === 2) w.word(label(this.ctx, 'sqrt', '√'));
    else if (value === 3) w.word(label(this.ctx, 'cbrt', '∛'));
    else {
      const nroot = labelOrNull(this.ctx, 'nroot');
      if (nroot === null && value === 4) w.word('∜');
      else {
        // Literal `√ n x`, as the literal fallback reads `\sqrt[n]{x}`.
        w.word(nroot ?? '√');
        this.scriptValue(d, w);
      }
    }
    if (this.accessible) {
      const inside = labelOrNull(this.ctx, 'root-inside');
      if (inside === null) {
        this.parens(unbrace(body), w);
        w.endScope('root', true);
        return;
      }
      w.pause();
      w.word(inside);
      w.colon();
      this.node(unbrace(body), w);
      w.pause();
      w.boundary(label(this.ctx, 'root-end'));
      w.endScope('root', true);
      return;
    }
    w.endScope('root', this.argument(body, w, 'of'), () => label(this.ctx, 'root-end'));
  }

  private func(node: Extract<MathNode, { t: 'func' }>, w: Writer): void {
    w.sem('func', node.name);
    w.word(speak(this.ctx, 'function', node.name, node.name));
    if (node.base) {
      w.sem('log-base');
      w.word(label(this.ctx, 'log-base', '_'));
      this.scriptValue(unbrace(node.base), w);
    }
    if (node.power) this.powerSuffix(node.power, w);
    const arg = unbrace(node.arg);
    if (arg.t === 'group') {
      if (isAtomic(unbrace(arg.body)) && !this.accessible) this.silentGroup(unbrace(arg.body), w);
      else this.group(arg, w, true);
      return;
    }
    this.node(arg, w);
  }

  /** `\int_a^b …` → «تكامل من ألف إلى باء، …» (P9). */
  private bigop(node: Extract<MathNode, { t: 'bigop' }>, w: Writer): void {
    w.sem('bigop', node.op);
    w.beginScope('bigop');
    w.word(label(this.ctx, BIGOP_LABELS[node.op], BIGOP_GLYPHS[node.op]));
    if (node.lower) {
      w.word(label(this.ctx, 'from', '_'));
      this.node(node.lower, w);
    }
    if (node.upper) {
      w.boundary(label(this.ctx, 'to', '^'));
      this.node(node.upper, w);
    }
    if (node.lower || node.upper) w.pause();
    this.node(node.body, w);
    w.endScope('bigop', false, () => label(this.ctx, 'bigop-end'));
  }

  private unary(node: Extract<MathNode, { t: 'unary' }>, w: Writer): void {
    w.sem(node.op === 'neg' ? 'neg' : node.op === 'pos' ? 'pos' : node.op);
    w.word(this.op(node.op, node.op === 'neg' ? '-' : node.op === 'pos' ? '+' : node.op));
    // `-x²`: whether the sign covers `x` or `x²` is not audible without a pause.
    if (!this.accessible && startsWithScriptedAtom(node.arg)) w.markAmbiguousStart('sign');
    this.operand(node.arg, w, true);
  }

  private bin(node: Extract<MathNode, { t: 'bin' }>, w: Writer): void {
    if (node.op === '/') {
      this.frac(node.left, node.right, w);
      return;
    }
    if (node.op === 'juxt') {
      const outer = this.inFormula;
      this.inFormula ||= this.isFormulaChain(node);
      w.sem('*');
      this.operand(node.left, w, true);
      if (this.endsWithIdentitySub(node.left)) {
        // `k_B T` → «كيه تحت بي في تي»: «في» ends the subscript audibly (DEC-053).
        w.boundary(this.op('*', '×'));
      } else if (startsWithGroup(node.right)) {
        // `2(x+1)`: the implicit product is spoken before a bracketed factor.
        w.operator(this.op('*', '×'));
      }
      this.operand(node.right, w, true);
      this.inFormula = outer;
      return;
    }
    w.sem(node.op);
    const multiplicative = node.op === '*' || node.op === '·' || node.op === '÷';
    this.operand(node.left, w, multiplicative);
    w.operator(this.op(OP_KEYS[node.op] ?? node.op, OP_SYMBOLS[node.op] ?? node.op));
    // The right operand of `-` also needs grouping: a − (b + c).
    this.operand(node.right, w, multiplicative || node.op === '-');
  }

  private rel(node: Extract<MathNode, { t: 'rel' }>, w: Writer): void {
    node.items.forEach((item, i) => {
      if (i > 0) {
        const op = node.ops[i - 1]!;
        w.sem('rel', op);
        if (this.accessible) w.pause();
        // A relation never sits inside a fraction, power or root: it closes them.
        w.boundary(this.op(op, op));
        if (this.accessible) w.pause();
      }
      this.node(item, w);
    });
  }
}

export function verbaliseMath(node: MathNode, ctx: MathVerbaliseContext): Writer {
  const natural = ctx.mode === 'natural';
  const w = new Writer({ pauseClosesScope: natural, speakScopeEnds: !natural, pauseEndsScope: natural });
  new MathVerbaliser(ctx).write(node, w);
  return w;
}
