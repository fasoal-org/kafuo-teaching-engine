/**
 * How an authored number is spoken (plan §10.1 *Numbers*).
 *
 * - `digits` mode (default, H3 pending): integers stay as authored digits
 *   (Western or Arabic-Indic); the decimal separator is spoken («فاصلة») and
 *   group separators are removed.
 * - `words` mode: the deterministic number-to-words module.
 * - Structural roles (exponents, root and subscript indices, chemical
 *   coefficients, charge magnitudes) use the `numbers-structural` words for
 *   0–12 in both modes, because there the word form carries the grammar.
 */
import type { Token } from '../math/tokenize';
import { digitsValue, isArabicIndicDigit } from '../normalise';
import { labelOrNull, speak, type VerbaliseContext, type Writer } from '../writer';
import { numberToArabicWords } from './ar-words';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

function toAscii(digits: string): string {
  let out = '';
  for (const ch of digits) {
    const index = ARABIC_INDIC.indexOf(ch);
    out += index >= 0 ? String(index) : ch;
  }
  return out;
}

/** Canonical value used by semantic tokens and dictionary keys (`'1.5'`). */
export function canonicalNumber(tok: Pick<Token, 'intDigits' | 'fracDigits'>): string {
  const whole = toAscii(tok.intDigits ?? '').replace(/^0+(?=\d)/, '');
  return tok.fracDigits ? `${whole}.${toAscii(tok.fracDigits)}` : whole;
}

/** Integer value when the token is a plain integer, else `null`. */
export function integerValue(tok: Pick<Token, 'intDigits' | 'fracDigits'>): number | null {
  if (tok.fracDigits || !tok.intDigits) return null;
  return digitsValue(tok.intDigits);
}

/**
 * Speaks a small integer in a structural role, or `null` when out of range:
 * 0–12 for scripts, indices, coefficients and charges; 0–20 for chemical
 * counts (`max`). Every form is in the «اثنين» register (O-1), so the old
 * nominative/genitive distinction is gone (upgrade plan P2).
 */
export function structuralWord(ctx: VerbaliseContext, value: number, max = 12): string | null {
  if (!Number.isInteger(value) || value < 0 || value > max) return null;
  return speak(ctx, 'number', String(value), String(value));
}

export function writeNumber(
  ctx: VerbaliseContext,
  w: Writer,
  tok: Pick<Token, 'intDigits' | 'fracDigits'>,
  structural = false,
): void {
  w.sem('num', canonicalNumber(tok));
  const whole = integerValue(tok);
  if (structural && whole !== null) {
    const word = structuralWord(ctx, whole);
    if (word) {
      w.word(word);
      return;
    }
  }
  // Only a number with a fractional part consults the separator word.
  const spokenDecimal = tok.fracDigits ? labelOrNull(ctx, 'decimal') : '';
  if (tok.fracDigits && spokenDecimal === null) {
    // Literal form: the number as authored (`9.8`, `٩٫٨`), one token, so the
    // separator is never split off or dropped (FR-030).
    const separator = isArabicIndicDigit(tok.fracDigits[0]) ? '٫' : '.';
    w.word(`${tok.intDigits ?? ''}${separator}${tok.fracDigits}`);
    return;
  }
  const decimal = spokenDecimal || '.';
  if (ctx.policy.numbersMode === 'words') {
    const words = numberToArabicWords(
      digitsValue(tok.intDigits ?? '0'),
      tok.fracDigits ? toAscii(tok.fracDigits) : null,
      decimal,
    );
    if (words) {
      w.word(words);
      return;
    }
  }
  w.word(tok.intDigits ?? '');
  if (tok.fracDigits) {
    w.word(decimal);
    w.word(tok.fracDigits);
  }
}
