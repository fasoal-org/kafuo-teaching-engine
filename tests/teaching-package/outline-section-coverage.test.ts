/**
 * Whole-section coverage. A plan that leaves an essential Content Unit
 * untaught no longer pauses generation: the gap is recorded, the package
 * finishes as a draft, "Generate slide" restores the section, and Submit (the
 * only way to approval) refuses while any essential section is untaught. An
 * over-long source is still never planned from a silent cut.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  computeContentUnitCoverage,
  findUntaughtEssentialSections,
  isTeachingSlide,
  type CoverageGapEvidence,
} from '@/lib/server/teaching-package/content-unit-coverage';
import {
  appOutlineDiagnostics,
  applyCorrectionOperations,
} from '@/lib/server/teaching-package/outline-correction';
import {
  essentialContentUnitIds,
  findUncoveredContentUnits,
} from '@/lib/server/teaching-package/outline-grounding';
import {
  adaptNormalizedText,
  type NormalizedLessonManifest,
} from '@/lib/server/teaching-package/normalized-content-resource';
import type { ContentUnitRow } from '@/lib/persistence/teaching-package';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';
import type { GenerationCheckpointSourceRefs } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

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
    id: `outline_${++seq}`,
    type: 'slide',
    title: 'S',
    description: '',
    keyPoints: [],
    order: seq,
    ...fields,
  }) as SceneOutline;

/** A live slide Scene citing `units`, with an optional slide role. */
const slide = (id: string, units: string[], contentRole?: string): AppScene => {
  const base = makeSlideScene(id, 'stage-1', ++seq);
  return {
    ...base,
    sourceContentUnitIds: units,
    content: { ...base.content, ...(contentRole ? { contentRole } : {}) },
  } as AppScene;
};

const rows = (ids: string[]): ContentUnitRow[] =>
  ids.map(
    (id, index) =>
      ({
        unitId: id,
        orderIndex: index,
        role: 'CONCEPT_EXPLANATION',
        title: null,
        textLength: 10,
      }) as unknown as ContentUnitRow,
  );

describe('essential sections of the approved source', () => {
  it('keeps only instructional, text-bearing, non-excluded units', () => {
    expect(essentialContentUnitIds(MANIFEST)).toEqual(ESSENTIAL);
  });

  it('detects a section the generated plan left untaught (the recorded gap)', () => {
    const plan = [
      outline({ contentRole: 'orientation', sourceContentUnitIds: ['11'] }),
      outline({ contentRole: 'explanation', sourceContentUnitIds: ['10'] }),
      outline({ contentRole: 'procedure', sourceContentUnitIds: ['12'] }),
      outline({ type: 'quiz', sourceContentUnitIds: ['11'] }),
    ];
    expect(findUncoveredContentUnits(plan, ESSENTIAL)).toEqual(['11']);
  });
});

describe('a missing section does not block generation', () => {
  it('raises no admin-correctable finding, so the run is not paused', () => {
    const plan = [outline({ contentRole: 'explanation', sourceContentUnitIds: ['10'] })];
    const diagnostics = appOutlineDiagnostics(plan, {
      flow: [],
      contentUnitIds: MANIFEST.contentUnits.map((entry) => entry.id),
      sourceImages: [],
      governed: false,
    });
    expect(diagnostics).toEqual([]);
  });
});

describe('Submit coverage gate', () => {
  const allTaught = () => [
    slide('s-intro', ['10'], 'orientation'),
    slide('s-10', ['10'], 'explanation'),
    slide('s-11', ['11'], 'worked_example'),
    slide('s-12', ['12'], 'procedure'),
  ];

  it('passes when every essential section has a teaching slide', () => {
    expect(findUntaughtEssentialSections(ESSENTIAL, allTaught(), null)).toEqual([]);
  });

  it('refuses a section taught only by an introduction, recap or check slide', () => {
    const scenes = [
      slide('s-10', ['10'], 'explanation'),
      slide('s-12', ['12'], 'procedure'),
      slide('s-o', ['11'], 'orientation'),
      slide('s-s', ['11'], 'summary'),
      slide('s-c', ['11'], 'check_understanding'),
    ];
    expect(findUntaughtEssentialSections(ESSENTIAL, scenes, null)).toEqual(['11']);
  });

  it('re-evaluates after a deletion: the only teaching slide removed → refused again', () => {
    const scenes = allTaught().filter((scene) => scene.id !== 's-12');
    expect(findUntaughtEssentialSections(ESSENTIAL, scenes, null)).toEqual(['12']);
  });

  describe('a section the plan left untaught (gap 11)', () => {
    const base = [slide('s-10', ['10'], 'explanation'), slide('s-12', ['12'], 'procedure')];
    const gapsWith = (inserted: Record<string, string[]>): CoverageGapEvidence => ({
      gapUnitIds: new Set(['11']),
      insertedSlideUnits: new Map(Object.entries(inserted)),
    });

    it('is refused while missing', () => {
      expect(findUntaughtEssentialSections(ESSENTIAL, base, null, gapsWith({}))).toEqual(['11']);
    });

    it('is NOT restored by citing it from an unrelated teaching slide', () => {
      const cited = [
        slide('s-10', ['10', '11'], 'explanation'),
        slide('s-12', ['12'], 'procedure'),
      ];
      expect(findUntaughtEssentialSections(ESSENTIAL, cited, null, gapsWith({}))).toEqual(['11']);
      // The lesson parts panel agrees, so "Generate slide" stays offered for it.
      const panel = computeContentUnitCoverage(rows(ESSENTIAL), cited, null, gapsWith({}));
      expect(panel.find((entry) => entry.id === '11')?.covered).toBe(false);
    });

    it('is restored by the slide "Generate slide" built for it', () => {
      const recovered = [...base, slide('s-ins', ['11'], 'explanation')];
      const gaps = gapsWith({ 's-ins': ['11'] });
      expect(findUntaughtEssentialSections(ESSENTIAL, recovered, null, gaps)).toEqual([]);
      const panel = computeContentUnitCoverage(rows(ESSENTIAL), recovered, null, gaps);
      expect(panel.find((entry) => entry.id === '11')?.coveredBySlideIds).toEqual(['s-ins']);
    });

    it('is refused again if the generated slide is deleted', () => {
      expect(
        findUntaughtEssentialSections(ESSENTIAL, base, null, gapsWith({ 's-ins': ['11'] })),
      ).toEqual(['11']);
    });
  });

  it('counts only slides as teaching (quiz and other Scene types do not)', () => {
    const quiz = { ...slide('q', ['11']), type: 'quiz' } as AppScene;
    expect(isTeachingSlide(quiz)).toBe(false);
    expect(isTeachingSlide(slide('s', ['11']))).toBe(true);
  });
});

describe('outline correction cannot claim a gap by citation', () => {
  const sourceRefs = {
    contentUnitIds: MANIFEST.contentUnits.map((entry) => entry.id),
    coverageGapUnitIds: ['11'],
    contentUnits: [],
    sourceImages: [],
  } as unknown as GenerationCheckpointSourceRefs;
  const context = { phase: 'outline' as const, flow: [], sourceRefs, pendingOutlineIds: null };

  it('refuses attaching a recorded gap section to an existing slide', () => {
    const plan = [
      outline({ id: 'o-10', contentRole: 'explanation', sourceContentUnitIds: ['10'] }),
    ];
    expect(() =>
      applyCorrectionOperations(
        plan,
        [{ op: 'set', outlineId: 'o-10', field: 'sourceContentUnitIds', value: ['10', '11'] }],
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('still allows ordinary grounding fixes', () => {
    const plan = [outline({ id: 'o-x', sourceContentUnitIds: [] })];
    const corrected = applyCorrectionOperations(
      plan,
      [{ op: 'set', outlineId: 'o-x', field: 'sourceContentUnitIds', value: ['10'] }],
      context,
    );
    expect(corrected[0]?.sourceContentUnitIds).toEqual(['10']);
  });
});

describe('source truncation stays a hard failure', () => {
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
