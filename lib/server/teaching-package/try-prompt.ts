/**
 * Lesson 2-5 (17 Nov 2026, item 214 scene 33): a line that asks the learner to try before
 * reading the solution («اكتب المعادلة … قبل قراءة الحل», «قبل ما تتابعون الحل»). On a
 * solution slide it puts the try beside its answer.
 */
const TRY_PROMPT =
  /قبل\s+(?:ما\s+)?(?:قراءة|كشف|إظهار|عرض|نكشف|نعرض|تشوف\S*|تتابع\S*|تقرأ\S*|تكمل\S*)\s+(?:ال)?حل|(?:جرّب|جرب|حاول)(?:وا)?\s+(?:بنفسك|بأنفسكم)/u;

export function asksForTry(text: unknown): boolean {
  return typeof text === 'string' && TRY_PROMPT.test(text.replace(/<[^>]*>/g, ' '));
}
