/**
 * Text normalisation helpers. Pure.
 */

/** Bidi controls stripped inside expressions only (plan §9.2). */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;

export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}

export function isBidiControl(ch: string): boolean {
  return /^[‎‏‪-‮⁦-⁩]$/.test(ch);
}

/** NFC normalisation of the whole input (plan §9.2). */
export function normaliseInput(text: string): string {
  return text.normalize('NFC');
}

export const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

export function isArabicIndicDigit(ch: string | undefined): boolean {
  return ch !== undefined && ARABIC_INDIC_DIGITS.includes(ch) && ch.length === 1;
}

export function isDigit(ch: string | undefined): boolean {
  return isAsciiDigit(ch) || isArabicIndicDigit(ch);
}

/** Integer value of an authored digit string (Western or Arabic-Indic). */
export function digitsValue(digits: string): number {
  let value = 0;
  for (const ch of digits) {
    const d = isAsciiDigit(ch) ? ch.charCodeAt(0) - 48 : ARABIC_INDIC_DIGITS.indexOf(ch);
    value = value * 10 + d;
  }
  return value;
}

export function isLatinLetter(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z]$/.test(ch);
}

/** Arabic script (letters, diacritics, Arabic punctuation excluded). */
export function isArabicLetter(ch: string | undefined): boolean {
  return ch !== undefined && /^[ء-ي٠-٩ٮ-ۓۺ-ۿـ]$/.test(ch)
    ? !isArabicIndicDigit(ch)
    : false;
}

/**
 * Arabic-script word characters: letters, tatweel, harakat, superscript alef,
 * extended letters and presentation forms. Digits and Arabic punctuation
 * (، ؛ ؟ ٪ ٫ ٬) are not word characters.
 */
export function isArabicWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x0621 && c <= 0x065f) ||
    c === 0x0670 ||
    (c >= 0x0671 && c <= 0x06d3) ||
    c === 0x06d5 ||
    (c >= 0x06e5 && c <= 0x06e6) ||
    (c >= 0x06ee && c <= 0x06ef) ||
    (c >= 0x06fa && c <= 0x06ff) ||
    (c >= 0x0750 && c <= 0x077f) ||
    (c >= 0x08a0 && c <= 0x08ff) ||
    (c >= 0xfb50 && c <= 0xfdff) ||
    (c >= 0xfe70 && c <= 0xfefc)
  );
}

/**
 * Arabic letters that can name a variable in the Saudi curriculum (D-1, D-10):
 * س، ص، ع، أ، ب، جـ، د، هـ … The conjunction و is never a variable.
 */
const ARABIC_VARIABLE_LETTERS: ReadonlySet<string> = new Set([...'اأإآبتثجحخدذرزسشصضطظعغفقكلمنهي']);

export const TATWEEL = 'ـ';

export function isArabicVariableLetter(ch: string | undefined): boolean {
  return ch !== undefined && ARABIC_VARIABLE_LETTERS.has(ch);
}

/**
 * End offset of an isolated Arabic variable letter at `i` (a one-letter word,
 * optionally drawn out with tatweel: `هـ`, `جـ`), or -1. A letter inside a word
 * (`سين`, `لـسين`, `وص`) is never isolated.
 */
export function arabicLetterEnd(text: string, i: number): number {
  const ch = text[i];
  if (ch === undefined || !ARABIC_VARIABLE_LETTERS.has(ch)) return -1;
  if (isArabicWordChar(text[i - 1])) return -1;
  let end = i + 1;
  while (text[end] === TATWEEL) end += 1;
  return isArabicWordChar(text[end]) ? -1 : end;
}
