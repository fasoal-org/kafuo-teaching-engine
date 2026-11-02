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
 * `remove`, `move`, `insert_book_slide`) — never a free-form document write — so a person can only
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
  VISUAL_TEACHING_NOTE_MISSING,
  type OutlineDiagnostic,
  type PdfImage,
  type TeachingScenePolicy,
} from '@openmaic/generation';

import {
  findBookCoverageDiagnostics,
  findBookCoverageGaps,
  requireEssentialUntypedUnits,
  teacherParityBook,
  type BookCoverageGap,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import { instructionFor } from '@/lib/server/teaching-package/book-coverage-repair';
import { checkItemLabels } from '@/lib/server/teaching-package/hidden-step-types';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { KAFUO_DEFERRED_WIDGET_TYPES } from '@/lib/server/teaching-package/kafuo-game-deferral';
import { findUngroundedOutlines } from '@/lib/server/teaching-package/outline-grounding';
import { findOutlineSkillSelectionIssues } from '@/lib/server/teaching-package/skill-policy';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationAttempt,
  GenerationCheckpoint,
  GenerationCheckpointLogEntry,
  GenerationCheckpointPhase,
  GenerationCheckpointSourceRefs,
  KafuoBookStructure,
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
  /**
   * g5.v7: the book map whose required elements must each have a slide. A
   * g5.v8 attempt's map is marked `teacherParity` (`teacherParityBook`).
   */
  bookStructure?: CoverageBookStructure;
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
  // g5.v7: a required book element without its slide (P-6). Here, in the one
  // app-authority diagnosis, so a correction edit re-checks it like the runner.
  diagnostics.push(...findBookCoverageDiagnostics(outlines, context.bookStructure));
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
    // Restored after the W6 review: a non-check Kafuo quiz still needs gradable keys.
    keyedQuizzesOnly: true,
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

/**
 * The coverage book a correction re-checks against: the pinned map, its
 * essential untyped units required, and — only for a g5.v8 attempt — the
 * teacher-parity mark with the unit facts the run pinned.
 */
export function correctionCoverageBook(
  sourceRefs: Pick<GenerationCheckpointSourceRefs, 'essentialContentUnitIds' | 'bookUnitFacts'>,
  bookStructure: KafuoBookStructure | undefined,
  teachingModel: { key: string; version: string } | undefined,
): CoverageBookStructure | undefined {
  return teacherParityBook(
    requireEssentialUntypedUnits(bookStructure, sourceRefs.essentialContentUnitIds),
    teachingModel,
    sourceRefs.bookUnitFacts,
  );
}

/** The diagnosis context a checkpoint pins (metadata only — no bytes). */
export function diagnosisContextFromCheckpoint(
  checkpoint: Pick<GenerationCheckpoint, 'sourceRefs'>,
  flow: readonly TeachingFlowEntry[],
  governed: boolean,
  bookStructure?: KafuoBookStructure,
  teachingModel?: { key: string; version: string },
): OutlineDiagnosisContext {
  const coverageBook = correctionCoverageBook(checkpoint.sourceRefs, bookStructure, teachingModel);
  return {
    ...(coverageBook ? { bookStructure: coverageBook } : {}),
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
  | { op: 'move'; outlineId: string; toIndex: number }
  /**
   * Add the solution slide a book check is missing, right after its try-it
   * slide (`outlineId`). The server builds the outline from the gap the
   * diagnosis itself finds — no model call; the resume writes the Scene.
   */
  | { op: 'insert_book_slide'; outlineId: string; unitId: string; title?: string }
  /**
   * A person accepts one open issue as it is (owner decision, 1 Nov 2026): it
   * no longer blocks the edit, the resume or the resumed run's outline gate.
   * Recorded in the edit log, which is where it is read back from.
   */
  | {
      op: 'ignore_issue';
      issueKey: string;
      /** Filled by the server from the open issue, for the record (never trusted from the request). */
      message?: string;
    };

/**
 * One diagnostic's identity across diagnoses. An issue about a slide is its
 * code, slide id and field — never its index or wording, which change when a
 * slide is added or a repair runs. An issue about the whole outline (a book
 * coverage gap) is told apart by its message, which names the book element.
 */
export function diagnosticKey(diagnostic: OutlineDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.outlineId ?? null,
    diagnostic.field ?? null,
    diagnostic.outlineId ? null : diagnostic.message.replace(/#\d+/g, '#'),
  ]);
}

/**
 * Issues an ignore would only postpone: the run still generates every Scene,
 * then the exact-flow check fails the attempt (review, 1 Nov 2026). They are
 * fixed with remove / move / teaching stage instead.
 */
const NOT_IGNORABLE_CODES: ReadonlySet<string> = new Set([
  'TEACHING_STAGE_MISSING',
  'TEACHING_STAGE_MISMATCH',
  'TEACHING_STAGE_INVALID',
  'POSITION_CARDINALITY',
  'FLOW_SEQUENCE_INVALID',
  'SCENE_CONFIG_INVALID',
  'WIDGET_TYPE_PROHIBITED',
  'NO_OUTLINES',
]);

/**
 * Whether a person may ignore an issue: not a structure/order issue, and not
 * one that never blocks a resume anyway (a missing visual note, a Scene the
 * resume regenerates).
 */
export function isIgnorableIssue(diagnostic: OutlineDiagnostic): boolean {
  return (
    !NOT_IGNORABLE_CODES.has(diagnostic.code) &&
    diagnostic.field !== 'teachingStage' &&
    diagnostic.field !== SCENE_REGENERATION_FIELD &&
    diagnostic.code !== VISUAL_TEACHING_NOTE_MISSING
  );
}

/** The issue keys a person has ignored on this checkpoint, from its edit log. */
export function ignoredIssueKeys(
  editLog: readonly GenerationCheckpointLogEntry[],
  operations: readonly CorrectionOperation[] = [],
): Set<string> {
  const keys = new Set<string>();
  const ops = [...editLog.flatMap((entry) => entry.operations ?? []), ...operations];
  for (const op of ops) {
    const record = op && typeof op === 'object' ? (op as Record<string, unknown>) : null;
    if (record?.op === 'ignore_issue' && typeof record.issueKey === 'string') {
      keys.add(record.issueKey);
    }
  }
  return keys;
}

export function withoutIgnoredIssues<T extends OutlineDiagnostic>(
  diagnostics: readonly T[],
  ignored: ReadonlySet<string>,
): T[] {
  return ignored.size === 0
    ? [...diagnostics]
    : diagnostics.filter((diagnostic) => !ignored.has(diagnosticKey(diagnostic)));
}

const MAX_INSERTED_TITLE = 120;

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
    if (record?.op === 'ignore_issue') {
      if (typeof record.issueKey !== 'string' || record.issueKey.trim() === '') {
        invalid(`operations[${index}].issueKey must name an open issue`);
      }
      return { op: 'ignore_issue', issueKey: record.issueKey as string };
    }
    if (!record || typeof record.outlineId !== 'string' || record.outlineId.trim() === '') {
      invalid(`operations[${index}] must name an outlineId`);
    }
    const outlineId = record.outlineId as string;
    if (record.op === 'remove') return { op: 'remove', outlineId };
    if (record.op === 'insert_book_slide') {
      if (typeof record.unitId !== 'string' || record.unitId.trim() === '') {
        invalid(`operations[${index}].unitId must name the book check's Content Unit`);
      }
      const title = record.title;
      if (
        title !== undefined &&
        title !== null &&
        (typeof title !== 'string' || title.trim() === '' || title.length > MAX_INSERTED_TITLE)
      ) {
        invalid(
          `operations[${index}].title must be a non-empty string of at most ${MAX_INSERTED_TITLE} characters`,
        );
      }
      return {
        op: 'insert_book_slide',
        outlineId,
        unitId: record.unitId as string,
        ...(typeof title === 'string' ? { title: title.trim() } : {}),
      };
    }
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
    invalid(
      `operations[${index}].op must be "set", "remove", "move", "insert_book_slide" or "ignore_issue"`,
    );
  });
}

export interface CorrectionEditContext {
  phase: GenerationCheckpointPhase;
  flow: readonly TeachingFlowEntry[];
  sourceRefs: GenerationCheckpointSourceRefs;
  pendingOutlineIds: readonly string[] | null;
  /** The book map the diagnosis checks coverage against (`insert_book_slide`). */
  bookStructure?: CoverageBookStructure;
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
      // A section the plan left untaught is not taught by citing it from a slide
      // written about something else: it is restored after generation with
      // "Generate slide", which builds the slide from the section's own text.
      const gaps = new Set(context.sourceRefs.coverageGapUnitIds ?? []);
      const added = ids.filter(
        (id) => gaps.has(id) && !(outline.sourceContentUnitIds ?? []).map(String).includes(id),
      );
      if (added.length > 0) {
        invalid(
          'an essential section the plan did not teach cannot be attached to an existing slide; generate a slide for it after generation',
          { unitIds: added },
        );
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
      // An image the administrator newly chose has no teaching note yet: only
      // the notes of images still shown are kept, and the resumed run
      // re-plans the rest (slide image plan D-3).
      const kept = (next.imagePlans ?? []).filter((plan) => ids.includes(plan.imageId));
      if (kept.length > 0) next.imagePlans = kept;
      else delete next.imagePlans;
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
      // A native diagram keeps its planned note only while it stays native; a
      // new native plan gets its note when the resumed run re-plans it (D-3).
      const diagram =
        record.mode === 'native' && next.visualPlan?.mode === 'native'
          ? next.visualPlan.diagram
          : undefined;
      next.visualPlan = {
        mode: record.mode as 'image' | 'native' | 'omitted',
        ...(typeof reason === 'string' ? { omissionReason: reason } : {}),
        ...(diagram ? { diagram } : {}),
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
    // Changes no outline: the caller checks the key and filters the diagnosis.
    if (operation.op === 'ignore_issue') continue;
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
    if (operation.op === 'insert_book_slide') {
      const gap = insertableBookGaps(next, context.bookStructure, context.flow).find(
        (candidate) =>
          candidate.unit.contentUnitId === operation.unitId &&
          next[candidate.anchorIndex!]?.id === operation.outlineId,
      );
      if (!gap) {
        invalid(
          `operations[${index}]: no missing solution slide for unit ${JSON.stringify(operation.unitId)} after outline ${JSON.stringify(operation.outlineId)}`,
        );
      }
      next.splice(position + 1, 0, insertedBookSlide(next, gap, operation.title, context));
      continue;
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

/**
 * The book gaps a person can fill with `insert_book_slide`: a check's missing
 * solution slide, which always has its try-it slide as the anchor — when the
 * anchor's flow position allows a worked example (else the slide could never pass).
 * g5.v8: a check item without its own solution slide is the same kind, with the
 * check's last solution slide as the anchor.
 */
export function insertableBookGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure | undefined,
  flow: readonly TeachingFlowEntry[],
): BookCoverageGap[] {
  return findBookCoverageGaps(outlines, book).filter((gap) => {
    if (gap.kind !== 'missing_solution' || gap.anchorIndex === undefined) return false;
    const roles = anchorPolicy(outlines[gap.anchorIndex], flow)?.contentRoles;
    return !roles || roles.includes('worked_example');
  });
}

function anchorPolicy(
  anchor: SceneOutline | undefined,
  flow: readonly TeachingFlowEntry[],
): TeachingScenePolicy | undefined {
  const stage = anchor?.teachingStage;
  const entry = stage ? flow[stage.flowIndex] : undefined;
  return entry && entry.stage === stage!.key ? scenePolicyFor(entry) : undefined;
}

/**
 * The solution slide for a gap, at the try-it slide's flow position with its
 * Skills. It cites only the check's unit (so the gate counts it), selects the
 * textbook visuals linked to that unit (`SOURCE_VISUAL_NOT_SELECTED`), and
 * carries the try-it's items as its key points: the slide solves exactly them.
 * Its visual teaching notes are planned by the resume, as for any slide.
 */
/**
 * The solution slide's title in the lesson's own language, read from the
 * try-it title it follows: «جرّب: تخمينات» → «الحل: تخمينات». Never the
 * admin page's language (a reviewer's English UI once titled an Arabic slide
 * "Solution: …").
 */
export function solutionTitle(tryItTitle: string): string {
  const topic = tryItTitle.replace(/^[^:：]{1,20}[:：]\s*/, '').trim() || tryItTitle;
  return /[؀-ۿ]/.test(tryItTitle) ? `الحل: ${topic}` : `Solution: ${topic}`;
}

/**
 * The inserted solution's title and key points. A whole check's solution
 * follows its try-it slide and carries all of its items. A g5.v8 item's
 * solution is anchored on the check's LAST solution slide, which solves
 * another item: it reads the check's try-it slide instead and keeps only the
 * key points that name its own item alone (none when no point does), and its title
 * names the item, so it never re-solves the item before it.
 */
function solutionContent(
  outlines: readonly SceneOutline[],
  gap: BookCoverageGap,
  anchor: SceneOutline,
  title: string | undefined,
): { title: string; keyPoints: string[] } {
  const label = gap.itemLabel;
  if (label === undefined) {
    return {
      title: title ?? solutionTitle(anchor.title),
      keyPoints: [...(anchor.keyPoints ?? [])],
    };
  }
  const unitId = gap.unit.contentUnitId;
  const tryIt = outlines.find(
    (outline) =>
      outline.contentRole === 'check_understanding' &&
      (outline.sourceContentUnitIds ?? []).some((id) => String(id) === unitId),
  );
  const keyPoints = (tryIt?.keyPoints ?? []).filter((point) => {
    const labels = checkItemLabels(point);
    return labels.length === 1 && labels[0] === label;
  });
  return {
    title: title ?? `${solutionTitle(tryIt?.title ?? anchor.title)} (${label})`,
    keyPoints,
  };
}

function insertedBookSlide(
  outlines: readonly SceneOutline[],
  gap: BookCoverageGap,
  title: string | undefined,
  context: CorrectionEditContext,
): SceneOutline {
  const anchor = outlines[gap.anchorIndex!]!;
  const unitId = gap.unit.contentUnitId;
  const base = `${anchor.id}-book-${gap.kind}-${unitId}`;
  let id = base;
  for (let n = 2; outlines.some((outline) => outline.id === id); n += 1) id = `${base}-${n}`;
  const unitImages = context.sourceRefs.sourceImages
    .filter((image) => (image.sourceContentUnitIds ?? []).some((ref) => String(ref) === unitId))
    .map((image) => image.id);
  // g5.v8: one more solution slide of a check whose image another slide already
  // shows gets a native diagram, never the same image again (I-4.3).
  const shownElsewhere =
    context.bookStructure?.teacherParity === true &&
    gap.itemLabel !== undefined &&
    outlines.some((outline) =>
      (outline.suggestedImageIds ?? []).some((id) => unitImages.includes(id)),
    );
  const linked = shownElsewhere ? [] : unitImages;
  // A position that requires a visual gets a native diagram when no textbook
  // visual belongs to the check (the resume plans its teaching note).
  const visualRequired = anchorPolicy(anchor, context.flow)?.visual !== undefined;
  return {
    id,
    type: 'slide',
    slideType: 'content',
    contentRole: 'worked_example',
    ...solutionContent(outlines, gap, anchor, title),
    description: instructionFor(gap),
    order: gap.anchorIndex! + 2,
    ...(anchor.teachingStage ? { teachingStage: { ...anchor.teachingStage } } : {}),
    sourceContentUnitIds: [unitId],
    ...(linked.length > 0
      ? { suggestedImageIds: linked, visualPlan: { mode: 'image' } }
      : visualRequired
        ? { visualPlan: { mode: 'native' } }
        : {}),
    ...(anchor.teachingSkills ? { teachingSkills: structuredClone(anchor.teachingSkills) } : {}),
  } as SceneOutline;
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
  /** Open issues, each with the `key` an `ignore_issue` names and whether it may be ignored. */
  blockingIssues: Array<
    GenerationCheckpoint['diagnostics'][number] & { key: string; ignorable: boolean }
  >;
  /** Issues a person accepted as they are, with who and when. */
  ignoredIssues: Array<{
    key: string;
    code: string;
    outlineId: string | null;
    field: string | null;
    message: string;
    actorRef: string;
    at: number;
  }>;
  /** Missing book slides a person can add with `insert_book_slide` (outline phase). */
  insertableBookSlides: Array<{
    kind: BookCoverageGap['kind'];
    unitId: string;
    unitKind: string | null;
    anchorOutlineId: string;
    anchorTitle: string;
    message: string;
    /** g5.v8: the check item the inserted solution slide works. */
    itemLabel?: string;
  }>;
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

function ignoredIssueList(
  editLog: readonly GenerationCheckpointLogEntry[],
): CorrectionView['ignoredIssues'] {
  const list: CorrectionView['ignoredIssues'] = [];
  for (const entry of editLog) {
    for (const op of entry.operations ?? []) {
      const record = op && typeof op === 'object' ? (op as Record<string, unknown>) : null;
      if (record?.op !== 'ignore_issue' || typeof record.issueKey !== 'string') continue;
      const key = record.issueKey;
      if (list.some((item) => item.key === key)) continue;
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        continue;
      }
      if (!Array.isArray(parts) || parts.length !== 4) continue;
      const [code, outlineId, field, keyMessage] = parts as unknown[];
      list.push({
        key,
        code: String(code),
        outlineId: typeof outlineId === 'string' ? outlineId : null,
        field: typeof field === 'string' ? field : null,
        // The wording recorded when it was ignored; the key's own text otherwise.
        message:
          typeof record.message === 'string'
            ? record.message
            : typeof keyMessage === 'string'
              ? keyMessage
              : String(code),
        actorRef: entry.actorRef,
        at: entry.at,
      });
    }
  }
  return list;
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
    // finding is resolved by the resume regenerating that Scene, and a missing
    // visual teaching note by the resume re-planning that slide's visual.
    canResume:
      checkpoint.state === 'awaiting' &&
      attempt.status === 'awaiting_admin_correction' &&
      checkpoint.diagnostics.every(
        (diagnostic) =>
          diagnostic.field === SCENE_REGENERATION_FIELD ||
          diagnostic.code === VISUAL_TEACHING_NOTE_MISSING,
      ),
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
    blockingIssues: checkpoint.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      key: diagnosticKey(diagnostic),
      ignorable: isIgnorableIssue(diagnostic),
    })),
    ignoredIssues: ignoredIssueList(checkpoint.editLog),
    insertableBookSlides:
      checkpoint.phase === 'outline'
        ? insertableBookGaps(
            checkpoint.outlines,
            correctionCoverageBook(
              checkpoint.sourceRefs,
              attempt.inputSnapshot.bookStructure,
              attempt.teachingModel,
            ),
            flow,
          ).map((gap) => {
            const anchor = checkpoint.outlines[gap.anchorIndex!]!;
            return {
              kind: gap.kind,
              unitId: gap.unit.contentUnitId,
              unitKind: gap.unit.kind ?? null,
              anchorOutlineId: anchor.id,
              anchorTitle: anchor.title,
              message: gap.message,
              ...(gap.itemLabel ? { itemLabel: gap.itemLabel } : {}),
            };
          })
        : [],
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
