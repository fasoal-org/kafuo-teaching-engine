/**
 * Slide semantics — the pedagogical metadata a slide scene may carry.
 *
 * Four concepts, deliberately kept apart:
 *
 * | concept            | lives on                   | answers                                   |
 * | ------------------ | -------------------------- | ----------------------------------------- |
 * | `SceneType`        | `Scene.type`               | which scene kind (slide/quiz/interactive/pbl) |
 * | `SlideType`        | `Slide.type` (the canvas)  | the deck-structural page kind (cover/contents/transition/content/end) |
 * | `SlideContentRole` | `SlideContent.contentRole` | the pedagogical purpose of the slide      |
 * | `SlideContentKind` | `SlideContent.contentKind` | a specialization of that purpose          |
 *
 * The role/kind vocabulary is curriculum-, grade-, language- and
 * subject-agnostic. It names *why a slide exists* in a lesson, never how it
 * looks: no layout, visual, or template concept belongs in these unions, and no
 * teaching-model stage name (those are app-layer, per-model data — see the
 * app's `teachingStage` annotation) is a semantic value here.
 *
 * The metadata sits on {@link SlideContent}, beside the canvas rather than
 * inside it: the canvas ({@link Slide}) is shared with whiteboards and the
 * importer and stays purely presentational, and canvas-scoped edit patches can
 * neither reach nor drop the semantics.
 *
 * Both fields are optional and additive. Documents written before they existed
 * simply lack them, and absence means "unclassified" — readers must never
 * fabricate a role for a legacy slide. Like the voice fields on
 * `GeneratedAgentConfig` (see `stage.ts`), the addition changes the meaning of
 * no existing field and does not bump `DSL_VERSION`; the same caveat applies to
 * consumers validating against a pinned older copy of the strict JSON Schema.
 *
 * No runtime dependencies. Pure types + pure guards only.
 */

/**
 * The pedagogical purpose of a slide.
 *
 * - `orientation` — opens the learning: context, relevance, prior knowledge,
 *   and the learning objectives. Learning objectives are part of orientation,
 *   not a role of their own.
 * - `explanation` — presents new knowledge.
 * - `example` — illustrates knowledge with a concrete instance.
 * - `worked_example` — a fully solved problem, shown step by step.
 * - `procedure` — the steps of a method or process to follow.
 * - `activity` — a learner task that builds understanding by doing.
 * - `practice` — exercises that apply what was taught.
 * - `check_understanding` — a formative check of comprehension.
 * - `summary` — consolidates what was learned.
 */
export type SlideContentRole =
  | 'orientation'
  | 'explanation'
  | 'example'
  | 'worked_example'
  | 'procedure'
  | 'activity'
  | 'practice'
  | 'check_understanding'
  | 'summary';

/** Specializations of the `explanation` role. */
export type ExplanationContentKind = 'concept' | 'definition' | 'rule' | 'observation';

/** Specializations of the `activity` role. */
export type ActivityContentKind = 'investigation' | 'source_analysis' | 'reflection' | 'production';

/** Specializations of the `practice` role. */
export type PracticeContentKind = 'guided' | 'independent' | 'higher_order';

/**
 * The roles that have specializations, each mapped to its kind union. A role
 * absent from this map has no `contentKind` at all.
 */
export interface SlideContentKindByRole {
  explanation: ExplanationContentKind;
  activity: ActivityContentKind;
  practice: PracticeContentKind;
}

/** Every content kind, across all roles. Only meaningful paired with its role. */
export type SlideContentKind = SlideContentKindByRole[keyof SlideContentKindByRole];

/** The kinds valid for role `R` — `never` for a role without specializations. */
export type SlideContentKindOf<R extends SlideContentRole> = R extends keyof SlideContentKindByRole
  ? SlideContentKindByRole[R]
  : never;

/**
 * A well-formed role/kind pairing, bound at the type level: `contentKind` is
 * only assignable when it specializes the given `contentRole`. Producers should
 * build semantics as this type; {@link SlideContent} carries the same two
 * fields flat (and loosely paired) so that persisted data stays a plain
 * interface, with the pairing enforced at runtime by `validateScene`.
 */
export type SlideContentSemantics = {
  [R in SlideContentRole]: { contentRole: R; contentKind?: SlideContentKindOf<R> };
}[SlideContentRole];

/** Frozen set of every valid {@link SlideContentRole}, for cheap membership checks. */
export const SLIDE_CONTENT_ROLES = [
  'orientation',
  'explanation',
  'example',
  'worked_example',
  'procedure',
  'activity',
  'practice',
  'check_understanding',
  'summary',
] as const satisfies readonly SlideContentRole[];

// Compile-time exhaustiveness: every SlideContentRole must appear in
// SLIDE_CONTENT_ROLES (`satisfies` above proves the converse).
type _RolesExhaustive = [SlideContentRole] extends [(typeof SLIDE_CONTENT_ROLES)[number]]
  ? true
  : never;
const _rolesExhaustive: _RolesExhaustive = true;
void _rolesExhaustive;

/**
 * The authoritative role -> valid kinds table. Every role has an entry; a role
 * without specializations maps to an empty list, so *any* `contentKind` on it
 * is invalid. The mapped type ties each entry to {@link SlideContentKindOf}, so
 * a kind listed under the wrong role fails the build.
 */
export const SLIDE_CONTENT_KINDS_BY_ROLE: {
  readonly [R in SlideContentRole]: readonly SlideContentKindOf<R>[];
} = {
  orientation: [],
  explanation: ['concept', 'definition', 'rule', 'observation'],
  example: [],
  worked_example: [],
  procedure: [],
  activity: ['investigation', 'source_analysis', 'reflection', 'production'],
  practice: ['guided', 'independent', 'higher_order'],
  check_understanding: [],
  summary: [],
};

/** Frozen set of every valid {@link SlideContentKind}, across all roles. */
export const SLIDE_CONTENT_KINDS = [
  'concept',
  'definition',
  'rule',
  'observation',
  'investigation',
  'source_analysis',
  'reflection',
  'production',
  'guided',
  'independent',
  'higher_order',
] as const satisfies readonly SlideContentKind[];

// Compile-time exhaustiveness: every SlideContentKind must appear in
// SLIDE_CONTENT_KINDS. (That the per-role table lists every kind too is pinned
// by a test — a tuple's completeness can't be read off a `readonly T[]`.)
type _KindsExhaustive = [SlideContentKind] extends [(typeof SLIDE_CONTENT_KINDS)[number]]
  ? true
  : never;
const _kindsExhaustive: _KindsExhaustive = true;
void _kindsExhaustive;

/** Narrow an unknown value to a valid {@link SlideContentRole}. */
export function isSlideContentRole(value: unknown): value is SlideContentRole {
  return typeof value === 'string' && (SLIDE_CONTENT_ROLES as readonly string[]).includes(value);
}

/**
 * Narrow an unknown value to a member of the {@link SlideContentKind}
 * vocabulary. This says nothing about whether the kind fits a given role — use
 * {@link isSlideContentKindForRole} for that.
 */
export function isSlideContentKind(value: unknown): value is SlideContentKind {
  return typeof value === 'string' && (SLIDE_CONTENT_KINDS as readonly string[]).includes(value);
}

/** True when `kind` is a valid specialization of `role`. */
export function isSlideContentKindForRole<R extends SlideContentRole>(
  role: R,
  kind: unknown,
): kind is SlideContentKindOf<R> {
  return (
    typeof kind === 'string' &&
    (SLIDE_CONTENT_KINDS_BY_ROLE[role] as readonly string[]).includes(kind)
  );
}

/**
 * On-demand learner assistance for a slide: up to three escalating tiers the
 * learner may ask for after attempting the task. It is NOT part of the visible
 * canvas — it sits on {@link SlideContent} beside it (same placement rationale
 * as `contentRole`), so the task as displayed never contains its own solution
 * and a renderer reveals a tier only on request.
 *
 * Each tier is the same sanitised rich-text HTML text elements carry, so every
 * surface renders it with the lesson's direction, shaping and math.
 *
 * Optional and additive, like the role/kind fields: absent on legacy data and
 * on every slide whose role does not use it. It adds no role, no kind, and no
 * layout concept, and models no answer capture, scoring, or attempt state.
 */
export interface SlideAssistance {
  /** A nudge that does not reveal the method. */
  hint?: string;
  /** The approach or a partial structure. */
  help?: string;
  /** The full worked explanation. */
  explanation?: string;
}

/** The assistance tiers, in escalation order. */
export const SLIDE_ASSISTANCE_TIERS = [
  'hint',
  'help',
  'explanation',
] as const satisfies readonly (keyof SlideAssistance)[];

/** The roles whose slides may carry {@link SlideAssistance}. */
export const SLIDE_ASSISTANCE_ROLES = [
  'practice',
  'check_understanding',
] as const satisfies readonly SlideContentRole[];

/** The tiers a slide that {@link slideSemanticsRequireAssistance} must carry. */
export const REQUIRED_SLIDE_ASSISTANCE_TIERS = [
  'hint',
  'explanation',
] as const satisfies readonly (keyof SlideAssistance)[];

/** True when a slide with this role may carry assistance at all. */
export function slideRoleAllowsAssistance(role: unknown): boolean {
  return typeof role === 'string' && (SLIDE_ASSISTANCE_ROLES as readonly string[]).includes(role);
}

/**
 * True when a newly generated slide with this classification MUST carry
 * assistance: independent practice shows the task alone, so its on-demand
 * support is what keeps the learner from being stranded.
 */
export function slideSemanticsRequireAssistance(role: unknown, kind: unknown): boolean {
  return role === 'practice' && kind === 'independent';
}
