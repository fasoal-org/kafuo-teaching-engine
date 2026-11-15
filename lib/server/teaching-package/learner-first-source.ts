/**
 * g5.v10 (learner-first, plan `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`):
 * two source-side fixes, run on g5.v10 generations only (D-9 B).
 *
 * - D-6 A: the PDF parser (Datalab) wrote an English description of each figure into
 *   the block text («A sequence of three blue triangles showing recursive
 *   subdivision…»). Content Units carry it as if it were lesson text, so the planner
 *   and the narration read it out and attached it to the wrong item (item 208,
 *   slides 5 and 20). Stripped here, before any prompt sees it; stored data is never
 *   changed.
 * - TD-4: one digit style per lesson, the book's (D-2.8). Slide text, quiz text and
 *   LaTeX are normalised after generation.
 */

const LATIN_LETTER = /[A-Za-z]/g;
const ARABIC_LETTER = /[\u0600-\u06FF]/g;

// The parser's figure descriptions name what a picture shows ("A sequence of three
// blue triangles… labeled 1… arranged from left to right"). Lesson English — a
// quotation, a vocabulary line, a code sample — does not use this vocabulary.
const FIGURE_WORDS =
  /\b(?:image|images|figure|figures|diagram|diagrams|illustration|picture|photo|photograph|drawing|shows|showing|depicts|depicting|arranged|labeled|labelled|outlined|shaded|dotted|dashed|arrow|arrows|triangle|triangles|circle|circles|rectangle|square|grid|graph|chart|axis|line|lines|shape|shapes|blue|green|red|yellow|black|white|gray|grey|left|right|top|bottom|center|centre)\b/gi;

/**
 * A line that is a parser's English figure description inside an Arabic lesson: long
 * Latin prose (≥ 6 words, ≥ 30 letters, ≥ 85 % Latin letters) that speaks of a picture
 * (at least three figure words), with no formula (`=`, `\`), no [[marker]], no table
 * pipes and nothing code-like (brackets, quotes, semicolons, tags).
 */
export function isProviderImageDescription(line: string): boolean {
  if (/[=\\|]|\[\[/.test(line)) return false;
  if (/[{}<>;"`]|\w\(|\)\./.test(line)) return false;
  if ((line.match(FIGURE_WORDS)?.length ?? 0) < 3) return false;
  const latin = line.match(LATIN_LETTER)?.length ?? 0;
  const arabic = line.match(ARABIC_LETTER)?.length ?? 0;
  const letters = latin + arabic;
  if (latin < 30 || letters === 0) return false;
  if (latin / letters < 0.85) return false;
  return (
    line
      .trim()
      .split(/\s+/)
      .filter((word) => /[A-Za-z]{2,}/.test(word)).length >= 6
  );
}

/** The text without its provider figure descriptions (Arabic lessons only). */
export function stripProviderImageDescriptions(
  text: string,
  language: string | null | undefined,
): string {
  if (
    !String(language ?? '')
      .toLowerCase()
      .startsWith('ar')
  )
    return text;
  const kept = text.split('\n').filter((line) => !isProviderImageDescription(line));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A figure description is never offered as an image's description (D-6). */
export function providerSafeImageDescription(
  description: string | undefined,
  language: string | null | undefined,
): string | undefined {
  if (!description) return description;
  if (
    !String(language ?? '')
      .toLowerCase()
      .startsWith('ar')
  )
    return description;
  return isProviderImageDescription(description) ? undefined : description;
}

// ── Digits (TD-4) ──────────────────────────────────────────────────────────────

export type LessonDigitStyle = 'western' | 'arabic-indic';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/**
 * The dominant digit style of the lesson's source text: Western when at least 60 % of
 * its digits are Western, Arabic-Indic when they are mostly Arabic-Indic. A source with
 * no digits follows the lesson language: Arabic-Indic for an Arabic lesson, Western for
 * any other.
 */
export function detectLessonDigitStyle(
  texts: readonly string[],
  language?: string | null,
): LessonDigitStyle {
  let western = 0;
  let indic = 0;
  for (const text of texts) {
    western += text.match(/[0-9]/g)?.length ?? 0;
    indic += text.match(/[٠-٩۰-۹]/g)?.length ?? 0;
  }
  const total = western + indic;
  if (total === 0) {
    const arabic = String(language ?? 'ar')
      .toLowerCase()
      .startsWith('ar');
    return arabic ? 'arabic-indic' : 'western';
  }
  return western / total >= 0.6 ? 'western' : 'arabic-indic';
}

// A digit glued to a Latin letter is part of a symbol (1A, H2O, x2, A1): never converted.
const NOT_BESIDE_LATIN = '(?<![A-Za-z])';
const AND_NOT_BEFORE_LATIN = '(?![A-Za-z])';

function toWestern(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/(?<=[0-9])٫(?=[0-9])/g, '.');
}

function toArabicIndic(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => ARABIC_INDIC[PERSIAN.indexOf(d)]!)
    .replace(
      new RegExp(`${NOT_BESIDE_LATIN}[0-9]+(?:\\.[0-9]+)?${AND_NOT_BEFORE_LATIN}`, 'g'),
      (number) => number.replace('.', '٫').replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]!),
    );
}

/** Plain text in the lesson's digit style. */
export function normalizeDigits(text: string, style: LessonDigitStyle): string {
  return style === 'western' ? toWestern(text) : toArabicIndic(text);
}

/**
 * HTML in the lesson's digit style: only text between tags changes, never a tag, an
 * attribute (`font-size:32px`) or an entity (`&#1234;`).
 */
export function normalizeDigitsInHtml(html: string, style: LessonDigitStyle): string {
  return html
    .split(/(<[^>]*>|&#?\w+;)/g)
    .map((part) =>
      part.startsWith('<') || part.startsWith('&') ? part : normalizeDigits(part, style),
    )
    .join('');
}

/**
 * LaTeX in the lesson's digit style. KaTeX renders Western digits as written, so a
 * Western lesson converts any Arabic-Indic digit; an Arabic-Indic lesson keeps its
 * formulas as generated (a formula is not prose).
 */
export function normalizeDigitsInLatex(latex: string, style: LessonDigitStyle): string {
  return style === 'western' ? toWestern(latex) : latex;
}

interface DigitScene {
  type?: string;
  content?: unknown;
}

/** Normalise one generated scene's learner-visible text in place (slide or quiz). */
export function normalizeSceneDigits(scene: DigitScene, style: LessonDigitStyle): void {
  const content = scene.content as Record<string, unknown> | undefined;
  if (!content) return;
  if (scene.type === 'slide') {
    const canvas = content.canvas as { elements?: Array<Record<string, unknown>> } | undefined;
    for (const element of canvas?.elements ?? []) {
      if (element.type === 'text' && typeof element.content === 'string') {
        element.content = normalizeDigitsInHtml(element.content, style);
      } else if (element.type === 'latex' && typeof element.latex === 'string') {
        element.latex = normalizeDigitsInLatex(element.latex, style);
      } else if (element.type === 'shape') {
        const text = element.text as { content?: unknown } | undefined;
        if (text && typeof text.content === 'string') {
          text.content = normalizeDigitsInHtml(text.content, style);
        }
      }
    }
    return;
  }
  if (scene.type === 'quiz') {
    const questions = (content.questions as Array<Record<string, unknown>> | undefined) ?? [];
    for (const question of questions) {
      if (typeof question.question === 'string') {
        question.question = normalizeDigits(question.question, style);
      }
      if (typeof question.analysis === 'string') {
        question.analysis = normalizeDigits(question.analysis, style);
      }
      for (const option of (question.options as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof option.label === 'string') option.label = normalizeDigits(option.label, style);
      }
    }
  }
}
