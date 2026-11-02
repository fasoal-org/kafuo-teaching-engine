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
/** What separates two names of a written list: spaces, punctuation, numbers, «و». */
const LIST_GAP = '[\\s\\d=:،,()\\-–→←.]{1,12}(?:و\\s*)?';

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

/** The cycles whose names the text uses: two distinct names of one cycle at least. */
function orderedSetsIn(text: string): string[] {
  return SET_MATCHERS.filter(
    ({ names }) => names.filter((name) => name.test(text)).length >= 2,
  ).map(({ set }) => set);
}

/** `10:15`, `3:00` — a time of day (minutes 00-59). */
const CLOCK_TIME = /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/g;

function clockTimes(text: string): string[] {
  return text.match(CLOCK_TIME) ?? [];
}

/**
 * A time of day as book text writes one: `hh:mm` right after «الساعة» or right
 * before a morning/evening marker («صباحًا», «مساءً», «ص», «م», am/pm). A bare
 * `1:20` is a ratio or a scale, never a time.
 */
const MARKED_CLOCK_TIME = new RegExp(
  `(?:(?<=الساعه\\s*)${CLOCK_TIME.source}` +
    `|${CLOCK_TIME.source}(?=\\s*(?:صباحا|مساءا|مساء|ص|م|am|pm|a\\.m\\.|p\\.m\\.)(?![\\p{L}])))`,
  'gu',
);

/** The detectable hidden-step types of one item's (or unit's) text. */
export function detectHiddenStepTypes(text: string): DetectedHiddenStepType[] {
  const normalized = normalizeBookText(text);
  const types: DetectedHiddenStepType[] = [];
  if (orderedSetsIn(normalized).length > 0) types.push('ordered_named_set');
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
  return labels;
}

/** What the gate needs to know about one book unit, pinned on the checkpoint. */
export interface BookUnitFacts {
  /** A check's labelled items (1A, 1B…); empty when the text labels none. */
  itemLabels: string[];
  /** The detectable hidden-step types its items use. */
  hiddenSteps: DetectedHiddenStepType[];
}

export function bookUnitFacts(text: string): BookUnitFacts {
  return { itemLabels: checkItemLabels(text), hiddenSteps: detectHiddenStepTypes(text) };
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

/** A step in minutes: `45 دقيقة`, `+ 45 min`. */
const MINUTE_STEP =
  /(?:\d+\s*(?:دقيقه|دقائق|دقيقتين|دقيقتان|minutes?|mins?(?![\p{L}])))|(?:\+\s*\d+)/u;

/**
 * Whether a solution's visible text writes the hidden step of `type`:
 * - `ordered_named_set`: at least two names of one cycle are written beside
 *   their number (the set numbered, «محرم = 1 … ذو الحجة = 12»);
 * - `clock_time`: at least two times and one step in minutes are written.
 * The item text is not needed, so a pinned checkpoint re-checks it alike.
 */
export function showsWorkingStep(type: DetectedHiddenStepType, visibleText: string): boolean {
  const visible = normalizeBookText(visibleText);
  if (type === 'ordered_named_set') {
    return SET_MATCHERS.some(({ set }) => numberedNames(visible, set) >= 2);
  }
  return clockTimes(visible).length >= 2 && MINUTE_STEP.test(visible);
}
