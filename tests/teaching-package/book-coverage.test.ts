import { describe, expect, it } from 'vitest';

import {
  annotateBookMarkers,
  BOOK_COVERAGE_INCOMPLETE,
  bookStructureRequirement,
  findBookCoverageDiagnostics,
} from '@/lib/server/teaching-package/book-coverage';
import {
  buildKafuoStartRequest,
  canonicalRequestDigest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';

const BOOK: KafuoBookStructure = {
  templateVersionId: '5',
  rules: [
    { kind: 'KEY_CONCEPT', element: 'key_concept', required: true },
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'UNDERSTANDING_CHECK', element: 'try_it', required: true },
  ],
  units: [
    { contentUnitId: '10', kind: 'LEARNING_GOALS', element: 'objective_source', required: false },
    {
      contentUnitId: '11',
      kind: 'KEY_CONCEPT',
      element: 'key_concept',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '12',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '13',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
      pairedExampleUnitId: '12',
    },
  ],
};

function slide(id: string, units: string[], extra: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    slideType: 'content',
    contentRole: 'explanation',
    sourceContentUnitIds: units,
    ...extra,
  } as SceneOutline;
}

describe('g5.v7 book coverage gate', () => {
  it('passes when every element, try-it and solution has its slide', () => {
    const outlines = [
      slide('t', ['11'], { slideType: 'transition' }),
      slide('kc', ['11']),
      slide('ex', ['12'], { contentRole: 'worked_example' }),
      slide('try', ['13'], { contentRole: 'check_understanding' }),
      slide('sol', ['13'], { contentRole: 'worked_example' }),
    ];
    expect(findBookCoverageDiagnostics(outlines, BOOK)).toEqual([]);
  });

  it('names a missing element and never counts a structural slide as teaching it', () => {
    const outlines = [
      slide('t', ['11'], { slideType: 'transition' }),
      slide('ex', ['12'], { contentRole: 'worked_example' }),
      slide('try', ['13'], { contentRole: 'check_understanding' }),
    ];
    const diagnostics = findBookCoverageDiagnostics(outlines, BOOK);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'KEY_CONCEPT 11 in part 1 has no teaching slide',
      'UNDERSTANDING_CHECK 13 in part 1 has a try-it slide but no solution slide after it',
    ]);
    expect(diagnostics.every((d) => d.code === BOOK_COVERAGE_INCOMPLETE)).toBe(true);
    expect(diagnostics.every((d) => d.disposition === 'admin_correctable')).toBe(true);
  });

  it('is a no-op without a book map (v6 and earlier)', () => {
    expect(findBookCoverageDiagnostics([], undefined)).toEqual([]);
    expect(bookStructureRequirement(undefined)).toBe('');
    expect(annotateBookMarkers('[[CONTENT_UNIT id=12 order=2 role=X]]', undefined)).toBe(
      '[[CONTENT_UNIT id=12 order=2 role=X]]',
    );
  });

  it('adds kind, element and part to the source markers only', () => {
    expect(annotateBookMarkers('[[CONTENT_UNIT id=12 order=2 role=WORKED_EXAMPLE]]\nx', BOOK)).toBe(
      '[[CONTENT_UNIT id=12 order=2 role=WORKED_EXAMPLE kind=WORKED_EXAMPLE element=worked_example part=1]]\nx',
    );
    expect(annotateBookMarkers('[[CONTENT_UNIT id=99 order=9 role=X]]', BOOK)).toBe(
      '[[CONTENT_UNIT id=99 order=9 role=X]]',
    );
  });
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'kafuo-req-1',
    tenantContext: { tenantId: 'tenant-1' },
    actorRef: 'user-42',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Deductive reasoning',
      unit: { id: '12', title: 'Unit 1' },
      curriculum: { id: '5', name: 'Math 1' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      language: 'ar',
    },
    learningObjectives: [
      {
        objectiveRef: '7001',
        snapshot: { statement: 'Law of Detachment.' },
        contentUnitIds: ['11', '12', '13'],
      },
    ],
    teachingModel: {
      key: 'g5',
      version: 'g5.v7',
      flow: [{ stage: 'lesson_opener', instructions: 'Cover.' }],
    },
    contentResource: {
      id: 'cs-77',
      url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
      mimeType: 'application/pdf',
    },
    generation: {},
    bookStructure: BOOK,
    ...overrides,
  };
}

describe('g5.v7 request fields', () => {
  it('parses objective units and the book map, and covers them in the digest', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(body());
    expect(request.learningObjectives[0].contentUnitIds).toEqual(['11', '12', '13']);
    expect(request.bookStructure).toEqual(BOOK);

    const { request: plain } = parseKafuoGenerationRequest(
      body({
        bookStructure: undefined,
        learningObjectives: [
          { objectiveRef: '7001', snapshot: { statement: 'Law of Detachment.' } },
        ],
      }),
    );
    expect(plain.bookStructure).toBeUndefined();
    expect(canonicalRequestDigest(request)).not.toBe(canonicalRequestDigest(plain));

    const { kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(kafuo.bookStructure).toEqual(BOOK);
    expect(kafuo.requirement).toContain('BOOK-STRUCTURED LESSON (g5.v7)');
  });

  it.each([
    [{ bookStructure: [] }, 'bookStructure must be an object'],
    [{ bookStructure: { ...BOOK, templateVersionId: '' } }, 'templateVersionId'],
    [{ bookStructure: { ...BOOK, units: [{ ...BOOK.units[1], partIndex: 0 }] } }, 'partIndex'],
    [
      {
        learningObjectives: [
          { objectiveRef: '7001', snapshot: { statement: 'x' }, contentUnitIds: [1] },
        ],
      },
      'contentUnitIds',
    ],
  ])('refuses a malformed v7 field', (overrides, message) => {
    expect(() => parseKafuoGenerationRequest(body(overrides))).toThrow(message);
  });
});
