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

/** Review H5 (21 Nov 2026): ordinary Arabic maths text is not a rewritten label run. */
describe('labelScriptChanged: false positives (H5)', () => {
  it('«س و ص» is two variables joined by «و», not a label run', () => {
    expect(labelScriptChanged('أوجد قيمتي س و ص', 'في △ABC أوجد قيمة كل متغير')).toBe(false);
    expect(spacedArabicLetterRuns('أوجد قيمتي س و ص')).toEqual([]);
  });

  it('«٣ م و ٤ م» is two lengths with their unit, not a label run', () => {
    expect(labelScriptChanged('طولا الضلعين ٣ م و ٤ م', 'AB = 3 m')).toBe(false);
    expect(spacedArabicLetterRuns('طولا الضلعين ٣ م و ٤ م')).toEqual([]);
  });

  it('a run whose letters the cited units print on their own is the book’s own', () => {
    // The unit prints AB and the variables س and ص: «س ص» on the canvas is the book's.
    expect(labelScriptChanged('نعوّض س ص', 'إذا كان AB يساوي س ص')).toBe(false);
    // The same canvas against a unit with the Latin run only still fires.
    expect(labelScriptChanged('نعوّض س ص', 'إذا كان AB يساوي 5')).toBe(true);
  });

  it('the 3-3 shape still fires, inside real Arabic prose that holds ز ي س و within words', () => {
    const unit =
      'في الشكل المجاور، يُطابق الشكل الرباعي ABCD الشكل الرباعي WXYZ. اكتب عبارة التطابق وسمِّ الزوايا المتطابقة.';
    expect(labelScriptChanged('المثلث ز ي س و مطابق', unit)).toBe(true);
    expect(labelScriptChanged('الشكل ز ي س و.', unit)).toBe(true);
  });
});

/** Review MEDIUM (21 Nov 2026): label runs the first version missed. */
describe('labelScriptChanged: false negatives', () => {
  it('a label glued to △ or ∠', () => {
    expect(labelScriptChanged('في المثلث △ز ي س', '△XYZ قائم الزاوية')).toBe(true);
    expect(labelScriptChanged('قياس ∠أ ب ج', 'm∠ABC = 40°')).toBe(true);
  });

  it('comma-separated labels', () => {
    expect(labelScriptChanged('النقاط ز، ي، س على استقامة واحدة', 'X, Y, Z: XYZ')).toBe(true);
    expect(spacedArabicLetterRuns('النقاط ز، ي، س على')).toEqual(['زيس']);
  });

  it('labels with harakat or primes, and a primed Latin run in the book', () => {
    expect(labelScriptChanged('المثلث سَ صَ عَ', 'PQR')).toBe(true);
    expect(labelScriptChanged('صورة المثلث أ′ ب′ ج′', '△A′B′C′ صورة △ABC')).toBe(true);
    expect(latinLabelRuns('△A′B′C′ صورة △ABC')).toEqual(['A′B′C′', 'ABC']);
  });

  it('adds no new finding on bracketed list markers', () => {
    expect(labelScriptChanged('(أ) (ب) (ج)', 'ABC')).toBe(false);
  });
});

/** Review MEDIUM (21 Nov 2026, second pass): the comma rule read ordinary lists as labels. */
describe('labelScriptChanged: comma-separated lists', () => {
  it('an answer list «أ، ب، ج» is not a label run', () => {
    expect(labelScriptChanged('أجب عن الأسئلة أ، ب، ج', 'المثلث ABC')).toBe(false);
    expect(spacedArabicLetterRuns('أجب عن الأسئلة أ، ب، ج')).toEqual([]);
  });

  it('a bracketed coordinate pair «(س، ص)» is never a label run', () => {
    expect(labelScriptChanged('النقطة (س، ص) تقع على المستقيم', 'AB')).toBe(false);
    expect(spacedArabicLetterRuns('(س، ص)')).toEqual([]);
    // Not even after a geometry cue.
    expect(spacedArabicLetterRuns('النقاط (س، ص)')).toEqual([]);
  });

  it('comma-separated letters after a geometry cue are still labels', () => {
    expect(labelScriptChanged('△ز، ي، س قائم الزاوية', 'XYZ')).toBe(true);
    expect(labelScriptChanged('∠أ، ب، ج حادة', 'ABC')).toBe(true);
    expect(labelScriptChanged('الرؤوس ز، ي، س', 'XYZ')).toBe(true);
    expect(labelScriptChanged('المثلث ز، ي، س', 'XYZ')).toBe(true);
    expect(labelScriptChanged('الشكل الرباعي ز، ي، س، ل', 'WXYZ')).toBe(true);
  });

  it('a run is skipped when the canvas itself prints a Latin run of the same length', () => {
    expect(labelScriptChanged('في المثلث ABC: النقاط أ، ب، ج', 'المثلث ABC')).toBe(false);
    expect(labelScriptChanged('في المثلث ABC نرسم ز ي س', 'XYZ')).toBe(false);
  });

  it('«ز ي س و» for WXYZ still fires', () => {
    expect(labelScriptChanged('ز ي س و', 'WXYZ')).toBe(true);
    expect(labelScriptChanged('الشكل الرباعي ز ي س و', 'الشكل الرباعي WXYZ')).toBe(true);
  });
});

/** Review LOW (21 Nov 2026): «و» inside a label run is a letter, not the conjunction. */
describe('labelScriptChanged: «و» inside a label run', () => {
  it('«و س ي ز» for WXYZ fires', () => {
    expect(labelScriptChanged('الشكل الرباعي و س ي ز', 'WXYZ')).toBe(true);
    expect(spacedArabicLetterRuns('الشكل الرباعي و س ي ز')).toEqual(['وسيز']);
  });

  it('«هـ و ز ح» for EFGH fires', () => {
    expect(labelScriptChanged('الشكل هـ و ز ح متوازي أضلاع', 'EFGH')).toBe(true);
    expect(spacedArabicLetterRuns('الشكل هـ و ز ح')).toEqual(['هوزح']);
  });

  it('«و» between single letters is still the conjunction', () => {
    expect(spacedArabicLetterRuns('أوجد قيمتي س و ص')).toEqual([]);
    expect(labelScriptChanged('أوجد قيمتي س و ص', 'في △ABC أوجد قيمة كل متغير')).toBe(false);
    expect(spacedArabicLetterRuns('طولا الضلعين ٣ م و ٤ م')).toEqual([]);
  });
});
