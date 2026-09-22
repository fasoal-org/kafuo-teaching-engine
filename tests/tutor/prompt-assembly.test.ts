import { describe, expect, it } from 'vitest';

import {
  assembleTutorPrompt,
  capUnitChars,
  HISTORY_FLOOR_TURNS,
  TUTOR_CLIP_CHARS,
  type AssemblePolicy,
  type GroundingUnitInput,
  type HistoryTurnInput,
} from '@/lib/server/tutor/prompt-assembly';
import {
  countTokens,
  effectiveCap,
  HARD_CAP,
  tighterCapForPolicy,
  UNIT_CHAR_CAP,
} from '@/lib/server/tutor/token-budget';
import { SAFETY_DIRECTIVE_TEXT, TUTOR_RULES_TEXT, TUTOR_RULES_VERSION } from '@/lib/server/tutor/tutor-rules';

/**
 * Prompt assembly under the enforced budget (plan §8.1, §8.7; contracts §8).
 * The budget assertions RE-COUNT the returned `messages` with the same
 * counter the executor uses, for BOTH targets of the pair.
 */

const MATH_POLICY: AssemblePolicy = {
  primary: { counterKind: 'proxy', modelString: 'qwen:qwen3.7-flash' },
  fallback: { counterKind: 'exact', modelString: 'openai:gpt-5-nano' },
};
const ARABIC_POLICY: AssemblePolicy = {
  primary: { counterKind: 'exact', modelString: 'openai:gpt-5.6-luna' },
  fallback: { counterKind: 'proxy', modelString: 'qwen:qwen3.7-flash' },
};

const ACADEMIC = {
  subjectNameAr: 'الرياضيات',
  subjectNameEn: 'Mathematics',
  curriculumName: 'المنهج الوطني',
  curriculumVersionLabel: '2026',
  gradeLabel: 'الصف التاسع',
  academicLanguage: 'ar',
};

const AR_SENTENCE = 'الاستنتاج المنطقي من الملاحظات المتكررة يسمى تبريراً استقرائياً، ويُستخدم في الرياضيات لاكتشاف الأنماط. ';
const EN_SENTENCE = 'Inductive reasoning draws a general rule from repeated observations, and mathematics uses it to discover patterns. ';

function repeat(sentence: string, chars: number): string {
  let out = '';
  while (out.length < chars) out += sentence;
  return out.slice(0, chars);
}

function syntheticTurns(count: number, sentence: string, chars = 700): HistoryTurnInput[] {
  const turns: HistoryTurnInput[] = [];
  for (let i = 0; i < count; i += 1) {
    turns.push({ student: `${i}: ${repeat(sentence, 120)}`, tutor: `${i}: ${repeat(sentence, chars)}` });
  }
  return turns;
}

function syntheticUnits(totalChars: number, sentence: string, unitChars = 2_000): GroundingUnitInput[] {
  const units: GroundingUnitInput[] = [];
  let remaining = totalChars;
  let i = 0;
  while (remaining > 0) {
    const size = Math.min(unitChars, remaining);
    units.push({ title: `وحدة ${i}`, text: repeat(sentence, size), score: 1 - i * 0.01 });
    remaining -= size;
    i += 1;
  }
  return units;
}

/** Re-count exactly as the executor will, for every counter in the pair. */
function assertUnderEveryCap(messages: { role: string; content: unknown }[], policy: AssemblePolicy, cap?: number) {
  for (const target of [policy.primary, policy.fallback]) {
    const estimate = countTokens(messages as never, target.counterKind, target.modelString);
    const limit = Math.min(effectiveCap(target.counterKind), cap ?? Number.POSITIVE_INFINITY);
    expect(estimate, `${target.modelString} ${estimate} > ${limit}`).toBeLessThanOrEqual(limit);
  }
}

const roles = (messages: { role: string }[]) => messages.map((m) => m.role);

describe('block order (EFF-02)', () => {
  it('rules → academic → grounding → summary → history → turn note → newest message, each block a system message', () => {
    const result = assembleTutorPrompt({
      academic: ACADEMIC,
      grounding: { mode: 'retrieved', lessonTitle: 'قانون حفظ الكتلة', units: [{ title: 'المتفاعلات', text: 'نص الوحدة.' }] },
      history: { summary: 'ملخص سابق.', turns: [{ student: 'س1', tutor: 'ج1' }, { student: 'س2', tutor: 'ج2' }] },
      message: 'س3',
      policy: MATH_POLICY,
      directives: { responseScript: 'ar' },
    });
    expect(roles(result.messages)).toEqual([
      'system', // rules
      'system', // academic
      'system', // grounding
      'system', // summary
      'user',
      'assistant',
      'user',
      'assistant',
      'system', // turn note
      'user', // newest
    ]);
    expect(result.messages[0]!.content).toBe(TUTOR_RULES_TEXT);
    expect(String(result.messages[0]!.content)).toContain(TUTOR_RULES_VERSION);
    expect(String(result.messages[1]!.content)).toContain('الرياضيات — Mathematics');
    expect(String(result.messages[1]!.content)).toContain('Grade / الصف: الصف التاسع');
    expect(String(result.messages[2]!.content)).toContain('Lesson / الدرس: قانون حفظ الكتلة');
    expect(String(result.messages[2]!.content)).toContain('### المتفاعلات');
    expect(String(result.messages[3]!.content)).toContain('ملخص سابق.');
    expect(String(result.messages[8]!.content)).toContain('reply in Arabic');
    expect(result.messages[9]).toEqual({ role: 'user', content: 'س3' });
    expect(result.reductions).toEqual([]);
    expect(result.groundingMode).toBe('retrieved');
  });

  it('is byte-stable across turns for the head blocks (rules, academic, grounding)', () => {
    const grounding = { mode: 'reuse' as const, units: [{ title: 'أ', text: 'نص' }] };
    const turn1 = assembleTutorPrompt({ academic: ACADEMIC, grounding, history: { turns: [] }, message: 'س1', policy: MATH_POLICY });
    const turn2 = assembleTutorPrompt({
      academic: ACADEMIC,
      grounding,
      history: { turns: [{ student: 'س1', tutor: 'ج1' }] },
      message: 'س2',
      policy: MATH_POLICY,
    });
    expect(turn2.messages.slice(0, 3)).toEqual(turn1.messages.slice(0, 3));
  });

  it('never leaks ids, timestamps or internal keys into the model input', () => {
    const result = assembleTutorPrompt({
      academic: ACADEMIC,
      grounding: { mode: 'retrieved', units: [{ title: 'عنوان', text: 'نص' }] },
      history: { turns: [{ student: 'س', tutor: 'ج' }] },
      message: 'س',
      policy: MATH_POLICY,
    });
    const all = result.messages.map((m) => String(m.content)).join('\n');
    expect(all).not.toMatch(/unitId|contentUnitId|tenant|studentRef|conversationId|turnId|reservation|\bid:/i);
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('adds the safety directive to the turn note only when triggered', () => {
    const base = { academic: ACADEMIC, grounding: { mode: 'none' as const }, history: { turns: [] }, message: 'س', policy: MATH_POLICY };
    const plain = assembleTutorPrompt({ ...base, directives: { responseScript: 'ar', safetyTriggered: false } });
    const triggered = assembleTutorPrompt({ ...base, directives: { responseScript: 'ar', safetyTriggered: true } });
    expect(plain.messages.map((m) => String(m.content)).join()).not.toContain(SAFETY_DIRECTIVE_TEXT);
    const note = triggered.messages[triggered.messages.length - 2]!;
    expect(note.role).toBe('system');
    expect(String(note.content)).toContain(SAFETY_DIRECTIVE_TEXT);
    // The stable head is identical either way.
    expect(triggered.messages.slice(0, 2)).toEqual(plain.messages.slice(0, 2));
  });

  it('omits the grounding block on mode none and renders the insufficient note', () => {
    const none = assembleTutorPrompt({ academic: ACADEMIC, grounding: { mode: 'none' }, history: { turns: [] }, message: 'س', policy: MATH_POLICY });
    expect(roles(none.messages)).toEqual(['system', 'system', 'system', 'user']);
    const insufficient = assembleTutorPrompt({ academic: ACADEMIC, grounding: { mode: 'insufficient' }, history: { turns: [] }, message: 'س', policy: MATH_POLICY });
    expect(String(insufficient.messages[2]!.content)).toContain('No curriculum text is available');
    expect(insufficient.groundingMode).toBe('insufficient');
  });
});

describe('budget: the returned messages fit the tighter cap of the pair', () => {
  for (const [label, sentence] of [
    ['Arabic', AR_SENTENCE],
    ['English', EN_SENTENCE],
  ] as const) {
    it(`${label}: 200-turn conversation + 40,000-char grounding on a proxy-primary pair`, () => {
      const result = assembleTutorPrompt({
        academic: ACADEMIC,
        grounding: { mode: 'retrieved', units: syntheticUnits(40_000, sentence) },
        history: { summary: repeat(sentence, 1_000), turns: syntheticTurns(200, sentence) },
        message: repeat(sentence, 300),
        policy: MATH_POLICY,
        directives: { responseScript: label === 'Arabic' ? 'ar' : 'en' },
      });
      assertUnderEveryCap(result.messages, MATH_POLICY);
      expect(result.budget.effectiveCap).toBe(tighterCapForPolicy(MATH_POLICY));
      expect(result.budget.counterKind).toBe('proxy');
      expect(result.budget.hardCap).toBe(HARD_CAP);
      expect(result.budget.estimate).toBeLessThanOrEqual(result.budget.effectiveCap);
      expect(result.grounding.totalChars).toBeLessThanOrEqual(UNIT_CHAR_CAP);
      expect(result.reductions[0]).toBe('unit_char_cap');
      expect(result.reductions).toContain('drop_oldest_turns');
      expect(result.history.turnsIncluded).toBeGreaterThan(0);
      expect(result.messages[result.messages.length - 1]!.role).toBe('user');
    });

    it(`${label}: same on an exact-primary pair (Arabic policy)`, () => {
      const result = assembleTutorPrompt({
        academic: ACADEMIC,
        grounding: { mode: 'retrieved', units: syntheticUnits(40_000, sentence) },
        history: { turns: syntheticTurns(200, sentence) },
        message: repeat(sentence, 300),
        policy: ARABIC_POLICY,
      });
      assertUnderEveryCap(result.messages, ARABIC_POLICY);
      expect(result.budget.effectiveCap).toBe(effectiveCap('proxy'));
    });
  }

  it('honours a tighter capTokens override (titles ≤ 300)', () => {
    const result = assembleTutorPrompt({
      rules: 'Write a title.',
      academic: ACADEMIC,
      grounding: { mode: 'none' },
      history: { turns: [{ student: repeat(AR_SENTENCE, 200), tutor: repeat(AR_SENTENCE, 200) }] },
      message: 'Title:',
      policy: MATH_POLICY,
      capTokens: 300,
    });
    assertUnderEveryCap(result.messages, MATH_POLICY, 300);
    expect(result.budget.effectiveCap).toBe(300);
  });
});

/**
 * Largest message length (in 100-char steps) for which `predicate` holds;
 * the predicates below are monotone in the message size.
 */
function largestMessage(predicate: (chars: number) => boolean, max = 70_000): number {
  let lo = 0;
  let hi = max;
  while (hi - lo > 100) {
    const mid = Math.floor((lo + hi) / 2 / 100) * 100;
    if (predicate(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

describe('reduction ladder order (plan §8.7)', () => {
  const ladderInput = (messageChars: number) => ({
    academic: ACADEMIC,
    grounding: { mode: 'retrieved' as const, units: syntheticUnits(9_000, AR_SENTENCE, 1_500) },
    history: { summary: repeat(AR_SENTENCE, 2_000), turns: syntheticTurns(16, AR_SENTENCE, 3_000) },
    message: repeat(AR_SENTENCE, messageChars),
    policy: MATH_POLICY,
  });

  it('drops oldest turns, then clips older tutor messages, then the summary, then trims and drops grounding, then the rest of history', () => {
    // The largest message that still fits at all: everything else must have given way.
    const chars = largestMessage((n) => {
      try {
        assembleTutorPrompt(ladderInput(n));
        return true;
      } catch {
        return false;
      }
    });
    expect(chars).toBeGreaterThan(0);
    const result = assembleTutorPrompt(ladderInput(chars));
    assertUnderEveryCap(result.messages, MATH_POLICY);
    expect(result.reductions).toEqual([
      'drop_oldest_turns',
      'clip_older_tutor_messages',
      'drop_summary',
      'trim_grounding',
      'drop_grounding',
      'drop_recent_turns',
    ]);
    expect(result.groundingMode).toBe('insufficient');
    expect(result.grounding.units).toEqual([]);
    expect(result.history.summaryIncluded).toBe(false);
    expect(result.history.turnsIncluded).toBe(0);
    // Just past it: REQUEST_TOO_LARGE.
    expect(() => assembleTutorPrompt(ladderInput(chars + 400))).toThrowError(
      expect.objectContaining({ code: 'REQUEST_TOO_LARGE', status: 422 }),
    );
  });

  it('stops at the first step that fits and keeps the recent floor', () => {
    const result = assembleTutorPrompt({
      academic: ACADEMIC,
      grounding: { mode: 'retrieved', units: syntheticUnits(3_000, AR_SENTENCE) },
      history: { turns: syntheticTurns(120, AR_SENTENCE, 900) },
      message: 'سؤال قصير',
      policy: MATH_POLICY,
    });
    expect(result.reductions).toEqual(['drop_oldest_turns']);
    expect(result.history.turnsIncluded).toBeGreaterThanOrEqual(HISTORY_FLOOR_TURNS);
    expect(result.groundingMode).toBe('retrieved');
    // The kept turns are the NEWEST ones.
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant')!;
    expect(String(lastAssistant.content).startsWith('119:')).toBe(true);
  });

  it('clips tutor messages older than the three most recent turns to 600 chars', () => {
    const result = assembleTutorPrompt({
      academic: ACADEMIC,
      grounding: { mode: 'none' },
      history: { turns: syntheticTurns(HISTORY_FLOOR_TURNS, AR_SENTENCE, 30_000) },
      message: 'س',
      policy: MATH_POLICY,
    });
    expect(result.reductions[0]).toBe('clip_older_tutor_messages');
    const assistants = result.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    for (const text of assistants.slice(0, -3)) expect(text.length).toBeLessThanOrEqual(TUTOR_CLIP_CHARS + 2);
  });

  it('trims grounding from the least relevant end and never adds units (Help mode)', () => {
    const units: GroundingUnitInput[] = [
      { title: 'أهم', text: repeat(AR_SENTENCE, 3_000), score: 0.9 },
      { title: 'متوسط', text: repeat(AR_SENTENCE, 3_000), score: 0.5 },
      { title: 'أقل', text: repeat(AR_SENTENCE, 3_000), score: 0.1 },
    ];
    const helpInput = (messageChars: number) => ({
      academic: ACADEMIC,
      grounding: { mode: 'scene' as const, sceneTitle: 'المشهد', units },
      history: { turns: [] },
      message: repeat(AR_SENTENCE, messageChars),
      policy: MATH_POLICY,
      helpMode: true,
    });
    // The largest message for which SOME Scene grounding still fits.
    const chars = largestMessage((n) => {
      try {
        return assembleTutorPrompt(helpInput(n)).groundingMode === 'scene';
      } catch {
        return false;
      }
    });
    const result = assembleTutorPrompt(helpInput(chars));
    assertUnderEveryCap(result.messages, MATH_POLICY);
    expect(result.reductions).toEqual(['trim_grounding']);
    const kept = result.grounding.units.map((u) => u.title);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThan(3);
    expect(kept[0]).toBe('أهم');
    for (const title of kept) expect(units.map((u) => u.title)).toContain(title);
    expect(String(result.messages[2]!.content)).toContain('Lesson Help anchored to the current Scene');
    expect(String(result.messages[2]!.content)).toContain('Scene / المشهد: المشهد');
    // Past it, grounding is dropped entirely (never widened) and the mode says so.
    const dropped = assembleTutorPrompt(helpInput(chars + 400));
    expect(dropped.groundingMode).toBe('insufficient');
    expect(dropped.grounding.units).toEqual([]);
    expect(dropped.reductions).toEqual(['trim_grounding', 'drop_grounding']);
  });

  it('REQUEST_TOO_LARGE when rules + academic + the message alone exceed the cap, after exhausting the ladder', () => {
    expect(() =>
      assembleTutorPrompt({
        academic: ACADEMIC,
        grounding: { mode: 'retrieved', units: syntheticUnits(5_000, AR_SENTENCE) },
        history: { summary: 'ملخص', turns: syntheticTurns(10, AR_SENTENCE) },
        message: repeat(AR_SENTENCE, 200_000),
        policy: MATH_POLICY,
      }),
    ).toThrowError(expect.objectContaining({ code: 'REQUEST_TOO_LARGE', status: 422 }));
  });
});

describe('UNIT_CHAR_CAP pre-cap', () => {
  it('drops the least relevant units first, then head-cuts a lone giant at a paragraph boundary', () => {
    const many = capUnitChars([
      { title: 'a', text: 'x'.repeat(6_000), score: 0.9 },
      { title: 'b', text: 'y'.repeat(6_000), score: 0.2 },
    ]);
    expect(many.changed).toBe(true);
    expect(many.units.map((u) => u.title)).toEqual(['a']);

    const paragraphs = Array.from({ length: 30 }, (_, i) => `فقرة ${i} ${'ن'.repeat(400)}`).join('\n\n');
    const giant = capUnitChars([{ title: 'g', text: paragraphs }]);
    expect(giant.changed).toBe(true);
    expect(giant.units[0]!.truncated).toBe(true);
    expect(giant.units[0]!.text.length).toBeLessThanOrEqual(UNIT_CHAR_CAP);
    expect(giant.units[0]!.text.endsWith('ن')).toBe(true);
  });
});
