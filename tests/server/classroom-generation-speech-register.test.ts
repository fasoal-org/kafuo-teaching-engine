import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';
import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';

/**
 * Server-owned spoken-language register policy, end to end through the REAL
 * generateClassroom → generateSceneContent → generateSceneActions path (the
 * `classroom-generation-governed-failures` harness): only the LLM boundary and
 * the outline model are stubbed.
 *
 * Regression for Learning Item 155 (Stage `stage-yhjoDFo1Co5k`): the outline
 * model persisted «يُقدَّم الدرس كاملًا باللغة العربية الفصحى…» and all 45
 * speech actions came out in MSA, with `independently` leaking into a quiz.
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
vi.mock('@openmaic/generation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openmaic/generation')>();
  return {
    ...original,
    generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
    withGenerationRetry: <T>(
      operation: (attempt: number) => Promise<T>,
      options: Parameters<typeof original.withGenerationRetry>[1],
    ) => original.withGenerationRetry(operation, { ...options, baseDelayMs: 1, maxDelayMs: 1 }),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const STAGE_ID = 'stage-register';
const sink = (): ClassroomPersistenceSink => ({
  reserve: async (buildStage) => ({ id: STAGE_ID, stage: buildStage(STAGE_ID) }),
  persist: async ({ id, stage, scenes }) => ({
    id,
    url: '',
    stage,
    scenes,
    createdAt: '2026-09-30T00:00:00.000Z',
  }),
  release: async () => {},
});

/** What the outline model persisted for Learning Item 155. */
const LI155_MODEL_DIRECTIVE =
  'يُقدَّم الدرس كاملًا باللغة العربية الفصحى، مع استخدام رموز الرياضيات والأعداد والأمثلة كما ترد في المصدر. تُشرح المصطلحات الرياضية بعبارات واضحة ومناسبة لطلاب الصف العاشر.';
const MSA_NARRATION =
  'مرحبًا بكم يا طلاب. لنبدأ بسؤال بسيط: ماذا يمكن أن تكشفه إجابات مجموعة من الأشخاص؟ قد تبدو الإجابات منفصلة، لكن عند جمعها قد يظهر بينها اتجاه أو نمط يستحق الانتباه.';
const SAUDI_NARRATION =
  'طيب يا شباب، خلونا الحين نشوف هذي البيانات مع بعض. لو جمعنا إجابات الناس بنلاحظ نمط يتكرر، وهذا اللي نبي نفهمه اليوم عشان نبني تخمين ونختبره بعدين.';
const LATIN_NARRATION = `${SAUDI_NARRATION} أجب عن كل سؤال independently.`;
const CJK_NARRATION = `${SAUDI_NARRATION} اضغط 提交 بعدين.`;

const outlines = [
  {
    id: 'o1',
    type: 'slide' as const,
    slideType: 'content' as const,
    contentRole: 'example' as const,
    title: 'لماذا نبحث عن الأنماط؟',
    description: 'Introduce patterns.',
    keyPoints: ['أنماط'],
    order: 1,
  },
];

const ACTIONS_PROMPT = /^# (Slide|Quiz|Interactive|PBL).*Action Generator/m;
const CONTENT_OK = JSON.stringify({
  elements: [{ type: 'text', content: 'الأنماط', left: 100, top: 100, width: 600, height: 60 }],
  remark: '',
});
const speech = (text: string) => JSON.stringify([{ type: 'text', content: text }]);

interface Routed {
  actionPrompts: Array<{ system: string; user: string }>;
  contentCalls: () => number;
}

function routeModel(actionReplies: string[]): Routed {
  const actionPrompts: Array<{ system: string; user: string }> = [];
  let contentCalls = 0;
  mocks.callLLM.mockImplementation(
    async (request: { messages: Array<{ role: string; content: string }> }) => {
      const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
      if (ACTIONS_PROMPT.test(system)) {
        actionPrompts.push({ system, user });
        return {
          text: actionReplies[Math.min(actionPrompts.length - 1, actionReplies.length - 1)]!,
        };
      }
      contentCalls += 1;
      return { text: CONTENT_OK };
    },
  );
  return { actionPrompts, contentCalls: () => contentCalls };
}

async function generate(input: Record<string, unknown>) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: 'درس', pdfContent: { text: 'pdf', images: [] }, ...input } as never,
    { baseUrl: '', persistence: sink() },
  );
}

const arabicMath = { language: 'ar', subjectCode: 'MATH' };
const saudi = resolveSpeechRegisterPolicy(arabicMath)!;

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
  mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
    success: true,
    data: { languageDirective: LI155_MODEL_DIRECTIVE, outlines },
  });
});

describe('Learning Item 155 regression: the outline model cannot choose MSA', () => {
  it('persists the server directive, and an MSA narration re-rolls only its scene', async () => {
    const routed = routeModel([speech(MSA_NARRATION), speech(SAUDI_NARRATION)]);

    const result = await generate(arabicMath);

    // The outline model was told the directive is fixed …
    expect(mocks.generateSceneOutlinesFromRequirements.mock.calls[0]![4]).toMatchObject({
      authoritativeLanguageDirective: saudi.directive,
    });
    // … and its «الفصحى» directive never reaches the Stage.
    expect(result.stage.languageDirective).toBe(saudi.directive);
    expect(result.stage.languageDirective).not.toContain('الفصحى');
    expect(result.stage.speechRegister).toEqual({
      policyVersion: saudi.version,
      register: 'saudi-white-spoken',
    });

    // One scene re-rolled once, with the correction; content was not regenerated.
    expect(routed.actionPrompts).toHaveLength(2);
    expect(routed.contentCalls()).toBe(1);
    expect(routed.actionPrompts[0]!.user).not.toContain('Correction Required');
    expect(routed.actionPrompts[1]!.user).toContain('formal Modern Standard Arabic');
    const actions = result.scenes[0]!.actions as Array<{ type: string; text?: string }>;
    expect(actions.find((action) => action.type === 'speech')?.text).toBe(SAUDI_NARRATION);
  });

  it('the action prompt carries the policy first and no contradicting register rule', async () => {
    const routed = routeModel([speech(SAUDI_NARRATION)]);
    await generate(arabicMath);
    const { system, user } = routed.actionPrompts[0]!;
    expect(system.indexOf('Server Policy (highest priority)')).toBeLessThan(
      system.indexOf('## Core Task'),
    );
    expect(system).toContain(saudi.directive);
    expect(system).not.toContain('write in Modern Standard Arabic');
    expect(`${system}\n${user}`).not.toContain('الفصحى');
    expect(user).toContain(`**Language Directive**: ${saudi.directive}`);
  });

  it.each([
    ['Latin', LATIN_NARRATION, 'independently'],
    ['CJK', CJK_NARRATION, '提交'],
  ])('%s contamination re-rolls the scene', async (_kind, contaminated, evidence) => {
    const routed = routeModel([speech(contaminated), speech(SAUDI_NARRATION)]);
    await generate(arabicMath);
    expect(routed.actionPrompts).toHaveLength(2);
    expect(routed.actionPrompts[1]!.user).toContain(evidence);
  });

  it('a scene that stays noncompliant fails clearly after the bounded budget', async () => {
    const routed = routeModel([speech(MSA_NARRATION)]);
    await expect(generate(arabicMath)).rejects.toMatchObject({
      code: 'SPEECH_REGISTER_NONCOMPLIANT',
      status: 422,
    });
    expect(routed.actionPrompts).toHaveLength(3);
    expect(routed.contentCalls()).toBe(1);
  });

  it('a governed run gets the same scene-level budget and the same clear code', async () => {
    const flow = [{ stage: 'lesson_introduction', instructions: 'Open the lesson.' }];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: LI155_MODEL_DIRECTIVE,
        outlines: [
          {
            ...outlines[0]!,
            teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
            teachingSkills: { classification: 'non-instructional' as const },
          },
        ],
      },
    });
    const routed = routeModel([speech(MSA_NARRATION)]);
    await expect(
      generate({
        ...arabicMath,
        teachingFlow: flow,
        governed: {
          contract: 'kafuo.teaching-skills.v1',
          teachingModel: { key: 'g5', version: 'g5.v1' },
          flow,
        },
      }),
    ).rejects.toMatchObject({ code: 'SPEECH_REGISTER_NONCOMPLIANT' });
    expect(routed.actionPrompts).toHaveLength(3);
  });
});

describe('outside the Saudi policy nothing is forced', () => {
  it('an Arabic-language lesson keeps MSA and accepts MSA narration', async () => {
    const routed = routeModel([speech(MSA_NARRATION)]);
    const result = await generate({ language: 'ar', subjectCode: 'ARABIC' });
    expect(result.stage.speechRegister).toMatchObject({ register: 'msa' });
    expect(result.stage.languageDirective).toContain('Modern Standard Arabic');
    expect(routed.actionPrompts[0]!.system).not.toContain('white Saudi dialect');
    expect(routed.actionPrompts).toHaveLength(1);
  });

  it('an English lesson behaves exactly as before', async () => {
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Teach in English.', outlines },
    });
    const routed = routeModel([speech('Now let us look at the pattern together.')]);
    const result = await generate({ language: 'en', subjectCode: 'MATH' });
    expect(result.stage.languageDirective).toBe('Teach in English.');
    expect(result.stage.speechRegister).toBeUndefined();
    expect(mocks.generateSceneOutlinesFromRequirements.mock.calls[0]![4]).not.toHaveProperty(
      'authoritativeLanguageDirective',
    );
    expect(routed.actionPrompts[0]!.system).not.toContain('Server Policy');
    expect(routed.actionPrompts).toHaveLength(1);
  });
});
