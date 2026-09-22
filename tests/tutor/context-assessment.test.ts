import { describe, expect, it } from 'vitest';

import { extractKeywords } from '@/lib/server/tutor/arabic-text';
import {
  assessContext,
  decideLessonAssociation,
  GROUNDING_STALE_TURNS,
  groundingKeywords,
  lessonMatchThreshold,
  type AssessmentRule,
  type ContextDecision,
} from '@/lib/server/tutor/context-assessment';

/**
 * Rule-based context assessment (FRD CTX-01..05; plan §8.2). Table-driven,
 * Arabic and English per rule, in rule order. The assessment is a pure
 * function: no model, no I/O.
 */

const MASS_GROUNDING = {
  keywords: extractKeywords(
    'قانون حفظ الكتلة: كتلة المواد المتفاعلة تساوي كتلة المواد الناتجة في التفاعل الكيميائي. law of conservation of mass reactants products chemical reaction',
  ),
  turnsSinceUse: 1,
};

type Case = [message: string, decision: ContextDecision, rule: AssessmentRule];

function run(cases: Case[], grounding: typeof MASS_GROUNDING | null) {
  for (const [message, decision, rule] of cases) {
    const result = assessContext({ message, grounding });
    expect({ message, decision: result.decision, rule: result.rule }).toEqual({ message, decision, rule });
    if (decision === 'retrieve') expect(result.query).toBeTruthy();
    else expect(result.query).toBeUndefined();
  }
}

describe('rule 1 — social / meta → none', () => {
  it('Arabic and English greetings and meta questions', () => {
    run(
      [
        ['شكرا', 'none', 'social_meta'],
        ['مرحبا!', 'none', 'social_meta'],
        ['من أنت؟', 'none', 'social_meta'],
        ['hello', 'none', 'social_meta'],
        ['thanks!', 'none', 'social_meta'],
        ['who are you?', 'none', 'social_meta'],
      ],
      MASS_GROUNDING,
    );
  });
});

describe('rule 2 — explicit curriculum signal', () => {
  it('reuses when the grounding overlaps, retrieves otherwise', () => {
    run(
      [
        ['ما تعريف قانون حفظ الكتلة في الدرس؟', 'reuse', 'explicit_curriculum_reuse'],
        ['what does the textbook say about conservation of mass?', 'reuse', 'explicit_curriculum_reuse'],
        ['ما تعريف السرعة المتجهة حسب المنهج؟', 'retrieve', 'explicit_curriculum_retrieve'],
        ['define velocity as in the lesson', 'retrieve', 'explicit_curriculum_retrieve'],
      ],
      MASS_GROUNDING,
    );
  });

  it('retrieves without any grounding', () => {
    run(
      [
        ['ما تعريف التسارع في الكتاب؟', 'retrieve', 'explicit_curriculum_retrieve'],
        ['according to the curriculum, what is acceleration?', 'retrieve', 'explicit_curriculum_retrieve'],
      ],
      null,
    );
  });
});

describe('rule 3 — continuation cue with a recently used grounding', () => {
  it('short follow-ups, anaphora and simplification requests reuse', () => {
    run(
      [
        ['ليه؟', 'reuse', 'continuation'],
        ['بسّط أكتر', 'reuse', 'continuation'],
        ['مثال تاني', 'reuse', 'continuation'],
        ['why?', 'reuse', 'continuation'],
        ['explain it again, simpler', 'reuse', 'continuation'],
        ['another example', 'reuse', 'continuation'],
      ],
      MASS_GROUNDING,
    );
  });

  it('does not fire when the grounding was used more than 6 turns ago', () => {
    const old = { ...MASS_GROUNDING, turnsSinceUse: 7 };
    const result = assessContext({ message: 'why?', grounding: old });
    expect(result.rule).not.toBe('continuation');
  });
});

describe('rule 4 — answer-check / hint cue', () => {
  it('reuses with a grounding, none without', () => {
    run(
      [
        ['هل إجابتي صحيحة: 12 جرام؟', 'reuse', 'answer_check_reuse'],
        ['give me a hint only, not the solution', 'reuse', 'answer_check_reuse'],
      ],
      { ...MASS_GROUNDING, turnsSinceUse: 8 },
    );
    run(
      [
        ['هل إجابتي صحيحة: 12 جرام؟', 'none', 'answer_check_none'],
        ['is my answer right? 12 grams', 'none', 'answer_check_none'],
      ],
      null,
    );
  });
});

describe('rule 5 — topic continuity against the current grounding', () => {
  it('reuses on overlap ≥ 0.2 and retrieves on a topic shift with ≥ 2 content keywords', () => {
    const grounding = { ...MASS_GROUNDING, turnsSinceUse: 8 };
    run(
      [
        ['احسب كتلة المواد الناتجة من التفاعل', 'reuse', 'topic_continuity_reuse'],
        ['compute the mass of the products of the reaction', 'reuse', 'topic_continuity_reuse'],
        ['اشرح الروابط التساهمية والأيونية', 'retrieve', 'topic_shift_retrieve'],
        ['explain covalent bonds', 'retrieve', 'topic_shift_retrieve'],
      ],
      grounding,
    );
  });

  it('a single unrelated keyword is not a shift (default none)', () => {
    const result = assessContext({ message: 'الروابط', grounding: { ...MASS_GROUNDING, turnsSinceUse: 8 } });
    expect(result.decision).toBe('none');
  });
});

describe('rule 6 — lesson discovery without grounding', () => {
  it('quoted phrase, ≥ 3 consecutive content keywords, lesson-ish noun', () => {
    run(
      [
        ['ما معنى "حفظ الكتلة" في التفاعلات؟', 'retrieve', 'lesson_discovery'],
        ['قانون حفظ الكتلة التفاعلات', 'retrieve', 'lesson_discovery'],
        ['اشرح درس التفاعلات', 'retrieve', 'lesson_discovery'],
        ['what is "kinetic energy" exactly', 'retrieve', 'lesson_discovery'],
        ['newton second law acceleration', 'retrieve', 'lesson_discovery'],
        ['the chapter on forces', 'retrieve', 'lesson_discovery'],
      ],
      null,
    );
  });
});

describe('rule 7 — default: subject-level conversation', () => {
  it('casual subject talk stays none', () => {
    run(
      [
        ['ممكن نتكلم عن الكيمياء شوية؟', 'none', 'default_none'],
        ['can we talk a bit', 'none', 'default_none'],
      ],
      null,
    );
  });
});

describe('stale grounding', () => {
  it(`is treated as absent after ${GROUNDING_STALE_TURNS} turns`, () => {
    const stale = { ...MASS_GROUNDING, turnsSinceUse: GROUNDING_STALE_TURNS + 1 };
    const result = assessContext({ message: 'احسب كتلة المواد الناتجة من التفاعل', grounding: stale });
    expect(result.groundingStale).toBe(true);
    expect(result.overlap).toBe(0);
    // Without grounding this is lesson discovery (3+ consecutive content words), not reuse.
    expect(result.decision).toBe('retrieve');
    expect(result.rule).toBe('lesson_discovery');
  });
});

describe('lesson association (CTX-04)', () => {
  const units = (lessonIds: string[]) =>
    lessonIds.map((lessonId, i) => ({
      contentUnitId: `u${i}`,
      lessonId,
      lessonTitle: 'L',
      unitTitle: 't',
      text: 'x',
      charLength: 1,
      score: 1,
    }));

  it('associates only above the threshold and when every unit shares the lesson', () => {
    expect(
      decideLessonAssociation({
        units: units(['L1', 'L1']),
        lessonMatch: { lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.62 },
      }),
    ).toEqual({ lessonId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.62 });
    expect(
      decideLessonAssociation({
        units: units(['L1', 'L1']),
        lessonMatch: { lessonId: 'L1', lessonTitle: 'x', confidence: 0.44 },
      }),
    ).toBeNull();
    expect(
      decideLessonAssociation({
        units: units(['L1', 'L2']),
        lessonMatch: { lessonId: 'L1', lessonTitle: 'x', confidence: 0.9 },
      }),
    ).toBeNull();
    expect(decideLessonAssociation({ units: units(['L1']), lessonMatch: null })).toBeNull();
    expect(decideLessonAssociation({ units: [], lessonMatch: { lessonId: 'L1', lessonTitle: 'x', confidence: 0.9 } })).toBeNull();
  });

  it('reads TUTOR_LESSON_MATCH_THRESHOLD with a 0.45 default', () => {
    expect(lessonMatchThreshold({})).toBe(0.45);
    expect(lessonMatchThreshold({ TUTOR_LESSON_MATCH_THRESHOLD: '0.7' })).toBe(0.7);
    expect(lessonMatchThreshold({ TUTOR_LESSON_MATCH_THRESHOLD: 'nope' })).toBe(0.45);
    expect(lessonMatchThreshold({ TUTOR_LESSON_MATCH_THRESHOLD: '0' })).toBe(0.45);
  });

  it('builds snapshot keywords from unit titles and text heads', () => {
    const keywords = groundingKeywords([{ unitTitle: 'حفظ الكتلة', text: 'كتلة المتفاعلات تساوي كتلة النواتج' }]);
    expect(keywords).toContain('حفظ');
    expect(keywords).toContain('كتله');
    expect(keywords).toContain('نواتج');
  });
});
