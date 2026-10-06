/**
 * Teaching Model Flow scene policies: one value drives the outline prompt and
 * the outline validator. Entries without a policy keep the stage-keyed legacy
 * rules, so a g5.v1–v4 attempt never changes meaning.
 */
import { describe, expect, test } from 'vitest';
import {
  LEGACY_STAGE_SCENE_POLICIES,
  analyzeOutlines,
  blockingOutlineDiagnostics,
  buildOutlinePrompt,
  describeScenePolicy,
  generateSceneOutlinesFromRequirements,
  parseTeachingScenePolicy,
  scenePolicyFor,
  type SceneOutline,
  type TeachingFlowEntry,
  type TeachingScenePolicy,
} from '@openmaic/generation';

/** The g5.v5 `outcome_visual_explanations` policy as Kafuo sends it. */
const V5_EXPLANATIONS: TeachingScenePolicy = {
  sceneTypes: ['slide'],
  contentRoles: ['explanation', 'procedure', 'worked_example', 'example', 'activity'],
  visual: 'source_grounded',
  cardinality: 'one_or_more',
};

const legacyFlow: TeachingFlowEntry[] = [
  { stage: 'outcome_visual_explanations', instructions: 'Explain objective O1 visually.' },
];
const v5Flow: TeachingFlowEntry[] = [
  {
    stage: 'outcome_visual_explanations',
    instructions: 'Teach objective O1 with a meaningful textbook visual.',
    scenePolicy: V5_EXPLANATIONS,
  },
];

function explanationSlide(patch: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'o1-a',
    type: 'slide',
    slideType: 'content',
    contentRole: 'explanation',
    title: 'Measuring a solution',
    description: 'Teach the method',
    keyPoints: ['step one', 'step two'],
    order: 1,
    visualPlan: { mode: 'native' },
    teachingStage: { key: 'outcome_visual_explanations', flowIndex: 0 },
    ...patch,
  };
}

describe('scenePolicyFor', () => {
  test('prefers the wire policy and falls back to the legacy stage rules', () => {
    expect(scenePolicyFor(v5Flow[0])).toBe(V5_EXPLANATIONS);
    expect(scenePolicyFor(legacyFlow[0])).toBe(
      LEGACY_STAGE_SCENE_POLICIES.outcome_visual_explanations,
    );
    expect(scenePolicyFor({ stage: 'lesson_introduction' })).toBeUndefined();
    // An inherited Object key is never mistaken for a stage rule.
    expect(scenePolicyFor({ stage: 'constructor' })).toBeUndefined();
  });

  test('the legacy outcome_visual_explanations rule still allows explanation only', () => {
    expect(LEGACY_STAGE_SCENE_POLICIES.outcome_visual_explanations?.contentRoles).toEqual([
      'explanation',
    ]);
  });
});

describe('analyzeOutlines with position policies', () => {
  test('a procedure slide is admin-correctable under the legacy (g5.v4) rules', () => {
    const analysis = analyzeOutlines([explanationSlide({ contentRole: 'procedure' })], {
      teachingFlow: legacyFlow,
    });
    expect(blockingOutlineDiagnostics(analysis)).toEqual([
      expect.objectContaining({
        code: 'CONTENT_ROLE_NOT_ALLOWED',
        disposition: 'admin_correctable',
        field: 'contentRole',
        allowedValues: ['explanation'],
        flowIndex: 0,
        stage: 'outcome_visual_explanations',
      }),
    ]);
  });

  test('a valid procedure role at the outcome stage passes under the v5 policy', () => {
    const analysis = analyzeOutlines(
      [
        explanationSlide({ id: 'a', contentRole: 'procedure' }),
        explanationSlide({ id: 'b', contentRole: 'worked_example' }),
      ],
      { teachingFlow: v5Flow },
    );
    expect(blockingOutlineDiagnostics(analysis)).toEqual([]);
  });

  test('the visual stays mandatory and textbook-grounded for every allowed role', () => {
    const sourceImages = [
      { id: 'src-1', src: '', pageNumber: 1, sourceContentUnitIds: ['cu-1'] },
    ];
    const analysis = analyzeOutlines(
      [
        explanationSlide({
          contentRole: 'procedure',
          sourceContentUnitIds: ['cu-1'],
          visualPlan: { mode: 'omitted', omissionReason: 'nothing to show here at all' },
          mediaGenerations: [{ type: 'image', elementId: 'gen_img_1', prompt: 'decoration' }],
        }),
      ],
      { teachingFlow: v5Flow, sourceImages },
    );
    // Deterministic completion from the authoritative Content Unit association.
    expect(analysis.outlines[0]).toMatchObject({
      visualPlan: { mode: 'image' },
      suggestedImageIds: ['src-1'],
    });
    expect(analysis.outlines[0]?.mediaGenerations).toBeUndefined();
    expect(analysis.repairs.map((repair) => repair.code)).toEqual(['SOURCE_VISUAL_NORMALIZED']);
    expect(blockingOutlineDiagnostics(analysis)).toEqual([]);
  });

  test('a role outside the v5 list is admin-correctable, never rewritten', () => {
    const analysis = analyzeOutlines([explanationSlide({ contentRole: 'summary' })], {
      teachingFlow: v5Flow,
    });
    expect(analysis.outlines[0]?.contentRole).toBe('summary');
    expect(blockingOutlineDiagnostics(analysis)).toEqual([
      expect.objectContaining({
        code: 'CONTENT_ROLE_NOT_ALLOWED',
        allowedValues: V5_EXPLANATIONS.contentRoles,
      }),
    ]);
  });

  test('a missing role is offered only the roles its position allows', () => {
    const analysis = analyzeOutlines([explanationSlide({ contentRole: undefined })], {
      teachingFlow: v5Flow,
    });
    expect(blockingOutlineDiagnostics(analysis)).toEqual([
      expect.objectContaining({
        code: 'CONTENT_ROLE_MISSING',
        allowedValues: V5_EXPLANATIONS.contentRoles,
      }),
    ]);
  });

  test('collects every flow violation instead of stopping at the first', () => {
    const flow: TeachingFlowEntry[] = [
      { stage: 'lesson_opener', instructions: 'Open.' },
      { stage: 'outcome_check_understanding', instructions: 'Check.' },
    ];
    const analysis = analyzeOutlines(
      [
        explanationSlide({ id: 'o', teachingStage: { key: 'lesson_opener', flowIndex: 0 } }),
        explanationSlide({ id: 'c', teachingStage: { key: 'outcome_check_understanding', flowIndex: 1 } }),
      ],
      { teachingFlow: flow },
    );
    expect(analysis.flow.map((diagnostic) => diagnostic.code)).toEqual([
      'SLIDE_TYPE_NOT_ALLOWED',
      'CONTENT_ROLE_NOT_ALLOWED',
      'SCENE_TYPE_NOT_ALLOWED',
    ]);
  });
});

describe('the prompt renders the same policy the validator enforces', () => {
  test('a policy-carrying flow lists the allowed values per position', () => {
    const { system, user } = buildOutlinePrompt({ requirement: 'Teach' }, { teachingFlow: v5Flow });
    const line = describeScenePolicy(V5_EXPLANATIONS);
    expect(line).toBe(
      'type: slide | contentRole: one of explanation, procedure, worked_example, example, activity | visual: textbook-grounded (required) | outlines: one or more',
    );
    expect(system).toContain(`policy="${line}"`);
    expect(user).toContain(`policy="${line}"`);
    expect(system).toContain('whose policy says `visual: textbook-grounded`');
    // The fixed explanation-only rule belongs to policy-less versions only.
    expect(system).not.toContain('at Teaching Model Flow stage `outcome_visual_explanations`');
  });

  test('a policy-less (g5.v4) flow keeps its fixed rule and renders no policy', () => {
    const { system } = buildOutlinePrompt({ requirement: 'Teach' }, { teachingFlow: legacyFlow });
    expect(system).toContain('at Teaching Model Flow stage `outcome_visual_explanations`');
    expect(system).not.toContain('policy="');
    expect(system).not.toContain('whose policy says');
  });
});

describe('parseTeachingScenePolicy', () => {
  test('accepts a well-formed policy and keeps exactly the received keys', () => {
    expect(parseTeachingScenePolicy(V5_EXPLANATIONS, 'flow[2].scenePolicy')).toEqual(
      V5_EXPLANATIONS,
    );
    expect(Object.keys(parseTeachingScenePolicy(V5_EXPLANATIONS, 'p'))).toEqual(
      Object.keys(V5_EXPLANATIONS),
    );
  });

  test.each([
    ['an unknown role', { ...V5_EXPLANATIONS, contentRoles: ['lecture'] }, /unknown value/],
    ['an empty scene type list', { ...V5_EXPLANATIONS, sceneTypes: [] }, /non-empty array/],
    ['a duplicate value', { ...V5_EXPLANATIONS, contentRoles: ['example', 'example'] }, /more than once/],
    ['a slide field without slides', { sceneTypes: ['quiz'], contentRoles: ['example'], cardinality: 'exactly_one' }, /requires "slide"/],
    ['an unknown field', { ...V5_EXPLANATIONS, roles: [] }, /unknown field/],
    ['a bad cardinality', { ...V5_EXPLANATIONS, cardinality: 'many' }, /cardinality/],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseTeachingScenePolicy(raw, 'p')).toThrow(message);
  });
});

describe('collectCorrectableIssues', () => {
  test('returns blocking findings as diagnostics instead of failing the answer', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          outlines: [explanationSlide({ contentRole: undefined, contentKind: 'concept' })],
        }),
      { teachingFlow: v5Flow, collectCorrectableIssues: true },
    );
    expect(result.success).toBe(true);
    expect(result.data?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'CONTENT_KIND_DROPPED',
      'CONTENT_ROLE_MISSING',
    ]);
  });

  test('without it the same answer is the historical re-rollable failure', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach' },
      undefined,
      undefined,
      async () => JSON.stringify({ outlines: [explanationSlide({ contentRole: undefined })] }),
      { teachingFlow: v5Flow },
    );
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/^OUTLINE_SLIDE_SEMANTICS_INVALID/),
    });
  });
});
