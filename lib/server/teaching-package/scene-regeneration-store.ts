/**
 * Reviewer-driven single-slide regeneration — persistence
 * (single-slide-regeneration-plan §9).
 *
 * Three transactions around one uncommitted model run:
 *
 * - **T1 `startSceneRegeneration`** — under `stage_meta FOR SHARE` and the
 *   version `FOR SHARE`: reclaim expired leases, answer an idempotent replay,
 *   capture the pre-image and its revision, insert the `running` row (one per
 *   Scene, `tpsr_single_running`) and the `started` event.
 * - **T2 `commitSceneRegeneration`** — the replacement is written through the
 *   SAME owner-bound store path every grant write uses, with
 *   {@link regenerationCommitFence} composed ahead of the stage guard. Its
 *   `'before'` locks `stage_meta → versions → the row` and requires the
 *   Scene's revision to still equal the T1 base; its `'after'` (only when this
 *   transaction advanced the revision) marks the row `succeeded` and appends
 *   the `completed` event before COMMIT, on the same pinned client — so the
 *   Scene, the row and the event commit together or not at all.
 * - **T3 `failSceneRegeneration`** — a guarded `running → failed` with the
 *   candidate kept for diagnosis and the `failed` event.
 *
 * No `@openmaic/storage` change: validation, lossless JSON, lineage
 * carry-forward, the DSL-current refusal, owner and tombstone checks all stay
 * the existing store's, unchanged.
 */
import { randomBytes } from 'node:crypto';

import { DSL_VERSION, dslVersionOf } from '@openmaic/dsl';
import { DocumentVersionError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
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
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { ReviewEventType, TeachingPackageStatus } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

/** Editable version statuses (the stage guard's own list). */
const EDITABLE: readonly TeachingPackageStatus[] = ['draft', 'rejected'];

export const DEFAULT_SCENE_REGENERATION_LEASE_SECONDS = 900;

/** `SCENE_REGENERATION_LEASE_SECONDS`, default 900 (15 min), clamped to ≥ 60. */
export function sceneRegenerationLeaseSeconds(): number {
  const raw = Number(process.env.SCENE_REGENERATION_LEASE_SECONDS);
  return Number.isFinite(raw) && raw >= 60
    ? Math.floor(raw)
    : DEFAULT_SCENE_REGENERATION_LEASE_SECONDS;
}

export type SceneRegenerationStatus = 'running' | 'succeeded' | 'failed';

export interface SceneRegeneration {
  id: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  sceneId: string;
  sceneOrder: number;
  idempotencyKey: string;
  requestDigest: string;
  instruction: string;
  reason: string;
  actorRef: string;
  sessionRef: string | null;
  status: SceneRegenerationStatus;
  attemptToken: string;
  leaseExpiresAt: number;
  baseSceneRev: number;
  previousScene: AppScene;
  resultScene: AppScene | null;
  resultSceneRev: number | null;
  candidateScene: AppScene | null;
  errorCode: string | null;
  registerPolicy: Record<string, unknown> | null;
  modelRoute: Record<string, unknown> | null;
  requestedAt: number;
  completedAt: number | null;
  restoredAt: number | null;
}

interface RawRegenerationRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  version_id: string;
  stage_id: string;
  scene_id: string;
  scene_order: number | string;
  idempotency_key: string;
  request_digest: string;
  instruction: string;
  reason: string;
  actor_ref: string;
  session_ref: string | null;
  status: string;
  attempt_token: string;
  lease_expires_at: number | string;
  base_scene_rev: number | string;
  previous_scene: unknown;
  result_scene: unknown;
  result_scene_rev: number | string | null;
  candidate_scene: unknown;
  error_code: string | null;
  register_policy: unknown;
  model_route: unknown;
  requested_at: number | string;
  completed_at: number | string | null;
  restored_at: number | string | null;
}

const COLUMNS = `id, tenant_id, version_id, stage_id, scene_id, scene_order, idempotency_key,
  request_digest, instruction, reason, actor_ref, session_ref, status, attempt_token,
  lease_expires_at, base_scene_rev, previous_scene, result_scene, result_scene_rev,
  candidate_scene, error_code, register_policy, model_route, requested_at, completed_at,
  restored_at`;

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) return JSON.parse(value) as T;
  return value as T;
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function rowToRegeneration(row: RawRegenerationRow): SceneRegeneration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    versionId: row.version_id,
    stageId: row.stage_id,
    sceneId: row.scene_id,
    sceneOrder: Number(row.scene_order),
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    instruction: row.instruction,
    reason: row.reason,
    actorRef: row.actor_ref,
    sessionRef: row.session_ref,
    status: row.status as SceneRegenerationStatus,
    attemptToken: row.attempt_token,
    leaseExpiresAt: Number(row.lease_expires_at),
    baseSceneRev: Number(row.base_scene_rev),
    previousScene: json<AppScene>(row.previous_scene)!,
    resultScene: json<AppScene>(row.result_scene),
    resultSceneRev: numberOrNull(row.result_scene_rev),
    candidateScene: json<AppScene>(row.candidate_scene),
    errorCode: row.error_code,
    registerPolicy: json<Record<string, unknown>>(row.register_policy),
    modelRoute: json<Record<string, unknown>>(row.model_route),
    requestedAt: Number(row.requested_at),
    completedAt: numberOrNull(row.completed_at),
    restoredAt: numberOrNull(row.restored_at),
  };
}

export function newSceneRegenerationId(): string {
  return `tsr-${randomBytes(9).toString('base64url')}`;
}

function newAttemptToken(): string {
  return randomBytes(18).toString('base64url');
}

export async function readSceneRegeneration(
  queryable: Queryable,
  id: string,
): Promise<SceneRegeneration | null> {
  const result = await queryable.query<RawRegenerationRow>(
    `SELECT ${COLUMNS} FROM teaching_package_scene_regenerations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToRegeneration(result.rows[0]) : null;
}

export async function readSceneRegenerationByKey(
  queryable: Queryable,
  versionId: string,
  idempotencyKey: string,
): Promise<SceneRegeneration | null> {
  const result = await queryable.query<RawRegenerationRow>(
    `SELECT ${COLUMNS} FROM teaching_package_scene_regenerations
      WHERE version_id = $1 AND idempotency_key = $2`,
    [versionId, idempotencyKey],
  );
  return result.rows[0] ? rowToRegeneration(result.rows[0]) : null;
}

/** Running rows of a Stage whose lease is still valid (the gate's read; never writes). */
export async function listRunningSceneRegenerations(
  queryable: Queryable,
  stageId: string,
  now: number,
): Promise<Array<{ sceneId: string; regenerationId: string }>> {
  const result = await queryable.query<{ id: string; scene_id: string }>(
    `SELECT id, scene_id FROM teaching_package_scene_regenerations
      WHERE stage_id = $1 AND status = 'running' AND lease_expires_at > $2
      ORDER BY requested_at`,
    [stageId, now],
  );
  return result.rows.map((row) => ({ sceneId: row.scene_id, regenerationId: row.id }));
}

/** The live Scene and its trigger-maintained revision (no lock). */
export async function readLiveScene(
  queryable: Queryable,
  stageId: string,
  sceneId: string,
): Promise<{ scene: AppScene; rev: number } | null> {
  const result = await queryable.query<{ data: unknown; rev: number | string }>(
    `SELECT s.data, COALESCE(sr.rev, 0) AS rev
       FROM document_scenes s
       LEFT JOIN document_scene_revision sr
         ON sr.stage_id = s.stage_id AND sr.scene_id = s.id
      WHERE s.stage_id = $1 AND s.id = $2`,
    [stageId, sceneId],
  );
  const row = result.rows[0];
  return row ? { scene: json<AppScene>(row.data)!, rev: Number(row.rev) } : null;
}

async function readSceneRev(
  queryable: Queryable,
  stageId: string,
  sceneId: string,
): Promise<number | null> {
  const result = await queryable.query<{ live: boolean; rev: number | string | null }>(
    `SELECT EXISTS(SELECT 1 FROM document_scenes WHERE stage_id = $1 AND id = $2) AS live,
            (SELECT rev FROM document_scene_revision WHERE stage_id = $1 AND scene_id = $2) AS rev`,
    [stageId, sceneId],
  );
  const row = result.rows[0];
  if (!row?.live) return null;
  return row.rev === null ? 0 : Number(row.rev);
}

interface EventContext {
  versionId: string;
  status: TeachingPackageStatus;
  actorRef: string;
  reason: string | null;
}

async function appendRegenerationEvent(
  queryable: Queryable,
  eventType: Extract<ReviewEventType, `scene_regeneration_${string}`>,
  context: EventContext,
  data: Record<string, unknown>,
  now: number,
): Promise<void> {
  await appendReviewEvent(queryable, {
    versionId: context.versionId,
    eventType,
    // A regeneration never changes the version's status.
    fromStatus: context.status,
    toStatus: context.status,
    actorRef: context.actorRef,
    reason: context.reason,
    data,
    createdAt: now,
  });
}

/** Reclaim this Scene's expired running rows: `failed / LEASE_EXPIRED` + a `failed` event each. */
async function reclaimExpired(
  queryable: Queryable,
  where: { stageId: string; sceneId: string } | { id: string },
  now: number,
): Promise<number> {
  const result = await queryable.query<RawRegenerationRow>(
    'id' in where
      ? `UPDATE teaching_package_scene_regenerations
            SET status = 'failed', error_code = 'LEASE_EXPIRED', completed_at = $2
          WHERE id = $1 AND status = 'running' AND lease_expires_at <= $2
          RETURNING ${COLUMNS}`
      : `UPDATE teaching_package_scene_regenerations
            SET status = 'failed', error_code = 'LEASE_EXPIRED', completed_at = $3
          WHERE stage_id = $1 AND scene_id = $2 AND status = 'running' AND lease_expires_at <= $3
          RETURNING ${COLUMNS}`,
    'id' in where ? [where.id, now] : [where.stageId, where.sceneId, now],
  );
  for (const raw of result.rows) {
    const row = rowToRegeneration(raw);
    const version = await queryable.query<{ status: string }>(
      'SELECT status FROM teaching_package_versions WHERE id = $1',
      [row.versionId],
    );
    await appendRegenerationEvent(
      queryable,
      'scene_regeneration_failed',
      {
        versionId: row.versionId,
        status: (version.rows[0]?.status ?? 'draft') as TeachingPackageStatus,
        actorRef: row.actorRef,
        reason: row.reason,
      },
      {
        regenerationId: row.id,
        sceneId: row.sceneId,
        failureCode: 'LEASE_EXPIRED',
        completedAt: now,
      },
      now,
    );
  }
  return result.rows.length;
}

// ---------------------------------------------------------------------------
// T1 — start
// ---------------------------------------------------------------------------

export interface StartSceneRegenerationInput {
  /** Pre-minted so the model route can name it in the ledger; minted here otherwise. */
  id?: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  sceneId: string;
  idempotencyKey: string;
  requestDigest: string;
  instruction: string;
  reason: string;
  actorRef: string;
  sessionRef: string | null;
  registerPolicy?: Record<string, unknown> | null;
  now?: number;
  leaseSeconds?: number;
}

/** A refusal decided under T1's locks; the caller records it (own transaction) and throws. */
export interface SceneRegenerationRefusal {
  code: TeachingPackageErrorCode;
  message: string;
  /** Whether §10.3 records it as a `scene_regeneration_refused` event. */
  audited: boolean;
  versionStatus: TeachingPackageStatus | null;
}

export type StartSceneRegenerationOutcome =
  | {
      kind: 'started';
      regeneration: SceneRegeneration;
      versionStatus: TeachingPackageStatus;
    }
  | { kind: 'replay'; regeneration: SceneRegeneration }
  | { kind: 'refused'; refusal: SceneRegenerationRefusal };

function refused(
  code: TeachingPackageErrorCode,
  message: string,
  audited: boolean,
  versionStatus: TeachingPackageStatus | null,
): StartSceneRegenerationOutcome {
  return { kind: 'refused', refusal: { code, message, audited, versionStatus } };
}

export async function startSceneRegeneration(
  pool: ConnectableQueryable,
  input: StartSceneRegenerationInput,
): Promise<StartSceneRegenerationOutcome> {
  const run = () => startOnce(pool, input);
  try {
    return await run();
  } catch (error) {
    if (!isPgUniqueViolation(error)) throw error;
    const constraint = (error as { constraint?: string }).constraint;
    if (constraint === 'tpsr_version_key_unique') {
      // A concurrent request with the same key won the insert: re-run once,
      // which now answers the replay.
      return run();
    }
    return refused(
      'SCENE_REGENERATION_IN_PROGRESS',
      'another regeneration of this slide is in progress',
      true,
      null,
    );
  }
}

async function startOnce(
  pool: ConnectableQueryable,
  input: StartSceneRegenerationInput,
): Promise<StartSceneRegenerationOutcome> {
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const now = input.now ?? Date.now();
    // 1. The Stage: service-owned and live. Writers take FOR UPDATE, so the
    //    pre-image and its revision are stable for the rest of T1.
    const meta = await tx.query<{ owner_id: string; deleted_at: unknown }>(
      'SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 FOR SHARE',
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
        versionStatus,
      );
    }
    // 3. Reclaim this Scene's expired leases.
    await reclaimExpired(tx, { stageId: input.stageId, sceneId: input.sceneId }, now);
    // 4. Idempotency.
    const existing = await tx.query<RawRegenerationRow>(
      `SELECT ${COLUMNS} FROM teaching_package_scene_regenerations
        WHERE version_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [input.versionId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const prior = rowToRegeneration(existing.rows[0]);
      if (prior.requestDigest !== input.requestDigest) {
        return refused(
          'IDEMPOTENCY_CONFLICT',
          'this idempotency key was already used for a different request',
          true,
          versionStatus,
        );
      }
      return { kind: 'replay', regeneration: prior };
    }
    // 5. The pre-image (slides only) on a DSL-current document.
    const stage = await tx.query<{ data: unknown }>(
      'SELECT data FROM document_stages WHERE id = $1',
      [input.stageId],
    );
    const live = await readLiveScene(tx, input.stageId, input.sceneId);
    if (!live) {
      throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide is not part of this stage');
    }
    if (live.scene.type !== 'slide' && live.scene.type !== 'quiz') {
      return refused(
        'SCENE_TYPE_NOT_REGENERABLE',
        `only slides and quizzes can be regenerated; this scene is a ${live.scene.type}`,
        true,
        versionStatus,
      );
    }
    if (dslVersionOf(json<Record<string, unknown>>(stage.rows[0]?.data) ?? {}) !== DSL_VERSION) {
      throw new TeachingPackageError(
        'DOCUMENT_NOT_CURRENT',
        'the stored stage is on an older document version; open and save it in the editor first',
      );
    }
    const running = await tx.query<{ id: string }>(
      `SELECT id FROM teaching_package_scene_regenerations
        WHERE stage_id = $1 AND scene_id = $2 AND status = 'running'`,
      [input.stageId, input.sceneId],
    );
    if (running.rows[0]) {
      return refused(
        'SCENE_REGENERATION_IN_PROGRESS',
        'another regeneration of this slide is in progress',
        true,
        versionStatus,
      );
    }
    // 6. The running row.
    const id = input.id ?? newSceneRegenerationId();
    const leaseSeconds = input.leaseSeconds ?? sceneRegenerationLeaseSeconds();
    const inserted = await tx.query<RawRegenerationRow>(
      `INSERT INTO teaching_package_scene_regenerations
         (id, tenant_id, version_id, stage_id, scene_id, scene_order, idempotency_key,
          request_digest, instruction, reason, actor_ref, session_ref, status, attempt_token,
          lease_expires_at, base_scene_rev, previous_scene, register_policy, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'running', $13,
               $14, $15, $16::jsonb, $17::jsonb, $18)
       RETURNING ${COLUMNS}`,
      [
        id,
        input.tenantId,
        input.versionId,
        input.stageId,
        input.sceneId,
        live.scene.order,
        input.idempotencyKey,
        input.requestDigest,
        input.instruction,
        input.reason,
        input.actorRef,
        input.sessionRef,
        newAttemptToken(),
        now + leaseSeconds * 1000,
        live.rev,
        JSON.stringify(live.scene),
        input.registerPolicy ? JSON.stringify(input.registerPolicy) : null,
        now,
      ],
    );
    const regeneration = rowToRegeneration(inserted.rows[0]!);
    // 7. The started event (instruction and reason in separate fields).
    await appendRegenerationEvent(
      tx,
      'scene_regeneration_started',
      {
        versionId: input.versionId,
        status: versionStatus,
        actorRef: input.actorRef,
        reason: input.reason,
      },
      {
        regenerationId: id,
        sceneId: input.sceneId,
        sceneOrder: live.scene.order,
        instruction: input.instruction,
        idempotencyKey: input.idempotencyKey,
        baseSceneRev: live.rev,
        sessionRef: input.sessionRef,
        requestedAt: now,
      },
      now,
    );
    return { kind: 'started', regeneration, versionStatus };
  });
}

/**
 * The `refused` audit event (§10.3), in its own transaction: authorized write
 * grants only, for refusals decided after the grant check.
 */
export async function recordSceneRegenerationRefusal(
  pool: ConnectableQueryable,
  input: {
    versionId: string;
    actorRef: string;
    reason: string;
    sceneId: string;
    refusalCode: string;
    idempotencyKey: string;
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
  await appendRegenerationEvent(
    pool,
    'scene_regeneration_refused',
    { versionId: input.versionId, status, actorRef: input.actorRef, reason: input.reason },
    {
      sceneId: input.sceneId,
      refusalCode: input.refusalCode,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// T2 — commit
// ---------------------------------------------------------------------------

export interface RegenerationCommitContext {
  regenerationId: string;
  attemptToken: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  sceneId: string;
  baseSceneRev: number;
  actorRef: string;
  reason: string;
  now?: () => number;
}

export interface RegenerationCommitState {
  /** Set by the `'after'` phase of the transaction that wrote the Scene. */
  completed?: { resultSceneRev: number; resultScene: AppScene; completedAt: number };
  /** How many times the completion ran (the AT-P1 #1 spy). */
  completions: number;
}

type FenceOperation = { stageId?: string; mode: string; scope: 'content' | 'library' };

/**
 * The commit half of T2 (compose FIRST, ahead of the stage guard). Runs in
 * every transaction the owner-bound store opens (`putScene` opens two).
 */
export function regenerationCommitFence(
  context: RegenerationCommitContext,
  state: RegenerationCommitState,
): (queryable: Queryable, operation: FenceOperation, phase: 'before' | 'after') => Promise<void> {
  const clock = context.now ?? Date.now;
  let versionStatus: TeachingPackageStatus = 'draft';
  return async (queryable, operation, phase) => {
    if (operation.stageId !== context.stageId || operation.mode === 'read') return;
    if (phase === 'before') {
      // stage_meta first: every owner-bound writer takes it FOR UPDATE, so
      // holding it makes "rev == base" mean "nobody else writes until COMMIT".
      await queryable.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [
        context.stageId,
      ]);
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
      const lease = await queryable.query<{
        status: string;
        attempt_token: string;
        lease_expires_at: number | string;
      }>(
        `SELECT status, attempt_token, lease_expires_at
           FROM teaching_package_scene_regenerations WHERE id = $1 FOR UPDATE`,
        [context.regenerationId],
      );
      const leaseRow = lease.rows[0];
      if (
        !leaseRow ||
        leaseRow.status !== 'running' ||
        leaseRow.attempt_token !== context.attemptToken ||
        Number(leaseRow.lease_expires_at) <= clock()
      ) {
        throw new TeachingPackageError(
          'REGENERATION_LEASE_LOST',
          'this regeneration’s lease expired or was reclaimed; nothing was written',
        );
      }
      const rev = await readSceneRev(queryable, context.stageId, context.sceneId);
      if (rev !== context.baseSceneRev) {
        throw new TeachingPackageError(
          'SCENE_CHANGED_DURING_REGENERATION',
          'the slide was changed while it was being regenerated; nothing was written',
          { currentRev: rev },
        );
      }
      return;
    }
    // 'after': only the transaction that advanced the revision completes.
    const rev = await readSceneRev(queryable, context.stageId, context.sceneId);
    if (rev === null || rev <= context.baseSceneRev) return;
    const written = await readLiveScene(queryable, context.stageId, context.sceneId);
    const completedAt = clock();
    const updated = await queryable.query<{ id: string }>(
      `UPDATE teaching_package_scene_regenerations
          SET status = 'succeeded', result_scene = $3::jsonb, result_scene_rev = $4,
              completed_at = $5
        WHERE id = $1 AND status = 'running' AND attempt_token = $2
        RETURNING id`,
      [
        context.regenerationId,
        context.attemptToken,
        JSON.stringify(written!.scene),
        rev,
        completedAt,
      ],
    );
    if (updated.rows.length !== 1) {
      throw new TeachingPackageError(
        'REGENERATION_LEASE_LOST',
        'this regeneration’s lease was lost before its commit; nothing was written',
      );
    }
    await appendRegenerationEvent(
      queryable,
      'scene_regeneration_completed',
      {
        versionId: context.versionId,
        status: versionStatus,
        actorRef: context.actorRef,
        reason: context.reason,
      },
      {
        regenerationId: context.regenerationId,
        sceneId: context.sceneId,
        resultSceneRev: rev,
        completedAt,
      },
      completedAt,
    );
    state.completions += 1;
    state.completed = { resultSceneRev: rev, resultScene: written!.scene, completedAt };
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '40P01' || code === '40001';
}

/**
 * T2: write the replacement through the owner-bound store with the commit
 * fence. Retried in place (≤ 2×) on deadlock / serialization failures only.
 */
export async function commitSceneRegeneration(
  pool: ConnectableQueryable,
  context: RegenerationCommitContext,
  replacement: AppScene,
  options: { maxRetries?: number } = {},
): Promise<{
  resultSceneRev: number;
  resultScene: AppScene;
  completedAt: number;
  state: RegenerationCommitState;
}> {
  const state: RegenerationCommitState = { completions: 0 };
  const commitFence = regenerationCommitFence(context, state);
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
  );
  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await store.putScene(context.stageId, replacement);
      break;
    } catch (error) {
      if (error instanceof DocumentVersionError && error.kind === 'not-current') {
        throw new TeachingPackageError(
          'DOCUMENT_NOT_CURRENT',
          'the stored stage is on an older document version; nothing was written',
        );
      }
      if (attempt < maxRetries && isRetryableTransactionError(error)) continue;
      throw error;
    }
  }
  if (!state.completed) {
    // The write committed nothing new (an identical-row upsert still bumps the
    // trigger, so this is unreachable in practice) — never claim success.
    throw new TeachingPackageError(
      'REGENERATION_PERSISTENCE_FAILED',
      'the regenerated slide could not be recorded',
    );
  }
  return { ...state.completed, state };
}

// ---------------------------------------------------------------------------
// T3 — fail
// ---------------------------------------------------------------------------

export async function failSceneRegeneration(
  pool: ConnectableQueryable,
  input: {
    regenerationId: string;
    attemptToken: string;
    errorCode: string;
    candidateScene?: AppScene | null;
    modelRoute?: Record<string, unknown> | null;
    now?: number;
  },
): Promise<boolean> {
  const withTransaction = nodePostgresTransaction(pool);
  return withTransaction(async (tx) => {
    const now = input.now ?? Date.now();
    const result = await tx.query<RawRegenerationRow>(
      `UPDATE teaching_package_scene_regenerations
          SET status = 'failed', error_code = $3, candidate_scene = $4::jsonb,
              model_route = COALESCE($5::jsonb, model_route), completed_at = $6
        WHERE id = $1 AND status = 'running' AND attempt_token = $2
        RETURNING ${COLUMNS}`,
      [
        input.regenerationId,
        input.attemptToken,
        input.errorCode,
        input.candidateScene ? JSON.stringify(input.candidateScene) : null,
        input.modelRoute ? JSON.stringify(input.modelRoute) : null,
        now,
      ],
    );
    if (result.rows.length !== 1) return false;
    const row = rowToRegeneration(result.rows[0]!);
    const version = await tx.query<{ status: string }>(
      'SELECT status FROM teaching_package_versions WHERE id = $1',
      [row.versionId],
    );
    await appendRegenerationEvent(
      tx,
      'scene_regeneration_failed',
      {
        versionId: row.versionId,
        status: (version.rows[0]?.status ?? 'draft') as TeachingPackageStatus,
        actorRef: row.actorRef,
        reason: row.reason,
      },
      {
        regenerationId: row.id,
        sceneId: row.sceneId,
        failureCode: input.errorCode,
        completedAt: now,
      },
      now,
    );
    return true;
  });
}

/** Record the route the run used (diagnostic; not part of any decision). */
export async function recordSceneRegenerationRoute(
  queryable: Queryable,
  regenerationId: string,
  modelRoute: Record<string, unknown>,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_scene_regenerations SET model_route = $2::jsonb
      WHERE id = $1 AND status = 'running'`,
    [regenerationId, JSON.stringify(modelRoute)],
  );
}

// ---------------------------------------------------------------------------
// Status read (lazy reclaim)
// ---------------------------------------------------------------------------

/**
 * The status read. Its lazy reclaim locks only the regeneration row and the
 * event insert (whose FK takes `KEY SHARE` on the version); it never touches
 * `stage_meta` or Scenes, so it cannot cycle with T2.
 */
export async function readSceneRegenerationStatus(
  pool: ConnectableQueryable,
  id: string,
  now = Date.now(),
): Promise<{
  regeneration: SceneRegeneration;
  current: { scene: AppScene; rev: number } | null;
} | null> {
  const withTransaction = nodePostgresTransaction(pool);
  const regeneration = await withTransaction(async (tx) => {
    await reclaimExpired(tx, { id }, now);
    return readSceneRegeneration(tx, id);
  });
  if (!regeneration) return null;
  const current = await readLiveScene(pool, regeneration.stageId, regeneration.sceneId);
  return { regeneration, current };
}

// ---------------------------------------------------------------------------
// Restore (phase 3)
// ---------------------------------------------------------------------------

/**
 * Restore the pre-image of a succeeded regeneration, through the same
 * owner-bound path, only while the Scene is still exactly the regenerated one
 * (its revision equals `result_scene_rev`).
 */
export async function restoreSceneRegeneration(
  pool: ConnectableQueryable,
  input: { regenerationId: string; tenantId: string; actorRef: string; now?: () => number },
): Promise<{ restoredSceneRev: number; scene: AppScene; regeneration: SceneRegeneration }> {
  const clock = input.now ?? Date.now;
  const state: { restored?: { rev: number; scene: AppScene }; row?: SceneRegeneration } = {};
  const guard = teachingPackageStageGuardFence();
  const initial = await readSceneRegeneration(pool, input.regenerationId);
  if (!initial || initial.tenantId !== input.tenantId) {
    throw new TeachingPackageError('REGENERATION_NOT_FOUND', 'regeneration not found');
  }
  const fence = async (
    queryable: Queryable,
    operation: FenceOperation,
    phase: 'before' | 'after',
  ) => {
    if (operation.stageId !== initial.stageId || operation.mode === 'read') return;
    if (phase === 'before') {
      await queryable.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [
        initial.stageId,
      ]);
      const version = await queryable.query<{ status: string; current_stage_id: string }>(
        'SELECT status, current_stage_id FROM teaching_package_versions WHERE id = $1 FOR SHARE',
        [initial.versionId],
      );
      const versionRow = version.rows[0];
      if (!versionRow || versionRow.current_stage_id !== initial.stageId) {
        throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package no longer owns this stage');
      }
      if (!EDITABLE.includes(versionRow.status as TeachingPackageStatus)) {
        throw new TeachingPackageStageLockedError(initial.stageId, versionRow.status);
      }
      const locked = await queryable.query<RawRegenerationRow>(
        `SELECT ${COLUMNS} FROM teaching_package_scene_regenerations WHERE id = $1 FOR UPDATE`,
        [initial.id],
      );
      const row = locked.rows[0] ? rowToRegeneration(locked.rows[0]) : null;
      if (
        !row ||
        row.status !== 'succeeded' ||
        row.restoredAt !== null ||
        row.resultSceneRev === null
      ) {
        throw new TeachingPackageError(
          'REGENERATION_NOT_RESTORABLE',
          'only a succeeded, not yet restored regeneration can be restored',
        );
      }
      const rev = await readSceneRev(queryable, initial.stageId, initial.sceneId);
      if (rev !== row.resultSceneRev) {
        throw new TeachingPackageError(
          'SCENE_CHANGED_SINCE_REGENERATION',
          'the slide changed after it was regenerated; it cannot be restored',
          { currentRev: rev },
        );
      }
      state.row = row;
      return;
    }
    const rev = await readSceneRev(queryable, initial.stageId, initial.sceneId);
    if (!state.row || rev === null || rev <= state.row.resultSceneRev!) return;
    const written = await readLiveScene(queryable, initial.stageId, initial.sceneId);
    const now = clock();
    await queryable.query(
      'UPDATE teaching_package_scene_regenerations SET restored_at = $2 WHERE id = $1',
      [initial.id, now],
    );
    const version = await queryable.query<{ status: string }>(
      'SELECT status FROM teaching_package_versions WHERE id = $1',
      [initial.versionId],
    );
    await appendRegenerationEvent(
      queryable,
      'scene_regeneration_restored',
      {
        versionId: initial.versionId,
        status: version.rows[0]!.status as TeachingPackageStatus,
        actorRef: input.actorRef,
        reason: state.row.reason,
      },
      {
        regenerationId: initial.id,
        sceneId: initial.sceneId,
        restoredSceneRev: rev,
        restoredAt: now,
      },
      now,
    );
    state.restored = { rev, scene: written!.scene };
  };
  const store = withPlainJsonDocumentWrites(
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as unknown as TransactionSource,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: async (queryable, operation, phase) => {
        await fence(queryable, operation, phase);
        await guard(queryable, operation, phase);
      },
    }),
  );
  try {
    await store.putScene(initial.stageId, initial.previousScene);
  } catch (error) {
    if (error instanceof DocumentVersionError && error.kind === 'not-current') {
      throw new TeachingPackageError('DOCUMENT_NOT_CURRENT', 'the stored stage is not current');
    }
    throw error;
  }
  if (!state.restored) {
    throw new TeachingPackageError(
      'REGENERATION_PERSISTENCE_FAILED',
      'the restore was not recorded',
    );
  }
  const after = await readSceneRegeneration(pool, input.regenerationId);
  return {
    restoredSceneRev: state.restored.rev,
    scene: state.restored.scene,
    regeneration: after!,
  };
}
