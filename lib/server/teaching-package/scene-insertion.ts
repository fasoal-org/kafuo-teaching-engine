/**
 * Reviewer-generated slide for an uncovered lesson part — the service
 * (reviewer-generated-slide-for-lesson-part-plan §6–§11). The order matters
 * (R6):
 *
 *   authorized grant (route) → body validation (route) → digest
 *   → replay lookup (BEFORE any new-run check: after a success whose response
 *     was lost, the units are covered and the anchors no longer adjacent)
 *   → new-run checks, no writes: eligibility, units, coverage, anchors,
 *     allowed stage, exact flow on the placeholder projection, the Skill
 *     pre-check (governed), the model route
 *   → T1 under the Stage mutex → planner → normalize → content → actions
 *   → T2: sandwich + fenced atomic write (≤ 3 builds, no new model call)
 *   ↘ any failure after T1: T3 (row failed, candidate kept, nothing else changes)
 *
 * The reviewer submits two texts: `instruction` (optional; the only reviewer
 * text a model sees, wrapped as untrusted) and `reason` (the audit
 * justification, stored on the row and the events, passed to nothing else).
 */
import { createHash, randomBytes } from 'node:crypto';

import { migrate } from '@openmaic/dsl';
import {
  assertGeneratedSlideScene,
  narrowDiagnosticsToPositionPolicy,
  normalizeSourceGroundedVisuals,
  teachingFlowDiagnostics,
  type PdfImage,
  type SceneOutline,
} from '@openmaic/generation';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type {
  AppDocument,
  AppDocumentOutline,
  AppStage,
} from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import {
  readAllContentUnitsForVersion,
  readRetainedVersionContext,
  readVersionById,
  type ContentUnitRow,
} from '@/lib/persistence/teaching-package';
import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';
import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
import { buildSceneAlignmentBaseline } from '@/lib/server/teaching-package/alignment';
import {
  allowedStagesAt,
  computeContentUnitCoverage,
  insertionPositionOptions,
  MAX_INSERTION_UNITS,
  newPolicyDiagnostics,
  orderedScenes,
  placeholderProjection,
  policyOutlineProjection,
  resolveInsertionPosition,
  shiftScenesForInsertion,
  suggestInsertionPosition,
  type InsertionAnchors,
  type UnitCoverage,
} from '@/lib/server/teaching-package/content-unit-coverage';
import { sceneRegenerationSessionRef } from '@/lib/server/teaching-package/editor-grant';
import {
  isTeachingPackageStageLockedError,
  TeachingPackageError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import {
  readFlowForVersion,
  readTeachingSkillsGovernanceForVersion,
  validateExactTeachingFlow,
} from '@/lib/server/teaching-package/exact-flow';
import {
  resolveGovernedRegenerationContext,
  type GovernedRegenerationContext,
} from '@/lib/server/teaching-package/governed-regeneration';
import { insertOneScene } from '@/lib/server/teaching-package/insert-one-scene';
import {
  insertionSkillsInvalidError,
  insertionSkillValidationSet,
  preCheckExistingSceneSkills,
  validateInsertionSkills,
} from '@/lib/server/teaching-package/insertion-skill-validation';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  planInsertedSlide,
  type PlanCheck,
  type PlannerSkillOption,
} from '@/lib/server/teaching-package/plan-inserted-slide';
import {
  createInsertionRoute,
  INSERTION_PLANNER_STAGE,
} from '@/lib/server/teaching-package/routed-insertion-call';
import {
  commitSceneInsertion,
  failSceneInsertion,
  listRunningSceneInsertions,
  newSceneInsertionId,
  readSceneInsertionByKey,
  readSceneInsertionStatus,
  recordSceneInsertionProgress,
  recordSceneInsertionRefusal,
  startSceneInsertion,
  type LiveStageData,
  type SceneInsertion,
  type SceneInsertionRefusal,
} from '@/lib/server/teaching-package/scene-insertion-store';
import { listRunningSceneRegenerations } from '@/lib/server/teaching-package/scene-regeneration-store';
import { resolveFlowSkillPolicies } from '@/lib/server/teaching-package/skill-policy';
import { resolveMoeBrandProfile } from '@/lib/server/visual-compliance/brand-profile';
import { getVerdictStore } from '@/lib/server/visual-compliance';
import type {
  SourceVisualManifestEntry,
  TeachingFlowEntry,
  TeachingPackageStatus,
  TeachingStageRef,
} from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneInsertion');

/** Field limits, trimmed — mirrored by the dialog (`SCENE_INSERTION_LIMITS` in the client). */
export const SCENE_INSERTION_LIMITS = {
  units: { min: 1, max: MAX_INSERTION_UNITS },
  instruction: { min: 0, max: 2000 },
  reason: { min: 5, max: 1000 },
  idempotencyKey: { min: 8, max: 128 },
} as const;

const EDITABLE: readonly TeachingPackageStatus[] = ['draft', 'rejected'];

/** The authorized grant, as the route resolved it (never the request body). */
export interface InsertionGrant {
  tenantId: string;
  versionId: string;
  stageId: string;
  learnerKey: string;
}

export interface SceneInsertionRequest extends InsertionAnchors {
  unitIds: string[];
  teachingStage: TeachingStageRef;
  instruction: string;
  reason: string;
  idempotencyKey: string;
}

function invalid(field: string, rule: string, limit?: number): TeachingPackageError {
  return new TeachingPackageError(
    'INVALID_REQUEST',
    `${field} ${rule === 'required' ? 'is required' : rule === 'min' ? `needs at least ${limit}` : rule === 'max' ? `allows at most ${limit}` : 'is malformed'}`,
    { field, rule, ...(limit === undefined ? {} : { limit }) },
  );
}

function anchor(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') throw invalid(field, 'format');
  return value;
}

/** Validate and normalize the body (structure only — no database read). */
export function parseSceneInsertionRequest(
  body: Record<string, unknown> | null,
): SceneInsertionRequest {
  if (!body) throw invalid('body', 'required');
  const rawUnits = body.unitIds;
  if (!Array.isArray(rawUnits)) throw invalid('unitIds', 'required');
  const unitIds = rawUnits.map((id) => {
    if (typeof id !== 'string' || id.trim() === '') throw invalid('unitIds', 'format');
    return id;
  });
  if (unitIds.length < SCENE_INSERTION_LIMITS.units.min) {
    throw invalid('unitIds', 'min', SCENE_INSERTION_LIMITS.units.min);
  }
  if (unitIds.length > SCENE_INSERTION_LIMITS.units.max) {
    throw new TeachingPackageError(
      'INSERTION_UNIT_INVALID',
      `one slide covers at most ${SCENE_INSERTION_LIMITS.units.max} lesson parts`,
      { reason: 'too_many', unitIds },
    );
  }
  if (new Set(unitIds).size !== unitIds.length) {
    throw new TeachingPackageError('INSERTION_UNIT_INVALID', 'a lesson part is listed twice', {
      reason: 'duplicate',
      unitIds,
    });
  }
  const stage = body.teachingStage as { key?: unknown; flowIndex?: unknown } | undefined;
  if (
    !stage ||
    typeof stage !== 'object' ||
    typeof stage.key !== 'string' ||
    stage.key === '' ||
    typeof stage.flowIndex !== 'number' ||
    !Number.isInteger(stage.flowIndex) ||
    stage.flowIndex < 0
  ) {
    throw invalid('teachingStage', 'format');
  }
  const instructionRaw = body.instruction ?? '';
  if (typeof instructionRaw !== 'string') throw invalid('instruction', 'format');
  const instruction = instructionRaw.trim();
  if (instruction.length > SCENE_INSERTION_LIMITS.instruction.max) {
    throw invalid('instruction', 'max', SCENE_INSERTION_LIMITS.instruction.max);
  }
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    throw invalid('reason', 'required');
  }
  const reason = body.reason.trim();
  if (reason.length < SCENE_INSERTION_LIMITS.reason.min) {
    throw invalid('reason', 'min', SCENE_INSERTION_LIMITS.reason.min);
  }
  if (reason.length > SCENE_INSERTION_LIMITS.reason.max) {
    throw invalid('reason', 'max', SCENE_INSERTION_LIMITS.reason.max);
  }
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || key === '') throw invalid('idempotencyKey', 'required');
  const { min, max } = SCENE_INSERTION_LIMITS.idempotencyKey;
  if (key.length < min) throw invalid('idempotencyKey', 'min', min);
  if (key.length > max) throw invalid('idempotencyKey', 'max', max);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw invalid('idempotencyKey', 'format');
  const afterSceneId = anchor(body.afterSceneId, 'afterSceneId');
  const beforeSceneId = anchor(body.beforeSceneId, 'beforeSceneId');
  if (afterSceneId !== null && afterSceneId === beforeSceneId) {
    throw invalid('beforeSceneId', 'format');
  }
  return {
    unitIds,
    afterSceneId,
    beforeSceneId,
    teachingStage: { key: stage.key, flowIndex: stage.flowIndex },
    instruction,
    reason,
    idempotencyKey: key,
  };
}

/** The digest an idempotency key is bound to: same key + different body → 409. */
export function sceneInsertionRequestDigest(
  request: Omit<SceneInsertionRequest, 'idempotencyKey'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        unitIds: [...request.unitIds].sort(),
        afterSceneId: request.afterSceneId,
        beforeSceneId: request.beforeSceneId,
        teachingStage: request.teachingStage,
        instruction: request.instruction,
        reason: request.reason,
      }),
    )
    .digest('hex');
}

export function sceneInsertionActorRef(stageId: string): string {
  return `teaching-package-editor:${stageId}`;
}

function newInsertedSceneId(): string {
  return `scene_ins_${randomBytes(9).toString('base64url')}`;
}

function newInsertedOutlineId(): string {
  return `ins_${randomBytes(9).toString('base64url')}`;
}

const KNOWN_FAILURE_CODES = new Set<string>([
  'INSERTION_UNIT_INVALID',
  'INSERTION_UNIT_ALREADY_COVERED',
  'INSERTION_POSITION_NOT_ALLOWED',
  'INSERTION_POSITION_CHANGED',
  'INSERTION_FLOW_INVALID',
  'INSERTION_FLOW_POLICY_VIOLATION',
  'INSERTION_PLAN_INVALID',
  'INSERTION_ALIGNMENT_UNAVAILABLE',
  'INSERTION_SKILLS_INVALID',
  'INSERTION_VISUAL_NOT_APPROVED',
  'INSERTION_STAGE_BUSY',
  'INSERTION_LEASE_LOST',
  'INSERTION_PERSISTENCE_FAILED',
  'ORIENTATION_VISUAL_MISSING',
  'GOVERNED_FLOW_CONTEXT_UNRESOLVED',
  'GOVERNED_SCENE_GENERATION_FAILED',
  'GOVERNED_ACTION_GENERATION_FAILED',
  'SCENE_ACTION_GENERATION_FAILED',
  'SCENE_CONTENT_GENERATION_FAILED',
  'SPEECH_REGISTER_NONCOMPLIANT',
  'ACTION_STRUCTURE_INVALID',
  'ACTION_TYPE_UNKNOWN',
  'ACTION_REFERENCE_INVALID',
  'SUBJECT_ROUTE_UNAVAILABLE',
  'TEACHING_MODEL_UNAVAILABLE',
  'ACCOUNTING_UNAVAILABLE',
  'DOCUMENT_NOT_CURRENT',
  'STAGE_LOCKED',
  'STAGE_NOT_LIVE',
  'SKILL_POLICY_REQUIRED',
]);

/** The error a stored failure code replays as. */
export function storedInsertionFailureError(row: SceneInsertion): TeachingPackageError {
  const stored = row.errorCode ?? 'INSERTION_PERSISTENCE_FAILED';
  const code: TeachingPackageErrorCode =
    stored === 'LEASE_EXPIRED'
      ? 'INSERTION_LEASE_LOST'
      : KNOWN_FAILURE_CODES.has(stored)
        ? (stored as TeachingPackageErrorCode)
        : 'INSERTION_PERSISTENCE_FAILED';
  return new TeachingPackageError(
    code,
    `this slide insertion failed (${stored}); nothing was written`,
    {
      insertionId: row.id,
      failureCode: stored,
      replayed: true,
    },
  );
}

/** The status body every read and the POST return (`insertion` in the envelope). */
export interface SceneInsertionStatusBody {
  insertionId: string;
  status: 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  newSceneId: string;
  resultSceneRev: number | null;
  scene: AppScene | null;
  revTransitions: Record<string, { before: number; after: number }> | null;
  requestedAt: number;
  completedAt: number | null;
}

export function insertionStatusBody(row: SceneInsertion): SceneInsertionStatusBody {
  return {
    insertionId: row.id,
    status: row.status,
    errorCode: row.errorCode,
    newSceneId: row.newSceneId,
    resultSceneRev: row.resultSceneRev,
    scene: row.resultScene,
    revTransitions: row.sceneRevTransitions,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  };
}

export type SceneInsertionResponse =
  | { status: 200; body: { insertion: SceneInsertionStatusBody; replayed: boolean } }
  | { status: 202; body: { insertion: SceneInsertionStatusBody; replayed: true } };

function replayResponse(row: SceneInsertion, now: number): SceneInsertionResponse {
  if (row.status === 'running' && row.leaseExpiresAt > now) {
    return { status: 202, body: { insertion: insertionStatusBody(row), replayed: true } };
  }
  if (row.status === 'succeeded' && row.resultScene && row.resultSceneRev !== null) {
    return { status: 200, body: { insertion: insertionStatusBody(row), replayed: true } };
  }
  throw storedInsertionFailureError(row);
}

export interface SceneInsertionDeps {
  pool: ConnectableQueryable;
  now?: () => number;
  leaseSeconds?: number;
  routingMode?: 'enforced' | 'off';
  /** Test seams. */
  createRoute?: typeof createInsertionRoute;
  plan?: typeof planInsertedSlide;
  insert?: typeof insertOneScene;
  resolveGoverned?: typeof resolveGovernedRegenerationContext;
  verdictStore?: () => Promise<{
    get(profileId: string, checksum: string): Promise<{ verdict: string } | undefined>;
  }>;
}

function documentStore(pool: ConnectableQueryable) {
  return createOwnerBoundDocumentStore<AppScene, AppStage>({
    pool: pool as unknown as TransactionSource,
    ownerId: TEACHING_PACKAGE_STAGE_OWNER,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

// ---------------------------------------------------------------------------
// The version context every path reads
// ---------------------------------------------------------------------------

type UnsupportedReason = 'no_flow' | 'legacy_successor' | 'no_content_units';

interface InsertionContext {
  version: NonNullable<Awaited<ReturnType<typeof readVersionById>>>;
  flow: TeachingFlowEntry[] | null;
  governed: boolean;
  unsupportedReason: UnsupportedReason | null;
  units: ContentUnitRow[];
  lineageStatus: 'own_attempt' | 'predecessor_attempt' | 'unavailable';
}

async function readInsertionContext(
  pool: ConnectableQueryable,
  grant: Pick<InsertionGrant, 'tenantId' | 'versionId' | 'stageId'>,
): Promise<InsertionContext> {
  const version = await readVersionById(pool, grant.versionId);
  if (!version || version.tenantId !== grant.tenantId || version.currentStageId !== grant.stageId) {
    throw new TeachingPackageError('NOT_FOUND', 'teaching package not found');
  }
  const flow = await readFlowForVersion(pool, version.id);
  const governance = await readTeachingSkillsGovernanceForVersion(pool, version.id);
  const governed = Boolean(governance?.contract);
  const legacySuccessor = !governed && version.predecessorVersionId !== null;
  const units = await readAllContentUnitsForVersion(pool, version.id, { tenantId: grant.tenantId });
  const unsupportedReason: UnsupportedReason | null =
    !flow || flow.length === 0
      ? 'no_flow'
      : legacySuccessor
        ? 'legacy_successor'
        : units.units.length === 0
          ? 'no_content_units'
          : null;
  return {
    version,
    flow: flow && flow.length > 0 ? flow : null,
    governed,
    unsupportedReason,
    units: units.units,
    lineageStatus: units.lineageStatus,
  };
}

function refusal(code: TeachingPackageErrorCode, message: string, details?: unknown) {
  return new TeachingPackageError(code, message, details);
}

/**
 * The checks that depend on the live document — run before T1 (new-run
 * checks), inside T1 (authoritative), and at T2 on the exact snapshot.
 */
function checkPositionAndUnits(
  request: SceneInsertionRequest,
  scenes: readonly AppScene[],
  outline: AppDocumentOutline | null | undefined,
  units: readonly ContentUnitRow[],
  flow: readonly TeachingFlowEntry[],
  changed: boolean,
): { at: number; after: AppScene | null; before: AppScene | null } {
  const coverage = computeContentUnitCoverage(units, scenes, outline);
  const byId = new Map(coverage.map((unit) => [unit.id, unit]));
  for (const unitId of request.unitIds) {
    const unit = byId.get(unitId);
    if (!unit || !unit.instructional || unit.textLength <= 0) {
      throw refusal(
        'INSERTION_UNIT_INVALID',
        `lesson part ${JSON.stringify(unitId)} is unknown, has no text, or is not taught`,
        {
          unitId,
          reason: !unit ? 'unknown' : !unit.instructional ? 'not_instructional' : 'textless',
        },
      );
    }
    if (unit.covered) {
      throw refusal(
        'INSERTION_UNIT_ALREADY_COVERED',
        `lesson part ${JSON.stringify(unitId)} is already taught by a slide`,
        { unitId, coveredBySlideIds: unit.coveredBySlideIds },
      );
    }
  }
  const position = resolveInsertionPosition(scenes, request);
  if (!position.ok) {
    throw refusal(
      changed ? 'INSERTION_POSITION_CHANGED' : 'INSERTION_POSITION_NOT_ALLOWED',
      changed
        ? 'the slides around the chosen position changed; choose the position again'
        : 'the chosen position is not between two adjacent slides',
      { reason: position.reason },
    );
  }
  const allowed = allowedStagesAt(scenes, flow, position);
  const chosen = allowed.find(
    (stage) =>
      stage.key === request.teachingStage.key &&
      stage.flowIndex === request.teachingStage.flowIndex,
  );
  if (!chosen) {
    throw refusal(
      changed ? 'INSERTION_POSITION_CHANGED' : 'INSERTION_POSITION_NOT_ALLOWED',
      allowed.length === 0
        ? 'no teaching stage of this lesson allows a new slide at that position'
        : 'that teaching stage is not allowed at the chosen position',
      { allowedStages: allowed },
    );
  }
  return { at: position.at, after: position.after, before: position.before };
}

function exactFlowOrRefuse(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
  outline: AppDocumentOutline | null | undefined,
): void {
  const result = validateExactTeachingFlow(scenes, flow, outline?.outlines);
  if (!result.valid) {
    throw refusal(
      'INSERTION_FLOW_INVALID',
      `the lesson would not follow its Teaching Model Flow (${result.violation.reason})`,
      {
        reason: result.violation.reason,
        offendingSceneIds: result.violation.offendingSceneIds,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Images (§10.4)
// ---------------------------------------------------------------------------

interface EligibleVisual {
  entry: SourceVisualManifestEntry;
  image: PdfImage;
}

async function eligibleVisuals(
  outline: AppDocumentOutline | null | undefined,
  unitIds: readonly string[],
  deps: SceneInsertionDeps,
): Promise<EligibleVisual[]> {
  const chosen = new Set(unitIds);
  const linked = (outline?.sourceVisuals ?? []).filter((entry) =>
    (entry.sourceContentUnitIds ?? []).some((id) => chosen.has(id)),
  );
  if (linked.length === 0) return [];
  const profileId = resolveMoeBrandProfile().id;
  let store: Awaited<ReturnType<NonNullable<SceneInsertionDeps['verdictStore']>>>;
  try {
    store = await (deps.verdictStore ?? getVerdictStore)();
  } catch (error) {
    log.warn(
      'the visual-compliance verdict store is unavailable; no textbook image is eligible',
      error,
    );
    return [];
  }
  const eligible: EligibleVisual[] = [];
  for (const entry of linked) {
    // A cached verdict only — never a screening call (fail closed).
    const verdict = await store.get(profileId, entry.sha256).catch(() => undefined);
    if (verdict?.verdict !== 'approved') continue;
    eligible.push({
      entry,
      image: {
        id: entry.id,
        src: entry.servingPath,
        pageNumber: entry.pageNumber ?? 0,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.height !== undefined ? { height: entry.height } : {}),
        ...(entry.sourceContentUnitIds ? { sourceContentUnitIds: entry.sourceContentUnitIds } : {}),
      } as PdfImage,
    });
  }
  return eligible;
}

/** Every image element of the candidate must show an eligible visual. */
function assertCandidateVisuals(candidate: AppScene, eligible: readonly EligibleVisual[]): void {
  if (candidate.content.type !== 'slide') return;
  const allowed = new Set(eligible.map((visual) => visual.entry.servingPath));
  const foreign = candidate.content.canvas.elements.filter(
    (element) =>
      (element as { type?: unknown }).type === 'image' &&
      !allowed.has(String((element as { src?: unknown }).src ?? '')),
  );
  if (foreign.length > 0) {
    throw refusal(
      'INSERTION_VISUAL_NOT_APPROVED',
      'the generated slide shows an image that is not an approved textbook visual for these lesson parts',
      { elementIds: foreign.map((element) => (element as { id?: unknown }).id) },
    );
  }
}

// ---------------------------------------------------------------------------
// The policy diagnostics (§9.4)
// ---------------------------------------------------------------------------

function policyViolations(
  scenes: readonly AppScene[],
  outline: AppDocumentOutline | null | undefined,
  planned: SceneOutline,
  at: number,
  flow: readonly TeachingFlowEntry[],
  images: readonly PdfImage[],
) {
  const shifted = shiftScenesForInsertion(scenes, at);
  const projection = policyOutlineProjection(shifted, outline);
  const withNew = [...projection, { ...planned, order: at }].sort((a, b) => a.order - b.order);
  const before = teachingFlowDiagnostics(projection, flow, [...images]);
  const after = narrowDiagnosticsToPositionPolicy(
    teachingFlowDiagnostics(withNew, flow, [...images]),
    withNew,
    flow,
  );
  return newPolicyDiagnostics(before, after, planned.id);
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function insertGeneratedSlide(
  grant: InsertionGrant,
  request: SceneInsertionRequest,
  deps: SceneInsertionDeps,
): Promise<SceneInsertionResponse> {
  const { pool } = deps;
  const clock = deps.now ?? Date.now;
  const actorRef = sceneInsertionActorRef(grant.stageId);
  const requestDigest = sceneInsertionRequestDigest(request);

  // Replay first (§6 step 4) — before any coverage or adjacency check.
  const prior = await readSceneInsertionByKey(pool, grant.versionId, request.idempotencyKey);
  if (prior) {
    if (prior.tenantId !== grant.tenantId || prior.stageId !== grant.stageId) {
      throw refusal('IDEMPOTENCY_KEY_REUSED', 'this idempotency key was already used');
    }
    if (prior.requestDigest !== requestDigest) {
      throw refusal(
        'IDEMPOTENCY_KEY_REUSED',
        'this idempotency key was already used for a different request',
      );
    }
    if (prior.status !== 'running' || prior.leaseExpiresAt > clock()) {
      return replayResponse(prior, clock());
    }
    // An expired running row: T1 reclaims it and answers the replay.
  }

  // New-run checks — no writes; a refusal here is audited (version resolved).
  const context = await readInsertionContext(pool, grant);
  const audit = async (code: string) =>
    recordSceneInsertionRefusal(pool, {
      versionId: grant.versionId,
      actorRef,
      reason: request.reason,
      refusalCode: code,
      idempotencyKey: request.idempotencyKey,
      unitIds: request.unitIds,
      now: clock(),
    }).catch((error) => log.warn('could not record the refused slide insertion', error));
  const refuseAudited = async (error: TeachingPackageError): Promise<never> => {
    await audit(error.code);
    throw error;
  };

  if (!EDITABLE.includes(context.version.status)) {
    return refuseAudited(
      refusal(
        'STAGE_LOCKED',
        `the teaching package is ${context.version.status}; only draft or rejected packages can be edited`,
      ),
    );
  }
  if (context.unsupportedReason || !context.flow) {
    return refuseAudited(
      refusal('INSERTION_NOT_SUPPORTED', 'a slide cannot be generated for this package', {
        reason: context.unsupportedReason ?? 'no_flow',
      }),
    );
  }
  const flow = context.flow;
  const stageDocument = (await documentStore(pool).loadDocument(
    grant.stageId,
  )) as AppDocument | null;
  if (!stageDocument) throw refusal('STAGE_NOT_LIVE', 'the package stage is not live');
  const outlineRecord = (stageDocument.outline ?? null) as AppDocumentOutline | null;
  const newSceneId = newInsertedSceneId();
  const newOutlineId = newInsertedOutlineId();
  let position: { at: number; after: AppScene | null; before: AppScene | null };
  try {
    position = checkPositionAndUnits(
      request,
      stageDocument.scenes,
      outlineRecord,
      context.units,
      flow,
      false,
    );
    exactFlowOrRefuse(
      placeholderProjection(stageDocument.scenes, position.at, {
        id: newSceneId,
        outlineId: newOutlineId,
        teachingStage: request.teachingStage,
        stageId: grant.stageId,
      }),
      flow,
      outlineRecord,
    );
    if (context.governed) {
      const preCheck = preCheckExistingSceneSkills(stageDocument.scenes, flow);
      if (preCheck) throw insertionSkillsInvalidError(preCheck);
    }
  } catch (error) {
    if (error instanceof TeachingPackageError) return refuseAudited(error);
    throw error;
  }

  // Producing-attempt context: the routed subject and the recorded register.
  const retained = await readRetainedVersionContext(pool, grant.versionId, {
    tenantId: grant.tenantId,
  });
  const stage = stageDocument.stage;
  const snapshot = retained?.inputSnapshot as
    | { subjectCode?: string; speechRegister?: Record<string, unknown> }
    | undefined;
  const subjectCode = snapshot?.subjectCode ?? undefined;
  const registerPolicy = resolveSpeechRegisterPolicy({
    language: stage.language,
    subjectCode: subjectCode ?? null,
  });
  const insertionId = newSceneInsertionId();
  const route = await (deps.createRoute ?? createInsertionRoute)({
    tenantId: grant.tenantId,
    versionId: grant.versionId,
    insertionId,
    generationAttemptId: retained?.attemptId ?? null,
    learningItem: context.version.learningItem,
    snapshotSubjectCode: subjectCode,
    stageSubjectCode: stage.subjectCode,
    queryable: pool,
    ...(deps.routingMode ? { mode: deps.routingMode } : {}),
  }).catch(async (error: unknown) => {
    if (error instanceof TeachingPackageError) return refuseAudited(error);
    throw error;
  });

  // T1 — authoritative, under the Stage mutex.
  const recheck = (live: LiveStageData): SceneInsertionRefusal | null => {
    try {
      checkPositionAndUnits(request, live.scenes, live.outline, context.units, flow, false);
      return null;
    } catch (error) {
      if (error instanceof TeachingPackageError) {
        return { code: error.code, message: error.message, details: error.details, audited: true };
      }
      throw error;
    }
  };
  const started = await startSceneInsertion(pool, {
    id: insertionId,
    tenantId: grant.tenantId,
    versionId: grant.versionId,
    stageId: grant.stageId,
    newSceneId,
    newOutlineId,
    unitIds: request.unitIds,
    afterSceneId: request.afterSceneId,
    beforeSceneId: request.beforeSceneId,
    teachingStage: request.teachingStage,
    idempotencyKey: request.idempotencyKey,
    requestDigest,
    instruction: request.instruction,
    reason: request.reason,
    actorRef,
    sessionRef: sceneRegenerationSessionRef(grant.tenantId, grant.versionId, grant.learnerKey),
    registerPolicy: {
      current: registerPolicy
        ? { policyVersion: registerPolicy.version, register: registerPolicy.register }
        : null,
      recorded: snapshot?.speechRegister ?? stage.speechRegister ?? null,
    },
    recheck,
    now: clock(),
    ...(deps.leaseSeconds !== undefined ? { leaseSeconds: deps.leaseSeconds } : {}),
  });
  if (started.kind === 'refused') {
    const { refusal: refused } = started;
    if (refused.audited) await audit(refused.code);
    throw new TeachingPackageError(refused.code, refused.message, refused.details);
  }
  if (started.kind === 'replay') return replayResponse(started.insertion, clock());
  const row = started.insertion;
  await recordSceneInsertionProgress(pool, row.id, { modelRoute: route.description }).catch(
    () => {},
  );

  let plannedOutline: SceneOutline | null = null;
  let candidate: AppScene | null = null;
  const fail = async (errorCode: string) => {
    try {
      await failSceneInsertion(pool, {
        insertionId: row.id,
        attemptToken: row.attemptToken,
        errorCode,
        candidateScene: candidate,
        plannedOutline: plannedOutline as unknown as Record<string, unknown> | null,
        now: clock(),
      });
    } catch (error) {
      // The lease expires and a later reclaim records LEASE_EXPIRED.
      log.warn(`could not record the failure of slide insertion ${row.id}`, error);
    }
  };
  const failAndThrow = async (error: TeachingPackageError): Promise<never> => {
    await fail(error.code);
    throw new TeachingPackageError(error.code, error.message, {
      ...(error.details && typeof error.details === 'object' ? error.details : {}),
      insertionId: row.id,
    });
  };

  // Generation — no transaction is open while the model runs.
  const eligible = await eligibleVisuals(outlineRecord, request.unitIds, deps);
  const eligibleImages = eligible.map((visual) => visual.image);
  let governedContext: GovernedRegenerationContext | undefined;
  try {
    governedContext = context.governed
      ? await (deps.resolveGoverned ?? resolveGovernedRegenerationContext)(pool, grant.versionId, {
          teachingStage: request.teachingStage,
        })
      : undefined;
    const flowEntry = flow[request.teachingStage.flowIndex]!;
    const ordered = orderedScenes(stageDocument.scenes);
    const chosenUnits = context.units.filter((unit) => request.unitIds.includes(unit.unitId));
    const planned = await (deps.plan ?? planInsertedSlide)({
      units: chosenUnits.map((unit) => ({
        id: unit.unitId,
        order: unit.orderIndex,
        role: unit.role,
        subtype: unit.subtype,
        title: unit.title,
        text: unit.normalizedText,
      })),
      unitIds: request.unitIds,
      flowEntry,
      teachingStage: request.teachingStage,
      allowedSkills: context.governed ? plannerSkillOptions(flowEntry, flow) : null,
      previousTitle: position.after?.title ?? null,
      nextTitle: position.before?.title ?? null,
      language: stage.language ?? 'ar-SA',
      languageDirective: registerPolicy?.directive ?? stage.languageDirective ?? '',
      eligibleVisuals: eligible.map((visual) => ({
        id: visual.entry.id,
        ...(visual.entry.description ? { description: visual.entry.description } : {}),
      })),
      instruction: request.instruction,
      outlineId: newOutlineId,
      order: position.at,
      check: (outline) =>
        checkPlan(outline, {
          scenes: ordered,
          outlineRecord,
          flow,
          newSceneId,
          at: position.at,
          governed: context.governed,
          eligibleImages,
        }),
      aiCall: route.aiCallFor(INSERTION_PLANNER_STAGE),
    });
    route.assertAvailable();
    if (!planned.ok) {
      throw new TeachingPackageError(planned.code, planned.message, planned.details);
    }
    plannedOutline = planned.outline;
    await recordSceneInsertionProgress(pool, row.id, {
      plannedOutline: planned.outline as unknown as Record<string, unknown>,
      outlineRepairs: planned.repairs,
    }).catch(() => {});
    const generated = await (deps.insert ?? insertOneScene)({
      outline: planned.outline,
      newSceneId,
      scenes: stageDocument.scenes,
      stage,
      eligibleImages,
      aiCallFor: route.aiCallFor,
      assertRouteAvailable: route.assertAvailable,
      registerPolicy,
      ...(governedContext ? { governed: governedContext } : {}),
      now: clock,
    });
    if (!generated.ok) {
      throw new TeachingPackageError(generated.code, generated.message, generated.details);
    }
    candidate = generated.scene;
  } catch (error) {
    if (error instanceof TeachingPackageError) return failAndThrow(error);
    await fail('SCENE_CONTENT_GENERATION_FAILED');
    throw error;
  }

  // T2 — sandwich + fenced atomic write; the candidate is reused on a rebuild.
  const built = candidate;
  const planned = plannedOutline as SceneOutline;
  try {
    const committed = await commitSceneInsertion(
      pool,
      {
        insertionId: row.id,
        attemptToken: row.attemptToken,
        tenantId: grant.tenantId,
        versionId: grant.versionId,
        stageId: grant.stageId,
        newSceneId,
        actorRef,
        reason: request.reason,
        now: clock,
      },
      (doc) =>
        buildFinalDocument(doc, built, {
          request,
          planned,
          units: context.units,
          flow,
          governed: context.governed,
          newSceneId,
          newOutlineId,
          eligible,
          now: clock(),
        }),
    );
    return {
      status: 200,
      body: {
        insertion: {
          insertionId: row.id,
          status: 'succeeded',
          errorCode: null,
          newSceneId,
          resultSceneRev: committed.resultSceneRev,
          scene: committed.resultScene,
          revTransitions: committed.sceneRevTransitions,
          requestedAt: row.requestedAt,
          completedAt: committed.completedAt,
        },
        replayed: false,
      },
    };
  } catch (error) {
    const code =
      error instanceof TeachingPackageError
        ? error.code
        : isTeachingPackageStageLockedError(error)
          ? 'STAGE_LOCKED'
          : 'INSERTION_PERSISTENCE_FAILED';
    await fail(code);
    if (error instanceof TeachingPackageError || isTeachingPackageStageLockedError(error)) {
      throw error;
    }
    log.error(`slide insertion ${row.id} could not be committed`, error);
    throw new TeachingPackageError(
      'INSERTION_PERSISTENCE_FAILED',
      'the slide was generated but could not be saved; nothing was written — try again',
      { insertionId: row.id },
    );
  }
}

/** The position's Skills, as the planner lists them (governed only). */
function plannerSkillOptions(
  entry: TeachingFlowEntry,
  flow: readonly TeachingFlowEntry[],
): PlannerSkillOption[] {
  const policy = entry.skillPolicy;
  if (!policy) return [];
  let definitions: ReturnType<typeof resolveFlowSkillPolicies>;
  try {
    definitions = resolveFlowSkillPolicies(flow);
  } catch {
    definitions = new Map();
  }
  const summaryOf = (skillId: string, version: string) => {
    const content = definitions.get(`${skillId}@${version}`)?.content ?? '';
    const line = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
    return line ? line.replace(/^["']|["']$/g, '').slice(0, 240) : undefined;
  };
  const options = new Map<string, PlannerSkillOption>();
  const add = (
    ref: { skillId: string; version: string },
    standing: PlannerSkillOption['standing'],
  ) => {
    const key = `${ref.skillId}@${ref.version}`;
    if (options.has(key)) return;
    const summary = summaryOf(ref.skillId, ref.version);
    options.set(key, { ...ref, standing, ...(summary ? { summary } : {}) });
  };
  for (const rule of policy.required) add(rule.skill, 'required');
  for (const ref of policy.preferred) add(ref, 'preferred');
  for (const ref of policy.allowed) add(ref, 'allowed');
  return [...options.values()];
}

/** §10.1 steps 3–5 on a semantically valid plan: Skills, normalization, policy. */
function checkPlan(
  outline: SceneOutline,
  input: {
    scenes: readonly AppScene[];
    outlineRecord: AppDocumentOutline | null;
    flow: readonly TeachingFlowEntry[];
    newSceneId: string;
    at: number;
    governed: boolean;
    eligibleImages: readonly PdfImage[];
  },
): PlanCheck {
  if (input.governed) {
    const failure = validateInsertionSkills(
      insertionSkillValidationSet(input.scenes, {
        id: input.newSceneId,
        teachingStage: outline.teachingStage,
        ...(outline.teachingSkills ? { teachingSkills: outline.teachingSkills } : {}),
      }),
      input.flow,
      input.newSceneId,
    );
    if (failure && failure.scope === 'new') {
      return {
        ok: false,
        fixable: true,
        messages: [`teachingSkills: ${failure.message}`],
        code: 'INSERTION_PLAN_INVALID',
        details: { validatorCode: failure.code },
      };
    }
    if (failure) {
      const error = insertionSkillsInvalidError(failure);
      return {
        ok: false,
        fixable: false,
        code: error.code,
        message: error.message,
        details: error.details,
      };
    }
  }
  const normalized = normalizeSourceGroundedVisuals([outline], input.flow, [
    ...input.eligibleImages,
  ]);
  const plan = normalized.outlines[0]!;
  const violations = policyViolations(
    input.scenes,
    input.outlineRecord,
    plan,
    input.at,
    input.flow,
    input.eligibleImages,
  );
  if (violations.length > 0) {
    return {
      ok: false,
      fixable: true,
      messages: violations.map(
        (diagnostic) =>
          `${diagnostic.field ?? diagnostic.code}: ${diagnostic.message}${diagnostic.allowedValues ? ` (allowed: ${diagnostic.allowedValues.join(', ')})` : ''}`,
      ),
      code: 'INSERTION_FLOW_POLICY_VIOLATION',
      details: { diagnostics: violations.map((d) => ({ code: d.code, field: d.field })) },
    };
  }
  return { ok: true, outline: plan, repairs: normalized.repairs };
}

/**
 * Build the document T2 persists from the sandwich's exact `doc` (§11.4 step
 * 2–3): re-check, shift Scenes only, add the candidate at its position, keep
 * the outline EXACTLY as loaded (D-6), migrate, stamp the governed baseline on
 * the migrated candidate, and validate (§10.7, §9.5). No model call.
 */
function buildFinalDocument(
  doc: AppDocument,
  candidate: AppScene,
  input: {
    request: SceneInsertionRequest;
    /** The normalized planned outline the candidate was generated from. */
    planned: SceneOutline;
    units: readonly ContentUnitRow[];
    flow: readonly TeachingFlowEntry[];
    governed: boolean;
    newSceneId: string;
    newOutlineId: string;
    eligible: readonly EligibleVisual[];
    now: number;
  },
): AppDocument {
  const outlineRecord = (doc.outline ?? null) as AppDocumentOutline | null;
  if (doc.scenes.some((scene) => scene.id === input.newSceneId)) {
    throw refusal('INSERTION_POSITION_CHANGED', 'the new slide id is already live');
  }
  const position = checkPositionAndUnits(
    input.request,
    doc.scenes,
    outlineRecord,
    input.units,
    input.flow,
    true,
  );
  const placed: AppScene = {
    ...candidate,
    id: input.newSceneId,
    stageId: doc.stage.id,
    order: position.at,
    outlineId: input.newOutlineId,
    teachingStage: { ...input.request.teachingStage },
    sourceContentUnitIds: [...input.request.unitIds],
  };
  const scenes = orderedScenes([...shiftScenesForInsertion(doc.scenes, position.at), placed]);
  const migratedCore = migrate({ stage: doc.stage, scenes }) as AppDocument;
  let migratedScenes = migratedCore.scenes as AppScene[];
  let fresh = migratedScenes.find((scene) => scene.id === input.newSceneId)!;
  if (input.governed) {
    const baseline = buildSceneAlignmentBaseline(fresh, { origin: 'generation', now: input.now });
    if (!baseline) {
      throw refusal(
        'INSERTION_ALIGNMENT_UNAVAILABLE',
        'the generated slide could not be given an alignment baseline (no classification)',
      );
    }
    fresh = { ...fresh, alignmentBaseline: baseline };
    migratedScenes = migratedScenes.map((scene) => (scene.id === fresh.id ? fresh : scene));
  }

  // §10.7 — the candidate on the exact snapshot.
  if (fresh.type !== 'slide' || fresh.content.type !== 'slide') {
    throw refusal('SCENE_CONTENT_GENERATION_FAILED', 'only a slide can be inserted');
  }
  try {
    assertGeneratedSlideScene(fresh);
  } catch (error) {
    throw refusal('SCENE_CONTENT_GENERATION_FAILED', (error as Error).message);
  }
  const findings = validateSceneActionStructure(migratedScenes, { stage: doc.stage }).filter(
    (finding) => finding.sceneId === fresh.id,
  );
  if (findings.length > 0) {
    throw refusal(findings[0]!.code, findings[0]!.message, { findings: findings.length });
  }
  assertCandidateVisuals(fresh, input.eligible);
  if (input.governed) {
    const failure = validateInsertionSkills(
      insertionSkillValidationSet(
        migratedScenes.filter((scene) => scene.id !== fresh.id),
        fresh,
      ),
      input.flow,
      fresh.id,
    );
    if (failure) {
      throw failure.scope === 'new'
        ? refusal(
            'INSERTION_PLAN_INVALID',
            `the new slide's Teaching Skills do not validate: ${failure.message}`,
            failure.details,
          )
        : insertionSkillsInvalidError(failure);
    }
  }
  const validation = validateAppScene(fresh);
  if (!validation.valid) {
    throw refusal(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the generated slide is not a valid scene: ${validation.errors
        .map((error) => `${error.path || '/'}: ${error.message}`)
        .join('; ')}`,
    );
  }
  // §9.5 — exact flow and the policy diagnostics on the real final document.
  exactFlowOrRefuse(migratedScenes, input.flow, outlineRecord);
  const violations = policyViolations(
    doc.scenes,
    outlineRecord,
    input.planned,
    position.at,
    input.flow,
    input.eligible.map((visual) => visual.image),
  );
  if (violations.length > 0) {
    throw refusal(
      'INSERTION_FLOW_POLICY_VIOLATION',
      `the lesson would gain a Teaching Model Flow policy problem (${violations[0]!.code})`,
      {
        diagnostics: violations.map((d) => ({
          code: d.code,
          field: d.field,
          outlineId: d.outlineId,
        })),
      },
    );
  }
  return {
    ...migratedCore,
    scenes: migratedScenes,
    // Written back EXACTLY as the sandwich loaded it (D-6).
    ...(doc.outline !== undefined ? { outline: doc.outline } : {}),
  } as AppDocument;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The status read for a write grant; another Stage's or version's id is a 404. */
export async function readSceneInsertionForGrant(
  pool: ConnectableQueryable,
  grant: Pick<InsertionGrant, 'tenantId' | 'versionId' | 'stageId'>,
  locate: { id: string } | { idempotencyKey: string },
  now = Date.now(),
): Promise<SceneInsertionStatusBody> {
  const id =
    'id' in locate
      ? locate.id
      : (await readSceneInsertionByKey(pool, grant.versionId, locate.idempotencyKey))?.id;
  const found = id ? await readSceneInsertionStatus(pool, id, now) : null;
  if (
    !found ||
    found.versionId !== grant.versionId ||
    found.stageId !== grant.stageId ||
    found.tenantId !== grant.tenantId
  ) {
    throw new TeachingPackageError('INSERTION_NOT_FOUND', 'slide insertion not found');
  }
  return insertionStatusBody(found);
}

/** The UI gate (§15). Never writes; expired rows are reported as not running. */
export async function readSceneInsertionGate(
  pool: ConnectableQueryable,
  grant: Pick<InsertionGrant, 'tenantId' | 'versionId' | 'stageId'> & {
    capability: 'read' | 'write';
  },
  now = Date.now(),
) {
  const context = await readInsertionContext(pool, grant);
  const versionStatus = context.version.status;
  const running =
    grant.capability === 'write'
      ? [
          ...(await listRunningSceneInsertions(pool, grant.stageId, now)).map((row) => ({
            kind: 'insertion' as const,
            id: row.insertionId,
          })),
          ...(await listRunningSceneRegenerations(pool, grant.stageId, now)).map((row) => ({
            kind: 'regeneration' as const,
            id: row.regenerationId,
            sceneId: row.sceneId,
          })),
        ]
      : [];
  return {
    capability: grant.capability,
    editable: EDITABLE.includes(versionStatus),
    versionStatus,
    supported: context.unsupportedReason === null,
    unsupportedReason: context.unsupportedReason,
    running,
  };
}

function humanStageLabel(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim();
}

/** The lesson parts and their coverage (§8.3) — never the unit text. */
export async function readContentUnitsForGrant(
  pool: ConnectableQueryable,
  grant: Pick<InsertionGrant, 'tenantId' | 'versionId' | 'stageId'>,
) {
  const context = await readInsertionContext(pool, grant);
  const document = (await documentStore(pool).loadDocument(grant.stageId)) as AppDocument | null;
  if (!document) throw refusal('STAGE_NOT_LIVE', 'the package stage is not live');
  const outlineRecord = (document.outline ?? null) as AppDocumentOutline | null;
  const coverage: UnitCoverage[] = computeContentUnitCoverage(
    context.units,
    document.scenes,
    outlineRecord,
  );
  const flow = context.flow ?? [];
  return {
    lineageStatus: context.lineageStatus,
    units: coverage.map((unit) => ({
      ...unit,
      suggestedPosition:
        unit.instructional && !unit.covered
          ? suggestInsertionPosition(unit.id, coverage, document.scenes)
          : null,
    })),
    positions: insertionPositionOptions(document.scenes, flow),
    stages: flow.map((entry, flowIndex) => ({
      key: entry.stage,
      flowIndex,
      label: humanStageLabel(entry.stage),
    })),
  };
}
