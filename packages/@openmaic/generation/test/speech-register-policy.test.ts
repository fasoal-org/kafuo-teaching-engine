/**
 * The server-owned spoken-language register policy inside the generation
 * package: the outline model can no longer choose the register, and every
 * Action prompt carries the policy as its highest-priority section without a
 * contradicting in-template rule. Without a policy nothing changes (the
 * unconditional template goldens pin that byte for byte).
 */
import { describe, expect, test, vi } from 'vitest';
import {
  buildOutlinePrompt,
  buildPrompt,
  generateSceneActions,
  generateSceneOutlinesFromRequirements,
  PROMPT_IDS,
  type AICallFn,
  type SceneOutline,
} from '@openmaic/generation';

const SAUDI_POLICY =
  'Server language policy ar-speech-register-1: an Arabic lesson.\n- Every spoken `text` segment: educated white Saudi dialect («طيب»، «خلونا»).';
const MSA_POLICY =
  'Server language policy ar-speech-register-1: an Arabic-language lesson.\n- Every spoken `text` segment: Modern Standard Arabic.';

/** The directive the outline model persisted for Learning Item 155. */
const LI155_MODEL_DIRECTIVE =
  'يُقدَّم الدرس كاملًا باللغة العربية الفصحى، مع استخدام رموز الرياضيات والأعداد والأمثلة كما ترد في المصدر.';

const outline: SceneOutline = {
  id: 'scene_1',
  type: 'slide',
  slideType: 'content',
  contentRole: 'explanation',
  contentKind: 'concept',
  title: 'لماذا نبحث عن الأنماط؟',
  description: 'Introduce patterns',
  keyPoints: ['أنماط'],
  order: 1,
};

describe('outline: the model has no authority over the register', () => {
  test('the server directive replaces the model directive (Learning Item 155)', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        languageDirective: LI155_MODEL_DIRECTIVE,
        courseTitle: 'التبرير الاستقرائي',
        outlines: [{ ...outline, languageNote: 'Use Modern Standard Arabic for this scene.' }],
      }),
    );
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'درس رياضيات' },
      undefined,
      undefined,
      aiCall,
      { authoritativeLanguageDirective: SAUDI_POLICY },
    );
    expect(result.success).toBe(true);
    expect(result.data?.languageDirective).toBe(SAUDI_POLICY);
    expect(result.data?.languageDirective).not.toContain('الفصحى');
    // A per-scene note cannot re-introduce a register of the model's choosing.
    expect(result.data?.outlines[0]).not.toHaveProperty('languageNote');
  });

  test('the outline prompt states the fixed directive only when one is given', () => {
    const withPolicy = buildOutlinePrompt(
      { requirement: 'x' },
      { authoritativeLanguageDirective: SAUDI_POLICY },
    );
    expect(withPolicy.system).toContain('fixed by the server');
    expect(withPolicy.system).toContain(SAUDI_POLICY);
    const without = buildOutlinePrompt({ requirement: 'x' }, {});
    expect(without.system).not.toContain('fixed by the server');
    expect(without.system).not.toContain('{{');
  });

  test('without a policy the model directive is used, unchanged', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({
        languageDirective: 'Teach in English.',
        outlines: [{ ...outline, languageNote: 'n' }],
      }),
    );
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'x' },
      undefined,
      undefined,
      aiCall,
    );
    expect(result.data?.languageDirective).toBe('Teach in English.');
    expect(result.data?.outlines[0]?.languageNote).toBe('n');
  });
});

describe('action prompts: the policy is the highest-priority section, never contradicted', () => {
  const base = {
    title: 't',
    keyPoints: '',
    description: '',
    elements: '',
    courseContext: '',
    agents: '',
    userProfile: '',
  };

  test('Saudi policy: first section of the system prompt, no in-template MSA exception', () => {
    const prompts = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      ...base,
      languageDirective: SAUDI_POLICY,
      hasSpokenLanguagePolicy: true,
      spokenLanguagePolicy: SAUDI_POLICY,
      legacyArabicRegisterRule: false,
    })!;
    const firstSection = prompts.system.indexOf(
      '## Spoken Language — Server Policy (highest priority)',
    );
    expect(firstSection).toBeGreaterThan(0);
    expect(firstSection).toBeLessThan(prompts.system.indexOf('## Core Task'));
    expect(prompts.system).toContain(SAUDI_POLICY);
    // The model-decided register rule and its MSA exception are gone.
    expect(prompts.system).not.toContain('write in Modern Standard Arabic');
    expect(prompts.system).not.toContain('*Wording — white Saudi dialect.*');
    // The user-level directive repeats the same policy — no second opinion.
    expect(prompts.user).toContain(`**Language Directive**: ${SAUDI_POLICY}`);
    // Register-neutral formula rules stay.
    expect(prompts.system).toContain('*Formulas — spoken, never printed.*');
  });

  test('MSA policy (Arabic-language subject): no Saudi-dialect instruction anywhere', () => {
    const prompts = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      ...base,
      languageDirective: MSA_POLICY,
      hasSpokenLanguagePolicy: true,
      spokenLanguagePolicy: MSA_POLICY,
      legacyArabicRegisterRule: false,
    })!;
    expect(prompts.system).toContain(MSA_POLICY);
    expect(prompts.system).not.toContain('white Saudi dialect');
    expect(prompts.system).not.toContain('طيب يا شباب');
  });

  test.each([PROMPT_IDS.QUIZ_ACTIONS, PROMPT_IDS.INTERACTIVE_ACTIONS, PROMPT_IDS.PBL_ACTIONS])(
    '%s carries the policy section too',
    (id) => {
      const prompts = buildPrompt(id, {
        ...base,
        languageDirective: SAUDI_POLICY,
        hasSpokenLanguagePolicy: true,
        spokenLanguagePolicy: SAUDI_POLICY,
      })!;
      expect(prompts.system).toContain('## Spoken Language — Server Policy (highest priority)');
      expect(prompts.system).toContain(SAUDI_POLICY);
    },
  );

  test('generateSceneActions renders the policy and appends a correction only on a re-roll', async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const aiCall: AICallFn = async (system, user) => {
      calls.push({ system, user });
      return JSON.stringify([{ type: 'text', content: 'طيب يا شباب، خلونا نبدأ.' }]);
    };
    const content = { elements: [], background: undefined } as never;
    await generateSceneActions(outline, content, aiCall, {
      spokenLanguagePolicy: SAUDI_POLICY,
      languageDirective: SAUDI_POLICY,
    });
    await generateSceneActions(outline, content, aiCall, {
      spokenLanguagePolicy: SAUDI_POLICY,
      languageDirective: SAUDI_POLICY,
      correctiveContext: 'The spoken text is formal Modern Standard Arabic.',
    });
    expect(calls[0]!.system).toContain(SAUDI_POLICY);
    expect(calls[0]!.user).not.toContain('Correction Required');
    expect(calls[1]!.user).toContain('## Correction Required');
    expect(calls[1]!.user).toContain('The spoken text is formal Modern Standard Arabic.');
  });

  test("without a policy the action prompt keeps today's register rule", () => {
    const prompts = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, { ...base, languageDirective: '' })!;
    expect(prompts.system).not.toContain('Server Policy');
    expect(prompts.system).toContain('*Wording — white Saudi dialect.*');
  });
});
