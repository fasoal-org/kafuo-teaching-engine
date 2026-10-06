/**
 * Reviewer-driven single-slide regeneration — the service
 * (single-slide-regeneration-plan §5–§10).
 *
 *   authorized grant (route) → request validation → model route (no writes)
 *   → T1 start → generation (no transaction) → T2 atomic commit
 *   ↘ any failure after T1: T3 marks the row failed (the Scene is untouched)
 *
 * The reviewer submits two separate texts: `instruction` (the edit directive,
 * the only text a model sees) and `reason` (the audit justification, stored on
 * the row and the review events and passed to nothing else).
 */
import { createHash } from 'node:crypto';

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
import { readRetainedVersionContext, readVersionById } from '@/lib/persistence/teaching-package';
import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';
import {
  isTeachingPackageStageLockedError,
  TeachingPackageError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import { resolveGovernedRegenerationContext } from '@/lib/server/teaching-package/governed-regeneration';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { regenerateOneScene } from '@/lib/server/teaching-package/regenerate-one-scene';
import { createRegenerationRoute } from '@/lib/server/teaching-package/routed-regeneration-call';
import {
  commitSceneRegeneration,
  failSceneRegeneration,
  listRunningSceneRegenerations,
  newSceneRegenerationId,
  readLiveScene,
  readSceneRegenerationByKey,
  readSceneRegenerationStatus,
  recordSceneRegenerationRefusal,
  recordSceneRegenerationRoute,
  restoreSceneRegeneration,
  startSceneRegeneration,
  type SceneRegeneration,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import { sceneRegenerationSessionRef } from '@/lib/server/teaching-package/editor-grant';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneRegeneration');

/** Field limits, trimmed (§12.2) — mirrored by the dialog. */
export const SCENE_REGENERATION_LIMITS = {
  instruction: { min: 10, max: 2000 },
  reason: { min: 5, max: 1000 },
  idempotencyKey: { min: 8, max: 128 },
} as const;

export const SUPPORTED_REGENERATION_SCENE_TYPES = ['slide', 'quiz'] as const;

const EDITABLE: readonly TeachingPackageStatus[] = ['draft', 'rejected'];

/** The authorized grant, as the route resolved it (never the request body). */
export interface RegenerationGrant {
  tenantId: string;
  versionId: string;
  stageId: string;
  learnerKey: string;
}

export interface SceneRegenerationRequest {
  instruction: string;
  reason: string;
  idempotencyKey: string;
}

function invalid(field: string, rule: string, limit?: number): TeachingPackageError {
  return new TeachingPackageError(
    'INVALID_REQUEST',
    `${field} ${rule === 'required' ? 'is required' : rule === 'min' ? `needs at least ${limit} characters` : rule === 'max' ? `allows at most ${limit} characters` : 'is malformed'}`,
    { field, rule, ...(limit === undefined ? {} : { limit }) },
  );
}

/** Validate and normalize the body. Errors carry `{field, rule, limit}`. */
export function parseSceneRegenerationRequest(
  body: Record<string, unknown> | null,
): SceneRegenerationRequest {
  if (!body) throw invalid('body', 'required');
  const text = (field: 'instruction' | 'reason') => {
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') throw invalid(field, 'required');
    const trimmed = value.trim();
    const { min, max } = SCENE_REGENERATION_LIMITS[field];
    if (trimmed.length < min) throw invalid(field, 'min', min);
    if (trimmed.length > max) throw invalid(field, 'max', max);
    return trimmed;
  };
  const instruction = text('instruction');
  const reason = text('reason');
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || key === '') throw invalid('idempotencyKey', 'required');
  const { min, max } = SCENE_REGENERATION_LIMITS.idempotencyKey;
  if (key.length < min) throw invalid('idempotencyKey', 'min', min);
  if (key.length > max) throw invalid('idempotencyKey', 'max', max);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw invalid('idempotencyKey', 'format');
  return { instruction, reason, idempotencyKey: key };
}

/** The digest an idempotency key is bound to: same key + different body → 409. */
export function sceneRegenerationRequestDigest(
  sceneId: string,
  request: Pick<SceneRegenerationRequest, 'instruction' | 'reason'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ sceneId, instruction: request.instruction, reason: request.reason }))
    .digest('hex');
}

export function sceneRegenerationActorRef(stageId: string): string {
  return `teaching-package-editor:${stageId}`;
}

const KNOWN_FAILURE_CODES = new Set<string>([
  'SCENE_TYPE_NOT_REGENERABLE',
  'SOURCE_VISUAL_UNRESOLVED',
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
  'SCENE_CHANGED_DURING_REGENERATION',
  'REGENERATION_LEASE_LOST',
  'DOCUMENT_NOT_CURRENT',
  'STAGE_LOCKED',
  'STAGE_NOT_LIVE',
  'SKILL_POLICY_REQUIRED',
  'REGENERATION_PERSISTENCE_FAILED',
]);

/** The error a stored failure code replays as. */
export function storedFailureError(row: SceneRegeneration): TeachingPackageError {
  const stored = row.errorCode ?? 'REGENERATION_PERSISTENCE_FAILED';
  const code: TeachingPackageErrorCode =
    stored === 'LEASE_EXPIRED'
      ? 'REGENERATION_LEASE_LOST'
      : KNOWN_FAILURE_CODES.has(stored)
        ? (stored as TeachingPackageErrorCode)
        : 'REGENERATION_PERSISTENCE_FAILED';
  return new TeachingPackageError(
    code,
    `this regeneration failed (${stored}); nothing was written`,
    {
      regenerationId: row.id,
      failureCode: stored,
      replayed: true,
    },
  );
}

export interface SceneRegenerationResult {
  regenerationId: string;
  status: 'succeeded';
  replayed: boolean;
  sceneId: string;
  /** The immutable snapshot written by this regeneration. */
  scene: AppScene;
  resultSceneRev: number;
  /** What the database holds now (may differ on a replay after later edits). */
  current: { rev: number; scene: AppScene } | null;
}

export type SceneRegenerationResponse =
  | { status: 200; body: SceneRegenerationResult }
  | {
      status: 202;
      body: { regenerationId: string; status: 'running'; replayed: true; sceneId: string };
    };

export interface SceneRegenerationDeps {
  pool: ConnectableQueryable;
  now?: () => number;
  leaseSeconds?: number;
  /** Test seams. */
  createRoute?: typeof createRegenerationRoute;
  regenerate?: typeof regenerateOneScene;
  resolveGoverned?: typeof resolveGovernedRegenerationContext;
  routingMode?: 'enforced' | 'off';
}

function documentStore(pool: ConnectableQueryable) {
  return createOwnerBoundDocumentStore<AppScene, AppStage>({
    pool: pool as unknown as TransactionSource,
    ownerId: TEACHING_PACKAGE_STAGE_OWNER,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

async function replayResponse(
  pool: ConnectableQueryable,
  row: SceneRegeneration,
  now: number,
): Promise<SceneRegenerationResponse> {
  if (row.status === 'running' && row.leaseExpiresAt > now) {
    return {
      status: 202,
      body: { regenerationId: row.id, status: 'running', replayed: true, sceneId: row.sceneId },
    };
  }
  if (row.status === 'succeeded' && row.resultScene && row.resultSceneRev !== null) {
    return {
      status: 200,
      body: {
        regenerationId: row.id,
        status: 'succeeded',
        replayed: true,
        sceneId: row.sceneId,
        scene: row.resultScene,
        resultSceneRev: row.resultSceneRev,
        current: await readLiveScene(pool, row.stageId, row.sceneId),
      },
    };
  }
  throw storedFailureError(row);
}

/**
 * Regenerate one slide. Throws `TeachingPackageError` /
 * `TeachingPackageStageLockedError` for every refusal and failure; the route
 * maps them onto the API envelope.
 */
export async function regenerateSlideScene(
  grant: RegenerationGrant,
  sceneId: string,
  request: SceneRegenerationRequest,
  deps: SceneRegenerationDeps,
): Promise<SceneRegenerationResponse> {
  const { pool } = deps;
  const clock = deps.now ?? Date.now;
  const actorRef = sceneRegenerationActorRef(grant.stageId);
  const requestDigest = sceneRegenerationRequestDigest(sceneId, request);

  // Producing-attempt context: the routed subject and the recorded register.
  const retained = await readRetainedVersionContext(pool, grant.versionId, {
    tenantId: grant.tenantId,
  });
  const version = await readVersionById(pool, grant.versionId);
  if (!version || version.tenantId !== grant.tenantId || version.currentStageId !== grant.stageId) {
    throw new TeachingPackageError('NOT_FOUND', 'teaching package not found');
  }
  const stageDocument = (await documentStore(pool).loadDocument(
    grant.stageId,
  )) as AppDocument | null;
  if (!stageDocument) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
  }
  const stage = stageDocument.stage;
  const snapshot = retained?.inputSnapshot as
    | { subjectCode?: string; speechRegister?: Record<string, unknown> }
    | undefined;
  const subjectCode = snapshot?.subjectCode ?? undefined;
  const registerPolicy = resolveSpeechRegisterPolicy({
    language: stage.language,
    subjectCode: subjectCode ?? null,
  });

  // A replay never re-runs: answer it before resolving any route.
  const prior = await readSceneRegenerationByKey(pool, grant.versionId, request.idempotencyKey);
  if (prior && prior.requestDigest === requestDigest && prior.status !== 'running') {
    return replayResponse(pool, prior, clock());
  }

  // The model route, resolved BEFORE any row exists: an unroutable package
  // refuses without a write.
  const regenerationId = newSceneRegenerationId();
  const createRoute = deps.createRoute ?? createRegenerationRoute;
  const editable = EDITABLE.includes(version.status);
  const route = editable
    ? await createRoute({
        tenantId: grant.tenantId,
        versionId: grant.versionId,
        regenerationId,
        generationAttemptId: retained?.attemptId ?? null,
        learningItem: version.learningItem,
        snapshotSubjectCode: subjectCode,
        stageSubjectCode: stage.subjectCode,
        queryable: pool,
        ...(deps.routingMode ? { mode: deps.routingMode } : {}),
      })
    : null;

  // T1.
  const started = await startSceneRegeneration(pool, {
    id: regenerationId,
    tenantId: grant.tenantId,
    versionId: grant.versionId,
    stageId: grant.stageId,
    sceneId,
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
    now: clock(),
    ...(deps.leaseSeconds !== undefined ? { leaseSeconds: deps.leaseSeconds } : {}),
  });
  if (started.kind === 'refused') {
    const { refusal } = started;
    if (refusal.audited) {
      await recordSceneRegenerationRefusal(pool, {
        versionId: grant.versionId,
        actorRef,
        reason: request.reason,
        sceneId,
        refusalCode: refusal.code,
        idempotencyKey: request.idempotencyKey,
        now: clock(),
      }).catch((error) => log.warn('could not record the refused regeneration', error));
    }
    throw new TeachingPackageError(refusal.code, refusal.message);
  }
  if (started.kind === 'replay') return replayResponse(pool, started.regeneration, clock());
  const row = started.regeneration;
  if (!route) {
    // Unreachable: T1 refuses a non-editable version before inserting.
    throw new TeachingPackageError('STAGE_LOCKED', 'the teaching package is not editable');
  }
  await recordSceneRegenerationRoute(pool, row.id, route.description).catch(() => {});

  const fail = async (errorCode: string, candidateScene?: AppScene | null) => {
    try {
      await failSceneRegeneration(pool, {
        regenerationId: row.id,
        attemptToken: row.attemptToken,
        errorCode,
        candidateScene: candidateScene ?? null,
        now: clock(),
      });
    } catch (error) {
      // The lease expires and a later reclaim records LEASE_EXPIRED.
      log.warn(`could not record the failure of regeneration ${row.id}`, error);
    }
  };

  // Generation — no transaction is open while the model runs.
  let candidate: AppScene;
  try {
    const resolveGoverned = deps.resolveGoverned ?? resolveGovernedRegenerationContext;
    const governed = await resolveGoverned(pool, grant.versionId, row.previousScene);
    const scenes = stageDocument.scenes.map((scene) =>
      scene.id === row.sceneId ? row.previousScene : scene,
    );
    const generated = await (deps.regenerate ?? regenerateOneScene)({
      scene: row.previousScene,
      scenes,
      stage,
      ...(stageDocument.outline
        ? { outlineSnapshot: stageDocument.outline as AppDocumentOutline }
        : {}),
      instruction: request.instruction,
      aiCallFor: route.aiCallFor,
      assertRouteAvailable: route.assertAvailable,
      registerPolicy,
      ...(governed ? { governed } : {}),
      refuseFallbackActions: true,
      now: clock,
    });
    if (!generated.ok) {
      await fail(generated.code);
      throw new TeachingPackageError(generated.code, generated.message, {
        regenerationId: row.id,
        ...(generated.details && typeof generated.details === 'object' ? generated.details : {}),
      });
    }
    candidate = generated.scene;
  } catch (error) {
    if (error instanceof TeachingPackageError) {
      if (!(error.details as { regenerationId?: string } | undefined)?.regenerationId) {
        await fail(error.code);
      }
      throw error;
    }
    await fail('SCENE_CONTENT_GENERATION_FAILED');
    throw error;
  }

  // T2.
  try {
    const committed = await commitSceneRegeneration(
      pool,
      {
        regenerationId: row.id,
        attemptToken: row.attemptToken,
        tenantId: grant.tenantId,
        versionId: grant.versionId,
        stageId: grant.stageId,
        sceneId: row.sceneId,
        baseSceneRev: row.baseSceneRev,
        actorRef,
        reason: request.reason,
        now: clock,
      },
      candidate,
    );
    return {
      status: 200,
      body: {
        regenerationId: row.id,
        status: 'succeeded',
        replayed: false,
        sceneId: row.sceneId,
        scene: committed.resultScene,
        resultSceneRev: committed.resultSceneRev,
        current: await readLiveScene(pool, grant.stageId, row.sceneId),
      },
    };
  } catch (error) {
    // The provider answered; the commit did not happen. X is intact (T2
    // rolled back); keep the candidate for diagnosis, never apply it.
    const code =
      error instanceof TeachingPackageError
        ? error.code
        : isTeachingPackageStageLockedError(error)
          ? 'STAGE_LOCKED'
          : 'REGENERATION_PERSISTENCE_FAILED';
    await fail(code, candidate);
    if (error instanceof TeachingPackageError || isTeachingPackageStageLockedError(error)) {
      throw error;
    }
    log.error(`regeneration ${row.id} could not be committed`, error);
    throw new TeachingPackageError(
      'REGENERATION_PERSISTENCE_FAILED',
      'the slide was generated but could not be saved; nothing was written — try again',
      { regenerationId: row.id },
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface SceneRegenerationStatusBody {
  regenerationId: string;
  sceneId: string;
  status: 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  resultSceneRev: number | null;
  scene: AppScene | null;
  current: { rev: number; scene: AppScene } | null;
  requestedAt: number;
  completedAt: number | null;
  restoredAt: number | null;
}

/** The status read for a write grant; another Stage's or version's id is a 404. */
export async function readSceneRegenerationForGrant(
  pool: ConnectableQueryable,
  grant: Pick<RegenerationGrant, 'tenantId' | 'versionId' | 'stageId'>,
  locate: { id: string } | { idempotencyKey: string },
  now = Date.now(),
): Promise<SceneRegenerationStatusBody> {
  const id =
    'id' in locate
      ? locate.id
      : (await readSceneRegenerationByKey(pool, grant.versionId, locate.idempotencyKey))?.id;
  const found = id ? await readSceneRegenerationStatus(pool, id, now) : null;
  if (
    !found ||
    found.regeneration.versionId !== grant.versionId ||
    found.regeneration.stageId !== grant.stageId ||
    found.regeneration.tenantId !== grant.tenantId
  ) {
    throw new TeachingPackageError('REGENERATION_NOT_FOUND', 'regeneration not found');
  }
  const row = found.regeneration;
  return {
    regenerationId: row.id,
    sceneId: row.sceneId,
    status: row.status,
    errorCode: row.errorCode,
    resultSceneRev: row.resultSceneRev,
    scene: row.resultScene,
    current: found.current,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
    restoredAt: row.restoredAt,
  };
}

/** The UI gate (§12.1). Never writes; expired rows are reported as not running. */
export async function readSceneRegenerationGate(
  pool: ConnectableQueryable,
  grant: Pick<RegenerationGrant, 'versionId' | 'stageId'> & { capability: 'read' | 'write' },
  now = Date.now(),
) {
  const version = await readVersionById(pool, grant.versionId);
  const versionStatus = version?.status ?? null;
  return {
    capability: grant.capability,
    editable: versionStatus !== null && EDITABLE.includes(versionStatus),
    versionStatus,
    supportedSceneTypes: [...SUPPORTED_REGENERATION_SCENE_TYPES],
    running:
      grant.capability === 'write'
        ? await listRunningSceneRegenerations(pool, grant.stageId, now)
        : [],
  };
}

/** Phase 3: restore the pre-image of a succeeded regeneration (write grant only). */
export async function restoreSlideScene(
  pool: ConnectableQueryable,
  grant: Pick<RegenerationGrant, 'tenantId' | 'versionId' | 'stageId'>,
  regenerationId: string,
  now?: () => number,
) {
  const status = await readSceneRegenerationForGrant(pool, grant, { id: regenerationId });
  const restored = await restoreSceneRegeneration(pool, {
    regenerationId: status.regenerationId,
    tenantId: grant.tenantId,
    actorRef: sceneRegenerationActorRef(grant.stageId),
    ...(now ? { now } : {}),
  });
  return {
    regenerationId: status.regenerationId,
    sceneId: status.sceneId,
    restoredSceneRev: restored.restoredSceneRev,
    scene: restored.scene,
  };
}
