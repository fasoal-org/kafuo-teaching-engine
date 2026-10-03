/**
 * Stage-1 slide-semantics contract for generated outlines.
 *
 * The outline prompt asks the model to classify every `type: 'slide'` outline
 * by pedagogical intent: `slideType` (the intended `Slide.type`), `contentRole`
 * and, optionally, a `contentKind` that specializes the role. This module is
 * the deterministic check of that answer. It never picks a role or a slide type
 * on the model's behalf: a missing, unknown or disallowed `contentRole` is
 * reported, and a run that supports checkpoints pauses it for a person.
 *
 * The ONLY things it repairs are metadata that cannot be valid beside the
 * purpose the model chose ({@link repairOutlineSlideSemantics}): a
 * `contentKind` the role does not define is dropped and the role is KEPT —
 * never the other way round — and a planner-only `assistancePlan` the role
 * cannot use is removed. Every repair is recorded as a `repaired` diagnostic.
 *
 * The role/kind vocabulary and the pairing table come from `@openmaic/dsl`
 * (`SLIDE_CONTENT_KINDS_BY_ROLE`); nothing is restated here.
 *
 * Pure: no I/O, no logging, no mutation of its inputs.
 */
import {
  REQUIRED_SLIDE_ASSISTANCE_TIERS,
  SLIDE_ASSISTANCE_ROLES,
  SLIDE_ASSISTANCE_TIERS,
  SLIDE_CONTENT_KINDS_BY_ROLE,
  SLIDE_CONTENT_ROLES,
  SLIDE_TYPES,
  isSlideContentKindForRole,
  isSlideContentRole,
  isSlideType,
  slideRoleAllowsAssistance,
  slideSemanticsRequireAssistance,
} from '@openmaic/dsl';
import type { OutlineDiagnostic } from './outline-diagnostics.js';
import type { SceneOutline, SlideOutlineSemantics } from './outline-types.js';

/** Every `Slide.type` value an outline may plan — the `@openmaic/dsl` list. */
export const OUTLINE_SLIDE_TYPES = SLIDE_TYPES;

/**
 * Slide types that always teach: a newly planned one must state its role. The
 * remaining types (`contents` / `transition` / `end`) may be purely structural
 * and then carry no role at all.
 */
const INSTRUCTIONAL_SLIDE_TYPES: readonly string[] = ['cover', 'content'];

/**
 * Stable prefix of the failure message produced for a response that violates
 * the contract. It is a message prefix, not a Teaching Package error code: the
 * failure surfaces as an ordinary outline-generation failure, which callers
 * already treat as a retryable bad model answer.
 */
export const OUTLINE_SLIDE_SEMANTICS_ERROR = 'OUTLINE_SLIDE_SEMANTICS_INVALID';

/** The outline fields that belong to the slide-semantics contract. */
const SEMANTIC_FIELDS = [
  'slideType',
  'contentRole',
  'contentKind',
  'assistancePlan',
  'visualPlan',
] as const;

export interface OutlineSemanticsIssue {
  /** Zero-based position of the offending outline. */
  index: number;
  field: (typeof SEMANTIC_FIELDS)[number];
  message: string;
}

/**
 * Report every violation of the slide-semantics contract, in outline order.
 * Empty → every slide outline is explicitly and validly classified.
 *
 * Per `type: 'slide'` outline:
 * - `slideType` is required and must be a known `Slide.type`;
 * - `contentRole` is required on an instructional slide (`cover` / `content`)
 *   and optional on a structural one (`contents` / `transition` / `end`); when
 *   present, on any slide type, it must be a known role;
 * - `contentKind` is optional; when present it must be one of the role's kinds,
 *   and it must be absent when the role defines none (or when there is no
 *   role). {@link repairOutlineSlideSemantics} removes such a kind first, so a
 *   repaired outline never reports it;
 * - `assistancePlan` is allowed only beside `practice` / `check_understanding`,
 *   is required (`hint` + `explanation`) for `practice` / `independent`, and is
 *   reported — never silently dropped — anywhere else.
 *
 * Across the lesson: at most one `cover` and at most one `end` — a second
 * opening or a second closing is not a genuine one.
 *
 * Non-slide outlines are not judged here; see {@link stripEmptyOutlineSemantics}.
 */
export function validateOutlineSlideSemantics(outlines: SceneOutline[]): OutlineSemanticsIssue[] {
  const issues: OutlineSemanticsIssue[] = [];
  const seenOnce = new Map<'cover' | 'end', number>();

  outlines.forEach((outline, index) => {
    if (outline?.type !== 'slide') return;
    const { slideType, contentRole, contentKind, assistancePlan } = outline as {
      slideType?: unknown;
      contentRole?: unknown;
      contentKind?: unknown;
      assistancePlan?: unknown;
    };
    const hasKind = contentKind !== undefined && contentKind !== null;
    const hasPlan = assistancePlan !== undefined && assistancePlan !== null;

    if (slideType === undefined || slideType === null) {
      issues.push({ index, field: 'slideType', message: 'slideType is missing' });
    } else if (!isSlideType(slideType)) {
      issues.push({
        index,
        field: 'slideType',
        message: `unknown slideType ${JSON.stringify(slideType)}`,
      });
    } else if (slideType === 'cover' || slideType === 'end') {
      const first = seenOnce.get(slideType);
      if (first === undefined) seenOnce.set(slideType, index);
      else
        issues.push({
          index,
          field: 'slideType',
          message: `a lesson has at most one "${slideType}" slide (first at #${first})`,
        });
    }

    if (contentRole === undefined || contentRole === null) {
      // Structural-only exception: no role is invented for a slide that has no
      // teaching purpose. An instructional slide still must state one.
      if (!isSlideType(slideType) || INSTRUCTIONAL_SLIDE_TYPES.includes(slideType))
        issues.push({ index, field: 'contentRole', message: 'contentRole is missing' });
      if (hasKind)
        issues.push({ index, field: 'contentKind', message: 'contentKind requires a contentRole' });
      if (hasPlan)
        issues.push({
          index,
          field: 'assistancePlan',
          message: 'assistancePlan requires a contentRole that allows assistance',
        });
      return;
    }
    if (!isSlideContentRole(contentRole)) {
      issues.push({
        index,
        field: 'contentRole',
        message: `unknown contentRole ${JSON.stringify(contentRole)}`,
      });
      return;
    }

    const allowed: readonly string[] = SLIDE_CONTENT_KINDS_BY_ROLE[contentRole];
    if (allowed.length === 0) {
      if (hasKind)
        issues.push({
          index,
          field: 'contentKind',
          message: `contentRole "${contentRole}" has no content kinds; got ${JSON.stringify(contentKind)}`,
        });
    } else if (hasKind && !isSlideContentKindForRole(contentRole, contentKind)) {
      issues.push({
        index,
        field: 'contentKind',
        message: `contentKind ${JSON.stringify(contentKind)} is not valid for contentRole "${contentRole}" (expected one of: ${allowed.join(', ')})`,
      });
    }

    for (const message of assistancePlanIssues(contentRole, contentKind, assistancePlan))
      issues.push({ index, field: 'assistancePlan', message });

    const visualIssue = visualPlanIssue(
      slideType,
      contentRole,
      (outline as SceneOutline).visualPlan,
    );
    if (visualIssue) issues.push({ index, field: 'visualPlan', message: visualIssue });
  });

  return issues;
}

const VISUAL_PLAN_MODES: readonly string[] = ['image', 'native', 'omitted'];
/** Reasons that say nothing: an omission must be justified for THIS lesson. */
const BOILERPLATE_OMISSION =
  /^(n\/?a|none|no|not needed|not applicable|no visual( needed)?|-+|\.+)$/i;

/**
 * The orientation visual is enforced, not logged: the lesson opening (`cover` +
 * `orientation`) must plan a visual or justify its omission. Other slides may
 * carry a well-formed `visualPlan` but are not required to.
 */
function visualPlanIssue(
  slideType: unknown,
  contentRole: string,
  plan: unknown,
): string | undefined {
  const isOpening = slideType === 'cover' && contentRole === 'orientation';
  if (plan === undefined || plan === null) {
    return isOpening
      ? 'the lesson opening (cover + orientation) requires visualPlan { mode: "image" | "native" | "omitted" }'
      : undefined;
  }
  if (typeof plan !== 'object' || Array.isArray(plan)) return 'visualPlan must be an object';
  const { mode, omissionReason } = plan as { mode?: unknown; omissionReason?: unknown };
  if (typeof mode !== 'string' || !VISUAL_PLAN_MODES.includes(mode)) {
    return `visualPlan.mode must be one of: ${VISUAL_PLAN_MODES.join(', ')}`;
  }
  if (mode === 'omitted') {
    const reason = typeof omissionReason === 'string' ? omissionReason.trim() : '';
    if (reason.length < 15 || BOILERPLATE_OMISSION.test(reason)) {
      return 'visualPlan.mode "omitted" requires a specific omissionReason explaining why no visual would help this lesson';
    }
  }
  return undefined;
}

/** The `assistancePlan` rules for a slide outline whose role is known. */
function assistancePlanIssues(contentRole: string, contentKind: unknown, plan: unknown): string[] {
  const messages: string[] = [];
  const hasPlan = plan !== undefined && plan !== null;
  if (hasPlan && !slideRoleAllowsAssistance(contentRole)) {
    return [
      `assistancePlan is only allowed with contentRole ${SLIDE_ASSISTANCE_ROLES.join(' / ')}; got "${contentRole}"`,
    ];
  }
  const tiers: Record<string, unknown> = {};
  if (hasPlan) {
    if (typeof plan !== 'object' || Array.isArray(plan))
      return ['assistancePlan must be an object'];
    const known: readonly string[] = SLIDE_ASSISTANCE_TIERS;
    for (const [key, value] of Object.entries(plan as Record<string, unknown>)) {
      if (!known.includes(key)) messages.push(`assistancePlan has an unknown tier "${key}"`);
      else if (value === undefined || value === null) continue;
      else if (typeof value !== 'string' || value.trim() === '')
        messages.push(`assistancePlan.${key} must be a non-empty string`);
      else tiers[key] = value;
    }
    if (messages.length === 0 && Object.keys(tiers).length === 0)
      messages.push('assistancePlan must plan at least one tier');
  }
  if (slideSemanticsRequireAssistance(contentRole, contentKind)) {
    const missing = REQUIRED_SLIDE_ASSISTANCE_TIERS.filter((tier) => tiers[tier] === undefined);
    if (missing.length > 0)
      messages.push(
        `contentRole "practice" / contentKind "independent" requires assistancePlan.${missing.join(' and assistancePlan.')}`,
      );
  }
  return messages;
}

/** Diagnostic code recorded when an incompatible `contentKind` is dropped. */
export const CONTENT_KIND_DROPPED = 'CONTENT_KIND_DROPPED';
/** Diagnostic code recorded when an unusable `assistancePlan` (or tier) is removed. */
export const ASSISTANCE_PLAN_REMOVED = 'ASSISTANCE_PLAN_REMOVED';

/**
 * Repair the metadata of ONE slide outline that cannot be valid beside the
 * purpose the model chose, and record each repair:
 *
 * - a `contentKind` the role does not define (including any kind on a role
 *   without kinds) is dropped — the `contentRole` is KEPT and is never derived
 *   from the kind;
 * - a `contentKind` on a slide with no `contentRole` is dropped (a kind
 *   specializes a purpose; without one it means nothing). The missing role is
 *   NOT supplied: it stays a reported issue;
 * - an `assistancePlan` beside a known role that cannot use it is removed, and
 *   unknown or empty tiers of an allowed plan are removed (an allowed plan left
 *   with no tier is removed whole).
 *
 * A `contentKind` beside an UNKNOWN role is left alone: the role is the issue,
 * and once a valid role is chosen this repair runs again. Non-slide outlines
 * are returned untouched. Returns the same object when nothing changed.
 */
export function repairOutlineSlideSemantics(
  outline: SceneOutline,
  index: number,
): { outline: SceneOutline; repairs: OutlineDiagnostic[] } {
  if (outline?.type !== 'slide') return { outline, repairs: [] };
  const record = outline as unknown as Record<string, unknown>;
  const { contentRole, contentKind, assistancePlan } = record;
  const repairs: OutlineDiagnostic[] = [];
  const base = { disposition: 'repaired' as const, outlineIndex: index, outlineId: outline.id };
  let repaired: Record<string, unknown> | undefined;
  const edit = () => (repaired ??= { ...record });

  const hasRole = contentRole !== undefined && contentRole !== null;
  if (contentKind !== undefined && contentKind !== null) {
    if (!hasRole) {
      delete edit().contentKind;
      repairs.push({
        ...base,
        code: CONTENT_KIND_DROPPED,
        field: 'contentKind',
        previousValue: contentKind,
        message: `contentKind ${JSON.stringify(contentKind)} was dropped: a kind specializes a contentRole and this slide has none`,
      });
    } else if (
      isSlideContentRole(contentRole) &&
      !isSlideContentKindForRole(contentRole, contentKind)
    ) {
      const kinds: readonly string[] = SLIDE_CONTENT_KINDS_BY_ROLE[contentRole];
      delete edit().contentKind;
      repairs.push({
        ...base,
        code: CONTENT_KIND_DROPPED,
        field: 'contentKind',
        previousValue: contentKind,
        allowedValues: [...kinds],
        message:
          kinds.length === 0
            ? `contentKind ${JSON.stringify(contentKind)} was dropped: contentRole "${contentRole}" has no content kinds; the role was kept`
            : `contentKind ${JSON.stringify(contentKind)} was dropped: it is not a kind of contentRole "${contentRole}" (kinds: ${kinds.join(', ')}); the role was kept and generic ${contentRole} guidance applies`,
      });
    }
  }

  if (assistancePlan !== undefined && assistancePlan !== null && isSlideContentRole(contentRole)) {
    if (!slideRoleAllowsAssistance(contentRole)) {
      delete edit().assistancePlan;
      repairs.push({
        ...base,
        code: ASSISTANCE_PLAN_REMOVED,
        field: 'assistancePlan',
        previousValue: assistancePlan,
        message: `assistancePlan was removed: contentRole "${contentRole}" does not use on-demand assistance (only ${SLIDE_ASSISTANCE_ROLES.join(' / ')})`,
      });
    } else if (typeof assistancePlan !== 'object' || Array.isArray(assistancePlan)) {
      delete edit().assistancePlan;
      repairs.push({
        ...base,
        code: ASSISTANCE_PLAN_REMOVED,
        field: 'assistancePlan',
        previousValue: assistancePlan,
        message: 'assistancePlan was removed: it is not an object of assistance tiers',
      });
    } else {
      const known: readonly string[] = SLIDE_ASSISTANCE_TIERS;
      const kept: Record<string, string> = {};
      const removed: string[] = [];
      for (const [tier, value] of Object.entries(assistancePlan as Record<string, unknown>)) {
        if (known.includes(tier) && typeof value === 'string' && value.trim() !== '') {
          kept[tier] = value;
        } else if (value !== undefined && value !== null) {
          removed.push(tier);
        }
      }
      if (removed.length > 0) {
        if (Object.keys(kept).length === 0) delete edit().assistancePlan;
        else edit().assistancePlan = kept;
        repairs.push({
          ...base,
          code: ASSISTANCE_PLAN_REMOVED,
          field: 'assistancePlan',
          previousValue: removed,
          message: `assistancePlan tier(s) ${removed.map((tier) => JSON.stringify(tier)).join(', ')} were removed: unknown or empty (tiers: ${SLIDE_ASSISTANCE_TIERS.join(', ')})`,
        });
      }
    }
  }

  return {
    outline: repaired ? (repaired as unknown as SceneOutline) : outline,
    repairs,
  };
}

/** {@link repairOutlineSlideSemantics} over a whole outline list, in order. */
export function repairOutlinesSlideSemantics(outlines: readonly SceneOutline[]): {
  outlines: SceneOutline[];
  repairs: OutlineDiagnostic[];
} {
  const repairs: OutlineDiagnostic[] = [];
  const repaired = outlines.map((outline, index) => {
    const result = repairOutlineSlideSemantics(outline, index);
    repairs.push(...result.repairs);
    return result.outline;
  });
  return { outlines: repaired, repairs };
}

/** The values an administrator may choose for a semantics field, where enumerable. */
function semanticsAllowedValues(
  issue: OutlineSemanticsIssue,
  outline: SceneOutline | undefined,
): Array<string | number> | undefined {
  switch (issue.field) {
    case 'slideType':
      return [...SLIDE_TYPES];
    case 'contentRole':
      return [...SLIDE_CONTENT_ROLES];
    case 'contentKind': {
      const role = outline?.contentRole;
      return isSlideContentRole(role) ? [...SLIDE_CONTENT_KINDS_BY_ROLE[role]] : undefined;
    }
    case 'visualPlan':
      return [...VISUAL_PLAN_MODES];
    default:
      return undefined;
  }
}

/** Stable diagnostic code for a semantics issue (field + the shape of the fault). */
function semanticsIssueCode(issue: OutlineSemanticsIssue): string {
  const missing = / is missing$/.test(issue.message) || /requires /.test(issue.message);
  switch (issue.field) {
    case 'slideType':
      return /at most one/.test(issue.message)
        ? 'SLIDE_TYPE_DUPLICATED'
        : missing
          ? 'SLIDE_TYPE_MISSING'
          : 'SLIDE_TYPE_INVALID';
    case 'contentRole':
      return missing ? 'CONTENT_ROLE_MISSING' : 'CONTENT_ROLE_INVALID';
    case 'contentKind':
      return 'CONTENT_KIND_INVALID';
    case 'assistancePlan':
      return 'ASSISTANCE_PLAN_INVALID';
    case 'visualPlan':
      return 'VISUAL_PLAN_INVALID';
  }
}

/**
 * The semantics contract as admin-correctable diagnostics: every issue
 * {@link validateOutlineSlideSemantics} reports, with the field, the reason and
 * the values a person may choose. Run {@link repairOutlinesSlideSemantics}
 * first so repairable metadata is not reported as blocking.
 */
export function outlineSemanticsDiagnostics(outlines: SceneOutline[]): OutlineDiagnostic[] {
  return validateOutlineSlideSemantics(outlines).map((issue) => {
    const outline = outlines[issue.index];
    const allowedValues = semanticsAllowedValues(issue, outline);
    return {
      code: semanticsIssueCode(issue),
      disposition: 'admin_correctable' as const,
      outlineIndex: issue.index,
      ...(outline?.id ? { outlineId: outline.id } : {}),
      field: issue.field,
      message: issue.message,
      ...(allowedValues ? { allowedValues } : {}),
      ...(outline?.teachingStage
        ? { flowIndex: outline.teachingStage.flowIndex, stage: outline.teachingStage.key }
        : {}),
    };
  });
}

/** One-line failure message for a response that violates the contract. */
export function formatOutlineSemanticsIssues(issues: OutlineSemanticsIssue[]): string {
  const shown = issues
    .slice(0, 5)
    .map((issue) => `#${issue.index} ${issue.message}`)
    .join('; ');
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
  return `${OUTLINE_SLIDE_SEMANTICS_ERROR}: ${issues.length} slide classification issue(s): ${shown}${more}`;
}

/**
 * Remove semantic fields that carry no classification. This only ever removes
 * data; it never assigns or alters a classification:
 *
 * - Slide semantics exist only on slide outlines. A quiz/interactive/pbl
 *   outline that came back carrying any of these fields (including the
 *   slide-only `assistancePlan`) keeps its scene type and loses the stray fields — they have no meaning there and nothing
 *   downstream may read them.
 * - On a slide outline, an explicit JSON `null` (a model's way of writing "no
 *   contentKind") is dropped so the outline carries the field or does not,
 *   never a `null`. Validation treats `null` as absent either way.
 *
 * Returns the same object when there is nothing to remove.
 */
export function stripEmptyOutlineSemantics(outline: SceneOutline): SceneOutline {
  const record = outline as unknown as Record<string, unknown>;
  const removable = SEMANTIC_FIELDS.filter((field) =>
    outline?.type === 'slide' ? record[field] === null : record[field] !== undefined,
  );
  if (removable.length === 0) return outline;
  const stripped = { ...outline };
  for (const field of removable) delete stripped[field];
  return stripped;
}

/**
 * The classification a slide outline hands to the scene builder: each field
 * copied VERBATIM from the outline, or omitted. Nothing is ever derived — not
 * from the title, description, key points, generated elements, or teaching
 * stage — and no default is supplied, so a slide built from an unclassified
 * (legacy, editor-made, or fallback) outline stays unclassified.
 *
 * A value outside the shared contract is omitted rather than copied, so the
 * builder can never emit a scene that `@openmaic/dsl`'s `validateScene`
 * rejects: an unknown `slideType` or `contentRole` is dropped, and a
 * `contentKind` is kept only beside a `contentRole` that lists it. Outlines
 * that came through the Stage-1 gate are valid by construction and pass
 * through whole; this guard only matters for outlines that did not (edited or
 * client-supplied ones). Non-slide outlines yield nothing.
 */
export function slideSemanticsFromOutline(outline: SceneOutline): Partial<SlideOutlineSemantics> {
  if (outline?.type !== 'slide') return {};
  const { slideType, contentRole, contentKind } = outline;
  const semantics: Partial<SlideOutlineSemantics> = {};
  if (isSlideType(slideType)) semantics.slideType = slideType;
  if (isSlideContentRole(contentRole)) {
    semantics.contentRole = contentRole;
    if (isSlideContentKindForRole(contentRole, contentKind)) semantics.contentKind = contentKind;
  }
  return semantics;
}
