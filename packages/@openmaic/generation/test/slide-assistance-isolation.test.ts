/**
 * T-06 / T-07 — structural isolation of hidden assistance and planner prose.
 *
 * A marker placed in `assistancePlan` must reach the assistance-authoring
 * prompt and NO canvas prompt, narration prompt, canvas element or speech text.
 * A marker placed in the planner's `description` may reach the planning
 * channel of a prompt but never becomes display text or fallback narration.
 */
import { describe, expect, it } from 'vitest';
import {
  SLIDE_ROLE_VARIANTS,
  buildSlideNarrationRoleContext,
  buildSlideRoleContext,
  explanationLeakedOntoCanvas,
  findInternalLeaks,
  generateSceneActions,
  generateSceneContent,
  sanitizeAssistanceHtml,
  type GeneratedSlideContent,
  type SceneOutline,
} from '@openmaic/generation';

const PLAN_HINT = 'ZQX-HINT-SENTINEL';
const PLAN_HELP = 'ZQX-HELP-SENTINEL';
const PLAN_EXPLANATION = 'ZQX-EXPLANATION-SENTINEL';
const DESCRIPTION = 'ZQX-PLANNER-DESCRIPTION-SENTINEL';

const outline: SceneOutline = {
  id: 'scene_1',
  type: 'slide',
  title: 'Find the speed',
  description: DESCRIPTION,
  keyPoints: ['A car travels 180 km in 3 hours. Find its average speed.'],
  order: 2,
  slideType: 'content',
  contentRole: 'practice',
  contentKind: 'independent',
  assistancePlan: { hint: PLAN_HINT, help: PLAN_HELP, explanation: PLAN_EXPLANATION },
};

const CANVAS = JSON.stringify({
  elements: [
    {
      type: 'text',
      left: 60,
      top: 60,
      width: 880,
      height: 76,
      content: '<p>A car travels 180 km in 3 hours. Find its average speed.</p>',
    },
  ],
});
const ASSISTANCE = JSON.stringify({
  hint: '<p onclick="x()">Look at the <strong>units</strong>.</p><script>alert(1)</script>',
  help: '<p>Speed relates distance and time.</p>',
  explanation: '<p>Divide 180 by 3 to get 60 km/h.</p>',
});

type Call = { system: string; user: string };
const isAssistanceCall = (call: Call) => call.system.includes('Slide Assistance Author');

async function generate(target: SceneOutline = outline) {
  const calls: Call[] = [];
  const aiCall = async (system: string, user: string) => {
    calls.push({ system, user });
    return system.includes('Slide Assistance Author') ? ASSISTANCE : CANVAS;
  };
  const content = (await generateSceneContent(target, aiCall)) as GeneratedSlideContent | null;
  return { calls, content };
}

describe('hidden assistance is structurally isolated (T-06)', () => {
  it('feeds the plan to the assistance step only — never to the canvas prompt or the canvas', async () => {
    const { calls, content } = await generate();
    const canvasCalls = calls.filter((call) => !isAssistanceCall(call));
    const assistanceCalls = calls.filter(isAssistanceCall);
    expect(canvasCalls).toHaveLength(1);
    expect(assistanceCalls).toHaveLength(1);

    for (const sentinel of [PLAN_HINT, PLAN_HELP, PLAN_EXPLANATION]) {
      expect(assistanceCalls[0]!.user).toContain(sentinel);
      expect(canvasCalls[0]!.system + canvasCalls[0]!.user).not.toContain(sentinel);
      expect(JSON.stringify(content!.elements)).not.toContain(sentinel);
    }
    // The assistance step sees the task AS RENDERED, not the planner's prose.
    expect(assistanceCalls[0]!.user).toContain('180 km in 3 hours');
    expect(assistanceCalls[0]!.user).not.toContain(DESCRIPTION);
    // Authored assistance is sanitised and sits beside the canvas.
    expect(content!.assistance).toEqual({
      hint: '<p>Look at the <strong>units</strong>.</p>',
      help: '<p>Speed relates distance and time.</p>',
      explanation: '<p>Divide 180 by 3 to get 60 km/h.</p>',
    });
  });

  it('keeps the plan and the authored assistance out of narration', async () => {
    const { content } = await generate();
    const calls: Call[] = [];
    const actions = await generateSceneActions(outline, content!, async (system, user) => {
      calls.push({ system, user });
      return '[]'; // forces the model-free fallback
    });
    const prompt = calls[0]!.system + calls[0]!.user;
    for (const hidden of [PLAN_HINT, PLAN_HELP, PLAN_EXPLANATION, 'Divide 180 by 3']) {
      expect(prompt).not.toContain(hidden);
      expect(JSON.stringify(actions)).not.toContain(hidden);
    }
    // Independent practice narration is told not to reveal the solution.
    expect(calls[0]!.user).toContain('MUST NOT reveal the method');
  });

  it('fails independent practice rather than shipping it without on-demand support', async () => {
    const failures: string[] = [];
    const content = await generateSceneContent(
      outline,
      async (system) => (system.includes('Slide Assistance Author') ? 'not json' : CANVAS),
      { onFailure: (failure) => failures.push(failure.code) },
    );
    expect(content).toBeNull();
    expect(failures).toEqual(['invalid-model-output']);
  });

  it('runs no assistance step when nothing is planned', async () => {
    const { assistancePlan: _plan, ...guided } = { ...outline, contentKind: 'guided' as const };
    const { calls, content } = await generate(guided);
    expect(calls.filter(isAssistanceCall)).toHaveLength(0);
    expect(content).not.toHaveProperty('assistance');
  });
});

describe('planner prose never becomes learner content (T-07)', () => {
  it('renders description and role guidance only inside the planning channel', async () => {
    const { calls } = await generate();
    const user = calls.find((call) => !isAssistanceCall(call))!.user;
    const learner = user.slice(
      user.indexOf('## LEARNER CONTENT'),
      user.indexOf('## PLANNING GUIDANCE'),
    );
    const planning = user.slice(user.indexOf('## PLANNING GUIDANCE'));
    expect(learner).toContain('Find the speed');
    expect(learner).not.toContain(DESCRIPTION);
    expect(planning).toContain(DESCRIPTION);
    expect(planning).toContain('before any solving support is shown');
    // Classification never travels as key:value data, in either channel.
    expect(user).not.toMatch(/contentRole|contentKind|slideType|practice\s*\/\s*independent/);
  });

  it('never uses the planner description as fallback narration or a remark', async () => {
    const { content } = await generate();
    expect(content).not.toHaveProperty('remark');
    const actions = await generateSceneActions(outline, content!, async () => '[]');
    const speech = actions.filter((action) => action.type === 'speech');
    expect(speech).toHaveLength(1);
    expect(JSON.stringify(actions)).not.toContain(DESCRIPTION);
    expect(JSON.stringify(speech)).toContain('180 km in 3 hours');
  });

  it('gives an unclassified (legacy) slide no role guidance, and every approved variant some', () => {
    expect(buildSlideRoleContext({})).toEqual({ hasRoleGuidance: false, roleGuidance: '' });
    expect(SLIDE_ROLE_VARIANTS).toHaveLength(17);
    for (const variant of SLIDE_ROLE_VARIANTS) {
      const [contentRole, contentKind] = variant.split('-') as [never, never];
      const canvas = buildSlideRoleContext({ slideType: 'content', contentRole, contentKind });
      const narration = buildSlideNarrationRoleContext({ contentRole, contentKind });
      expect(canvas.hasRoleGuidance && narration.hasRoleGuidance, variant).toBe(true);
      // Guidance prose never names the internal tokens it was resolved from.
      expect(findInternalLeaks([canvas.roleGuidance, narration.roleGuidance]), variant).toEqual([]);
    }
    expect(buildSlideRoleContext({ slideType: 'transition' }).roleGuidance).toContain(
      'purely structural',
    );
  });
});

describe('defence in depth', () => {
  it('flags internal identifiers and placeholders, never ordinary instructional words', () => {
    expect(findInternalLeaks(['contentRole: practice', 'see {{roleGuidance}}'])).toEqual([
      'contentRole',
      '{{roleGuidance}}',
    ]);
    expect(findInternalLeaks(['A worked_example follows'])).toEqual(['worked_example']);
    expect(
      findInternalLeaks([
        'Worked example: a summary of the practice, then check your understanding',
      ]),
    ).toEqual([]);
  });

  it('detects a full explanation leaked onto the canvas, not a restated task', () => {
    const explanation =
      '<p>First convert the distance into kilometres. Then divide the distance by the time taken. The result is sixty kilometres per hour.</p>';
    expect(
      explanationLeakedOntoCanvas(
        explanation,
        'First convert the distance into kilometres. Then divide the distance by the time taken.',
      ),
    ).toBe(true);
    expect(explanationLeakedOntoCanvas(explanation, 'A car travels 180 km in 3 hours.')).toBe(
      false,
    );
  });

  it('reduces assistance HTML to the allowed formatting tags', () => {
    expect(sanitizeAssistanceHtml('<div style="x"><p class="a">Hi<img src=x></p></div>')).toBe(
      '<p>Hi</p>',
    );
  });
});
