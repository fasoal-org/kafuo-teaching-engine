import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassroomPersistenceSink,
  GenerateClassroomInput,
} from '@/lib/server/classroom-generation';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  reserveClassroom: vi.fn(),
  releaseClassroomReservation: vi.fn(),
  persistClassroom: vi.fn(),
  generateClassroomId: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
}));

vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-storage')>()),
  reserveClassroom: mocks.reserveClassroom,
  releaseClassroomReservation: mocks.releaseClassroomReservation,
  persistClassroom: mocks.persistClassroom,
  generateClassroomId: mocks.generateClassroomId,
}));

vi.mock('@/lib/server/classroom-media-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-media-generation')>()),
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Sink Basics',
  description: 'Explain sinks',
  keyPoints: ['Sinks are injectable'],
  order: 1,
} as const;

const slideContent = { elements: [], remark: 'Sinks are injectable' };

/** A recording custom sink: id 'stage-pg-N', optional persist/release failures. */
function makeRecordingSink(failures: { persist?: Error } = {}) {
  const calls = { reserve: [] as string[], release: [] as string[] };
  const sink: ClassroomPersistenceSink = {
    reserve: async (buildStage) => {
      const id = `stage-pg-${calls.reserve.length + 1}`;
      calls.reserve.push(id);
      return { id, stage: buildStage(id) };
    },
    persist: async ({ id, stage, scenes }) => {
      if (failures.persist) throw failures.persist;
      return { id, url: '', stage, scenes, createdAt: '2026-09-14T00:00:00.000Z' };
    },
    release: async (id) => {
      calls.release.push(id);
    },
  };
  return { sink, calls };
}

async function generateWith(options: {
  persistence?: ClassroomPersistenceSink;
  input?: Partial<GenerateClassroomInput>;
  validateOutlines?: (outlines: SceneOutline[]) => void | Promise<void>;
}) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: 'Teach sink basics', ...options.input },
    {
      baseUrl: 'http://localhost',
      ...(options.persistence ? { persistence: options.persistence } : {}),
      ...(options.validateOutlines ? { validateOutlines: options.validateOutlines } : {}),
    },
  );
}

describe('generateClassroom Stage-1 outline gate', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines: [outline] },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, stage, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      stage,
      scenes,
      createdAt: '2026-09-14T00:00:00.000Z',
    }));
    mocks.reserveClassroom.mockResolvedValue(undefined);
    mocks.releaseClassroomReservation.mockResolvedValue(undefined);
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.replaceMediaPlaceholders.mockImplementation(() => undefined);
    mocks.generateTTSForClassroom.mockResolvedValue(undefined);
    mocks.generateClassroomId.mockReturnValue('stagesink1');
  });

  it('runs the validator on the generated outlines before reserving a Stage', async () => {
    const { sink, calls } = makeRecordingSink();
    const seen: SceneOutline[][] = [];

    await generateWith({
      persistence: sink,
      validateOutlines: (outlines) => {
        // Position proof: nothing is reserved yet at the moment the gate runs.
        expect(calls.reserve).toEqual([]);
        seen.push(outlines);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((o) => o.id)).toEqual(['outline-1']);
    expect(calls.reserve).toEqual(['stage-pg-1']);
  });

  it('aborts before any Stage, Scene, or media when the validator throws', async () => {
    /* The whole point of the Stage-1 boundary: the previous check ran only after
       `generateClassroom` had generated and persisted all 33 Scenes, so every retry of
       the real attempt burned ~5 minutes to learn the first outline was ungrounded. */
    const { sink, calls } = makeRecordingSink();
    const persist = vi.fn(sink.persist);
    const failure = Object.assign(new Error('outline content-unit grounding is missing'), {
      code: 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID',
    });

    await expect(
      generateWith({
        persistence: { ...sink, persist },
        validateOutlines: () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({ code: 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID' });

    expect(calls.reserve).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(mocks.generateSceneContent).not.toHaveBeenCalled();
    expect(mocks.generateSceneActions).not.toHaveBeenCalled();
    expect(mocks.createSceneWithActions).not.toHaveBeenCalled();
    expect(mocks.generateMediaForClassroom).not.toHaveBeenCalled();
    expect(mocks.reserveClassroom).not.toHaveBeenCalled();
    // The outline call itself was spent — that is the bounded cost of a re-roll.
    expect(mocks.generateSceneOutlinesFromRequirements).toHaveBeenCalledTimes(1);
  });

  it('holds the same no-cost boundary for the Teaching Skills fail-closed refusals (W8)', async () => {
    /* BR-TS-048's enforcement point is this gate: a governed request whose policy is
       missing, invalid, or unresolvable must refuse here — after outlines, before
       `sink.reserve` — costing no Stage reservation, no Scene generation, and no media
       write, exactly like a grounding refusal. The runner assembles the validator
       (generation-runner.ts); this pins the boundary the assembled refusal lands on. */
    const { sink, calls } = makeRecordingSink();
    const persist = vi.fn(sink.persist);
    const failure = Object.assign(
      new Error('teachingModel.flow[1] (stage "outcome_teaching_cards") carries no Skill Policy'),
      { code: 'SKILL_POLICY_REQUIRED' },
    );

    await expect(
      generateWith({
        persistence: { ...sink, persist },
        validateOutlines: () => {
          // Position proof, identical to the grounding case: nothing reserved yet.
          expect(calls.reserve).toEqual([]);
          throw failure;
        },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_POLICY_REQUIRED' });

    expect(calls.reserve).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(mocks.generateSceneContent).not.toHaveBeenCalled();
    expect(mocks.generateSceneActions).not.toHaveBeenCalled();
    expect(mocks.createSceneWithActions).not.toHaveBeenCalled();
    expect(mocks.generateMediaForClassroom).not.toHaveBeenCalled();
    expect(mocks.reserveClassroom).not.toHaveBeenCalled();
    expect(mocks.generateSceneOutlinesFromRequirements).toHaveBeenCalledTimes(1);
  });

  it('awaits an async validator before continuing', async () => {
    const { sink, calls } = makeRecordingSink();
    let resolved = false;

    await generateWith({
      persistence: sink,
      validateOutlines: async () => {
        await Promise.resolve();
        expect(calls.reserve).toEqual([]);
        resolved = true;
      },
    });

    expect(resolved).toBe(true);
    expect(calls.reserve).toEqual(['stage-pg-1']);
  });

  it('generates normally when no validator is supplied', async () => {
    // Non-Kafuo runs are untouched: the hook is opt-in.
    const { sink, calls } = makeRecordingSink();
    await generateWith({ persistence: sink });
    expect(calls.reserve).toEqual(['stage-pg-1']);
    expect(mocks.generateSceneContent).toHaveBeenCalledTimes(1);
  });

  it('propagates normalizedGrounding to the outline prompt context', async () => {
    await generateWith({ input: { normalizedGrounding: true } });
    const context = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]![4];
    expect(context.normalizedGrounding).toBe(true);
  });

  it('leaves the outline prompt context untouched without the option', async () => {
    await generateWith({});
    const context = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]![4];
    expect(context.normalizedGrounding).toBeUndefined();
  });

  it('propagates the skillPolicy governance mode to the outline prompt context (W10)', async () => {
    // The mode arrives here already derived once (the runner's
    // `teachingSkillsContract` value) — the classroom layer only forwards it.
    await generateWith({ input: { skillPolicy: true } });
    const context = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]![4];
    expect(context.skillPolicy).toBe(true);
  });

  it('leaves skillPolicy out of the outline prompt context unless the run is governed', async () => {
    await generateWith({});
    const context = mocks.generateSceneOutlinesFromRequirements.mock.calls[0]![4];
    expect(context.skillPolicy).toBeUndefined();
  });

  it('pre-resolves exact Skill definitions and passes them to BOTH generators when governed (W11)', async () => {
    // The definitions are settled BEFORE prompt assembly (resolvedVisionImages
    // precedent), resolved once per run from the same policies that governed
    // selection — this is what makes the selected Skill reach narration,
    // questions, feedback, pacing, and interaction rather than metadata only.
    const teachingFlow = [
      {
        stage: 'lesson_introduction',
        instructions: 'Introduce.',
        skillPolicy: {
          required: [],
          preferred: [{ skillId: 'feynman-learning', version: 'v1' }],
          allowed: [
            { skillId: 'feynman-learning', version: 'v1' },
            { skillId: 'learning-to-learn', version: 'v1' },
          ],
          combinationRestrictions: [],
        },
      },
    ];
    await generateWith({ input: { skillPolicy: true, teachingFlow } });

    const contentOptions = mocks.generateSceneContent.mock.calls[0]![2];
    const actionsOptions = mocks.generateSceneActions.mock.calls[0]![3];
    for (const options of [contentOptions, actionsOptions]) {
      const resolved = (
        options as {
          resolvedSkills?: Array<{ skillId: string; version: string; definition: string }>;
        }
      ).resolvedSkills;
      expect(resolved).toBeDefined();
      const feynman = resolved!.find((skill) => skill.skillId === 'feynman-learning');
      expect(feynman?.version).toBe('v1');
      expect(feynman?.definition).toContain('Feynman');
    }
  });

  it("passes no Skill definitions when the run is ungoverned (the three non-Kafuo sites' bytes)", async () => {
    const teachingFlow = [{ stage: 'lesson_introduction', instructions: 'Introduce.' }];
    await generateWith({ input: { teachingFlow } });

    const contentOptions = mocks.generateSceneContent.mock.calls[0]![2];
    const actionsOptions = mocks.generateSceneActions.mock.calls[0]![3];
    expect((contentOptions as { resolvedSkills?: unknown }).resolvedSkills).toBeUndefined();
    expect((actionsOptions as { resolvedSkills?: unknown }).resolvedSkills).toBeUndefined();
  });
});
