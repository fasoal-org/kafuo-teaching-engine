/**
 * The typed boundary that keeps a slide's hidden assistance plan out of every
 * display generator's inputs.
 */
import { describe, expect, it } from 'vitest';
import {
  toAssistancePlan,
  toPlannerGuidance,
  toVisibleSlideInput,
  type PlannerGuidance,
  type SceneOutline,
  type VisibleSlideInput,
} from '@openmaic/generation';

const SENTINEL = 'SOLUTION-PATH-SENTINEL';
const outline: SceneOutline = {
  id: 'scene_1',
  type: 'slide',
  title: 'Try it yourself',
  description: 'Independent practice on unit rates',
  keyPoints: ['A car travels 180 km in 3 hours. Find its speed.'],
  order: 1,
  slideType: 'content',
  contentRole: 'practice',
  contentKind: 'independent',
  assistancePlan: { hint: `${SENTINEL} hint`, explanation: `${SENTINEL} explanation` },
};

describe('slide generation inputs', () => {
  it('keeps the assistance plan out of both display-side inputs', () => {
    const visible = toVisibleSlideInput(outline);
    const guidance = toPlannerGuidance(outline);
    expect(visible).toEqual({ title: outline.title, keyPoints: outline.keyPoints });
    expect(guidance).toMatchObject({ contentRole: 'practice', contentKind: 'independent' });
    expect(JSON.stringify([visible, guidance])).not.toContain(SENTINEL);
    expect(toAssistancePlan(outline)).toEqual(outline.assistancePlan);
  });

  it('refuses a whole outline where a display input is expected (compile-time)', () => {
    // @ts-expect-error a SceneOutline carries `assistancePlan`; display inputs declare it `never`
    const visible: VisibleSlideInput = outline;
    // @ts-expect-error same boundary for planner guidance
    const guidance: PlannerGuidance = outline;
    void visible;
    void guidance;
  });

  it('yields no plan for a non-slide outline or a role that does not allow assistance', () => {
    expect(toAssistancePlan({ ...outline, type: 'quiz' })).toBeUndefined();
    expect(toAssistancePlan({ ...outline, contentRole: 'example' })).toBeUndefined();
  });
});
