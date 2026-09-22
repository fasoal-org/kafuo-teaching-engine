/**
 * Stage-1 slide-semantics contract for generated outlines.
 *
 * The outline prompt asks the model to classify every `type: 'slide'` outline
 * by pedagogical intent: `slideType` (the intended `Slide.type`), `contentRole`
 * and, where the role defines specializations, `contentKind`. This module is
 * the deterministic check of that answer. It only ever ACCEPTS or REPORTS — it
 * never picks a role, a kind, or a slide type on the model's behalf: a
 * classification the model did not make correctly is a bad model answer, and
 * the remedy is the caller's existing re-roll, not a guess.
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
  SLIDE_TYPES,
  isSlideContentKindForRole,
  isSlideContentRole,
  isSlideType,
  slideRoleAllowsAssistance,
  slideSemanticsRequireAssistance,
} from '@openmaic/dsl';
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
 * - `contentKind` is required when the role defines kinds, must be one of that
 *   role's kinds, and must be absent when the role defines none (or when there
 *   is no role);
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
    } else if (!hasKind) {
      issues.push({
        index,
        field: 'contentKind',
        message: `contentRole "${contentRole}" requires a contentKind (one of: ${allowed.join(', ')})`,
      });
    } else if (!isSlideContentKindForRole(contentRole, contentKind)) {
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
