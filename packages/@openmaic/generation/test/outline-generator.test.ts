// Behavior-parity port of lib/generation/outline-generator.ts assertions from
// tests/generation/media-prompt-wiring.test.ts and procedural-skill-content-gates.test.ts.
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_LANGUAGE_DIRECTIVE,
  applyOutlineFallbacks,
  buildOutlinePrompt,
  generateSceneOutlinesFromRequirements,
  sanitizeProceduralSkillOutline,
  type AICallFn,
  type GenerationLogger,
  type SceneOutline,
  type UserRequirements,
} from '@openmaic/generation';

const baseOutline: SceneOutline = {
  id: 'scene_1',
  type: 'slide',
  slideType: 'content',
  contentRole: 'explanation',
  contentKind: 'concept',
  title: 'Photosynthesis',
  description: 'How plants make food',
  keyPoints: ['light', 'water', 'carbon dioxide'],
  order: 99,
};

describe('generateSceneOutlinesFromRequirements', () => {
  test('returns enriched outlines from a valid wrapped response', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        languageDirective: 'Teach in English.',
        courseTitle: 'Photosynthesis Basics',
        outlines: [{ ...baseOutline, id: '', order: 42 }],
      }),
    );

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      aiCall,
    );

    expect(result.success).toBe(true);
    expect(result.data?.languageDirective).toBe('Teach in English.');
    expect(result.data?.courseTitle).toBe('Photosynthesis Basics');
    expect(result.data?.outlines[0]?.id).toBeTruthy();
    expect(result.data?.outlines[0]?.order).toBe(1);
  });

  test('integrates repairable JSON parsing', async () => {
    const response = `{
      "languageDirective": "Teach in English.",
      "courseTitle": "Repair",
      "outlines": [{
        "id": "scene_1",
        "type": "slide",
        "slideType": "content",
        "contentRole": "summary",
        "title": "Repairable",
        "description": "A repaired response",
        "keyPoints": ["one"],
        "order: 7"
      }]
    }`;
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Test repair' },
      undefined,
      undefined,
      async () => response,
    );

    expect(result.success).toBe(true);
    expect(result.data?.outlines).toMatchObject([{ title: 'Repairable', order: 1 }]);
  });

  test('supports the legacy flat-array response with a default language directive', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () => JSON.stringify([baseOutline]),
    );

    expect(result.success).toBe(true);
    expect(result.data?.languageDirective).toBe(DEFAULT_LANGUAGE_DIRECTIVE);
  });

  test('rejects a Teaching Model Flow answer that omits teachingStage', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({ languageDirective: 'Teach in English.', outlines: [baseOutline] }),
      {
        teachingFlow: [{ stage: 'lesson_introduction', instructions: 'Introduce the lesson.' }],
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(
        /^OUTLINE_TEACHING_FLOW_INVALID: outline #1 .* must carry teachingStage/,
      ),
    });
  });

  test('accepts consecutive outlines that cover the exact Teaching Model Flow', async () => {
    const flow = [
      { stage: 'lesson_introduction', instructions: 'Introduce.' },
      { stage: 'guided_practice', instructions: 'Practise.' },
    ];
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          languageDirective: 'Teach in English.',
          outlines: [
            {
              ...baseOutline,
              id: 's1',
              teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
            },
            {
              ...baseOutline,
              id: 's2',
              teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
            },
            { ...baseOutline, id: 's3', teachingStage: { key: 'guided_practice', flowIndex: 1 } },
          ],
        }),
      { teachingFlow: flow },
    );

    expect(result.success).toBe(true);
    expect(result.data?.outlines.map((item) => item.teachingStage?.flowIndex)).toEqual([0, 0, 1]);
  });

  test('rejects a Teaching Model Flow answer with a gap or reordered position', async () => {
    const flow = [
      { stage: 'lesson_introduction', instructions: 'Introduce.' },
      { stage: 'guided_practice', instructions: 'Practise.' },
    ];
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          languageDirective: 'Teach in English.',
          outlines: [
            { ...baseOutline, id: 's1', teachingStage: { key: 'guided_practice', flowIndex: 1 } },
          ],
        }),
      { teachingFlow: flow },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(
        /OUTLINE_TEACHING_FLOW_INVALID:.*collapsed \[1\].*expected \[0, 1\]/,
      ),
    });
  });

  test('requires every g5.v2 Check Understanding position to be exactly one quiz', async () => {
    const flow = [{ stage: 'outcome_check_understanding', instructions: 'Check objective O1.' }];
    const wrongType = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          outlines: [
            {
              ...baseOutline,
              teachingStage: { key: 'outcome_check_understanding', flowIndex: 0 },
            },
          ],
        }),
      { teachingFlow: flow },
    );
    expect(wrongType).toMatchObject({
      success: false,
      error: expect.stringContaining('requires exactly one quiz'),
    });

    const quiz = {
      id: 'check-1',
      type: 'quiz' as const,
      title: 'Check understanding',
      description: 'Check objective O1',
      keyPoints: ['photosynthesis'],
      order: 1,
      quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
      teachingStage: { key: 'outcome_check_understanding', flowIndex: 0 },
    };
    const duplicates = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () => JSON.stringify({ outlines: [quiz, { ...quiz, id: 'check-2' }] }),
      { teachingFlow: flow },
    );
    expect(duplicates).toMatchObject({
      success: false,
      error: expect.stringContaining('requires exactly one outline, received 2'),
    });
  });

  test('requires the g5.v2 final learning game to be exactly one interactive game', async () => {
    const flow = [{ stage: 'lesson_learning_game', instructions: 'Play.' }];
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          outlines: [
            {
              id: 'game-1',
              type: 'interactive',
              title: 'Photosynthesis challenge',
              description: 'Apply the lesson',
              keyPoints: ['light', 'water'],
              order: 1,
              widgetType: 'game',
              widgetOutline: {
                concept: 'photosynthesis',
                gameType: 'quiz',
                challenge: 'Build the correct photosynthesis process',
                playerControls: ['choose'],
                interactions: ['select answer'],
              },
              teachingStage: { key: 'lesson_learning_game', flowIndex: 0 },
            },
          ],
        }),
      { teachingFlow: flow },
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines[0]).toMatchObject({ type: 'interactive', widgetType: 'game' });
  });

  test('requires the g5.v3 opener and learning map as two separate slides', async () => {
    const flow = [
      { stage: 'lesson_opener', instructions: 'Open visually.' },
      { stage: 'lesson_learning_map', instructions: 'Preview objectives.' },
    ];
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          outlines: [
            {
              ...baseOutline,
              id: 'opener',
              slideType: 'cover',
              contentRole: 'orientation',
              contentKind: undefined,
              visualPlan: { mode: 'native' },
              teachingStage: { key: 'lesson_opener', flowIndex: 0 },
            },
            {
              ...baseOutline,
              id: 'map',
              slideType: 'content',
              contentRole: 'orientation',
              contentKind: undefined,
              teachingStage: { key: 'lesson_learning_map', flowIndex: 1 },
            },
          ],
        }),
      { teachingFlow: flow },
    );
    expect(result.success).toBe(true);
  });

  test('completes a g5.v3 explanation without a book image as a native visual', async () => {
    const flow = [{ stage: 'outcome_visual_explanations', instructions: 'Explain visually.' }];
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          outlines: [
            {
              ...baseOutline,
              teachingStage: { key: 'outcome_visual_explanations', flowIndex: 0 },
            },
          ],
        }),
      { teachingFlow: flow },
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines[0]).toMatchObject({ visualPlan: { mode: 'native' } });
  });

  test('deterministically attaches the textbook visual linked to a g5.v3 explanation Content Unit', async () => {
    const flow = [{ stage: 'outcome_visual_explanations', instructions: 'Explain visually.' }];
    const sourceImage = {
      id: 'src-1',
      src: 'data:image/png;base64,book',
      pageNumber: 7,
      sourceContentUnitIds: ['cu-1'],
    };
    const answer = (patch: Partial<SceneOutline>) =>
      JSON.stringify({
        outlines: [
          {
            ...baseOutline,
            sourceContentUnitIds: ['cu-1'],
            teachingStage: { key: 'outcome_visual_explanations', flowIndex: 0 },
            ...patch,
          },
        ],
      });

    const completed = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      [sourceImage],
      async () => answer({ visualPlan: { mode: 'native' } }),
      { teachingFlow: flow },
    );
    expect(completed).toMatchObject({
      success: true,
      data: {
        outlines: [
          expect.objectContaining({
            visualPlan: { mode: 'image' },
            suggestedImageIds: ['src-1'],
          }),
        ],
      },
    });

    const selected = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      [sourceImage],
      async () => answer({ visualPlan: { mode: 'image' }, suggestedImageIds: ['src-1'] }),
      { teachingFlow: flow },
    );
    expect(selected.success).toBe(true);
  });

  test('replaces an AI-image request with a source-grounded native visual without a retry', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          outlines: [
            {
              ...baseOutline,
              visualPlan: { mode: 'native' },
              mediaGenerations: [
                { type: 'image', elementId: 'gen_img_1', prompt: 'A decorative plant' },
              ],
              teachingStage: { key: 'outcome_visual_explanations', flowIndex: 0 },
            },
          ],
        }),
      {
        teachingFlow: [{ stage: 'outcome_visual_explanations', instructions: 'Explain visually.' }],
      },
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines[0]).toMatchObject({ visualPlan: { mode: 'native' } });
    expect(result.data?.outlines[0]?.mediaGenerations).toBeUndefined();
  });

  test('passes media enable flags into prompt conditionals', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      return JSON.stringify({
        languageDirective: 'Teach in English.',
        courseTitle: 'Evaporation',
        outlines: [],
      });
    };
    const requirements: UserRequirements = {
      requirement: 'Teach evaporation with an animation',
    };

    const result = await generateSceneOutlinesFromRequirements(
      requirements,
      undefined,
      undefined,
      aiCall,
      { imageGenerationEnabled: false, videoGenerationEnabled: true },
    );

    expect(result.success).toBe(true);
    expect(capturedPrompt).toContain('gen_vid_1');
    expect(capturedPrompt).not.toContain('gen_img_');
    expect(capturedPrompt).not.toContain('suggestedImageIds');
    expect(capturedPrompt).not.toContain('{{');
  });

  test('keeps a valid slide classification verbatim on the enriched outline', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Photosynthesis',
          outlines: [
            {
              ...baseOutline,
              id: 's1',
              slideType: 'cover',
              contentRole: 'orientation',
              contentKind: undefined,
              visualPlan: { mode: 'native' },
            },
            { ...baseOutline, id: 's2' },
          ],
        }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.outlines[0]).toMatchObject({
      slideType: 'cover',
      contentRole: 'orientation',
    });
    expect(result.data?.outlines[1]).toMatchObject({
      slideType: 'content',
      contentRole: 'explanation',
      contentKind: 'concept',
    });
  });

  test.each([
    ['an unclassified slide', { slideType: undefined, contentRole: undefined }],
    ['example + concept', { contentRole: 'example', contentKind: 'concept' }],
    ['summary + guided', { contentRole: 'summary', contentKind: 'guided' }],
    ['procedure + observation', { contentRole: 'procedure', contentKind: 'observation' }],
    ['a Teaching Model stage name as a role', { contentRole: 'lesson_introduction' }],
  ])('rejects %s instead of guessing a classification', async (_label, patch) => {
    const warn = vi.fn();
    const logger: GenerationLogger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        languageDirective: 'Teach in English.',
        courseTitle: 'Photosynthesis',
        outlines: [{ ...baseOutline, contentKind: undefined, ...patch }],
      }),
    );

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      aiCall,
      { logger },
    );

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toContain('OUTLINE_SLIDE_SEMANTICS_INVALID');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OUTLINE_SLIDE_SEMANTICS_INVALID'));
    // No hidden repair loop: the caller's re-roll is the only remedy.
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  test('leaves quiz / interactive / pbl outlines unclassified and available', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach photosynthesis' },
      undefined,
      undefined,
      async () =>
        JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Photosynthesis',
          outlines: [
            {
              ...baseOutline,
              id: 'q1',
              type: 'quiz',
              // Stray semantics on a non-slide outline are dropped, not judged.
              contentRole: 'check_understanding',
              quizConfig: { questionCount: 2, difficulty: 'easy', questionTypes: ['single'] },
            },
            {
              id: 'i1',
              type: 'interactive',
              title: 'Explore',
              description: 'Simulate light intensity',
              keyPoints: ['light'],
              order: 2,
              widgetType: 'simulation',
              widgetOutline: { concept: 'Photosynthesis', keyVariables: ['light'] },
            },
            {
              id: 'p1',
              type: 'pbl',
              title: 'Garden project',
              description: 'Design a school garden',
              keyPoints: ['plan'],
              order: 3,
              pblConfig: {
                projectTopic: 'School garden',
                projectDescription: 'Design it',
                targetSkills: ['planning'],
              },
            },
          ],
        }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.outlines.map((outline) => outline.type)).toEqual([
      'quiz',
      'interactive',
      'pbl',
    ]);
    for (const outline of result.data!.outlines) {
      expect(outline).not.toHaveProperty('slideType');
      expect(outline).not.toHaveProperty('contentRole');
      expect(outline).not.toHaveProperty('contentKind');
    }
  });

  const requirements: UserRequirements = { requirement: 'Teach photosynthesis' };
  async function runWith(raw: unknown) {
    return generateSceneOutlinesFromRequirements(requirements, undefined, undefined, async () =>
      JSON.stringify(raw),
    );
  }

  test('trims and caps a string courseTitle', async () => {
    const result = await runWith({
      languageDirective: 'Teach in English.',
      courseTitle: `  ${'A '.repeat(80)}  `,
      outlines: [],
    });
    expect(result.data?.courseTitle?.length).toBeLessThanOrEqual(120);
    expect(result.data?.courseTitle?.startsWith(' ')).toBe(false);
  });

  test.each([
    [{ languageDirective: 'Teach in English.', outlines: [] }],
    [{ languageDirective: 'Teach in English.', courseTitle: '   ', outlines: [] }],
    [{ languageDirective: 'Teach in English.', courseTitle: 123, outlines: [] }],
  ])('omits a missing, empty, or non-string courseTitle', async (raw) => {
    const result = await runWith(raw);
    expect(result.success).toBe(true);
    expect(result.data?.courseTitle).toBeUndefined();
  });
});

describe('no runtime scene degrades to a slide (RSS W2, T-05)', () => {
  const requirements = { requirement: 'Teach photosynthesis' };
  const interactive = (order: number): SceneOutline => ({
    id: `i${order}`,
    type: 'interactive',
    title: 'Explore',
    description: 'D',
    keyPoints: ['k'],
    order,
    widgetType: 'simulation',
    widgetOutline: { concept: 'Light' },
  });
  const pbl: SceneOutline = {
    id: 'p1',
    type: 'pbl',
    title: 'Project',
    description: 'D',
    keyPoints: ['k'],
    order: 2,
    pblConfig: { projectTopic: 'Garden', projectDescription: 'Grow it', targetSkills: [] },
  };
  const run = (outlines: unknown[], options = {}) =>
    generateSceneOutlinesFromRequirements(
      requirements,
      undefined,
      undefined,
      async () => JSON.stringify({ languageDirective: 'English', outlines }),
      options,
    );

  test('a config-less interactive outline is rejected for re-roll, never converted', async () => {
    const { widgetType: _w, widgetOutline: _o, ...bare } = interactive(1);
    const result = await run([baseOutline, bare]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OUTLINE_SCENE_CONFIG_INVALID.*#1/);
  });

  test('a plan that requires an unavailable runtime stops with the typed conflict', async () => {
    await expect(
      run([baseOutline, pbl], { availableRuntimes: { pbl: false } }),
    ).rejects.toMatchObject({
      code: 'SCENE_RUNTIME_UNAVAILABLE',
      requiredType: 'pbl',
      sceneIndex: 1,
    });
  });

  test('required runtime scenes beyond the prompt budget are kept; only a configured hard limit conflicts', async () => {
    const plan = [interactive(1), interactive(2), interactive(3)];
    const kept = await run(plan);
    expect(kept.data?.outlines.map((outline) => outline.type)).toEqual(
      Array(3).fill('interactive'),
    );
    await expect(run(plan, { sceneHardLimits: { interactive: 2 } })).rejects.toMatchObject({
      code: 'SCENE_CAP_CONFLICT',
      family: 'interactive',
      required: 3,
      limit: 2,
    });
  });

  test('a re-roll carries the rejection back as corrective context', () => {
    const prompts = buildOutlinePrompt(requirements, { correctiveContext: 'SENTINEL-ISSUE' });
    expect(prompts.user).toContain('SENTINEL-ISSUE');
    expect(buildOutlinePrompt(requirements).user).not.toContain('Correction Required');
  });
});

describe('outline fallbacks', () => {
  // RSS W2: a runtime scene is never downgraded to a slide. (This test pinned
  // the old fallback-to-slide behaviour and was rewritten to the new contract.)
  test('refuses incomplete or undeliverable interactive / PBL outlines instead of downgrading them', () => {
    expect(() => applyOutlineFallbacks({ ...baseOutline, type: 'interactive' }, true)).toThrow(
      /OUTLINE_SCENE_CONFIG_INVALID/,
    );
    expect(() => applyOutlineFallbacks({ ...baseOutline, type: 'pbl' }, true)).toThrow(
      /OUTLINE_SCENE_CONFIG_INVALID/,
    );
    const pbl = {
      ...baseOutline,
      type: 'pbl' as const,
      pblConfig: { projectTopic: 'Garden', projectDescription: 'Grow it', targetSkills: [] },
    };
    expect(() => applyOutlineFallbacks(pbl, false)).toThrow(
      expect.objectContaining({ code: 'SCENE_RUNTIME_UNAVAILABLE', requiredType: 'pbl' }),
    );
  });

  test('keeps configured interactive and PBL outlines when a language model is present', () => {
    const interactive = {
      ...baseOutline,
      type: 'interactive' as const,
      widgetType: 'diagram' as const,
      widgetOutline: { concept: 'Cycle' },
    };
    const pbl = {
      ...baseOutline,
      type: 'pbl' as const,
      pblConfig: { projectTopic: 'Garden', projectDescription: 'Grow it', targetSkills: [] },
    };
    expect(applyOutlineFallbacks(interactive, true)).toBe(interactive);
    expect(applyOutlineFallbacks(pbl, true)).toBe(pbl);
  });

  test('logs the procedural-skill fallback through the injected structural logger', () => {
    const warn = vi.fn();
    const logger: GenerationLogger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    applyOutlineFallbacks(
      {
        ...baseOutline,
        type: 'interactive',
        widgetType: 'procedural-skill',
        widgetOutline: { concept: 'Wiring' },
      },
      true,
      { logger },
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('sanitizeProceduralSkillOutline', () => {
  const procedural: SceneOutline = {
    ...baseOutline,
    type: 'interactive',
    widgetType: 'procedural-skill',
    widgetOutline: {
      concept: 'calibration procedure',
      procedureType: 'operation',
      task: 'Calibrate a device',
      tools: ['meter'],
      steps: ['inspect'],
      successCriteria: ['within range'],
      errorConsequences: ['stop'],
      interactions: ['inspect details'],
    },
  };

  test('strips every task-engine field and preserves unrelated widget fields', () => {
    const safe = sanitizeProceduralSkillOutline(procedural);
    expect(safe.widgetType).toBe('diagram');
    expect(safe.widgetOutline).toEqual({
      concept: 'calibration procedure',
      interactions: ['inspect details'],
    });
    expect(safe.description).toContain('Present this as a process or structure diagram.');
  });

  test('uses the fallback description when the source description is empty', () => {
    expect(sanitizeProceduralSkillOutline({ ...procedural, description: '' }).description).toBe(
      'Present this topic as a process or structure diagram.',
    );
  });

  test('retains procedural-skill only when explicitly allowed', () => {
    expect(applyOutlineFallbacks(procedural, true, { allowProceduralSkill: true }).widgetType).toBe(
      'procedural-skill',
    );
  });
});
