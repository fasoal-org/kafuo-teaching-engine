import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';

/**
 * Module 3/4 W1 headline integration (TAE-AC-002): for every Scene of a
 * GOVERNED run, the assembled Action-generation input demonstrably contains
 * the exact Flow Instructions, the Teaching Model identity/version, the
 * current flow position, the Primary Skill, every Supporting Skill, and the
 * authorized final Scene content.
 *
 * This drives the real path — outline LLM stub → REAL generateSceneContent →
 * REAL generateSceneActions (the real prompt assembly) → REAL
 * createSceneWithActions → REAL api.scene.create — and captures the assembled
 * system+user pair at the callLLM boundary. The four sibling
 * classroom-generation harnesses mock generateSceneActions; this one refuses
 * that shortcut precisely because the assembled Action input is the object
 * under test.
 */

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
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
// ONLY the outline stage is stubbed — content parsing and ACTION prompt
// assembly run for real. Actions come back through the same callLLM stub.
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const STAGE_ID = 'stage-ac002';

const sink = (): ClassroomPersistenceSink => ({
  reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
  persist: async ({ id, stage, scenes }) => ({
    id,
    url: '',
    stage,
    scenes,
    createdAt: '2026-09-18T00:00:00.000Z',
  }),
  release: async () => {},
});

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const SEL = { skillId: 'social-emotional-learning', version: 'v1' };

const governedFlow = [
  {
    stage: 'lesson_introduction',
    instructions: 'Open by connecting the goal to the learner.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, SEL],
      combinationRestrictions: [],
    },
  },
  {
    stage: 'outcome_teaching_cards',
    instructions: 'Consolidate the outcome with the cards.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, SEL],
      combinationRestrictions: [],
    },
  },
];

/** The W10-governed outline shape: carriers + stage on every outline. */
const governedOutlines = [
  {
    id: 'ac1',
    type: 'slide' as const,
    title: 'Opening',
    description: 'Introduce the topic.',
    keyPoints: ['Anchor the goal'],
    order: 1,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: {
      classification: 'instructional' as const,
      primary: FEYNMAN,
      supporting: [SEL],
    },
  },
  {
    id: 'ac2',
    type: 'slide' as const,
    title: 'Cards',
    description: 'Structural consolidation.',
    keyPoints: ['Recap'],
    order: 2,
    teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
    teachingSkills: { classification: 'non-instructional' as const },
  },
];

interface CapturedCall {
  system: string;
  user: string;
}

/** Route the stubbed model: action prompts get an action array, content prompts get slide JSON. */
function routeModelReply(calls: CapturedCall[]) {
  mocks.callLLM.mockImplementation(
    async (request: { messages: Array<{ role: string; content: string }> }) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
      calls.push({ system, user });
      if (/^# (Slide|Quiz|Interactive|PBL).*Action Generator/m.test(system)) {
        return { text: JSON.stringify([{ type: 'text', content: 'Governed narration.' }]) };
      }
      return {
        text: JSON.stringify({
          elements: [
            {
              type: 'text',
              content: `Final scene body for ${governedOutlines[calls.filter((c) => !/^# (Slide|Quiz|Interactive|PBL).*Action Generator/m.test(c.system)).length - 1]!.title}`,
              left: 100,
              top: 100,
              width: 600,
              height: 60,
            },
          ],
          remark: '',
        }),
      };
    },
  );
}

/** The captured ACTION-generation calls, in generation order. */
const actionCalls = (calls: CapturedCall[]): CapturedCall[] =>
  calls.filter(({ system }) => /^# (Slide|Quiz|Interactive|PBL).*Action Generator/m.test(system));

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
});

describe('generateClassroom — TAE-AC-002: the governed Action input', () => {
  it("every Scene's assembled Action prompt carries the full authoritative context", async () => {
    const calls: CapturedCall[] = [];
    routeModelReply(calls);
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: governedOutlines },
    });

    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    const result = await generateClassroom(
      {
        requirement: 'Governed run',
        pdfContent: { text: 'pdf body', images: [] },
        teachingFlow: governedFlow,
        governed: {
          contract: 'kafuo.teaching-skills.v1',
          teachingModel: { key: 'g5', version: 'g5.v1' },
          flow: governedFlow,
        },
      },
      { baseUrl: '', persistence: sink() },
    );

    expect(result.scenes).toHaveLength(2);
    const actionsPrompts = actionCalls(calls);
    expect(actionsPrompts).toHaveLength(2);

    // Scene 1 — instructional: Flow context, Primary AND Supporting Skills.
    const [first] = actionsPrompts;
    const firstAssembled = `${first!.system}\n${first!.user}`;
    expect(firstAssembled).toContain('Open by connecting the goal to the learner.');
    expect(firstAssembled).toContain('Teaching Model: g5@g5.v1');
    expect(firstAssembled).toContain('Flow position:  lesson_introduction (position 1)');
    expect(firstAssembled).toContain('PRIMARY SKILL: feynman-learning@v1');
    expect(firstAssembled).toContain('SUPPORTING SKILL: social-emotional-learning@v1');
    // The FINAL Scene content the Actions operate on (authorized context,
    // TAE-RQ-015): the generated element list is in the user prompt.
    expect(first!.user).toContain('Final scene body for Opening');

    // Scene 2 — its OWN position and instructions, not scene 1's.
    const secondAssembled = `${actionsPrompts[1]!.system}\n${actionsPrompts[1]!.user}`;
    expect(secondAssembled).toContain('Consolidate the outcome with the cards.');
    expect(secondAssembled).toContain('Flow position:  outcome_teaching_cards (position 2)');
    expect(secondAssembled).not.toContain('Open by connecting the goal to the learner.');
    expect(actionsPrompts[1]!.user).toContain('Final scene body for Cards');

    // The Flow block precedes the Skill block wherever a Skill block renders
    // (scene 1 is instructional; scene 2 is non-instructional, so its Flow
    // block stands alone and no Skill block appears at all).
    const [firstPrompt, secondPrompt] = actionsPrompts;
    const firstFlowAt = firstPrompt!.system.indexOf('## Teaching Model Flow Authority');
    const firstSkillAt = firstPrompt!.system.search(/## Teaching Skills? /);
    expect(firstFlowAt).toBeGreaterThanOrEqual(0);
    expect(firstSkillAt).toBeGreaterThan(firstFlowAt);
    expect(secondPrompt!.system.indexOf('## Teaching Model Flow Authority')).toBeGreaterThanOrEqual(
      0,
    );
    expect(secondPrompt!.system.search(/## Teaching Skills? /)).toBe(-1);
  });

  it('marker-only mode: the same inputs WITHOUT the contract marker render no Flow block (tier B)', async () => {
    const calls: CapturedCall[] = [];
    routeModelReply(calls);
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'English.', outlines: governedOutlines },
    });

    const { generateClassroom } = await import('@/lib/server/classroom-generation');
    // teachingFlow, teachingStage and teachingSkills carriers all present —
    // but NO governed authority. The run is legacy and no refusal fires.
    const result = await generateClassroom(
      {
        requirement: 'Tier-B run',
        pdfContent: { text: 'pdf body', images: [] },
        teachingFlow: governedFlow,
      },
      { baseUrl: '', persistence: sink() },
    );

    expect(result.scenes).toHaveLength(2);
    const actionsPrompts = actionCalls(calls);
    expect(actionsPrompts).toHaveLength(2);
    for (const prompt of actionsPrompts) {
      expect(prompt.system).not.toContain('Teaching Model Flow Authority');
      expect(prompt.system).not.toContain('PRIMARY SKILL:');
    }
  });
});
