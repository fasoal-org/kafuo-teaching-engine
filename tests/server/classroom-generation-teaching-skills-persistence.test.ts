import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';

/**
 * Integration coverage for the Scene Teaching Skills carrier on the REAL
 * generation path (Module 2 P0 fix).
 *
 * This test drives the governed pipeline end to end:
 *
 *   governed outline (LLM stub) carrying teachingStage + teachingSkills
 *     → the REAL generateSceneContent (parses the stubbed model reply)
 *     → the REAL createSceneWithActions          ← the seam that dropped the carrier
 *     → the REAL api.scene.create + in-memory store
 *     → the REAL stampGenerationAlignmentBaselines, invoked exactly where the
 *       real teaching-package sink invokes it
 *     → the persisted scene set the run returns
 *
 * Deliberately NOT mocked: `generateSceneContent`, `createSceneWithActions`,
 * `createStageAPI`, the store, and the W15 stamping. The four sibling
 * `classroom-generation-*.test.ts` harnesses mock `createSceneWithActions` —
 * the function with the defect — so none of them could host this test.
 *
 * Regression guarded: `createSceneWithActions` re-projected the built scene
 * into `api.scene.create` without `teachingSkills`, so every governed Scene
 * reached the store carrier-less, was never stamped, and the package could
 * never pass the W17 submit gate. `teachingStage` survived the same
 * projection — that asymmetry is why the defect never surfaced as an
 * exact-flow error.
 */

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  generateSceneActions: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  isProviderKeyRequired: mocks.isProviderKeyRequired,
}));
vi.mock('@/lib/ai/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/llm')>()),
  callLLM: mocks.callLLM,
}));
// Only the two pure-LLM stages of the package are stubbed — outlines and
// actions. Scene CONTENT generation, the scene builder, the app projection,
// and the stage-store API all run for real.
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  generateSceneActions: mocks.generateSceneActions,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };
const STAGE_ID = 'stage-ts-carrier';
const STAMPED_AT = 1_700_000_000_000;

/** A real governed flow: both positions carry resolvable on-disk policies. */
const governedFlow: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'Open the lesson.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, LECTURE],
      combinationRestrictions: [],
    },
  },
  {
    stage: 'outcome_teaching_cards',
    instructions: 'Teach the outcome.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, LECTURE],
      combinationRestrictions: [],
    },
  },
];

/** What the W10-governed outline generator emits: carriers on every outline. */
const governedOutlines = [
  {
    id: 'go1',
    type: 'slide' as const,
    title: 'Opening',
    description: 'Introduce the topic.',
    keyPoints: ['Anchor the goal'],
    order: 1,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: { primary: FEYNMAN, classification: 'instructional' as const },
  },
  {
    id: 'go2',
    type: 'slide' as const,
    title: 'Cards',
    description: 'Structural consolidation.',
    keyPoints: ['Recap'],
    order: 2,
    teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
    teachingSkills: { classification: 'non-instructional' as const },
  },
];

/** The pre-Module-2 shape: no carriers, no flow — byte-identical legacy path. */
const legacyOutlines = [
  {
    id: 'lo1',
    type: 'slide' as const,
    title: 'Plain',
    description: 'No governance.',
    keyPoints: [],
    order: 1,
  },
];

/** The model's scene-content reply for a slide outline. */
const slideContentReply = {
  text: JSON.stringify({
    elements: [
      { type: 'text', content: 'Skill-governed body', left: 100, top: 100, width: 600, height: 60 },
    ],
    remark: '',
  }),
};

/**
 * The persistence-sink BOUNDARY is stubbed (no DB, no media directory, no
 * collision retry), but the W15 stamping inside it is the real module invoked
 * exactly as `stage-persistence-sink.ts` invokes it — so the scene set this
 * returns is the set the real governed sink would persist.
 */
function stampingSink(): ClassroomPersistenceSink {
  return {
    reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
    persist: async (data) => {
      const { stampGenerationAlignmentBaselines } =
        await import('@/lib/server/teaching-package/alignment');
      const scenes = stampGenerationAlignmentBaselines(data.scenes as AppScene[], STAMPED_AT);
      return {
        id: data.id,
        url: '',
        stage: data.stage,
        scenes: scenes as typeof data.scenes,
        createdAt: new Date(STAMPED_AT).toISOString(),
      };
    },
    release: async () => {},
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.resolveModel.mockResolvedValue({
    model: { id: 'language-model' },
    modelInfo: { capabilities: { vision: true } },
    modelString: 'vision-model',
    providerId: 'test',
    apiKey: '',
  });
  mocks.isProviderKeyRequired.mockReturnValue(false);
  mocks.generateSceneActions.mockResolvedValue([]);
  mocks.callLLM.mockResolvedValue(slideContentReply);
});

describe('generateClassroom — the Teaching Skills carrier survives the real generation path', () => {
  it('a governed run persists every Scene carrier-on, byte-equal, with a generation baseline', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: governedOutlines },
    });
    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    const { deriveSceneAlignment } = await import('@/lib/server/teaching-package/alignment');

    const result = await generateClassroom(
      {
        requirement: 'Governed run',
        pdfContent: { text: 'pdf body', images: [] },
        teachingFlow: governedFlow,
        skillPolicy: true,
      },
      { baseUrl: '', persistence: stampingSink() },
    );

    expect(result.scenes).toHaveLength(2);
    for (const [index, scene] of result.scenes.entries()) {
      // Byte-equal to the outline's carrier — the W9/W10 copy seam, end to end.
      expect(scene.teachingSkills).toEqual(governedOutlines[index]!.teachingSkills);
      expect(scene.teachingStage).toEqual(governedOutlines[index]!.teachingStage);
      // W15: a governed Scene leaves generation with a generation-origin baseline.
      expect('alignmentBaseline' in scene).toBe(true);
      expect(scene.alignmentBaseline?.origin).toBe('generation');
      expect(deriveSceneAlignment(scene)).toMatchObject({ state: 'current', aligned: true });
    }
  });

  it('a non-governed run persists Scenes with the carrier key ABSENT (AC-TS-034)', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: legacyOutlines },
    });
    const { generateClassroom } = await import('@/lib/server/classroom-generation');

    const result = await generateClassroom(
      { requirement: 'Non-governed run', pdfContent: { text: 'pdf body', images: [] } },
      { baseUrl: '', persistence: stampingSink() },
    );

    expect(result.scenes).toHaveLength(1);
    for (const scene of result.scenes) {
      // Absence — not a present-but-undefined key, and no fabricated baseline.
      expect('teachingSkills' in scene).toBe(false);
      expect('teachingStage' in scene).toBe(false);
      expect('alignmentBaseline' in scene).toBe(false);
    }
  });
});
