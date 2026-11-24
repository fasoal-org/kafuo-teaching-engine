/**
 * Owner, 24 Nov 2026: a slide line's direction comes from the line as a whole, not
 * from its first letter. The slide sits in a `dir="ltr"` frame and
 * `unicode-bidi: plaintext` took the first strong letter, so «(1C) انظر …» became a
 * left-to-right line with its «.» on the wrong side. Any Arabic letter makes the
 * line right-to-left; Latin letters alone make it left-to-right; a line with no
 * letters (empty, or numbers only) keeps the CSS fallback.
 */
export type LineDirection = 'rtl' | 'ltr';

const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;

export const lineDirection = (text: string): LineDirection | null => {
  if (ARABIC_LETTER.test(text)) return 'rtl';
  if (LATIN_LETTER.test(text)) return 'ltr';
  return null;
};

/** Sets `dir` on every paragraph and list item under `root` from its own text. */
export const applyLineDirections = (root: HTMLElement) => {
  root.querySelectorAll<HTMLElement>('p, li').forEach((line) => {
    const dir = lineDirection(line.textContent ?? '');
    if (dir) line.setAttribute('dir', dir);
    else line.removeAttribute('dir');
  });
};

/**
 * Removes the `dir` the slide editor puts on paragraphs and list items for display
 * only, so the stored slide HTML stays as it was.
 */
export const stripLineDirections = (html: string) =>
  html.replace(/(<(?:p|li)\b[^>]*?) dir="(?:rtl|ltr|auto)"/g, '$1');
