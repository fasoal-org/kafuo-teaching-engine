/**
 * Teaching Model Flow position policy — ONE source for the outline prompt and
 * the outline validator.
 *
 * A flow position's scene policy says which scene types, slide types and
 * content roles may fill it, whether a (textbook-grounded) visual is required,
 * and how many outlines it takes. Since g5.v5 the Teaching Model owner authors
 * it on the flow definition item and sends it on the wire
 * (`TeachingFlowEntry.scenePolicy`). Entries from older Teaching Model versions
 * carry none; for them {@link scenePolicyFor} returns the stage-keyed
 * {@link LEGACY_STAGE_SCENE_POLICIES}, which reproduce the rules the validator
 * enforced before policies existed — so a g5.v1–v4 attempt never changes
 * meaning.
 *
 * Everything here is pure: no I/O, no logging, no mutation of inputs.
 */
import {
  SLIDE_CONTENT_ROLES,
  SLIDE_TYPES,
  isSlideContentRole,
  isSlideType,
  type SlideContentRole,
  type SlideType,
} from '@openmaic/dsl';
import { sortDocumentImagesForVision } from './outline-formatters.js';
import type { OutlineDiagnostic } from './outline-diagnostics.js';
import type {
  PdfImage,
  SceneOutline,
  TeachingFlowEntry,
  TeachingScenePolicy,
  TeachingSceneType,
  WidgetType,
} from './outline-types.js';

const SCENE_TYPES: readonly TeachingSceneType[] = ['slide', 'quiz', 'interactive', 'pbl'];
const VISUAL_REQUIREMENTS = ['required', 'source_grounded'] as const;
const CARDINALITIES = ['exactly_one', 'one_or_more'] as const;
const VISUAL_MODES = ['image', 'native'] as const;

/**
 * The rules each known stage key carried before scene policies existed,
 * expressed as policies. Applied ONLY to a flow entry that carries no
 * `scenePolicy`. A stage key absent here has no position rules (only the
 * `teachingStage` carrier and the flow sequence are checked), exactly as before.
 */
export const LEGACY_STAGE_SCENE_POLICIES: Readonly<Record<string, TeachingScenePolicy>> =
  Object.freeze({
    lesson_opener: {
      sceneTypes: ['slide'],
      slideTypes: ['cover'],
      contentRoles: ['orientation'],
      visual: 'required',
      cardinality: 'exactly_one',
    },
    lesson_learning_map: {
      sceneTypes: ['slide'],
      slideTypes: ['content'],
      contentRoles: ['orientation'],
      cardinality: 'exactly_one',
    },
    outcome_visual_explanations: {
      sceneTypes: ['slide'],
      contentRoles: ['explanation'],
      visual: 'source_grounded',
      cardinality: 'one_or_more',
    },
    outcome_check_understanding: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
    lesson_learning_game: {
      sceneTypes: ['interactive'],
      widgetTypes: ['game'],
      cardinality: 'exactly_one',
    },
  });

/** The policy that governs a flow position: its own, else the legacy stage rules. */
export function scenePolicyFor(
  entry: Pick<TeachingFlowEntry, 'stage' | 'scenePolicy'> | undefined,
): TeachingScenePolicy | undefined {
  if (!entry) return undefined;
  if (entry.scenePolicy) return entry.scenePolicy;
  return Object.prototype.hasOwnProperty.call(LEGACY_STAGE_SCENE_POLICIES, entry.stage)
    ? LEGACY_STAGE_SCENE_POLICIES[entry.stage]
    : undefined;
}

/** True when at least one entry carries an explicit (wire) scene policy. */
export function flowHasScenePolicies(flow: readonly TeachingFlowEntry[] | undefined): boolean {
  return (flow ?? []).some((entry) => entry.scenePolicy !== undefined);
}

// ---------------------------------------------------------------------------
// Wire parsing (the caller's single parse seam maps a thrown Error to its own
// refusal code). Arrays and present keys are kept exactly as received: the
// policy participates in a shared canonical digest.
// ---------------------------------------------------------------------------

function stringList<T extends string>(
  raw: unknown,
  field: string,
  where: string,
  known?: readonly string[],
): T[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${where}.${field} must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${where}.${field} must contain non-empty strings`);
    }
    if (known && !known.includes(value)) {
      throw new Error(`${where}.${field} contains unknown value ${JSON.stringify(value)}`);
    }
    if (seen.has(value)) {
      throw new Error(`${where}.${field} lists ${JSON.stringify(value)} more than once`);
    }
    seen.add(value);
  }
  return raw as T[];
}

/**
 * Validate a received scene policy. Throws an `Error` describing the first
 * fault; returns a policy carrying exactly the received keys and values.
 */
export function parseTeachingScenePolicy(raw: unknown, where: string): TeachingScenePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const allowedKeys = [
    'sceneTypes',
    'slideTypes',
    'contentRoles',
    'widgetTypes',
    'visual',
    'cardinality',
  ];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${where} has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const sceneTypes = stringList<TeachingSceneType>(
    record.sceneTypes,
    'sceneTypes',
    where,
    SCENE_TYPES,
  );
  if (!(CARDINALITIES as readonly unknown[]).includes(record.cardinality)) {
    throw new Error(`${where}.cardinality must be one of: ${CARDINALITIES.join(', ')}`);
  }
  const policy: TeachingScenePolicy = {
    sceneTypes,
    cardinality: record.cardinality as TeachingScenePolicy['cardinality'],
  };
  const slideOnly = (field: string) => {
    if (!sceneTypes.includes('slide')) {
      throw new Error(`${where}.${field} requires "slide" in sceneTypes`);
    }
  };
  if (record.slideTypes !== undefined) {
    slideOnly('slideTypes');
    policy.slideTypes = stringList<SlideType>(record.slideTypes, 'slideTypes', where, SLIDE_TYPES);
  }
  if (record.contentRoles !== undefined) {
    slideOnly('contentRoles');
    policy.contentRoles = stringList<SlideContentRole>(
      record.contentRoles,
      'contentRoles',
      where,
      SLIDE_CONTENT_ROLES,
    );
  }
  if (record.widgetTypes !== undefined) {
    if (!sceneTypes.includes('interactive')) {
      throw new Error(`${where}.widgetTypes requires "interactive" in sceneTypes`);
    }
    policy.widgetTypes = stringList<WidgetType>(record.widgetTypes, 'widgetTypes', where);
  }
  if (record.visual !== undefined) {
    slideOnly('visual');
    if (!(VISUAL_REQUIREMENTS as readonly unknown[]).includes(record.visual)) {
      throw new Error(`${where}.visual must be one of: ${VISUAL_REQUIREMENTS.join(', ')}`);
    }
    policy.visual = record.visual as TeachingScenePolicy['visual'];
  }
  // Re-assemble in the received key order so the policy re-serializes exactly.
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(record))
    ordered[key] = (policy as unknown as Record<string, unknown>)[key];
  return ordered as unknown as TeachingScenePolicy;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/** The policy as one compact line for the outline prompt's flow table. */
export function describeScenePolicy(policy: TeachingScenePolicy): string {
  const parts = [`type: ${policy.sceneTypes.join(' or ')}`];
  if (policy.widgetTypes?.length) parts.push(`widgetType: ${policy.widgetTypes.join(' or ')}`);
  if (policy.slideTypes?.length) parts.push(`slideType: ${policy.slideTypes.join(' or ')}`);
  if (policy.contentRoles?.length) {
    parts.push(`contentRole: one of ${policy.contentRoles.join(', ')}`);
  }
  if (policy.visual === 'required') parts.push('visual: required (image or native)');
  if (policy.visual === 'source_grounded') parts.push('visual: textbook-grounded (required)');
  parts.push(`outlines: ${policy.cardinality === 'exactly_one' ? 'exactly one' : 'one or more'}`);
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Deterministic textbook-visual completion (machine repair)
// ---------------------------------------------------------------------------

/** Diagnostic code recorded when a textbook-grounded visual carrier is completed. */
export const SOURCE_VISUAL_NORMALIZED = 'SOURCE_VISUAL_NORMALIZED';

function positionPolicy(
  outline: SceneOutline,
  flow: readonly TeachingFlowEntry[],
): { policy: TeachingScenePolicy | undefined; entry: TeachingFlowEntry | undefined } {
  const position = outline.teachingStage;
  if (
    !position ||
    !Number.isInteger(position.flowIndex) ||
    position.flowIndex < 0 ||
    position.flowIndex >= flow.length ||
    flow[position.flowIndex]!.stage !== position.key
  ) {
    return { policy: undefined, entry: undefined };
  }
  const entry = flow[position.flowIndex]!;
  return { policy: scenePolicyFor(entry), entry };
}

/**
 * Deterministically complete the textbook-visual carrier of every outline at a
 * `visual: source_grounded` position. Content Unit ↔ image associations are
 * authoritative input, so applying them is not a model guess: a linked source
 * image is selected (`visualPlan: image`), otherwise a native diagram is
 * planned, and AI image requests are dropped. Each change is recorded as a
 * `repaired` diagnostic; validation still enforces the result.
 */
export function normalizeSourceGroundedVisuals(
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
  sourceImages: readonly PdfImage[],
): { outlines: SceneOutline[]; repairs: OutlineDiagnostic[] } {
  const orderedImages = sortDocumentImagesForVision([...sourceImages]);
  const imageById = new Map(orderedImages.map((image) => [image.id, image] as const));
  const repairs: OutlineDiagnostic[] = [];

  const normalized = outlines.map((outline, index) => {
    const { policy, entry } = positionPolicy(outline, flow);
    if (outline.type !== 'slide' || policy?.visual !== 'source_grounded') return outline;

    const contentUnitIds = new Set(outline.sourceContentUnitIds ?? []);
    const grounded = orderedImages.filter((image) =>
      (image.sourceContentUnitIds ?? []).some((id) => contentUnitIds.has(id)),
    );
    const suggested = (outline.suggestedImageIds ?? []).filter((id) => imageById.has(id));
    const selectedGrounded = suggested.filter((id) => grounded.some((image) => image.id === id));
    const selectedBookImages = selectedGrounded.length
      ? selectedGrounded
      : grounded.length
        ? [grounded[0]!.id]
        : suggested;
    const nonImageMedia = (outline.mediaGenerations ?? []).filter(
      (request) => request.type !== 'image',
    );
    const {
      mediaGenerations: _discardedMedia,
      suggestedImageIds: _discardedIds,
      ...rest
    } = outline;

    const next: SceneOutline = {
      ...rest,
      visualPlan: { mode: selectedBookImages.length > 0 ? 'image' : 'native' },
      ...(selectedBookImages.length > 0 ? { suggestedImageIds: selectedBookImages } : {}),
      ...(nonImageMedia.length > 0 ? { mediaGenerations: nonImageMedia } : {}),
    };

    const changed =
      outline.visualPlan?.mode !== next.visualPlan?.mode ||
      JSON.stringify(outline.suggestedImageIds ?? []) !==
        JSON.stringify(next.suggestedImageIds ?? []) ||
      (outline.mediaGenerations?.length ?? 0) !== (next.mediaGenerations?.length ?? 0);
    if (changed) {
      repairs.push({
        code: SOURCE_VISUAL_NORMALIZED,
        disposition: 'repaired',
        outlineIndex: index,
        outlineId: outline.id,
        field: 'visualPlan',
        previousValue: {
          visualPlan: outline.visualPlan ?? null,
          suggestedImageIds: outline.suggestedImageIds ?? [],
          aiImageRequests: (outline.mediaGenerations ?? []).filter((r) => r.type === 'image')
            .length,
        },
        message:
          selectedBookImages.length > 0
            ? `the textbook visual ${selectedBookImages.join(', ')} linked to this slide's Content Units was selected as its visual; AI image requests were removed`
            : 'no textbook visual is linked to this slide, so a native diagram built from the source content is planned; AI image requests were removed',
        ...(entry ? { flowIndex: outline.teachingStage!.flowIndex, stage: entry.stage } : {}),
      });
    }
    return next;
  });
  return { outlines: normalized, repairs };
}

// ---------------------------------------------------------------------------
// Flow diagnostics (admin-correctable)
// ---------------------------------------------------------------------------

function sceneTypesPhrase(policy: TeachingScenePolicy): string {
  const types = policy.sceneTypes
    .map((type) =>
      type === 'interactive' && policy.widgetTypes?.length === 1
        ? `interactive ${policy.widgetTypes[0]}`
        : type,
    )
    .join(' or ');
  return policy.cardinality === 'exactly_one' ? `exactly one ${types}` : `${types} scenes`;
}

/**
 * Every Teaching Model Flow violation of a candidate outline list, as
 * admin-correctable diagnostics, in outline order then flow order:
 *
 * - the `teachingStage` carrier: present, in range, and naming the stage at
 *   that index;
 * - the position's scene policy ({@link scenePolicyFor}): scene type, widget
 *   type, slide type, content role (a MISSING or unknown role is reported by the
 *   slide-semantics contract, not twice here), and the visual requirement;
 * - once every carrier is valid: the exact ordered coverage of the flow (no
 *   gap, no reorder, no re-entry) and each `exactly_one` position's count.
 *
 * Run {@link normalizeSourceGroundedVisuals} first so a deterministic carrier
 * completion is not reported as a violation.
 */
export function teachingFlowDiagnostics(
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
  sourceImages: readonly PdfImage[] = [],
): OutlineDiagnostic[] {
  const diagnostics: OutlineDiagnostic[] = [];
  if (outlines.length === 0) {
    return [
      {
        code: 'NO_OUTLINES',
        disposition: 'admin_correctable',
        message: `no outlines were returned for a ${flow.length}-position Teaching Model Flow`,
      },
    ];
  }
  const flowIndices = flow.map((_, index) => index);
  let carriersValid = true;
  const indices: number[] = [];
  const countByFlowIndex = new Map<number, number>();

  for (const [outlineIndex, outline] of outlines.entries()) {
    const label = `outline #${outlineIndex + 1} (${JSON.stringify(outline.id)})`;
    const base = {
      disposition: 'admin_correctable' as const,
      outlineIndex,
      ...(outline.id ? { outlineId: outline.id } : {}),
    };
    const position = outline.teachingStage;
    if (!position) {
      carriersValid = false;
      diagnostics.push({
        ...base,
        code: 'TEACHING_STAGE_MISSING',
        field: 'teachingStage',
        allowedValues: flowIndices,
        message: `${label} must carry teachingStage copied from the authoritative Teaching Model Flow`,
      });
      continue;
    }
    if (
      !Number.isInteger(position.flowIndex) ||
      position.flowIndex < 0 ||
      position.flowIndex >= flow.length
    ) {
      carriersValid = false;
      diagnostics.push({
        ...base,
        code: 'TEACHING_STAGE_INVALID',
        field: 'teachingStage',
        allowedValues: flowIndices,
        message: `${label} has flowIndex ${String(position.flowIndex)} outside 0..${flow.length - 1}`,
      });
      continue;
    }
    const entry = flow[position.flowIndex]!;
    if (position.key !== entry.stage) {
      carriersValid = false;
      diagnostics.push({
        ...base,
        code: 'TEACHING_STAGE_MISMATCH',
        field: 'teachingStage',
        allowedValues: flowIndices,
        flowIndex: position.flowIndex,
        message: `${label} has teachingStage.key ${JSON.stringify(position.key)} but flow[${position.flowIndex}].stage is ${JSON.stringify(entry.stage)}`,
      });
      continue;
    }
    indices.push(position.flowIndex);
    countByFlowIndex.set(position.flowIndex, (countByFlowIndex.get(position.flowIndex) ?? 0) + 1);

    const policy = scenePolicyFor(entry);
    if (!policy) continue;
    const at = { ...base, flowIndex: position.flowIndex, stage: entry.stage };

    if (!policy.sceneTypes.includes(outline.type as TeachingSceneType)) {
      diagnostics.push({
        ...at,
        code: 'SCENE_TYPE_NOT_ALLOWED',
        field: 'type',
        allowedValues: [...policy.sceneTypes],
        message: `${label} covers ${entry.stage} but has type ${JSON.stringify(outline.type)}; this stage requires ${sceneTypesPhrase(policy)}`,
      });
      continue;
    }
    if (
      outline.type === 'interactive' &&
      policy.widgetTypes &&
      !policy.widgetTypes.includes(outline.widgetType as WidgetType)
    ) {
      diagnostics.push({
        ...at,
        code: 'WIDGET_TYPE_NOT_ALLOWED',
        field: 'widgetType',
        allowedValues: [...policy.widgetTypes],
        message: `${label} covers ${entry.stage} but has widgetType ${JSON.stringify(outline.widgetType ?? null)}; this stage requires ${sceneTypesPhrase(policy)}`,
      });
    }
    if (outline.type !== 'slide') continue;

    if (
      policy.slideTypes &&
      isSlideType(outline.slideType) &&
      !policy.slideTypes.includes(outline.slideType)
    ) {
      diagnostics.push({
        ...at,
        code: 'SLIDE_TYPE_NOT_ALLOWED',
        field: 'slideType',
        allowedValues: [...policy.slideTypes],
        message: `${label} covers ${entry.stage} with slideType ${JSON.stringify(outline.slideType)}; this position allows slideType ${policy.slideTypes.join(' or ')}`,
      });
    }
    if (
      policy.contentRoles &&
      isSlideContentRole(outline.contentRole) &&
      !policy.contentRoles.includes(outline.contentRole)
    ) {
      diagnostics.push({
        ...at,
        code: 'CONTENT_ROLE_NOT_ALLOWED',
        field: 'contentRole',
        allowedValues: [...policy.contentRoles],
        message: `${label} covers ${entry.stage} with contentRole ${JSON.stringify(outline.contentRole)}, which this position does not allow; choose one of: ${policy.contentRoles.join(', ')}`,
      });
    }
    if (policy.visual) {
      const mode = outline.visualPlan?.mode;
      if (mode !== 'image' && mode !== 'native') {
        diagnostics.push({
          ...at,
          code: 'VISUAL_REQUIRED',
          field: 'visualPlan',
          allowedValues: [...VISUAL_MODES],
          message: `${label} covers ${entry.stage}, which requires a meaningful visual; visualPlan.mode must be "image" or "native"`,
        });
      }
    }
    if (policy.visual === 'source_grounded') {
      diagnostics.push(...sourceGroundedVisualDiagnostics(outline, label, at, sourceImages));
    }
  }

  if (!carriersValid) return diagnostics;

  const collapsed = indices.filter((value, index) => index === 0 || value !== indices[index - 1]);
  if (
    collapsed.length !== flowIndices.length ||
    collapsed.some((value, index) => value !== flowIndices[index])
  ) {
    diagnostics.push({
      code: 'FLOW_SEQUENCE_INVALID',
      disposition: 'admin_correctable',
      field: 'teachingStage',
      allowedValues: flowIndices,
      message: `outline teachingStage sequence must cover the exact flow in order (collapsed [${collapsed.join(', ')}], expected [${flowIndices.join(', ')}])`,
    });
  }
  for (const [flowIndex, entry] of flow.entries()) {
    const policy = scenePolicyFor(entry);
    if (policy?.cardinality === 'exactly_one' && countByFlowIndex.get(flowIndex) !== 1) {
      diagnostics.push({
        code: 'POSITION_CARDINALITY',
        disposition: 'admin_correctable',
        field: 'teachingStage',
        flowIndex,
        stage: entry.stage,
        message: `flow[${flowIndex}] stage ${JSON.stringify(entry.stage)} requires exactly one outline, received ${countByFlowIndex.get(flowIndex) ?? 0}`,
      });
    }
  }
  return diagnostics;
}

function sourceGroundedVisualDiagnostics(
  outline: SceneOutline,
  label: string,
  at: Pick<OutlineDiagnostic, 'disposition' | 'outlineIndex' | 'outlineId' | 'flowIndex' | 'stage'>,
  sourceImages: readonly PdfImage[],
): OutlineDiagnostic[] {
  const stage = at.stage;
  if (outline.mediaGenerations?.some((request) => request.type === 'image')) {
    return [
      {
        ...at,
        code: 'AI_IMAGE_NOT_ALLOWED',
        field: 'mediaGenerations',
        message: `${label} covers ${stage} but requests an AI-generated image; its visual must come from the authoritative textbook, or be a native diagram grounded only in the textbook content`,
      },
    ];
  }
  const contentUnitIds = new Set(outline.sourceContentUnitIds ?? []);
  const groundedBookImages = sourceImages.filter((image) =>
    (image.sourceContentUnitIds ?? []).some((id) => contentUnitIds.has(id)),
  );
  const suggested = new Set(outline.suggestedImageIds ?? []);
  const selectedBookImages = sourceImages.filter((image) => suggested.has(image.id));
  if (groundedBookImages.length > 0) {
    const selectedGrounded = groundedBookImages.some((image) => suggested.has(image.id));
    if (outline.visualPlan?.mode !== 'image' || !selectedGrounded) {
      return [
        {
          ...at,
          code: 'SOURCE_VISUAL_NOT_SELECTED',
          field: 'suggestedImageIds',
          allowedValues: groundedBookImages.map((image) => image.id),
          message: `${label} has a textbook visual linked to the same Content Unit but did not select it; set visualPlan.mode "image" and include at least one matching id in suggestedImageIds`,
        },
      ];
    }
  } else if (selectedBookImages.length > 0) {
    if (outline.visualPlan?.mode !== 'image') {
      return [
        {
          ...at,
          code: 'VISUAL_MODE_MISMATCH',
          field: 'visualPlan',
          allowedValues: ['image'],
          message: `${label} selected a textbook visual but visualPlan.mode is not "image"`,
        },
      ];
    }
  } else if (outline.visualPlan?.mode !== 'native') {
    return [
      {
        ...at,
        code: 'VISUAL_MODE_MISMATCH',
        field: 'visualPlan',
        allowedValues: ['native'],
        message: `${label} has no selected textbook visual; use visualPlan.mode "native" so the slide is visualised only from its authoritative source content`,
      },
    ];
  }
  return [];
}

/**
 * Narrow the allowed values of semantics diagnostics (`contentRole`,
 * `slideType`) to what the outline's flow position permits, so a person is
 * offered only values that can pass. Diagnostics without a valid position are
 * returned unchanged.
 */
export function narrowDiagnosticsToPositionPolicy(
  diagnostics: readonly OutlineDiagnostic[],
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
): OutlineDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.outlineIndex === undefined) return diagnostic;
    const outline = outlines[diagnostic.outlineIndex];
    if (!outline) return diagnostic;
    const { policy } = positionPolicy(outline, flow);
    if (diagnostic.field === 'contentRole' && policy?.contentRoles) {
      return { ...diagnostic, allowedValues: [...policy.contentRoles] };
    }
    if (diagnostic.field === 'slideType' && policy?.slideTypes) {
      return { ...diagnostic, allowedValues: [...policy.slideTypes] };
    }
    return diagnostic;
  });
}
