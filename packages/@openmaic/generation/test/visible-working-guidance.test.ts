import { describe, expect, it } from 'vitest';
import { buildSlideRoleContext, hiddenStepCatalogue } from '@openmaic/generation';

// g5.v8 (teacher-parity plan I-2): the visible-working rule reaches a solving
// slide only when the caller asks for it; every other guidance is unchanged.
describe('visible-working role guidance', () => {
  const workedExample = { slideType: 'content', contentRole: 'worked_example' } as const;

  it('is absent unless the caller asks, so earlier flows are byte-identical', () => {
    const plain = buildSlideRoleContext(workedExample);
    expect(plain.roleGuidance).not.toContain('Visible working');
    expect(buildSlideRoleContext(workedExample, {}).roleGuidance).toBe(plain.roleGuidance);
    expect(buildSlideRoleContext(workedExample, { visibleWorkingSteps: false }).roleGuidance).toBe(
      plain.roleGuidance,
    );
  });

  it('tells a g5.v8 solution to answer every item, never refuse (lesson 316)', () => {
    const guided = buildSlideRoleContext(workedExample, { visibleWorkingSteps: true });
    expect(guided.roleGuidance).toContain('**Solve every item (mandatory).**');
    // E-8: a composed model answer never cites sacred text.
    expect(guided.roleGuidance).toContain('a composed example is never a Quran verse or hadith');
    expect(guided.roleGuidance).toContain('never send the learner to the book');
    expect(buildSlideRoleContext(workedExample).roleGuidance).not.toContain('Solve every item');
  });

  it('adds the rule and the hidden-step catalogue to a worked example', () => {
    const guided = buildSlideRoleContext(workedExample, { visibleWorkingSteps: true });
    expect(guided.roleGuidance).toContain(
      'Write every hidden step from the plan as a visible line on the canvas',
    );
    expect(guided.roleGuidance).toContain(hiddenStepCatalogue());
    expect(hiddenStepCatalogue()).toContain('`ordered_named_set`');
  });

  it('never reaches a try-it slide, which keeps its answer hidden', () => {
    const check = { slideType: 'content', contentRole: 'check_understanding' } as const;
    expect(buildSlideRoleContext(check, { visibleWorkingSteps: true }).roleGuidance).toBe(
      buildSlideRoleContext(check).roleGuidance,
    );
  });
});
