import { describe, expect, it } from 'vitest';

import { stripContentUnitIdLabels } from '@/lib/server/teaching-package/outline-unit-labels';
import type { SceneOutline } from '@/lib/types/generation';

function outline(keyPoints: string[], title = 'تمارين: متتابعات وعلاقات'): SceneOutline {
  return {
    id: 'scene_30',
    type: 'slide',
    title,
    description: 'حل التمارين المختارة',
    keyPoints,
    order: 24,
  };
}

const UNIT_IDS = ['4386', '4387', '4390'];

describe('stripContentUnitIdLabels', () => {
  it('removes the unit id labels the planner copied (staging lesson 426)', () => {
    const [cleaned] = stripContentUnitIdLabels(
      [
        outline([
          '4386 | التكلفة والمواعيد ١) ٦٫٧٥ − ٤٫٥٠ = ٢٫٢٥',
          '٤٣٨٧ | السؤال ٧: حاصل ضرب عددين زوجيين',
          'حلّ (4390) | السؤال ٩',
        ]),
      ],
      UNIT_IDS,
    );
    expect(cleaned!.keyPoints).toEqual([
      'التكلفة والمواعيد ١) ٦٫٧٥ − ٤٫٥٠ = ٢٫٢٥',
      'السؤال ٧: حاصل ضرب عددين زوجيين',
      'حلّ السؤال ٩',
    ]);
  });

  it('removes a leading «id:» label from a title or key point', () => {
    const [cleaned] = stripContentUnitIdLabels(
      [outline(['4386: أوجد الحد التالي'], '4387 - تمارين الأمثلة المضادة')],
      UNIT_IDS,
    );
    expect(cleaned!.title).toBe('تمارين الأمثلة المضادة');
    expect(cleaned!.keyPoints).toEqual(['أوجد الحد التالي']);
  });

  it('keeps a number that is not one of the lesson unit ids', () => {
    const points = ['1445 | عدد الطلاب ١٩٠', '٢٦٠ − ١٩٠ = ٧٠ طالبًا', '12: الساعة الثانية عشرة'];
    const input = [outline(points)];
    const [cleaned] = stripContentUnitIdLabels(input, UNIT_IDS);
    expect(cleaned!.keyPoints).toEqual(points);
    expect(cleaned).toBe(input[0]);
  });

  it('returns the plan unchanged when no unit ids are known', () => {
    const input = [outline(['4386 | التكلفة والمواعيد'])];
    expect(stripContentUnitIdLabels(input, [])).toBe(input);
  });
});
