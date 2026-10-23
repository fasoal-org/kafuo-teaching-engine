import { describe, expect, it } from 'vitest';

import type { OutlineDiagnostic } from '@openmaic/generation';

import type { ContentUnitRow } from '@/lib/persistence/teaching-package';
import {
  allowedStagesAt,
  citedContentUnitIds,
  computeContentUnitCoverage,
  diagnosticIdentity,
  insertionPositionOptions,
  newPolicyDiagnostics,
  placeholderProjection,
  policyOutlineProjection,
  resolveInsertionPosition,
  shiftScenesForInsertion,
  suggestInsertionPosition,
} from '@/lib/server/teaching-package/content-unit-coverage';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

/** Reviewer-generated slide plan §8–§9 (`content-unit-coverage`): pure geometry and coverage. */

const STAGE = 'stage-cov';

function scene(id: string, order: number, extra: Partial<AppScene> = {}): AppScene {
  return { ...makeSlideScene(id, STAGE, order), ...extra } as AppScene;
}

function unit(id: string, order: number, role = 'CONCEPT'): ContentUnitRow {
  return {
    attemptId: 'tpa',
    tenantId: 't',
    unitId: id,
    orderIndex: order,
    role,
    subtype: null,
    title: id,
    normalizedText: `text ${id}`,
    textLength: 10,
    contentRevisionId: null,
    approvedSnapshotId: null,
    createdAt: 1,
  };
}

const flow: TeachingFlowEntry[] = [
  {
    stage: 'lesson_opener',
    instructions: 'o',
    scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
  },
  {
    stage: 'explain',
    instructions: 'e',
    scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
  },
  {
    stage: 'quiz',
    instructions: 'q',
    scenePolicy: { sceneTypes: ['quiz'], cardinality: 'one_or_more' },
  },
  {
    stage: 'explain',
    instructions: 'e2',
    scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
  },
] as TeachingFlowEntry[];

describe('citedContentUnitIds — Help parity (F8)', () => {
  const outline = {
    outlines: [
      { id: 'o1', sourceContentUnitIds: [7, 'cu_a', '', null] },
      { id: 'o2', sourceContentUnitIds: ['cu_b'] },
    ],
  } as never;

  it('uses the Scene array when present, even empty, filtered to non-empty strings', () => {
    expect(citedContentUnitIds({ sourceContentUnitIds: [], outlineId: 'o1' }, outline)).toEqual([]);
    expect(
      citedContentUnitIds(
        { sourceContentUnitIds: ['x', '', 3 as never], outlineId: 'o1' },
        outline,
      ),
    ).toEqual(['x']);
  });

  it('falls back to the outline entry by outlineId only — numeric ids as strings', () => {
    expect(citedContentUnitIds({ outlineId: 'o1' }, outline)).toEqual(['7', 'cu_a']);
    expect(citedContentUnitIds({ outlineId: 'missing' }, outline)).toEqual([]);
    expect(citedContentUnitIds({}, outline)).toEqual([]);
  });
});

describe('coverage (slides only)', () => {
  it('a unit cited only by a quiz is uncovered and reported separately', () => {
    const coverage = computeContentUnitCoverage(
      [unit('cu_1', 1), unit('cu_2', 2), unit('cu_ref', 3, 'REFERENCE')],
      [
        scene('s1', 1, { sourceContentUnitIds: ['cu_1'] }),
        scene('q1', 2, { type: 'quiz', sourceContentUnitIds: ['cu_2'] } as Partial<AppScene>),
      ],
      null,
    );
    expect(coverage.map((entry) => [entry.id, entry.covered, entry.instructional])).toEqual([
      ['cu_1', true, true],
      ['cu_2', false, true],
      ['cu_ref', false, false],
    ]);
    expect(coverage[1]!.citedByOtherSceneIds).toEqual(['q1']);
  });
});

describe('positions and stages (§9.1–§9.2)', () => {
  const scenes = [
    scene('s1', 1, {
      teachingStage: { key: 'lesson_opener', flowIndex: 0 },
      sourceContentUnitIds: [],
    }),
    scene('s2', 2, {
      teachingStage: { key: 'explain', flowIndex: 1 },
      sourceContentUnitIds: ['cu_1'],
    }),
    scene('q1', 3, {
      type: 'quiz',
      teachingStage: { key: 'quiz', flowIndex: 2 },
    } as Partial<AppScene>),
    scene('s3', 4, {
      teachingStage: { key: 'explain', flowIndex: 3 },
      sourceContentUnitIds: ['cu_3'],
    }),
  ];

  it('resolves only adjacent anchors; `at` is the shifted position', () => {
    expect(
      resolveInsertionPosition(scenes, { afterSceneId: 's2', beforeSceneId: 'q1' }),
    ).toMatchObject({
      ok: true,
      at: 3,
    });
    expect(
      resolveInsertionPosition(scenes, { afterSceneId: null, beforeSceneId: 's1' }),
    ).toMatchObject({
      ok: true,
      at: 1,
    });
    expect(
      resolveInsertionPosition(scenes, { afterSceneId: 's3', beforeSceneId: null }),
    ).toMatchObject({
      ok: true,
      at: 5,
    });
    expect(resolveInsertionPosition(scenes, { afterSceneId: 's1', beforeSceneId: 'q1' })).toEqual({
      ok: false,
      reason: 'not_adjacent',
    });
    expect(resolveInsertionPosition(scenes, { afterSceneId: 'nope', beforeSceneId: null })).toEqual(
      {
        ok: false,
        reason: 'unknown_anchor',
      },
    );
  });

  it('allowed stages by (key, flowIndex): a repeated key is two different stages', () => {
    const at = (after: string | null, before: string | null) => {
      const position = resolveInsertionPosition(scenes, {
        afterSceneId: after,
        beforeSceneId: before,
      });
      if (!position.ok) throw new Error('not ok');
      return allowedStagesAt(scenes, flow, position);
    };
    // The opener is exactly_one and full; inside the boundary only explain/1.
    expect(at('s1', 's2')).toEqual([{ key: 'explain', flowIndex: 1 }]);
    // explain/1 → quiz/2: quiz positions do not allow a slide.
    expect(at('s2', 'q1')).toEqual([{ key: 'explain', flowIndex: 1 }]);
    // quiz/2 → explain/3 (same key as flowIndex 1, different stage).
    expect(at('q1', 's3')).toEqual([{ key: 'explain', flowIndex: 3 }]);
    // The very start: only the right-hand opener, which is full.
    expect(at(null, 's1')).toEqual([]);
    expect(at('s3', null)).toEqual([{ key: 'explain', flowIndex: 3 }]);
  });

  it('cardinality counts live scenes of EVERY type', () => {
    const quizOnly: TeachingFlowEntry[] = [
      {
        stage: 'q',
        instructions: 'q',
        scenePolicy: { sceneTypes: ['slide', 'quiz'], cardinality: 'exactly_one' },
      },
    ] as TeachingFlowEntry[];
    const withQuiz = [
      scene('q', 1, {
        type: 'quiz',
        teachingStage: { key: 'q', flowIndex: 0 },
      } as Partial<AppScene>),
    ];
    const position = resolveInsertionPosition(withQuiz, { afterSceneId: 'q', beforeSceneId: null });
    if (!position.ok) throw new Error('not ok');
    expect(allowedStagesAt(withQuiz, quizOnly, position)).toEqual([]);
  });

  it('one option per gap', () => {
    const options = insertionPositionOptions(scenes, flow);
    expect(options).toHaveLength(5);
    expect(options[0]).toMatchObject({
      afterSceneId: null,
      beforeSceneId: 's1',
      allowedStages: [],
    });
  });

  it('suggests after the last slide of the nearest preceding covered unit, else before the next, else the end', () => {
    const coverage = computeContentUnitCoverage(
      [unit('cu_1', 1), unit('cu_2', 2), unit('cu_3', 3), unit('cu_4', 4)],
      scenes,
      null,
    );
    expect(suggestInsertionPosition('cu_2', coverage, scenes)).toEqual({
      afterSceneId: 's2',
      beforeSceneId: 'q1',
    });
    expect(suggestInsertionPosition('cu_4', coverage, scenes)).toEqual({
      afterSceneId: 's3',
      beforeSceneId: null,
    });
    const onlyLater = computeContentUnitCoverage([unit('cu_0', 0), unit('cu_3', 3)], scenes, null);
    expect(suggestInsertionPosition('cu_0', onlyLater, scenes)).toEqual({
      afterSceneId: 'q1',
      beforeSceneId: 's3',
    });
  });
});

describe('projections and diagnostic identities (§9.3–§9.4)', () => {
  it('shifts orders only and places the placeholder', () => {
    const scenes = [scene('a', 1), scene('b', 2), scene('c', 3)];
    expect(shiftScenesForInsertion(scenes, 2).map((entry) => entry.order)).toEqual([1, 3, 4]);
    const projected = placeholderProjection(scenes, 2, {
      id: 'new',
      outlineId: 'ins_x',
      teachingStage: { key: 'explain', flowIndex: 1 },
      stageId: STAGE,
    });
    expect(projected.map((entry) => [entry.id, entry.order])).toEqual([
      ['a', 1],
      ['b', 3],
      ['c', 4],
      ['new', 2],
    ]);
  });

  it('uses the stored outline entry by id as stored, else the Scene’s own fields', () => {
    const outline = {
      outlines: [
        {
          id: 'o-a',
          order: 9,
          type: 'slide',
          title: 'planned',
          description: 'd',
          keyPoints: [],
          teachingStage: { key: 'explain', flowIndex: 1 },
          teachingSkills: { classification: 'instructional' },
        },
      ],
    } as never;
    const projection = policyOutlineProjection(
      [
        scene('a', 1, { outlineId: 'o-a' }),
        scene('b', 2, { teachingStage: { key: 'explain', flowIndex: 1 } }),
      ],
      outline,
    );
    expect(projection[0]).toMatchObject({ id: 'o-a', order: 1, title: 'planned' });
    expect(projection[1]).toMatchObject({
      id: 'b',
      teachingStage: { key: 'explain', flowIndex: 1 },
    });
  });

  it('identity ignores array indexes; stage-wide codes key on flowIndex', () => {
    const outlineScoped = {
      code: 'VISUAL_REQUIRED',
      outlineId: 'o1',
      field: 'visualPlan',
      outlineIndex: 3,
    } as OutlineDiagnostic;
    expect(diagnosticIdentity(outlineScoped)).toBe(
      diagnosticIdentity({ ...outlineScoped, outlineIndex: 4 }),
    );
    const stageWide = {
      code: 'POSITION_CARDINALITY',
      flowIndex: 2,
      outlineId: 'o9',
    } as OutlineDiagnostic;
    expect(diagnosticIdentity(stageWide)).toBe('POSITION_CARDINALITY|2');
  });

  it('tolerates pre-existing drift; refuses anything new or on the new outline', () => {
    const old = {
      code: 'VISUAL_REQUIRED',
      outlineId: 'o1',
      field: 'visualPlan',
    } as OutlineDiagnostic;
    const onNew = {
      code: 'CONTENT_ROLE_NOT_ALLOWED',
      outlineId: 'ins_1',
      field: 'contentRole',
    } as OutlineDiagnostic;
    const fresh = { code: 'POSITION_CARDINALITY', flowIndex: 0 } as OutlineDiagnostic;
    expect(newPolicyDiagnostics([old], [old], 'ins_1')).toEqual([]);
    expect(newPolicyDiagnostics([old], [old, onNew, fresh], 'ins_1')).toEqual([onNew, fresh]);
  });
});
