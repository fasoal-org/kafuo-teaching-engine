/**
 * The Stage-1 slide-semantics contract: every generated `slide` outline is
 * explicitly classified by the model, and the deterministic check only ever
 * accepts or reports — it never picks a classification itself.
 */
import { describe, expect, it } from 'vitest';
import { SLIDE_CONTENT_KINDS_BY_ROLE, SLIDE_CONTENT_ROLES } from '@openmaic/dsl';

import {
  OUTLINE_SLIDE_SEMANTICS_ERROR,
  OUTLINE_SLIDE_TYPES,
  buildOutlinePrompt,
  formatOutlineSemanticsIssues,
  stripEmptyOutlineSemantics,
  validateOutlineSlideSemantics,
  type SceneOutline,
} from '@openmaic/generation';

let nextId = 0;
function slide(semantics: Record<string, unknown>): SceneOutline {
  nextId += 1;
  return {
    id: `scene_${nextId}`,
    type: 'slide',
    title: 'T',
    description: 'D',
    keyPoints: ['k'],
    order: nextId,
    ...semantics,
  } as SceneOutline;
}

const NATIVE = { mode: 'native' } as const;
const PLAN = { hint: 'look at the units', explanation: 'convert, then divide' };

describe('validateOutlineSlideSemantics', () => {
  it('accepts representative classifications across pedagogical purposes', () => {
    const outlines = [
      slide({ slideType: 'cover', contentRole: 'orientation', visualPlan: NATIVE }),
      slide({ slideType: 'content', contentRole: 'explanation', contentKind: 'concept' }),
      slide({ slideType: 'content', contentRole: 'explanation', contentKind: 'definition' }),
      slide({ slideType: 'content', contentRole: 'example' }),
      slide({ slideType: 'content', contentRole: 'worked_example' }),
      slide({ slideType: 'content', contentRole: 'procedure' }),
      slide({ slideType: 'content', contentRole: 'activity', contentKind: 'investigation' }),
      slide({ slideType: 'content', contentRole: 'practice', contentKind: 'guided' }),
      slide({ slideType: 'content', contentRole: 'check_understanding' }),
      slide({ slideType: 'transition', contentRole: 'orientation' }),
      slide({ slideType: 'content', contentRole: 'summary' }),
      slide({ slideType: 'end', contentRole: 'summary' }),
    ];
    expect(validateOutlineSlideSemantics(outlines)).toEqual([]);
  });

  it('accepts every role/kind pair of the Phase 1 table and no other', () => {
    for (const role of SLIDE_CONTENT_ROLES) {
      const kinds = SLIDE_CONTENT_KINDS_BY_ROLE[role];
      for (const kind of kinds) {
        expect(
          validateOutlineSlideSemantics([
            slide({
              slideType: 'content',
              contentRole: role,
              contentKind: kind,
              // Independent practice is the one pair that must plan assistance.
              ...(kind === 'independent' && { assistancePlan: PLAN }),
            }),
          ]),
        ).toEqual([]);
      }
      const foreignKind = role === 'explanation' ? 'guided' : 'concept';
      expect(
        validateOutlineSlideSemantics([
          slide({ slideType: 'content', contentRole: role, contentKind: foreignKind }),
        ]),
      ).toHaveLength(1);
    }
  });

  it('keeps contents available as an explicit choice', () => {
    expect(OUTLINE_SLIDE_TYPES).toEqual(['cover', 'contents', 'transition', 'content', 'end']);
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'contents', contentRole: 'orientation' })]),
    ).toEqual([]);
  });

  it.each([
    ['example + concept', { contentRole: 'example', contentKind: 'concept' }],
    ['summary + guided', { contentRole: 'summary', contentKind: 'guided' }],
    ['procedure + observation', { contentRole: 'procedure', contentKind: 'observation' }],
  ])('rejects the invalid combination %s', (_label, semantics) => {
    const issues = validateOutlineSlideSemantics([slide({ slideType: 'content', ...semantics })]);
    expect(issues).toEqual([expect.objectContaining({ index: 0, field: 'contentKind' })]);
  });

  it('requires a contentKind on the roles that define kinds', () => {
    for (const contentRole of ['explanation', 'activity', 'practice']) {
      expect(validateOutlineSlideSemantics([slide({ slideType: 'content', contentRole })])).toEqual(
        [expect.objectContaining({ field: 'contentKind' })],
      );
    }
  });

  it('reports a missing classification rather than defaulting one', () => {
    const issues = validateOutlineSlideSemantics([slide({})]);
    expect(issues.map((issue) => issue.field)).toEqual(['slideType', 'contentRole']);
  });

  it('lets a structural-only slide omit its role, never an instructional one', () => {
    for (const slideType of ['contents', 'transition', 'end']) {
      expect(validateOutlineSlideSemantics([slide({ slideType })])).toEqual([]);
    }
    for (const slideType of ['cover', 'content']) {
      expect(validateOutlineSlideSemantics([slide({ slideType })])).toEqual([
        expect.objectContaining({ field: 'contentRole' }),
      ]);
    }
    // A role on a structural slide is still validated, and a kind needs a role.
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'end', contentRole: 'summary' })]),
    ).toEqual([]);
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'end', contentRole: 'game' })]),
    ).toEqual([expect.objectContaining({ field: 'contentRole' })]);
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'transition', contentKind: 'concept' })]),
    ).toEqual([expect.objectContaining({ field: 'contentKind' })]);
  });

  it('gates assistancePlan by role: required, optional, or reported — never dropped', () => {
    const practice = (contentKind: string, extra: Record<string, unknown> = {}) =>
      slide({ slideType: 'content', contentRole: 'practice', contentKind, ...extra });

    // Required for independent practice, with hint + explanation at minimum.
    expect(validateOutlineSlideSemantics([practice('independent')])).toEqual([
      expect.objectContaining({ field: 'assistancePlan' }),
    ]);
    expect(
      validateOutlineSlideSemantics([practice('independent', { assistancePlan: { hint: 'h' } })]),
    ).toEqual([expect.objectContaining({ field: 'assistancePlan' })]);

    // Optional on the other assistance roles.
    expect(validateOutlineSlideSemantics([practice('guided')])).toEqual([]);
    expect(
      validateOutlineSlideSemantics([
        practice('higher_order', { assistancePlan: PLAN }),
        slide({ slideType: 'content', contentRole: 'check_understanding', assistancePlan: PLAN }),
      ]),
    ).toEqual([]);

    // Forbidden anywhere else — an issue, and the outline is left untouched.
    const worked = slide({
      slideType: 'content',
      contentRole: 'worked_example',
      assistancePlan: PLAN,
    });
    expect(validateOutlineSlideSemantics([worked])).toEqual([
      expect.objectContaining({ field: 'assistancePlan' }),
    ]);
    expect(stripEmptyOutlineSemantics(worked)).toBe(worked);
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'transition', assistancePlan: PLAN })]),
    ).toEqual([expect.objectContaining({ field: 'assistancePlan' })]);
  });

  it('enforces the opening visual: planned, or omitted with a specific reason (RSS 7.5.7)', () => {
    const opening = (visualPlan?: unknown) =>
      slide({
        slideType: 'cover',
        contentRole: 'orientation',
        ...(visualPlan ? { visualPlan } : {}),
      });
    const field = [expect.objectContaining({ field: 'visualPlan' })];
    expect(validateOutlineSlideSemantics([opening()])).toEqual(field);
    expect(validateOutlineSlideSemantics([opening({ mode: 'omitted' })])).toEqual(field);
    expect(
      validateOutlineSlideSemantics([opening({ mode: 'omitted', omissionReason: 'N/A' })]),
    ).toEqual(field);
    expect(validateOutlineSlideSemantics([opening({ mode: 'collage' })])).toEqual(field);
    for (const plan of [
      { mode: 'image' },
      { mode: 'native' },
      {
        mode: 'omitted',
        omissionReason: 'The lesson is a poem recitation; the text itself is the focus.',
      },
    ]) {
      expect(validateOutlineSlideSemantics([opening(plan)])).toEqual([]);
    }
    // Not required elsewhere, and never kept on a non-slide outline.
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'content', contentRole: 'example' })]),
    ).toEqual([]);
    const quiz = { ...opening({ mode: 'image' }), type: 'quiz' } as SceneOutline;
    expect(stripEmptyOutlineSemantics(quiz)).not.toHaveProperty('visualPlan');
  });

  it('rejects Teaching Model concepts and layout names as semantic values', () => {
    for (const value of ['g5_teaching_card', 'outcome_teaching_cards', 'lesson_introduction']) {
      expect(
        validateOutlineSlideSemantics([slide({ slideType: 'content', contentRole: value })]),
      ).toEqual([expect.objectContaining({ field: 'contentRole' })]);
    }
    expect(
      validateOutlineSlideSemantics([slide({ slideType: 'two_column', contentRole: 'example' })]),
    ).toEqual([expect.objectContaining({ field: 'slideType' })]);
  });

  it('allows at most one cover and one end per lesson', () => {
    const issues = validateOutlineSlideSemantics([
      slide({ slideType: 'cover', contentRole: 'orientation', visualPlan: NATIVE }),
      slide({ slideType: 'cover', contentRole: 'orientation', visualPlan: NATIVE }),
      slide({ slideType: 'end', contentRole: 'summary' }),
      slide({ slideType: 'end', contentRole: 'summary' }),
    ]);
    expect(issues.map((issue) => [issue.index, issue.field])).toEqual([
      [1, 'slideType'],
      [3, 'slideType'],
    ]);
  });

  it('does not judge quiz, interactive, or pbl outlines', () => {
    const outlines = (['quiz', 'interactive', 'pbl'] as const).map(
      (type) => ({ ...slide({}), type }) as SceneOutline,
    );
    expect(validateOutlineSlideSemantics(outlines)).toEqual([]);
  });

  it('formats a bounded, prefixed failure message', () => {
    const issues = validateOutlineSlideSemantics(Array.from({ length: 4 }, () => slide({})));
    const message = formatOutlineSemanticsIssues(issues);
    expect(message.startsWith(`${OUTLINE_SLIDE_SEMANTICS_ERROR}: 8 slide classification`)).toBe(
      true,
    );
    expect(message).toContain('(+3 more)');
  });
});

describe('stripEmptyOutlineSemantics', () => {
  it('drops stray semantics from a non-slide outline without touching its type', () => {
    const quiz = {
      ...slide({ slideType: 'content', contentRole: 'check_understanding' }),
      type: 'quiz',
    } as SceneOutline;
    const stripped = stripEmptyOutlineSemantics(quiz);
    expect(stripped.type).toBe('quiz');
    expect(stripped).not.toHaveProperty('slideType');
    expect(stripped).not.toHaveProperty('contentRole');
    expect(stripEmptyOutlineSemantics({ ...quiz, assistancePlan: PLAN })).not.toHaveProperty(
      'assistancePlan',
    );
    expect(quiz.contentRole).toBe('check_understanding'); // input untouched
  });

  it('drops a null contentKind on a slide and never alters a real value', () => {
    const withNull = slide({ slideType: 'content', contentRole: 'example', contentKind: null });
    expect(stripEmptyOutlineSemantics(withNull)).not.toHaveProperty('contentKind');

    const classified = slide({
      slideType: 'content',
      contentRole: 'example',
      contentKind: 'concept',
    });
    // An invalid pairing is left intact for the validator to reject.
    expect(stripEmptyOutlineSemantics(classified)).toBe(classified);
  });
});

describe('outline prompt — slide classification contract', () => {
  const plain = buildOutlinePrompt({ requirement: 'Teach photosynthesis' });
  const flow = buildOutlinePrompt(
    { requirement: 'Teach photosynthesis' },
    { teachingFlow: [{ stage: 'lesson_introduction', instructions: 'Open the lesson' }] },
  );

  it('asks for the three fields explicitly, in both prompts', () => {
    for (const text of [plain.system, plain.user]) {
      expect(text).toContain('slideType');
      expect(text).toContain('contentRole');
      expect(text).toContain('contentKind');
    }
  });

  it('names every role, kind and slide type of the shared contract', () => {
    for (const role of SLIDE_CONTENT_ROLES) {
      expect(plain.system).toContain(`\`${role}\``);
      for (const kind of SLIDE_CONTENT_KINDS_BY_ROLE[role])
        expect(plain.system).toContain(`\`${kind}\``);
    }
    for (const slideType of OUTLINE_SLIDE_TYPES) expect(plain.system).toContain(`\`${slideType}\``);
  });

  it('plans the opening as one cover + orientation slide holding the objectives', () => {
    expect(plain.system).toContain(
      '`"type": "slide"`, `"slideType": "cover"`, `"contentRole": "orientation"`',
    );
    expect(plain.system).toContain('Do **NOT** plan a separate learning-objectives slide');
    expect(plain.system).toContain('Do **NOT** generate one for a normal single lesson');
  });

  it('keeps quiz, interactive and pbl as first-class scene choices', () => {
    expect(plain.system).toContain('**captured and checked**, graded, or retried → `quiz`');
    // No budget, missing config or unavailable feature may turn a runtime scene into a slide.
    expect(plain.system).toContain('A scene that needs a runtime KEEPS that runtime.');
    expect(plain.system).not.toContain('Limit to **1-2 interactive scenes');
    const limited = buildOutlinePrompt(
      { requirement: 'Teach fractions' },
      { availableRuntimes: { pbl: false } },
    );
    expect(limited.system).toContain('`pbl` scenes cannot be delivered');
    expect(plain.system).not.toContain('cannot be delivered');
    expect(plain.system).toContain('→ `interactive`');
    expect(plain.system).toContain('→ `pbl`');
    expect(plain.system).toContain('### Interactive Scene Guidelines');
    expect(plain.system).toContain('### PBL Scene Guidelines');
  });

  it('introduces no curriculum- or Teaching-Model-specific semantic value', () => {
    for (const text of [plain.system, plain.user]) {
      expect(text).not.toContain('g5_teaching_card');
      expect(text).not.toContain('outcome_teaching_cards');
      expect(text).not.toContain('outcome_worked_examples');
    }
    // A stage key reaches the prompt only as caller-supplied flow data.
    expect(plain.system).not.toContain('lesson_introduction');
  });

  it('leaves Teaching Model Flow authority intact and subordinate-proof', () => {
    expect(flow.system).toContain('## Authoritative Teaching Model Flow (MANDATORY)');
    expect(flow.system).toContain('a stage key is context, never a value of');
    expect(plain.system).not.toContain('Teaching Model Flow decides which positions exist');
    expect(flow.system).not.toContain('{{');
  });
});
