/**
 * The typed input boundary between a slide outline and the generators that
 * produce what a learner sees.
 *
 * A slide outline mixes three classes of information that must never blur:
 *
 * | class                     | outline fields                                  | may be displayed |
 * | ------------------------- | ----------------------------------------------- | ---------------- |
 * | learner-visible content   | `title`, `keyPoints`                            | yes              |
 * | planner guidance          | `description`, classification, skills, flow ... | never            |
 * | hidden assistance plan    | `assistancePlan`                                | only as authored `SlideContent.assistance`, on demand |
 *
 * Display generators (canvas, narration) take {@link VisibleSlideInput} and
 * {@link PlannerGuidance}; only the assistance-authoring step takes the
 * {@link AssistancePlan}. Both display-side types declare `assistancePlan` as
 * `never`, so handing a whole `SceneOutline` to a display generator does not
 * compile — the separation is structural, not an instruction to a model.
 *
 * Pure: no I/O, no logging, no mutation of its inputs. Nothing is derived or
 * defaulted; every value is copied verbatim from the outline or omitted.
 */
import { SLIDE_ASSISTANCE_TIERS, slideRoleAllowsAssistance } from '@openmaic/dsl';
import type { AssistancePlan, SceneOutline } from './outline-types.js';

export type { AssistancePlan } from './outline-types.js';

/** The outline content a learner may see, and nothing else. */
export interface VisibleSlideInput {
  readonly title: string;
  readonly keyPoints: readonly string[];
  /** The solution path is never display input. */
  readonly assistancePlan?: never;
}

/** The outline fields that steer generation but are never displayed. */
const PLANNER_GUIDANCE_FIELDS = [
  'id',
  'order',
  'description',
  'teachingObjective',
  'estimatedDuration',
  'languageNote',
  'slideType',
  'contentRole',
  'contentKind',
  'visualPlan',
  'teachingStage',
  'teachingSkills',
  'sourceContentUnitIds',
  'sourceBlockIds',
  'suggestedImageIds',
  'mediaGenerations',
] as const satisfies readonly (keyof SceneOutline)[];

/**
 * Planner guidance for a slide: how to build it, never what to show. A
 * generator may read it as a labelled non-display block only.
 */
export type PlannerGuidance = Readonly<
  Pick<SceneOutline, (typeof PLANNER_GUIDANCE_FIELDS)[number]>
> & {
  /** The solution path is never planner guidance for a display generator. */
  readonly assistancePlan?: never;
};

/** The learner-visible half of a slide outline. */
export function toVisibleSlideInput(outline: SceneOutline): VisibleSlideInput {
  return { title: outline.title, keyPoints: [...(outline.keyPoints ?? [])] };
}

/** The non-display guidance half of a slide outline — without the assistance plan. */
export function toPlannerGuidance(outline: SceneOutline): PlannerGuidance {
  const guidance: Record<string, unknown> = {};
  for (const field of PLANNER_GUIDANCE_FIELDS) {
    if (outline[field] !== undefined) guidance[field] = outline[field];
  }
  return guidance as PlannerGuidance;
}

/**
 * The hidden assistance plan of a slide outline, for the assistance-authoring
 * step only. `undefined` when the outline is not a slide, its role does not
 * allow assistance, or no tier is planned.
 */
export function toAssistancePlan(outline: SceneOutline): AssistancePlan | undefined {
  if (outline?.type !== 'slide' || !slideRoleAllowsAssistance(outline.contentRole)) {
    return undefined;
  }
  const plan: AssistancePlan = {};
  for (const tier of SLIDE_ASSISTANCE_TIERS) {
    const value = outline.assistancePlan?.[tier];
    if (typeof value === 'string' && value.trim() !== '') plan[tier] = value;
  }
  return Object.keys(plan).length > 0 ? plan : undefined;
}
