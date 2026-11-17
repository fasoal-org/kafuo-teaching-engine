/**
 * Lesson 2-5 (17 Nov 2026, item 214 scene 35): an exercise solution slide titled
 * «حل التمارين ٤–٦» solved only exercise 4. The title names the exercises the canvas solves
 * (its «تمرين N» lines), on the scene and on the slide's own title line.
 */
const TITLE = /حل\s+التمارين?\s+[0-9٠-٩]+(?:\s*[–-]\s*[0-9٠-٩]+)?/u;
const EXERCISE_LINE = /^\s*تمرين\s+([0-9٠-٩]+)/u;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const toNumber = (digits: string) =>
  Number(digits.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))));
const toArabic = (n: number) => String(n).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);
const plain = (html: unknown) =>
  typeof html === 'string' ? html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ') : '';

function titleFor(numbers: number[], arabic: boolean): string {
  const show = arabic ? toArabic : String;
  if (numbers.length === 1) return `حل التمرين ${show(numbers[0])}`;
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  return last - first === numbers.length - 1
    ? `حل التمارين ${show(first)}–${show(last)}`
    : `حل التمارين ${numbers.map(show).join('، ')}`;
}

export function retitledExerciseSolution<T extends { elements: Array<Record<string, unknown>> }>(
  title: string,
  canvas: T,
): { title: string; content: T } | null {
  if (!TITLE.test(title)) return null;
  const numbers = [
    ...new Set(
      canvas.elements
        .map((element) => EXERCISE_LINE.exec(plain(element.content))?.[1])
        .filter((digits): digits is string => digits !== undefined)
        .map(toNumber),
    ),
  ].sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const next = title.replace(TITLE, titleFor(numbers, /[٠-٩]/.test(title)));
  if (next === title) return null;
  const elements = canvas.elements.map((element) => {
    const text = element.content;
    if (typeof text !== 'string' || !TITLE.test(text)) return element;
    const match = TITLE.exec(text)?.[0] ?? '';
    return { ...element, content: text.replace(TITLE, titleFor(numbers, /[٠-٩]/.test(match))) };
  });
  return { title: next, content: { ...canvas, elements } };
}
