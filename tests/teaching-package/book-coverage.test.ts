import { describe, expect, it } from 'vitest';

import {
  annotateBookMarkers,
  BOOK_COVERAGE_INCOMPLETE,
  bookStructureRequirement,
  findBookCoverageDiagnostics,
  findBookCoverageGaps,
  plannerVisibleRequiredUnitIds,
  requireEssentialUntypedUnits,
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

  it('places each gap after its anchor slide', () => {
    const outlines = [
      slide('kc', ['11']),
      slide('ex', ['12'], { contentRole: 'worked_example' }),
      slide('try', ['13'], { contentRole: 'check_understanding' }),
    ];
    const gaps = findBookCoverageGaps(outlines, BOOK);
    expect(gaps.map((g) => [g.kind, g.unit.contentUnitId, g.anchorIndex])).toEqual([
      ['missing_solution', '13', 2],
    ]);

    const noTryIt = findBookCoverageGaps(outlines.slice(0, 2), BOOK);
    expect(noTryIt.map((g) => [g.kind, g.anchorIndex])).toEqual([
      ['missing_teaching', 1],
      ['missing_try_it', 1],
    ]);

    const noExample = findBookCoverageGaps([slide('kc', ['11'])], BOOK);
    expect(noExample.map((g) => [g.kind, g.unit.contentUnitId, g.anchorIndex])).toEqual([
      ['missing_teaching', '12', 0],
      ['missing_teaching', '13', 0],
      ['missing_try_it', '13', undefined],
    ]);
  });

  it('flags a check solved before its try-it, with no anchor to re-plan from', () => {
    // Lesson 306: the example's slide also worked its check, ahead of the try-it.
    const outlines = [
      slide('kc', ['11']),
      slide('ex', ['12', '13'], { contentRole: 'worked_example' }),
      slide('try', ['13'], { contentRole: 'check_understanding' }),
      slide('sol', ['13'], { contentRole: 'worked_example' }),
    ];
    const gaps = findBookCoverageGaps(outlines, BOOK);
    expect(gaps.map((g) => [g.kind, g.unit.contentUnitId, g.anchorIndex])).toEqual([
      ['solution_before_try_it', '13', undefined],
    ]);
    expect(findBookCoverageDiagnostics(outlines, BOOK).map((d) => d.message)).toEqual([
      'UNDERSTANDING_CHECK 13 in part 1 is solved on a slide before its try-it slide',
    ]);
    expect(bookStructureRequirement(BOOK)).toContain('Never solve a try_it unit before');
    expect(bookStructureRequirement(BOOK)).toContain('stated as an estimate');
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

  it('requires an untyped part unit only when its role makes it essential', () => {
    const book: KafuoBookStructure = {
      ...BOOK,
      units: [
        ...BOOK.units,
        { contentUnitId: '14', kind: null, element: null, required: false, partIndex: 1 },
        { contentUnitId: '15', kind: null, element: null, required: false, partIndex: 1 },
        { contentUnitId: '16', kind: 'HOOK', element: 'ignore', required: false },
      ],
    };
    const effective = requireEssentialUntypedUnits(book, ['11', '12', '14', '16']);
    const required = effective!.units.filter((unit) => unit.required).map((u) => u.contentUnitId);
    expect(required).toEqual(['11', '12', '13', '14']);
    const outlines = [
      slide('kc', ['11']),
      slide('ex', ['12'], { contentRole: 'worked_example' }),
      slide('try', ['13'], { contentRole: 'check_understanding' }),
      slide('sol', ['13'], { contentRole: 'worked_example' }),
    ];
    expect(findBookCoverageGaps(outlines, effective).map((gap) => gap.message)).toEqual([
      'unit 14 in part 1 has no teaching slide',
    ]);
    expect(requireEssentialUntypedUnits(book, null)).toBe(book);
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

describe('g5.v7 coverage in the correction re-diagnosis', () => {
  it('keeps naming a missing element after an outline edit', async () => {
    const { diagnoseCandidateOutlines } =
      await import('@/lib/server/teaching-package/outline-correction');
    const outlines = [slide('ex', ['12'], { contentRole: 'worked_example' })];
    const context = { flow: [], contentUnitIds: null, sourceImages: [], governed: false };
    const withBook = diagnoseCandidateOutlines(outlines, { ...context, bookStructure: BOOK });
    const without = diagnoseCandidateOutlines(outlines, context);
    // KC 11 has no slide; check 13 has neither a teaching slide nor a try-it slide.
    expect(withBook.blocking.filter((d) => d.code === BOOK_COVERAGE_INCOMPLETE)).toHaveLength(3);
    expect(without.blocking.some((d) => d.code === BOOK_COVERAGE_INCOMPLETE)).toBe(false);
  });
});

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

describe('plannerVisibleRequiredUnitIds (lesson 306, F-2 denominator)', () => {
  const book: KafuoBookStructure = {
    ...BOOK,
    units: [
      ...BOOK.units,
      { contentUnitId: '14', kind: 'RECALL', element: 'prior_knowledge', required: true },
      { contentUnitId: '15', kind: 'EXERCISES', element: 'exercise', required: true },
      { contentUnitId: '16', kind: 'KEY_CONCEPT', element: 'key_concept', required: true },
    ],
  };
  const marker = (id: string) =>
    `[[CONTENT_UNIT id=${id} order=1 role=TEXT]]\ntext\n[[/CONTENT_UNIT]]`;

  it('counts required, one-slide-each units whose marker the planner text carries', () => {
    const text = ['10', '11', '12', '13', '14', '15'].map(marker).join('\n');
    // 10 is not required; 14/15 are rule-placed; 16 was cut from the prompt.
    expect(plannerVisibleRequiredUnitIds(book, text)).toEqual(['11', '12', '13']);
  });

  it('is empty without a book or without markers (pdf fallback)', () => {
    expect(plannerVisibleRequiredUnitIds(undefined, marker('11'))).toEqual([]);
    expect(plannerVisibleRequiredUnitIds(book, 'plain pdf text')).toEqual([]);
  });
});
