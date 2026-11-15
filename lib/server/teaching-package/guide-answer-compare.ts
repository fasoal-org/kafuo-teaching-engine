/**
 * g5.v11 (teacher-guide answer referee plan §6 "Comparison rules" and §8.3–8.5): the ONE
 * normalizer and comparator of a guide answer against a written answer. Pure, no model.
 * Its test vectors are a shared JSON fixture (`tests/fixtures/guide-answer-compare.v1.json`)
 * the backend's independent check (J7) can pin too.
 *
 * Rules:
 * - digits: Arabic-Indic and Eastern Arabic-Indic become Western; the Arabic decimal
 *   separator «٫», and «،» or «,» between digits (not followed by exactly three digits),
 *   is a decimal point; «٬» and a «,» before exactly three digits group thousands;
 * - number: equal within 1% (relative), or 5% when the guide answer is approximate
 *   (`approximate`, or «تقريب» in its unit); a written unit must match the guide's after
 *   normalization, and a missing written unit is accepted;
 * - choice: the same option letter, «أ/ب/ج/د» mapped to A–D;
 * - bool: the same truth value («صحيحة/صواب/نعم» vs «خاطئة/خطأ/غير صحيحة/لا»);
 * - text: the same after normalization (diacritics, tatweel, hamza and alef forms,
 *   «ة/ه», «ى/ي», case, spaces, punctuation), or contained as whole words.
 */
import type { KafuoTeacherGuideAnswer } from '@/lib/types/teaching-package';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Western digits, «٫»/«،»/«,» decimals, thousands separators out, «−» as «-». */
export function normalizeGuideDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_INDIC.indexOf(digit)))
    .replace(/[−‒–]/g, '-')
    .replace(/(\d)٬(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)[٫،,](?=\d)/g, '$1.');
}

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Text for comparison: digits as above, no diacritics or tatweel, one alef/ya/ha form. */
export function normalizeGuideText(text: string): string {
  return (
    normalizeGuideDigits(text)
      .normalize('NFKC')
      .replace(DIACRITICS, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .toLowerCase()
      .replace(/[«»"'“”()[\]{}:;؛!?؟،]/g, ' ')
      // A point or comma is punctuation unless it sits between two digits (a decimal).
      .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** A number token: a sign, digits, an optional decimal part, an optional «/b» fraction. */
const NUMBER = /(?<![\d.])(-|سالب\s*)?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?(?![\d])/gu;

export interface GuideNumberToken {
  value: number;
  /** Where the token ends in the normalized text. */
  end: number;
}

/** Every number of a text, in order (digits normalized first). */
export function guideNumbers(text: string): GuideNumberToken[] {
  const normalized = normalizeGuideDigits(text);
  const tokens: GuideNumberToken[] = [];
  for (const match of normalized.matchAll(NUMBER)) {
    const numerator = Number(match[2]);
    const denominator = match[3] !== undefined ? Number(match[3]) : null;
    if (denominator === 0) continue;
    const magnitude = denominator === null ? numerator : numerator / denominator;
    tokens.push({
      value: match[1] ? -magnitude : magnitude,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return tokens;
}

function tolerance(answer: Extract<KafuoTeacherGuideAnswer, { type: 'number' }>): number {
  return answer.approximate === true || /تقريب/u.test(answer.unit ?? '') ? 0.05 : 0.01;
}

/** Equal within the relative tolerance (an answer of zero needs an exact zero). */
export function numbersAgree(expected: number, written: number, relative: number): boolean {
  const scale = Math.max(Math.abs(expected), Math.abs(written));
  if (scale === 0) return true;
  return Math.abs(expected - written) <= relative * scale + 1e-12;
}

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  'ر س': 'ريال',
  رس: 'ريال',
  sar: 'ريال',
  cm: 'سم',
  m: 'م',
  km: 'كم',
  mm: 'مم',
  kg: 'كجم',
  g: 'جم',
  s: 'ث',
  min: 'دقيقه',
  h: 'ساعه',
  '%': '٪',
  بالمييه: '٪',
  بالميه: '٪',
};

/** A unit for comparison: normalized, aliased, an accusative «ـًا» or a plural ending dropped. */
export function normalizeGuideUnit(unit: string): string {
  const text = normalizeGuideText(unit.replace(/%/g, ' % '))
    .replace(/تقريبا/g, '')
    .trim();
  const aliased = UNIT_ALIASES[text] ?? text;
  return aliased
    .split(' ')
    .map((word) => {
      if (word.length > 3 && word.endsWith('ات')) return word.slice(0, -2);
      if (word.length > 3 && word.endsWith('ا')) return word.slice(0, -1);
      return UNIT_ALIASES[word] ?? word;
    })
    .join(' ');
}

function unitsAgree(expected: string, written: string): boolean {
  const a = normalizeGuideUnit(expected);
  const b = normalizeGuideUnit(written);
  if (a === '' || b === '' || a === b) return true;
  // A unit and a following word («ريال لكل شهر»): the written text starts with the unit.
  return b.startsWith(`${a} `) || a.split(' ').every((word) => b.split(' ').includes(word));
}

const ARABIC_CHOICE: Readonly<Record<string, string>> = { ا: 'A', ب: 'B', ج: 'C', د: 'D' };

/** An option letter, A–D: «ج» → C, «(c)» → C; null when the text names no single letter. */
export function guideChoiceLetter(text: string): string | null {
  const normalized = normalizeGuideText(text);
  const tokens = normalized.split(' ').filter((token) => /^(?:[a-d]|[ابجد])$/u.test(token));
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  return ARABIC_CHOICE[last] ?? last.toUpperCase();
}

const FALSE_WORDS = [
  'غير صحيح',
  'غير صحيحه',
  'ليس صحيحا',
  'ليست صحيحه',
  'خطا',
  'خاطي',
  'خاطيه',
  'false',
  'لا',
];
const TRUE_WORDS = ['صحيح', 'صحيحه', 'صواب', 'نعم', 'صح', 'true'];

/** A written truth value, or null. Negations are read before the positive words. */
export function guideTruthValue(text: string): boolean | null {
  const normalized = ` ${normalizeGuideText(text)} `;
  if (FALSE_WORDS.some((word) => normalized.includes(` ${word} `))) return false;
  if (TRUE_WORDS.some((word) => normalized.includes(` ${word} `))) return true;
  return null;
}

/** Whole-word containment of normalized text. */
function containsWords(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

export interface GuideComparison {
  match: boolean;
  /** Why not, in a few words (for the log and the fix note); absent on a match. */
  reason?: string;
}

/**
 * Compare a written final answer (a final line's value, or an option label) with the
 * approved guide answer. A number is read as the LAST number of the written text, so
 * «الإنتاج في 1440 هو 71.9» reads 71.9.
 */
export function compareGuideAnswer(
  answer: KafuoTeacherGuideAnswer,
  written: string,
): GuideComparison {
  switch (answer.type) {
    case 'number': {
      const numbers = guideNumbers(written);
      const last = numbers[numbers.length - 1];
      if (!last) return { match: false, reason: 'no number' };
      if (!numbersAgree(answer.value, last.value, tolerance(answer))) {
        return { match: false, reason: `${last.value} is not ${answer.value}` };
      }
      if (answer.unit) {
        const after = normalizeGuideDigits(written).slice(last.end).trim();
        if (after !== '' && !unitsAgree(answer.unit, after)) {
          return { match: false, reason: `unit «${after}» is not «${answer.unit}»` };
        }
      }
      return { match: true };
    }
    case 'choice': {
      const expected =
        ARABIC_CHOICE[normalizeGuideText(answer.value)] ?? answer.value.toUpperCase();
      const letter = guideChoiceLetter(written);
      if (letter === null) return { match: false, reason: 'no option letter' };
      return letter === expected
        ? { match: true }
        : { match: false, reason: `option ${letter} is not ${expected}` };
    }
    case 'bool': {
      const value = guideTruthValue(written);
      if (value === null) return { match: false, reason: 'no truth value' };
      return value === answer.value
        ? { match: true }
        : { match: false, reason: `${value} is not ${answer.value}` };
    }
    case 'text': {
      const expected = normalizeGuideText(answer.value);
      const got = normalizeGuideText(written);
      return got === expected || containsWords(got, expected)
        ? { match: true }
        : { match: false, reason: `«${written.trim()}» is not «${answer.value}»` };
    }
  }
}

/**
 * The leak guard's test: does `text` (a try-it slide, its narration, an attempt stem)
 * state the approved answer, where the item's own book question does not already hold
 * that value (a given that equals the answer is not a leak)? Only numbers and text
 * answers can leak; a number only at its exact value; a text answer only on a line that
 * announces an answer («الإجابة», «الجواب», «الحل», «الناتج») or right after «=», since a
 * cycle or a word list shown as given data legitimately holds it. Choice letters and
 * truth values are never checked.
 */
export function leaksGuideAnswer(
  answer: KafuoTeacherGuideAnswer,
  text: string,
  bookText = '',
): boolean {
  if (answer.type === 'number') {
    // A slide is searched, not graded: only the exact value counts (the 1%/5% window would
    // flag nearby givens and cost a regeneration, then a dropped check).
    const agrees = (token: GuideNumberToken) => Math.abs(token.value - answer.value) < 1e-9;
    if (guideNumbers(bookText).some(agrees)) return false;
    return guideNumbers(text).some(agrees);
  }
  if (answer.type !== 'text') return false;
  const expected = normalizeGuideText(answer.value);
  if (containsWords(normalizeGuideText(bookText), expected)) return false;
  // «= شوال» announces it; «شوال = 10» (a numbered cycle given as data, item 208) does not.
  const afterEquals = (line: string) =>
    line
      .split('=')
      .slice(1)
      .some((part) => {
        const value = part.trim();
        return value === expected || value.startsWith(`${expected} `);
      });
  return text
    .split('\n')
    .map(normalizeGuideText)
    .some(
      (line) =>
        (/(?:^| )(?:الاجابه|الجواب|الحل|الناتج)(?: |$)/u.test(line) &&
          containsWords(line, expected)) ||
        afterEquals(line),
    );
}
