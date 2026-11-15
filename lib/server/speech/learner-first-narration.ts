/**
 * g5.v10 (learner-first, plan `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`):
 * the deterministic checks of a slide's narration against its own canvas. Run inside
 * the narration re-roll loop on g5.v10 runs only; every earlier Teaching Model never
 * reaches this module (D-9 B).
 *
 * Three checks, each a weak-student failure seen on item 208 (15 Nov 2026):
 * - NARRATION_ITEM_MISSING: the slide shows several labelled items (أ، ب، ج …) and the
 *   narration never points to one of them (slides 10 and 13 spoke item أ only).
 * - IMAGE_APPEARANCE_NARRATION: the narration describes a picture's colours, line
 *   styles or place on the page instead of its mathematics (slide 5).
 * - SYMBOL_READING_ARABIC_NAME: a Latin letter on the canvas is read with an Arabic
 *   letter name («ألف باء هاء» for A, B, E; «جيم» for J), against owner decision D-3.
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
  | 'SYMBOL_READING_ARABIC_NAME';

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
    for (const line of lines) {
      const run =
        NAME_RUN.exec(line)?.[1] ??
        SYMBOL_CUED_NAME.exec(line)?.[1] ??
        NUMBER_CUED_NAME.exec(line)?.[1];
      if (run && run.split(/\s+/).some((name) => forbidden.has(name))) {
        issues.push({ code: 'SYMBOL_READING_ARABIC_NAME', evidence: run });
        break;
      }
    }
  }
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
        return `- SYMBOL_READING_ARABIC_NAME: you read Latin letters with Arabic letter names («${issue.evidence}»). Read each Latin letter by its English name: ${letters}.`;
    }
  });
  return `Your previous narration broke these lesson rules; fix every one:\n${lines.join('\n')}`;
}
