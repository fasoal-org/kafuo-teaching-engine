/**
 * Whole-section coverage: every essential Content Unit of the approved lesson
 * must be cited by at least one teaching outline before Scenes are generated,
 * and an over-long source must never be planned from a silent cut.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  appOutlineDiagnostics,
  applyCorrectionOperations,
  buildCorrectionView,
  diagnosisContextFromCheckpoint,
  type OutlineDiagnosisContext,
} from '@/lib/server/teaching-package/outline-correction';
import {
  essentialContentUnitIds,
  findUncoveredContentUnits,
} from '@/lib/server/teaching-package/outline-grounding';
import {
  adaptNormalizedText,
  type NormalizedLessonManifest,
} from '@/lib/server/teaching-package/normalized-content-resource';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationAttempt,
  GenerationCheckpoint,
  GenerationCheckpointSourceRefs,
} from '@/lib/types/teaching-package';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const unit = (
  id: string,
  orderIndex: number,
  role: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  orderIndex,
  role,
  normalizedText: `text ${id}`,
  blocks: [{ id: `b${id}`, orderIndex, blockType: 'paragraph' }],
  ...extra,
});

const MANIFEST = {
  contentUnits: [
    unit('10', 0, 'CONCEPT_EXPLANATION'),
    unit('11', 1, 'WORKED_EXAMPLE'),
    unit('12', 2, 'PROCEDURE'),
    // Non-instructional or optional material: never required.
    unit('20', 3, 'REFERENCE'),
    unit('21', 4, 'SUMMARY'),
    unit('22', 5, 'UNDERSTANDING_CHECK'),
    unit('23', 6, 'PRACTICE_SET'),
    unit('24', 7, 'UNCLASSIFIED'),
    // Explicitly excluded by the approved structure.
    unit('30', 8, 'CONCEPT_EXPLANATION', {
      blocks: [{ id: 'b30', orderIndex: 8, blockType: 'paragraph', disposition: 'excluded' }],
    }),
    // Figure-only: no text the model ever read.
    unit('31', 9, 'CONCEPT_EXPLANATION', {
      normalizedText: '',
      blocks: [{ id: 'b31', orderIndex: 9, blockType: 'figure', associatedVisualIds: ['v1'] }],
    }),
  ],
} as unknown as NormalizedLessonManifest;

const ESSENTIAL = ['10', '11', '12'];

let seq = 0;
const outline = (fields: Partial<SceneOutline>): SceneOutline =>
  ({
    id: `scene_${++seq}`,
    type: 'slide',
    title: 'S',
    description: '',
    keyPoints: [],
    order: seq,
    ...fields,
  }) as SceneOutline;

const context = (essential: readonly string[] | null): OutlineDiagnosisContext => ({
  flow: [],
  contentUnitIds: null,
  essentialContentUnitIds: essential,
  sourceImages: [],
  governed: false,
});

const coverage = (outlines: SceneOutline[], essential: readonly string[] | null = ESSENTIAL) =>
  appOutlineDiagnostics(outlines, context(essential)).filter(
    (diagnostic) => diagnostic.code === 'COVERAGE_SECTION_MISSING',
  );

const fullPlan = () => [
  outline({ contentRole: 'orientation', sourceContentUnitIds: ['10'] }),
  outline({ contentRole: 'explanation', sourceContentUnitIds: ['10'] }),
  outline({ contentRole: 'worked_example', sourceContentUnitIds: ['11'] }),
  outline({ contentRole: 'procedure', sourceContentUnitIds: ['12'] }),
  outline({ type: 'quiz', sourceContentUnitIds: ['22', '23'] }),
  outline({ contentRole: 'summary', sourceContentUnitIds: ['21'] }),
];

describe('essential sections of the approved source', () => {
  it('keeps only instructional, text-bearing, non-excluded units', () => {
    expect(essentialContentUnitIds(MANIFEST)).toEqual(ESSENTIAL);
  });
});

describe('section coverage diagnosis', () => {
  it('passes when every essential section has a teaching slide', () => {
    expect(coverage(fullPlan())).toEqual([]);
  });

  it('detects one omitted essential section', () => {
    const plan = fullPlan().filter((entry) => entry.contentRole !== 'worked_example');
    const missing = coverage(plan);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      code: 'COVERAGE_SECTION_MISSING',
      disposition: 'admin_correctable',
      field: 'sourceContentUnitIds',
      allowedValues: ['11'],
    });
  });

  it('does not accept introduction, summary, check or quiz slides as teaching evidence', () => {
    const plan = [
      outline({ contentRole: 'explanation', sourceContentUnitIds: ['10'] }),
      outline({ contentRole: 'procedure', sourceContentUnitIds: ['12'] }),
      outline({ contentRole: 'orientation', sourceContentUnitIds: ['11'] }),
      outline({ contentRole: 'summary', sourceContentUnitIds: ['11'] }),
      outline({ contentRole: 'check_understanding', sourceContentUnitIds: ['11'] }),
      outline({ type: 'quiz', sourceContentUnitIds: ['11'] }),
    ];
    expect(findUncoveredContentUnits(plan, ESSENTIAL)).toEqual(['11']);
  });

  it('never fails on excluded, optional or non-instructional material', () => {
    // Nothing cites REFERENCE/SUMMARY/practice/unclassified/excluded/figure-only units.
    const plan = [
      outline({ contentRole: 'explanation', sourceContentUnitIds: ['10', '11', '12'] }),
    ];
    expect(coverage(plan, essentialContentUnitIds(MANIFEST))).toEqual([]);
  });

  it('accepts numeric ids the model copies from the projection', () => {
    const plan = [
      outline({
        contentRole: 'explanation',
        sourceContentUnitIds: [10, 11, 12] as unknown as string[],
      }),
    ];
    expect(coverage(plan)).toEqual([]);
  });

  it('runs no gate without an essential set (PDF fallback, pre-existing checkpoints)', () => {
    expect(coverage([outline({ sourceContentUnitIds: ['10'] })], null)).toEqual([]);
    const legacyRefs = {
      contentUnitIds: ['10'],
      sourceImages: [],
    } as unknown as GenerationCheckpointSourceRefs;
    expect(
      diagnosisContextFromCheckpoint({ sourceRefs: legacyRefs }, [], false).essentialContentUnitIds,
    ).toBeNull();
  });
});

describe('recovery through the existing admin correction', () => {
  const sourceRefs = {
    contentUnitIds: MANIFEST.contentUnits.map((entry) => entry.id),
    essentialContentUnitIds: ESSENTIAL,
    contentUnits: [],
    sourceImages: [],
  } as unknown as GenerationCheckpointSourceRefs;

  it('a correction citing the missing section from a teaching slide clears the finding', () => {
    const plan = fullPlan().filter((entry) => entry.contentRole !== 'worked_example');
    const checkpointContext = diagnosisContextFromCheckpoint({ sourceRefs }, [], false);
    expect(appOutlineDiagnostics(plan, checkpointContext)).toHaveLength(1);

    const explanation = plan.find((entry) => entry.contentRole === 'explanation')!;
    const corrected = applyCorrectionOperations(
      plan,
      [
        {
          op: 'set',
          outlineId: explanation.id,
          field: 'sourceContentUnitIds',
          value: ['10', '11'],
        },
      ],
      { phase: 'outline', flow: [], sourceRefs, pendingOutlineIds: null },
    );
    expect(appOutlineDiagnostics(corrected, checkpointContext)).toEqual([]);
  });

  it('a section that stays missing keeps the attempt from resuming', () => {
    const plan = fullPlan().filter((entry) => entry.contentRole !== 'worked_example');
    const diagnostics = appOutlineDiagnostics(
      plan,
      diagnosisContextFromCheckpoint({ sourceRefs }, [], false),
    );
    const checkpoint = {
      phase: 'outline',
      state: 'awaiting',
      revision: 1,
      pausedAt: 0,
      updatedAt: 0,
      pendingOutlineIds: null,
      outlines: plan,
      diagnostics,
      repairs: [],
      editLog: [],
      sourceRefs,
    } as unknown as GenerationCheckpoint;
    const attempt = {
      id: 'attempt-1',
      status: 'awaiting_admin_correction',
      teachingModel: null,
    } as unknown as GenerationAttempt;
    expect(buildCorrectionView(attempt, checkpoint, []).canResume).toBe(false);
  });
});

describe('source truncation', () => {
  it('fails acquisition instead of planning from a cut source', () => {
    const long = {
      contentUnits: [unit('10', 0, 'CONCEPT_EXPLANATION', { normalizedText: 'x'.repeat(50_001) })],
    } as unknown as NormalizedLessonManifest;
    expect(() => adaptNormalizedText(long)).toThrow(
      expect.objectContaining({ code: 'NORMALIZED_CONTENT_TRUNCATED' }),
    );
  });

  it('keeps a source within the limit untouched', () => {
    expect(adaptNormalizedText(MANIFEST)).toContain('[[CONTENT_UNIT id=10');
  });
});
