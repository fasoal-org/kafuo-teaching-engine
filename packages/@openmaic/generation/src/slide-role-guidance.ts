/**
 * Role guidance for slide generation: turns a slide's planned classification
 * into the prose that tells the content and narration generators what this
 * slide is FOR and what it must contain.
 *
 * The classification itself (`contentRole` / `contentKind` / `slideType`) is
 * never handed to a model as `key: value` data and never becomes display text:
 * it is resolved HERE into guidance prose that lives inside the prompt's
 * non-display planning channel. The guidance describes obligations and
 * hierarchy only — it deliberately says nothing about coordinates or fixed
 * arrangements, so no role has a rigid template.
 *
 * Sources: `snippets/slide-roles/<variant>.md` — one file per approved variant
 * (17) plus `structural.md` for a role-less `contents` / `transition` / `end`
 * slide. An unclassified (legacy) slide has NO guidance: it keeps today's
 * generic prompt, byte for byte.
 *
 * The prompt loader supports only truthiness conditionals and leaves undefined
 * variables as literal `{{name}}`, so both returned variables are ALWAYS
 * defined.
 */
import {
  SLIDE_CONTENT_KINDS_BY_ROLE,
  isSlideContentKindForRole,
  isSlideContentRole,
  type SlideContentRole,
} from '@openmaic/dsl';
import { loadPromptAsset } from './prompts/loader.js';
import type { PlannerGuidance } from './slide-generation-inputs.js';

export type SlideRoleGuidanceInput = Pick<
  PlannerGuidance,
  'slideType' | 'contentRole' | 'contentKind' | 'visualPlan'
>;

export interface SlideRoleContext {
  hasRoleGuidance: boolean;
  roleGuidance: string;
}

const NO_GUIDANCE: SlideRoleContext = { hasRoleGuidance: false, roleGuidance: '' };

/** Slide types that may be purely structural (no role at all). */
const STRUCTURAL_SLIDE_TYPES: readonly string[] = ['contents', 'transition', 'end'];

/**
 * The precedence among the three things that shape a slide — stated once, in
 * the role block (FRD RSS-FR-104).
 */
const PRECEDENCE =
  "**Precedence.** This purpose defines what the slide is for and what it must contain. The Teaching Model Flow positions the slide in the lesson. Selected Teaching Skills govern HOW it is taught within these obligations. An edit instruction changes specifics but cannot change this slide's obligations.";

/** Every approved variant file name (role, or role-kind), in vocabulary order. */
export const SLIDE_ROLE_VARIANTS: readonly string[] = (
  Object.keys(SLIDE_CONTENT_KINDS_BY_ROLE) as SlideContentRole[]
).flatMap((role) => {
  const kinds = SLIDE_CONTENT_KINDS_BY_ROLE[role];
  return kinds.length === 0 ? [role] : kinds.map((kind) => `${role}-${kind}`);
});

/** The guidance file for a classification, or `undefined` when there is none. */
function variantFile(input: SlideRoleGuidanceInput): string | undefined {
  const { slideType, contentRole, contentKind } = input;
  if (!isSlideContentRole(contentRole)) {
    return slideType !== undefined && STRUCTURAL_SLIDE_TYPES.includes(slideType)
      ? 'structural'
      : undefined;
  }
  if (SLIDE_CONTENT_KINDS_BY_ROLE[contentRole].length === 0) return contentRole;
  // A role that defines kinds has no guidance without a valid kind: nothing is
  // guessed, and generation gates reject such a slide before this point.
  return isSlideContentKindForRole(contentRole, contentKind)
    ? `${contentRole}-${contentKind}`
    : undefined;
}

function loadVariant(file: string): string {
  return loadPromptAsset(`snippets/slide-roles/${file}.md`);
}

/** Role guidance for the slide CANVAS generator. */
export function buildSlideRoleContext(input: SlideRoleGuidanceInput): SlideRoleContext {
  const file = variantFile(input);
  if (!file) return NO_GUIDANCE;
  const visual = VISUAL_PLAN_GUIDANCE[input.visualPlan?.mode ?? ''];
  return {
    hasRoleGuidance: true,
    roleGuidance: [loadVariant(file), ...(visual ? [visual] : []), PRECEDENCE].join('\n\n'),
  };
}

/** How the planned visual is realised on the canvas. Placement is never prescribed. */
const VISUAL_PLAN_GUIDANCE: Readonly<Record<string, string>> = {
  image:
    '**The planned visual.** Use the image made available to this slide as its one supporting visual, sized to be genuinely readable. If no image is listed under Available Media, compose the visual from native elements instead — never leave this slide without its visual.',
  native:
    '**The planned visual.** Compose ONE meaningful visual from native slide elements — a simple diagram, a chart, or an illustrative group of shapes and lines with short labels — that expresses the hook, the context or the big idea. It must carry meaning; decoration does not count.',
  omitted:
    '**No visual is planned for this slide.** Do not add decorative imagery or filler shapes.',
};

/** What narration must respect, per variant, beyond elaborating the canvas. */
const NARRATION_RULES: Readonly<Record<string, string>> = {
  orientation: 'Open with the hook, then frame the context, the objectives and the big idea.',
  'activity-investigation':
    'Set up the investigation and what to observe. Do NOT reveal the finding or conclusion.',
  'activity-source_analysis':
    'Frame the source and the prompts. Do NOT give the analysis or interpretation.',
  'activity-reflection': 'Invite reflection. Do NOT supply model answers.',
  'activity-production': 'Clarify the output and success criteria. Do NOT complete the task.',
  'practice-guided':
    'Walk through the visible scaffolding. Do NOT give the full solution or final answer.',
  'practice-independent':
    'Present the task and invite the learner to attempt it on their own. You MUST NOT reveal the method, any step of the solution, a hint, or the answer.',
  'practice-higher_order':
    'Present the task and ask the learner to reason and justify. Do NOT state the conclusion, the judgement, or the justification.',
  check_understanding:
    'Pose the question and give the learner time to think. You MUST NOT reveal or explain the answer, and never mention scores, points, attempts or grades.',
  summary: 'Consolidate what was taught. Introduce NO new concept.',
  structural:
    'Keep narration brief and orienting; do not add teaching content this slide does not show.',
};

/** Role guidance for the slide NARRATION (actions) generator. */
export function buildSlideNarrationRoleContext(input: SlideRoleGuidanceInput): SlideRoleContext {
  const file = variantFile(input);
  if (!file) return NO_GUIDANCE;
  // The file's first paragraph is its purpose statement.
  const purpose = loadVariant(file).split('\n\n')[0];
  const rule = NARRATION_RULES[file];
  const lines = [
    purpose,
    'Narration elaborates what is visible on the slide, in keeping with this purpose. It may explain more than the slide shows, but must stay consistent with the visible content.',
    ...(rule ? [`**For this slide:** ${rule}`] : []),
  ];
  return { hasRoleGuidance: true, roleGuidance: lines.join('\n\n') };
}
