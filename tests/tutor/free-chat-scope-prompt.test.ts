/**
 * TE-3 (Free Chat iOS run, 6 Oct 2026): in an Arabic-subject Free Chat a
 * Mathematics question got «this lesson is about Arabic grammar». Free Chat
 * now carries its own scope line (another subject → say this chat is for the
 * subject above and suggest that subject's Free Chat; never "this lesson")
 * and its insufficient-grounding note speaks of "the curriculum".
 *
 * Lesson / Scene Help must not move: every block after the rules block is
 * compared with the prompt the pre-r3 code (HEAD before this change)
 * assembled for the same input (`fixtures/help-prompts-before-r3.json`).
 */
import { describe, expect, it } from 'vitest';

import {
  assembleTutorPrompt,
  type AssemblePolicy,
  type AssembleTutorPromptInput,
  type GroundingInput,
} from '@/lib/server/tutor/prompt-assembly';
import {
  COMPACTION_PROMPT_TEXT,
  COMPACTION_REQUEST_TEXT,
  TITLE_PROMPT_TEXT,
  TITLE_REQUEST_TEXT,
  TUTOR_RULES_TEXT,
} from '@/lib/server/tutor/tutor-rules';

import HELP_PROMPTS_BEFORE_R3 from './fixtures/help-prompts-before-r3.json';

const POLICY: AssemblePolicy = {
  primary: { counterKind: 'proxy', modelString: 'qwen:qwen3.7-flash' },
  fallback: { counterKind: 'exact', modelString: 'openai:gpt-5-nano' },
};

const ARABIC_SUBJECT = {
  subjectNameAr: 'اللغة العربية',
  subjectNameEn: 'Arabic',
  curriculumName: 'المنهج الوطني',
  curriculumVersionLabel: '2026',
  gradeLabel: 'الصف التاسع',
  academicLanguage: 'ar',
};

const freeChat = (grounding: GroundingInput, message = 'اشرح لي الدوال الخطية') =>
  assembleTutorPrompt({
    academic: ARABIC_SUBJECT,
    grounding,
    history: { turns: [] },
    message,
    policy: POLICY,
  });

const allText = (result: ReturnType<typeof assembleTutorPrompt>) =>
  result.messages.map((m) => String(m.content)).join('\n');

const SCOPE_EN =
  "If the question belongs to another subject, say briefly that this chat is for the subject named above and suggest that subject's Free Chat.";
const SCOPE_AR =
  'إن كان السؤال يخص مادة أخرى فقل باختصار إن هذه الدردشة مخصصة للمادة المذكورة أعلاه واقترح الدردشة الحرة لتلك المادة.';
const NO_THIS_LESSON_EN = 'Never say "this lesson" in this chat';
const NO_THIS_LESSON_AR = 'لا تقل «هذا الدرس» في هذه الدردشة أبدًا';

describe('Free Chat scope line (TE-3)', () => {
  it('the academic block names the other-subject rule and bans «this lesson», in both languages', () => {
    const result = freeChat({ mode: 'none' });
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'system', 'system', 'user']);
    const academic = String(result.messages[1]!.content);
    expect(academic).toContain('Subject / المادة: اللغة العربية — Arabic');
    expect(academic).toContain(SCOPE_EN);
    expect(academic).toContain(SCOPE_AR);
    expect(academic).toContain(NO_THIS_LESSON_EN);
    expect(academic).toContain(NO_THIS_LESSON_AR);
    // The subject comes first, the scope line refers back to it.
    expect(academic.indexOf('Subject / المادة')).toBeLessThan(academic.indexOf(SCOPE_EN));
  });

  it('is present on every Free Chat grounding mode and byte-stable across turns', () => {
    const modes: GroundingInput[] = [
      { mode: 'none' },
      { mode: 'insufficient' },
      {
        mode: 'retrieved',
        lessonTitle: 'المبتدأ والخبر',
        units: [{ title: 'المبتدأ', text: 'نص' }],
      },
      { mode: 'reuse', units: [{ title: 'الخبر', text: 'نص' }] },
    ];
    const first = String(freeChat(modes[0]!).messages[1]!.content);
    for (const grounding of modes) {
      const turn1 = freeChat(grounding, 'سؤال');
      const turn2 = assembleTutorPrompt({
        academic: ARABIC_SUBJECT,
        grounding,
        history: { turns: [{ student: 'سؤال', tutor: 'جواب' }] },
        message: 'سؤال آخر',
        policy: POLICY,
      });
      expect(String(turn1.messages[1]!.content)).toBe(first);
      expect(turn2.messages.slice(0, 2)).toEqual(turn1.messages.slice(0, 2));
    }
  });

  it('Free Chat without an academic block still gets the scope line, right after the rules', () => {
    const result = assembleTutorPrompt({
      academic: null,
      grounding: { mode: 'none' },
      history: { turns: [] },
      message: 'سؤال',
      policy: POLICY,
    });
    expect(result.messages[0]!.content).toBe(TUTOR_RULES_TEXT);
    expect(String(result.messages[1]!.content)).toContain(SCOPE_EN);
  });

  it('titles and compaction (their own rules) and Help never get the Free Chat scope line', () => {
    const title = assembleTutorPrompt({
      rules: TITLE_PROMPT_TEXT,
      academic: ARABIC_SUBJECT,
      grounding: { mode: 'none' },
      history: { turns: [{ student: 'سؤال', tutor: 'جواب' }] },
      message: TITLE_REQUEST_TEXT,
      policy: POLICY,
      capTokens: 300,
    });
    const compaction = assembleTutorPrompt({
      rules: COMPACTION_PROMPT_TEXT,
      academic: ARABIC_SUBJECT,
      grounding: { mode: 'none' },
      history: { turns: [{ student: 'سؤال', tutor: 'جواب' }] },
      message: COMPACTION_REQUEST_TEXT,
      policy: POLICY,
    });
    const help = assembleTutorPrompt({
      academic: ARABIC_SUBJECT,
      grounding: { mode: 'insufficient' },
      history: { turns: [] },
      message: 'سؤال',
      policy: POLICY,
      helpMode: true,
    });
    for (const result of [title, compaction, help]) {
      expect(allText(result)).not.toContain(SCOPE_EN);
      expect(allText(result)).not.toContain(NO_THIS_LESSON_AR);
    }
  });
});

describe('Free Chat insufficient-grounding note says "the curriculum" (TE-3)', () => {
  const cases: Array<[string, GroundingInput]> = [
    ['plain', { mode: 'insufficient' }],
    ['no_match', { mode: 'insufficient', reason: 'no_match' }],
    ['index_not_ready', { mode: 'insufficient', reason: 'index_not_ready' }],
    ['retrieval_busy', { mode: 'insufficient', reason: 'retrieval_busy' }],
    ['retrieved with no units', { mode: 'retrieved', lessonTitle: 'المبتدأ والخبر', units: [] }],
  ];
  for (const [label, grounding] of cases) {
    it(`${label}: the curriculum, never the lesson`, () => {
      const block = String(freeChat(grounding).messages[2]!.content);
      expect(block).toContain('No curriculum text is available for this turn.');
      expect(block).toContain(
        "Do not claim what the curriculum states; say that you cannot confirm the curriculum's wording",
      );
      expect(block).toContain('لا تدّعِ ما يذكره المنهج؛ قل إنك لا تستطيع تأكيد صياغة المنهج');
      expect(block).not.toMatch(/lesson|الدرس/i);
    });
  }

  it('the ladder dropping Free Chat grounding renders the same curriculum note', () => {
    const repeat = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
    const sentence = 'الاستنتاج المنطقي من الملاحظات المتكررة يسمى تبريراً استقرائياً. ';
    const input = (chars: number): AssembleTutorPromptInput => ({
      academic: ARABIC_SUBJECT,
      grounding: { mode: 'retrieved', units: [{ title: 'وحدة', text: repeat(sentence, 3_000) }] },
      history: { turns: [] },
      message: repeat(sentence, chars),
      policy: POLICY,
    });
    // Largest message that still keeps the grounding (monotone), then one step past it.
    const keepsGrounding = (chars: number) => {
      try {
        return assembleTutorPrompt(input(chars)).groundingMode === 'retrieved';
      } catch {
        return false; // REQUEST_TOO_LARGE
      }
    };
    let lo = 0;
    let hi = 120_000;
    while (hi - lo > 500) {
      const mid = Math.floor((lo + hi) / 2);
      if (keepsGrounding(mid)) lo = mid;
      else hi = mid;
    }
    const dropped = assembleTutorPrompt(input(hi));
    expect(dropped.groundingMode).toBe('insufficient');
    expect(dropped.reductions).toContain('drop_grounding');
    const block = String(dropped.messages[2]!.content);
    expect(block).toContain('Do not claim what the curriculum states');
    expect(block).not.toMatch(/lesson|الدرس/i);
  });
});

describe('Lesson / Scene Help prompts are unchanged (only the rules block moves to r3, then r4)', () => {
  const HELP_POLICY = POLICY;
  const PHYSICS = {
    subjectNameAr: 'الفيزياء',
    subjectNameEn: 'Physics',
    curriculumName: 'المنهج الوطني',
    curriculumVersionLabel: '2026',
    gradeLabel: 'الصف الأول الثانوي',
    academicLanguage: 'ar',
  };
  const SCENE_UNITS = [
    { title: 'القوة', text: 'القوة مؤثر يغير حالة الجسم.', score: 0.9 },
    { title: 'التسارع', text: 'التسارع معدل تغير السرعة.', score: 0.5 },
  ];
  // Same inputs that produced fixtures/help-prompts-before-r3.json on the pre-r3 code.
  const CASES: Record<keyof typeof HELP_PROMPTS_BEFORE_R3, AssembleTutorPromptInput> = {
    scene_complete: {
      academic: PHYSICS,
      grounding: {
        mode: 'scene',
        sceneTitle: 'قانون نيوتن الثاني',
        sceneText: 'القوة تساوي الكتلة في التسارع.',
        units: SCENE_UNITS,
        coverage: 'complete',
      },
      history: { turns: [{ student: 'ما القوة؟', tutor: 'القوة مؤثر.' }] },
      message: 'اشرح التسارع',
      policy: HELP_POLICY,
      directives: { responseScript: 'ar', localeHint: 'ar', intentHint: 'explain' },
      helpMode: true,
    },
    scene_partial_safety: {
      academic: PHYSICS,
      grounding: {
        mode: 'scene',
        sceneTitle: 'قانون نيوتن الثاني',
        units: SCENE_UNITS,
        coverage: 'partial',
      },
      history: { turns: [] },
      message: 'give me a hint',
      policy: HELP_POLICY,
      directives: { responseScript: 'en', intentHint: 'hint', safetyTriggered: true },
      helpMode: true,
    },
    scene_without_units: {
      academic: PHYSICS,
      grounding: { mode: 'scene', units: [] },
      history: { turns: [] },
      message: 'سؤال',
      policy: HELP_POLICY,
      helpMode: true,
    },
    help_insufficient: {
      academic: PHYSICS,
      grounding: { mode: 'insufficient' },
      history: { turns: [{ student: 'سؤال سابق', tutor: null }] },
      message: 'ما الطاقة الحركية؟',
      policy: HELP_POLICY,
      directives: { responseScript: 'mixed', intentHint: 'check_answer' },
      helpMode: true,
    },
    help_insufficient_no_match: {
      academic: PHYSICS,
      grounding: { mode: 'insufficient', reason: 'no_match' },
      history: { turns: [] },
      message: '...',
      policy: HELP_POLICY,
      directives: { localeHint: 'en', intentHint: 'simplify' },
      helpMode: true,
    },
    help_reuse_without_units: {
      academic: PHYSICS,
      grounding: { mode: 'reuse', lessonTitle: 'قانون نيوتن الثاني', units: [] },
      history: { turns: [] },
      message: 'سؤال',
      policy: HELP_POLICY,
      helpMode: true,
    },
    help_without_academic: {
      academic: null,
      grounding: { mode: 'insufficient' },
      history: { summary: 'ملخص سابق.', turns: [] },
      message: 'سؤال',
      policy: HELP_POLICY,
      directives: { responseScript: 'ar' },
      helpMode: true,
    },
  };

  for (const [name, input] of Object.entries(CASES) as Array<
    [keyof typeof CASES, AssembleTutorPromptInput]
  >) {
    it(`${name}: every block after the rules equals the pre-r3 prompt`, () => {
      const result = assembleTutorPrompt(input);
      expect(result.messages[0]!.content).toBe(TUTOR_RULES_TEXT);
      expect(result.groundingMode).toBe(HELP_PROMPTS_BEFORE_R3[name].groundingMode);
      expect(result.messages.slice(1)).toEqual(HELP_PROMPTS_BEFORE_R3[name].messages);
    });
  }
});
