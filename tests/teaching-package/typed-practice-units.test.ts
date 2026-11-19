import { describe, expect, it } from 'vitest';

import { withTypedPracticeUnits } from '@/lib/server/teaching-package/book-coverage';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';

// Lesson 2-5 (item 214): «تأكد» (6419) and a «تدرب» continuation (6423) came untyped, so
// their 67 guide answers were logged «not a check or exercise unit of this lesson».
const BOOK = {
  templateVersionId: '2',
  rules: [
    { kind: 'GUIDED_PRACTICE', element: 'exercise', required: true },
    { kind: 'PRACTICE', element: 'exercise', required: true },
  ],
  units: [
    { contentUnitId: '6419', kind: null, element: null, required: false },
    { contentUnitId: '6423', kind: null, element: null, required: false },
    { contentUnitId: '6431', kind: null, element: null, required: false },
  ],
} as unknown as KafuoBookStructure;

const SOURCE = [
  { id: '6419', role: 'PRACTICE_SET', subtype: 'GUIDED_PRACTICE' },
  { id: '6423', role: 'PRACTICE_SET', subtype: 'INDEPENDENT_PRACTICE' },
  { id: '6431', role: 'PRACTICE_SET', subtype: 'TEST_PREP' },
];

describe('withTypedPracticeUnits', () => {
  it('types the lesson’s own «تأكد» and «تدرب» units as exercises', () => {
    const units = withTypedPracticeUnits(BOOK, SOURCE)!.units;
    expect(units[0]).toMatchObject({ kind: 'GUIDED_PRACTICE', element: 'exercise' });
    expect(units[1]).toMatchObject({ kind: 'PRACTICE', element: 'exercise' });
  });

  it('leaves any other unit as the map sent it, and the same book when nothing changes', () => {
    expect(withTypedPracticeUnits(BOOK, SOURCE)!.units[2]).toMatchObject({ element: null });
    expect(withTypedPracticeUnits(BOOK, [SOURCE[2]!])).toBe(BOOK);
  });
});
