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
// «السؤال ٧», «تمرين ٣». Plain numbered steps («١. …») are steps of ONE item, not items.
const ITEM_LABEL =
  /^\s*(?:(?:تحقق|حل)\s*)?(?:[0-9٠-٩]{1,2}\s*[أبجد](?=[\s)\-—|:.،]|$)|[أبجد]\s*[)\-—|:]|(?:السؤال|سؤال|تمرين)\s*[0-9٠-٩]+)/u;

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
const APPEARANCE =
  /(أزرق|زرقاء|زرق|أخضر|خضراء|خضر|أحمر|حمراء|حمر|أصفر|صفراء|بنفسجي|برتقالي|رمادي|متقطع|متقطعة|منقط|منقطة|الزاوية السفلية|الزاوية العلوية|الركن السفلي|الركن العلوي)/u;

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
// Two or more letter names in a row («ألف باء هاء»), or one after a math cue
// («المتغير نون», «سالب نون», «النقطة كاف»). A year read as «ألف وأربعمئة» never matches.
const NAME_RUN = new RegExp(`(?:^|[\\s،,(«])(${NAME}(?:\\s+${NAME})+)(?=$|[\\s،,.)»؟])`, 'u');
const CUED_NAME = new RegExp(
  `(?:المتغير|المتغيّر|النقطة|القطعة|الزاوية|المستقيم|سالب|العدد)\\s+(${NAME})(?=$|[\\s،,.)»؟])`,
  'u',
);

/** The Latin letters a canvas shows (point names, variables), upper-cased. */
export function canvasLatinLetters(elements: readonly NarrationCanvasElement[]): Set<string> {
  const letters = new Set<string>();
  for (const element of elements) {
    for (const match of element.text.matchAll(/(?<![A-Za-z])([A-Za-z]{1,3})(?![A-Za-z])/g)) {
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
    const described = lines.find((line) => IMAGE_CUE.test(line) && APPEARANCE.test(line));
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
      const run = NAME_RUN.exec(line)?.[1] ?? CUED_NAME.exec(line)?.[1];
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
): string {
  const letters = [...canvasLatinLetters(elements)]
    .filter((letter) => LATIN_LETTER_READINGS[letter])
    .map((letter) => `${letter} «${LATIN_LETTER_READINGS[letter]}»`)
    .join('، ');
  const lines = issues.map((issue) => {
    switch (issue.code) {
      case 'NARRATION_ITEM_MISSING':
        return `- NARRATION_ITEM_MISSING: your narration skipped items the slide shows (${issue.evidence}). Spotlight EACH item element and explain it fully, in order.`;
      case 'IMAGE_APPEARANCE_NARRATION':
        return `- IMAGE_APPEARANCE_NARRATION: you described how a picture looks («${issue.evidence}»). Explain what the picture shows mathematically (what is counted or compared, and its numbers); never colours, line styles or positions.`;
      case 'SYMBOL_READING_ARABIC_NAME':
        return `- SYMBOL_READING_ARABIC_NAME: you read Latin letters with Arabic letter names («${issue.evidence}»). Read each Latin letter by its English name: ${letters}.`;
    }
  });
  return `Your previous narration broke these lesson rules; fix every one:\n${lines.join('\n')}`;
}
