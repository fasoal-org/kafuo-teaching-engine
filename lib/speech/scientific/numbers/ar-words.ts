/**
 * Deterministic Arabic number-to-words (masculine, in the «اثنين» register of
 * O-1: the oblique forms «اثنين، اثني عشر، عشرين، مئتين، ألفين» that Saudi
 * classrooms speak), used when the policy's `numbersMode` is `'words'` (the §10.1
 * contingency held behind a switch until the H3 review decides it). Pure.
 *
 * Coverage: integers 0 … 999,999,999,999 and decimals (the fractional digits
 * are read as one number after «فاصلة», with each leading zero read as «صفر»).
 * Anything outside that range returns `null` and the caller keeps the digits.
 */

const ONES = [
  'صفر',
  'واحد',
  'اثنين',
  'ثلاثة',
  'أربعة',
  'خمسة',
  'ستة',
  'سبعة',
  'ثمانية',
  'تسعة',
];
const TEENS = [
  'عشرة',
  'أحد عشر',
  'اثني عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];
const TENS = ['', '', 'عشرين', 'ثلاثين', 'أربعين', 'خمسين', 'ستين', 'سبعين', 'ثمانين', 'تسعين'];
const HUNDREDS = [
  '',
  'مئة',
  'مئتين',
  'ثلاثمئة',
  'أربعمئة',
  'خمسمئة',
  'ستمئة',
  'سبعمئة',
  'ثمانمئة',
  'تسعمئة',
];

interface Scale {
  value: number;
  one: string;
  two: string;
  plural: string;
  accusative: string;
}

const SCALES: Scale[] = [
  { value: 1e9, one: 'مليار', two: 'مليارين', plural: 'مليارات', accusative: 'مليارًا' },
  { value: 1e6, one: 'مليون', two: 'مليونين', plural: 'ملايين', accusative: 'مليونًا' },
  { value: 1e3, one: 'ألف', two: 'ألفين', plural: 'آلاف', accusative: 'ألفًا' },
];

/** 1 … 999, joined with «و». */
function belowThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(HUNDREDS[h]!);
  if (rest > 0) {
    if (rest < 10) parts.push(ONES[rest]!);
    else if (rest < 20) parts.push(TEENS[rest - 10]!);
    else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      parts.push(o === 0 ? TENS[t]! : `${ONES[o]} و${TENS[t]}`);
    }
  }
  return parts.join(' و');
}

function scaled(count: number, scale: Scale): string {
  if (count === 1) return scale.one;
  if (count === 2) return scale.two;
  if (count >= 3 && count <= 10) return `${belowThousand(count)} ${scale.plural}`;
  const rest = count % 100;
  // 11–99 (and x11–x99) take the accusative singular; round hundreds the genitive.
  if (rest >= 11) return `${belowThousand(count)} ${scale.accusative}`;
  return `${belowThousand(count)} ${scale.one}`;
}

/** Integer to words, or `null` when out of range. */
export function integerToArabicWords(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1e12) return null;
  if (value === 0) return ONES[0]!;
  const parts: string[] = [];
  let rest = value;
  for (const scale of SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count > 0) {
      parts.push(scaled(count, scale));
      rest %= scale.value;
    }
  }
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(' و');
}

/**
 * Reads an authored number given as its integer digits and optional fractional
 * digits (already stripped of group separators). `decimalWord` is the policy's
 * word for the separator («فاصلة»).
 */
export function numberToArabicWords(
  integerDigits: number,
  fractionDigits: string | null,
  decimalWord: string,
): string | null {
  const whole = integerToArabicWords(integerDigits);
  if (whole === null) return null;
  if (fractionDigits === null || fractionDigits === '') return whole;
  const zeros = /^0*/.exec(fractionDigits)![0].length;
  const tail = fractionDigits.slice(zeros);
  const words: string[] = Array.from({ length: zeros }, () => ONES[0]!);
  if (tail.length > 0) {
    if (tail.length > 12) return null;
    const tailWords = integerToArabicWords(Number(tail));
    if (tailWords === null) return null;
    words.push(tailWords);
  }
  return `${whole} ${decimalWord} ${words.join(' ')}`;
}
