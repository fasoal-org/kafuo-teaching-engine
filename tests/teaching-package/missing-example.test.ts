import { describe, expect, it } from 'vitest';

import {
  missingExampleGaps,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import type { SceneOutline } from '@/lib/types/generation';

// Lesson 2-5 (item 214): Example 3 sat only on check 2's solution and check 3's try.
const BOOK: CoverageBookStructure = {
  templateVersionId: '2',
  rules: [],
  examplesKept: true,
  units: [
    {
      contentUnitId: 'E2',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 2,
    },
    {
      contentUnitId: 'C2',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 2,
      pairedExampleUnitId: 'E2',
    },
    {
      contentUnitId: 'E3',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 3,
    },
    {
      contentUnitId: 'C3',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 3,
      pairedExampleUnitId: 'E3',
    },
  ],
} as CoverageBookStructure;

const slide = (id: string, units: string[], contentRole = 'explanation') =>
  ({
    id,
    type: 'slide',
    title: id,
    slideType: 'content',
    contentRole,
    sourceContentUnitIds: units,
  }) as SceneOutline;

const LESSON_2_5 = [
  slide('example 2', ['E2']),
  slide('check 2 try', ['C2'], 'check_understanding'),
  slide('check 2 solution', ['C2', 'E3'], 'worked_example'),
  slide('check 3 try', ['C3', 'E3'], 'check_understanding'),
];

describe('missingExampleGaps', () => {
  it('finds Example 3 with no slide of its own before check 3, anchored before that try', () => {
    const gaps = missingExampleGaps(LESSON_2_5, BOOK);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      kind: 'missing_example',
      unit: { contentUnitId: 'E3' },
      anchorIndex: 2,
    });
  });

  it('is satisfied by an own slide for the example before its check', () => {
    const outlines = [...LESSON_2_5.slice(0, 3), slide('example 3', ['E3']), LESSON_2_5[3]!];
    expect(missingExampleGaps(outlines, BOOK)).toEqual([]);
  });

  it('does nothing before g5.v11', () => {
    expect(missingExampleGaps(LESSON_2_5, { ...BOOK, examplesKept: undefined })).toEqual([]);
  });
});
