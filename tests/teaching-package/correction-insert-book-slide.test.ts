import { describe, expect, it } from 'vitest';

import { findBookCoverageDiagnostics } from '@/lib/server/teaching-package/book-coverage';
import {
  applyCorrectionOperations,
  buildCorrectionView,
  diagnoseCandidateOutlines,
  insertableBookGaps,
  parseCorrectionOperations,
  solutionTitle,
  type CorrectionEditContext,
} from '@/lib/server/teaching-package/outline-correction';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationAttempt,
  GenerationCheckpoint,
  GenerationCheckpointSourceRefs,
  KafuoBookStructure,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

// Lesson 306's paused shape for one part: example 2 and its check, which has a
// try-it slide but no solution slide.
const BOOK: KafuoBookStructure = {
  templateVersionId: '2',
  rules: [
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'UNDERSTANDING_CHECK', element: 'try_it', required: true },
  ],
  units: [
    {
      contentUnitId: '4026',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 2,
    },
    {
      contentUnitId: '4028',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 2,
      pairedExampleUnitId: '4026',
    },
  ],
};

const STAGE = { key: 'outcome_visual_explanations', flowIndex: 0 };
// Lesson 306's own policy at this position (the legacy stage rule allows only
// `explanation`, where no solution slide could be inserted).
const FLOW = [
  {
    stage: 'outcome_visual_explanations',
    instructions: 'Teach the part.',
    scenePolicy: {
      visual: 'source_grounded',
      sceneTypes: ['slide'],
      cardinality: 'one_or_more',
      contentRoles: ['explanation', 'worked_example', 'check_understanding'],
    },
  },
] as unknown as TeachingFlowEntry[];
const SKILLS = {
  primary: { skillId: 'understanding-by-design', version: 'v1' },
  classification: 'instructional',
};

function slide(id: string, units: string[], extra: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    slideType: 'content',
    contentRole: 'explanation',
    sourceContentUnitIds: units,
    teachingStage: STAGE,
    ...extra,
  } as SceneOutline;
}

const CANDIDATE = [
  slide('ex2', ['4026'], { contentRole: 'worked_example' }),
  slide('try2', ['4028'], {
    contentRole: 'check_understanding',
    title: 'جرّب: تخمينات جبرية وهندسية',
    keyPoints: ['item one', 'item two'],
    teachingSkills: SKILLS,
  } as Partial<SceneOutline>),
  slide('next', ['9999'], { slideType: 'transition' }),
];

const SOURCE_REFS = {
  contentUnits: [],
  sourceImages: [
    { id: 'src-5', pageNumber: 2, sourceContentUnitIds: ['4028'] },
    { id: 'src-9', pageNumber: 3, sourceContentUnitIds: ['4026'] },
  ],
} as unknown as GenerationCheckpointSourceRefs;

function context(extra: Partial<CorrectionEditContext> = {}): CorrectionEditContext {
  return {
    phase: 'outline',
    flow: FLOW,
    sourceRefs: SOURCE_REFS,
    pendingOutlineIds: null,
    bookStructure: BOOK,
    ...extra,
  };
}

const INSERT = { op: 'insert_book_slide', outlineId: 'try2', unitId: '4028' } as const;

describe('insert_book_slide correction', () => {
  it("titles the solution in the lesson's language, never the admin page's", () => {
    expect(solutionTitle('جرّب: تخمينات جبرية')).toBe('الحل: تخمينات جبرية');
    expect(solutionTitle('تخمينات')).toBe('الحل: تخمينات');
    expect(solutionTitle('Try it: conjectures')).toBe('Solution: conjectures');
  });

  it('parses the operation and its optional title', () => {
    expect(parseCorrectionOperations([{ ...INSERT, title: '  الحل  ' }])).toEqual([
      { ...INSERT, title: 'الحل' },
    ]);
    expect(parseCorrectionOperations([INSERT])).toEqual([INSERT]);
    expect(() =>
      parseCorrectionOperations([{ op: 'insert_book_slide', outlineId: 'try2' }]),
    ).toThrow(/unitId/);
    expect(() => parseCorrectionOperations([{ ...INSERT, title: '' }])).toThrow(/title/);
  });

  it('adds the solution right after the try-it, and the coverage gap closes', () => {
    expect(findBookCoverageDiagnostics(CANDIDATE, BOOK)).toHaveLength(1);

    const edited = applyCorrectionOperations(CANDIDATE, [INSERT], context());

    expect(edited.map((o) => o.id)).toEqual([
      'ex2',
      'try2',
      'try2-book-missing_solution-4028',
      'next',
    ]);
    expect(edited.map((o) => o.order)).toEqual([1, 2, 3, 4]);
    const inserted = edited[2]!;
    expect(inserted).toMatchObject({
      type: 'slide',
      slideType: 'content',
      contentRole: 'worked_example',
      // In the lesson's language, read from the try-it title.
      title: 'الحل: تخمينات جبرية وهندسية',
      keyPoints: ['item one', 'item two'],
      teachingStage: STAGE,
      sourceContentUnitIds: ['4028'],
      suggestedImageIds: ['src-5'],
      visualPlan: { mode: 'image' },
      teachingSkills: SKILLS,
    });
    expect(inserted.description).toContain('solution slide (contentRole worked_example)');
    expect(findBookCoverageDiagnostics(edited, BOOK)).toEqual([]);
    expect(insertableBookGaps(edited, BOOK, FLOW)).toEqual([]);
  });

  it("uses the person's title when given", () => {
    const edited = applyCorrectionOperations(
      CANDIDATE,
      [{ ...INSERT, title: 'الحل: تخمينات' }],
      context(),
    );
    expect(edited[2]!.title).toBe('الحل: تخمينات');
  });

  it('selects no visual when none is linked and the position requires none', () => {
    const { visual: _visual, ...noVisual } = (FLOW[0] as unknown as { scenePolicy: object })
      .scenePolicy as Record<string, unknown>;
    const flow = [{ ...FLOW[0], scenePolicy: noVisual }] as unknown as TeachingFlowEntry[];
    const edited = applyCorrectionOperations(
      CANDIDATE,
      [INSERT],
      context({ flow, sourceRefs: { ...SOURCE_REFS, sourceImages: [] } }),
    );
    expect(edited[2]!.suggestedImageIds).toBeUndefined();
    expect(edited[2]!.visualPlan).toBeUndefined();
  });

  it('refuses a unit with no open gap, a wrong anchor, or no book map', () => {
    expect(() =>
      applyCorrectionOperations(CANDIDATE, [{ ...INSERT, unitId: '4026' }], context()),
    ).toThrow(/no missing solution slide/);
    expect(() =>
      applyCorrectionOperations(CANDIDATE, [{ ...INSERT, outlineId: 'ex2' }], context()),
    ).toThrow(/no missing solution slide/);
    expect(() =>
      applyCorrectionOperations(CANDIDATE, [INSERT], context({ bookStructure: undefined })),
    ).toThrow(/no missing solution slide/);
    // A second insert for the same check finds the gap already closed.
    expect(() => applyCorrectionOperations(CANDIDATE, [INSERT, INSERT], context())).toThrow(
      /no missing solution slide/,
    );
  });

  it('passes the full diagnosis: only the picture note the resume writes stays open', () => {
    const diagnosisContext = {
      flow: FLOW,
      contentUnitIds: ['4026', '4028', '9999'],
      sourceImages: [
        { id: 'src-5', src: '', pageNumber: 2, sourceContentUnitIds: ['4028'] },
        { id: 'src-9', src: '', pageNumber: 3, sourceContentUnitIds: ['4026'] },
      ],
      governed: false,
      bookStructure: BOOK,
    };
    const before = diagnoseCandidateOutlines(CANDIDATE, diagnosisContext).blocking;
    const after = diagnoseCandidateOutlines(
      applyCorrectionOperations(CANDIDATE, [INSERT], context()),
      diagnosisContext,
    ).blocking;
    const insertedId = 'try2-book-missing_solution-4028';
    expect(before.some((d) => d.code === 'BOOK_COVERAGE_INCOMPLETE')).toBe(true);
    expect(after.some((d) => d.code === 'BOOK_COVERAGE_INCOMPLETE')).toBe(false);
    expect(
      after
        .filter((d) => d.outlineId === insertedId)
        .filter((d) => d.code !== 'VISUAL_TEACHING_NOTE_MISSING'),
    ).toEqual([]);
  });

  it('plans a native diagram where the position requires a visual and none is linked', () => {
    const flow = [
      {
        ...FLOW[0],
        scenePolicy: {
          sceneTypes: ['slide'],
          visual: 'source_grounded',
          cardinality: 'one_or_more',
        },
      },
    ] as unknown as TeachingFlowEntry[];
    const edited = applyCorrectionOperations(
      CANDIDATE,
      [INSERT],
      context({ flow, sourceRefs: { ...SOURCE_REFS, sourceImages: [] } }),
    );
    expect(edited[2]!.visualPlan).toEqual({ mode: 'native' });
  });

  it('offers no insert where the position does not allow a worked example', () => {
    const flow = [
      {
        ...FLOW[0],
        scenePolicy: {
          sceneTypes: ['slide'],
          contentRoles: ['check_understanding'],
          cardinality: 'one_or_more',
        },
      },
    ] as unknown as TeachingFlowEntry[];
    expect(insertableBookGaps(CANDIDATE, BOOK, flow)).toEqual([]);
    expect(() => applyCorrectionOperations(CANDIDATE, [INSERT], context({ flow }))).toThrow(
      /no missing solution slide/,
    );
  });

  it('refuses the insert once Scenes exist', () => {
    expect(() =>
      applyCorrectionOperations(
        CANDIDATE,
        [INSERT],
        context({ phase: 'scenes', pendingOutlineIds: ['try2'] }),
      ),
    ).toThrow(/can no longer be removed or reordered/);
  });

  it('lists the insertable slides in the admin view (outline phase only)', () => {
    const attempt = {
      id: 'tpa-1',
      status: 'awaiting_admin_correction',
      teachingModel: null,
      inputSnapshot: { bookStructure: BOOK },
    } as unknown as GenerationAttempt;
    const checkpoint = {
      phase: 'outline',
      state: 'awaiting',
      revision: 1,
      pausedAt: 0,
      updatedAt: 0,
      pendingOutlineIds: null,
      outlines: CANDIDATE,
      diagnostics: findBookCoverageDiagnostics(CANDIDATE, BOOK),
      repairs: [],
      sourceRefs: SOURCE_REFS,
      editLog: [],
    } as unknown as GenerationCheckpoint;

    expect(buildCorrectionView(attempt, checkpoint, FLOW).insertableBookSlides).toEqual([
      {
        kind: 'missing_solution',
        unitId: '4028',
        unitKind: 'UNDERSTANDING_CHECK',
        anchorOutlineId: 'try2',
        anchorTitle: 'جرّب: تخمينات جبرية وهندسية',
        message:
          'UNDERSTANDING_CHECK 4028 in part 2 has a try-it slide but no solution slide after it',
      },
    ]);
    expect(
      buildCorrectionView(attempt, { ...checkpoint, phase: 'scenes' }, FLOW).insertableBookSlides,
    ).toEqual([]);
  });
});
