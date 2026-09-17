import { describe, expect, it } from 'vitest';

import { buildOutlinePrompt, type TeachingFlowEntry } from '@openmaic/generation';

const POLICY_FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'Introduce the whole item once.',
    skillPolicy: {
      required: [],
      preferred: [{ skillId: 'social-emotional-learning', version: 'v1' }],
      allowed: [
        { skillId: 'social-emotional-learning', version: 'v1' },
        { skillId: 'lecture-style', version: 'v1' },
      ],
      combinationRestrictions: [],
    },
  },
  {
    stage: 'outcome_teaching_cards',
    instructions: 'Teach objective 1 with cards.',
    skillPolicy: {
      required: [
        {
          skill: { skillId: 'feynman-learning', version: 'v1' },
          scope: 'flow_position',
          role: 'primary',
        },
      ],
      preferred: [],
      allowed: [
        { skillId: 'feynman-learning', version: 'v1' },
        { skillId: 'learning-to-learn', version: 'v1' },
      ],
      combinationRestrictions: [
        {
          skillA: { skillId: 'feynman-learning', version: 'v1' },
          skillB: { skillId: 'learning-to-learn', version: 'v1' },
        },
      ],
    },
  },
];

describe('requirements-to-outlines skill-policy conditional block', () => {
  it('renders the authority block, policy table, and teachingSkills output contract when governed', () => {
    const { system, user } = buildOutlinePrompt(
      { requirement: 'Teach photosynthesis' },
      { teachingFlow: POLICY_FLOW, skillPolicy: true },
    );

    // The authority declaration — Flow/instructions → Primary → Supporting →
    // global defaults, with the conflicting-default clause (BR-TS-015/016/017).
    expect(system).toContain('Teaching Skill Policy — Selection Authority');
    expect(system).toContain("then the outline's Primary Teaching Skill");
    expect(system).toContain('selected Skill wins');
    expect(system).toContain('Teaching Style | Interactive (engaging)');
    expect(system).toContain('never yield to a Skill');

    // The per-position permitted-Skills table, exactly as received.
    expect(system).toContain(
      '0. stage="lesson_introduction" | required: none | preferred: social-emotional-learning@v1 | allowed: social-emotional-learning@v1, lecture-style@v1 | prohibited-to-combine: none',
    );
    expect(system).toContain('(scope=flow_position, role=primary)');
    expect(system).toContain('prohibited-to-combine: (feynman-learning@v1 + learning-to-learn@v1)');

    // The selection contract: exactly one permitted primary + intentional
    // supporting, required honored as scoped, preferred never binding,
    // classification by purpose — never by type, never by Skill absence.
    expect(system).toContain('exactly one `primary`');
    expect(system).toContain('**Preferred** Skills guide selection but never bind');
    expect(system).toContain('Scene type alone never determines it');
    expect(system).toContain('the absence of a Skill never creates it');

    // The output schema: field-table row, example carriers, closing reminder.
    expect(system).toContain('| teachingSkills    | object');
    expect(system).toContain(
      '"teachingSkills": { "classification": "instructional", "primary": { "skillId": "feynman-learning", "version": "v1" } }',
    );
    expect(system.slice(-1400)).toContain('**Teaching Skills on every outline:**');

    // The user prompt carries the same contract.
    expect(user).toContain('### Teaching Skill Selection');
    expect(user).toContain('MUST carry `teachingSkills`');
    expect(user).toContain('never by scene type, never by Skill absence');
  });

  it('renders byte-identical prompts without the flag, and explicit false behaves exactly like absent', () => {
    const without = buildOutlinePrompt({ requirement: 'Teach photosynthesis' }, {});
    const explicitFalse = buildOutlinePrompt(
      { requirement: 'Teach photosynthesis' },
      { teachingFlow: POLICY_FLOW, skillPolicy: false },
    );
    // Policy data riding the flow entries alone is NOT governance: with the
    // flag absent, the rendering is byte-identical to the same flow carrying
    // NO policies at all (mode is declared, never inferred — §M).
    const flowWithoutPolicies: TeachingFlowEntry[] = POLICY_FLOW.map(({ stage, instructions }) => ({
      stage,
      instructions,
    }));
    const dataWithoutFlag = buildOutlinePrompt(
      { requirement: 'Teach photosynthesis' },
      { teachingFlow: POLICY_FLOW },
    );
    const flowOnly = buildOutlinePrompt(
      { requirement: 'Teach photosynthesis' },
      { teachingFlow: flowWithoutPolicies },
    );

    expect(without.system).not.toContain('Teaching Skill Policy');
    expect(without.system).not.toContain('teachingSkills');
    expect(without.user).not.toContain('Teaching Skill Selection');
    expect(dataWithoutFlag.system).toBe(flowOnly.system);
    expect(dataWithoutFlag.user).toBe(flowOnly.user);
    expect(explicitFalse.system).toBe(dataWithoutFlag.system);
    expect(explicitFalse.user).toBe(dataWithoutFlag.user);

    // No skill-policy variables leak into the rendered text.
    expect(without.system).not.toContain('skillPolicyText');
    expect(without.system).not.toContain('hasSkillPolicy');
  });

  it('composes with the teaching-flow and grounding blocks without losing any of the three contracts', () => {
    const { system, user } = buildOutlinePrompt(
      { requirement: 'Teach photosynthesis' },
      { teachingFlow: POLICY_FLOW, normalizedGrounding: true, skillPolicy: true },
    );

    // All three authority sections render, in order, each with its contract.
    const flowAt = system.indexOf('## Authoritative Teaching Model Flow');
    const groundingAt = system.indexOf('## Authoritative Source Grounding');
    const skillsAt = system.indexOf('## Teaching Skill Policy — Selection Authority');
    expect(flowAt).toBeGreaterThanOrEqual(0);
    expect(groundingAt).toBeGreaterThan(flowAt);
    expect(skillsAt).toBeGreaterThan(groundingAt);

    expect(system).toContain('`teachingStage`');
    expect(system).toContain('`sourceContentUnitIds`');
    expect(system).toContain('| teachingSkills    | object');

    // All three example carriers coexist on one outline without comma damage.
    expect(system).toContain('"sourceContentUnitIds": ["2900"]');
    expect(
      system.split('\n').filter((line) => line.trim().startsWith('"teachingSkills"')).length,
    ).toBeGreaterThanOrEqual(2);

    expect(user).toContain('### Authoritative Teaching Model Flow');
    expect(user).toContain('### Authoritative Source Grounding');
    expect(user).toContain('### Teaching Skill Selection');
  });
});
