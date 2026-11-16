/**
 * g5.v11 (teacher-guide answer referee plan §6 comparison rules): the one pure
 * normalizer and comparator, pinned by the shared vectors the backend's independent
 * check can mirror (`tests/fixtures/guide-answer-compare.v1.json`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  arabicNumberWords,
  compareGuideAnswer,
  guideChoiceLetter,
  guideNumbers,
  guideTruthValue,
  leaksGuideAnswer,
  normalizeGuideDigits,
  normalizeGuideText,
  normalizeGuideUnit,
} from '@/lib/server/teaching-package/guide-answer-compare';
import type { KafuoTeacherGuideAnswer } from '@/lib/types/teaching-package';

const VECTORS = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'guide-answer-compare.v1.json'), 'utf8'),
) as {
  contract: string;
  compare: Array<{ answer: KafuoTeacherGuideAnswer; written: string; match: boolean }>;
  leak: Array<{ answer: KafuoTeacherGuideAnswer; text: string; book: string; leak: boolean }>;
};

describe('guide-answer-compare.v1 shared vectors', () => {
  it('names its contract', () => {
    expect(VECTORS.contract).toBe('kafuo.guide-answer-compare.v1');
  });

  it.each(VECTORS.compare.map((vector) => [JSON.stringify(vector.answer), vector.written, vector]))(
    'compare %s with «%s»',
    (_answer, _written, vector) => {
      const { answer, written, match } = vector as (typeof VECTORS.compare)[number];
      const result = compareGuideAnswer(answer, written);
      expect(result.match).toBe(match);
      if (!match) expect(result.reason).toBeTruthy();
    },
  );

  it.each(VECTORS.leak.map((vector) => [JSON.stringify(vector.answer), vector.text, vector]))(
    'leak of %s in «%s»',
    (_answer, _text, vector) => {
      const { answer, text, book, leak } = vector as (typeof VECTORS.leak)[number];
      expect(leaksGuideAnswer(answer, text, book)).toBe(leak);
    },
  );
});

describe('the normalizers', () => {
  it('reads every digit form and decimal separator', () => {
    expect(normalizeGuideDigits('٧١٫٩ و ۱۲ و ٣،٥ و 4,5')).toBe('71.9 و 12 و 3.5 و 4.5');
    // A list separator with a space is never a decimal point.
    expect(guideNumbers('41.6، 51.8، 61.7').map((token) => token.value)).toEqual([
      41.6, 51.8, 61.7,
    ]);
  });

  it('folds diacritics, tatweel, hamza and alef forms, ة and ى', () => {
    expect(normalizeGuideText('الإجـابةُ: إلى الأعلى')).toBe('الاجابه الي الاعلي');
  });

  it('folds a unit to one form', () => {
    expect(normalizeGuideUnit('ريالًا')).toBe('ريال');
    expect(normalizeGuideUnit('ريالات')).toBe('ريال');
    expect(normalizeGuideUnit('cm')).toBe('سم');
  });

  it('reads option letters and truth values', () => {
    expect(guideChoiceLetter('الخيار (ب)')).toBe('B');
    expect(guideChoiceLetter('لا خيار هنا')).toBeNull();
    expect(guideTruthValue('العبارة ليست صحيحة')).toBe(false);
    expect(guideTruthValue('نعم')).toBe(true);
    expect(guideTruthValue('ربما')).toBeNull();
  });
});

// Re-review finding 4: the comparator's false mismatches (each one would remove an
// exercise under D-19) and the leak guard's false leaks and missed spoken numbers.
describe('re-review finding 4', () => {
  it('looks a joined unit up again', () => {
    expect(normalizeGuideUnit('سنتيمترًا مربعًا')).toBe(normalizeGuideUnit('سم²'));
    expect(normalizeGuideUnit('أمتار مكعبة')).toBe('م3');
  });

  it('tells what each number is: a date, a page or a reference is never the answer', () => {
    const kinds = (text: string) => guideNumbers(text).map((token) => token.kind);
    expect(kinds('71.9 في عام ١٤٤٠')).toEqual(['value', 'date']);
    expect(kinds('١٤٤٠هـ')).toEqual(['date']);
    expect(kinds('انظر ص 48 والمثال 3 و 4')).toEqual(['page', 'reference', 'reference']);
    expect(kinds('حل 2A و س11')).toEqual(['label', 'label']);
    expect(kinds('التاريخ 16/11/2026')).toEqual(['date', 'date']);
  });

  it('cannot compare a number that reads two ways with two verdicts, never a mismatch', () => {
    expect(compareGuideAnswer({ type: 'number', value: 3.142 }, '3,142')).toMatchObject({
      match: false,
      undecided: true,
    });
    expect(compareGuideAnswer({ type: 'number', value: 3142 }, '3,142')).toMatchObject({
      undecided: true,
    });
    expect(
      compareGuideAnswer({ type: 'number', value: 1250 }, 'الحدود 2 4 8 والمجموع 1 250'),
    ).toMatchObject({ undecided: true });
    // Both readings wrong: a decided mismatch.
    const wrong = compareGuideAnswer({ type: 'number', value: 50 }, '3,142');
    expect(wrong.match).toBe(false);
    expect(wrong.undecided).toBeUndefined();
    // The context decides: a «.» decimal elsewhere makes the «,» a thousands separator.
    expect(compareGuideAnswer({ type: 'number', value: 3142 }, '2.5 ثم 3,142').match).toBe(true);
  });

  it('reads the numbers said in Arabic words, bounded to 0–9999 and the simple fractions', () => {
    expect(arabicNumberWords('الحد التالي اثنا عشر')).toEqual([12]);
    expect(arabicNumberWords('إحدى عشرة')).toEqual([11]);
    expect(arabicNumberWords('في عام ألف وأربعمائة وأربعين')).toEqual([1440]);
    expect(arabicNumberWords('ألفان وثلاثمائة وخمسة وأربعون')).toEqual([2345]);
    expect(arabicNumberWords('واحد وعشرون')).toEqual([21]);
    expect(arabicNumberWords('ثلاث مائة')).toEqual([300]);
    expect(arabicNumberWords('خمسة آلاف')).toEqual([5000]);
    expect(arabicNumberWords('مائة واثنا عشر')).toEqual([112]);
    expect(arabicNumberWords('ثلاثة أرباع الكعكة ونصف')).toEqual([0.75, 0.5]);
    expect(arabicNumberWords('ثلاثة ونصف')).toEqual([3.5]);
    expect(arabicNumberWords('خمسة وستة')).toEqual([5, 6]);
    expect(arabicNumberWords('والعشرين')).toEqual([20]);
    expect(arabicNumberWords('عشرة آلاف')).toEqual([]);
    expect(arabicNumberWords('لست متأكدًا من أحد')).toEqual([]);
  });

  it('flags a spoken number only in a narration, its givens still let through', () => {
    const twelve = { type: 'number', value: 12 } as const;
    expect(leaksGuideAnswer(twelve, 'الحد التالي هو اثنا عشر', '', { spoken: true })).toBe(true);
    expect(leaksGuideAnswer(twelve, 'الحد التالي هو اثنا عشر')).toBe(false);
    expect(
      leaksGuideAnswer(twelve, 'عندنا اثنا عشر قلمًا', 'مع أحمد 12 قلمًا', { spoken: true }),
    ).toBe(false);
    expect(
      leaksGuideAnswer({ type: 'number', value: 0.75 }, 'الناتج ثلاثة أرباع', '', {
        spoken: true,
      }),
    ).toBe(true);
  });
});
