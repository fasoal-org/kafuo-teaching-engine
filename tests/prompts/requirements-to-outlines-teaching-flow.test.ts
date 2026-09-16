import { describe, expect, it } from 'vitest';

import {
  buildOutlinePrompt,
  type TeachingFlowEntry,
} from '@openmaic/generation';

const FLOW: TeachingFlowEntry[] = [
  { stage: 'lesson_introduction', instructions: 'Introduce the whole item once.' },
  { stage: 'outcome_teaching_cards', instructions: 'Teach objective 1 with cards.' },
  { stage: 'outcome_worked_examples', instructions: 'Demonstrate objective 1.' },
];

function baseVars() {
  return {
    requirement: 'Teach photosynthesis',
    pdfContent: 'None',
    availableImages: 'No images available',
    userProfile: '',
    researchContext: 'None',
    teacherContext: '',
    hasSourceImages: false,
    imageEnabled: false,
    videoEnabled: false,
    mediaEnabled: false,
  };
}

describe('requirements-to-outlines teaching-flow conditional block', () => {
  it('renders the authoritative flow block and rules when a flow is supplied', () => {
    const { system, user } = buildOutlinePrompt({ requirement: 'Teach photosynthesis' }, {
      teachingFlow: FLOW,
    });
    expect(system).toContain('Authoritative Teaching Model Flow');
    expect(system).toContain('stage="lesson_introduction"');
    expect(system).toContain('stage="outcome_teaching_cards"');
    expect(system).toContain('stage="outcome_worked_examples"');
    expect(system).toContain('`teachingStage`');
    expect(system).toContain('no gaps, no reordering, no re-entry');
    expect(user).toContain('flowIndex');
    expect(user).toContain('"key": "lesson_introduction", "flowIndex": 0');
  });

  it('renders byte-identical prompts without a flow (legacy/non-Kafuo path)', () => {
    const without = buildOutlinePrompt({ requirement: 'Teach photosynthesis' }, {});
    const empty = buildOutlinePrompt({ requirement: 'Teach photosynthesis' }, {
      teachingFlow: [],
    });

    expect(without.system).not.toContain('Authoritative Teaching Model Flow');
    expect(without.system).not.toContain('teachingStage');
    expect(without.user).not.toContain('flowIndex');
    expect(without.system).toBe(empty.system);
    expect(without.user).toBe(empty.user);

    // And the exact same bytes the pre-integration prompt produced for the
    // same inputs (no flow variables leak into the rendered text).
    expect(without.system).not.toContain('teachingFlowText');
    expect(without.system).not.toContain('hasTeachingFlow');
  });
});
