/**
 * g5.v11 (teacher-guide answer referee plan §6 "Comparison rules" and §8.3–8.5): the ONE
 * normalizer and comparator of a guide answer against a written answer. Pure, no model.
 * Its test vectors are a shared JSON fixture (`tests/fixtures/guide-answer-compare.v1.json`)
 * the backend's independent check (J7) can pin too.
 *
 * Rules:
 * - digits: Arabic-Indic and Eastern Arabic-Indic become Western; the Arabic decimal
 *   separator «٫», and «،» between digits, is a decimal point; «٬» groups thousands;
 * - an ASCII «,» between digits is a decimal point unless exactly three digits follow it.
 *   Then the context decides (re-review finding 4): several groups («1,234,567»), a
 *   decimal tail («1,250.5»), a «.» decimal elsewhere in the text, or a group ending in
 *   0 («1,000») group thousands; a lead of 0 or of four digits («0,125»), or a «,»
 *   decimal elsewhere, is a decimal point; otherwise («3,142») it reads both ways;
 * - a space before groups of exactly three digits («1 250») groups thousands, unless the
 *   lead is 0 or the text lists numbers with bare spaces elsewhere (then both ways);
 * - a number that reads both ways and gives two verdicts cannot be compared: it is
 *   `undecided`, never a mismatch;
 * - fractions: a vulgar fraction («½», «¾») and `\frac{a}{b}` read as «a/b», and a whole
 *   number before a proper fraction is a mixed number («3 1/2», «3½», `3\frac{1}{2}` = 3.5);
 * - number: equal within 1% (relative), or 5% when the guide answer is approximate
 *   (`approximate`, or «تقريب» in its unit); the written answer is the LAST number that
 *   is not part of a date («عام ١٤٤٠», «١٤٤٠هـ»), a page («ص 48») or a reference
 *   («المثال 3», «س11», «2A»); a written unit must match the guide's after
 *   normalization (the Arabic full names are aliases: «متر» = «م», «درجة» = «°», and a
 *   joined unit is looked up again: «سنتيمترًا مربعًا» = «سم²»), and a missing written
 *   unit is accepted;
 * - choice: the same option letter, «أ/ب/ج/د» mapped to A–D;
 * - bool: the FIRST truth word decides («صحيحة/صحيحًا/صواب/صائبة/نعم» vs
 *   «خاطئة/خاطئًا/خطأ/غير صحيحة/لا»), so «صحيحة، لا يوجد مثال مضاد» is true;
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

/** Western digits, fractions as «a/b», «−» as «-», «٬» thousands out (no «,» decided). */
function digitForms(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_INDIC.indexOf(digit)))
    .replace(VULGAR_FRACTION, (fraction) => ` ${VULGAR_FRACTIONS[fraction]}`)
    .replace(/⁄/g, '/')
    .replace(LATEX_FRACTION, ' $1/$2')
    .replace(/[−‒–]/g, '-')
    .replace(/(\d)٬(?=\d{3}(?!\d))/g, '$1');
}

/** Western digits, «٫»/«،»/«,» decimals, thousands separators out, «−» as «-», fractions as «a/b». */
export function normalizeGuideDigits(text: string): string {
  return digitForms(text)
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)[٫،,](?=\d)/g, '$1.');
}

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Marks and tatweel out; alef, ta marbuta and alef maqsura folded (the cue words' forms). */
function foldLetters(text: string): string {
  return text
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

/** Digit groups joined by ASCII commas, with an optional decimal tail («1,250.75»). */
const COMMA_RUN = /(?<![\d.,])(\d+)((?:,\d+)+)(\.\d+)?/g;
/** Groups of exactly three digits after a space («1 250», «1 250 000»), never a mixed number. */
const SPACE_RUN = /(?<![\d.,])(\d{1,3})((?:[    ]\d{3})+)(?!\d)(?![^\S\n]*\/[^\S\n]*\d)/gu;
/** A no-break or thin space only ever groups thousands. */
const GROUPING_SPACE = /[   ]/u;
/** A mixed number («3 1/2»): its space is never a list. */
const MIXED_NUMBER = /\d+[^\S\n]+\d+[^\S\n]*\/[^\S\n]*\d+/g;

/**
 * Re-review finding 4: the readings of a text's numbers, each a normalized text (Western
 * digits, «.» decimals, no thousands separators, no marks, letters folded). One
 * reading when every separator is decided by its context; two (thousands first, then
 * decimal or separate) when one is not («3,142», or «1 250» beside a bare-space list).
 */
export function guideNumberReadings(text: string): string[] {
  const base = foldLetters(digitForms(text)).replace(/(\d)[٫،](?=\d)/g, '$1.');
  const runs = [...base.matchAll(COMMA_RUN)];
  const pointDecimal = /\d\.\d/.test(base.replace(COMMA_RUN, ' '));
  const commaDecimal = runs.some((run) =>
    run[2]!
      .split(',')
      .slice(1)
      .some((group) => group.length !== 3),
  );
  let ambiguous = false;
  const commas = (thousands: boolean) =>
    base.replace(COMMA_RUN, (_all, lead: string, rest: string, tail: string | undefined) => {
      const groups = rest.split(',').slice(1);
      const end = tail ?? '';
      if (groups.length >= 2) {
        // «1,234,567»; any other run keeps the per-comma rule of `normalizeGuideDigits`.
        if (lead.length <= 3 && groups.every((group) => group.length === 3)) {
          return `${lead}${groups.join('')}${end}`;
        }
        return `${lead}${rest}${end}`
          .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
          .replace(/(\d),(?=\d)/g, '$1.');
      }
      const group = groups[0]!;
      const asThousands = `${lead}${group}${end}`;
      const asDecimal = `${lead}.${group}${end}`;
      if (group.length !== 3) return asDecimal;
      if (end !== '') return asThousands;
      if (lead.length >= 4 || lead.startsWith('0')) return asDecimal;
      if (pointDecimal !== commaDecimal) return pointDecimal ? asThousands : asDecimal;
      // A decimal drops its trailing zero: «1,000» and «2,500» group thousands.
      if (group.endsWith('0')) return asThousands;
      ambiguous = true;
      return thousands ? asThousands : asDecimal;
    });
  const spaces = (source: string, grouped: boolean) => {
    // A bare space between two numbers that cannot group them: the text lists with spaces.
    const listed = /\d[^\S\n]+\d/.test(source.replace(SPACE_RUN, ' ').replace(MIXED_NUMBER, ' '));
    return source.replace(SPACE_RUN, (all, lead: string, rest: string) => {
      if (lead.startsWith('0')) return all;
      const joined = `${lead}${rest.replace(/\D/g, '')}`;
      if (GROUPING_SPACE.test(rest) || !listed) return joined;
      ambiguous = true;
      return grouped ? joined : all;
    });
  };
  const first = spaces(commas(true), true);
  if (!ambiguous) return [first];
  const second = spaces(commas(false), false);
  return second === first ? [first] : [first, second];
}

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

/**
 * What a number is in its text (re-review finding 4): the answer's `value`, or part of a
 * `date` («عام ١٤٤٠», «١٤٤٠هـ», «16/11/2026»), a `page` («ص 48») or a `reference`
 * («المثال 3», «تمرين 11»), or an item `label` («2A», «1ب», «س11»).
 */
export type GuideNumberKind = 'value' | 'label' | 'date' | 'page' | 'reference';

export interface GuideNumberToken {
  value: number;
  /** Where the token starts and ends in its reading (`guideNumberReadings`). */
  start: number;
  end: number;
  kind: GuideNumberKind;
  /** Where its cue word («عام», «ص», «المثال», «س») starts; `start` for a value. */
  cueStart: number;
}

/** A cue word right before a number, a preposition or «و/ب/ل/ف» and «ال» allowed. */
function cueBefore(words: string): RegExp {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])((?:(?:في|من|منذ|حتي|الي|خلال|عن)[^\\S\\n]+)?[وبلف]?(?:ال)?(?:${words}))\\.?[^\\S\\n]*(?:رقم[^\\S\\n]*)?[(:#]?[^\\S\\n]*$`,
    'iu',
  );
}
/** Folded forms («سنة» → «سنه», «أمثلة» → «امثله»): `guideNumberReadings` folds letters. */
const DATE_CUE = cueBefore('عام|عامي|سنه|سنتي|year');
const PAGE_CUE = cueBefore('ص|صفحه|صفحات|page|pp|p');
const REFERENCE_CUE = cueBefore(
  'مثال|مثالان|مثالين|امثله|تمرين|تمرينين|تمارين|سؤال|سؤالين|اسئله|مساله|شكل|اشكال|جدول|درس|بند|فقره|فصل|وحده|example|exercise|question|figure|fig|table|lesson|ex|q',
);
/** «س11», «(س 11)»: a question label. */
const LABEL_BEFORE = /(?:^|[^\p{L}\p{N}])(س)[^\S\n]?$/u;
/** «2A», «1ب», «11b», «2 A)»: an item label. */
const LABEL_AFTER = /^(?:(?:[A-H]|[a-d]|[ابجد])(?![\p{L}\p{N}])|[^\S\n][A-H](?=[^\S\n]*\)))/u;
/** «١٤٤٠هـ» (folded «1440ه»): a Hijri year. */
const HIJRI_AFTER = /^[^\S\n]?ه(?!\p{L})/u;
const SLASH_DATE = /(?<![\d.])\d{1,2}\/\d{1,2}\/\d{2,4}(?!\d)/g;
/** What joins a run of numbers under one cue («1-5», «3 و 4», «1439، 1440»). */
const RUN_JOINER = /^[^\S\n]*(?:[-–,،/&]|و|او|الي|حتي)[^\S\n]*$/u;

function cueStartOf(pattern: RegExp, before: string, start: number): number | null {
  const match = pattern.exec(before);
  if (!match) return null;
  return start - before.length + (match.index ?? 0) + match[0].indexOf(match[1]!);
}

/** The tokens of one reading, each with what it is in its text. */
function readingTokens(reading: string): GuideNumberToken[] {
  const tokens: GuideNumberToken[] = [];
  for (const match of reading.matchAll(NUMBER)) {
    const index = match.index ?? 0;
    const sign = match[1] ? -1 : 1;
    const whole = match[2] !== undefined ? Number(match[2]) : null;
    const numerator = Number(match[3]);
    const denominator = match[4] !== undefined ? Number(match[4]) : null;
    const end = index + match[0].length;
    if (denominator === 0) continue;
    const fraction = denominator === null ? numerator : numerator / denominator;
    const token = (value: number, start: number, until: number): GuideNumberToken => ({
      value,
      start,
      end: until,
      kind: 'value',
      cueStart: start,
    });
    // A mixed number takes a proper fraction of whole numbers; otherwise the whole
    // number is its own token («3 5/2» reads 3, then 2.5).
    const mixed =
      whole !== null &&
      denominator !== null &&
      Number.isInteger(numerator) &&
      Number.isInteger(denominator) &&
      numerator < denominator;
    if (whole !== null && !mixed) {
      const wholeEnd = index + match[0].indexOf(match[2]!) + match[2]!.length;
      tokens.push(token(sign * whole, index, wholeEnd));
      tokens.push(token(fraction, index + match[0].indexOf(match[3]!, wholeEnd - index), end));
      continue;
    }
    tokens.push(token(sign * ((whole ?? 0) + fraction), index, end));
  }
  const dates = [...reading.matchAll(SLASH_DATE)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  let previous: GuideNumberToken | undefined;
  for (const token of tokens) {
    const before = reading.slice(Math.max(0, token.start - 48), token.start);
    const after = reading.slice(token.end, token.end + 4);
    const date = dates.find((range) => token.start >= range.start && token.start < range.end);
    const labelCue = cueStartOf(LABEL_BEFORE, before, token.start);
    const dateCue = cueStartOf(DATE_CUE, before, token.start);
    const pageCue = cueStartOf(PAGE_CUE, before, token.start);
    const referenceCue = cueStartOf(REFERENCE_CUE, before, token.start);
    if (date) Object.assign(token, { kind: 'date', cueStart: date.start });
    else if (LABEL_AFTER.test(after)) token.kind = 'label';
    else if (labelCue !== null) Object.assign(token, { kind: 'label', cueStart: labelCue });
    else if (dateCue !== null) Object.assign(token, { kind: 'date', cueStart: dateCue });
    else if (Number.isInteger(token.value) && token.value >= 100 && HIJRI_AFTER.test(after)) {
      token.kind = 'date';
    } else if (pageCue !== null) Object.assign(token, { kind: 'page', cueStart: pageCue });
    else if (referenceCue !== null) {
      Object.assign(token, { kind: 'reference', cueStart: referenceCue });
    } else if (
      previous &&
      previous.kind !== 'value' &&
      previous.kind !== 'label' &&
      RUN_JOINER.test(reading.slice(previous.end, token.start))
    ) {
      Object.assign(token, { kind: previous.kind, cueStart: previous.cueStart });
    }
    previous = token;
  }
  return tokens;
}

/** Every number of a text, in order, from its first reading (digits normalized first). */
export function guideNumbers(text: string): GuideNumberToken[] {
  return readingTokens(guideNumberReadings(text)[0]!);
}

/** The answer's candidates: the values, or every number when the text has no value. */
function answerTokens(tokens: readonly GuideNumberToken[]): readonly GuideNumberToken[] {
  const values = tokens.filter((token) => token.kind === 'value');
  return values.length > 0 ? values : tokens;
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
  'كم مربع': 'كم2',
  cm3: 'سم3',
  'سنتيمتر مكعب': 'سم3',
  'سم مكعب': 'سم3',
  m3: 'م3',
  'متر مكعب': 'م3',
  'م مكعب': 'م3',
  // The feminine of «مربع» and «مكعب», so a joined unit is looked up again.
  مربعه: 'مربع',
  مكعبه: 'مكعب',
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
  // Re-review finding 4: the words aliased one by one are looked up again as a whole
  // («سنتيمترًا مربعًا» → «سم مربع» → «سم2»).
  const words = text.split(' ').map(unitWord).join(' ');
  return UNIT_ALIASES[words] ?? words;
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

/** The two-word negations (normalized: «ئ» reads «ي»), read before a positive word. */
const FALSE_PHRASES = [
  'غير صحيح',
  'غير صحيحه',
  'ليس صحيحا',
  'ليس صحيح',
  'ليست صحيحه',
  'ليست صحيحا',
  'غير صايب',
  'غير صايبه',
  'ليس صايبا',
  'ليست صايبه',
  'not true',
  'not correct',
];
// Re-review finding 4: the accusative («صحيحًا», «خاطئًا») and feminine forms too.
const FALSE_WORDS: ReadonlySet<string> = new Set(['خطا', 'خاطي', 'خاطيه', 'خاطيا', 'false']);
const TRUE_WORDS: ReadonlySet<string> = new Set([
  'صحيح',
  'صحيحه',
  'صحيحا',
  'صواب',
  'صوابا',
  'صح',
  'صايب',
  'صايبه',
  'صايبا',
  'true',
]);
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
  /**
   * Re-review finding 4: the written number reads two ways that give two verdicts
   * («3,142»): it cannot be compared, which is never a mismatch. Only with `match: false`.
   */
  undecided?: true;
  /** Why not, in a few words (for the log and the fix note); absent on a match. */
  reason?: string;
}

type NumberAnswer = Extract<KafuoTeacherGuideAnswer, { type: 'number' }>;

/** One reading's verdict: its LAST answer number, then the unit right after it. */
function numberVerdict(answer: NumberAnswer, reading: string): GuideComparison {
  const tokens = readingTokens(reading);
  const candidates = answerTokens(tokens);
  const last = candidates[candidates.length - 1];
  if (!last) return { match: false, reason: 'no number' };
  if (!numbersAgree(answer.value, last.value, tolerance(answer))) {
    return { match: false, reason: `${last.value} is not ${answer.value}` };
  }
  if (answer.unit) {
    // The unit is the text up to the next number, or the cue of a date, page or
    // reference after it («71.9 مليون ريال في عام 1440»).
    const next = tokens.find((token) => token.start >= last.end);
    const stop = next ? (next.kind === 'value' ? next.start : next.cueStart) : reading.length;
    const after = reading.slice(last.end, Math.max(stop, last.end)).trim();
    if (after !== '' && !unitsAgree(answer.unit, after)) {
      return { match: false, reason: `unit «${after}» is not «${answer.unit}»` };
    }
  }
  return { match: true };
}

/**
 * Compare a written final answer (a final line's value, or an option label) with the
 * approved guide answer. A number is read as the LAST number of the written text that
 * is not part of a date, a page or a reference, so «الإنتاج في 1440 هو 71.9» and «71.9
 * في عام 1440» both read 71.9.
 */
export function compareGuideAnswer(
  answer: KafuoTeacherGuideAnswer,
  written: string,
): GuideComparison {
  switch (answer.type) {
    case 'number': {
      const verdicts = guideNumberReadings(written).map((reading) =>
        numberVerdict(answer, reading),
      );
      const first = verdicts[0]!;
      if (verdicts.every((verdict) => verdict.match === first.match)) return first;
      return {
        match: false,
        undecided: true,
        reason: 'the written number reads two ways (a thousands or a decimal separator)',
      };
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

// ── Numbers said in Arabic words (re-review finding 4) ────────────────────────────────

/** 0–9, masculine and feminine, as `normalizeGuideText` writes them («ثلاثة» → «ثلاثه»). */
const WORD_UNITS: Readonly<Record<string, number>> = {
  صفر: 0,
  واحد: 1,
  واحده: 1,
  اثنان: 2,
  اثنين: 2,
  اثنتان: 2,
  اثنتين: 2,
  ثلاثه: 3,
  ثلاث: 3,
  اربعه: 4,
  اربع: 4,
  خمسه: 5,
  خمس: 5,
  سته: 6,
  ست: 6,
  سبعه: 7,
  سبع: 7,
  ثمانيه: 8,
  ثماني: 8,
  ثمان: 8,
  تسعه: 9,
  تسع: 9,
};
/** The first word of 11 and 12 («أحد عشر», «إحدى عشرة», «اثنا عشر», «اثنتي عشرة»). */
const WORD_TEEN_LEADS: Readonly<Record<string, number>> = {
  احد: 1,
  احدي: 1,
  اثنا: 2,
  اثني: 2,
  اثنتا: 2,
  اثنتي: 2,
};
const WORD_TEN: ReadonlySet<string> = new Set(['عشر', 'عشره']);
const WORD_TENS: Readonly<Record<string, number>> = {
  عشرون: 20,
  عشرين: 20,
  ثلاثون: 30,
  ثلاثين: 30,
  اربعون: 40,
  اربعين: 40,
  خمسون: 50,
  خمسين: 50,
  ستون: 60,
  ستين: 60,
  سبعون: 70,
  سبعين: 70,
  ثمانون: 80,
  ثمانين: 80,
  تسعون: 90,
  تسعين: 90,
};
/** «مئة/مائة» («ئ» reads «ي»), «مئتان», and «ثلاثمئة» … «تسعمائة» written as one word. */
const WORD_HUNDREDS: Readonly<Record<string, number>> = (() => {
  const hundreds: Record<string, number> = {
    مايه: 100,
    ميه: 100,
    مايتان: 200,
    مايتين: 200,
    مايتا: 200,
    ميتان: 200,
    ميتين: 200,
    ميتا: 200,
  };
  const stems: ReadonlyArray<readonly [string, number]> = [
    ['ثلاث', 3],
    ['اربع', 4],
    ['خمس', 5],
    ['ست', 6],
    ['سبع', 7],
    ['ثمان', 8],
    ['ثماني', 8],
    ['تسع', 9],
  ];
  for (const [stem, value] of stems) {
    hundreds[`${stem}مايه`] = value * 100;
    hundreds[`${stem}ميه`] = value * 100;
  }
  return hundreds;
})();
const WORD_THOUSANDS: Readonly<Record<string, number>> = {
  الف: 1000,
  الفان: 2000,
  الفين: 2000,
  الفا: 2000,
};
/** «آلاف» after 3–10 («ثلاثة آلاف»), «أرباع» after three («ثلاثة أرباع»). */
const WORD_THOUSANDS_PLURAL = 'الاف';
const WORD_QUARTERS = 'ارباع';
const WORD_FRACTIONS: Readonly<Record<string, number>> = {
  نصف: 0.5,
  ربع: 0.25,
  ثلث: 1 / 3,
  ثلثان: 2 / 3,
  ثلثين: 2 / 3,
  ثلثا: 2 / 3,
  ثلثي: 2 / 3,
};

type WordAtom =
  | { kind: 'unit' | 'teen_lead' | 'tens' | 'hundred' | 'thousand' | 'fraction'; value: number }
  | { kind: 'ten'; value: 10 };

function wordAtom(word: string): WordAtom | null {
  const of = (
    table: Readonly<Record<string, number>>,
    kind: Exclude<WordAtom['kind'], 'ten'>,
  ): WordAtom | null =>
    Object.prototype.hasOwnProperty.call(table, word) ? { kind, value: table[word]! } : null;
  if (WORD_TEN.has(word)) return { kind: 'ten', value: 10 };
  return (
    of(WORD_UNITS, 'unit') ??
    of(WORD_TEEN_LEADS, 'teen_lead') ??
    of(WORD_TENS, 'tens') ??
    of(WORD_HUNDREDS, 'hundred') ??
    of(WORD_THOUSANDS, 'thousand') ??
    of(WORD_FRACTIONS, 'fraction')
  );
}

/** A number word with its prefixes: «و» (a join), then «ال», «بال», «لل», «ب», «ل» … */
function numberWord(word: string): { atom: WordAtom; joined: boolean } | null {
  const direct = wordAtom(word);
  if (direct) return { atom: direct, joined: false };
  const joined = word.startsWith('و');
  const rest = joined ? word.slice(1) : word;
  if (joined) {
    const atom = wordAtom(rest);
    if (atom) return { atom, joined };
  }
  for (const prefix of ['بال', 'لل', 'فال', 'كال', 'ال', 'ب', 'ل', 'ك', 'ف']) {
    if (!rest.startsWith(prefix)) continue;
    const stem = rest.slice(prefix.length);
    // «لست» is «I am not», never «ل» + six.
    if (stem.length < (prefix.length === 1 ? 4 : 3)) continue;
    const atom = wordAtom(stem);
    if (atom) return { atom, joined };
  }
  return null;
}

/** The places of a composite, highest first; a teen fills the units and the tens. */
const PLACE = { thousands: 5, hundreds: 4, units: 3, tens: 2, fraction: 0 } as const;

interface WordPart {
  value: number;
  place: number;
  teen?: true;
}

/** One part at `index`: a word, or a unit with «عشر», «مئة», «آلاف» or «أرباع». */
function wordPart(
  words: readonly string[],
  index: number,
): { part: WordPart; joined: boolean; used: number } | null {
  const read = numberWord(words[index]!);
  if (!read) return null;
  const { atom, joined } = read;
  const next = words[index + 1];
  const nextAtom = next !== undefined ? wordAtom(next) : null;
  const one = (part: WordPart) => ({ part, joined, used: 1 });
  const two = (part: WordPart) => ({ part, joined, used: 2 });
  switch (atom.kind) {
    case 'unit':
    case 'teen_lead': {
      const lead = atom.value;
      if (nextAtom?.kind === 'ten' && (atom.kind === 'teen_lead' || lead >= 3)) {
        return two({ value: 10 + lead, place: PLACE.tens, teen: true });
      }
      if (atom.kind === 'teen_lead') return null;
      if (lead >= 3 && nextAtom?.kind === 'hundred' && nextAtom.value === 100) {
        return two({ value: lead * 100, place: PLACE.hundreds });
      }
      if (lead >= 3 && next === WORD_THOUSANDS_PLURAL) {
        return two({ value: lead * 1000, place: PLACE.thousands });
      }
      if (lead === 3 && next === WORD_QUARTERS) return two({ value: 0.75, place: PLACE.fraction });
      return one({ value: lead, place: PLACE.units });
    }
    case 'ten':
      if (next === WORD_THOUSANDS_PLURAL) return two({ value: 10_000, place: PLACE.thousands });
      return one({ value: 10, place: PLACE.tens, teen: true });
    case 'tens':
      return one({ value: atom.value, place: PLACE.tens });
    case 'hundred':
      return one({ value: atom.value, place: PLACE.hundreds });
    case 'thousand':
      return one({ value: atom.value, place: PLACE.thousands });
    case 'fraction':
      return one({ value: atom.value, place: PLACE.fraction });
  }
}

/**
 * Re-review finding 4: the numbers a text says in Arabic words — bounded to the integers
 * 0–9999 (masculine and feminine, joined by «و» in the Arabic place order: «ألف
 * وأربعمائة وأربعون», «واحد وعشرون», «مائة واثنا عشر») and the fractions «نصف»,
 * «ربع», «ثلث», «ثلثان», «ثلاثة أرباع», alone or after a whole number («ثلاثة ونصف»).
 * Two numbers side by side («خمسة ستة», «خمسة وستة») are two numbers.
 */
export function arabicNumberWords(text: string): number[] {
  const words = normalizeGuideText(text).split(' ').filter(Boolean);
  const values: number[] = [];
  let total: number | null = null;
  let place: number = Number.POSITIVE_INFINITY;
  const flush = () => {
    if (total !== null && total >= 0 && total <= 9999) values.push(total);
    total = null;
    place = Number.POSITIVE_INFINITY;
  };
  for (let index = 0; index < words.length; ) {
    const read = wordPart(words, index);
    if (!read) {
      flush();
      index += 1;
      continue;
    }
    const { part, joined, used } = read;
    index += used;
    // A part joins only after «و», in a lower place, and a teen never after a unit
    // («خمسة وعشرة» is two numbers; «خمسة وعشرون» is 25).
    const joins =
      total !== null && joined && part.place < place && !(part.teen && place === PLACE.units);
    if (!joins) {
      flush();
      total = part.value;
    } else {
      total = total! + part.value;
    }
    place = part.place;
  }
  flush();
  return values;
}

/**
 * The leak guard's test: does `text` (a try-it slide, its narration, an attempt stem)
 * state the approved answer, where the item's OWN question text (`bookText`: that item
 * only, its number or label removed, never the whole unit) does not already hold that
 * value (a given that equals the answer is not a leak)? Only numbers and text answers
 * leak here; a number only at its exact value, never as an item label («2A»), a
 * reference («السؤال 11») or a page; a text answer only on a line that
 * announces an answer («الإجابة», «الجواب», «الحل», «الناتج») or right after «=», since a
 * cycle or a word list shown as given data legitimately holds it. Choice letters and
 * truth values are {@link announcesGuideAnswer}'s.
 */
export function leaksGuideAnswer(
  answer: KafuoTeacherGuideAnswer,
  text: string,
  bookText = '',
  /**
   * Re-review finding 4: `spoken` (a narration) also reads the numbers said in Arabic
   * words («اثنا عشر», «ثلاثة أرباع»), since the spoken-notation rule writes them so.
   */
  options: { spoken?: boolean } = {},
): boolean {
  if (answer.type === 'number') {
    // A slide is searched, not graded: only the exact value counts (the 1%/5% window would
    // flag nearby givens and cost a regeneration, then a dropped check).
    const agrees = (value: number) => Math.abs(value - answer.value) < 1e-9;
    // Searched, so every reading counts, the plain one («100 200» as two numbers) too.
    const numbersOf = (source: string) =>
      [
        ...new Set([...guideNumberReadings(source), foldLetters(normalizeGuideDigits(source))]),
      ].flatMap((reading) => readingTokens(reading));
    const givens = [
      ...numbersOf(bookText).map((token) => token.value),
      ...(options.spoken ? arabicNumberWords(bookText) : []),
    ];
    if (givens.some(agrees)) return false;
    // An item label («2A»), a reference («السؤال 11») or a page states no answer.
    const shown = numbersOf(text)
      .filter((token) => token.kind === 'value' || token.kind === 'date')
      .map((token) => token.value);
    if (shown.some(agrees)) return true;
    return options.spoken === true && arabicNumberWords(text).some(agrees);
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
const STATED_TRUE: ReadonlySet<string> = new Set([
  'صحيح',
  'صحيحه',
  'صحيحا',
  'صواب',
  'صوابا',
  'صايب',
  'صايبه',
  'صايبا',
  'true',
]);
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
