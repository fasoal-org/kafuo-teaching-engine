/**
 * LABEL_SCRIPT_CHANGED (21 Nov 2026, master prompt D2): the book prints a Latin label run
 * on a slide's cited units (ABCD, WXYZ, △PMQ) while the slide's canvas writes the labels
 * as Arabic letters («ز ي س و» for WXYZ, lesson 3-3 scene 12). Deterministic and pure;
 * the package review states it as a finding so the fix loop regenerates the slide once.
 *
 * Never fires when the book itself prints Arabic labels: the check needs a Latin run of
 * two or more distinct letters on the cited units, and compares it with the canvas. A
 * canvas that repeats the book's Latin labels never matches the Arabic-letter form.
 */

/** A word-shaped Latin letter run: `ABCD`, `WXYZ`, `PMQ` (2+ distinct uppercase letters). */
const LATIN_RUN = /\b[A-Z]{2,}\b/g;
/** One Arabic letter alone between separators: «ز ي س و» — never a word of the language. */
const ARABIC_LETTER = /[ء-ي]/u;
/** A spaced run of two or more single Arabic letters: «ز ي س و», «ب ج». */
const SPACED_ARABIC_RUN = /(?:^|[\s(\[««])((?:[ء-ي]\s+){1,5}[ء-ي])(?=$|[\s)\]»،,.:;!?])/gu;

function distinctLetters(run: string): string {
  return [...new Set(run)].join('');
}

/** The Latin label runs a text prints, distinct-letter form (`WXYZ`), uppercase only. */
export function latinLabelRuns(text: string): string[] {
  return [...(text || '').matchAll(LATIN_RUN)]
    .map((match) => distinctLetters(match[0]))
    .filter((run) => run.length >= 2);
}

/**
 * The spaced single-Arabic-letter runs a canvas text prints («ز ي س و»). Only runs of two
 * or more count: a lone «ا» is a word of the language («ا» the letter, yes, but also the
 * alef of prose), and a canvas of real Arabic words never matches.
 */
export function spacedArabicLetterRuns(text: string): string[] {
  const runs: string[] = [];
  for (const match of (text || '').matchAll(SPACED_ARABIC_RUN)) {
    const letters = match[1]!.replace(/\s+/g, '');
    if (letters.length >= 2 && [...letters].every((letter) => ARABIC_LETTER.test(letter))) {
      runs.push(letters);
    }
  }
  return runs;
}

/**
 * Whether the canvas rewrote the book's Latin labels in Arabic letters: the cited units
 * print a Latin run of the same length as a spaced Arabic-letter run on the canvas.
 * Same length, not same letters: the OCR's Latin→Arabic mapping is not a transliteration
 * the check could predict («WXYZ» arrived as «ز ي س و»), but a label run rewritten letter
 * by letter keeps its length.
 */
export function labelScriptChanged(canvasText: string, unitText: string): boolean {
  const latin = latinLabelRuns(unitText);
  if (latin.length === 0) {
    // The book prints no Latin labels here — Arabic labels on the canvas are its own.
    return false;
  }
  const lengths = new Set(latin.map((run) => run.length));
  return spacedArabicLetterRuns(canvasText).some((run) => lengths.has(run.length));
}

/** The check's stable code, as the review finding names it. */
export const LABEL_SCRIPT_CHANGED = 'LABEL_SCRIPT_CHANGED';
