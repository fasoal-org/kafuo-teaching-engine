/**
 * The hidden-step question types (teacher-parity plan I-2, g5.v8): a small,
 * deterministic detector beside the catalogue the planner and the solution
 * canvas read (`@openmaic/generation` `snippets/working-steps/hidden-step-types.md`).
 *
 * A new type is one catalogue row and one entry in {@link HIDDEN_STEP_TYPES}.
 * Only the types whose trigger is reliable in book text are detected here; the
 * rest are planned by the model alone (plan I-2 point 5), so the gate never
 * guesses them.
 *
 * Everything is pure and works on normalized text: Arabic diacritics and
 * tatweel removed, alef/yaa/taa-marbuta forms unified, Arabic-Indic digits
 * turned into ASCII digits.
 */

export type HiddenStepType =
  | 'ordered_named_set'
  | 'clock_time'
  | 'recalled_property'
  | 'figure_reasoning'
  | 'pattern_rule'
  | 'estimate_from_data';

/** Every catalogue type, and whether the detector (and so the gate) checks it. */
export const HIDDEN_STEP_TYPES: Readonly<Record<HiddenStepType, { detected: boolean }>> = {
  ordered_named_set: { detected: true },
  clock_time: { detected: true },
  recalled_property: { detected: false },
  figure_reasoning: { detected: false },
  pattern_rule: { detected: false },
  estimate_from_data: { detected: false },
};

export type DetectedHiddenStepType = 'ordered_named_set' | 'clock_time';

/** Book text as the detector reads it (Latin case kept unless `lowerCase`). */
export function normalizeBookText(text: string, lowerCase = true): string {
  const normalized = text
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, '.');
  return lowerCase ? normalized.toLowerCase() : normalized;
}

/**
 * The fixed cycles of names, each name as normalized text (`ة` → `ه`,
 * `ى` → `ي`). A two-word name keeps its space. For a month, the article and a
 * one-letter conjunction or preposition before it are allowed by the matcher.
 * Names that are also ordinary words are held tighter (see {@link namePattern}):
 * an Arabic weekday needs its article or a preceding «يوم» and takes no
 * one-letter prefix («واحد», «أحد», «اثنين» are numbers), and «صفر» (zero)
 * counts only as «شهر صفر» or beside another Hijri month in a list.
 */
const ORDERED_SETS: Readonly<Record<string, readonly string[]>> = {
  hijri_months: [
    'محرم',
    'صفر',
    'ربيع الاول|ربيع اول',
    'ربيع الاخر|ربيع الثاني|ربيع اخر|ربيع ثاني',
    'جمادي الاولي|جمادي اولي|جمادي الاول',
    'جمادي الاخره|جمادي الثانيه|جمادي الاخر|جمادي اخره',
    'رجب',
    'شعبان',
    'رمضان',
    'شوال',
    'ذو القعده|ذي القعده',
    'ذو الحجه|ذي الحجه',
  ],
  gregorian_months: [
    'يناير|january',
    'فبراير|february',
    'مارس|march',
    'ابريل|april',
    // English "may" is left out: it is far more often the verb.
    'مايو',
    'يونيو|june',
    'يوليو|july',
    'اغسطس|august',
    'سبتمبر|september',
    'اكتوبر|october',
    'نوفمبر|november',
    'ديسمبر|december',
  ],
  weekdays: [
    'الاحد|sunday',
    'الاثنين|الاتنين|monday',
    'الثلاثاء|tuesday',
    'الاربعاء|wednesday',
    'الخميس|thursday',
    'الجمعه|friday',
    'السبت|saturday',
  ],
};

const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';

/** A word that names a Hijri month, for «صفر»'s list context. */
const HIJRI_WORD =
  '(?<![\\p{L}])(?:محرم|المحرم|ربيع|جمادي|رجب|شعبان|رمضان|شوال|ذو\\s+ال(?:قعده|حجه)|ذي\\s+ال(?:قعده|حجه)|الحجه|القعده)';
/**
 * What separates two names of a written list or sequence: spaces, punctuation, numbers,
 * then «و» or «ثم» («محرم، صفر», «السبت ثم الأحد», «يناير / فبراير»).
 */
const LIST_GAP = '[\\s\\d=:،,;؛|/()\\-–→←.]{1,12}(?:(?:و|ثم)\\s*)?';

/**
 * A name from a cycle, as a whole word. Months allow an article and a
 * one-letter prefix; an Arabic weekday needs its article (a one-letter prefix
 * only before the article, as in «والأحد») or a preceding «يوم», so «واحد» is
 * never «الأحد»; «صفر» needs «شهر» before it
 * or another Hijri month beside it.
 */
function namePattern(set: string, alternatives: string): string {
  const forms = alternatives.split('|');
  if (set === 'weekdays') {
    const arabic = forms
      .filter((form) => form.startsWith('ال'))
      .map((form) => form.replace(/^ال/, ''))
      .join('|');
    const latin = forms.filter((form) => !form.startsWith('ال')).join('|');
    return `${WORD_START}(?:(?:[وبفك]?ال|يوم\\s+(?:ال)?)(?:${arabic})|${latin})${WORD_END}`;
  }
  if (alternatives === 'صفر') {
    return (
      `${WORD_START}(?:شهر\\s+صفر|(?<=${HIJRI_WORD}${LIST_GAP})و?صفر` +
      `|و?صفر(?=${LIST_GAP}${HIJRI_WORD}))${WORD_END}`
    );
  }
  const body = forms.map((form) => form.replace(/^ال/, '').replace(/ /g, '\\s+(?:ال)?')).join('|');
  return `${WORD_START}[وبلفك]?(?:ال)?(?:${body})${WORD_END}`;
}

const SET_MATCHERS: ReadonlyArray<{ set: string; names: RegExp[] }> = Object.entries(
  ORDERED_SETS,
).map(([set, names]) => ({
  set,
  names: names.map((name) => new RegExp(namePattern(set, name), 'u')),
}));

/** Per cycle: three of its names written one after another, as a list or a sequence. */
const SEQUENCE_MATCHERS: ReadonlyArray<RegExp> = SET_MATCHERS.map(({ names }) => {
  const name = `(?:${names.map((pattern) => pattern.source).join('|')})`;
  return new RegExp(`${name}(?:${LIST_GAP}${name}){2,}`, 'u');
});

/** Unit forms that, after a number, always count: plural and accusative (normalized). */
const COUNTED_UNIT = '(?:ايام|يوما|اسابيع|اسبوعا|اشهر|شهرا|شهور|days|weeks|months)';
/** Singular unit forms: after a number they also name a day or a month («12 يوم السبت»). */
const SINGLE_UNIT = '(?:يوم|اسبوع|شهر)';
/**
 * What a singular unit names instead of counting: «يوم السبت», «يوم غد», «شهر رجب». Only
 * a day or a month name: «100 يوم الأولى», «100 يوم إلى …» («إلى» normalizes to «الي»)
 * still count.
 */
const NAMED_AFTER =
  '(?![^\\S\\n]*(?:ال(?:احد|اثنين|اتنين|ثلاثاء|اربعاء|خميس|جمعه|سبت)|غد|امس' +
  '|(?:ال)?(?:محرم|صفر|ربيع|جمادي|رجب|شعبان|رمضان|شوال)|ذو|ذي' +
  '|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)(?![\\p{L}]))';
/** A number written as words before a unit: «خمسة أيام», «خمسة وعشرين يومًا» (normalized). */
const NUMBER_WORD =
  '(?:عشرون|عشرين|ثلاثون|ثلاثين|اربعون|اربعين|خمسون|خمسين|ستون|ستين|سبعون|سبعين|ثمانون|ثمانين|تسعون|تسعين' +
  '|ثلاثه|ثلاث|اربعه|اربع|خمسه|خمس|سته|ست|سبعه|سبع|ثمانيه|ثماني|ثمان|تسعه|تسع|عشره|عشر|مئه|مائه|الف)';
/** A one-letter prefix a counted word may carry: «فكم», «بيومين», «وعشرين». */
const PREFIX = '[وبلف]?';

/**
 * A step counted along the cycle:
 * - digits before a plural unit («بعد 10 أيام», «(10 أيام)», «ب3 أيام»);
 * - digits before a singular unit («100 يوم») that does not name a day or a month
 *   («12 يوم السبت»), and is no item label: «(1 يوم غد …» (the OCR form «(N»), a number
 *   opening a line, or the minutes of «7:30 يوم السبت»;
 * - number words before a unit («خمسة أشهر», «خمسة وعشرين يومًا»);
 * - a dual («يومين», «شهرين»);
 * - a «كم» question («فكم يومًا», «كم عدد الأيام»).
 * «يوم» alone («يوم غد», «يوم السبت») is no step.
 */
const COUNTING_CUE = new RegExp(
  [
    `(?<![\\p{N}.:])(?:(?<![\\p{L}])|(?<=(?<![\\p{L}])[وبلف]))\\d+[^\\S\\n]*${COUNTED_UNIT}${WORD_END}`,
    `(?<![\\p{L}\\p{N}.:(])(?<!^[^\\S\\n]*)\\d+[^\\S\\n]*${SINGLE_UNIT}${WORD_END}${NAMED_AFTER}`,
    `${WORD_START}${PREFIX}${NUMBER_WORD}\\s+(?:${COUNTED_UNIT}${WORD_END}|${SINGLE_UNIT}${WORD_END}${NAMED_AFTER})`,
    `${WORD_START}${PREFIX}(?:يومين|يومان|اسبوعين|اسبوعان|شهرين|شهران)${WORD_END}`,
    `${WORD_START}${PREFIX}كم\\s+(?:عدد\\s+)?(?:ال)?(?:${COUNTED_UNIT}|${SINGLE_UNIT})${WORD_END}`,
    `${WORD_START}how\\s+many\\s+(?:days|weeks|months)${WORD_END}`,
  ].join('|'),
  'mu',
);

/**
 * A blank line before an item number («(2 …», «2) …», «2. …»): where one book item ends and
 * the next begins. A blank line alone is only a paragraph break: an item's choices
 * («أ) الخميس ب) الجمعة») or a wrapped stem may follow it and still belong to the item.
 */
const ITEM_BREAK = /\n[^\S\n]*\n(?=[^\S\n]*\(?\d{1,3}[\s).\-])/u;

/**
 * Whether the text counts along a cycle of names, so its solution owes the numbered set:
 * - three names of one cycle written as a sequence («الأحد، الثلاثاء، الخميس، …»), or
 * - two names of one cycle with a counted step ({@link COUNTING_CUE}), in one item.
 *
 * Two names alone are not enough (13 Nov 2026, local run, lesson 328 unit 6139): «يوم غد
 * هو السبت إذا كان اليوم هو الجمعة» is a statement whose hypothesis and conclusion the
 * learner names; nothing is counted, and the gate blocked the package for a numbered week.
 * Names and a count from different items (separated by a blank line) or names scattered
 * over separate statements do not add up either.
 */
function countsAlongACycle(text: string): boolean {
  if (SEQUENCE_MATCHERS.some((sequence) => sequence.test(text))) return true;
  return text
    .split(ITEM_BREAK)
    .some(
      (item) =>
        COUNTING_CUE.test(item) &&
        SET_MATCHERS.some(({ names }) => names.filter((name) => name.test(item)).length >= 2),
    );
}

/** `10:15`, `3:00` — a time of day (minutes 00-59). */
const CLOCK_TIME = /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/g;

function clockTimes(text: string): string[] {
  return text.match(CLOCK_TIME) ?? [];
}

/** A morning/evening marker after a time: «صباحًا», «مساءً», «ص», «م», am/pm (normalized). */
const DAY_PERIOD = '\\s*(?:صباحا|مساءا|مساء|ص|م|am|pm|a\\.m\\.|p\\.m\\.)(?![\\p{L}])';

/**
 * A time of day as book text writes one: `hh:mm` right after «الساعة» or right
 * before a morning/evening marker. A bare `1:20` is a ratio or a scale, never a time.
 */
const MARKED_CLOCK_TIME = new RegExp(
  `(?:(?<=الساعه\\s*)${CLOCK_TIME.source}|${CLOCK_TIME.source}(?=${DAY_PERIOD}))`,
  'gu',
);

/** A time written with its morning/evening marker, so the side of noon is shown: «12:30 مساءً». */
const PERIOD_CLOCK_TIME = new RegExp(`${CLOCK_TIME.source}(?=${DAY_PERIOD})`, 'u');

/** The detectable hidden-step types of one item's (or unit's) text. */
export function detectHiddenStepTypes(text: string): DetectedHiddenStepType[] {
  const normalized = normalizeBookText(text);
  const types: DetectedHiddenStepType[] = [];
  if (countsAlongACycle(normalized)) types.push('ordered_named_set');
  if ((normalized.match(MARKED_CLOCK_TIME) ?? []).length >= 2) types.push('clock_time');
  return types;
}

/**
 * The labelled items of a «تحقق من فهمك» check, in book order and without
 * repeats: `1A)`, `(2A`, `4B)` — a number and one letter touching a
 * parenthesis, as the parse prints them. Arabic item letters (أ ب ج د) map to
 * A-D. Only capital Latin letters count, so algebra such as `(2a + b)` is
 * never an item. An unlabelled check has no items here (it counts as one).
 */
export function checkItemLabels(text: string): string[] {
  const normalized = normalizeBookText(text, false);
  const arabic: Record<string, string> = { ا: 'A', ب: 'B', ج: 'C', د: 'D' };
  const label =
    /(?:\(\s*(\d{1,2})\s?([A-H]|[ابجد])(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(\d{1,2})\s?([A-H]|[ابجد])\s*\))/gu;
  const labels: string[] = [];
  for (const match of normalized.matchAll(label)) {
    const number = match[1] ?? match[3]!;
    const letter = match[2] ?? match[4]!;
    const key = `${Number(number)}${arabic[letter] ?? letter}`;
    if (!labels.includes(key)) labels.push(key);
  }
  if (labels.length > 0) return labels;
  // A check numbered «1.», «1-», «1)», «(1)» at line start (3 Nov 2026). The
  // space after «.» / «-» keeps «1.5» and a section number «1-1» out.
  // «.5 » is the RTL form of «5.» (4 Nov 2026, the backend's rule); a decimal
  // «.5» inside a line never opens it.
  const numbered =
    /^[^\S\n]*(?:\.(\d{1,2})(?=\s)|\(\s*(\d{1,2})\s*\)|(\d{1,2})[^\S\n]*(?:[.\-–](?=\s)|\)))/gmu;
  for (const match of normalized.matchAll(numbered)) {
    const key = String(Number(match[1] ?? match[2] ?? match[3]!));
    if (!labels.includes(key)) labels.push(key);
  }
  if (labels.length > 0) return labels;
  return trailingItemNumbers(asciiDigits(text)).map(String);
}

/**
 * The math-book OCR form «value (N» (4 Nov 2026, lessons 312 units 5464/5466):
 * in RTL order the item number follows its answer or expression, as in
 * «62 (1 \frac{5}{4} (2». On one line, a `(N` (N of 1–3 digits) is an item
 * number when ALL hold:
 * 1. a value precedes it on the line: the last non-space character before
 *    the «(» exists and is not «(»;
 * 2. N is followed by whitespace or the line's end, or by «)» ending the line
 *    («-2a + 9d \quad (38)», unit 5466);
 * 3. no «)» follows on the line before the next «(» or the line's end (so an
 *    expression bracket «(8 \cdot 5)» never counts).
 * Then a candidate counts only when N-1 or N+1 is a candidate too: they form
 * runs of consecutive numbers (1..12, 37..42), so one stray bracket never does.
 * Returned ascending, once per number.
 */
export function trailingItemNumbers(text: string): number[] {
  const candidates = new Set<number>();
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/\((\d{1,3})(?:(?=\s|$)|\)(?=\s*$))/gu)) {
      const at = match.index ?? 0;
      const before = line.slice(0, at).trimEnd();
      if (before === '' || before.endsWith('(')) continue;
      const after = line.slice(at + match[0].length);
      const close = after.indexOf(')');
      const open = after.indexOf('(');
      if (close >= 0 && (open < 0 || close < open)) continue;
      candidates.add(Number(match[1]));
    }
  }
  return [...candidates]
    .filter((n) => candidates.has(n - 1) || candidates.has(n + 1))
    .sort((a, b) => a - b);
}

/** Arabic-Indic digits as ASCII digits; nothing else changes. */
function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * The «المثال N» header «تأكد» / «تدرب» print, at a line's start — the backend's
 * `_EXERCISE_HEADER_RE` (`curriculums_management/domain/book_parts.py`).
 */
const EXERCISE_HEADER =
  /^[^\p{L}\p{N}_\n]*(?:(?:تأكد|تدرب(?:[^\S\n]+وحل[^\S\n]+المسائل)?)[^\S\n]*)?(?:المثالان|المثال|الأمثلة)[^\S\n]*(\d{1,3})(?:[^\S\n]*(?:[,،\-–]|و|إلى)[^\S\n]*\d{1,3})*/gmu;
/** A numbered question opening a line — the backend's `_LINE_ITEM_NUMBER_RE`. */
const LINE_ITEM_NUMBER =
  /^[^\S\n]*(?:\.(\d{1,3})(?=\s)|\(?[^\S\n]*(\d{1,3})(?:[^\S\n]*[A-Za-z]?[^\S\n]*\)|[^\S\n]*[.\-–](?=\s)|(?=[^\S\n]|$)))/gmu;

/**
 * The numbered questions an exercise unit holds, once per number, in book
 * order: the backend's `exercise_question_count` rule, so the engine weighs a
 * unit as `minExercises` counted it. Only a number opening a line counts
 * («1.», «1-», «1)», «(1)», a bare «1 »); «●» bullets and an «المثال N» header
 * never do.
 */
export function exerciseQuestionNumbers(text: string): number[] {
  if (!text) return [];
  const body = asciiDigits(text).replace(EXERCISE_HEADER, ' ');
  const all = trailingItemNumbers(body);
  const numbers: number[] = [];
  for (const match of body.matchAll(LINE_ITEM_NUMBER)) {
    // A unit using the OCR form «value (N» prints a value, not a question, as a
    // bare line-start number («62» in «62 (1», «84» in «84 + 16 = …»), so every
    // bare line-start number is then skipped (the backend's
    // `exercise_question_numbers`, 4 Nov 2026).
    const bare = match[1] === undefined && /^[^\S\n]*\d+$/.test(match[0]);
    if (all.length > 0 && bare) continue;
    const number = Number(match[1] ?? match[2]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  // The OCR form «value (N» ({@link trailingItemNumbers}), added once per number.
  const trailing = all.filter((number) => !numbers.includes(number));
  if (trailing.length === 0) return numbers;
  return [...numbers, ...trailing].sort((a, b) => a - b);
}

/** What the gate needs to know about one book unit, pinned on the checkpoint. */
export interface BookUnitFacts {
  /** A check's labelled items (1A, 1B… or 1, 2…); empty when the text labels none. */
  itemLabels: string[];
  /** The detectable hidden-step types its items use. */
  hiddenSteps: DetectedHiddenStepType[];
  /**
   * The numbered questions the unit holds ({@link exerciseQuestionNumbers}).
   * Absent on facts pinned before 3 Nov 2026: the unit then weighs one.
   */
  questionNumbers?: number[];
  /**
   * M-4 (4 Nov 2026 rule): an exercise or check whose every item held a verse
   * or hadith, so nothing is left to set or solve; the engine never selects it.
   */
  noItemsLeft?: true;
}

export function bookUnitFacts(text: string): BookUnitFacts {
  const questionNumbers = exerciseQuestionNumbers(text);
  return {
    itemLabels: checkItemLabels(text),
    hiddenSteps: detectHiddenStepTypes(text),
    ...(questionNumbers.length > 0 ? { questionNumbers } : {}),
  };
}

/** A name of the cycle beside a number: `محرم = 1`, `1. محرم`, `شوال (10)`. */
function numberedNames(text: string, set: string): number {
  const matcher = SET_MATCHERS.find((entry) => entry.set === set)!;
  return matcher.names.filter((name) => {
    const body = name.source;
    const after = new RegExp(`${body}\\s*(?:[=:：(\\-–→]\\s*)?\\(?\\d{1,2}(?!\\d)`, 'u');
    const before = new RegExp(`(?<!\\d)\\d{1,2}\\s*(?:[=:.)\\-–→]\\s*)?${body}`, 'u');
    return after.test(text) || before.test(text);
  }).length;
}

/** Minutes written as a number and the unit: `45 دقيقة`, `45 min`. */
const MINUTES = /\d+\s*(?:دقيقه|دقائق|دقيقتين|دقيقتان|minutes?|mins?(?![\p{L}]))/u;
/** A step in minutes: `45 دقيقة`, `+ 45 min`, `+ 45`. */
const MINUTE_STEP = new RegExp(`${MINUTES.source}|\\+\\s*\\d+`, 'u');

/**
 * Whether a solution's visible text writes the hidden step of `type`:
 * - `ordered_named_set`: at least two names of one cycle are written beside
 *   their number (the set numbered, «محرم = 1 … ذو الحجة = 12»);
 * - `clock_time`: at least two times and one step in minutes are written, or one
 *   time with its morning/evening marker and the step written in minutes («تتكرر
 *   زيادة 45 دقيقة؛ الموعد التالي 12:30 مساءً»).
 *
 * The second `clock_time` form is what the planner snippet asks for (work in minutes,
 * write the crossing of noon). Owner, 14 Nov 2026: two local g5.v9 runs of one lesson
 * (items 207 and 208, the «تأكد» bus times) paused for a person on a plan that wrote
 * exactly that, and the slide written from it showed the full working. A sum's «+ 3»
 * is not minutes, so the one-time form needs the unit written.
 * The item text is not needed, so a pinned checkpoint re-checks it alike.
 */
export function showsWorkingStep(type: DetectedHiddenStepType, visibleText: string): boolean {
  const visible = normalizeBookText(visibleText);
  if (type === 'ordered_named_set') {
    return SET_MATCHERS.some(({ set }) => numberedNames(visible, set) >= 2);
  }
  if (clockTimes(visible).length >= 2 && MINUTE_STEP.test(visible)) return true;
  return PERIOD_CLOCK_TIME.test(visible) && MINUTES.test(visible);
}
