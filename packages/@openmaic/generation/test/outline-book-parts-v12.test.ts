/**
 * g5.v12 (critical items 27 Nov 2026, Wave 2: W2.5, MI-4, MI-5): the book-part outline
 * prompt. Every other caller's prompt is byte-identical (the golden tests pin it).
 */
import { describe, expect, it } from 'vitest';

import { buildOutlinePrompt, sharedFlowBodies } from '../src/outline-generator.js';

const BODY = 'Teach every unit of this objective block in book order, one idea per slide.';
const FLOW = [
  { stage: 'lesson_opener', instructions: 'Open the lesson.' },
  {
    stage: 'outcome_visual_explanations',
    instructions: `For Learning Objective 7001: 'Explain matter.'. ${BODY}`,
  },
  { stage: 'outcome_check_understanding', instructions: 'Check objective 1.' },
  {
    stage: 'outcome_visual_explanations',
    instructions: `For Learning Objective 7002: 'Explain change.'. ${BODY}`,
  },
  { stage: 'outcome_check_understanding', instructions: 'Check objective 2.' },
];

const prompt = (bookPartPlacement?: boolean) =>
  buildOutlinePrompt(
    { requirement: 'Teach the lesson' },
    {
      researchContext: '',
      teacherContext: '',
      teachingFlow: FLOW as never,
      ...(bookPartPlacement === undefined ? {} : { bookPartPlacement }),
    },
  );

describe('g5.v12 outline prompt', () => {
  it('W2.5: the opener lists no objectives and no big idea; other callers keep both', () => {
    const v12 = prompt(true);
    const other = prompt();
    expect(prompt(false)).toEqual(other);
    expect(other.user).toContain('concise learning objectives and the big idea together');
    expect(other.system).toContain('`orientation` slide that includes the learning objectives');
    expect(other.system).toContain('- the big idea / key framing message');
    for (const text of [v12.user, v12.system]) {
      expect(text).not.toContain('concise learning objectives and the big idea together');
      expect(text).not.toContain('`orientation` slide that includes the learning objectives');
      expect(text).not.toContain('- the big idea / key framing message');
      expect(text).not.toContain('- concise learning objectives\n');
    }
    expect(v12.user).toContain('It lists no learning objectives and states no big idea');
    expect(v12.system).toContain('(no learning-objectives list, no big idea)');
  });

  it('MI-5: a check’s single multi-item solution slide is a worked_example, on v12 only', () => {
    expect(prompt(true).system).toContain(
      "A check's ONE solution slide that solves every item of that check together",
    );
    expect(prompt().system).not.toContain("A check's ONE solution slide");
  });

  it('MI-4: a body several objective positions share is sent once', () => {
    const v12 = prompt(true);
    const count = (text: string) => text.split(BODY).length - 1;
    expect(count(prompt().system)).toBe(2);
    expect(count(v12.system)).toBe(1);
    expect(count(v12.user)).toBe(1);
    expect(v12.system).toContain('SHARED INSTRUCTIONS S1 (flow positions 1, 3)');
    expect(v12.system).toContain(
      "For Learning Objective 7001: 'Explain matter.'. Then follow the shared instructions S1 below.",
    );
  });

  it('MI-3: the subject Skill body is sent above the flow, only when given', () => {
    const withSkill = buildOutlinePrompt(
      { requirement: 'Teach the lesson' },
      {
        researchContext: '',
        teacherContext: '',
        teachingFlow: FLOW as never,
        bookPartPlacement: true,
        subjectSkillText: '# Physics conceptual teaching\nStart from the phenomenon.',
      },
    );
    const skillAt = withSkill.system.indexOf('Start from the phenomenon.');
    expect(skillAt).toBeGreaterThan(-1);
    expect(skillAt).toBeLessThan(withSkill.system.indexOf('## Authoritative Teaching Model Flow'));
    expect(prompt(true).system).not.toContain("## The subject's Teaching Skill");
    expect(prompt().system).not.toContain("## The subject's Teaching Skill");
  });

  it('sharedFlowBodies leaves a flow with no shared body unchanged', () => {
    expect(sharedFlowBodies(['Open.', "For Learning Objective 1: 'a'. Only mine."])).toBeNull();
  });
});
