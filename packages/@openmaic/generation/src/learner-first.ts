/**
 * g5.v10 — the learner-first Teaching Model (plan
 * `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`, owner decisions D-1..D-10 of
 * 15 Nov 2026). Every rule here reaches a prompt ONLY when the caller sets
 * `learnerFirst` (the run's Teaching Model is `g5@g5.v10`); without it every prompt stays
 * byte-identical (D-9 B: g5.v1–g5.v9 never change).
 *
 * The rules are written for a weak student: what is shown is said, every item is
 * explained, nothing on screen is contradicted by the voice, symbols are read one way,
 * images are explained as mathematics, and a claim is stated before it is tested.
 */
import type { PPTElement } from '@openmaic/dsl';

import { visibleCanvasText } from './slide-assistance.js';

/** D-3 A: a Latin letter is read by its English name, in Arabic script. */
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

/** The table, rendered once for the narration prompt. */
function letterTable(): string {
  return Object.entries(LATIN_LETTER_READINGS)
    .map(([letter, reading]) => `${letter}/${letter.toLowerCase()} = «${reading}»`)
    .join('، ');
}

/**
 * D-2 + D-3 + D-4: the narration rules of a learner-first slide. One block, appended to
 * the slide-actions prompt under its own heading.
 */
/**
 * Roles whose slide sets a task the learner does first: the narration reads every item
 * and never solves it (the role's own rule, "MUST NOT reveal", stands).
 */
export const LEARNER_TASK_ROLES: ReadonlySet<string> = new Set([
  'check_understanding',
  'practice',
  'activity',
]);

/** Whether a slide of this role sets the learner a task (it is read, never solved). */
export function isLearnerTaskRole(contentRole: string | null | undefined): boolean {
  return LEARNER_TASK_ROLES.has(String(contentRole ?? ''));
}

export function learnerFirstNarrationRules(contentRole?: string | null): string {
  const items = isLearnerTaskRole(contentRole)
    ? '1. Read EVERY item the slide shows aloud, in the order shown (أ، ب، ج، … or ١، ٢، ٣ …), spotlighting its element id first. This slide sets the learner a task: never solve an item, never give or hint its answer and never say what to notice — the learner tries first.'
    : '1. Explain EVERY item the slide shows, in the order shown (أ، ب، ج، … or ١، ٢، ٣ …). For each item, first spotlight its element id, then explain it fully to its final answer. Never stop after the first item; a solution slide with three items has three explanations.';
  return [
    items,
    '2. The ELEMENTS list is the authority: say only what is on the canvas, with the same names, directions, numbers and shapes. If the key points disagree with an element, follow the element. Never say "right" where the slide says "left", never call a shape by another name.',
    `3. Read symbols one way for the whole lesson, matching the screen. A Latin letter takes its English name in Arabic script (${letterTable()}); an Arabic letter takes its Arabic name (أ «ألف»، ب «باء»). Put a short noun before a letter whenever it could be misheard: «المتغير إن», «العدد إن», «النقطة إيه», «القطعة إيه بي», «الزاوية إيه بي سي». Never read a Latin letter with an Arabic letter name (never «ألف» for A or a, «جيم» for J or C, «نون» for n, «سين» for x, «صاد» for y).`,
    '4. An image or diagram is explained as mathematics: what is counted, measured or compared, and how it gives the numbers on the slide (for example «في الشكل الأول ٤ قطع، وفي الثاني ١٠»). Never describe colours, line styles or positions on the page (no «أزرق», «متقطع», «في الزاوية السفلية»).',
    '5. Before testing a claim or giving a counterexample, say the claim itself in full («التخمين: إذا كانت الزاويتان متتامتين فإن لهما ضلعًا مشتركًا»).',
    "6. Say the caution «الأمثلة لا تثبت التخمين» only where this slide is about it, at most once. Never read the book's question numbers or the grey book tag; call an item by the slide's own label.",
    // Quality plan W3 (15 Nov 2026): item 208 read 8:30 as «ثمانية وثلاثين» and called a
    // conjecture «صحيح» after one checked case; «صفر» unvowelled can be heard as zero.
    '7. Read a clock time as an hour and its part, the way a teacher says it: 8:30 «الثامنة والنصف», 9:10 «التاسعة وعشر دقائق», 9:15 «التاسعة والربع», 9:50 «التاسعة وخمسون دقيقة». Never «ثمانية وثلاثين» and never «الثامنة والثلاثون». Use the period word the book uses («صباحًا» / «مساءً») and keep it the same on every slide.',
    '8. Examples that satisfy a conjecture support it; they never prove it. Never say «التخمين صحيح» because one or a few cases work; say «المثال يؤيد التخمين». Call a conjecture true only when the slide proves it in general (for example by algebra).',
    '9. Write the Hijri month «صَفَر» with its vowels every time, so it is never heard as the number «صِفر».',
  ].join('\n');
}

/**
 * D-2, D-4, D-7, D-8: the canvas rules of a learner-first slide, appended to the
 * slide-content prompt under its own heading.
 */
export function learnerFirstSlideRules(): string {
  return [
    "1. Show every item this slide sets or solves; label items with the slide's own labels (أ، ب، ج or ١، ٢، ٣). For a textbook exercise, number it locally («تمرين ١») and put the book's number only as a small grey tag in brackets, for example «(س٣٥ في كتابك)» — never as the item's label.",
    '2. When the slide tests a claim or gives a counterexample, write the claim itself first, in full, on the canvas, labelled «التخمين:».',
    "3. The first time a term the lesson teaches appears, show a definition box: the term and the book's own definition sentence, verbatim. A term the lesson uses but the book never defines gets a one-line plain meaning.",
    '4. Use only the methods the textbook source uses. Never add a method of your own (for example an "average rate of change") to reach a result. To estimate a next value from data, add the last difference again (the latest rise) and show that working on the slide.',
    '5. A conjecture from data states what is expected next («غالبًا سيزيد عدد الطلاب في السنة القادمة»), then why the data support it; never only a statement about the past.',
    '6. Never draw an empty placeholder (an empty box, a shape labelled only «إجابة»): every shape carries real content.',
    // Quality plan W4 (item 208 slides 6–8): the learner had no month list to count with.
    '7. An item on a fixed named cycle (the Hijri months, the days of the week) shows the whole cycle, numbered in order, as the given data — on the try-it slide too. It is the data of the item, never a hint.',
    // Quality plan W6 (item 208 on GPT-6.1 Terra, 15 Nov 2026): T-1, T-3, T-4, T-8, T-9, T-10.
    '8. A drawing respects its givens: segments or angles the item gives as equal are drawn equal, and a drawing never shows what the givens deny. When a drawing cannot respect the givens, leave it out.',
    '9. Use only words the lesson has already taught or the book prints for this item; a new term gets a one-line plain meaning on the slide where it first appears. Call a thing by the same book term on the try-it slide and on its solution slide.',
    "10. A solution names every answer its item accepts («أي عدد سالب أو الصفر»), so the learner's own correct try is never contradicted.",
    '11. A definition box quotes a whole sentence of the book, from its start, never half of one.',
    '12. Only a textbook exercise («تمارين») is labelled «تمرين»; a check item («تحقق من فهمك») keeps its own label, for example «تحقق ٣».',
  ].join('\n');
}

/** The prompt variables of a learner-first slide-actions call (empty otherwise). */
export function learnerFirstNarrationVars(
  learnerFirst: boolean | undefined,
  contentRole?: string | null,
): Record<string, unknown> {
  return learnerFirst
    ? {
        hasLearnerFirstNarration: true,
        learnerFirstNarrationRules: learnerFirstNarrationRules(contentRole),
      }
    : {};
}

/**
 * Quality plan W4: the canvas rules of a learner-first STRUCTURAL slide (a part opener,
 * contents, end). It teaches nothing, so it gets no definition box and no diagram.
 */
export function learnerFirstStructuralSlideRules(): string {
  return [
    '1. This slide only opens or closes a part of the lesson: show its title and at most one short line saying what the learner will do next.',
    '2. Teach nothing here: no definition box, no example, no worked step, no diagram and no numbers. The next slide teaches the idea.',
  ].join('\n');
}

/** The prompt variables of a learner-first slide-content call (empty otherwise). */
export function learnerFirstSlideVars(
  learnerFirst: boolean | undefined,
  structural = false,
): Record<string, unknown> {
  if (!learnerFirst) return {};
  return {
    hasLearnerFirstSlide: true,
    learnerFirstSlideRules: structural
      ? learnerFirstStructuralSlideRules()
      : learnerFirstSlideRules(),
  };
}

/**
 * W2: the visible canvas text, one line per text-bearing element, for the narration's
 * "Key Points" on a learner-first slide. The narration is then anchored to what the
 * learner sees, not to the planner's older key points (the AI-review fix loop rebuilds a
 * canvas from a fix note while the plan stays as it was).
 */
export function canvasKeyPoints(elements: readonly PPTElement[], limit = 24): string[] {
  const lines: string[] = [];
  for (const element of elements) {
    if (lines.length >= limit) break;
    if (element.type === 'latex' && 'latex' in element) {
      const latex = String((element as { latex?: unknown }).latex ?? '').trim();
      if (latex) lines.push(latex.slice(0, 400));
      continue;
    }
    if (element.type !== 'text' && element.type !== 'shape' && element.type !== 'table') continue;
    const text = visibleCanvasText([element]).replace(/\s+/g, ' ').trim();
    if (text) lines.push(text.slice(0, 600));
  }
  return lines;
}
