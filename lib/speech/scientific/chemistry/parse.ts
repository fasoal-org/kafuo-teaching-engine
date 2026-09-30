/**
 * Chemistry grammar V1 (plan §10.3) — a separate grammar, never delegated to
 * Mathematics. Character-level, linear, bounded. Element symbols are validated
 * case-sensitively against the 118-element table; case is never corrected.
 *
 *   reaction := side (ARROW side)*
 *   side     := term ('+' term)*
 *   term     := COEFF? species STATE? MARK?        MARK: ↑ (gas), ↓ (precipitate)
 *   species  := formula CHARGE? | electron
 *   formula  := unit+ ('·' COEFF? unit+)*          ASCII `.` is also a hydrate dot (P7)
 *   unit     := ELEMENT COUNT? | '(' unit+ ')' COUNT? | '[' unit+ ']' COUNT? | BOND
 *   BOND     := '-' | '=' | '≡' | '#'  between two units, with no spaces (O-9)
 */
import { isElementSymbol } from './elements';
import { subscriptValue, superscriptValue } from '../math/tokenize';

export interface ChemCount {
  value: number;
  /** Written as plain ASCII digits (`B12`), not `₁₂` or `_{12}`. */
  ascii?: boolean;
}

export type BondOrder = '-' | '=' | '≡';

export type FormulaUnit =
  | { t: 'el'; symbol: string; count: ChemCount | null }
  | { t: 'group'; bracket: '(' | '['; units: FormulaUnit[]; count: ChemCount | null }
  /** O-9: a structural bond between two units, read by its neutral symbol name. */
  | { t: 'bond'; order: BondOrder };

export interface Charge {
  sign: '+' | '-';
  magnitude: number;
  /** Written as ASCII digits then a sign (`Fe3+`, `SO42-`): read by convention, flagged for review. */
  ascii?: boolean;
}

export interface Hydrate {
  coeff: ChemCount | null;
  units: FormulaUnit[];
}

/** P9: a nuclide's mass number (and atomic number): `¹⁴C`, `^{235}_{92}U`, `C-14`. */
export interface Isotope {
  mass: number;
  atomic: number | null;
}

export type Species =
  | { t: 'formula'; units: FormulaUnit[]; hydrates: Hydrate[]; charge: Charge | null; isotope?: Isotope }
  | { t: 'electron' }
  /** P9: `[H⁺]` — a species in written square brackets, read with its brackets. */
  | { t: 'bracketed'; inner: Species };

export type Coefficient =
  | { kind: 'int'; value: number }
  | { kind: 'frac'; num: number; den: number }
  /** `0.5H₂O` (P7 item 6): digits as authored. */
  | { kind: 'decimal'; intDigits: string; fracDigits: string };

export type ChemState = 's' | 'l' | 'g' | 'aq';

export interface Term {
  coeff: Coefficient | null;
  species: Species;
  state: ChemState | null;
  /** `↑` / `↓` after a species (P7 item 3), read by its glyph name only. */
  mark?: '↑' | '↓';
}

export type ChemArrow = '→' | '←' | '⇌' | '↔';

/** P9 (O-10): text written over / under a reaction arrow, read neutrally. */
export interface ArrowCondition {
  above: string | null;
  below: string | null;
}

export interface Reaction {
  sides: Term[][];
  arrows: ChemArrow[];
  /** One per arrow; `null` when the arrow has no condition. */
  conditions?: Array<ArrowCondition | null>;
}

export type ChemFaultKind = 'malformed' | 'unknown-element' | 'unsupported';

export class ChemFault extends Error {
  constructor(
    public readonly kind: ChemFaultKind,
    public readonly detail: string,
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'ChemFault';
  }
}

const ARROWS: ReadonlyArray<[string, ChemArrow]> = [
  ['<=>', '⇌'],
  ['<->', '↔'],
  ['⇌', '⇌'],
  ['⇄', '⇌'],
  ['⇋', '⇌'],
  ['\\rightleftharpoons', '⇌'],
  ['\\leftrightharpoons', '⇌'],
  ['\\rightleftarrows', '⇌'],
  ['↔', '↔'],
  ['\\xrightarrow', '→'],
  ['\\xleftarrow', '←'],
  ['\\leftrightarrow', '↔'],
  ['->', '→'],
  ['→', '→'],
  ['⟶', '→'],
  ['\\longrightarrow', '→'],
  ['\\rightarrow', '→'],
  ['\\to', '→'],
  ['<-', '←'],
  ['←', '←'],
  ['⟵', '←'],
  ['\\leftarrow', '←'],
];

const VULGAR_COEFFICIENTS: Readonly<Record<string, [number, number]>> = {
  '½': [1, 2],
  '⅓': [1, 3],
  '⅔': [2, 3],
  '¼': [1, 4],
  '¾': [3, 4],
};

const STATES: readonly ChemState[] = ['aq', 's', 'l', 'g'];

const MAX_CHEM_UNITS = 64;
const MAX_CHEM_DEPTH = 6;

function isUpper(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'A' && ch <= 'Z';
}

function isLower(ch: string | undefined): boolean {
  return ch !== undefined && ch >= 'a' && ch <= 'z';
}

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

class ChemParser {
  private pos = 0;
  private units = 0;
  /** An arrow anywhere: `e-` outside `\ce` is then an electron (P7 item 9). */
  private readonly reactionContext: boolean;

  constructor(
    private readonly src: string,
    private readonly inCe: boolean,
  ) {
    this.reactionContext = ARROWS.some(([text]) => src.includes(text));
  }

  parse(): Reaction {
    const sides: Term[][] = [this.side()];
    const arrows: ChemArrow[] = [];
    const conditions: Array<ArrowCondition | null> = [];
    for (;;) {
      this.spaces();
      const arrow = this.arrow();
      if (!arrow) break;
      arrows.push(arrow);
      conditions.push(this.arrowCondition());
      sides.push(this.side());
    }
    this.spaces();
    if (this.pos < this.src.length) {
      throw new ChemFault('malformed', `unexpected '${this.src[this.pos]}'`);
    }
    return conditions.some(Boolean) ? { sides, arrows, conditions } : { sides, arrows };
  }

  /**
   * O-10: `->[\Delta]`, `->[above][below]` (mhchem) and
   * `\xrightarrow[below]{above}` (LaTeX) right after an arrow.
   */
  private arrowCondition(): ArrowCondition | null {
    const read = (open: string, close: string): string | null => {
      if (this.src[this.pos] !== open) return null;
      let depth = 0;
      for (let i = this.pos; i < this.src.length; i += 1) {
        const ch = this.src[i];
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === open) depth += 1;
        else if (ch === close) {
          depth -= 1;
          if (depth === 0) {
            const text = this.src.slice(this.pos + 1, i).trim();
            this.pos = i + 1;
            return text;
          }
        }
      }
      throw new ChemFault('malformed', 'arrow condition');
    };
    const latex = this.src.slice(0, this.pos).endsWith('arrow');
    if (latex) {
      const below = read('[', ']');
      const above = read('{', '}');
      return above || below ? { above: above || null, below: below || null } : null;
    }
    const above = read('[', ']');
    const below = above === null ? null : read('[', ']');
    return above || below ? { above: above || null, below: below || null } : null;
  }

  private spaces(): void {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === ' ') this.pos += 1;
  }

  private arrow(): ChemArrow | null {
    for (const [text, arrow] of ARROWS) {
      if (this.src.startsWith(text, this.pos) && !/[A-Za-z]/.test(this.src[this.pos + text.length] ?? '')) {
        this.pos += text.length;
        return arrow;
      }
    }
    // mhchem: a spaced `=` is a reaction arrow; `=` between atoms is a bond (O-9).
    if (this.inCe && this.src[this.pos] === '=') {
      this.pos += 1;
      return '→';
    }
    return null;
  }

  private side(): Term[] {
    this.spaces();
    const terms = [this.term()];
    for (;;) {
      const save = this.pos;
      this.spaces();
      // `+` between terms: spaced, or glued before a term (`2H2+O2`, P7 item 8).
      if (this.src[this.pos] === '+' && (this.pos > save || this.termStartsAt(this.pos + 1))) {
        this.pos += 1;
        this.spaces();
        terms.push(this.term());
        continue;
      }
      this.pos = save;
      break;
    }
    return terms;
  }

  private termStartsAt(i: number): boolean {
    const ch = this.src[i];
    return ch !== undefined && (isUpper(ch) || isAsciiDigit(ch) || ch === '(' || ch === '[' || ch in VULGAR_COEFFICIENTS);
  }

  private term(): Term {
    const coeff = this.coefficient();
    const species = this.species();
    const state = this.state();
    const ch = this.src[this.pos];
    if (ch === '↑' || ch === '↓') {
      this.pos += 1;
      return { coeff, species, state, mark: ch };
    }
    // mhchem ` ^` (gas) and ` v` (precipitate), P9.
    if (this.inCe && ch === ' ' && (this.src[this.pos + 1] === '^' || this.src[this.pos + 1] === 'v')) {
      const after = this.src[this.pos + 2];
      if (after === undefined || after === ' ') {
        const mark = this.src[this.pos + 1] === '^' ? '↑' : '↓';
        this.pos += 2;
        return { coeff, species, state, mark };
      }
    }
    return { coeff, species, state };
  }

  private coefficient(): Coefficient | null {
    const start = this.pos;
    const vulgar = VULGAR_COEFFICIENTS[this.src[this.pos] ?? ''];
    if (vulgar) {
      this.pos += 1;
      this.spaces();
      return { kind: 'frac', num: vulgar[0], den: vulgar[1] };
    }
    if (this.src.startsWith('\\frac{', this.pos)) {
      const match = /^\\frac\{(\d+)\}\{(\d+)\}/.exec(this.src.slice(this.pos));
      if (!match) throw new ChemFault('malformed', 'fraction coefficient');
      this.pos += match[0].length;
      this.spaces();
      return { kind: 'frac', num: Number(match[1]), den: Number(match[2]) };
    }
    let digits = '';
    while (isAsciiDigit(this.src[this.pos])) {
      digits += this.src[this.pos];
      this.pos += 1;
    }
    if (!digits) return null;
    // `0.5H₂O`: a decimal coefficient (P7 item 6).
    if (this.src[this.pos] === '.' && isAsciiDigit(this.src[this.pos + 1])) {
      let frac = '';
      let j = this.pos + 1;
      while (isAsciiDigit(this.src[j])) {
        frac += this.src[j];
        j += 1;
      }
      if (isUpper(this.src[j]) || this.src[j] === '(' || (this.src[j] === ' ' && isUpper(this.src[j + 1]))) {
        this.pos = j;
        this.spaces();
        return { kind: 'decimal', intDigits: digits, fracDigits: frac };
      }
    }
    if (this.src[this.pos] === '/' && isAsciiDigit(this.src[this.pos + 1])) {
      this.pos += 1;
      let den = '';
      while (isAsciiDigit(this.src[this.pos])) {
        den += this.src[this.pos];
        this.pos += 1;
      }
      this.spaces();
      return { kind: 'frac', num: Number(digits), den: Number(den) };
    }
    this.spaces();
    const next = this.src[this.pos];
    if (!isUpper(next) && next !== '(' && next !== '[' && next !== 'e') {
      this.pos = start;
      throw new ChemFault('malformed', 'coefficient without species');
    }
    return { kind: 'int', value: Number(digits) };
  }

  private species(): Species {
    // An electron: e⁻, e^-, e^{-}, or e- inside \ce.
    if (this.src[this.pos] === 'e' && !isLower(this.src[this.pos + 1])) {
      const rest = this.src.slice(this.pos + 1);
      const plainMinus = (this.inCe || this.reactionContext) && rest.startsWith('-') && !isUpper(rest[1]);
      const marker = ['⁻', '^-', '^{-}'].find((m) => rest.startsWith(m)) ?? (plainMinus ? '-' : null);
      if (marker) {
        this.pos += 1 + marker.length;
        return { t: 'electron' };
      }
    }
    // `[H⁺]`: a charged species in written square brackets (P9).
    if (this.src[this.pos] === '[') {
      const bracketed = this.bracketedSpecies();
      if (bracketed) return bracketed;
    }
    const isotope = this.isotopePrefix();
    const units = this.formulaUnits(0);
    if (units.length === 0) throw new ChemFault('malformed', 'missing formula');
    const hydrates: Hydrate[] = [];
    while (this.hydrateDot()) {
      this.pos += 1;
      let digits = '';
      while (isAsciiDigit(this.src[this.pos])) {
        digits += this.src[this.pos];
        this.pos += 1;
      }
      const hydrateUnits = this.formulaUnits(0);
      if (hydrateUnits.length === 0) throw new ChemFault('malformed', 'empty hydrate');
      hydrates.push({ coeff: digits ? { value: Number(digits) } : null, units: hydrateUnits });
    }
    const countStart = this.lastCountStart;
    const charge = this.asciiCharge(hydrates.length > 0 ? hydrates[hydrates.length - 1]!.units : units, this.charge(), countStart);
    // `C-14`: a hyphen and a mass number after a lone element (P9).
    const hyphenMass = !isotope && !charge && units.length === 1 && units[0]!.t === 'el' && !units[0]!.count ? this.hyphenMass() : null;
    const nuclide = isotope ?? (hyphenMass === null ? null : { mass: hyphenMass, atomic: null });
    return nuclide ? { t: 'formula', units, hydrates, charge, isotope: nuclide } : { t: 'formula', units, hydrates, charge };
  }

  /** `[H⁺]`, `[OH^-]`: brackets around one charged species, or `null` (a group) with the cursor unchanged. */
  private bracketedSpecies(): Species | null {
    const save = this.pos;
    this.pos += 1;
    try {
      const inner = this.species();
      if (this.src[this.pos] === ']' && inner.t === 'formula' && inner.charge) {
        this.pos += 1;
        return { t: 'bracketed', inner };
      }
    } catch {
      // Not a bracketed species: parse the bracket as a group.
    }
    this.pos = save;
    return null;
  }

  /** `¹⁴C`, `^{14}C`, `^{235}_{92}U`, `_{92}^{235}U`, `²³⁵₉₂U` before the first element. */
  private isotopePrefix(): Isotope | null {
    const save = this.pos;
    let mass: string | null = null;
    let atomic: string | null = null;
    const braced = (marker: string): string | null => {
      if (this.src[this.pos] !== marker) return null;
      const match = /^[_^]\{(\d+)\}|^[_^](\d)/.exec(this.src.slice(this.pos));
      if (!match) return null;
      this.pos += match[0].length;
      return match[1] ?? match[2]!;
    };
    const unicode = (read: (ch: string) => string | undefined): string | null => {
      let digits = '';
      while (this.pos < this.src.length && /^[0-9]$/.test(read(this.src[this.pos]!) ?? '')) {
        digits += read(this.src[this.pos]!);
        this.pos += 1;
      }
      return digits || null;
    };
    for (let i = 0; i < 2; i += 1) {
      mass ??= braced('^') ?? unicode(superscriptValue);
      atomic ??= braced('_') ?? unicode(subscriptValue);
    }
    if (mass !== null && isUpper(this.src[this.pos])) return { mass: Number(mass), atomic: atomic === null ? null : Number(atomic) };
    this.pos = save;
    return null;
  }

  /** `-14` after `C` when a mass number follows the hyphen, or `null`. */
  private hyphenMass(): number | null {
    const match = /^-(\d{1,3})(?![\d.A-Za-z])/.exec(this.src.slice(this.pos));
    if (!match) return null;
    this.pos += match[0].length;
    return Number(match[1]);
  }

  /** `·`, `•`, `*`, or an ASCII `.` before a count or an element (`CuSO4.5H2O`, P7 item 4). */
  private hydrateDot(): boolean {
    const ch = this.src[this.pos];
    if (ch === '·' || ch === '•' || ch === '*') return true;
    if (ch !== '.') return false;
    let j = this.pos + 1;
    while (isAsciiDigit(this.src[j])) j += 1;
    return isUpper(this.src[j]) || this.src[j] === '(';
  }

  /** O-9: `-`, `=`, `≡`, `#` glued between two units. */
  private bond(): BondOrder | null {
    const ch = this.src[this.pos];
    const order: BondOrder | null = ch === '-' ? '-' : ch === '=' ? '=' : ch === '≡' || ch === '#' ? '≡' : null;
    if (!order) return null;
    const next = this.src[this.pos + 1];
    if (next === undefined || !(isUpper(next) || next === '(' || next === '[')) return null;
    return order;
  }

  private formulaUnits(depth: number): FormulaUnit[] {
    if (depth > MAX_CHEM_DEPTH) throw new ChemFault('malformed', 'nesting');
    const units: FormulaUnit[] = [];
    for (;;) {
      const bond = units.length > 0 ? this.bond() : null;
      if (bond) {
        this.pos += 1;
        units.push({ t: 'bond', order: bond });
        continue;
      }
      const ch = this.src[this.pos];
      if (ch === '(' || ch === '[') {
        // A state marker is not a group.
        if (ch === '(' && this.peekState()) break;
        const close = ch === '(' ? ')' : ']';
        this.pos += 1;
        const inner = this.formulaUnits(depth + 1);
        if (this.src[this.pos] !== close || inner.length === 0) {
          throw new ChemFault('malformed', 'unbalanced group');
        }
        this.pos += 1;
        units.push({ t: 'group', bracket: ch, units: inner, count: this.count() });
      } else if (isUpper(ch)) {
        const two = ch + (this.src[this.pos + 1] ?? '');
        let symbol: string;
        if (isLower(this.src[this.pos + 1]) && isElementSymbol(two)) symbol = two;
        else if (isElementSymbol(ch!)) symbol = ch!;
        else {
          const shown = isLower(this.src[this.pos + 1]) ? two : ch!;
          throw new ChemFault('unknown-element', shown);
        }
        this.pos += symbol.length;
        units.push({ t: 'el', symbol, count: this.count() });
      } else break;
      this.units += 1;
      if (this.units > MAX_CHEM_UNITS) throw new ChemFault('malformed', 'too many units');
    }
    return units;
  }

  /** Where the last plain ASCII count began (for the `Fe3+` convention), or -1. */
  private lastCountStart = -1;

  private count(): ChemCount | null {
    let digits = '';
    this.lastCountStart = isAsciiDigit(this.src[this.pos]) ? this.pos : -1;
    if (this.src[this.pos] === '_') {
      this.pos += 1;
      if (this.src[this.pos] === '{') {
        const close = this.src.indexOf('}', this.pos);
        if (close < 0) throw new ChemFault('malformed', 'count');
        digits = this.src.slice(this.pos + 1, close);
        this.pos = close + 1;
      } else {
        while (isAsciiDigit(this.src[this.pos])) {
          digits += this.src[this.pos];
          this.pos += 1;
        }
      }
      if (!/^\d+$/.test(digits)) throw new ChemFault('malformed', 'count');
      return { value: Number(digits) };
    }
    while (isAsciiDigit(this.src[this.pos])) {
      digits += this.src[this.pos];
      this.pos += 1;
    }
    const ascii = digits.length > 0;
    while (this.pos < this.src.length && /^[0-9]$/.test(subscriptValue(this.src[this.pos]!) ?? '')) {
      digits += subscriptValue(this.src[this.pos]!);
      this.pos += 1;
    }
    return digits ? { value: Number(digits), ...(ascii ? { ascii: true } : {}) } : null;
  }

  private charge(): Charge | null {
    const ch = this.src[this.pos];
    // ^{2+} ^{2-} ^{+} ^2- ^+ ^-
    if (ch === '^') {
      let body: string;
      if (this.src[this.pos + 1] === '{') {
        const close = this.src.indexOf('}', this.pos);
        if (close < 0) throw new ChemFault('malformed', 'charge');
        body = this.src.slice(this.pos + 2, close);
        this.pos = close + 1;
      } else {
        let j = this.pos + 1;
        while (isAsciiDigit(this.src[j])) j += 1;
        if (this.src[j] === '+' || this.src[j] === '-') j += 1;
        body = this.src.slice(this.pos + 1, j);
        this.pos = j;
      }
      return parseChargeBody(body);
    }
    // Unicode superscripts: ⁺ ⁻ ²⁺ ³⁻
    if (ch !== undefined && superscriptValue(ch) !== undefined) {
      let body = '';
      while (this.pos < this.src.length && superscriptValue(this.src[this.pos]!) !== undefined) {
        body += superscriptValue(this.src[this.pos]!);
        this.pos += 1;
      }
      return parseChargeBody(body);
    }
    // A trailing +/- attached to the species (Na+, Cl-), not an arrow or a separator.
    if ((ch === '+' || ch === '-') && this.src[this.pos + 1] !== '>') {
      const after = this.src[this.pos + 1];
      if (after === undefined || after === ' ' || after === '(' || after === ')' || after === '↑' || after === '↓') {
        this.pos += 1;
        return { sign: ch, magnitude: 1 };
      }
    }
    return null;
  }

  /**
   * P7 item 5: `Fe3+`, `SO42-`, `CO32-` — ASCII digits right before a sign.
   * Two or more digits: the last digit is the charge (`SO42-` = SO₄²⁻). One
   * digit on a single element is the charge (`Fe3+` = Fe³⁺); on a polyatomic
   * species it is a count with a charge of one (`NH4+`, `NO3-`). Flagged.
   */
  asciiCharge(units: FormulaUnit[], charge: Charge | null, countStart: number): Charge | null {
    if (!charge || charge.magnitude !== 1 || countStart < 0) return charge;
    const signAt = this.pos - 1;
    if (this.src[signAt] !== '+' && this.src[signAt] !== '-') return charge;
    const last = units[units.length - 1];
    if (!last || last.t === 'bond' || !last.count) return charge;
    const digits = this.src.slice(countStart, signAt);
    if (!/^[0-9]+$/.test(digits)) return charge;
    // A single element (`Fe3+`) or a bracketed complex (`[Cu(NH3)4]2+`): the digit is the charge.
    const single = (units.length === 1 && last.t === 'el') || (last.t === 'group' && last.bracket === '[');
    if (digits.length === 1 && !single) return { ...charge, ascii: true };
    const magnitude = Number(digits[digits.length - 1]);
    if (magnitude < 1) return charge;
    const rest = digits.slice(0, -1);
    last.count = rest ? { value: Number(rest) } : null;
    return { sign: charge.sign, magnitude, ascii: true };
  }

  private peekState(): ChemState | null {
    for (const state of STATES) {
      if (this.src.startsWith(`(${state})`, this.pos)) return state;
    }
    return null;
  }

  private state(): ChemState | null {
    const save = this.pos;
    // `NaCl (aq)`: one space before a state is allowed outside `\ce` too (P7 item 8).
    if (this.inCe) this.spaces();
    else if (this.src[this.pos] === ' ' && this.src[this.pos + 1] === '(') this.pos += 1;
    const state = this.peekState();
    if (state) {
      this.pos += state.length + 2;
      return state;
    }
    this.pos = save;
    return null;
  }
}

function parseChargeBody(body: string): Charge {
  const make = (sign: string, digits: string): Charge => {
    const magnitude = digits ? Number(digits) : 1;
    if (magnitude < 1 || magnitude > 9) throw new ChemFault('malformed', `charge ${body}`);
    return { sign: sign as '+' | '-', magnitude };
  };
  const trailing = /^(\d*)([+-])$/.exec(body);
  if (trailing) return make(trailing[2]!, trailing[1]!);
  const leading = /^([+-])(\d+)$/.exec(body);
  if (leading) return make(leading[1]!, leading[2]!);
  throw new ChemFault('malformed', `charge ${body}`);
}

export function parseChemistry(src: string, options: { inCe: boolean }): Reaction {
  return new ChemParser(src, options.inCe).parse();
}

function unitsKey(units: FormulaUnit[]): string {
  return units
    .map((unit) =>
      unit.t === 'bond'
        ? unit.order
        : unit.t === 'el'
          ? `${unit.symbol}${unit.count && unit.count.value !== 1 ? unit.count.value : ''}`
          : `${unit.bracket}${unitsKey(unit.units)}${unit.bracket === '(' ? ')' : ']'}${unit.count ? unit.count.value : ''}`,
    )
    .join('');
}

/** The exact canonical formula string used as a dictionary key (`H2O`, `SO4^2-`, `Na^+`). */
export function canonicalFormula(species: Species): string {
  if (species.t === 'electron') return 'e^-';
  if (species.t === 'bracketed') return `[${canonicalFormula(species.inner)}]`;
  let key = unitsKey(species.units);
  for (const hydrate of species.hydrates) key += `·${hydrate.coeff ? hydrate.coeff.value : ''}${unitsKey(hydrate.units)}`;
  if (species.charge) {
    key += `^${species.charge.magnitude === 1 ? '' : species.charge.magnitude}${species.charge.sign}`;
  }
  return key;
}

function elements(units: FormulaUnit[]): string[] {
  return units.flatMap((unit) => (unit.t === 'el' ? [unit.symbol] : unit.t === 'group' ? elements(unit.units) : []));
}

/**
 * Formula-candidate promotion outside `\ce{}` and `$…$` (P7 item 1): the run
 * parses completely AND shows chemistry evidence — a count, a group, a bond,
 * a charge, a state, a coefficient, a hydrate, a reaction, or a two-letter
 * element symbol among two or more elements (`NaCl`). An all-capitals run of
 * one-letter symbols (`WHO`, `CPU`, `ON`, `CO`) and a lone element with a
 * two-digit count (`B12`) are not evidence: they stay prose.
 */
export function isPromoted(reaction: Reaction): boolean {
  if (reaction.arrows.length > 0 || reaction.sides.some((side) => side.length > 1)) return true;
  const term = reaction.sides[0]![0]!;
  if (term.coeff || term.state || term.mark) return true;
  const species = term.species;
  if (species.t === 'electron' || species.t === 'bracketed') return true;
  if (species.isotope) return true;
  if (species.charge || species.hydrates.length > 0) return true;
  const units = species.units;
  if (units.some((unit) => unit.t === 'group' || unit.t === 'bond')) return true;
  const symbols = elements(units);
  const counted = units.filter((unit) => unit.t === 'el' && unit.count !== null);
  // `B12`, `C60`: one element with a multi-digit ASCII count reads like a name.
  const onlyCount = counted.length === 1 ? (counted[0] as { count: ChemCount }).count : null;
  if (symbols.length === 1 && onlyCount?.ascii && onlyCount.value >= 10) return false;
  if (counted.length > 0) return true;
  return symbols.length >= 2 && symbols.some((symbol) => symbol.length === 2);
}
