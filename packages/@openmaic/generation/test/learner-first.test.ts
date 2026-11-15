import { describe, expect, it } from 'vitest';

import type { AICallFn, PPTElement } from '@openmaic/generation';
import {
  LATIN_LETTER_READINGS,
  canvasKeyPoints,
  generateSceneActions,
  learnerFirstNarrationRules,
  learnerFirstSlideRules,
} from '@openmaic/generation';
import { buildPrompt, PROMPT_IDS } from '../src/prompts/index.js';
import {
  AVERAGE_CHANGE_STEP,
  buildSlideNarrationRoleContext,
  buildSlideRoleContext,
  hiddenStepCatalogue,
  learnerFirstHiddenStepCatalogue,
} from '../src/slide-role-guidance.js';

describe('g5.v10 learner-first role guidance (W3)', () => {
  const solution = { contentRole: 'worked_example' } as never;

  it('drops the invented average-change method from the canvas guidance only on g5.v10', () => {
    const v8 = buildSlideRoleContext(solution, { visibleWorkingSteps: true }).roleGuidance ?? '';
    const v10 =
      buildSlideRoleContext(solution, { visibleWorkingSteps: true, learnerFirst: true })
        .roleGuidance ?? '';
    expect(v8).toContain('an average change');
    expect(v8).toContain(AVERAGE_CHANGE_STEP);
    expect(v10).not.toContain('an average change');
    expect(v10).not.toContain(AVERAGE_CHANGE_STEP);
    expect(v10).toContain('Use only the methods the textbook source uses.');
    expect(hiddenStepCatalogue()).toContain(AVERAGE_CHANGE_STEP);
    expect(learnerFirstHiddenStepCatalogue()).not.toContain(AVERAGE_CHANGE_STEP);
  });

  it("makes a solution slide's narration work every item only on g5.v10", () => {
    const v8 = buildSlideNarrationRoleContext(solution).roleGuidance ?? '';
    const v10 = buildSlideNarrationRoleContext(solution, { learnerFirst: true }).roleGuidance ?? '';
    expect(v8).toContain('Work the problem step by step');
    expect(v10).toContain('Work EVERY item this slide shows');
    expect(v10).not.toContain('Work the problem step by step');
  });
});
import { slideOutline } from './scene-fixtures.js';

/**
 * g5.v10 (learner-first plan W2/W3, owner decisions of 15 Nov 2026): the narration and
 * canvas rules reach a prompt only when `learnerFirst` is set; every other run renders
 * byte-identically (D-9 B).
 */

const ELEMENTS = [
  { id: 'title', type: 'text', content: '<p><strong>حل تحقق ٢</strong></p>' },
  { id: 'a', type: 'text', content: '<p>٢أ: ٢ + ٤ = ٦ عدد زوجي</p>' },
  { id: 'b', type: 'text', content: '<p>٢ب: AB = CD و CD = EF إذن AB = EF</p>' },
  {
    id: 'f',
    type: 'latex',
    latex: '1^2+2^2=1+4=5,\\quad 2^2+3^2=4+9=13 \\text{ (odd in both examples)}',
  },
] as unknown as PPTElement[];

const CONTENT = { elements: ELEMENTS, background: { type: 'solid' as const, color: '#fff' } };

function capture(): { call: AICallFn; prompts: Array<{ system: string; user: string }> } {
  const prompts: Array<{ system: string; user: string }> = [];
  const call: AICallFn = async (system, user) => {
    prompts.push({ system, user });
    return JSON.stringify([{ type: 'text', content: 'نشرح البنود.' }]);
  };
  return { call, prompts };
}

describe('g5.v10 learner-first prompts', () => {
  it('leaves the slide-actions and slide-content templates byte-identical without the flag', () => {
    const vars = { title: 'T', keyPoints: '1. K', description: 'D', elements: 'E' };
    const plain = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, vars)!;
    const off = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      ...vars,
      hasLearnerFirstNarration: false,
    })!;
    expect(off.user).toBe(plain.user);
    expect(plain.user).not.toContain('Narration rules for this lesson');
    const content = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, vars)!;
    expect(content.user).not.toContain('Slide rules for this lesson');
  });

  it('renders the rules under their own headings when set', () => {
    const vars = { title: 'T', keyPoints: '1. K', description: 'D', elements: 'E' };
    const actions = buildPrompt(PROMPT_IDS.SLIDE_ACTIONS, {
      ...vars,
      hasLearnerFirstNarration: true,
      learnerFirstNarrationRules: learnerFirstNarrationRules(),
    })!;
    expect(actions.user).toContain('Narration rules for this lesson');
    expect(actions.user).toContain('Explain EVERY item the slide shows');
    const content = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, {
      ...vars,
      hasLearnerFirstSlide: true,
      learnerFirstSlideRules: learnerFirstSlideRules(),
    })!;
    expect(content.user).toContain('Slide rules for this lesson');
    expect(content.user).toContain('«التخمين:»');
  });

  it('states every owner rule in the narration and slide rules', () => {
    const narration = learnerFirstNarrationRules();
    expect(narration).toContain('spotlight its element id');
    expect(narration).toContain('Never say "right" where the slide says "left"');
    expect(narration).toContain('A/a = «إيه»');
    expect(narration).toContain('«المتغير إن»');
    expect(narration).toContain('Never describe colours, line styles or positions');
    expect(narration).toContain('say the claim itself in full');
    const slide = learnerFirstSlideRules();
    expect(slide).toContain('«(س٣٥ في كتابك)»');
    expect(slide).toContain('definition box');
    expect(slide).toContain('average rate of change');
    expect(slide).toContain('states what is expected next');
  });

  it('reads Latin letters by their English names (D-3 A)', () => {
    expect(LATIN_LETTER_READINGS.A).toBe('إيه');
    expect(LATIN_LETTER_READINGS.J).toBe('جيه');
    expect(LATIN_LETTER_READINGS.N).toBe('إن');
    expect(LATIN_LETTER_READINGS.X).toBe('إكس');
    expect(Object.keys(LATIN_LETTER_READINGS)).toHaveLength(26);
  });
});

describe('g5.v10 learner-first narration call', () => {
  it('keeps the planner key points, the 30-character formula cut and no rules without the flag', async () => {
    const { call, prompts } = capture();
    await generateSceneActions(slideOutline(), CONTENT, call, {});
    const user = prompts[0]!.user;
    expect(user).toContain('Caller owns dependencies');
    expect(user).toContain('Formula: 1^2+2^2=1+4=5,\\quad 2^2+3');
    expect(user).not.toContain('(odd in both examples)');
    expect(user).not.toContain('Narration rules for this lesson');
  });

  it('reads the canvas as key points, sees every formula whole and gets the rules', async () => {
    const { call, prompts } = capture();
    await generateSceneActions(slideOutline(), CONTENT, call, { learnerFirst: true });
    const user = prompts[0]!.user;
    expect(user).not.toContain('Caller owns dependencies');
    expect(user).toContain('٢ب: AB = CD و CD = EF إذن AB = EF');
    expect(user).toContain('(odd in both examples)');
    expect(user).toContain('Narration rules for this lesson');
  });

  it('turns the canvas into ordered key points (text, shape, table and LaTeX)', () => {
    expect(canvasKeyPoints(ELEMENTS)).toEqual([
      'حل تحقق ٢',
      '٢أ: ٢ + ٤ = ٦ عدد زوجي',
      '٢ب: AB = CD و CD = EF إذن AB = EF',
      '1^2+2^2=1+4=5,\\quad 2^2+3^2=4+9=13 \\text{ (odd in both examples)}',
    ]);
  });
});
