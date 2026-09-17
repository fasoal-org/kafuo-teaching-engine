/**
 * Teaching Package persistence — the Module 1 companion tables beside the
 * document store, following the exact pattern of `stage-meta.ts` and
 * `owner-materials.ts`: exported schema constants, an idempotent
 * `ensureTeachingPackageSchema` registered at server bootstrap, raw-row
 * interfaces, and small typed row helpers that take a `Queryable` (so they work
 * inside any transaction). No class, no store abstraction.
 *
 * Tables (BRD §25 / plan §4.3, Kafuo integration plan §4.1):
 * - `teaching_package_versions`: one row per version; the TENANT-SCOPED
 *   single-approved and single-active partial unique indexes and the
 *   `ON DELETE RESTRICT` `current_stage_id` FK are the database-level floor
 *   under the BRD's absolute invariants. The one canonical aggregate scope is
 *   `(tenant_id, learning_item_type, learning_item_id)` (plan §4.1.2).
 * - `teaching_package_review_events`: append-only (trigger-enforced) history.
 * - `teaching_package_generation_attempts`: job record and lineage record at
 *   once. `input_snapshot` carries the lightweight `GenerationInputSnapshot`
 *   only — never the transient execution input. `produced_stage_id` is the
 *   immutable Stage identity; `stage_id` is the nullable live reference
 *   (`ON DELETE SET NULL`) the future retention policy releases. Kafuo rows
 *   additionally carry the semantic `request_digest`, a `generation_runs`
 *   counter, and structured `error_code`/`error_retryable` columns.
 *
 * No `ON DELETE CASCADE` anywhere: history must outlive hard deletes, and a
 * version's Stage can never be hard-deleted underneath it (RESTRICT).
 *
 * Tenant evolution (plan §4.1.1): `ensureTeachingPackageSchema` runs an
 * idempotent evolution block between the tables and the indexes that adds
 * `tenant_id` to an already-populated pre-tenant database, backfills existing
 * rows to the explicit `__legacy__` namespace, enforces NOT NULL + a
 * non-empty CHECK, drops the obsolete item-scoped unique indexes, creates the
 * canonical tenant-scoped ones, and finally VERIFIES no obsolete index name
 * remains (a failed verification fails boot).
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

import { LEGACY_TENANT_ID } from '@/lib/types/teaching-package';
import type {
  GenerationAttempt,
  GenerationAttemptKind,
  GenerationAttemptStatus,
  GenerationInputSnapshot,
  LearningItemRef,
  ReviewEvent,
  ReviewEventType,
  TeachingModelLineage,
  TeachingPackageAggregateKey,
  TeachingPackageStatus,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

const TENANT_CHECK = `tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0)`;

/** Tables only — created before the evolution block runs. */
const TEACHING_PACKAGE_TABLES = `
CREATE TABLE IF NOT EXISTS teaching_package_versions (
  id TEXT PRIMARY KEY,
  ${TENANT_CHECK},
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
  ${TENANT_CHECK},
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  version_id TEXT REFERENCES teaching_package_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('initial','regeneration')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  request_id TEXT,
  request_digest TEXT,
  teaching_skills_contract TEXT,
  skill_policy_digest TEXT,
  generation_runs INTEGER NOT NULL DEFAULT 0,
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
  error_code TEXT,
  error_retryable BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  started_at DOUBLE PRECISION,
  completed_at DOUBLE PRECISION
);
`;

/** Webhook delivery rows (plan §4.4.1) — created in their own idempotent block. */
const WEBHOOK_DELIVERY_TABLES = `
CREATE TABLE IF NOT EXISTS teaching_package_webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'teaching_package.generation_succeeded',
    'teaching_package.generation_failed',
    'teaching_package.status_changed'
  )),
  occurred_at DOUBLE PRECISION NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','terminal_failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at DOUBLE PRECISION NOT NULL,
  claimed_by TEXT,
  claimed_until DOUBLE PRECISION,
  last_status INTEGER,
  last_error TEXT,
  first_attempt_at DOUBLE PRECISION,
  last_attempt_at DOUBLE PRECISION,
  delivered_at DOUBLE PRECISION,
  terminal_failed_at DOUBLE PRECISION
);

CREATE UNIQUE INDEX IF NOT EXISTS tpwd_aggregate_sequence_unique
  ON teaching_package_webhook_deliveries (tenant_id, learning_item_type, learning_item_id, sequence);

CREATE INDEX IF NOT EXISTS tpwd_status_next_attempt_idx
  ON teaching_package_webhook_deliveries (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS tpwd_terminal_failed_idx
  ON teaching_package_webhook_deliveries (terminal_failed_at)
  WHERE terminal_failed_at IS NOT NULL;
`;

/**
 * Durable lesson source context (Kafuo question-flow closure, B1.2). Layer A
 * extracts the lesson PDF once per attempt and, until now, discarded the text
 * after the classroom runs. Question generation for an APPROVED version needs
 * that grounding later, without the transient presigned URL, so the extracted
 * text (from the existing `extractDocument` output — no second parser) is kept
 * per attempt. Never the PDF binary, never a URL, never a credential.
 */
const SOURCE_CONTEXT_TABLES = `
CREATE TABLE IF NOT EXISTS teaching_package_source_contexts (
  attempt_id TEXT PRIMARY KEY
    REFERENCES teaching_package_generation_attempts(id) ON DELETE RESTRICT,
  ${TENANT_CHECK},
  content_resource_id TEXT NOT NULL,
  measured_sha256 TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'pdf_fallback'
    CHECK (source_kind IN ('pdf_fallback', 'kafuo_normalized')),
  normalized_package_id TEXT,
  normalized_schema_version TEXT,
  content_revision_id TEXT,
  parse_run_id TEXT,
  structure_profile_id TEXT,
  structure_profile_version_id TEXT,
  text TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS tpsc_tenant_resource_idx
  ON teaching_package_source_contexts (tenant_id, content_resource_id);
`;

/**
 * Idempotent evolution for already-populated pre-tenant databases (plan
 * §4.1.1). Every statement is safe to re-run: add column if absent, backfill
 * NULLs to the explicit legacy namespace, tighten to NOT NULL, add the CHECK
 * constraint only when missing, then drop the obsolete item-scoped indexes.
 */
const TEACHING_PACKAGE_EVOLUTION = `
ALTER TABLE teaching_package_versions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE teaching_package_versions SET tenant_id = '${LEGACY_TENANT_ID}' WHERE tenant_id IS NULL;
ALTER TABLE teaching_package_versions ALTER COLUMN tenant_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teaching_package_versions_tenant_id_check'
  ) THEN
    ALTER TABLE teaching_package_versions
      ADD CONSTRAINT teaching_package_versions_tenant_id_check CHECK (length(tenant_id) > 0);
  END IF;
END;
$$;

ALTER TABLE teaching_package_generation_attempts ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE teaching_package_generation_attempts SET tenant_id = '${LEGACY_TENANT_ID}' WHERE tenant_id IS NULL;
ALTER TABLE teaching_package_generation_attempts ALTER COLUMN tenant_id SET NOT NULL;
-- Teaching Skills governance (Module 2 W6, plan §F — the module's only DDL):
-- additive, nullable, idempotent. NULL teaching_skills_contract ⇒ the attempt
-- was not governed ⇒ legacy. Deliberately NO backfill — absence IS the legacy
-- marker and inferring one would fabricate governance history (AC-TS-034).
ALTER TABLE teaching_package_generation_attempts ADD COLUMN IF NOT EXISTS teaching_skills_contract TEXT;
ALTER TABLE teaching_package_generation_attempts ADD COLUMN IF NOT EXISTS skill_policy_digest TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teaching_package_attempts_tenant_id_check'
  ) THEN
    ALTER TABLE teaching_package_generation_attempts
      ADD CONSTRAINT teaching_package_attempts_tenant_id_check CHECK (length(tenant_id) > 0);
  END IF;
END;
$$;

DROP INDEX IF EXISTS teaching_package_versions_item_version_unique;
DROP INDEX IF EXISTS teaching_package_versions_single_approved;
DROP INDEX IF EXISTS teaching_package_versions_single_active;
DROP INDEX IF EXISTS teaching_package_versions_item_version_idx;
DROP INDEX IF EXISTS teaching_package_attempts_single_inflight;
DROP INDEX IF EXISTS teaching_package_attempts_request_id_unique;
`;

const SOURCE_CONTEXT_EVOLUTION = `
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'pdf_fallback';
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS normalized_package_id TEXT;
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS normalized_schema_version TEXT;
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS content_revision_id TEXT;
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS parse_run_id TEXT;
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS structure_profile_id TEXT;
ALTER TABLE teaching_package_source_contexts ADD COLUMN IF NOT EXISTS structure_profile_version_id TEXT;
`;

/** Canonical indexes — tenant-scoped unique constraints in their ONLY form. */
const TEACHING_PACKAGE_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS tpv_tenant_item_version_unique
  ON teaching_package_versions (tenant_id, learning_item_type, learning_item_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS tpv_tenant_single_approved
  ON teaching_package_versions (tenant_id, learning_item_type, learning_item_id)
  WHERE status = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS tpv_tenant_single_active
  ON teaching_package_versions (tenant_id, learning_item_type, learning_item_id)
  WHERE status IN ('draft','in_review','rejected');

CREATE UNIQUE INDEX IF NOT EXISTS teaching_package_versions_current_stage_unique
  ON teaching_package_versions (current_stage_id);

CREATE INDEX IF NOT EXISTS tpv_tenant_item_version_idx
  ON teaching_package_versions (tenant_id, learning_item_type, learning_item_id, version DESC);

CREATE INDEX IF NOT EXISTS teaching_package_review_events_version_idx
  ON teaching_package_review_events (version_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS tpa_tenant_single_inflight
  ON teaching_package_generation_attempts (tenant_id, learning_item_type, learning_item_id)
  WHERE status IN ('queued','running');

CREATE UNIQUE INDEX IF NOT EXISTS tpa_tenant_request_id_unique
  ON teaching_package_generation_attempts (
    tenant_id, learning_item_type, learning_item_id, request_id
  )
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

/** Pre-tenant index names that must never survive `ensureTeachingPackageSchema`. */
const OBSOLETE_INDEX_NAMES = [
  'teaching_package_versions_item_version_unique',
  'teaching_package_versions_single_approved',
  'teaching_package_versions_single_active',
  'teaching_package_versions_item_version_idx',
  'teaching_package_attempts_single_inflight',
  'teaching_package_attempts_request_id_unique',
] as const;

export const TEACHING_PACKAGE_SCHEMA = `${TEACHING_PACKAGE_TABLES}
${TEACHING_PACKAGE_INDEXES}`;

export async function ensureTeachingPackageSchema(queryable: Queryable): Promise<void> {
  // The trigger/DO bodies are dollar-quoted, so every block must go through
  // splitSqlStatements (see owner-materials.ts) rather than a plain split(';').
  for (const statement of splitSqlStatements(TEACHING_PACKAGE_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(TEACHING_PACKAGE_EVOLUTION)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(TEACHING_PACKAGE_INDEXES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(WEBHOOK_DELIVERY_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(SOURCE_CONTEXT_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(SOURCE_CONTEXT_EVOLUTION)) {
    await queryable.query(statement);
  }
  // Verification: the canonical tenant-scoped indexes are the ONLY unique
  // authority; a surviving obsolete index would silently re-impose the
  // pre-tenant uniqueness. Failing here fails boot (instrumentation precedent).
  const stale = await queryable.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename IN ('teaching_package_versions', 'teaching_package_generation_attempts')
        AND indexname = ANY($1)`,
    [[...OBSOLETE_INDEX_NAMES]],
  );
  if (stale.rows.length > 0) {
    const names = stale.rows.map((row) => row.indexname).join(', ');
    throw new Error(`obsolete pre-tenant teaching package indexes remain: ${names}`);
  }
}

interface RawTeachingPackageVersionRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
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
  tenant_id,
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
    tenantId: row.tenant_id,
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

const ITEM_PARAMS = 'tenant_id = $1 AND learning_item_type = $2 AND learning_item_id = $3';

function itemValues(aggregate: TeachingPackageAggregateKey): [string, string, string] {
  return [aggregate.tenantId, aggregate.learningItem.type, aggregate.learningItem.id];
}

/** Scope filter for by-id reads: a cross-tenant id behaves exactly like absence. */
const TENANT_SCOPE_PARAM = 'tenant_id = $2';

export interface InsertTeachingPackageVersionInput {
  id: string;
  aggregate: TeachingPackageAggregateKey;
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
       (id, tenant_id, learning_item_type, learning_item_id, version, status,
        current_stage_id, current_attempt_id, teaching_model_key, teaching_model_version,
        predecessor_version_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING ${VERSION_COLUMNS}`,
    [
      input.id,
      input.aggregate.tenantId,
      input.aggregate.learningItem.type,
      input.aggregate.learningItem.id,
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
  scope: { tenantId: string },
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE id = $1 AND ${TENANT_SCOPE_PARAM}`,
    [id, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

export async function readVersionForUpdate(
  queryable: Queryable,
  id: string,
  scope: { tenantId: string },
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE id = $1 AND ${TENANT_SCOPE_PARAM}
      FOR UPDATE`,
    [id, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

/**
 * By-id read WITHOUT a tenant filter. Temporary internal seam for the handoff
 * redeem route, whose token does not carry the tenant until Phase 4 embeds it;
 * the HMAC token is the capability there. Never expose through a service route.
 */
export async function readVersionById(
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

export async function listVersionsByItem(
  queryable: Queryable,
  aggregate: TeachingPackageAggregateKey,
): Promise<TeachingPackageVersion[]> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS}
      ORDER BY version ASC`,
    itemValues(aggregate),
  );
  return result.rows.map(rowToVersion);
}

export async function readApprovedVersion(
  queryable: Queryable,
  aggregate: TeachingPackageAggregateKey,
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS} AND status = 'approved'
      LIMIT 1`,
    itemValues(aggregate),
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

export async function readActiveVersion(
  queryable: Queryable,
  aggregate: TeachingPackageAggregateKey,
): Promise<TeachingPackageVersion | null> {
  const result = await queryable.query<RawTeachingPackageVersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS} AND status IN ('draft','in_review','rejected')
      LIMIT 1`,
    itemValues(aggregate),
  );
  const row = result.rows[0];
  return row ? rowToVersion(row) : null;
}

/** Next version number = MAX(version) + 1 under the aggregate's advisory lock. */
export async function nextVersionNumber(
  queryable: Queryable,
  aggregate: TeachingPackageAggregateKey,
): Promise<number> {
  const result = await queryable.query<{ next: number | string | null }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM teaching_package_versions
      WHERE ${ITEM_PARAMS}`,
    itemValues(aggregate),
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
  tenant_id: string;
  learning_item_type: string;
  learning_item_id: string;
  version_id: string | null;
  kind: string;
  status: string;
  request_id: string | null;
  request_digest: string | null;
  teaching_skills_contract: string | null;
  skill_policy_digest: string | null;
  generation_runs: number | string;
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
  error_code: string | null;
  error_retryable: boolean | null;
  created_at: number | string;
  started_at: number | string | null;
  completed_at: number | string | null;
}

const ATTEMPT_COLUMNS = `id,
  tenant_id,
  learning_item_type,
  learning_item_id,
  version_id,
  kind,
  status,
  request_id,
  request_digest,
  teaching_skills_contract,
  skill_policy_digest,
  generation_runs,
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
  error_code,
  error_retryable,
  created_at,
  started_at,
  completed_at`;

function rowToAttempt(row: RawAttemptRow): GenerationAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    learningItem: {
      type: row.learning_item_type as LearningItemRef['type'],
      id: row.learning_item_id,
    },
    versionId: row.version_id,
    kind: row.kind as GenerationAttemptKind,
    status: row.status as GenerationAttemptStatus,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    teachingSkillsContract: row.teaching_skills_contract,
    skillPolicyDigest: row.skill_policy_digest,
    generationRuns: Number(row.generation_runs ?? 0),
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
    errorCode: row.error_code,
    errorRetryable: row.error_retryable === null ? null : row.error_retryable === true,
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
/**
 * Keys whose NAME marks a credential-bearing retrieval URL field, wherever
 * they appear (plan §4.4.7). A safe unrelated metadata field named `url`
 * (e.g. a documentation link) is NOT rejected — only the credential-bearing
 * names and URL values carrying signature query parameters are.
 */
const SIGNED_URL_FIELD_NAME = /^(signedUrl|presignedUrl|retrievalUrl|downloadUrl)$/i;
const CREDENTIAL_QUERY_PARAMS = [
  'x-amz-signature',
  'x-amz-credential',
  'signature',
  'sig',
  'token',
  'access_key',
];

function carriesCredentialQuery(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAMS.includes(key.toLowerCase())) return true;
  }
  return false;
}

/** Reject credential-bearing URL fields anywhere in a JSON-able value. */
function assertNoCredentialUrls(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && carriesCredentialQuery(value)) {
      throw new Error(`input snapshot must not carry credential-bearing URLs (at ${path})`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialUrls(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SIGNED_URL_FIELD_NAME.test(key)) {
        throw new Error(
          `input snapshot must not carry ${JSON.stringify(key)} (credential-bearing URL field, at ${path})`,
        );
      }
      assertNoCredentialUrls(entry, path === '' ? key : `${path}.${key}`);
    }
  }
}

function assertSnapshotPersistable(snapshot: GenerationInputSnapshot): void {
  const record = snapshot as unknown as Record<string, unknown>;
  if ('webSearchApiKey' in record) {
    throw new Error('input snapshot must not carry webSearchApiKey (execution-only)');
  }
  if ('pdfContent' in record) {
    throw new Error('input snapshot must not carry pdfContent (execution-only)');
  }
  if (
    record.contentResource &&
    typeof record.contentResource === 'object' &&
    'url' in (record.contentResource as Record<string, unknown>)
  ) {
    throw new Error('input snapshot must not carry contentResource.url (transient credential)');
  }
  if (
    record.normalizedContentResource &&
    typeof record.normalizedContentResource === 'object' &&
    'url' in (record.normalizedContentResource as Record<string, unknown>)
  ) {
    throw new Error(
      'input snapshot must not carry normalizedContentResource.url (transient credential)',
    );
  }
  assertNoCredentialUrls(record, '');
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
  aggregate: TeachingPackageAggregateKey;
  versionId?: string | null;
  kind: GenerationAttemptKind;
  status: GenerationAttemptStatus;
  requestId?: string | null;
  /** Semantic digest of the Kafuo request; null for legacy body callers. */
  requestDigest?: string | null;
  /** Teaching Skills contract marker; null/omitted ⇒ the attempt is legacy (Module 2 W6). */
  teachingSkillsContract?: string | null;
  /** Skill Policy lineage digest — integrity evidence only (Module 2 W6). */
  skillPolicyDigest?: string | null;
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
       (id, tenant_id, learning_item_type, learning_item_id, version_id, kind, status,
        request_id, request_digest, teaching_skills_contract, skill_policy_digest,
        requested_by_actor_ref,
        teaching_model_key, teaching_model_version, input_snapshot, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
     RETURNING ${ATTEMPT_COLUMNS}`,
    [
      input.id,
      input.aggregate.tenantId,
      input.aggregate.learningItem.type,
      input.aggregate.learningItem.id,
      input.versionId ?? null,
      input.kind,
      input.status,
      input.requestId ?? null,
      input.requestDigest ?? null,
      input.teachingSkillsContract ?? null,
      input.skillPolicyDigest ?? null,
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
  scope: { tenantId: string },
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM teaching_package_generation_attempts
      WHERE id = $1 AND ${TENANT_SCOPE_PARAM}`,
    [id, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

export async function readAttemptForUpdate(
  queryable: Queryable,
  id: string,
  scope: { tenantId: string },
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM teaching_package_generation_attempts
      WHERE id = $1 AND ${TENANT_SCOPE_PARAM}
      FOR UPDATE`,
    [id, scope.tenantId],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

/**
 * By-id read WITHOUT a tenant filter, for the runner/completion transaction:
 * the attempt id is an internal handle and the aggregate scope (including the
 * tenant) is derived from the row itself. Service routes must use
 * {@link readAttempt} with a caller scope instead.
 */
export async function readAttemptById(
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

export async function readAttemptByRequestId(
  queryable: Queryable,
  aggregate: TeachingPackageAggregateKey,
  requestId: string,
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM teaching_package_generation_attempts
      WHERE ${ITEM_PARAMS} AND request_id = $4
      LIMIT 1`,
    [...itemValues(aggregate), requestId],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
}

/**
 * Reclaim attempts whose runner died in-process: both `queued` (the `after()`
 * never ran) and `running` rows older than `staleBefore` fail with
 * `ATTEMPT_RECLAIMED_STALE`. Returns the reclaimed rows so a caller can emit
 * the Phase 4 `generation_failed` event. `scope = null` reclaims across every
 * aggregate (the periodic sweep); a scoped call reclaims one aggregate under
 * its advisory lock. The execution input was never persisted, so a reclaimed
 * attempt cannot be resumed.
 */
export async function reclaimStaleAttempts(
  queryable: Queryable,
  scope: TeachingPackageAggregateKey | null,
  staleBefore: number,
): Promise<GenerationAttempt[]> {
  const now = Date.now();
  const scoped = scope !== null;
  const result = await queryable.query<RawAttemptRow>(
    `UPDATE teaching_package_generation_attempts
        SET status = 'failed',
            error = 'stale',
            error_code = 'ATTEMPT_RECLAIMED_STALE',
            error_retryable = TRUE,
            completed_at = $1
      WHERE status IN ('queued', 'running')
        AND created_at < $2
        ${scoped ? 'AND tenant_id = $3 AND learning_item_type = $4 AND learning_item_id = $5' : ''}
      RETURNING ${ATTEMPT_COLUMNS}`,
    scoped
      ? [now, staleBefore, scope.tenantId, scope.learningItem.type, scope.learningItem.id]
      : [now, staleBefore],
  );
  return result.rows.map(rowToAttempt);
}

/** +1 on the full-classroom generation run counter (Layer B, plan §4.3.8). */
export async function incrementGenerationRuns(
  queryable: Queryable,
  attemptId: string,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_generation_attempts
        SET generation_runs = generation_runs + 1
      WHERE id = $1`,
    [attemptId],
  );
}

export interface UpdateAttemptPatch {
  status?: GenerationAttemptStatus;
  progress?: GenerationAttempt['progress'];
  error?: string | null;
  errorCode?: string | null;
  errorRetryable?: boolean | null;
  startedAt?: number | null;
  completedAt?: number | null;
  versionId?: string | null;
}

/**
 * Atomically claim a queued attempt for execution: `queued → running`, once.
 *
 * The status predicate lives in the UPDATE rather than in a read-then-write,
 * so two runners racing the same attempt cannot both proceed — exactly one
 * row is returned, and every other caller gets `null`. A terminal attempt
 * (`succeeded`/`failed`) never matches, so a replayed request can never turn a
 * finished attempt back into a running one.
 *
 * `null` is an ANSWER, not an error: the attempt was already claimed, or it is
 * terminal. Nothing else is written — `completed_at`, the stage bindings and
 * the error columns are untouched by construction, which is what keeps a
 * replay from rewriting a finished attempt's outcome.
 *
 * Deliberately separate from `updateAttempt`: that one is unconditional by
 * design (progress writes and `failGenerationAttempt` depend on it), so the
 * predicate cannot be folded into it without changing those callers.
 */
export async function claimQueuedAttemptForRun(
  queryable: Queryable,
  id: string,
  startedAt: number,
): Promise<GenerationAttempt | null> {
  const result = await queryable.query<RawAttemptRow>(
    `UPDATE teaching_package_generation_attempts
        SET status = 'running', started_at = $2
      WHERE id = $1 AND status = 'queued'
      RETURNING ${ATTEMPT_COLUMNS}`,
    [id, startedAt],
  );
  const row = result.rows[0];
  return row ? rowToAttempt(row) : null;
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
  if (patch.errorCode !== undefined) addColumn('error_code', patch.errorCode);
  if (patch.errorRetryable !== undefined) addColumn('error_retryable', patch.errorRetryable);
  if (patch.startedAt !== undefined) addColumn('started_at', patch.startedAt);
  if (patch.completedAt !== undefined) addColumn('completed_at', patch.completedAt);
  if (patch.versionId !== undefined) addColumn('version_id', patch.versionId);
  if (sets.length === 0) {
    const untouched = await readAttemptById(queryable, id);
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

/**
 * Release EVERY attempt row that still retains `stageId`, so the stage guard's
 * retained-displaced protection stops applying to it.
 *
 * Keyed by Stage rather than by attempt id on purpose: a Stage can be retained
 * by more than one attempt row (a reclaimed runner's orphan alongside the
 * version's own producing attempt), and the guard's retention read
 * (`stage_id = $1 AND stage_released_at IS NULL`) refuses while ANY of them
 * still retains it. Releasing one row would leave the Stage protected by the
 * others. The rows themselves are kept — lineage and audit metadata survive;
 * only the retention claim is lifted.
 */
export async function releaseStageRetention(
  queryable: Queryable,
  stageId: string,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_generation_attempts
        SET stage_released_at = $2
      WHERE stage_id = $1 AND stage_released_at IS NULL`,
    [stageId, now],
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

// ---------------------------------------------------------------------------
// Webhook delivery rows (plan §4.4.1).
// ---------------------------------------------------------------------------

export interface WebhookDeliveryRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  learning_item_type: string;
  learning_item_id: string;
  sequence: number | string;
  event_type: string;
  occurred_at: number | string;
  payload: unknown;
  status: string;
  attempts: number | string;
  next_attempt_at: number | string;
  claimed_by: string | null;
  claimed_until: number | string | null;
  last_status: number | null;
  last_error: string | null;
  first_attempt_at: number | string | null;
  last_attempt_at: number | string | null;
  delivered_at: number | string | null;
  terminal_failed_at: number | string | null;
}

const WEBHOOK_COLUMNS = `id,
  tenant_id,
  learning_item_type,
  learning_item_id,
  sequence,
  event_type,
  occurred_at,
  payload,
  status,
  attempts,
  next_attempt_at,
  claimed_by,
  claimed_until,
  last_status,
  last_error,
  first_attempt_at,
  last_attempt_at,
  delivered_at,
  terminal_failed_at`;

export interface InsertWebhookDeliveryInput {
  id: string;
  aggregate: TeachingPackageAggregateKey;
  sequence: number;
  eventType: string;
  occurredAt: number;
  payload: Record<string, unknown>;
  now: number;
}

export async function insertWebhookDelivery(
  queryable: Queryable,
  input: InsertWebhookDeliveryInput,
): Promise<WebhookDeliveryRow> {
  const inserted = await queryable.query<WebhookDeliveryRow>(
    `INSERT INTO teaching_package_webhook_deliveries
       (id, tenant_id, learning_item_type, learning_item_id, sequence,
        event_type, occurred_at, payload, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', 0, $7)
     RETURNING ${WEBHOOK_COLUMNS}`,
    [
      input.id,
      input.aggregate.tenantId,
      input.aggregate.learningItem.type,
      input.aggregate.learningItem.id,
      input.sequence,
      input.eventType,
      input.occurredAt,
      JSON.stringify(input.payload),
    ],
  );
  return inserted.rows[0]!;
}

/** Highest allocated sequence for the aggregate (0 when none). */
export async function readLatestWebhookSequence(
  queryable: Queryable,
  aggregate: TeachingPackageAggregateKey,
): Promise<number> {
  const result = await queryable.query<{ latest: number | string | null }>(
    `SELECT MAX(sequence) AS latest
       FROM teaching_package_webhook_deliveries
      WHERE tenant_id = $1 AND learning_item_type = $2 AND learning_item_id = $3`,
    itemValues(aggregate),
  );
  return Number(result.rows[0]?.latest ?? 0);
}

/**
 * Claim due rows under a lease. Ordering per aggregate is preserved by the
 * NOT EXISTS guard: an event is claimable only when no older pending row for
 * the same aggregate exists, so later events can never overtake older ones.
 */
export async function claimPendingWebhookDeliveries(
  queryable: Queryable,
  options: { workerId: string; batch: number; leaseUntil: number; now: number },
): Promise<WebhookDeliveryRow[]> {
  const claimed = await queryable.query<WebhookDeliveryRow>(
    `UPDATE teaching_package_webhook_deliveries AS d
        SET claimed_by = $1, claimed_until = $2
      WHERE d.id IN (
        SELECT candidate.id
          FROM teaching_package_webhook_deliveries AS candidate
         WHERE candidate.status = 'pending'
           AND candidate.next_attempt_at <= $3
           AND (candidate.claimed_until IS NULL OR candidate.claimed_until < $3)
           AND NOT EXISTS (
             SELECT 1
               FROM teaching_package_webhook_deliveries AS older
              WHERE older.tenant_id = candidate.tenant_id
                AND older.learning_item_type = candidate.learning_item_type
                AND older.learning_item_id = candidate.learning_item_id
                AND older.sequence < candidate.sequence
                AND older.status = 'pending'
           )
         ORDER BY candidate.tenant_id, candidate.learning_item_type, candidate.learning_item_id, candidate.sequence
         LIMIT $4
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${WEBHOOK_COLUMNS}`,
    [options.workerId, options.leaseUntil, options.now, options.batch],
  );
  return claimed.rows;
}

export async function markWebhookDelivered(
  queryable: Queryable,
  id: string,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_webhook_deliveries
        SET status = 'delivered',
            attempts = attempts + 1,
            last_attempt_at = $2,
            delivered_at = $2,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE id = $1`,
    [id, now],
  );
}

export async function markWebhookRetry(
  queryable: Queryable,
  id: string,
  options: {
    nextAttemptAt: number;
    lastStatus: number | null;
    lastError: string | null;
    now: number;
  },
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_webhook_deliveries
        SET attempts = attempts + 1,
            next_attempt_at = $2,
            last_status = $3,
            last_error = $4,
            last_attempt_at = $5,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE id = $1`,
    [id, options.nextAttemptAt, options.lastStatus, options.lastError, options.now],
  );
}

export async function markWebhookTerminalFailed(
  queryable: Queryable,
  id: string,
  options: { lastStatus: number | null; lastError: string | null; now: number },
): Promise<void> {
  await queryable.query(
    `UPDATE teaching_package_webhook_deliveries
        SET status = 'terminal_failed',
            attempts = attempts + 1,
            last_status = $2,
            last_error = $3,
            last_attempt_at = $4,
            terminal_failed_at = $4,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE id = $1`,
    [id, options.lastStatus, options.lastError, options.now],
  );
}

/**
 * Grant tenant validation (plan §4.4.5): the Stage must belong to the grant's
 * tenant through either a version's `current_stage_id` or an attempt row
 * retaining the Stage under that tenant.
 */
export async function stageBelongsToTenant(
  queryable: Queryable,
  stageId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await queryable.query<{ ok: boolean }>(
    `SELECT (
       EXISTS(
         SELECT 1 FROM teaching_package_versions
          WHERE tenant_id = $2 AND current_stage_id = $1
       ) OR EXISTS(
         SELECT 1 FROM teaching_package_generation_attempts
          WHERE tenant_id = $2 AND stage_id = $1 AND stage_released_at IS NULL
       )
     ) AS ok`,
    [stageId, tenantId],
  );
  return result.rows[0]?.ok === true;
}

// ---------------------------------------------------------------------------
// Durable lesson source context (Kafuo question-flow closure, B1.2)
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE_CONTEXT_MAX_CHARS = 400_000;

export function sourceContextMaxChars(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_SOURCE_CONTEXT_MAX_CHARS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_SOURCE_CONTEXT_MAX_CHARS;
}

export interface SourceContextInput {
  tenantId: string;
  attemptId: string;
  contentResourceId: string;
  measuredSha256: string;
  text: string;
  sourceKind?: 'pdf_fallback' | 'kafuo_normalized';
  normalizedPackageId?: string;
  normalizedSchemaVersion?: string;
  contentRevisionId?: string;
  parseRunId?: string;
  structureProfile?: { id: string; versionId: string };
}

/** Idempotent per attempt: a re-run of Layer A for the same attempt keeps one row. */
export async function upsertSourceContext(
  queryable: Queryable,
  input: SourceContextInput,
): Promise<void> {
  const max = sourceContextMaxChars();
  const truncated = input.text.length > max;
  const text = truncated ? input.text.slice(0, max) : input.text;
  await queryable.query(
    `INSERT INTO teaching_package_source_contexts
       (attempt_id, tenant_id, content_resource_id, measured_sha256, text,
        text_length, truncated, created_at, source_kind, normalized_package_id,
        normalized_schema_version, content_revision_id, parse_run_id,
        structure_profile_id, structure_profile_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (attempt_id) DO UPDATE SET
       content_resource_id = EXCLUDED.content_resource_id,
       measured_sha256 = EXCLUDED.measured_sha256,
       text = EXCLUDED.text,
       text_length = EXCLUDED.text_length,
       truncated = EXCLUDED.truncated
       , source_kind = EXCLUDED.source_kind
       , normalized_package_id = EXCLUDED.normalized_package_id
       , normalized_schema_version = EXCLUDED.normalized_schema_version
       , content_revision_id = EXCLUDED.content_revision_id
       , parse_run_id = EXCLUDED.parse_run_id
       , structure_profile_id = EXCLUDED.structure_profile_id
       , structure_profile_version_id = EXCLUDED.structure_profile_version_id
     WHERE teaching_package_source_contexts.tenant_id = EXCLUDED.tenant_id`,
    [
      input.attemptId,
      input.tenantId,
      input.contentResourceId,
      input.measuredSha256,
      text,
      input.text.length,
      truncated,
      Date.now(),
      input.sourceKind ?? 'pdf_fallback',
      input.normalizedPackageId ?? null,
      input.normalizedSchemaVersion ?? null,
      input.contentRevisionId ?? null,
      input.parseRunId ?? null,
      input.structureProfile?.id ?? null,
      input.structureProfile?.versionId ?? null,
    ],
  );
}

export interface RetainedVersionContext {
  /** The generated attempt whose context the version's current Stage descends from. */
  attemptId: string;
  inputSnapshot: GenerationInputSnapshot;
  sourceText: string | null;
  sourceTruncated: boolean;
}

/**
 * The retained generation context for a version: its `current_attempt_id`, or —
 * for a successor clone that has no attempt of its own — the nearest
 * predecessor's generated attempt (the `readFlowForVersion` walk, tenant-scoped
 * at every hop). `sourceText` is `null` when the attempt predates source-context
 * retention.
 */
export async function readRetainedVersionContext(
  queryable: Queryable,
  versionId: string,
  scope: { tenantId: string },
): Promise<RetainedVersionContext | null> {
  const visited = new Set<string>();
  let currentId: string | null = versionId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const versionResult: { rows: Array<Record<string, unknown>> } = await queryable.query(
      `SELECT current_attempt_id, predecessor_version_id
         FROM teaching_package_versions
        WHERE id = $1 AND ${TENANT_SCOPE_PARAM}`,
      [currentId, scope.tenantId],
    );
    const row = versionResult.rows[0] as
      | { current_attempt_id: string | null; predecessor_version_id: string | null }
      | undefined;
    if (!row) return null;
    if (row.current_attempt_id) {
      const attempt = await queryable.query<Record<string, unknown>>(
        `SELECT a.id, a.input_snapshot, c.text AS source_text, c.truncated AS source_truncated
           FROM teaching_package_generation_attempts a
           LEFT JOIN teaching_package_source_contexts c
             ON c.attempt_id = a.id AND c.tenant_id = a.tenant_id
          WHERE a.id = $1 AND a.tenant_id = $2`,
        [row.current_attempt_id, scope.tenantId],
      );
      const hit = attempt.rows[0];
      if (!hit) return null;
      return {
        attemptId: String(hit.id),
        inputSnapshot: hit.input_snapshot as GenerationInputSnapshot,
        sourceText: typeof hit.source_text === 'string' ? hit.source_text : null,
        sourceTruncated: hit.source_truncated === true,
      };
    }
    currentId = row.predecessor_version_id;
  }
  return null;
}
