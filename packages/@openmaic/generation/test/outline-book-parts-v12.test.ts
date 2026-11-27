/**
 * g5.v12 (critical items 27 Nov 2026, Wave 2: W2.5, MI-4, MI-5): the book-part outline
 * prompt. Every other caller's prompt is byte-identical (the golden tests pin it).
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildOutlinePrompt, sharedFlowBodies } from '../src/outline-generator.js';
import { loadSnippet, processConditionalBlocks } from '../src/prompts/loader.js';

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
    }
    // The backend's g5.v12 opener (MI-6): title, what the lesson teaches today, at most
    // one recall; no hook, no objectives list, no invented big idea.
    expect(v12.user).toContain('one sentence saying what the lesson teaches today');
    expect(v12.user).toContain("never tells an opening story or the book's hook question");
    expect(v12.user).toContain('never invents a big idea the book does not print');
    expect(v12.user).not.toContain('a hook and a short context');
    expect(v12.system).toContain('(no hook, no learning-objectives list, no invented big idea)');
    // The shared classification contract keeps its opening list for every caller (the
    // host templates load it with no variable defaults); v12 alone adds the override.
    const override = 'the opening list above is replaced';
    expect(v12.system).toContain('- the big idea / key framing message');
    expect(v12.system).toContain(
      `${override}: the opening is one short intro slide holding the lesson title`,
    );
    expect(v12.system).toContain("the book's own «الفكرة الرئيسة» as the book prints it");
    expect(v12.system).toContain('never invents a big idea the book does not print');
    expect(other.system).not.toContain(override);
  });

  it('fresh review HIGH 1: the contract rendered with no variables (the host loader) keeps both opener lines', () => {
    const contract = processConditionalBlocks(loadSnippet('slide-classification-contract'), {});
    expect(contract).toContain('- concise learning objectives\n');
    expect(contract).toContain('- the big idea / key framing message\n');
    expect(contract).not.toContain('the opening list above is replaced');
    expect(contract).not.toContain("A check's ONE solution slide");
    // Byte-identical to 693e2d42's contract rendered the same way (sha256 : length).
    const pin = `${createHash('sha256').update(contract).digest('hex')}:${contract.length}`;
    expect(pin).toBe('1ef6bebb9844c531ab1fa23eb1e8d88cec15be53fe2199a131eeb009e7a18dfe:15150');
  });

  it('W2.5 (contract): on v12 the role table and the orientation line follow the backend opener', () => {
    const v12 = prompt(true).system;
    const other = prompt().system;
    const clauses = [
      'the big idea (on this lesson: the title, what the lesson teaches today and at most one recall — no hook, no objectives list, no invented big idea)',
      'its key points are the lesson title, one sentence saying what the lesson teaches today and, only when a unit states it, a one-line recall of the one earlier idea the lesson needs — never a hook, an objectives list or an invented big idea — and it plans one simple visual.',
    ];
    for (const clause of clauses) {
      expect(v12).toContain(clause);
      expect(other).not.toContain(clause);
    }
    // Re-review NIT-a / NIT-b: the objectives-slide rule and the main-idea unit note.
    const objectivesNote = 'On this lesson the orientation slide lists no objectives.';
    expect(v12).toContain(objectivesNote);
    expect(other).not.toContain(objectivesNote);
    const unitNote =
      "citing its unit (the lesson's first part still teaches that unit where the book prints it)";
    expect(v12).toContain(unitNote);
    expect(prompt(true).user).toContain(unitNote);
    expect(other).not.toContain(unitNote);
    // No v12 clause asks for a hook or a framing context.
    expect(v12).not.toContain('tied to the hook or the context');
    expect(v12).not.toContain('the hook and the short context only');
  });

  it('W2.5 (example): the v12 example opener is the title and what the lesson teaches today', () => {
    const v12 = prompt(true).system;
    const other = prompt().system;
    const standard =
      '"keyPoints": ["Framing question", "Why it matters", "Learning objectives", "Big idea"],';
    expect(other).toContain(standard);
    expect(v12).not.toContain(standard);
    expect(v12).toContain('"keyPoints": ["Lesson title", "What this lesson teaches today"],');
    expect(v12).not.toContain('a framing question');
    expect(v12).not.toContain('brief context, the learning objectives and the big idea.');
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
