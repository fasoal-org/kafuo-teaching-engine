import { describe, expect, it } from 'vitest';

import {
  LABEL_SCRIPT_CHANGED,
  labelScriptChanged,
  latinLabelRuns,
  spacedArabicLetterRuns,
} from '@/lib/server/teaching-package/label-script-check';

/** The 3-3 shape: the book prints WXYZ, the canvas writes «ز ي س و». */
describe('labelScriptChanged (D2, 21 Nov 2026)', () => {
  it('extracts the Latin label runs a book unit prints', () => {
    expect(latinLabelRuns('ABCD ≅ WXYZ و △PMQ ≅ △JKL')).toEqual(['ABCD', 'WXYZ', 'PMQ', 'JKL']);
    // A single letter or a lower-case word is not a label run.
    expect(latinLabelRuns('النقطة P تنتمي للمستقيم')).toEqual([]);
    expect(latinLabelRuns('value of x')).toEqual([]);
  });

  it('extracts spaced single-Arabic-letter runs, never words', () => {
    expect(spacedArabicLetterRuns('نقرأ: ز ي س و في الشكل')).toEqual(['زيسو']);
    expect(spacedArabicLetterRuns('قاعدة جمع عددين زوجيين')).toEqual([]);
  });

  it('fires on the 3-3 shape: WXYZ in the unit, ز ي س و on the canvas', () => {
    expect(labelScriptChanged('المثلث ز ي س و مطابق', 'ABCD ≅ WXYZ')).toBe(true);
  });

  it('never fires when the book itself prints Arabic labels', () => {
    expect(labelScriptChanged('المثلث س ص ع قائم', 'المثلث س ص ع قائم الزاوية')).toBe(false);
  });

  it('never fires when the canvas keeps the book’s Latin labels', () => {
    expect(labelScriptChanged('المثلث ABCD مطابق لـ WXYZ', 'ABCD ≅ WXYZ')).toBe(false);
  });

  it('the finding code is stable', () => {
    expect(LABEL_SCRIPT_CHANGED).toBe('LABEL_SCRIPT_CHANGED');
  });
});
