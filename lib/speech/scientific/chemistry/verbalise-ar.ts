/**
 * Arabic reading of Chemistry (plan §10.3, upgrade plan R1):
 * - D-9: element symbols by their Latin letter names («إتش اثنين أو»);
 * - O-1: subscript counts, coefficients and charge magnitudes are Arabic
 *   numerals in the «اثنين» register («اثنين إتش اثنين أو»);
 * - O-2: SATTS never speaks a compound, ion or quantity name — only the
 *   notation. If a name should be heard, the narration says it;
 * - A structural word whose entry is unusable is spoken in its literal form
 *   (`+`, `→`, `^2-`, `·`, `(…)`), never dropped (FR-030).
 */
import { integerToArabicWords } from '../numbers/ar-words';
import { structuralWord, writeNumber } from '../numbers/read';
import { label, labelOrNull, speak, speakOrNull, type VerbaliseContext, Writer } from '../writer';
import { isEnglishText, literalReading } from '../literal';
import {
  type ArrowCondition,
  type Charge,
  type ChemState,
  type Coefficient,
  type FormulaUnit,
  type Reaction,
  type Species,
} from './parse';

/**
 * An element symbol by its letter names («إن إيه»). When any letter's entry
 * is unusable, the symbol is spoken whole (`Na`, never `N a`: P3).
 */
export function writeElement(ctx: VerbaliseContext, w: Writer, symbol: string): void {
  const names = [...symbol].map((ch) => ctx.policy.resolve({ role: 'element', token: ch, domain: ctx.domain }, ctx.mode));
  if (names.every((name) => name !== null)) {
    for (const name of names) {
      if (name!.proposed) ctx.noteProposed();
      w.word(name!.text);
    }
    return;
  }
  ctx.warn('SATTS_W_MISSING_DICTIONARY_ENTRY', `element:${symbol}`);
  w.word(symbol);
}

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** `²⁻`, `⁺`: the authored charge as superscript glyphs (never «أُس»). */
function chargeGlyph(charge: Charge): string {
  const magnitude = charge.magnitude === 1 ? '' : [...String(charge.magnitude)].map((d) => SUPERSCRIPT_DIGITS[Number(d)]).join('');
  return `${magnitude}${charge.sign === '+' ? '⁺' : '⁻'}`;
}

/** A charge: «بشحنة سالب اثنين» (natural), «الشحنة: سالب اثنين» (accessible), or the glyph. */
export function writeCharge(ctx: VerbaliseContext, w: Writer, charge: Charge): void {
  w.sem('charge', `${charge.sign}${charge.magnitude}`);
  // `Fe3+`, `SO42-`: read by convention (P7 item 5); a reviewer must confirm.
  if (charge.ascii) ctx.warn('SATTS_W_AMBIGUOUS_CHARGE', `${charge.magnitude}${charge.sign}`);
  const accessible = ctx.mode === 'accessible';
  const sign = charge.sign === '+' ? 'positive' : 'negative';
  const one = !accessible && charge.magnitude === 1;
  const lead = labelOrNull(ctx, 'charge');
  const signWord = lead === null ? null : labelOrNull(ctx, one ? `${sign}-one` : sign);
  if (lead === null || signWord === null) {
    // Literal charge `⁺`, `²⁻`, glued to its species: never dropped, never «أُس».
    w.suffix(chargeGlyph(charge));
    return;
  }
  w.pause();
  w.word(lead);
  if (accessible) w.colon();
  w.word(signWord);
  if (one) return;
  w.word(structuralWord(ctx, charge.magnitude) ?? String(charge.magnitude));
}

/**
 * A count: a number word up to 20; beyond, composed in the same «اثنين»
 * register (`22` → «اثنين وعشرين», P7 item 10) when the number words are
 * usable, else the digits.
 */
function writeCount(ctx: VerbaliseContext, w: Writer, value: number): void {
  w.sem('count', String(value));
  const word = structuralWord(ctx, value, 20);
  if (word !== null) {
    w.word(word);
    return;
  }
  const composed = value > 20 && speakOrNull(ctx, 'number', '2') !== null ? integerToArabicWords(value) : null;
  w.word(composed ?? String(value));
}

/** An arrow condition that is exactly `Δ` (`\Delta`, `{\Delta}`, `$\Delta$`). */
function isDelta(text: string): boolean {
  return text.replace(/[\s${}]/g, '').replace(/^\\Delta$/, 'Δ') === 'Δ';
}

class ChemVerbaliser {
  constructor(private readonly ctx: VerbaliseContext) {}

  private get accessible(): boolean {
    return this.ctx.mode === 'accessible';
  }

  reaction(reaction: Reaction, w: Writer): void {
    reaction.sides.forEach((side, sideIndex) => {
      if (sideIndex > 0) {
        const arrow = reaction.arrows[sideIndex - 1]!;
        w.sem('arrow', arrow);
        if (this.accessible) w.pause();
        // What is written on the arrow is heard first: «…، بالتسخين، ينتج …».
        const condition = reaction.conditions?.[sideIndex - 1];
        if (condition) this.condition(condition, w);
        // The arrow's conventional reading in a parsed reaction («ينتج»، «في حالة
        // اتزان مع»); an arrow with none (`←`, `↔`) keeps its glyph name (DEC-052).
        w.word(speak(this.ctx, 'reaction', arrow, arrow));
        if (this.accessible) w.pause();
      }
      side.forEach((term, termIndex) => {
        if (termIndex > 0) {
          w.sem('+');
          // `+` is «زائد» on both sides: never «مع» / «و» (R1).
          const plus = speakOrNull(this.ctx, 'operator', '+');
          if (plus === null) w.word('+');
          else if (this.accessible) {
            w.pause();
            w.word(plus);
            w.pause();
          } else w.word(plus);
        }
        if (term.coeff) this.coefficient(term.coeff, w);
        this.species(term.species, w);
        if (term.state) this.state(term.state, w);
        if (term.mark) {
          // `↑` / `↓` after a product: «يتصاعد» / «يترسب» (DEC-052).
          w.sem('mark', term.mark);
          w.word(speak(this.ctx, 'reaction', term.mark, term.mark));
        }
      });
    });
  }

  private coefficient(coeff: Coefficient, w: Writer): void {
    if (this.accessible) w.word(label(this.ctx, 'coefficient'));
    if (coeff.kind === 'decimal') {
      w.sem('coeff', `${coeff.intDigits}.${coeff.fracDigits}`);
      writeNumber(this.ctx, w, { intDigits: coeff.intDigits, fracDigits: coeff.fracDigits });
      return;
    }
    if (coeff.kind === 'frac') {
      w.sem('coeff', `${coeff.num}/${coeff.den}`);
      const found = this.ctx.policy.resolve(
        { role: 'fraction', token: `${coeff.num}/${coeff.den}`, domain: this.ctx.domain },
        'natural',
      );
      if (found) {
        if (found.proposed) this.ctx.noteProposed();
        w.word(found.text);
      } else {
        w.word(`${coeff.num}`);
        w.word(label(this.ctx, '/', '/'));
        w.word(`${coeff.den}`);
      }
      return;
    }
    w.sem('coeff', String(coeff.value));
    w.word(structuralWord(this.ctx, coeff.value) ?? String(coeff.value));
  }

  /**
   * What is written over / under the arrow (DEC-052): `Δ` alone is its
   * conventional reading «بالتسخين»; anything else (a catalyst, a
   * temperature) is read by its symbols and placed: «إم إن أو اثنين فوق السهم».
   */
  private condition(condition: ArrowCondition, w: Writer): void {
    w.pause();
    for (const [text, place] of [
      [condition.above, 'over-arrow'],
      [condition.below, 'under-arrow'],
    ] as const) {
      if (!text) continue;
      w.sem('condition', place);
      const heat = isDelta(text) ? speakOrNull(this.ctx, 'reaction', 'Δ') : null;
      if (heat !== null) {
        w.word(heat);
        continue;
      }
      if (isEnglishText(text)) {
        // `->[heat]`: an English word stays prose, never spelled (P3 rule).
        this.ctx.warn('SATTS_W_UNSUPPORTED_NOTATION', 'english-word');
        w.word(text);
      } else w.append(literalReading(text, this.ctx));
      w.word(label(this.ctx, place));
    }
    w.pause();
  }

  species(species: Species, w: Writer): void {
    if (species.t === 'electron') {
      w.sem('electron');
      w.word(label(this.ctx, 'electron', 'e⁻'));
      return;
    }
    if (species.t === 'bracketed') {
      // `[H⁺]`: the written brackets, never «تركيز» (P9, R1).
      w.sem('bracketed');
      w.word(speak(this.ctx, 'symbol', '[', '['));
      this.species(species.inner, w);
      w.pause();
      w.boundary(speak(this.ctx, 'symbol', ']', ']'));
      return;
    }
    if (this.accessible) this.decoration('formula', w);
    this.units(species.units, w);
    if (species.isotope) {
      // `¹⁴C` → «سي أربعة عشر»; `^{235}_{92}U` → «يو مئتين وخمسة وثلاثين، اثنين وتسعين» (P9).
      w.sem('isotope', String(species.isotope.mass));
      writeCount(this.ctx, w, species.isotope.mass);
      if (species.isotope.atomic !== null) {
        w.pause();
        writeCount(this.ctx, w, species.isotope.atomic);
      }
    }
    for (const hydrate of species.hydrates) {
      w.sem('hydrate');
      w.pause();
      w.word(label(this.ctx, 'hydrate', '·'));
      if (hydrate.coeff) {
        w.sem('coeff', String(hydrate.coeff.value));
        w.word(structuralWord(this.ctx, hydrate.coeff.value) ?? String(hydrate.coeff.value));
      }
      this.units(hydrate.units, w);
    }
    if (species.charge) this.charge(species.charge, w);
  }

  private units(units: FormulaUnit[], w: Writer): void {
    units.forEach((unit, index) => {
      if (unit.t === 'bond') {
        // O-9: the neutral name of the bond symbol, never «رابطة …».
        w.sem('bond', unit.order);
        w.word(speak(this.ctx, 'bond', unit.order, unit.order));
        return;
      }
      if (unit.t === 'el') {
        w.sem('el', unit.symbol);
        if (this.accessible && index > 0) w.pause();
        writeElement(this.ctx, w, unit.symbol);
        if (unit.count && this.accessible) {
          w.pause();
          w.word(label(this.ctx, 'count'));
          writeCount(this.ctx, w, unit.count.value);
        } else if (unit.count) writeCount(this.ctx, w, unit.count.value);
        return;
      }
      w.sem('group');
      w.pause();
      const opener = labelOrNull(this.ctx, this.accessible ? 'open-paren' : 'group');
      if (opener === null) {
        // Literal `(OH)`.
        w.prefix(unit.bracket);
        this.units(unit.units, w);
        w.suffix(unit.bracket === '(' ? ')' : ']');
      } else if (this.accessible) {
        w.word(opener);
        w.pause();
        this.units(unit.units, w);
        w.pause();
        w.word(label(this.ctx, 'close-paren', ')'));
      } else {
        w.word(opener);
        this.units(unit.units, w);
      }
      if (unit.count) {
        w.sem('times', String(unit.count.value));
        // The literal `(OH)2` keeps its count next to the bracket.
        if (opener !== null) w.pause();
        if (this.accessible) w.word(label(this.ctx, 'repeated'));
        w.word(speak(this.ctx, 'repeat', String(unit.count.value), String(unit.count.value)));
      } else if (opener !== null && !this.accessible) {
        // P5: a group with no count ends audibly, so `[Cu(NH3)4]SO4` and
        // `[Cu(NH3)4SO4]` sound different («نهاية المجموعة»).
        w.pause();
        w.word(label(this.ctx, 'group-end'));
      }
      w.pause();
    });
  }

  private charge(charge: Charge, w: Writer): void {
    writeCharge(this.ctx, w, charge);
  }

  /** An accessible-mode label followed by a colon; nothing when the label is unusable. */
  private decoration(key: string, w: Writer): void {
    const text = labelOrNull(this.ctx, key);
    if (text === null) return;
    w.word(text);
    w.colon();
  }

  private state(state: ChemState, w: Writer): void {
    w.sem('state', state);
    if (this.accessible) {
      w.pause();
      this.decoration('state', w);
    }
    w.word(speak(this.ctx, 'state', state, `(${state})`));
  }
}

export function verbaliseChemistry(reaction: Reaction, ctx: VerbaliseContext): { writer: Writer } {
  const w = new Writer();
  new ChemVerbaliser(ctx).reaction(reaction, w);
  return { writer: w };
}

/** A lone symbol that parses as a formula but is not promoted: read as letters. */
export function verbaliseAmbiguousSymbol(symbol: string, ctx: VerbaliseContext): Writer {
  const w = new Writer();
  for (const ch of symbol) {
    w.sem('var', ch);
    w.word(speak(ctx, 'variable', ch, ch));
  }
  return w;
}
