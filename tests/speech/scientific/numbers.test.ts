import { describe, expect, it } from 'vitest';

import { integerToArabicWords, numberToArabicWords } from '@/lib/speech/scientific/numbers/ar-words';

describe('Arabic number-to-words (numbersMode: words, §10.1 contingency; O-1 «اثنين» register)', () => {
  it.each([
    [0, 'صفر'],
    [1, 'واحد'],
    [2, 'اثنين'],
    [10, 'عشرة'],
    [11, 'أحد عشر'],
    [12, 'اثني عشر'],
    [19, 'تسعة عشر'],
    [20, 'عشرين'],
    [21, 'واحد وعشرين'],
    [99, 'تسعة وتسعين'],
    [100, 'مئة'],
    [200, 'مئتين'],
    [305, 'ثلاثمئة وخمسة'],
    [1000, 'ألف'],
    [2000, 'ألفين'],
    [3000, 'ثلاثة آلاف'],
    [11000, 'أحد عشر ألفًا'],
    [100000, 'مئة ألف'],
    [1445, 'ألف وأربعمئة وخمسة وأربعين'],
    [2500000, 'مليونين وخمسمئة ألف'],
    [3000000000, 'ثلاثة مليارات'],
  ])('%i → %s', (value, words) => {
    expect(integerToArabicWords(value)).toBe(words);
  });

  it('reads decimals after «فاصلة», keeping leading zeros', () => {
    expect(numberToArabicWords(3, '14', 'فاصلة')).toBe('ثلاثة فاصلة أربعة عشر');
    expect(numberToArabicWords(1, '05', 'فاصلة')).toBe('واحد فاصلة صفر خمسة');
  });

  it('returns null outside its range instead of guessing', () => {
    expect(integerToArabicWords(1e12)).toBeNull();
    expect(integerToArabicWords(-1)).toBeNull();
    expect(integerToArabicWords(1.5)).toBeNull();
  });
});
