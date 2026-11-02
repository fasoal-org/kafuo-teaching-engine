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
 * (17 role or role-kind variants, plus the generic `explanation` / `activity` /
 * `practice` used when the optional `contentKind` is absent) and
 * `structural.md` for a role-less `contents` / `transition` / `end` slide. An
 * unclassified (legacy) slide has NO guidance: it keeps today's generic
 * prompt, byte for byte.
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

/**
 * Every approved variant file name, in vocabulary order: the role itself (for a
 * role with kinds this is the generic guidance used when `contentKind` is
 * absent), then each `role-kind` specialization.
 */
export const SLIDE_ROLE_VARIANTS: readonly string[] = (
  Object.keys(SLIDE_CONTENT_KINDS_BY_ROLE) as SlideContentRole[]
).flatMap((role) => [role, ...SLIDE_CONTENT_KINDS_BY_ROLE[role].map((kind) => `${role}-${kind}`)]);

/** The guidance file for a classification, or `undefined` when there is none. */
function variantFile(input: SlideRoleGuidanceInput): string | undefined {
  const { slideType, contentRole, contentKind } = input;
  if (!isSlideContentRole(contentRole)) {
    return slideType !== undefined && STRUCTURAL_SLIDE_TYPES.includes(slideType)
      ? 'structural'
      : undefined;
  }
  // `contentKind` is an optional specialization: a valid one selects its
  // specific guidance; an absent one (or one the role does not define, which the
  // outline gate drops before this point) gets the role's generic guidance —
  // never a guessed kind.
  return isSlideContentKindForRole(contentRole, contentKind)
    ? `${contentRole}-${contentKind}`
    : contentRole;
}

function loadVariant(file: string): string {
  return loadPromptAsset(`snippets/slide-roles/${file}.md`);
}

/**
 * The hidden-step question catalogue (teacher-parity plan I-2): each type, what
 * reveals it, and the visible working its solution must write. One row per type.
 */
export const WORKING_STEP_ASSETS: readonly string[] = [
  'snippets/working-steps/hidden-step-types.md',
];

/** The hidden-step catalogue text, as the planner and the solution canvas read it. */
export function hiddenStepCatalogue(): string {
  return loadPromptAsset(WORKING_STEP_ASSETS[0]!);
}

/** Roles that solve an item on the canvas, so every hidden step is written there. */
const SOLVING_ROLES: readonly string[] = ['worked_example'];

const VISIBLE_WORKING_RULE =
  '**Visible working (mandatory).** Write every hidden step from the plan as a visible line on the canvas: a step the learner cannot see in the question (a numbered set, a time worked in minutes, a recalled property, a labelled figure, the differences of a pattern, an average change) is its own line, never folded into the answer.';

export interface SlideRoleGuidanceOptions {
  /**
   * The caller's flow writes every hidden step visibly (g5.v8). A solving slide
   * then gets the visible-working rule and the hidden-step catalogue. Absent →
   * the guidance is byte-identical to before.
   */
  visibleWorkingSteps?: boolean;
}

/** Role guidance for the slide CANVAS generator. */
export function buildSlideRoleContext(
  input: SlideRoleGuidanceInput,
  options: SlideRoleGuidanceOptions = {},
): SlideRoleContext {
  const file = variantFile(input);
  if (!file) return NO_GUIDANCE;
  const diagram = input.visualPlan?.mode === 'native' ? input.visualPlan.diagram : undefined;
  // A try-it, practice task or activity leaves the finding to the learner, so its
  // diagram shows the question's data and never labels the result.
  const withholdFinding = ['check_understanding', 'practice', 'activity'].includes(
    String(input.contentRole ?? ''),
  );
  const visual =
    VISUAL_PLAN_GUIDANCE[input.visualPlan?.mode ?? ''] &&
    (diagram?.shows?.trim() && withholdFinding
      ? `${VISUAL_PLAN_GUIDANCE.native} The planner's note for this diagram: it shows ${diagram.shows.trim()}. It is the data of the question: never draw or label the pattern, relationship or result the learner is asked to find.`
      : diagram?.shows?.trim() && diagram.teachingPoint?.trim()
        ? `${VISUAL_PLAN_GUIDANCE.native} The planner's note for this diagram: it shows ${diagram.shows.trim()}; the learner should notice ${diagram.teachingPoint.trim()}.`
        : VISUAL_PLAN_GUIDANCE[input.visualPlan?.mode ?? '']);
  const sourceGrounding =
    input.contentRole === 'explanation' ? EXPLANATION_VISUAL_GROUNDING : undefined;
  const visibleWorking =
    options.visibleWorkingSteps && SOLVING_ROLES.includes(String(input.contentRole ?? ''))
      ? [VISIBLE_WORKING_RULE, hiddenStepCatalogue()]
      : [];
  return {
    hasRoleGuidance: true,
    roleGuidance: [
      loadVariant(file),
      ...visibleWorking,
      ...(sourceGrounding ? [sourceGrounding] : []),
      ...(visual ? [visual] : []),
      PRECEDENCE,
    ].join('\n\n'),
  };
}

const EXPLANATION_VISUAL_GROUNDING =
  '**Textbook-grounded visual (mandatory).** The visual must stabilise the exact idea taught by this explanation and must follow the authoritative source. Use the selected textbook image when one is available. Otherwise build a native diagram only from the facts, relationships and sequence already supplied for this scene. Do not invent a new example, fact, analogy or context, and do not use decoration as the visual.';

/** How the planned visual is realised on the canvas. Placement is never prescribed. */
const VISUAL_PLAN_GUIDANCE: Readonly<Record<string, string>> = {
  image:
    '**The planned visual.** Use the selected image made available to this slide as its one supporting visual, sized to be genuinely readable. The exact selected source must appear on the canvas; an unrelated image or generated substitute does not count.',
  native:
    '**The planned visual.** Compose ONE meaningful visual from native slide elements — a simple diagram, a chart, or an illustrative group of shapes and lines with short labels — using only the facts, relationships and sequence in the authoritative source content for this slide. It must clarify the idea; decoration does not count.',
  omitted:
    '**No visual is planned for this slide.** Do not add decorative imagery or filler shapes.',
};

/** What narration must respect, per variant, beyond elaborating the canvas. */
const NARRATION_RULES: Readonly<Record<string, string>> = {
  orientation: 'Open with the hook, then frame the context, the objectives and the big idea.',
  activity:
    'Set up the activity and what to do or notice. Do NOT reveal the finding, analysis, or finished work it asks for.',
  'activity-investigation':
    'Set up the investigation and what to observe. Do NOT reveal the finding or conclusion.',
  'activity-source_analysis':
    'Frame the source and the prompts. Do NOT give the analysis or interpretation.',
  'activity-reflection': 'Invite reflection. Do NOT supply model answers.',
  'activity-production': 'Clarify the output and success criteria. Do NOT complete the task.',
  practice:
    'Present the task and walk through any visible scaffolding. Do NOT give the full solution or final answer.',
  'practice-guided':
    'Walk through the visible scaffolding. Do NOT give the full solution or final answer.',
  'practice-independent':
    'Present the task and invite the learner to attempt it on their own. You MUST NOT reveal the method, any step of the solution, a hint, or the answer.',
  'practice-higher_order':
    'Present the task and ask the learner to reason and justify. Do NOT state the conclusion, the judgement, or the justification.',
  check_understanding:
    'Pose the question and give the learner time to think. You MUST NOT reveal or explain the answer, and never mention scores, points, attempts or grades.',
  worked_example:
    'Work the problem step by step to its final answer and say that answer clearly. When the item asks to guess, estimate or predict, give a reasoned value derived from the given data and say it is an estimate.',
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
