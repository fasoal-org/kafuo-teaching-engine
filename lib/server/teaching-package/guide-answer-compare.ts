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
 * - fractions: a vulgar fraction («½», «¾») and `\frac{a}{b}` read as «a/b», and a whole
 *   number before a proper fraction is a mixed number («3 1/2», «3½», `3\frac{1}{2}` = 3.5);
 * - number: equal within 1% (relative), or 5% when the guide answer is approximate
 *   (`approximate`, or «تقريب» in its unit); a written unit must match the guide's after
 *   normalization (the Arabic full names are aliases: «متر» = «م», «درجة» = «°»), and a
 *   missing written unit is accepted;
 * - choice: the same option letter, «أ/ب/ج/د» mapped to A–D;
 * - bool: the FIRST truth word decides («صحيحة/صواب/نعم» vs «خاطئة/خطأ/غير صحيحة/لا»), so
 *   «صحيحة، لا يوجد مثال مضاد» is true;
 * - text: the same after normalization (diacritics, tatweel, hamza and alef forms,
 *   «ة/ه», «ى/ي», case, spaces, punctuation), or contained as whole words.
 */
import type { KafuoTeacherGuideAnswer } from '@/lib/types/teaching-package';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/**
 * The vulgar fractions, each read as «a/b» after a space, so «3½» is the mixed «3 1/2».
 * (No blanket NFKC: it would read «م²» as «م2» and «3½» as «31⁄2».)
 */
const VULGAR_FRACTIONS: Readonly<Record<string, string>> = {
  '½': '1/2',
  '⅓': '1/3',
  '⅔': '2/3',
  '¼': '1/4',
  '¾': '3/4',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅐': '1/7',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⅑': '1/9',
  '⅒': '1/10',
};
const VULGAR_FRACTION = new RegExp(`[${Object.keys(VULGAR_FRACTIONS).join('')}]`, 'gu');
/** `\frac{a}{b}`, `\dfrac`, `\tfrac` with plain numbers: «a/b» after a space. */
const LATEX_FRACTION = /\\[dt]?frac\s*\{\s*(-?\d+(?:\.\d+)?)\s*\}\s*\{\s*(\d+(?:\.\d+)?)\s*\}/g;

/** Western digits, «٫»/«،»/«,» decimals, thousands separators out, «−» as «-», fractions as «a/b». */
export function normalizeGuideDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_INDIC.indexOf(digit)))
    .replace(VULGAR_FRACTION, (fraction) => ` ${VULGAR_FRACTIONS[fraction]}`)
    .replace(/⁄/g, '/')
    .replace(LATEX_FRACTION, ' $1/$2')
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
      .replace(/[«»"'“”()[\]{}:;؛!?؟،$]/g, ' ')
      // A point or comma is punctuation unless it sits between two digits (a decimal).
      .replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * A number token: a sign, an optional whole number before a fraction («3 1/2»), digits,
 * an optional decimal part, an optional «/b» fraction.
 */
const NUMBER =
  /(?<![\d.])(-|سالب\s*)?(?:(\d+)[^\S\n]+(?=\d+\s*\/\s*\d))?(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?(?![\d])/gu;

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
    const sign = match[1] ? -1 : 1;
    const whole = match[2] !== undefined ? Number(match[2]) : null;
    const numerator = Number(match[3]);
    const denominator = match[4] !== undefined ? Number(match[4]) : null;
    const end = (match.index ?? 0) + match[0].length;
    if (denominator === 0) continue;
    const fraction = denominator === null ? numerator : numerator / denominator;
    // A mixed number takes a proper fraction of whole numbers; otherwise the whole
    // number is its own token («3 5/2» reads 3, then 2.5).
    const mixed =
      whole !== null &&
      denominator !== null &&
      Number.isInteger(numerator) &&
      Number.isInteger(denominator) &&
      numerator < denominator;
    if (whole !== null && !mixed) {
      tokens.push({
        value: sign * whole,
        end: (match.index ?? 0) + match[0].indexOf(match[2]!) + match[2]!.length,
      });
      tokens.push({ value: fraction, end });
      continue;
    }
    tokens.push({ value: sign * ((whole ?? 0) + fraction), end });
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

/** Unit aliases, keyed by the normalized form (ة→ه, أ→ا, ى→ي; «²» reads «2»). */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  'ر س': 'ريال',
  رس: 'ريال',
  sar: 'ريال',
  'ريال سعودي': 'ريال',
  cm: 'سم',
  سنتيمتر: 'سم',
  سنتيمترات: 'سم',
  سنتمتر: 'سم',
  سنتمترات: 'سم',
  سانتيمتر: 'سم',
  m: 'م',
  متر: 'م',
  امتار: 'م',
  km: 'كم',
  كيلومتر: 'كم',
  كيلومترات: 'كم',
  mm: 'مم',
  ملم: 'مم',
  مليمتر: 'مم',
  ملليمتر: 'مم',
  مليمترات: 'مم',
  ملليمترات: 'مم',
  cm2: 'سم2',
  'سنتيمتر مربع': 'سم2',
  'سم مربع': 'سم2',
  m2: 'م2',
  'متر مربع': 'م2',
  'م مربع': 'م2',
  km2: 'كم2',
  'كيلومتر مربع': 'كم2',
  cm3: 'سم3',
  'سنتيمتر مكعب': 'سم3',
  m3: 'م3',
  'متر مكعب': 'م3',
  kg: 'كجم',
  كغ: 'كجم',
  كيلوجرام: 'كجم',
  كيلوغرام: 'كجم',
  كيلوجرامات: 'كجم',
  كيلوغرامات: 'كجم',
  g: 'جم',
  غ: 'جم',
  جرام: 'جم',
  غرام: 'جم',
  جرامات: 'جم',
  غرامات: 'جم',
  l: 'ل',
  لتر: 'ل',
  لترات: 'ل',
  ml: 'مل',
  مليلتر: 'مل',
  ملليلتر: 'مل',
  s: 'ث',
  ثانيه: 'ث',
  ثواني: 'ث',
  ثوان: 'ث',
  min: 'دقيقه',
  د: 'دقيقه',
  دقائق: 'دقيقه',
  h: 'ساعه',
  ساعات: 'ساعه',
  '°': '°',
  درجه: '°',
  درجات: '°',
  deg: '°',
  '%': '٪',
  بالمييه: '٪',
  بالميه: '٪',
  'في المييه': '٪',
  'في الميه': '٪',
};

/**
 * One unit word: its alias, else an accusative «ـًا» or a plural «ـات» dropped and that
 * form's alias («مترًا» → «م», «ريالات» → «ريال»).
 */
function unitWord(word: string): string {
  const alias = UNIT_ALIASES[word];
  if (alias !== undefined) return alias;
  if (word.length > 3 && word.endsWith('ات'))
    return UNIT_ALIASES[word.slice(0, -2)] ?? word.slice(0, -2);
  if (word.length > 3 && word.endsWith('ا'))
    return UNIT_ALIASES[word.slice(0, -1)] ?? word.slice(0, -1);
  return word;
}

/** A unit for comparison: normalized, aliased, an accusative «ـًا» or a plural ending dropped. */
export function normalizeGuideUnit(unit: string): string {
  const text = normalizeGuideText(unit.replace(/%/g, ' % ').replace(/°/g, ' ° '))
    .replace(/تقريبا/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const aliased = UNIT_ALIASES[text];
  if (aliased !== undefined) return aliased;
  return text.split(' ').map(unitWord).join(' ');
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

/** The two-word negations, read before a positive word at the same position. */
const FALSE_PHRASES = [
  'غير صحيح',
  'غير صحيحه',
  'ليس صحيحا',
  'ليس صحيح',
  'ليست صحيحه',
  'ليست صحيحا',
  'غير صائب',
  'not true',
  'not correct',
];
const FALSE_WORDS: ReadonlySet<string> = new Set(['خطا', 'خاطي', 'خاطيه', 'false']);
const TRUE_WORDS: ReadonlySet<string> = new Set(['صحيح', 'صحيحه', 'صواب', 'صح', 'true']);
/** «نعم» / «لا» answer only as the whole reply or its first word before a stop («لا، …»). */
const YES_NO = /^\s*(نعم|لا)\s*(?:[،,.:؛;!]|$)/u;

/**
 * A written truth value, or null. The FIRST truth word decides, a two-word negation
 * («غير صحيحة») before a positive word at the same position: «صحيحة، لا يوجد مثال
 * مضاد» is true, «التخمين غير صحيح» is false. A «لا» inside a sentence («لا يوجد») is
 * never a truth word.
 */
export function guideTruthValue(text: string): boolean | null {
  const yesNo = YES_NO.exec(text);
  if (yesNo) return yesNo[1] === 'نعم';
  const words = normalizeGuideText(text).split(' ');
  for (let index = 0; index < words.length; index += 1) {
    const pair = `${words[index]} ${words[index + 1] ?? ''}`;
    if (FALSE_PHRASES.includes(pair)) return false;
    if (TRUE_WORDS.has(words[index]!)) return true;
    if (FALSE_WORDS.has(words[index]!)) return false;
  }
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
 * state the approved answer, where the item's OWN question text (`bookText`: that item
 * only, its number or label removed, never the whole unit) does not already hold that
 * value (a given that equals the answer is not a leak)? Only numbers and text answers
 * leak here; a number only at its exact value; a text answer only on a line that
 * announces an answer («الإجابة», «الجواب», «الحل», «الناتج») or right after «=», since a
 * cycle or a word list shown as given data legitimately holds it. Choice letters and
 * truth values are {@link announcesGuideAnswer}'s.
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

interface Sentence {
  raw: string;
  /** The normalized text (`normalizeGuideText`). */
  text: string;
  asks: boolean;
}

/** «هل», a condition («إذا كانت صحيحة …») or "whether": the sentence states no value. */
const ASKS = /(?:^| )(?:هل|اذا|لو|ان كان|ان كانت|is it|whether|if)(?: |$)/u;

/** One sentence of spoken or shown text, with whether it asks (a «؟» / «?» or {@link ASKS}). */
function sentencesOf(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  for (const match of text.matchAll(/([^.!؟?؛;\n]+)([.!؟?؛;\n]*)/gu)) {
    const body = match[1]!.trim();
    if (body === '') continue;
    const normalized = normalizeGuideText(body);
    sentences.push({
      raw: body,
      text: normalized,
      asks: /[؟?]/u.test(match[2] ?? '') || ASKS.test(normalized),
    });
  }
  return sentences;
}

const LETTER_OF: Readonly<Record<string, string>> = { ا: 'A', ب: 'B', ج: 'C', د: 'D' };
/** Words that mark an announced answer or a correct option. */
const ANSWER_WORD =
  /(?:^| )(?:الاجابه|الجواب|الحل|الصحيح|الصحيحه|الصواب|answer|correct|right)(?: |$)/u;

/** The distinct option letters a sentence names: «ج», «(ب)», and a capital «C» not opening it. */
function namedLetters(raw: string, normalized: string): Set<string> {
  const letters = new Set<string>();
  for (const token of normalized.split(' ')) {
    if (LETTER_OF[token]) letters.add(LETTER_OF[token]!);
  }
  const start = raw.search(/\S/u);
  for (const match of raw.matchAll(/(?<![\p{L}\p{N}])([A-D])(?![\p{L}\p{N}])/gu)) {
    // A capital opening the sentence is English's article «A», never an option.
    if ((match.index ?? 0) !== start) letters.add(match[1]!);
  }
  return letters;
}

/** Stock phrases that name no truth value («اختر الإجابة الصحيحة», «صح أم خطأ»). */
const TRUTH_STOCK_PHRASES = [
  'الاجابه الصحيحه',
  'الاجابات الصحيحه',
  'الخيار الصحيح',
  'الاختيار الصحيح',
  'البديل الصحيح',
  'بشكل صحيح',
  'خطا شايع',
  'الخطا الشايع',
  'اخطاء شايعه',
  'الاخطاء الشايعه',
  'صح ام خطا',
  'صح او خطا',
  'صواب ام خطا',
  'صواب او خطا',
  'صحيحه ام خاطيه',
  'صحيحه او خاطيه',
  'correct answer',
  'right answer',
  'true or false',
];
const STATED_TRUE: ReadonlySet<string> = new Set(['صحيح', 'صحيحه', 'صحيحا', 'صواب', 'true']);
const STATED_FALSE: ReadonlySet<string> = new Set(['خطا', 'خاطي', 'خاطيه', 'خاطيا', 'false']);

/** The truth values a sentence states, its negations («غير صحيحة») read as false. */
function statedTruths(sentence: string): { true: boolean; false: boolean } {
  let text = ` ${sentence} `;
  for (const phrase of TRUTH_STOCK_PHRASES) text = text.split(` ${phrase} `).join(' ');
  const words = text.trim().split(' ');
  const found = { true: false, false: false };
  for (let index = 0; index < words.length; index += 1) {
    const pair = `${words[index]} ${words[index + 1] ?? ''}`;
    if (FALSE_PHRASES.includes(pair)) {
      found.false = true;
      index += 1;
    } else if (STATED_TRUE.has(words[index]!)) found.true = true;
    else if (STATED_FALSE.has(words[index]!)) found.false = true;
  }
  return found;
}

/**
 * The leak guard's test for a choice or a truth answer (review finding 1): does `text`
 * (a try-it slide or narration before the try) ANNOUNCE it? Reading the options aloud,
 * «اختر الإجابة الصحيحة», and a question («هل العبارة صحيحة أم خاطئة؟») never do.
 * - choice: a sentence naming exactly one option letter, the approved one, beside an
 *   answer word («الخيار ج هو الصحيح», «الإجابة: ب», "the answer is C");
 * - bool: a sentence stating only the approved truth value («العبارة خاطئة»).
 * Numbers and text answers are {@link leaksGuideAnswer}'s; they never announce here.
 */
export function announcesGuideAnswer(answer: KafuoTeacherGuideAnswer, text: string): boolean {
  if (answer.type !== 'choice' && answer.type !== 'bool') return false;
  const sentences = sentencesOf(text);
  if (answer.type === 'choice') {
    const expected = LETTER_OF[normalizeGuideText(answer.value)] ?? answer.value.toUpperCase();
    return sentences.some((sentence) => {
      const letters = namedLetters(sentence.raw, sentence.text);
      return (
        !sentence.asks &&
        letters.size === 1 &&
        letters.has(expected) &&
        ANSWER_WORD.test(sentence.text)
      );
    });
  }
  return sentences.some((sentence) => {
    if (sentence.asks) return false;
    const stated = statedTruths(sentence.text);
    return stated.true !== stated.false && stated.true === answer.value;
  });
}
