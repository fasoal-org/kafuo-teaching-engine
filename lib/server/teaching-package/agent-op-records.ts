/**
 * Kafuo Agent API E3: the keyed records of the agent editor ops that have no run row of
 * their own (`teaching_package_agent_ops`, lib/persistence/teaching-package.ts).
 *
 * - `delete`: written inside the delete's own transaction (`recordDeleteInTransaction`),
 *   so it exists exactly when the slide is gone. A retry with the key answers "done" with
 *   the stored backup, before any revision check.
 * - `narration-audio`: a leased `running` marker taken before the voice is synthesized
 *   (`claimNarration`), so a retry during a slow TTS run never synthesizes twice; `done`
 *   with the result after; removed on a failure so the op can be retried.
 * - `link-dry-run`: owner decision D-6, "dry run first": a successful link dry run by a
 *   key records its scene and part; a real link with that key needs one younger than
 *   {@link LINK_DRY_RUN_WINDOW_MS}.
 *
 * Every read and write is scoped by version (and the version is read under the tenant by
 * the route), and the key is the Backend's namespaced engine key (`agt_<key id>_…`).
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

export type AgentOpRecordKind =
  | 'delete'
  | 'narration-audio'
  | 'link-dry-run'
  | AgentEditOpKind
  | 'alignment-confirm';

/** Wave F2's direct edits: each row is an A8 proof (actor, result rev and fingerprint). */
export const AGENT_EDIT_OP_KINDS = [
  'quiz-item-edit',
  'quiz-item-delete',
  'narration-line',
  'text-element',
] as const;
export type AgentEditOpKind = (typeof AGENT_EDIT_OP_KINDS)[number];

export const LINK_DRY_RUN_WINDOW_MS = 30 * 60 * 1000;
export const NARRATION_MARKER_LEASE_MS = 10 * 60 * 1000;

export interface AgentOpRecord {
  op: AgentOpRecordKind;
  idempotencyKey: string;
  sceneId: string;
  requestDigest: string;
  status: 'running' | 'done';
  result: Record<string, unknown> | null;
  leaseUntil: number | null;
  createdAt: number;
}

export function agentOpDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

export async function readAgentOpRecord(
  queryable: Queryable,
  key: { versionId: string; op: AgentOpRecordKind; idempotencyKey: string },
): Promise<AgentOpRecord | null> {
  const result = await queryable.query<{
    op: AgentOpRecordKind;
    idempotency_key: string;
    scene_id: string;
    request_digest: string;
    status: 'running' | 'done';
    result: unknown;
    lease_until: number | string | null;
    created_at: number | string;
  }>(
    `SELECT op, idempotency_key, scene_id, request_digest, status, result, lease_until, created_at
       FROM teaching_package_agent_ops
      WHERE version_id = $1 AND op = $2 AND idempotency_key = $3`,
    [key.versionId, key.op, key.idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    op: row.op,
    idempotencyKey: row.idempotency_key,
    sceneId: row.scene_id,
    requestDigest: row.request_digest,
    status: row.status,
    result: json<Record<string, unknown>>(row.result),
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    createdAt: Number(row.created_at),
  };
}

interface WriteInput {
  tenantId: string;
  versionId: string;
  idempotencyKey: string;
  sceneId: string;
  requestDigest: string;
  now: number;
}

/** The delete's record, in the delete's own transaction (the fence's `after` phase). */
export async function recordDeleteInTransaction(
  queryable: Queryable,
  input: WriteInput & { result: Record<string, unknown> },
): Promise<void> {
  await queryable.query(
    `INSERT INTO teaching_package_agent_ops
       (tenant_id, version_id, idempotency_key, op, scene_id, request_digest, status, result,
        lease_until, created_at, updated_at)
     VALUES ($1, $2, $3, 'delete', $4, $5, 'done', $6::jsonb, NULL, $7, $7)`,
    [
      input.tenantId,
      input.versionId,
      input.idempotencyKey,
      input.sceneId,
      input.requestDigest,
      JSON.stringify(input.result),
      input.now,
    ],
  );
}

/**
 * Take the narration marker: `true` when this request may synthesize. A live `running`
 * marker or a `done` record of the key refuses (`false`); an expired marker is taken over.
 */
export async function claimNarration(queryable: Queryable, input: WriteInput): Promise<boolean> {
  const inserted = await queryable.query<{ idempotency_key: string }>(
    `INSERT INTO teaching_package_agent_ops
       (tenant_id, version_id, idempotency_key, op, scene_id, request_digest, status, result,
        lease_until, created_at, updated_at)
     VALUES ($1, $2, $3, 'narration-audio', $4, $5, 'running', NULL, $6, $7, $7)
     ON CONFLICT (version_id, op, idempotency_key) DO UPDATE
       SET lease_until = EXCLUDED.lease_until, updated_at = EXCLUDED.updated_at
       WHERE teaching_package_agent_ops.status = 'running'
         AND teaching_package_agent_ops.lease_until <= EXCLUDED.updated_at
     RETURNING idempotency_key`,
    [
      input.tenantId,
      input.versionId,
      input.idempotencyKey,
      input.sceneId,
      input.requestDigest,
      input.now + NARRATION_MARKER_LEASE_MS,
      input.now,
    ],
  );
  return inserted.rows.length > 0;
}

export async function completeNarration(
  queryable: Queryable,
  input: {
    versionId: string;
    idempotencyKey: string;
    result: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_agent_ops
        SET status = 'done', result = $3::jsonb, lease_until = NULL, updated_at = $4
      WHERE version_id = $1 AND op = 'narration-audio' AND idempotency_key = $2`,
    [input.versionId, input.idempotencyKey, JSON.stringify(input.result), input.now],
  );
}

/** A failed synthesis frees the key (nothing was written). */
export async function releaseNarration(
  queryable: Queryable,
  input: { versionId: string; idempotencyKey: string },
): Promise<void> {
  await queryable.query(
    `DELETE FROM teaching_package_agent_ops
      WHERE version_id = $1 AND op = 'narration-audio' AND idempotency_key = $2
        AND status = 'running'`,
    [input.versionId, input.idempotencyKey],
  );
}

/**
 * Wave F2: one direct edit (or an alignment confirmation), written on the transaction
 * that advanced the scene's revision, so the row exists exactly when the write landed.
 * `resultFingerprint` is the material fingerprint of the written scene WITHOUT its
 * narration audio (R-H1); `alignedBefore` is A8's "the slide was aligned (or stale only
 * by this agent's own ops) before this op" (R-H2).
 */
export async function recordEditInTransaction(
  queryable: Queryable,
  input: WriteInput & {
    op: AgentEditOpKind | 'alignment-confirm';
    actorRef: string;
    resultSceneRev: number;
    resultFingerprint: string;
    alignedBefore: boolean;
    result: Record<string, unknown>;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO teaching_package_agent_ops
       (tenant_id, version_id, idempotency_key, op, scene_id, request_digest, status, result,
        lease_until, created_at, updated_at, actor_ref, result_scene_rev, result_fingerprint,
        aligned_before)
     VALUES ($1, $2, $3, $4, $5, $6, 'done', $7::jsonb, NULL, $8, $8, $9, $10, $11, $12)`,
    [
      input.tenantId,
      input.versionId,
      input.idempotencyKey,
      input.op,
      input.sceneId,
      input.requestDigest,
      JSON.stringify(input.result),
      input.now,
      input.actorRef,
      input.resultSceneRev,
      input.resultFingerprint,
      input.alignedBefore,
    ],
  );
}

/**
 * Merge top-level fields into a landed edit row's stored result (the narration line's
 * `audio` block, known only after the write committed), so a replay answers the same body.
 */
export async function mergeAgentOpResult(
  queryable: Queryable,
  key: { versionId: string; op: AgentEditOpKind; idempotencyKey: string },
  fields: Record<string, unknown>,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_agent_ops
        SET result = COALESCE(result, '{}'::jsonb) || $4::jsonb, updated_at = $5
      WHERE version_id = $1 AND op = $2 AND idempotency_key = $3 AND status = 'done'`,
    [key.versionId, key.op, key.idempotencyKey, JSON.stringify(fields), now],
  );
}

/** The A8 proof fields of one landed edit row. */
export interface AgentEditRow {
  op: AgentEditOpKind;
  sceneId: string;
  actorRef: string;
  at: number;
  resultSceneRev: number | null;
  resultFingerprint: string;
  alignedBefore: boolean;
}

/** Every landed F2 edit row of the version (optionally of some scenes), oldest first. */
export async function listAgentEditRows(
  queryable: Queryable,
  versionId: string,
  sceneIds?: readonly string[],
): Promise<AgentEditRow[]> {
  const result = await queryable.query<{
    op: AgentEditOpKind;
    scene_id: string;
    actor_ref: string | null;
    created_at: number | string;
    result_scene_rev: number | string | null;
    result_fingerprint: string | null;
    aligned_before: boolean | null;
  }>(
    `SELECT op, scene_id, actor_ref, created_at, result_scene_rev, result_fingerprint,
            aligned_before
       FROM teaching_package_agent_ops
      WHERE version_id = $1 AND status = 'done'
        AND op IN (${AGENT_EDIT_OP_KINDS.map((kind) => `'${kind}'`).join(',')})
        ${sceneIds ? 'AND scene_id = ANY($2::text[])' : ''}
      ORDER BY created_at, idempotency_key`,
    sceneIds ? [versionId, [...sceneIds]] : [versionId],
  );
  return result.rows
    .filter((row) => row.actor_ref !== null && row.result_fingerprint !== null)
    .map((row) => ({
      op: row.op,
      sceneId: row.scene_id,
      actorRef: row.actor_ref!,
      at: Number(row.created_at),
      resultSceneRev: row.result_scene_rev === null ? null : Number(row.result_scene_rev),
      resultFingerprint: row.result_fingerprint!,
      alignedBefore: row.aligned_before === true,
    }));
}

/** D-6: a successful link dry run by this key, on this scene and part (refreshed each time). */
export async function recordLinkDryRun(queryable: Queryable, input: WriteInput): Promise<void> {
  await queryable.query(
    `INSERT INTO teaching_package_agent_ops
       (tenant_id, version_id, idempotency_key, op, scene_id, request_digest, status, result,
        lease_until, created_at, updated_at)
     VALUES ($1, $2, $3, 'link-dry-run', $4, $5, 'done', NULL, NULL, $6, $6)
     ON CONFLICT (version_id, op, idempotency_key) DO UPDATE
       SET scene_id = EXCLUDED.scene_id, request_digest = EXCLUDED.request_digest,
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
    [
      input.tenantId,
      input.versionId,
      input.idempotencyKey,
      input.sceneId,
      input.requestDigest,
      input.now,
    ],
  );
}
