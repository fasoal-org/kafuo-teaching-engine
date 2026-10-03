/**
 * Row helpers for `teaching_package_generation_checkpoints` (schema in
 * `teaching-package.ts`, slide-classification-admin-correction-plan §3.1).
 *
 * One row per paused attempt, updated in place: a later pause of the same
 * attempt (for example after Scenes were generated) overwrites the candidate,
 * increments `revision` and appends to `edit_log`. Every edit is a compare-and-
 * set on `revision`, so two administrators can never silently overwrite each
 * other, and a resume names the exact revision it validated.
 *
 * Small typed helpers over a `Queryable`, usable inside any transaction — the
 * same pattern as the rest of the teaching-package persistence.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import type { OutlineDiagnostic } from '@openmaic/generation';

import { assertCheckpointPersistable } from '@/lib/persistence/teaching-package';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationCheckpoint,
  GenerationCheckpointLogEntry,
  GenerationCheckpointPhase,
  GenerationCheckpointSourceRefs,
  GenerationCheckpointState,
} from '@/lib/types/teaching-package';

interface RawCheckpointRow extends Record<string, unknown> {
  attempt_id: string;
  tenant_id: string;
  phase: string;
  state: string;
  revision: number | string;
  outlines: unknown;
  course_title: string | null;
  language_directive: string;
  diagnostics: unknown;
  repairs: unknown;
  source_refs: unknown;
  reserved_stage_id: string | null;
  pending_outline_ids: unknown;
  edit_log: unknown;
  resumed_revision: number | string | null;
  pause_count: number | string;
  paused_at: number | string;
  updated_at: number | string;
  resumed_at: number | string | null;
  abandoned_at: number | string | null;
}

const CHECKPOINT_COLUMNS = `attempt_id,
  tenant_id,
  phase,
  state,
  revision,
  outlines,
  course_title,
  language_directive,
  diagnostics,
  repairs,
  source_refs,
  reserved_stage_id,
  pending_outline_ids,
  edit_log,
  resumed_revision,
  pause_count,
  paused_at,
  updated_at,
  resumed_at,
  abandoned_at`;

const nullableNumber = (value: number | string | null): number | null =>
  value === null || value === undefined ? null : Number(value);

function rowToCheckpoint(row: RawCheckpointRow): GenerationCheckpoint {
  return {
    attemptId: row.attempt_id,
    tenantId: row.tenant_id,
    phase: row.phase as GenerationCheckpointPhase,
    state: row.state as GenerationCheckpointState,
    revision: Number(row.revision),
    outlines: (Array.isArray(row.outlines) ? row.outlines : []) as SceneOutline[],
    courseTitle: row.course_title,
    languageDirective: row.language_directive,
    diagnostics: (Array.isArray(row.diagnostics) ? row.diagnostics : []) as OutlineDiagnostic[],
    repairs: (Array.isArray(row.repairs) ? row.repairs : []) as OutlineDiagnostic[],
    sourceRefs: row.source_refs as GenerationCheckpointSourceRefs,
    reservedStageId: row.reserved_stage_id,
    pendingOutlineIds: Array.isArray(row.pending_outline_ids)
      ? (row.pending_outline_ids as string[])
      : null,
    editLog: (Array.isArray(row.edit_log) ? row.edit_log : []) as GenerationCheckpointLogEntry[],
    resumedRevision: nullableNumber(row.resumed_revision),
    pauseCount: Number(row.pause_count),
    pausedAt: Number(row.paused_at),
    updatedAt: Number(row.updated_at),
    resumedAt: nullableNumber(row.resumed_at),
    abandonedAt: nullableNumber(row.abandoned_at),
  };
}

export interface PauseCheckpointInput {
  attemptId: string;
  tenantId: string;
  phase: GenerationCheckpointPhase;
  outlines: SceneOutline[];
  courseTitle: string | null;
  languageDirective: string;
  diagnostics: OutlineDiagnostic[];
  repairs: OutlineDiagnostic[];
  sourceRefs: GenerationCheckpointSourceRefs;
  reservedStageId: string | null;
  pendingOutlineIds: string[] | null;
  actorRef: string;
  now: number;
}

/**
 * Record a pause: insert the checkpoint, or — for an attempt that paused before
 * and resumed — overwrite the candidate, bump `revision` and `pause_count`, and
 * return it to `awaiting`. The pause is appended to the edit log.
 */
export async function upsertCheckpointForPause(
  queryable: Queryable,
  input: PauseCheckpointInput,
): Promise<GenerationCheckpoint> {
  const persisted = {
    outlines: input.outlines,
    diagnostics: input.diagnostics,
    repairs: input.repairs,
    sourceRefs: input.sourceRefs,
  };
  assertCheckpointPersistable(persisted);
  const blockingCount = input.diagnostics.filter(
    (diagnostic) => diagnostic.disposition === 'admin_correctable',
  ).length;
  const result = await queryable.query<RawCheckpointRow>(
    `INSERT INTO teaching_package_generation_checkpoints
       (attempt_id, tenant_id, phase, state, revision, outlines, course_title,
        language_directive, diagnostics, repairs, source_refs, reserved_stage_id,
        pending_outline_ids, edit_log, pause_count, paused_at, updated_at)
     VALUES ($1, $2, $3, 'awaiting', 1, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
             $10, $11::jsonb,
             jsonb_build_array(jsonb_build_object(
               'revision', 1, 'event', 'paused', 'actorRef', $12::text, 'at', $13::double precision,
               'phase', $3::text, 'blockingCount', $14::int)),
             1, $13, $13)
     ON CONFLICT (attempt_id) DO UPDATE
       SET phase = EXCLUDED.phase,
           state = 'awaiting',
           revision = teaching_package_generation_checkpoints.revision + 1,
           outlines = EXCLUDED.outlines,
           course_title = EXCLUDED.course_title,
           language_directive = EXCLUDED.language_directive,
           diagnostics = EXCLUDED.diagnostics,
           repairs = EXCLUDED.repairs,
           source_refs = EXCLUDED.source_refs,
           reserved_stage_id = EXCLUDED.reserved_stage_id,
           pending_outline_ids = EXCLUDED.pending_outline_ids,
           edit_log = teaching_package_generation_checkpoints.edit_log || jsonb_build_array(
             jsonb_build_object(
               'revision', teaching_package_generation_checkpoints.revision + 1,
               'event', 'paused', 'actorRef', $12::text, 'at', $13::double precision,
               'phase', $3::text, 'blockingCount', $14::int)),
           pause_count = teaching_package_generation_checkpoints.pause_count + 1,
           paused_at = EXCLUDED.paused_at,
           updated_at = EXCLUDED.updated_at,
           resumed_at = NULL,
           abandoned_at = NULL
       WHERE teaching_package_generation_checkpoints.tenant_id = EXCLUDED.tenant_id
     RETURNING ${CHECKPOINT_COLUMNS}`,
    [
      input.attemptId,
      input.tenantId,
      input.phase,
      JSON.stringify(input.outlines),
      input.courseTitle,
      input.languageDirective,
      JSON.stringify(input.diagnostics),
      JSON.stringify(input.repairs),
      JSON.stringify(input.sourceRefs),
      input.reservedStageId,
      input.pendingOutlineIds === null ? null : JSON.stringify(input.pendingOutlineIds),
      input.actorRef,
      input.now,
      blockingCount,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`checkpoint for attempt ${input.attemptId} belongs to another tenant`);
  }
  return rowToCheckpoint(row);
}

/** Tenant-scoped read. */
export async function readCheckpoint(
  queryable: Queryable,
  attemptId: string,
  scope: { tenantId: string },
): Promise<GenerationCheckpoint | null> {
  const result = await queryable.query<RawCheckpointRow>(
    `SELECT ${CHECKPOINT_COLUMNS}
       FROM teaching_package_generation_checkpoints
      WHERE attempt_id = $1 AND tenant_id = $2`,
    [attemptId, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToCheckpoint(row) : null;
}

/** Tenant-scoped read under a row lock (edit, resume and abandon transactions). */
export async function readCheckpointForUpdate(
  queryable: Queryable,
  attemptId: string,
  scope: { tenantId: string },
): Promise<GenerationCheckpoint | null> {
  const result = await queryable.query<RawCheckpointRow>(
    `SELECT ${CHECKPOINT_COLUMNS}
       FROM teaching_package_generation_checkpoints
      WHERE attempt_id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [attemptId, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToCheckpoint(row) : null;
}

/** Runner read by attempt id (the attempt row already carries the tenant). */
export async function readCheckpointByAttemptId(
  queryable: Queryable,
  attemptId: string,
): Promise<GenerationCheckpoint | null> {
  const result = await queryable.query<RawCheckpointRow>(
    `SELECT ${CHECKPOINT_COLUMNS}
       FROM teaching_package_generation_checkpoints
      WHERE attempt_id = $1`,
    [attemptId],
  );
  const row = result.rows[0];
  return row ? rowToCheckpoint(row) : null;
}

/**
 * Apply an administrator's edit: compare-and-set on `revision` while the
 * checkpoint is `awaiting`. `null` ⇒ the revision moved (or the checkpoint is
 * no longer awaiting) — the caller answers a stale-state conflict.
 */
export async function applyCheckpointEdit(
  queryable: Queryable,
  attemptId: string,
  edit: {
    tenantId: string;
    expectedRevision: number;
    outlines: SceneOutline[];
    diagnostics: OutlineDiagnostic[];
    repairs: OutlineDiagnostic[];
    logEntry: Omit<GenerationCheckpointLogEntry, 'revision'>;
    now: number;
  },
): Promise<GenerationCheckpoint | null> {
  assertCheckpointPersistable({ outlines: edit.outlines, diagnostics: edit.diagnostics });
  const result = await queryable.query<RawCheckpointRow>(
    `UPDATE teaching_package_generation_checkpoints
        SET outlines = $4::jsonb,
            diagnostics = $5::jsonb,
            repairs = $6::jsonb,
            revision = revision + 1,
            edit_log = edit_log || jsonb_build_array($7::jsonb || jsonb_build_object('revision', revision + 1)),
            updated_at = $8
      WHERE attempt_id = $1 AND tenant_id = $2 AND revision = $3 AND state = 'awaiting'
      RETURNING ${CHECKPOINT_COLUMNS}`,
    [
      attemptId,
      edit.tenantId,
      edit.expectedRevision,
      JSON.stringify(edit.outlines),
      JSON.stringify(edit.diagnostics),
      JSON.stringify(edit.repairs),
      JSON.stringify(edit.logEntry),
      edit.now,
    ],
  );
  const row = result.rows[0];
  return row ? rowToCheckpoint(row) : null;
}

/** Mark the awaiting checkpoint resumed at `revision` (inside the resume transaction). */
export async function markCheckpointResumed(
  queryable: Queryable,
  attemptId: string,
  input: { tenantId: string; revision: number; actorRef: string; now: number },
): Promise<GenerationCheckpoint | null> {
  const result = await queryable.query<RawCheckpointRow>(
    `UPDATE teaching_package_generation_checkpoints
        SET state = 'resumed',
            resumed_revision = $3,
            resumed_at = $5,
            updated_at = $5,
            edit_log = edit_log || jsonb_build_array(jsonb_build_object(
              'revision', $3::int, 'event', 'resumed', 'actorRef', $4::text, 'at', $5::double precision))
      WHERE attempt_id = $1 AND tenant_id = $2 AND revision = $3 AND state = 'awaiting'
      RETURNING ${CHECKPOINT_COLUMNS}`,
    [attemptId, input.tenantId, input.revision, input.actorRef, input.now],
  );
  const row = result.rows[0];
  return row ? rowToCheckpoint(row) : null;
}

/** Mark the awaiting checkpoint abandoned (inside the abandon transaction). */
export async function markCheckpointAbandoned(
  queryable: Queryable,
  attemptId: string,
  input: { tenantId: string; actorRef: string; reason: string; now: number },
): Promise<GenerationCheckpoint | null> {
  const result = await queryable.query<RawCheckpointRow>(
    `UPDATE teaching_package_generation_checkpoints
        SET state = 'abandoned',
            abandoned_at = $5,
            updated_at = $5,
            edit_log = edit_log || jsonb_build_array(jsonb_build_object(
              'revision', revision, 'event', 'abandoned', 'actorRef', $3::text,
              'at', $5::double precision, 'reason', $4::text))
      WHERE attempt_id = $1 AND tenant_id = $2 AND state = 'awaiting'
      RETURNING ${CHECKPOINT_COLUMNS}`,
    [attemptId, input.tenantId, input.actorRef, input.reason, input.now],
  );
  const row = result.rows[0];
  return row ? rowToCheckpoint(row) : null;
}
