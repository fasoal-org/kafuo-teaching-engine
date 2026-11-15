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
export function learnerFirstNarrationRules(): string {
  return [
    '1. Explain EVERY item the slide shows, in the order shown (أ، ب، ج، … or ١، ٢، ٣ …). For each item, first spotlight its element id, then explain it fully to its final answer. Never stop after the first item; a solution slide with three items has three explanations.',
    '2. The ELEMENTS list is the authority: say only what is on the canvas, with the same names, directions, numbers and shapes. If the key points disagree with an element, follow the element. Never say "right" where the slide says "left", never call a shape by another name.',
    `3. Read symbols one way for the whole lesson, matching the screen. A Latin letter takes its English name in Arabic script (${letterTable()}); an Arabic letter takes its Arabic name (أ «ألف»، ب «باء»). Put a short noun before a letter whenever it could be misheard: «المتغير إن», «العدد إن», «النقطة إيه», «القطعة إيه بي», «الزاوية إيه بي سي». Never read a Latin letter with an Arabic letter name (never «ألف» for A, «جيم» for J or C, «نون» for n, «سين» for x).`,
    '4. An image or diagram is explained as mathematics: what is counted, measured or compared, and how it gives the numbers on the slide (for example «في الشكل الأول ٤ قطع، وفي الثاني ١٠»). Never describe colours, line styles or positions on the page (no «أزرق», «متقطع», «في الزاوية السفلية»).',
    '5. Before testing a claim or giving a counterexample, say the claim itself in full («التخمين: إذا كانت الزاويتان متتامتين فإن لهما ضلعًا مشتركًا»).',
    "6. Say the caution «الأمثلة لا تثبت التخمين» only where this slide is about it, at most once. Never read the book's question numbers or the grey book tag; call an item by the slide's own label.",
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
    '4. Use only the methods the textbook source uses. Never add a method of your own (for example an "average rate of change") to reach a result.',
    '5. A conjecture from data states what is expected next («غالبًا سيزيد عدد الطلاب في السنة القادمة»), then why the data support it; never only a statement about the past.',
    '6. Never draw an empty placeholder (an empty box, a shape labelled only «إجابة»): every shape carries real content.',
  ].join('\n');
}

/** The prompt variables of a learner-first slide-actions call (empty otherwise). */
export function learnerFirstNarrationVars(
  learnerFirst: boolean | undefined,
): Record<string, unknown> {
  return learnerFirst
    ? { hasLearnerFirstNarration: true, learnerFirstNarrationRules: learnerFirstNarrationRules() }
    : {};
}

/** The prompt variables of a learner-first slide-content call (empty otherwise). */
export function learnerFirstSlideVars(learnerFirst: boolean | undefined): Record<string, unknown> {
  return learnerFirst
    ? { hasLearnerFirstSlide: true, learnerFirstSlideRules: learnerFirstSlideRules() }
    : {};
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
