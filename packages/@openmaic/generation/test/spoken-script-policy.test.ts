/**
 * The shared TTS-ready spoken-script + topic-signposting policy: ONE source
 * rendered into all four Action prompts, after the server register policy,
 * never duplicated by the slide template's own Arabic formula rules, and
 * absent (byte-identical prompts) when the server does not supply it.
 */
import { describe, expect, test } from 'vitest';
import {
  classifySceneTransition,
  generateSceneActions,
  type AICallFn,
  type SceneGenerationContext,
  type SceneOutline,
  type SpokenScriptOptions,
} from '@openmaic/generation';

const SAUDI_POLICY =
  'Server language policy ar-speech-register-2: an Arabic lesson.\n- Every spoken `text` segment: educated white Saudi dialect («طيب»، «خلونا»).';
const MSA_POLICY =
  'Server language policy ar-speech-register-2: an Arabic-language lesson.\n- Every spoken `text` segment: Modern Standard Arabic.';

const ctx: SceneGenerationContext = {
  pageIndex: 3,
  totalPages: 5,
  allTitles: [
    'مقدمة الدرس',
    'قانون نيوتن الأول',
    'القوة المحصلة',
    'مثال على القوة المحصلة',
    'ملخص',
  ],
  previousSpeeches: [
    'طيب، خلونا الحين نتعرف على قانون نيوتن الأول.',
    'وهذا كل شي عن القصور الذاتي.',
  ],
};

const base = { id: 's', description: 'd', keyPoints: ['القوة المحصلة'], order: 3 };
const SCENES: Array<[string, SceneOutline, unknown]> = [
  [
    'slide',
    {
      ...base,
      type: 'slide',
      slideType: 'content',
      contentRole: 'explanation',
      contentKind: 'concept',
      title: 'القوة المحصلة',
    },
    { elements: [] },
  ],
  ['quiz', { ...base, type: 'quiz', title: 'أسئلة على القوة المحصلة' }, { questions: [] }],
  [
    'interactive',
    { ...base, type: 'interactive', title: 'القوة المحصلة' },
    { html: '<div id="w"></div>' },
  ],
  ['pbl', { ...base, type: 'pbl', title: 'مشروع القوة المحصلة' }, {}],
];

async function systemPrompt(
  outline: SceneOutline,
  content: unknown,
  options: { spokenScript?: SpokenScriptOptions; spokenLanguagePolicy?: string },
): Promise<string> {
  let captured = '';
  const aiCall: AICallFn = async (system) => {
    captured = system;
    return JSON.stringify([{ type: 'text', content: 'طيب، الحين ننتقل لموضوع القوة المحصلة.' }]);
  };
  await generateSceneActions(outline, content as never, aiCall, {
    ctx,
    languageDirective: options.spokenLanguagePolicy ?? 'Teach in English.',
    ...options,
  });
  return captured;
}

const saudi = {
  spokenScript: { language: 'arabic', register: 'saudi-white-spoken' },
  spokenLanguagePolicy: SAUDI_POLICY,
} as const;

describe('all four Action prompts receive the ONE shared spoken-script policy', () => {
  test.each(SCENES)(
    '%s: spoken script + signposting, after the register policy',
    async (_type, outline, content) => {
      const system = await systemPrompt(outline, content, saudi);
      const register = system.indexOf('## Spoken Language — Server Policy (highest priority)');
      const script = system.indexOf('## Spoken Script — TTS-ready narration');
      const signposting = system.indexOf('## Topic Signposting');
      expect(register).toBeGreaterThan(-1);
      // The Saudi register policy stays the first, highest-priority rule.
      expect(register).toBeLessThan(script);
      expect(script).toBeLessThan(signposting);
      expect(system).toContain('«إف يساوي إم في إيه»');
      expect(system).toContain('**This Scene:**');
      expect(system).not.toContain('{{');
    },
  );

  test.each(SCENES)(
    '%s: formula rules appear once and never contradict',
    async (_type, outline, content) => {
      const system = await systemPrompt(outline, content, saudi);
      expect(system.split('«سين تربيع»').length - 1).toBe(1);
      // The slide template's own legacy formula block is withheld.
      expect(system).not.toContain('*Formulas — spoken, never printed.*');
      expect(system).not.toContain('*Wording — white Saudi dialect.*');
      expect(system).not.toContain('«تو»'.replace('«', '"'));
    },
  );

  test.each(SCENES)(
    '%s: without the server policy the prompt has no spoken-script block',
    async (_type, outline, content) => {
      const system = await systemPrompt(outline, content, {});
      expect(system).not.toContain('## Spoken Script');
      expect(system).not.toContain('## Topic Signposting');
    },
  );
});

describe('language and register', () => {
  const [, slide, slideContent] = SCENES[0]!;

  test('Saudi lessons get Saudi transition examples', async () => {
    const system = await systemPrompt(slide, slideContent, saudi);
    expect(system).toContain('«طيب، الحين ننتقل لموضوع القوة المحصلة.»');
    expect(system).toContain(SAUDI_POLICY);
  });

  test('subject ARABIC stays MSA: MSA examples, no Saudi transition phrases', async () => {
    const system = await systemPrompt(slide, slideContent, {
      spokenScript: { language: 'arabic', register: 'msa' },
      spokenLanguagePolicy: MSA_POLICY,
    });
    expect(system).toContain(MSA_POLICY);
    expect(system).toContain('«ننتقل الآن إلى موضوع جديد هو …»');
    expect(system).not.toContain('الحين ننتقل');
    expect(system).not.toContain('Natural Saudi openings');
    expect(system).not.toContain('«خلونا الحين نتعرف على …»');
    expect(system).not.toContain('white Saudi dialect');
  });

  test('English narration is never told to pronounce formulas in Arabic', async () => {
    const system = await systemPrompt(slide, slideContent, { spokenScript: { language: 'other' } });
    expect(system).toContain('## Spoken Script — TTS-ready narration');
    expect(system).toContain('"x squared"');
    expect(system).toContain('never in Arabic words');
    expect(system).not.toContain('سين تربيع');
    expect(system).not.toContain('إتش اثنين أو');
    expect(system).not.toContain('## Spoken Language — Server Policy');
  });
});

describe('the scene transition the prompt announces', () => {
  const outline = (title: string, extra: Partial<SceneOutline> = {}): SceneOutline => ({
    id: 'o',
    type: 'slide',
    title,
    description: '',
    keyPoints: [],
    order: 1,
    ...extra,
  });
  const at = (pageIndex: number, allTitles: string[]) => ({
    pageIndex,
    totalPages: allTitles.length,
    allTitles,
  });

  test('first page → opening; new title → new topic; shared topic → continuation', () => {
    const titles = [
      'مقدمة',
      'قانون نيوتن الأول',
      'القوة المحصلة',
      'القوة المحصلة على جسم مائل',
      'تابع: القوة المحصلة',
    ];
    expect(classifySceneTransition(outline(titles[0]!), at(1, titles))?.kind).toBe('opening');
    expect(classifySceneTransition(outline(titles[2]!), at(3, titles))?.kind).toBe('new-topic');
    expect(classifySceneTransition(outline(titles[3]!), at(4, titles))?.kind).toBe('continuation');
    expect(classifySceneTransition(outline(titles[4]!), at(5, titles))?.kind).toBe('continuation');
  });

  test('roles: worked example, practice (and every quiz), summary', () => {
    const titles = ['a', 'b'];
    expect(
      classifySceneTransition(outline('b', { contentRole: 'worked_example' }), at(2, titles))?.kind,
    ).toBe('worked-example');
    expect(
      classifySceneTransition(
        outline('b', { contentRole: 'practice', contentKind: 'guided' }),
        at(2, titles),
      )?.kind,
    ).toBe('practice');
    expect(classifySceneTransition(outline('b', { type: 'quiz' }), at(2, titles))?.kind).toBe(
      'practice',
    );
    expect(
      classifySceneTransition(outline('b', { contentRole: 'summary' }), at(2, titles))?.kind,
    ).toBe('summary');
  });

  test('no page context → no transition is asked for', () => {
    expect(classifySceneTransition(outline('x'), undefined)).toBeNull();
  });

  test("the prompt names this scene's transition and the previous opening to avoid repeating it", async () => {
    const [, slide, slideContent] = SCENES[0]!;
    const system = await systemPrompt(slide, slideContent, saudi);
    expect(system).toContain('NEW TOPIC (page 3 of 5)');
    expect(system).toContain('«قانون نيوتن الأول»');
    expect(system).toContain('open this scene with different wording');
  });
});
