/**
 * Admin correction of a paused Teaching Package candidate
 * (slide-classification-admin-correction-plan §2.4, §3).
 *
 * ONE diagnosis serves the run, an administrator's edit and the revalidation
 * before a resume: the generation package's `analyzeOutlines` (classification
 * repair + contract, runtime-scene config, Teaching Model Flow position
 * policy) plus the two checks that need app authority — Content-Unit grounding
 * against the exact id set the run used, and Teaching Skill selections against
 * the flow's Skill Policies. Everything reported here is admin-correctable;
 * execution failures (provider outage, unresolvable authority) never reach it.
 *
 * Edits are a constrained operation list (`set` on a whitelisted field,
 * `remove`, `move`) — never a free-form document write — so a person can only
 * choose among values the policy names, and every edit is revalidated before
 * it is stored.
 */
import {
  SLIDE_CONTENT_KINDS,
  SLIDE_CONTENT_KINDS_BY_ROLE,
  SLIDE_CONTENT_ROLES,
  SLIDE_TYPES,
} from '@openmaic/dsl';
import {
  analyzeOutlines,
  blockingOutlineDiagnostics,
  scenePolicyFor,
  type OutlineDiagnostic,
  type PdfImage,
  type TeachingScenePolicy,
} from '@openmaic/generation';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { KAFUO_DEFERRED_WIDGET_TYPES } from '@/lib/server/teaching-package/kafuo-game-deferral';
import { findUngroundedOutlines } from '@/lib/server/teaching-package/outline-grounding';
import { findOutlineSkillSelectionIssues } from '@/lib/server/teaching-package/skill-policy';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationAttempt,
  GenerationCheckpoint,
  GenerationCheckpointPhase,
  GenerationCheckpointSourceRefs,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

// ---------------------------------------------------------------------------
// The pause signal
// ---------------------------------------------------------------------------

/** What a paused run hands the runner to persist as its checkpoint. */
export interface CorrectionCandidate {
  phase: GenerationCheckpointPhase;
  outlines: SceneOutline[];
  courseTitle: string | null;
  languageDirective: string;
  /** Open admin-correctable findings (never empty for a pause). */
  diagnostics: OutlineDiagnostic[];
  /** Machine repairs applied to the candidate. */
  repairs: OutlineDiagnostic[];
  /** `scenes` phase: the retained, unbound Stage and the outlines to regenerate. */
  reservedStageId?: string;
  pendingOutlineIds?: string[];
}

/**
 * Thrown by `generateClassroom` when a candidate needs a person. It is the
 * opposite of a failure: nothing is compensated and the attempt pauses.
 */
export class GenerationCorrectionRequiredError extends Error {
  readonly code = 'GENERATION_CORRECTION_REQUIRED';
  constructor(readonly candidate: CorrectionCandidate) {
    super(
      `generation paused for admin correction: ${candidate.diagnostics.length} issue(s) in the ${candidate.phase} phase`,
    );
    this.name = 'GenerationCorrectionRequiredError';
  }
}

/**
 * Diagnostic `field` of a `scenes`-phase finding about a generated Scene (not
 * its outline): the resume itself resolves it by regenerating that Scene, so it
 * never blocks a resume on its own.
 */
export const SCENE_REGENERATION_FIELD = 'scene';

export function isGenerationCorrectionRequired(
  error: unknown,
): error is GenerationCorrectionRequiredError {
  return error instanceof GenerationCorrectionRequiredError;
}

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export interface OutlineDiagnosisContext {
  flow: readonly TeachingFlowEntry[];
  /** The exact Content Unit id set the grounding gate uses; `null` = no gate. */
  contentUnitIds: readonly string[] | null;
  /** The approved source visuals offered to the planner (metadata suffices). */
  sourceImages: readonly PdfImage[];
  /** Governed by Teaching Skills: Skill selections are checked. */
  governed: boolean;
  /** Test seam for the canonical Skill registry directory. */
  skillsDir?: string;
}

const positionLabel = (flow: readonly TeachingFlowEntry[], outline: SceneOutline | undefined) => {
  const position = outline?.teachingStage;
  return position && flow[position.flowIndex]?.stage === position.key
    ? { flowIndex: position.flowIndex, stage: position.key }
    : {};
};

/**
 * The app-authority outline findings as admin-correctable diagnostics:
 * Content-Unit grounding and (governed runs) Teaching Skill selections.
 * Numeric Content Unit ids are normalised to strings in place, exactly as the
 * grounding gate always did.
 */
export function appOutlineDiagnostics(
  outlines: SceneOutline[],
  context: OutlineDiagnosisContext,
): OutlineDiagnostic[] {
  const diagnostics: OutlineDiagnostic[] = [];
  const indexById = new Map(outlines.map((outline, index) => [outline.id, index] as const));

  if (context.contentUnitIds) {
    for (const outline of outlines) {
      if (Array.isArray(outline.sourceContentUnitIds)) {
        outline.sourceContentUnitIds = outline.sourceContentUnitIds.map((id) => String(id));
      }
    }
    const unitIds = new Set(context.contentUnitIds.map(String));
    for (const entry of findUngroundedOutlines(outlines, unitIds)) {
      const outline = outlines[entry.index];
      const unknown = entry.reasons.some((reason) => reason.startsWith('unknown'));
      diagnostics.push({
        code: unknown ? 'GROUNDING_UNKNOWN' : 'GROUNDING_MISSING',
        disposition: 'admin_correctable',
        outlineIndex: entry.index,
        ...(outline?.id ? { outlineId: outline.id } : {}),
        field: 'sourceContentUnitIds',
        allowedValues: [...unitIds],
        message: `outline #${entry.index + 1} is not grounded in the approved source: ${entry.reasons.join('; ')}`,
        ...positionLabel(context.flow, outline),
      });
    }
  }

  if (context.governed) {
    const flow = context.flow as TeachingFlowEntry[];
    const issues = context.skillsDir
      ? findOutlineSkillSelectionIssues(outlines, flow, context.skillsDir)
      : findOutlineSkillSelectionIssues(outlines, flow);
    for (const issue of issues) {
      const details = (issue.details ?? {}) as {
        offendingSceneIds?: string[];
        flowIndex?: number;
      };
      const ids = details.offendingSceneIds?.length ? details.offendingSceneIds : [undefined];
      for (const outlineId of ids) {
        const outlineIndex = outlineId !== undefined ? indexById.get(outlineId) : undefined;
        const flowIndex =
          details.flowIndex ??
          (outlineIndex !== undefined
            ? outlines[outlineIndex]?.teachingStage?.flowIndex
            : undefined);
        const policy = flowIndex !== undefined ? context.flow[flowIndex]?.skillPolicy : undefined;
        diagnostics.push({
          code: issue.code,
          disposition: 'admin_correctable',
          ...(outlineIndex !== undefined ? { outlineIndex } : {}),
          ...(outlineId !== undefined ? { outlineId } : {}),
          field: 'teachingSkills',
          message: issue.message,
          ...(policy
            ? { allowedValues: policy.allowed.map((ref) => `${ref.skillId}@${ref.version}`) }
            : {}),
          ...(flowIndex !== undefined ? { flowIndex, stage: context.flow[flowIndex]?.stage } : {}),
        });
      }
    }
  }
  return diagnostics;
}

export interface CandidateDiagnosis {
  outlines: SceneOutline[];
  repairs: OutlineDiagnostic[];
  blocking: OutlineDiagnostic[];
}

/** The ONE diagnosis of a candidate outline list (package analysis + app authority). */
export function diagnoseCandidateOutlines(
  outlines: readonly SceneOutline[],
  context: OutlineDiagnosisContext,
): CandidateDiagnosis {
  const analysis = analyzeOutlines(outlines, {
    teachingFlow: context.flow,
    sourceImages: context.sourceImages,
    // Correction exists only for Kafuo attempts: Kafuo Release 1 defers games,
    // so an edit that plans one is reported and blocks the resume.
    prohibitedWidgetTypes: KAFUO_DEFERRED_WIDGET_TYPES,
  });
  const normalized = analysis.outlines.map((outline, index) => ({ ...outline, order: index + 1 }));
  return {
    outlines: normalized,
    repairs: analysis.repairs,
    blocking: [
      ...blockingOutlineDiagnostics(analysis),
      ...appOutlineDiagnostics(normalized, context),
    ],
  };
}

/** The diagnosis context a checkpoint pins (metadata only — no bytes). */
export function diagnosisContextFromCheckpoint(
  checkpoint: Pick<GenerationCheckpoint, 'sourceRefs'>,
  flow: readonly TeachingFlowEntry[],
  governed: boolean,
): OutlineDiagnosisContext {
  return {
    flow,
    contentUnitIds: checkpoint.sourceRefs.contentUnitIds,
    sourceImages: checkpoint.sourceRefs.sourceImages.map((image) => ({
      id: image.id,
      src: '',
      pageNumber: image.pageNumber ?? 0,
      ...(image.sourceContentUnitIds ? { sourceContentUnitIds: image.sourceContentUnitIds } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
      ...(image.figureLabel ? { figureLabel: image.figureLabel } : {}),
      ...(image.description ? { description: image.description } : {}),
    })),
    governed,
  };
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

/** Fields a person may set while the candidate is still an outline plan. */
export const OUTLINE_PHASE_EDITABLE_FIELDS = [
  'contentRole',
  'contentKind',
  'slideType',
  'teachingStage',
  'sourceContentUnitIds',
  'visualPlan',
  'suggestedImageIds',
  'type',
  'widgetType',
  'teachingSkills',
] as const;

/**
 * Fields a person may set on a PENDING outline once Scenes exist: the outline's
 * classification and visual, never its flow position or scene type (those
 * would desynchronise it from the retained Scenes around it).
 */
export const SCENES_PHASE_EDITABLE_FIELDS = [
  'contentRole',
  'contentKind',
  'slideType',
  'visualPlan',
  'teachingSkills',
] as const;

export type CorrectionField = (typeof OUTLINE_PHASE_EDITABLE_FIELDS)[number];

export type CorrectionOperation =
  | { op: 'set'; outlineId: string; field: CorrectionField; value: unknown }
  | { op: 'remove'; outlineId: string }
  | { op: 'move'; outlineId: string; toIndex: number };

const MAX_OPERATIONS = 50;
const SCENE_TYPES = ['slide', 'quiz', 'interactive', 'pbl'] as const;
const VISUAL_MODES = ['image', 'native', 'omitted'] as const;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new TeachingPackageError('INVALID_REQUEST', message, details);
}

function stringList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    invalid(`${field} must be an array of at most ${max} ids`);
  }
  return value.map((entry) => {
    if ((typeof entry !== 'string' && typeof entry !== 'number') || String(entry).trim() === '') {
      invalid(`${field} must contain non-empty ids`);
    }
    return String(entry);
  });
}

function skillRef(value: unknown, field: string): { skillId: string; version: string } {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (
    !record ||
    typeof record.skillId !== 'string' ||
    record.skillId.trim() === '' ||
    typeof record.version !== 'string' ||
    record.version.trim() === ''
  ) {
    invalid(`${field} must be { skillId, version }`);
  }
  return { skillId: record.skillId as string, version: record.version as string };
}

/** Parse and shape-check the request's operation list. */
export function parseCorrectionOperations(raw: unknown): CorrectionOperation[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPERATIONS) {
    invalid(`operations must be a non-empty array of at most ${MAX_OPERATIONS} operations`);
  }
  return raw.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!record || typeof record.outlineId !== 'string' || record.outlineId.trim() === '') {
      invalid(`operations[${index}] must name an outlineId`);
    }
    const outlineId = record.outlineId as string;
    if (record.op === 'remove') return { op: 'remove', outlineId };
    if (record.op === 'move') {
      if (!Number.isInteger(record.toIndex))
        invalid(`operations[${index}].toIndex must be an integer`);
      return { op: 'move', outlineId, toIndex: record.toIndex as number };
    }
    if (record.op === 'set') {
      if (!(OUTLINE_PHASE_EDITABLE_FIELDS as readonly unknown[]).includes(record.field)) {
        invalid(`operations[${index}].field is not editable`, {
          editableFields: [...OUTLINE_PHASE_EDITABLE_FIELDS],
        });
      }
      if (!('value' in record)) invalid(`operations[${index}].value is required (null clears)`);
      return { op: 'set', outlineId, field: record.field as CorrectionField, value: record.value };
    }
    invalid(`operations[${index}].op must be "set", "remove" or "move"`);
  });
}

export interface CorrectionEditContext {
  phase: GenerationCheckpointPhase;
  flow: readonly TeachingFlowEntry[];
  sourceRefs: GenerationCheckpointSourceRefs;
  pendingOutlineIds: readonly string[] | null;
}

function setField(
  outline: SceneOutline,
  field: CorrectionField,
  value: unknown,
  context: CorrectionEditContext,
): SceneOutline {
  const next = { ...outline } as SceneOutline & Record<string, unknown>;
  const clear = value === null;
  switch (field) {
    case 'contentRole':
      if (!clear && !(SLIDE_CONTENT_ROLES as readonly unknown[]).includes(value)) {
        invalid(`contentRole must be one of: ${SLIDE_CONTENT_ROLES.join(', ')}`);
      }
      break;
    case 'contentKind':
      if (!clear && !(SLIDE_CONTENT_KINDS as readonly unknown[]).includes(value)) {
        invalid(`contentKind must be one of: ${SLIDE_CONTENT_KINDS.join(', ')} (or null)`);
      }
      break;
    case 'slideType':
      if (!clear && !(SLIDE_TYPES as readonly unknown[]).includes(value)) {
        invalid(`slideType must be one of: ${SLIDE_TYPES.join(', ')}`);
      }
      break;
    case 'type':
      if (clear || !(SCENE_TYPES as readonly unknown[]).includes(value)) {
        invalid(`type must be one of: ${SCENE_TYPES.join(', ')}`);
      }
      break;
    case 'widgetType':
      if (!clear && (typeof value !== 'string' || value.trim() === '' || value.length > 40)) {
        invalid('widgetType must be a short string (or null)');
      }
      break;
    case 'teachingStage': {
      if (
        !Number.isInteger(value) ||
        (value as number) < 0 ||
        (value as number) >= context.flow.length
      ) {
        invalid(`teachingStage must be a flow index 0..${context.flow.length - 1}`);
      }
      const flowIndex = value as number;
      next.teachingStage = { key: context.flow[flowIndex]!.stage, flowIndex };
      return next;
    }
    case 'sourceContentUnitIds': {
      const ids = stringList(value, 'sourceContentUnitIds', 50);
      const known = context.sourceRefs.contentUnitIds;
      if (known && ids.some((id) => !known.includes(id))) {
        invalid('sourceContentUnitIds may only name Content Units of the approved source');
      }
      next.sourceContentUnitIds = ids;
      return next;
    }
    case 'suggestedImageIds': {
      if (clear) {
        delete next.suggestedImageIds;
        return next;
      }
      const ids = stringList(value, 'suggestedImageIds', 10);
      const approved = new Set(context.sourceRefs.sourceImages.map((image) => image.id));
      if (ids.some((id) => !approved.has(id))) {
        invalid('suggestedImageIds may only name approved source visuals');
      }
      next.suggestedImageIds = ids;
      return next;
    }
    case 'visualPlan': {
      if (clear) {
        delete next.visualPlan;
        return next;
      }
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      if (!record || !(VISUAL_MODES as readonly unknown[]).includes(record.mode)) {
        invalid(`visualPlan.mode must be one of: ${VISUAL_MODES.join(', ')}`);
      }
      const reason = record.omissionReason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
        invalid('visualPlan.omissionReason must be a string of at most 500 characters');
      }
      next.visualPlan = {
        mode: record.mode as 'image' | 'native' | 'omitted',
        ...(typeof reason === 'string' ? { omissionReason: reason } : {}),
      } as SceneOutline['visualPlan'];
      return next;
    }
    case 'teachingSkills': {
      if (clear) {
        delete next.teachingSkills;
        return next;
      }
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      if (!record) invalid('teachingSkills must be an object (or null)');
      const classification = record.classification;
      if (
        classification !== undefined &&
        classification !== 'instructional' &&
        classification !== 'non-instructional'
      ) {
        invalid('teachingSkills.classification must be "instructional" or "non-instructional"');
      }
      const supporting = record.supporting;
      if (supporting !== undefined && (!Array.isArray(supporting) || supporting.length > 5)) {
        invalid('teachingSkills.supporting must be an array of at most 5 refs');
      }
      next.teachingSkills = {
        ...(classification !== undefined
          ? { classification: classification as 'instructional' | 'non-instructional' }
          : {}),
        ...(record.primary !== undefined && record.primary !== null
          ? { primary: skillRef(record.primary, 'teachingSkills.primary') }
          : {}),
        ...(Array.isArray(supporting)
          ? {
              supporting: supporting.map((ref, i) =>
                skillRef(ref, `teachingSkills.supporting[${i}]`),
              ),
            }
          : {}),
      };
      return next;
    }
  }
  const record = next as Record<string, unknown>;
  if (clear) delete record[field];
  else record[field] = value;
  return next;
}

/**
 * Apply an operation list to the candidate, in order. Throws `INVALID_REQUEST`
 * for an operation the phase or the policy vocabulary does not allow. The
 * result is NOT yet validated: the caller runs {@link diagnoseCandidateOutlines}.
 */
export function applyCorrectionOperations(
  outlines: readonly SceneOutline[],
  operations: readonly CorrectionOperation[],
  context: CorrectionEditContext,
): SceneOutline[] {
  let next = outlines.map((outline) => ({ ...outline }));
  const pending = new Set(context.pendingOutlineIds ?? []);
  for (const [index, operation] of operations.entries()) {
    const position = next.findIndex((outline) => outline.id === operation.outlineId);
    if (position < 0) {
      invalid(
        `operations[${index}] names an unknown outline ${JSON.stringify(operation.outlineId)}`,
      );
    }
    if (context.phase === 'scenes') {
      if (operation.op !== 'set') {
        invalid('Scenes already exist: outlines can no longer be removed or reordered');
      }
      if (!pending.has(operation.outlineId)) {
        invalid(
          `outline ${JSON.stringify(operation.outlineId)} already has a valid Scene; only the outlines being regenerated may be edited`,
        );
      }
      if (!(SCENES_PHASE_EDITABLE_FIELDS as readonly string[]).includes(operation.field)) {
        invalid(`field ${operation.field} cannot change once Scenes exist`, {
          editableFields: [...SCENES_PHASE_EDITABLE_FIELDS],
        });
      }
    }
    if (operation.op === 'remove') {
      if (next.length === 1) invalid('the last outline cannot be removed');
      next = next.filter((_, i) => i !== position);
      continue;
    }
    if (operation.op === 'move') {
      if (operation.toIndex < 0 || operation.toIndex >= next.length) {
        invalid(`operations[${index}].toIndex must be within 0..${next.length - 1}`);
      }
      const [moved] = next.splice(position, 1);
      next.splice(operation.toIndex, 0, moved!);
      continue;
    }
    next[position] = setField(next[position]!, operation.field, operation.value, context);
  }
  return next.map((outline, index) => ({ ...outline, order: index + 1 }));
}

// ---------------------------------------------------------------------------
// The administrator's view
// ---------------------------------------------------------------------------

export interface CorrectionFlowPosition {
  flowIndex: number;
  stage: string;
  instructions: string;
  /** The policy enforced at this position, and where it comes from. */
  policy: TeachingScenePolicy | null;
  policySource: 'teaching_model' | 'legacy_stage_rule' | 'none';
  allowedSkills: string[];
}

export interface CorrectionView {
  attemptId: string;
  attemptStatus: GenerationAttempt['status'];
  teachingModel: GenerationAttempt['teachingModel'];
  phase: GenerationCheckpointPhase;
  state: GenerationCheckpoint['state'];
  revision: number;
  canResume: boolean;
  pausedAt: number;
  updatedAt: number;
  pendingOutlineIds: string[] | null;
  editableFields: string[];
  outlines: Array<Record<string, unknown>>;
  blockingIssues: GenerationCheckpoint['diagnostics'];
  repairs: GenerationCheckpoint['repairs'];
  flow: CorrectionFlowPosition[];
  choices: {
    sceneTypes: readonly string[];
    slideTypes: readonly string[];
    contentRoles: readonly string[];
    contentKindsByRole: Readonly<Record<string, readonly string[]>>;
    visualModes: readonly string[];
    contentUnits: GenerationCheckpointSourceRefs['contentUnits'];
    images: Array<{
      id: string;
      pageNumber: number | null;
      caption?: string;
      figureLabel?: string;
      sourceContentUnitIds?: string[];
    }>;
  };
  editLog: GenerationCheckpoint['editLog'];
}

/** The admin read model of a paused attempt (no source text, no URL, no bytes). */
export function buildCorrectionView(
  attempt: GenerationAttempt,
  checkpoint: GenerationCheckpoint,
  flow: readonly TeachingFlowEntry[],
): CorrectionView {
  const pending = new Set(checkpoint.pendingOutlineIds ?? []);
  return {
    attemptId: attempt.id,
    attemptStatus: attempt.status,
    teachingModel: attempt.teachingModel,
    phase: checkpoint.phase,
    state: checkpoint.state,
    revision: checkpoint.revision,
    // Mirrors the resume's own gate: outline-level findings block; a `scenes`
    // finding is resolved by the resume regenerating that Scene.
    canResume:
      checkpoint.state === 'awaiting' &&
      attempt.status === 'awaiting_admin_correction' &&
      checkpoint.diagnostics.every((diagnostic) => diagnostic.field === SCENE_REGENERATION_FIELD),
    pausedAt: checkpoint.pausedAt,
    updatedAt: checkpoint.updatedAt,
    pendingOutlineIds: checkpoint.pendingOutlineIds,
    editableFields: [
      ...(checkpoint.phase === 'scenes'
        ? SCENES_PHASE_EDITABLE_FIELDS
        : OUTLINE_PHASE_EDITABLE_FIELDS),
    ],
    outlines: checkpoint.outlines.map((outline, index) => ({
      index,
      id: outline.id,
      title: outline.title,
      description: outline.description,
      keyPoints: outline.keyPoints,
      type: outline.type,
      slideType: outline.slideType ?? null,
      contentRole: outline.contentRole ?? null,
      contentKind: outline.contentKind ?? null,
      teachingStage: outline.teachingStage ?? null,
      sourceContentUnitIds: outline.sourceContentUnitIds ?? null,
      visualPlan: outline.visualPlan ?? null,
      suggestedImageIds: outline.suggestedImageIds ?? null,
      widgetType: outline.widgetType ?? null,
      teachingSkills: outline.teachingSkills ?? null,
      editable: checkpoint.phase === 'outline' || pending.has(outline.id),
    })),
    blockingIssues: checkpoint.diagnostics,
    repairs: checkpoint.repairs,
    flow: flow.map((entry, flowIndex) => {
      const policy = scenePolicyFor(entry) ?? null;
      return {
        flowIndex,
        stage: entry.stage,
        instructions: entry.instructions,
        policy,
        policySource: entry.scenePolicy ? 'teaching_model' : policy ? 'legacy_stage_rule' : 'none',
        allowedSkills: (entry.skillPolicy?.allowed ?? []).map(
          (ref) => `${ref.skillId}@${ref.version}`,
        ),
      };
    }),
    choices: {
      sceneTypes: SCENE_TYPES,
      slideTypes: SLIDE_TYPES,
      contentRoles: SLIDE_CONTENT_ROLES,
      contentKindsByRole: SLIDE_CONTENT_KINDS_BY_ROLE,
      visualModes: VISUAL_MODES,
      contentUnits: checkpoint.sourceRefs.contentUnits,
      images: checkpoint.sourceRefs.sourceImages.map((image) => ({
        id: image.id,
        pageNumber: image.pageNumber,
        ...(image.caption ? { caption: image.caption } : {}),
        ...(image.figureLabel ? { figureLabel: image.figureLabel } : {}),
        ...(image.sourceContentUnitIds ? { sourceContentUnitIds: image.sourceContentUnitIds } : {}),
      })),
    },
    editLog: checkpoint.editLog.slice(-50),
  };
}
