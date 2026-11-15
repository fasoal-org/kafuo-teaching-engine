/**
 * g5.v11 (teacher-guide answer referee plan §6 comparison rules): the one pure
 * normalizer and comparator, pinned by the shared vectors the backend's independent
 * check can mirror (`tests/fixtures/guide-answer-compare.v1.json`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
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
