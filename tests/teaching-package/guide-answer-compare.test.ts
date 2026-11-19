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
  guideAnswerShown,
  isEquationAnswer,
  statesEquation,
} from '@/lib/server/teaching-package/guide-answer-compare';
import type { KafuoTeacherGuideAnswer } from '@/lib/types/teaching-package';

describe('equation answers (lesson 2-5, 17 Nov 2026)', () => {
  const text = (value: string): KafuoTeacherGuideAnswer => ({ type: 'text', value });

  it('tells an equation answer from a prose one', () => {
    expect(isEquationAnswer('y = ³⁄₅ x + ²⁶⁄₅')).toBe(true);
    expect(isEquationAnswer('x = −3')).toBe(true);
    expect(isEquationAnswer('y = 150, y = 10x + 100')).toBe(true);
    expect(isEquationAnswer('يتساوى العرضان عند 5 زيارات؛ يكون Y أفضل لأقل من 5')).toBe(false);
    expect(isEquationAnswer('شوال')).toBe(false);
    expect(isEquationAnswer('n أو p أو r')).toBe(false);
  });

  it.each([
    // The guide's notation against the slide's LaTeX (checks 3A, 3B, 4 and 5 of the run).
    ['y = ³⁄₅ x + ²⁶⁄₅', 'y=\\frac35x+\\frac65+\\frac{20}5=\\boxed{\\frac35x+\\frac{26}5}'],
    ['y = 3x', '\\boxed{y=3x}'],
    ['y = 0', 'y=0'],
    ['y = −3/4 x + 15/4', 'y=-\\frac{3}{4}x+\\frac{15}{4}'],
    // The quiz's Arabic variables and bracketed coefficients.
    ['y = ³⁄₅ x + ²⁶⁄₅', 'ص = (3/5)س + 26/5'],
    ['y = 3x', 'ص = 3س'],
    ['y = −3/4 x + 15/4', 'y = -3/4 x + 15/4'],
    // Point-slope form, a vulgar fraction, a final line's value, a dfrac.
    ['y − 5 = −¾(x + 2)', 'y-5=-\\frac{3}{4}(x+2)'],
    ['y + 6 = 4(x + 3)', 'الإجابة: y+6=4(x+3)'],
    ['y = 5/2 x − 1', 'y=\\dfrac{5}{2}x-1'],
    ['x = −3', '\\left(x=-3\\right)'],
  ])('«%s» matches «%s»', (answer, written) => {
    expect(compareGuideAnswer(text(answer), written).match).toBe(true);
  });

  it.each([
    ['y = ³⁄₅ x + ²⁶⁄₅', 'ص = (5/3)س + 26/5'],
    ['y = ³⁄₅ x + ²⁶⁄₅', 'y-4=\\frac35x+\\frac65'],
    ['y = −3/4 x + 15/4', 'y = 3/4 x + 33/4'],
    ['y = 0', 'y-0=0(x-3)'],
    ['x = 2', 'لا يمكن كتابة معادلته بصيغة الميل والمقطع'],
    ['y = 3x', 'y = 13x'],
  ])('«%s» does not match «%s»', (answer, written) => {
    expect(compareGuideAnswer(text(answer), written).match).toBe(false);
  });

  it('needs every equation of a two-equation answer', () => {
    expect(statesEquation('y = 150, y = 10x + 100', ['y=150', 'y=10x+100'])).toBe(true);
    expect(statesEquation('y = 150, y = 10x + 100', ['y=150'])).toBe(false);
  });

  it('reads an answer shown on the canvas without a final line, never a given', () => {
    const lines = ['تحقق 5', 'y=-\\frac{3}{4}x+3', 'المعادلة:', 'y=-\\frac{3}{4}x+\\frac{15}{4}'];
    expect(guideAnswerShown(text('y = −3/4 x + 15/4'), lines)).toBe(true);
    expect(guideAnswerShown(text('y = −3/4 x + 15/4'), lines.slice(0, 3))).toBe(false);
    // A number ends an equation chain; a bare number in prose is no answer.
    expect(
      guideAnswerShown({ type: 'number', value: 3.75 }, ['b=6-\\frac{9}{4}=\\frac{15}{4}']),
    ).toBe(true);
    expect(guideAnswerShown({ type: 'number', value: 12 }, ['نضيف 3 فيكون 12'])).toBe(false);
    // A choice or truth value is read only from its final line.
    expect(guideAnswerShown({ type: 'choice', value: 'B' }, ['B'])).toBe(false);
  });

  it('reads the LaTeX one-digit fraction shorthand as a number', () => {
    expect(compareGuideAnswer({ type: 'number', value: 3.75 }, '\\frac{15}4').match).toBe(true);
    expect(compareGuideAnswer({ type: 'number', value: 0.6 }, '\\frac35').match).toBe(true);
  });
});

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
