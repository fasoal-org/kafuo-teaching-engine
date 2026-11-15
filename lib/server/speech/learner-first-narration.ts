/**
 * g5.v10 (learner-first, plan `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`):
 * the deterministic checks of a slide's narration against its own canvas. Run inside
 * the narration re-roll loop on g5.v10 runs only; every earlier Teaching Model never
 * reaches this module (D-9 B).
 *
 * The checks, each a weak-student failure seen on items 208 and 195 (15 Nov 2026):
 * - NARRATION_ITEM_MISSING: the slide shows several labelled items (أ، ب، ج …) and the
 *   narration never points to one of them (slides 10 and 13 spoke item أ only).
 * - IMAGE_APPEARANCE_NARRATION: the narration describes a picture's colours, line
 *   styles or place on the page instead of its mathematics (slide 5).
 * - SYMBOL_READING_ARABIC_NAME: a Latin letter on the canvas is read with an Arabic
 *   letter name («ألف باء هاء» for A, B, E; «جيم» for J), against owner decision D-3.
 *   Since the quality plan W3 also a single name: «سين» for x, «ثلاثة ألف» for 3a.
 * - CLOCK_TIME_READ_AS_NUMBER (W3): a canvas time read as a number («ثمانية وثلاثين»).
 * - CONJECTURE_CALLED_PROVED (W3): «التخمين صحيح» because examples satisfy it.
 */
/**
 * D-3 A: a Latin letter is read by its English name, in Arabic script. The same table
 * the narration prompt states (`packages/@openmaic/generation/src/learner-first.ts`,
 * `LATIN_LETTER_READINGS`); `tests/speech/learner-first-narration.test.ts` pins the two
 * equal.
 */
export const LATIN_LETTER_READINGS: Readonly<Record<string, string>> = Object.freeze({
  A: 'إيه',
  B: 'بي',
  C: 'سي',
  D: 'دي',
  E: 'إي',
  F: 'إف',
  G: 'جي',
  H: 'إتش',
  I: 'آي',
  J: 'جيه',
  K: 'كيه',
  L: 'إل',
  M: 'إم',
  N: 'إن',
  O: 'أو',
  P: 'بي',
  Q: 'كيو',
  R: 'آر',
  S: 'إس',
  T: 'تي',
  U: 'يو',
  V: 'في',
  W: 'دبليو',
  X: 'إكس',
  Y: 'واي',
  Z: 'زد',
});

/** Roles whose slide sets the learner a task: read every item, never solve it. */
export const LEARNER_TASK_ROLES: ReadonlySet<string> = new Set([
  'check_understanding',
  'practice',
  'activity',
]);

export type LearnerFirstNarrationIssueCode =
  | 'NARRATION_ITEM_MISSING'
  | 'IMAGE_APPEARANCE_NARRATION'
  | 'SYMBOL_READING_ARABIC_NAME'
  | 'CLOCK_TIME_READ_AS_NUMBER'
  | 'CONJECTURE_CALLED_PROVED';

export interface LearnerFirstNarrationIssue {
  code: LearnerFirstNarrationIssueCode;
  evidence: string;
}

/** The canvas the narration is checked against: ids, kinds and visible text. */
export interface NarrationCanvasElement {
  id: string;
  type: string;
  text: string;
}

interface NarrationAction {
  type: string;
  text?: unknown;
  elementId?: unknown;
}

// An item label at the start of an element's text: «٢أ», «تحقق ١ب», «أ)», «ب —»,
// «السؤال ٧», «تمرين ٣», and the book's own «(1A)», «1A», «(١أ)». Plain numbered steps
// («١. …») are steps of ONE item, not items.
const ITEM_LABEL =
  /^\s*\(?\s*(?:(?:تحقق|حل)\s*)?(?:[0-9٠-٩]{1,2}\s*[أبجدA-Da-d](?=[\s)\-—|:.،]|$)|[أبجد]\s*[)\-—|:]|(?:السؤال|سؤال|تمرين)\s*[0-9٠-٩]+)/u;

/** The ids of the canvas elements that each start one labelled item. */
export function itemElementIds(elements: readonly NarrationCanvasElement[]): string[] {
  return elements
    .filter(
      (element) =>
        (element.type === 'text' || element.type === 'shape') && ITEM_LABEL.test(element.text),
    )
    .map((element) => element.id);
}

const IMAGE_CUE = /(الصورة|الصور|الشكل|الأشكال|الرسم|الرسوم|المخطط|الرسمة)/u;
const APPEARANCE_WORDS = [
  'أزرق',
  'زرقاء',
  'زرق',
  'أخضر',
  'خضراء',
  'خضر',
  'أحمر',
  'حمراء',
  'حمر',
  'أصفر',
  'صفراء',
  'بنفسجي',
  'برتقالي',
  'رمادي',
  'متقطع',
  'متقطعة',
  'منقط',
  'منقطة',
  'الزاوية السفلية',
  'الزاوية العلوية',
  'الركن السفلي',
  'الركن العلوي',
];

/**
 * The appearance words a line uses that the canvas itself does not print. A colour or
 * line style that is the slide's own data («الكرات الحمراء», «دالة متقطعة») is allowed.
 */
function appearanceWords(line: string, canvasText: string): string[] {
  return APPEARANCE_WORDS.filter((word) => line.includes(word) && !canvasText.includes(word));
}

/** D-3: the Arabic letter name a Latin letter must never be read with. */
const ARABIC_NAME_OF: Readonly<Record<string, readonly string[]>> = Object.freeze({
  A: ['ألف'],
  B: ['باء'],
  C: ['جيم'],
  D: ['دال'],
  E: ['هاء'],
  F: ['فاء'],
  H: ['حاء'],
  J: ['جيم'],
  K: ['كاف'],
  L: ['لام'],
  M: ['ميم'],
  N: ['نون'],
  R: ['راء'],
  S: ['سين'],
  T: ['تاء'],
  X: ['سين'],
  Y: ['صاد'],
});
const LETTER_NAMES = [...new Set(Object.values(ARABIC_NAME_OF).flat())];
const NAME = `(?:${LETTER_NAMES.join('|')})`;
// Two or more letter names in a row («ألف باء هاء»), or one after a symbol cue
// («المتغير نون», «النقطة كاف»). A year read as «ألف وأربعمئة» never matches; «ألف» after a
// number cue («سالب ألف», «العدد ألف») is the number one thousand, not the letter.
const NAME_RUN = new RegExp(`(?:^|[\\s،,(«])(${NAME}(?:\\s+${NAME})+)(?=$|[\\s،,.)»؟])`, 'u');
const SYMBOL_CUED_NAME = new RegExp(
  `(?:المتغير|المتغيّر|النقطة|القطعة|الزاوية|المستقيم)\\s+(${NAME})(?=$|[\\s،,.)»؟])`,
  'u',
);
const NAME_WITHOUT_THOUSAND = `(?:${LETTER_NAMES.filter((name) => name !== 'ألف').join('|')})`;
const NUMBER_CUED_NAME = new RegExp(
  `(?:سالب|العدد)\\s+(${NAME_WITHOUT_THOUSAND})(?=$|[\\s،,.)»؟])`,
  'u',
);

// ── Quality plan W3 (15 Nov 2026) ─────────────────────────────────────────────────
// A single letter name (item 195: «سين أصغر من…», «ثلاثة ألف زائد ثمانية»), a clock
// time read as a number (item 208: 8:30 «ثمانية وثلاثين»), and one checked case called
// a proof (item 208: «إذن التخمين صحيح»).

const WORD_END = '(?=$|[\\s،,.)»؟:؛!])';
// A prefix the spoken word may carry: «و», «ب», «ف», «ل», with or without «ال» («للسين»).
const WORD_START = '(?:^|[\\s،,(«:—-])(?:[وفبل]?(?:ال|لل)?)';
/** x, y and s are read «سين» / «صاد» nowhere else in a lesson; one alone is the letter. */
const LONE_STRONG = new RegExp(`${WORD_START}(سين|صاد)${WORD_END}`, 'u');
/** Names that are also Arabic item letters (أ ب ج) or words; checked with the guards below. */
const GUARDED_NAMES = ['ألف', 'باء', 'جيم', 'هاء', 'ميم', 'نون'] as const;
const LONE_GUARDED = new RegExp(`${WORD_START}(${GUARDED_NAMES.join('|')})${WORD_END}`, 'gu');
/** «الفقرة ألف», «البند باء», «الحالتين باء وجيم»: an item cue names an Arabic item letter. */
const ITEM_CUE =
  /(?:الفقرة|فقرة|الجزء|جزء|الفرع|فرع|البند|بند|الحالة|حالة|الحالتين|الحالتان|السؤال|المطلوب)$/u;
/** The Arabic item letter a guarded name reads. */
const ARABIC_ITEM_OF: Readonly<Record<string, string>> = { ألف: 'أ', باء: 'ب', جيم: 'ج' };
const NUMBER_WORD =
  /^و?(?:واحد|اثن|ثلاث|أربع|خمس|ست|سبع|ثمان|تسع|عشر|مئة|مائة|مئت|ميت|مية|ألفين|آلاف)/u;
/**
 * The word before «ألف» that makes it the number: «العدد ألف», «أحد عشر ألف», «عشرين
 * ألف», «مية ألف». Three to ten take «آلاف», so «ثلاثة ألف» is 3a (item 195), never 3000.
 */
const THOUSAND_BEFORE =
  /^(?:العدد|عدد|الرقم|رقم|و?(?:عشر|عشرين|ثلاثين|أربعين|خمسين|ستين|سبعين|ثمانين|تسعين|مئة|مائة|مية|مئتين|مائتين|ميتين))$/u;

/** The Arabic item letters (أ ب ج د) the canvas labels items with: «أ)», «٢أ:», «(ب». */
function canvasArabicItemLetters(elements: readonly NarrationCanvasElement[]): Set<string> {
  const letters = new Set<string>();
  for (const element of elements) {
    for (const match of element.text.matchAll(
      /(?:^|[\s(])([أبجد])\s*[):.\-—|]|[0-9٠-٩]\s*([أبجد])(?![\p{L}])/gu,
    )) {
      letters.add((match[1] ?? match[2])!);
    }
  }
  return letters;
}

/**
 * The first single letter name the line reads a canvas Latin letter with, or null.
 * «سين» / «صاد» always count when the canvas shows x / y / s. «ألف», «باء», «جيم» …
 * do not count after an item cue, when the canvas labels items with that Arabic
 * letter, or when «ألف» is the number thousand (before «و» and a number, or on a
 * slide whose canvas prints a number of four digits).
 */
function loneLetterName(
  line: string,
  forbidden: ReadonlySet<string>,
  arabicItems: ReadonlySet<string>,
  arabicSymbols: ReadonlySet<string>,
  canvasHasThousands: boolean,
): string | null {
  const allowed = (name: string) => {
    const symbol = ARABIC_SYMBOL_OF[name];
    return symbol !== undefined && arabicSymbols.has(symbol);
  };
  const strong = LONE_STRONG.exec(line)?.[1];
  if (strong && forbidden.has(strong) && !allowed(strong)) return strong;
  for (const match of line.matchAll(LONE_GUARDED)) {
    const name = match[1]!;
    if (!forbidden.has(name) || allowed(name)) continue;
    const item = ARABIC_ITEM_OF[name];
    if (item && arabicItems.has(item)) continue;
    const before = line.slice(0, match.index).trimEnd();
    const previous = before.split(/[\s،,(«:]+/u).pop() ?? '';
    if (ITEM_CUE.test(previous)) continue;
    if (name === 'ألف') {
      if (canvasHasThousands || THOUSAND_BEFORE.test(previous)) continue;
      const after = line.slice((match.index ?? 0) + match[0].length).trimStart();
      if (NUMBER_WORD.test(after.split(/\s+/u)[0] ?? '')) continue;
    }
    return name;
  }
  return null;
}

const HOUR_CARDINAL =
  '(?:واحدة|وحدة|اثنين|ثنتين|ثلاث|ثلاثة|أربع|أربعة|خمس|خمسة|ست|ستة|سبع|سبعة|ثمان|ثمانية|تسع|تسعة|عشر|عشرة|إحدى عشرة|احدعش|اثنا عشر|اثنعش|اثني عشر)';
const HOUR_ORDINAL =
  '(?:الواحدة|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة|الحادية عشرة|الثانية عشرة)';
const TENS: Readonly<Record<string, number>> = {
  عشرين: 20,
  العشرون: 20,
  ثلاثين: 30,
  الثلاثون: 30,
  أربعين: 40,
  الأربعون: 40,
  خمسين: 50,
  الخمسون: 50,
};
/** «ثمانية وثلاثين» (38) or «الثامنة والثلاثون» (the 38th) for a time ending :30. */
const TIME_AS_NUMBER = new RegExp(
  `(?:^|[\\s،,(«])[وبلف]?(?:${HOUR_CARDINAL}\\s+و(عشرين|ثلاثين|أربعين|خمسين)|${HOUR_ORDINAL}\\s+و(العشرون|الثلاثون|الأربعون|الخمسون))${WORD_END}`,
  'gu',
);

/** The minutes (10…59) of every clock time the canvas prints: «8:30», «١٠:٣٠», «10{:}30». */
function canvasClockMinutes(elements: readonly NarrationCanvasElement[]): Set<number> {
  const minutes = new Set<number>();
  for (const element of elements) {
    const text = element.text.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
    for (const match of text.matchAll(/(?<![\d.])([0-2]?\d)\s*(?:\{:\}|:)\s*([0-5]\d)(?!\d)/g)) {
      minutes.add(Number(match[2]));
    }
  }
  return minutes;
}

/**
 * «التخمين صحيح» as a verdict — not a question («هل التخمين صحيح؟», «صحيحًا أم خاطئًا»)
 * and not a line that shows it in general («بصورة عامة», «لأي عدد», a proof).
 */
const CONJECTURE_PROVED = /التخمين\s+(?:صحيح|صحيحًا|صحيحا|صح)(?![\p{L}])/u;
const NOT_A_VERDICT =
  /(?<![\p{L}])(?:هل(?![\p{L}])|إذا كان|ما إذا|أم\s+خاطئ|أو\s+خاطئ|أم\s+لا|بصورة عامة|بشكل عام|لأي عدد|لكل عدد|لكل قيمة|لجميع|في كل الحالات|برهان|نبرهن|أثبتنا)/u;

/** Arabic letters the canvas prints as symbols («س», «ص», «ن»): their names are right. */
function canvasArabicSymbols(elements: readonly NarrationCanvasElement[]): Set<string> {
  const symbols = new Set<string>();
  for (const element of elements) {
    for (const match of element.text.matchAll(/(?<![\p{L}])([سصنمه])(?![\p{L}])/gu)) {
      symbols.add(match[1]!);
    }
  }
  return symbols;
}
const ARABIC_SYMBOL_OF: Readonly<Record<string, string>> = {
  سين: 'س',
  صاد: 'ص',
  نون: 'ن',
  ميم: 'م',
  هاء: 'ه',
};

// Units and LaTeX/HTML leftovers that are not point names or variables.
const NOT_A_SYMBOL =
  /\\[A-Za-z]+|&[A-Za-z]+;|\b(?:cm|mm|km|kg|mg|ml|m²|m³|cm²|cm³|km²|sec|min|hr|pH)\b/g;

/**
 * The Latin letters a canvas shows as symbols, upper-cased: capital point or segment
 * names (A, AB, ABC) and single-letter variables (n, x). Words, units, LaTeX commands
 * and HTML entities are not symbols.
 */
export function canvasLatinLetters(elements: readonly NarrationCanvasElement[]): Set<string> {
  const letters = new Set<string>();
  for (const element of elements) {
    const text = element.text.replace(NOT_A_SYMBOL, ' ');
    for (const match of text.matchAll(/(?<![A-Za-z])([A-Z]{1,3}|[a-z])(?![A-Za-z])/g)) {
      for (const char of match[1]!) letters.add(char.toUpperCase());
    }
  }
  return letters;
}

function spoken(actions: readonly NarrationAction[]): string[] {
  return actions
    .filter((action) => action.type === 'speech' || action.type === 'text')
    .map((action) => String(action.text ?? '').trim())
    .filter(Boolean);
}

/** Every learner-first issue of one slide's narration, against its canvas. */
export function validateLearnerFirstNarration(
  actions: readonly NarrationAction[],
  elements: readonly NarrationCanvasElement[],
): LearnerFirstNarrationIssue[] {
  const issues: LearnerFirstNarrationIssue[] = [];
  const lines = spoken(actions);

  const items = itemElementIds(elements);
  if (items.length >= 2) {
    const pointed = new Set(
      actions
        .filter((action) => action.type === 'spotlight' || action.type === 'laser')
        .map((action) => String(action.elementId ?? '')),
    );
    const missing = items.filter((id) => !pointed.has(id));
    if (missing.length > 0) {
      const labels = missing
        .map((id) => elements.find((element) => element.id === id)?.text.slice(0, 24) ?? id)
        .map((label) => `"${label}"`);
      issues.push({
        code: 'NARRATION_ITEM_MISSING',
        evidence: `never explained: ${labels.join(', ')} (element ${missing.join(', ')})`,
      });
    }
  }

  if (elements.some((element) => element.type === 'image')) {
    const canvasText = elements.map((element) => element.text).join('\n');
    const described = lines.find(
      (line) => IMAGE_CUE.test(line) && appearanceWords(line, canvasText).length > 0,
    );
    if (described) {
      issues.push({ code: 'IMAGE_APPEARANCE_NARRATION', evidence: described.slice(0, 160) });
    }
  }

  const letters = canvasLatinLetters(elements);
  if (letters.size > 0) {
    const forbidden = new Set(
      [...letters].flatMap((letter) => [...(ARABIC_NAME_OF[letter] ?? [])]),
    );
    const arabicItems = canvasArabicItemLetters(elements);
    const arabicSymbols = canvasArabicSymbols(elements);
    const canvasHasThousands = elements.some((element) =>
      /[0-9٠-٩]{4,}|[0-9٠-٩]{1,3}[,٬][0-9٠-٩]{3}/u.test(element.text),
    );
    for (const line of lines) {
      const run =
        NAME_RUN.exec(line)?.[1] ??
        SYMBOL_CUED_NAME.exec(line)?.[1] ??
        NUMBER_CUED_NAME.exec(line)?.[1];
      if (run && run.split(/\s+/).some((name) => forbidden.has(name))) {
        issues.push({ code: 'SYMBOL_READING_ARABIC_NAME', evidence: run });
        break;
      }
      // W3: one letter name alone («سين أصغر من سالب ثلاثة»).
      const lone = loneLetterName(line, forbidden, arabicItems, arabicSymbols, canvasHasThousands);
      if (lone) {
        issues.push({ code: 'SYMBOL_READING_ARABIC_NAME', evidence: lone });
        break;
      }
    }
  }

  // W3: a clock time the canvas prints, read as a number («ثمانية وثلاثين» for 8:30).
  const minutes = canvasClockMinutes(elements);
  if (minutes.size > 0) {
    const misread = lines
      .flatMap((line) => [...line.matchAll(TIME_AS_NUMBER)])
      .find((match) => minutes.has(TENS[(match[1] ?? match[2])!] ?? -1));
    if (misread) {
      issues.push({ code: 'CLOCK_TIME_READ_AS_NUMBER', evidence: misread[0].trim() });
    }
  }

  // W3: examples support a conjecture, they never prove it.
  const proved = lines.find((line) => CONJECTURE_PROVED.test(line) && !NOT_A_VERDICT.test(line));
  if (proved) issues.push({ code: 'CONJECTURE_CALLED_PROVED', evidence: proved.slice(0, 160) });
  return issues;
}

/** The corrective context of a learner-first re-roll, one line per issue. */
export function formatLearnerFirstNarrationCorrection(
  issues: readonly LearnerFirstNarrationIssue[],
  elements: readonly NarrationCanvasElement[],
  /** The slide's contentRole: a learner task (a try-it) is read, never solved. */
  contentRole?: string | null,
): string {
  const letters = [...canvasLatinLetters(elements)]
    .filter((letter) => LATIN_LETTER_READINGS[letter])
    .map((letter) => `${letter} «${LATIN_LETTER_READINGS[letter]}»`)
    .join('، ');
  const learnerTask = LEARNER_TASK_ROLES.has(String(contentRole ?? ''));
  const lines = issues.map((issue) => {
    switch (issue.code) {
      case 'NARRATION_ITEM_MISSING':
        return learnerTask
          ? `- NARRATION_ITEM_MISSING: your narration skipped items the slide shows (${issue.evidence}). Spotlight EACH item element and read it aloud, in order. This slide is the learner's task: never solve an item or hint its answer.`
          : `- NARRATION_ITEM_MISSING: your narration skipped items the slide shows (${issue.evidence}). Spotlight EACH item element and explain it fully, in order.`;
      case 'IMAGE_APPEARANCE_NARRATION':
        return `- IMAGE_APPEARANCE_NARRATION: you described how a picture looks («${issue.evidence}»). Explain what the picture shows mathematically (what is counted or compared, and its numbers); never colours, line styles or positions.`;
      case 'SYMBOL_READING_ARABIC_NAME':
        return `- SYMBOL_READING_ARABIC_NAME: you read Latin letters with Arabic letter names («${issue.evidence}»). Read each Latin letter by its English name: ${letters}. Never «سين» for x, «صاد» for y or «ألف» for a, not even once.`;
      case 'CLOCK_TIME_READ_AS_NUMBER':
        return `- CLOCK_TIME_READ_AS_NUMBER: you read a clock time as a number («${issue.evidence}»). Read it as an hour and its part: 8:30 «الثامنة والنصف», 9:10 «التاسعة وعشر دقائق», 9:50 «التاسعة وخمسون دقيقة».`;
      case 'CONJECTURE_CALLED_PROVED':
        return `- CONJECTURE_CALLED_PROVED: you called a conjecture true because examples satisfy it («${issue.evidence}»). Examples support a conjecture, they never prove it: say «المثال يؤيد التخمين».`;
    }
  });
  return `Your previous narration broke these lesson rules; fix every one:\n${lines.join('\n')}`;
}
