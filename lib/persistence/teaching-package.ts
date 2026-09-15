/**
 * Teaching Package persistence — the Module 1 companion tables beside the
 * document store, following the exact pattern of `stage-meta.ts` and
 * `owner-materials.ts`: an exported schema string, an idempotent
 * `ensureTeachingPackageSchema` registered at server bootstrap, raw-row
 * interfaces, and small typed row helpers that take a `Queryable` (so they work
 * inside any transaction). No class, no store abstraction.
 *
 * Three tables (BRD §25 / plan §4.3):
 * - `teaching_package_versions`: one row per version; the single-approved and
 *   single-active partial unique indexes and the `ON DELETE RESTRICT`
 *   `current_stage_id` FK are the database-level floor under the BRD's absolute
 *   invariants.
 * - `teaching_package_review_events`: append-only (trigger-enforced) history.
 * - `teaching_package_generation_attempts`: job record and lineage record at
 *   once. `input_snapshot` carries the lightweight `GenerationInputSnapshot`
 *   only — never the transient execution input. `produced_stage_id` is the
 *   immutable Stage identity; `stage_id` is the nullable live reference
 *   (`ON DELETE SET NULL`) the future retention policy releases.
 *
 * No `ON DELETE CASCADE` anywhere: history must outlive hard deletes, and a
 * version's Stage can never be hard-deleted underneath it (RESTRICT).
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

import type {
  GenerationAttempt,
  GenerationAttemptKind,
  GenerationAttemptStatus,
  GenerationInputSnapshot,
  LearningItemRef,
  ReviewEvent,
  ReviewEventType,
  TeachingModelLineage,
  TeachingPackageStatus,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

export const TEACHING_PACKAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS teaching_package_versions (
  id TEXT PRIMARY KEY,
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft','in_review','rejected','approved','superseded','discarded')),
  current_stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE RESTRICT,
  current_attempt_id TEXT,
  teaching_model_key TEXT NOT NULL,
  teaching_model_version TEXT NOT NULL,
  predecessor_version_id TEXT REFERENCES teaching_package_versions(id),
  superseded_by_version_id TEXT REFERENCES teaching_package_versions(id),
  submitted_stage_rev BIGINT,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  submitted_at DOUBLE PRECISION,
  approved_at DOUBLE PRECISION,
  superseded_at DOUBLE PRECISION,
  discarded_at DOUBLE PRECISION
);

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_item_version_unique
  ON teaching_package_versions (learning_item_type, learning_item_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_current_stage_unique
  ON teaching_package_versions (current_stage_id);

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_single_approved
  ON teaching_package_versions (learning_item_type, learning_item_id) WHERE status = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_single_active
  ON teaching_package_versions (learning_item_type, learning_item_id)
  WHERE status IN ('draft','in_review','rejected');

CREATE INDEX IF NOT EXISTS teaching_package_versions_item_version_idx
  ON teaching_package_versions (learning_item_type, learning_item_id, version DESC);

CREATE TABLE IF NOT EXISTS teaching_package_review_events (
  id BIGSERIAL PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES teaching_package_versions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('created','submitted_for_review','review_edit_started','rejected','resubmitted','approved','superseded','discarded','successor_created','stage_replaced')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_ref TEXT NOT NULL CHECK (length(btrim(actor_ref)) > 0),
  reason TEXT,
  comment TEXT,
  related_version_id TEXT,
  data JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  CONSTRAINT teaching_package_review_events_rejected_reason_check
    CHECK (event_type <> 'rejected' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS teaching_package_review_events_version_idx
  ON teaching_package_review_events (version_id, id);

CREATE OR REPLACE FUNCTION teaching_package_review_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'teaching_package_review_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teaching_package_review_events_append_only_trigger
  ON teaching_package_review_events;

CREATE TRIGGER teaching_package_review_events_append_only_trigger
  BEFORE UPDATE OR DELETE ON teaching_package_review_events
  FOR EACH ROW EXECUTE FUNCTION teaching_package_review_events_append_only();

CREATE TABLE IF NOT EXISTS teaching_package_generation_attempts (
  id TEXT PRIMARY KEY,
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  version_id TEXT REFERENCES teaching_package_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('initial','regeneration')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  request_id TEXT,
  requested_by_actor_ref TEXT NOT NULL,
  teaching_model_key TEXT NOT NULL,
  teaching_model_version TEXT NOT NULL,
  input_snapshot JSONB NOT NULL,
  produced_stage_id TEXT,
  stage_id TEXT REFERENCES document_stages(id) ON DELETE SET NULL,
  displaced_at DOUBLE PRECISION,
  stage_released_at DOUBLE PRECISION,
  progress JSONB,
  error TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  started_at DOUBLE PRECISION,
  completed_at DOUBLE PRECISION
);

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_attempts_single_inflight
  ON teaching_package_generation_attempts (learning_item_type, learning_item_id)
  WHERE status IN ('queued','running');

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_attempts_request_id_unique
  ON teaching_package_generation_attempts (learning_item_type, learning_item_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS teaching_package_attempts_version_created_idx
  ON teaching_package_generation_attempts (version_id, created_at);

CREATE INDEX IF NOT EXISTS teaching_package_attempts_stage_idx
  ON teaching_package_generation_attempts (stage_id)
  WHERE stage_id IS NOT NULL AND stage_released_at IS NULL;

CREATE INDEX IF NOT EXISTS teaching_package_attempts_displaced_idx
  ON teaching_package_generation_attempts (displaced_at)
  WHERE displaced_at IS NOT NULL AND stage_released_at IS NULL;
`;

export async function ensureTeachingPackageSchema(queryable: Queryable): Promise<void> {
  // The trigger body is dollar-quoted, so the schema must go through
  // splitSqlStatements (see owner-materials.ts) rather than a plain split(';').
  for (const statement of splitSqlStatements(TEACHING_PACKAGE_SCHEMA)) {
    await queryable.query(statement);
  }
}

interface RawTeachingPackageVersionRow extends Record<string, unknown> {
  id: string;
  learning_item_type: string;
  learning_item_id: string;
  version: number | string;
  status: string;
  current_stage_id: string;
  current_attempt_id: string | null;
  teaching_model_key: string;
  teaching_model_version: string;
  predecessor_version_id: string | null;
  superseded_by_version_id: string | null;
  submitted_stage_rev: number | string | null;
  created_at: number | string;
  updated_at: number | string;
  submitted_at: number | string | null;
  approved_at: number | string | null;
  superseded_at: number | string | null;
  discarded_at: number | string | null;
}

const VERSION_COLUMNS = `id,
  learning_item_type,
  learning_item_id,
  version,
  status,
  current_stage_id,
  current_attempt_id,
  teaching_model_key,
  teaching_model_version,
  predecessor_version_id,
  superseded_by_version_id,
  submitted_stage_rev,
  created_at,
  updated_at,
  submitted_at,
  approved_at,
  superseded_at,
  discarded_at`;

function rowToVersion(row: RawTeachingPackageVersionRow): TeachingPackageVersion {
  return {
    id: row.id,
    learningItem: {
      type: row.learning_item_type as LearningItemRef['type'],
      id: row.learning_item_id,
    },
    version: Number(row.version),
    status: row.status as TeachingPackageStatus,
    currentStageId: row.current_stage_id,
    currentAttemptId: row.current_attempt_id,
    teachingModel: {
      key: row.teaching_model_key,
      version: row.teaching_model_version,
    },
    predecessorVersionId: row.predecessor_version_id,
    supersededByVersionId: row.superseded_by_version_id,
    submittedStageRev: row.submitted_stage_rev === null ? null : Number(row.submitted_stage_rev),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
    approvedAt: row.approved_at === null ? null : Number(row.approved_at),
    supersededAt: row.superseded_at === null ? null : Number(row.superseded_at),
    discardedAt: row.discarded_at === null ? null : Number(row.discarded_at),
  };
}

const ITEM_PARAMS = 'learning_item_type = $1 AND learning_item_id = $2';

function itemValues(item: LearningItemRef): [string, string] {
  return [item.type, item.id];
}

export interface InsertTeachingPackageVersionInput {
  id: string;
  learningItem: LearningItemRef;
  version: number;
  status: TeachingPackageStatus;
  currentStageId: string;
  currentAttemptId?: string | null;
  teachingModel: TeachingModelLineage;
  predecessorVersionId?: string | null;
  now: number;
}

export async function insertVersion(
  queryable: Queryable,
  input: InsertTeachingPackageVersionInput,
): Promise<TeachingPackageVersion> {
  const inserted = await queryable.query<RawTeachingPackageVersionRow>(
    `INSERT INTO teaching_package_versions
       (id, learning_item_type, learning_item_id, version, status,
        current_stage_id, current_attempt_id, teaching_model_key, teaching_model_version,
        predecessor_version_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     RETURNING ${VERSION_COLUMNS}`,
    [
      input.id,
      input.learningItem.type,
      input.learningItem.id,
      input.version,
      input.status,
      input.currentStageId,
      input.currentAttemptId ?? null,
      input.teachingModel.key,
      input.teachingModel.version,
      input.predecessorVersionId ?? null,
      input.now,
    ],
  );
  return rowToVersion(inserted.rows[0]);
}

export async function readVersion(
  queryable: Queryable,
  id: string,
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM teaching_package_versions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

export async function readVersionForUpdate(
  queryable: Queryable,
  id: string,
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM teaching_package_versions WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

export async function listVersionsByItem(
  queryable: Queryable,
  item: LearningItemRef,
): Promise<TeachingPackageVersion[]> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS}
      ORDER BY version ASC`,
    itemValues(item),
  );
  return result.rows.map(rowToVersion);
}

export async function readApprovedVersion(
  queryable: Queryable,
  item: LearningItemRef,
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS} AND status = 'approved'
      LIMIT 1`,
    itemValues(item),
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

export async function readActiveVersion(
  queryable: Queryable,
  item: LearningItemRef,
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS} AND status IN ('draft','in_review','rejected')
      LIMIT 1`,
    itemValues(item),
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

/** Next version number = MAX(version) + 1 under the item's advisory lock. */
export async function nextVersionNumber(
  queryable: Queryable,
  item: LearningItemRef,
): Promise<number> {
  const result = await queryable.query<{ next: number | string | null }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS}`,
    itemValues(item),
  );
  return Number(result.rows[0]?.next ?? 1);
}

export interface UpdateTeachingPackageVersionStatusPatch {
  status: TeachingPackageStatus;
  /** Explicit null clears the column; undefined leaves it untouched. */
  submittedAt?: number | null;
  approvedAt?: number | null;
  supersededAt?: number | null;
  discardedAt?: number | null;
  supersededByVersionId?: string | null;
  submittedStageRev?: number | null;
  now: number;
}

export async function updateVersionStatus(
  queryable: Queryable,
  id: string,
  patch: UpdateTeachingPackageVersionStatusPatch,
): Promise<TeachingPackageVersion | null> {
  const sets: string[] = ['status = $1', 'updated_at = $2'];
  const values: unknown[] = [patch.status, patch.now];
  const addColumn = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.submittedAt !== undefined) addColumn('submitted_at', patch.submittedAt);
  if (patch.approvedAt !== undefined) addColumn('approved_at', patch.approvedAt);
  if (patch.supersededAt !== undefined) addColumn('superseded_at', patch.supersededAt);
  if (patch.discardedAt !== undefined) addColumn('discarded_at', patch.discardedAt);
  if (patch.supersededByVersionId !== undefined) {
    addColumn('superseded_by_version_id', patch.supersededByVersionId);
  }
  if (patch.submittedStageRev !== undefined) {
    addColumn('submitted_stage_rev', patch.submittedStageRev);
  }
  values.push(id);
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `UPDATE teaching_package_versions
        SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${VERSION_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

/** Point a draft/rejected version at a freshly completed Stage (regeneration relink). */
export async function relinkVersionStage(
  queryable: Queryable,
  id: string,
  relink: {
    stageId: string;
    attemptId: string | null;
    teachingModel: TeachingModelLineage;
    now: number;
  },
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `UPDATE teaching_package_versions
        SET current_stage_id = $2,
            current_attempt_id = $3,
            teaching_model_key = $4,
            teaching_model_version = $5,
            updated_at = $6
      WHERE id = $1
      RETURNING ${VERSION_COLUMNS}`,
    [
      id,
      relink.stageId,
      relink.attemptId,
      relink.teachingModel.key,
      relink.teachingModel.version,
      relink.now,
    ],
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

interface RawReviewEventRow extends Record<string, unknown> {
  id: number | string;
  version_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor_ref: string;
  reason: string | null;
  comment: string | null;
  related_version_id: string | null;
  data: unknown;
  created_at: number | string;
}

const EVENT_COLUMNS = `id,
  version_id,
  event_type,
  from_status,
  to_status,
  actor_ref,
  reason,
  comment,
  related_version_id,
  data,
  created_at`;

function rowToEvent(row: RawReviewEventRow): ReviewEvent {
  return {
    id: Number(row.id),
    versionId: row.version_id,
    eventType: row.event_type as ReviewEventType,
    fromStatus: row.from_status as TeachingPackageStatus | null,
    toStatus: row.to_status as TeachingPackageStatus,
    actorRef: row.actor_ref,
    reason: row.reason,
    comment: row.comment,
    relatedVersionId: row.related_version_id,
    data: row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : null,
    createdAt: Number(row.created_at),
  };
}

export interface AppendReviewEventInput {
  versionId: string;
  eventType: ReviewEventType;
  fromStatus: TeachingPackageStatus | null;
  toStatus: TeachingPackageStatus;
  actorRef: string;
  reason?: string | null;
  comment?: string | null;
  relatedVersionId?: string | null;
  data?: Record<string, unknown> | null;
  createdAt: number;
}

export async function appendReviewEvent(
  queryable: Queryable,
  event: AppendReviewEventInput,
): Promise<ReviewEvent> {
  const inserted = await queryable.query<RawReviewEventRow>(
    `INSERT INTO teaching_package_review_events
       (version_id, event_type, from_status, to_status, actor_ref,
        reason, comment, related_version_id, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     RETURNING ${EVENT_COLUMNS}`,
    [
      event.versionId,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.actorRef,
      event.reason ?? null,
      event.comment ?? null,
      event.relatedVersionId ?? null,
      event.data ? JSON.stringify(event.data) : null,
      event.createdAt,
    ],
  );
  return rowToEvent(inserted.rows[0]);
}

export async function listReviewEvents(
  queryable: Queryable,
  versionId: string,
): Promise<ReviewEvent[]> {
  const result = await queryable.query<RawReviewEventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM teaching_package_review_events
      WHERE version_id = $1
      ORDER BY id ASC`,
    [versionId],
  );
  return result.rows.map(rowToEvent);
}

interface RawAttemptRow extends Record<string, unknown> {
  id: string;
  learning_item_type: string;
  learning_item_id: string;
  version_id: string | null;
  kind: string;
  status: string;
  request_id: string | null;
  requested_by_actor_ref: string;
  teaching_model_key: string;
  teaching_model_version: string;
  input_snapshot: unknown;
  produced_stage_id: string | null;
  stage_id: string | null;
  displaced_at: number | string | null;
  stage_released_at: number | string | null;
  progress: unknown;
  error: string | null;
  created_at: number | string;
  started_at: number | string | null;
  completed_at: number | string | null;
}

const ATTEMPT_COLUMNS = `id,
  learning_item_type,
  learning_item_id,
  version_id,
  kind,
  status,
  request_id,
  requested_by_actor_ref,
  teaching_model_key,
  teaching_model_version,
  input_snapshot,
  produced_stage_id,
  stage_id,
  displaced_at,
  stage_released_at,
  progress,
  error,
  created_at,
  started_at,
  completed_at`;

function rowToAttempt(row: RawAttemptRow): GenerationAttempt {
  return {
    id: row.id,
    learningItem: {
      type: row.learning_item_type as LearningItemRef['type'],
      id: row.learning_item_id,
    },
    versionId: row.version_id,
    kind: row.kind as GenerationAttemptKind,
    status: row.status as GenerationAttemptStatus,
    requestId: row.request_id,
    requestedByActorRef: row.requested_by_actor_ref,
    teachingModel: { key: row.teaching_model_key, version: row.teaching_model_version },
    inputSnapshot: row.input_snapshot as GenerationInputSnapshot,
    producedStageId: row.produced_stage_id,
    stageId: row.stage_id,
    displacedAt: row.displaced_at === null ? null : Number(row.displaced_at),
    stageReleasedAt: row.stage_released_at === null ? null : Number(row.stage_released_at),
    progress:
      row.progress && typeof row.progress === 'object'
        ? (row.progress as GenerationAttempt['progress'])
        : null,
    error: row.error,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

/** Key names that may never appear in a persisted generationContext. */
const SECRET_CONTEXT_KEY = /key|token|secret|password/i;

/**
 * The snapshot persisted per attempt is the lightweight `GenerationInputSnapshot`
 * only. The transient execution input (`webSearchApiKey`, raw `pdfContent`,
 * secret-looking context keys) must never reach any column, so the insert
 * refuses it outright rather than silently persisting it.
 */
function assertSnapshotPersistable(snapshot: GenerationInputSnapshot): void {
  const record = snapshot as unknown as Record<string, unknown>;
  if ('webSearchApiKey' in record) {
    throw new Error('input snapshot must not carry webSearchApiKey (execution-only)');
  }
  if ('pdfContent' in record) {
    throw new Error('input snapshot must not carry pdfContent (execution-only)');
  }
  if (record.generationContext && typeof record.generationContext === 'object') {
    for (const key of Object.keys(record.generationContext as Record<string, unknown>)) {
      if (SECRET_CONTEXT_KEY.test(key)) {
        throw new Error(
          `generation context key ${JSON.stringify(key)} looks like a secret and is not persistable`,
        );
      }
    }
  }
}

export interface InsertTeachingPackageAttemptInput {
  id: string;
  learningItem: LearningItemRef;
  versionId?: string | null;
  kind: GenerationAttemptKind;
  status: GenerationAttemptStatus;
  requestId?: string | null;
  requestedByActorRef: string;
  teachingModel: TeachingModelLineage;
  inputSnapshot: GenerationInputSnapshot;
  now: number;
}

export async function insertAttempt(
  queryable: Queryable,
  input: InsertTeachingPackageAttemptInput,
): Promise<GenerationAttempt> {
  assertSnapshotPersistable(input.inputSnapshot);
  const inserted = await queryable.query<RawAttemptRow>(
    `INSERT INTO teaching_package_generation_attempts
       (id, learning_item_type, learning_item_id, version_id, kind, status,
        request_id, requested_by_actor_ref, teaching_model_key, teaching_model_version,
        input_snapshot, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     RETURNING ${ATTEMPT_COLUMNS}`,
    [
      input.id,
      input.learningItem.type,
      input.learningItem.id,
      input.versionId ?? null,
      input.kind,
      input.status,
      input.requestId ?? null,
      input.requestedByActorRef,
      input.teachingModel.key,
      input.teachingModel.version,
      JSON.stringify(input.inputSnapshot),
      input.now,
    ],
  );
  return rowToAttempt(inserted.rows[0]);
}

export async function readAttempt(
  queryable: Queryable,
  id: string,
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM teaching_package_generation_attempts WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

export async function readAttemptForUpdate(
  queryable: Queryable,
  id: string,
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM teaching_package_generation_attempts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

export async function readAttemptByRequestId(
  queryable: Queryable,
  item: LearningItemRef,
  requestId: string,
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM teaching_package_generation_attempts
      WHERE ${ITEM_PARAMS} AND request_id = $3
      LIMIT 1`,
    [...itemValues(item), requestId],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

export interface UpdateAttemptPatch {
  status?: GenerationAttemptStatus;
  progress?: GenerationAttempt['progress'];
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  versionId?: string | null;
}

export async function updateAttempt(
  queryable: Queryable,
  id: string,
  patch: UpdateAttemptPatch,
): Promise<GenerationAttempt | null> {
  if ('producedStageId' in (patch as Record<string, unknown>)) {
    throw new Error('producedStageId is immutable once set; use markAttemptSucceeded');
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  const addColumn = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.status !== undefined) addColumn('status', patch.status);
  if (patch.progress !== undefined) {
    addColumn('progress', patch.progress === null ? null : JSON.stringify(patch.progress));
  }
  if (patch.error !== undefined) addColumn('error', patch.error);
  if (patch.startedAt !== undefined) addColumn('started_at', patch.startedAt);
  if (patch.completedAt !== undefined) addColumn('completed_at', patch.completedAt);
  if (patch.versionId !== undefined) addColumn('version_id', patch.versionId);
  if (sets.length === 0) {
    const untouched = await readAttempt(queryable, id);
    if (!untouched) return null;
    return untouched;
  }
  values.push(id);
  const result = await queryable.query<RawAttemptRow>(
    `UPDATE teaching_package_generation_attempts
        SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ATTEMPT_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

/**
 * Record a successful completion: `produced_stage_id` (immutable lineage) and
 * `stage_id` (live reference) are set to the same generated Stage id together
 * with `status='succeeded'` and `completed_at`. `produced_stage_id` keeps its
 * existing value if one is already present — it is written exactly once.
 */
export async function markAttemptSucceeded(
  queryable: Queryable,
  id: string,
  success: { stageId: string; versionId: string; now: number },
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `UPDATE teaching_package_generation_attempts
        SET status = 'succeeded',
            completed_at = $2,
            version_id = $3,
            produced_stage_id = COALESCE(produced_stage_id, $4),
            stage_id = $4
      WHERE id = $1
      RETURNING ${ATTEMPT_COLUMNS}`,
    [id, success.now, success.versionId, success.stageId],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

/** Mark the attempt whose Stage stopped being the version's current Stage. */
export async function markAttemptDisplaced(
  queryable: Queryable,
  attemptId: string,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_generation_attempts
        SET displaced_at = $2
      WHERE id = $1 AND displaced_at IS NULL`,
    [attemptId, now],
  );
}

/**
 * Release a displaced Stage for the future retention policy: the guard stops
 * protecting the Stage once `stage_released_at` is set.
 */
export async function releaseDisplacedStage(
  queryable: Queryable,
  attemptId: string,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_generation_attempts
        SET stage_released_at = $2
      WHERE id = $1 AND stage_released_at IS NULL`,
    [attemptId, now],
  );
}

export interface StageReferences {
  /** Versions referencing the Stage as `current_stage_id`, with their statuses. */
  versions: Array<{ id: string; status: TeachingPackageStatus }>;
  /** True iff an attempt row retains this Stage (`stage_id` set, not released). */
  retainedDisplaced: boolean;
}

/**
 * The stage guard's read: versions are taken `FOR SHARE` so a write waits for
 * an in-flight lifecycle transaction on the same version to commit and then
 * sees the committed status (lock order stays `stage_meta → versions`; this
 * helper never takes the advisory lock and never locks `stage_meta` itself).
 */
export async function readStageReferences(
  queryable: Queryable,
  stageId: string,
): Promise<StageReferences> {
  const versions = await queryable.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM teaching_package_versions
      WHERE current_stage_id = $1
      ORDER BY id
      FOR SHARE`,
    [stageId],
  );
  const retained = await queryable.query<{ retained: boolean }>(
    `SELECT EXISTS(
       SELECT 1
         FROM teaching_package_generation_attempts
        WHERE stage_id = $1 AND stage_released_at IS NULL
     ) AS retained`,
    [stageId],
  );
  return {
    versions: versions.rows.map((row) => ({
      id: row.id,
      status: row.status as TeachingPackageStatus,
    })),
    retainedDisplaced: retained.rows[0]?.retained === true,
  };
}
