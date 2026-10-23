/**
 * Reviewer-generated slide for an uncovered lesson part — persistence
 * (reviewer-generated-slide-for-lesson-part-plan §11).
 *
 * Three transactions around one uncommitted model run:
 *
 * - **T1 `startSceneInsertion`** — under `stage_meta FOR UPDATE` (the
 *   Stage-wide paid-generation mutex the regeneration T1 takes too, R2) and
 *   the version `FOR SHARE`: reclaim the Stage's expired insertion AND
 *   regeneration leases, answer an idempotent replay, re-check the request on
 *   the live data, refuse while an insertion or a regeneration runs, insert
 *   the `running` row and the `started` event.
 * - **T2 `commitSceneInsertion`** — a revision → document → revision
 *   sandwich builds the whole document (R1), then ONE owner-bound
 *   `saveDocument` with {@link insertionCommitFence} composed ahead of the
 *   stage guard. Its `'before'` takes `stage_meta FOR UPDATE` itself (the
 *   owner-bound transaction runs the fence before its own lock, F36) and
 *   requires the stage revision to still equal the sandwich's; its `'after'`
 *   marks the row `succeeded` with the per-Scene revision lineage and appends
 *   the `completed` event before COMMIT. A moved revision rebuilds (≤ 3 builds
 *   in total) from the new state with the SAME candidate — no model call.
 * - **T3 `failSceneInsertion`** — a guarded `running → failed`, the planned
 *   outline and candidate kept for diagnosis, and the `failed` event.
 *
 * The outline record is written back exactly as the sandwich loaded it (D-6);
 * no `@openmaic/storage` change.
 */
import { randomBytes } from 'node:crypto';

import { DocumentVersionError, readStageFreshnessManifest } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { OwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
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
import { appendReviewEvent } from '@/lib/persistence/teaching-package';
import {
  isPgUniqueViolation,
  TeachingPackageError,
  TeachingPackageStageLockedError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  readLiveScene,
  reclaimExpiredStageRegenerations,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import {
  reclaimExpiredSceneInsertions,
  runningSceneInsertionId,
} from '@/lib/server/teaching-package/stage-generation-mutex';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { ReviewEventType, TeachingPackageStatus } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

const EDITABLE: readonly TeachingPackageStatus[] = ['draft', 'rejected'];

export const DEFAULT_SCENE_INSERTION_LEASE_SECONDS = 900;

/** `SCENE_INSERTION_LEASE_SECONDS`, default 900 (15 min), clamped to ≥ 60. */
export function sceneInsertionLeaseSeconds(): number {
  const raw = Number(process.env.SCENE_INSERTION_LEASE_SECONDS);
  return Number.isFinite(raw) && raw >= 60
    ? Math.floor(raw)
    : DEFAULT_SCENE_INSERTION_LEASE_SECONDS;
}

/** Build attempts of T2 in total (sandwich retries and moved revisions alike). */
export const MAX_INSERTION_BUILDS = 3;

export type SceneInsertionStatus = 'running' | 'succeeded' | 'failed';

export interface TeachingStageRef {
  key: string;
  flowIndex: number;
}

export type SceneRevTransitions = Record<string, { before: number; after: number }>;

export interface SceneInsertion {
  id: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  newSceneId: string;
  newOutlineId: string;
  unitIds: string[];
  afterSceneId: string | null;
  beforeSceneId: string | null;
  teachingStage: TeachingStageRef;
  idempotencyKey: string;
  requestDigest: string;
  instruction: string;
  reason: string;
  actorRef: string;
  sessionRef: string | null;
  status: SceneInsertionStatus;
  attemptToken: string;
  leaseExpiresAt: number;
  plannedOutline: Record<string, unknown> | null;
  outlineRepairs: unknown[] | null;
  candidateScene: AppScene | null;
  resultScene: AppScene | null;
  resultSceneRev: number | null;
  sceneRevTransitions: SceneRevTransitions | null;
  errorCode: string | null;
  registerPolicy: Record<string, unknown> | null;
  modelRoute: Record<string, unknown> | null;
  requestedAt: number;
  completedAt: number | null;
}

interface RawInsertionRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  version_id: string;
  stage_id: string;
  new_scene_id: string;
  new_outline_id: string;
  unit_ids: unknown;
  after_scene_id: string | null;
  before_scene_id: string | null;
  teaching_stage: unknown;
  idempotency_key: string;
  request_digest: string;
  instruction: string;
  reason: string;
  actor_ref: string;
  session_ref: string | null;
  status: string;
  attempt_token: string;
  lease_expires_at: number | string;
  planned_outline: unknown;
  outline_repairs: unknown;
  candidate_scene: unknown;
  result_scene: unknown;
  result_scene_rev: number | string | null;
  scene_rev_transitions: unknown;
  error_code: string | null;
  register_policy: unknown;
  model_route: unknown;
  requested_at: number | string;
  completed_at: number | string | null;
}

const COLUMNS = `id, tenant_id, version_id, stage_id, new_scene_id, new_outline_id, unit_ids,
  after_scene_id, before_scene_id, teaching_stage, idempotency_key, request_digest, instruction,
  reason, actor_ref, session_ref, status, attempt_token, lease_expires_at, planned_outline,
  outline_repairs, candidate_scene, result_scene, result_scene_rev, scene_rev_transitions,
  error_code, register_policy, model_route, requested_at, completed_at`;

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) return JSON.parse(value) as T;
  return value as T;
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function rowToInsertion(row: RawInsertionRow): SceneInsertion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    versionId: row.version_id,
    stageId: row.stage_id,
    newSceneId: row.new_scene_id,
    newOutlineId: row.new_outline_id,
    unitIds: json<string[]>(row.unit_ids) ?? [],
    afterSceneId: row.after_scene_id,
    beforeSceneId: row.before_scene_id,
    teachingStage: json<TeachingStageRef>(row.teaching_stage)!,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    instruction: row.instruction,
    reason: row.reason,
    actorRef: row.actor_ref,
    sessionRef: row.session_ref,
    status: row.status as SceneInsertionStatus,
    attemptToken: row.attempt_token,
    leaseExpiresAt: Number(row.lease_expires_at),
    plannedOutline: json<Record<string, unknown>>(row.planned_outline),
    outlineRepairs: json<unknown[]>(row.outline_repairs),
    candidateScene: json<AppScene>(row.candidate_scene),
    resultScene: json<AppScene>(row.result_scene),
    resultSceneRev: numberOrNull(row.result_scene_rev),
    sceneRevTransitions: json<SceneRevTransitions>(row.scene_rev_transitions),
    errorCode: row.error_code,
    registerPolicy: json<Record<string, unknown>>(row.register_policy),
    modelRoute: json<Record<string, unknown>>(row.model_route),
    requestedAt: Number(row.requested_at),
    completedAt: numberOrNull(row.completed_at),
  };
}

export function newSceneInsertionId(): string {
  return `tpsi_${randomBytes(9).toString('base64url')}`;
}

function newAttemptToken(): string {
  return randomBytes(18).toString('base64url');
}

export async function readSceneInsertion(
  queryable: Queryable,
  id: string,
): Promise<SceneInsertion | null> {
  const result = await queryable.query<RawInsertionRow>(
    `SELECT ${COLUMNS} FROM teaching_package_scene_insertions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToInsertion(result.rows[0]) : null;
}

export async function readSceneInsertionByKey(
  queryable: Queryable,
  versionId: string,
  idempotencyKey: string,
): Promise<SceneInsertion | null> {
  const result = await queryable.query<RawInsertionRow>(
    `SELECT ${COLUMNS} FROM teaching_package_scene_insertions
      WHERE version_id = $1 AND idempotency_key = $2`,
    [versionId, idempotencyKey],
  );
  return result.rows[0] ? rowToInsertion(result.rows[0]) : null;
}

/** Running insertions of a Stage whose lease is still valid (the gate's read; never writes). */
export async function listRunningSceneInsertions(
  queryable: Queryable,
  stageId: string,
  now: number,
): Promise<Array<{ insertionId: string }>> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM teaching_package_scene_insertions
      WHERE stage_id = $1 AND status = 'running' AND lease_expires_at > $2
      ORDER BY requested_at`,
    [stageId, now],
  );
  return result.rows.map((row) => ({ insertionId: row.id }));
}

interface EventContext {
  versionId: string;
  status: TeachingPackageStatus;
  actorRef: string;
  reason: string | null;
}

async function appendInsertionEvent(
  queryable: Queryable,
  eventType: Extract<ReviewEventType, `scene_insertion_${string}`>,
  context: EventContext,
  data: Record<string, unknown>,
  now: number,
): Promise<void> {
  await appendReviewEvent(queryable, {
    versionId: context.versionId,
    eventType,
    // An insertion never changes the version's status.
    fromStatus: context.status,
    toStatus: context.status,
    actorRef: context.actorRef,
    reason: context.reason,
    data,
    createdAt: now,
  });
}

/** The live document as T1 reads it under its locks (plain SQL, no store). */
export interface LiveStageData {
  scenes: AppScene[];
  outline: AppDocumentOutline | null;
}

async function readLiveStageData(queryable: Queryable, stageId: string): Promise<LiveStageData> {
  const scenes = await queryable.query<{ data: unknown }>(
    'SELECT data FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order, id',
    [stageId],
  );
  const outline = await queryable.query<{ data: unknown }>(
    'SELECT data FROM document_outlines WHERE stage_id = $1',
    [stageId],
  );
  return {
    scenes: scenes.rows.map((row) => json<AppScene>(row.data)!),
    outline: json<AppDocumentOutline>(outline.rows[0]?.data),
  };
}

// ---------------------------------------------------------------------------
// T1 — start
// ---------------------------------------------------------------------------

/** A refusal decided under T1's locks; the caller records it (own transaction) and throws. */
export interface SceneInsertionRefusal {
  code: TeachingPackageErrorCode;
  message: string;
  details?: unknown;
  /** Whether it is recorded as a `scene_insertion_refused` event. */
  audited: boolean;
}

export interface StartSceneInsertionInput {
  /** Pre-minted so the model route can name it in the ledger; minted here otherwise. */
  id?: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  newSceneId: string;
  newOutlineId: string;
  unitIds: string[];
  afterSceneId: string | null;
  beforeSceneId: string | null;
  teachingStage: TeachingStageRef;
  idempotencyKey: string;
  requestDigest: string;
  instruction: string;
  reason: string;
  actorRef: string;
  sessionRef: string | null;
  registerPolicy?: Record<string, unknown> | null;
  /**
   * The authoritative re-check of anchors, coverage and the allowed stage on
   * the live data, run under T1's locks (§11.3 step 5). `null` = pass.
   */
  recheck: (live: LiveStageData) => SceneInsertionRefusal | null;
  now?: number;
  leaseSeconds?: number;
}

export type StartSceneInsertionOutcome =
  | { kind: 'started'; insertion: SceneInsertion; versionStatus: TeachingPackageStatus }
  | { kind: 'replay'; insertion: SceneInsertion }
  | { kind: 'refused'; refusal: SceneInsertionRefusal };

function refused(
  code: TeachingPackageErrorCode,
  message: string,
  audited: boolean,
  details?: unknown,
): StartSceneInsertionOutcome {
  return {
    kind: 'refused',
    refusal: { code, message, audited, ...(details === undefined ? {} : { details }) },
  };
}

export async function startSceneInsertion(
  pool: ConnectableQueryable,
  input: StartSceneInsertionInput,
): Promise<StartSceneInsertionOutcome> {
  try {
    return await startOnce(pool, input);
  } catch (error) {
    if (!isPgUniqueViolation(error)) throw error;
    // Behind the mutex the unique indexes are a backstop only.
    const constraint = (error as { constraint?: string }).constraint;
    if (constraint === 'tpsi_version_key_unique') return startOnce(pool, input);
    return refused(
      'SCENE_INSERTION_IN_PROGRESS',
      'another AI slide insertion is running on this lesson',
      true,
    );
  }
}

async function startOnce(
  pool: ConnectableQueryable,
  input: StartSceneInsertionInput,
): Promise<StartSceneInsertionOutcome> {
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const now = input.now ?? Date.now();
    // 1. The Stage mutex: service-owned, live.
    const meta = await tx.query<{ owner_id: string; deleted_at: unknown }>(
      'SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 FOR UPDATE',
      [input.stageId],
    );
    const stageRow = meta.rows[0];
    if (
      !stageRow ||
      stageRow.owner_id !== TEACHING_PACKAGE_STAGE_OWNER ||
      stageRow.deleted_at !== null
    ) {
      throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
    }
    // 2. The version: same tenant, still pointing at this Stage, editable.
    const versionResult = await tx.query<{
      tenant_id: string;
      current_stage_id: string;
      status: string;
    }>(
      `SELECT tenant_id, current_stage_id, status FROM teaching_package_versions
        WHERE id = $1 FOR SHARE`,
      [input.versionId],
    );
    const version = versionResult.rows[0];
    if (
      !version ||
      version.tenant_id !== input.tenantId ||
      version.current_stage_id !== input.stageId
    ) {
      throw new TeachingPackageError('NOT_FOUND', 'teaching package not found');
    }
    const versionStatus = version.status as TeachingPackageStatus;
    if (!EDITABLE.includes(versionStatus)) {
      return refused(
        'STAGE_LOCKED',
        `the teaching package is ${versionStatus}; only draft or rejected packages can be edited`,
        true,
      );
    }
    // 3. Reclaim expired leases in both tables, for the whole Stage.
    await reclaimExpiredSceneInsertions(tx, { stageId: input.stageId }, now);
    await reclaimExpiredStageRegenerations(tx, input.stageId, now);
    // 4. The authoritative replay lookup.
    const existing = await tx.query<RawInsertionRow>(
      `SELECT ${COLUMNS} FROM teaching_package_scene_insertions
        WHERE version_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [input.versionId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const prior = rowToInsertion(existing.rows[0]);
      if (prior.requestDigest !== input.requestDigest) {
        return refused(
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was already used for a different request',
          true,
        );
      }
      return { kind: 'replay', insertion: prior };
    }
    // 5. Re-check on the live data (cheap reads, authoritative).
    const recheck = input.recheck(await readLiveStageData(tx, input.stageId));
    if (recheck) return { kind: 'refused', refusal: recheck };
    // 6. Running checks (after the reclaim, every running row holds a lease).
    if (await runningSceneInsertionId(tx, input.stageId, now)) {
      return refused(
        'SCENE_INSERTION_IN_PROGRESS',
        'another AI slide insertion is running on this lesson',
        true,
      );
    }
    const regenerating = await tx.query<{ id: string }>(
      `SELECT id FROM teaching_package_scene_regenerations
        WHERE stage_id = $1 AND status = 'running' AND lease_expires_at > $2 LIMIT 1`,
      [input.stageId, now],
    );
    if (regenerating.rows[0]) {
      return refused(
        'STAGE_GENERATION_IN_PROGRESS',
        'a slide regeneration is running on this lesson; try again when it finishes',
        true,
      );
    }
    // 7. The running row and the started event.
    const id = input.id ?? newSceneInsertionId();
    const leaseSeconds = input.leaseSeconds ?? sceneInsertionLeaseSeconds();
    const inserted = await tx.query<RawInsertionRow>(
      `INSERT INTO teaching_package_scene_insertions
         (id, tenant_id, version_id, stage_id, new_scene_id, new_outline_id, unit_ids,
          after_scene_id, before_scene_id, teaching_stage, idempotency_key, request_digest,
          instruction, reason, actor_ref, session_ref, status, attempt_token, lease_expires_at,
          register_policy, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, $14, $15,
               $16, 'running', $17, $18, $19::jsonb, $20)
       RETURNING ${COLUMNS}`,
      [
        id,
        input.tenantId,
        input.versionId,
        input.stageId,
        input.newSceneId,
        input.newOutlineId,
        JSON.stringify(input.unitIds),
        input.afterSceneId,
        input.beforeSceneId,
        JSON.stringify(input.teachingStage),
        input.idempotencyKey,
        input.requestDigest,
        input.instruction,
        input.reason,
        input.actorRef,
        input.sessionRef,
        newAttemptToken(),
        now + leaseSeconds * 1000,
        input.registerPolicy ? JSON.stringify(input.registerPolicy) : null,
        now,
      ],
    );
    const insertion = rowToInsertion(inserted.rows[0]!);
    // The instruction and the reason in separate fields; neither reaches a model here.
    await appendInsertionEvent(
      tx,
      'scene_insertion_started',
      {
        versionId: input.versionId,
        status: versionStatus,
        actorRef: input.actorRef,
        reason: input.reason,
      },
      {
        insertionId: id,
        newSceneId: input.newSceneId,
        unitIds: input.unitIds,
        afterSceneId: input.afterSceneId,
        beforeSceneId: input.beforeSceneId,
        teachingStage: input.teachingStage,
        instruction: input.instruction,
        idempotencyKey: input.idempotencyKey,
        sessionRef: input.sessionRef,
        requestedAt: now,
      },
      now,
    );
    return { kind: 'started', insertion, versionStatus };
  });
}

/**
 * The `refused` audit event, in its own transaction: authorized write grants
 * only, for refusals decided after the version is resolved.
 */
export async function recordSceneInsertionRefusal(
  pool: ConnectableQueryable,
  input: {
    versionId: string;
    actorRef: string;
    reason: string;
    refusalCode: string;
    idempotencyKey: string;
    unitIds: string[];
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? Date.now();
  const version = await pool.query<{ status: string }>(
    'SELECT status FROM teaching_package_versions WHERE id = $1',
    [input.versionId],
  );
  const status = version.rows[0]?.status as TeachingPackageStatus | undefined;
  if (!status) return;
  await appendInsertionEvent(
    pool,
    'scene_insertion_refused',
    { versionId: input.versionId, status, actorRef: input.actorRef, reason: input.reason },
    {
      refusalCode: input.refusalCode,
      idempotencyKey: input.idempotencyKey,
      unitIds: input.unitIds,
    },
    now,
  );
}

/** Record the route and the normalized plan (diagnostic; not part of any decision). */
export async function recordSceneInsertionProgress(
  queryable: Queryable,
  insertionId: string,
  progress: {
    modelRoute?: Record<string, unknown>;
    plannedOutline?: Record<string, unknown>;
    outlineRepairs?: unknown[];
  },
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_scene_insertions
        SET model_route = COALESCE($2::jsonb, model_route),
            planned_outline = COALESCE($3::jsonb, planned_outline),
            outline_repairs = COALESCE($4::jsonb, outline_repairs)
      WHERE id = $1 AND status = 'running'`,
    [
      insertionId,
      progress.modelRoute ? JSON.stringify(progress.modelRoute) : null,
      progress.plannedOutline ? JSON.stringify(progress.plannedOutline) : null,
      progress.outlineRepairs ? JSON.stringify(progress.outlineRepairs) : null,
    ],
  );
}

// ---------------------------------------------------------------------------
// T2 — commit
// ---------------------------------------------------------------------------

export interface InsertionCommitContext {
  insertionId: string;
  attemptToken: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  newSceneId: string;
  actorRef: string;
  reason: string;
  now?: () => number;
}

export interface InsertionCompletion {
  resultScene: AppScene;
  resultSceneRev: number;
  sceneRevTransitions: SceneRevTransitions;
  completedAt: number;
}

interface InsertionCommitState {
  /** The sandwich's stage revision and per-Scene revisions for this build. */
  expectedRev?: number;
  beforeRevs?: ReadonlyMap<string, number>;
  completed?: InsertionCompletion;
  completions: number;
}

type FenceOperation = { stageId?: string; mode: string; scope: 'content' | 'library' };

/** The stage revision moved between the sandwich and the fence: rebuild. */
export class StageRevisionMovedError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`the stage revision moved (${expected} → ${actual}) before the insertion commit`);
    this.name = 'StageRevisionMovedError';
  }
}

/** The commit half of T2 (compose FIRST, ahead of the stage guard). */
export function insertionCommitFence(
  context: InsertionCommitContext,
  state: InsertionCommitState,
): (queryable: Queryable, operation: FenceOperation, phase: 'before' | 'after') => Promise<void> {
  const clock = context.now ?? Date.now;
  let versionStatus: TeachingPackageStatus = 'draft';
  return async (queryable, operation, phase) => {
    if (operation.stageId !== context.stageId || operation.mode === 'read') return;
    if (phase === 'before') {
      // 1. stage_meta first, taken by the fence itself (F36): holding it makes
      //    "rev === m2" mean "nobody else writes until COMMIT".
      await queryable.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [
        context.stageId,
      ]);
      // 2. The version: current, editable.
      const version = await queryable.query<{
        tenant_id: string;
        current_stage_id: string;
        status: string;
      }>(
        `SELECT tenant_id, current_stage_id, status FROM teaching_package_versions
          WHERE id = $1 FOR SHARE`,
        [context.versionId],
      );
      const row = version.rows[0];
      if (!row || row.tenant_id !== context.tenantId || row.current_stage_id !== context.stageId) {
        throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package no longer owns this stage');
      }
      versionStatus = row.status as TeachingPackageStatus;
      if (!EDITABLE.includes(versionStatus)) {
        throw new TeachingPackageStageLockedError(context.stageId, versionStatus);
      }
      // 3. The lease.
      const lease = await queryable.query<{
        status: string;
        attempt_token: string;
        lease_expires_at: number | string;
      }>(
        `SELECT status, attempt_token, lease_expires_at
           FROM teaching_package_scene_insertions WHERE id = $1 FOR UPDATE`,
        [context.insertionId],
      );
      const leaseRow = lease.rows[0];
      if (
        !leaseRow ||
        leaseRow.status !== 'running' ||
        leaseRow.attempt_token !== context.attemptToken ||
        Number(leaseRow.lease_expires_at) <= clock()
      ) {
        throw new TeachingPackageError(
          'INSERTION_LEASE_LOST',
          'this insertion’s lease expired or was reclaimed; nothing was written',
        );
      }
      // 4. The stage revision, on the same queryable, under the lock.
      const manifest = await readStageFreshnessManifest(context.stageId, queryable);
      if (state.expectedRev === undefined || manifest.rev !== state.expectedRev) {
        throw new StageRevisionMovedError(state.expectedRev ?? -1, manifest.rev);
      }
      return;
    }
    // 'after': the new Scene is live with its revision; record the lineage.
    const manifest = await readStageFreshnessManifest(context.stageId, queryable);
    const fresh = manifest.scenes.find((scene) => scene.id === context.newSceneId);
    const written = fresh
      ? await readLiveScene(queryable, context.stageId, context.newSceneId)
      : null;
    if (!fresh || !written) {
      throw new TeachingPackageError(
        'INSERTION_PERSISTENCE_FAILED',
        'the inserted slide is not live after the write; nothing was written',
      );
    }
    const transitions: SceneRevTransitions = {};
    for (const scene of manifest.scenes) {
      const before = state.beforeRevs?.get(scene.id);
      if (before !== undefined) transitions[scene.id] = { before, after: scene.rev };
    }
    const completedAt = clock();
    const updated = await queryable.query<{ id: string }>(
      `UPDATE teaching_package_scene_insertions
          SET status = 'succeeded', result_scene = $3::jsonb, result_scene_rev = $4,
              scene_rev_transitions = $5::jsonb, completed_at = $6
        WHERE id = $1 AND status = 'running' AND attempt_token = $2
        RETURNING id`,
      [
        context.insertionId,
        context.attemptToken,
        JSON.stringify(written.scene),
        fresh.rev,
        JSON.stringify(transitions),
        completedAt,
      ],
    );
    if (updated.rows.length !== 1) {
      throw new TeachingPackageError(
        'INSERTION_LEASE_LOST',
        'this insertion’s lease was lost before its commit; nothing was written',
      );
    }
    await appendInsertionEvent(
      queryable,
      'scene_insertion_completed',
      {
        versionId: context.versionId,
        status: versionStatus,
        actorRef: context.actorRef,
        reason: context.reason,
      },
      {
        insertionId: context.insertionId,
        newSceneId: context.newSceneId,
        resultSceneRev: fresh.rev,
        order: written.scene.order,
        completedAt,
      },
      completedAt,
    );
    state.completions += 1;
    state.completed = {
      resultScene: written.scene,
      resultSceneRev: fresh.rev,
      sceneRevTransitions: transitions,
      completedAt,
    };
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '40P01' || code === '40001';
}

/**
 * Build the final document from the sandwich's `doc` (re-check, shift, add the
 * candidate, migrate + stamp, validate). Throws a `TeachingPackageError` for a
 * refusal (the caller's T3). Must not call a model: a rebuild reuses the same
 * candidate.
 */
export type InsertionDocumentBuilder = (doc: AppDocument) => AppDocument | Promise<AppDocument>;

export interface InsertionCommitResult extends InsertionCompletion {
  /** Builds attempted (1 = no rebuild). */
  builds: number;
}

export async function commitSceneInsertion(
  pool: ConnectableQueryable,
  context: InsertionCommitContext,
  build: InsertionDocumentBuilder,
  options: { maxRetries?: number; maxBuilds?: number } = {},
): Promise<InsertionCommitResult> {
  const state: InsertionCommitState = { completions: 0 };
  const commitFence = insertionCommitFence(context, state);
  const guard = teachingPackageStageGuardFence();
  const store = withPlainJsonDocumentWrites(
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as unknown as TransactionSource,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: async (queryable, operation, phase) => {
        await commitFence(queryable, operation, phase);
        await guard(queryable, operation, phase);
      },
    }),
  ) as OwnerScopedDocumentStore;
  const maxRetries = options.maxRetries ?? 2;
  const maxBuilds = options.maxBuilds ?? MAX_INSERTION_BUILDS;
  for (let builds = 1; builds <= maxBuilds; builds += 1) {
    // 1. The sandwich: equal revisions prove `doc` is exactly the state at m2.
    const m1 = await store.readFreshnessManifest(context.stageId);
    const doc = (await store.loadDocument(context.stageId)) as AppDocument | null;
    const m2 = await store.readFreshnessManifest(context.stageId);
    if (!m1 || !m2 || !doc) {
      throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
    }
    if (m1.rev !== m2.rev) continue;
    // 2–3. Re-check and build on exactly that state (no model call).
    const finalDoc = await build(doc);
    state.expectedRev = m2.rev;
    state.beforeRevs = new Map(m2.scenes.map((scene) => [scene.id, scene.rev]));
    // 4. The fenced write.
    let moved = false;
    for (let attempt = 0; ; attempt += 1) {
      // Only the attempt that COMMITS may report a completion: an attempt
      // that ran its 'after' phase and then rolled back must leave nothing.
      state.completed = undefined;
      try {
        await store.saveDocument(finalDoc);
        break;
      } catch (error) {
        if (error instanceof StageRevisionMovedError) {
          moved = true;
          break;
        }
        if (error instanceof DocumentVersionError) {
          throw new TeachingPackageError(
            'DOCUMENT_NOT_CURRENT',
            'the stored stage is on a newer document version; nothing was written',
          );
        }
        if (attempt < maxRetries && isRetryableTransactionError(error)) continue;
        throw error;
      }
    }
    // 5. A moved revision rebuilds from the new state.
    if (moved) continue;
    // Set by the fence's 'after' phase of the committed attempt (the reset
    // above narrows the field for the compiler, hence the explicit read).
    const completed = state.completed as InsertionCompletion | undefined;
    if (!completed) {
      throw new TeachingPackageError(
        'INSERTION_PERSISTENCE_FAILED',
        'the inserted slide could not be recorded',
      );
    }
    return { ...completed, builds };
  }
  throw new TeachingPackageError(
    'INSERTION_STAGE_BUSY',
    'the lesson kept changing while the slide was being added; nothing was written — try again',
  );
}

// ---------------------------------------------------------------------------
// T3 — fail
// ---------------------------------------------------------------------------

export async function failSceneInsertion(
  pool: ConnectableQueryable,
  input: {
    insertionId: string;
    attemptToken: string;
    errorCode: string;
    candidateScene?: AppScene | null;
    plannedOutline?: Record<string, unknown> | null;
    now?: number;
  },
): Promise<boolean> {
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const now = input.now ?? Date.now();
    const result = await tx.query<RawInsertionRow>(
      `UPDATE teaching_package_scene_insertions
          SET status = 'failed', error_code = $3,
              candidate_scene = COALESCE($4::jsonb, candidate_scene),
              planned_outline = COALESCE($5::jsonb, planned_outline),
              completed_at = $6
        WHERE id = $1 AND status = 'running' AND attempt_token = $2
        RETURNING ${COLUMNS}`,
      [
        input.insertionId,
        input.attemptToken,
        input.errorCode,
        input.candidateScene ? JSON.stringify(input.candidateScene) : null,
        input.plannedOutline ? JSON.stringify(input.plannedOutline) : null,
        now,
      ],
    );
    if (result.rows.length !== 1) return false;
    const row = rowToInsertion(result.rows[0]!);
    const version = await tx.query<{ status: string }>(
      'SELECT status FROM teaching_package_versions WHERE id = $1',
      [row.versionId],
    );
    await appendInsertionEvent(
      tx,
      'scene_insertion_failed',
      {
        versionId: row.versionId,
        status: (version.rows[0]?.status ?? 'draft') as TeachingPackageStatus,
        actorRef: row.actorRef,
        reason: row.reason,
      },
      {
        insertionId: row.id,
        newSceneId: row.newSceneId,
        failureCode: input.errorCode,
        completedAt: now,
      },
      now,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// Status read (lazy reclaim)
// ---------------------------------------------------------------------------

/**
 * The status read. Its lazy reclaim locks only the insertion row and the event
 * insert; it never touches `stage_meta` or Scenes, so it cannot cycle with T2.
 */
export async function readSceneInsertionStatus(
  pool: ConnectableQueryable,
  id: string,
  now = Date.now(),
): Promise<SceneInsertion | null> {
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    await reclaimExpiredSceneInsertions(tx, { id }, now);
    return readSceneInsertion(tx, id);
  });
}
