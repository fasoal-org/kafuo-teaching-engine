/**
 * Idempotent results of Backend-originated legacy Help model turns (Kafuo R1
 * plan §5.1 `legacy_help_turns`, §8.8; contracts §3.4).
 *
 * One row per Backend `turnId`. A retry with the same `turnId` and
 * `requestDigest` replays the stored result without a new model attempt; a
 * different digest is `TURN_DIGEST_CONFLICT`; a `generating` row younger
 * than the route deadline is `TURN_IN_PROGRESS`. Rows are accounting-neutral
 * (the ledger keeps the attempts) and are deleted after 7 days by the
 * retention sweep registered with the accounting sweeper.
 *
 * Same conventions as the other Kafuo tables: idempotent DDL at boot, raw
 * helpers over a `Queryable`, epoch-second timestamps.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

export const LEGACY_HELP_TURN_RETENTION_S = 7 * 24 * 60 * 60;

const LEGACY_HELP_TURN_TABLES = `
CREATE TABLE IF NOT EXISTS legacy_help_turns (
  turn_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  student_ref TEXT NOT NULL,
  origin_conversation_ref TEXT,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating','completed','failed')),
  text TEXT,
  served_by TEXT CHECK (served_by IN ('primary','fallback')),
  safety JSONB,
  grounding_mode TEXT CHECK (grounding_mode IN ('scene','insufficient')),
  error_code TEXT,
  attempt_ids JSONB,
  budget JSONB,
  generating_at DOUBLE PRECISION NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  completed_at DOUBLE PRECISION
);
`;

const LEGACY_HELP_TURN_INDEXES = `
CREATE INDEX IF NOT EXISTS lht_created_at_idx ON legacy_help_turns (created_at);
`;

export const LEGACY_HELP_TURNS_SCHEMA = `${LEGACY_HELP_TURN_TABLES}
${LEGACY_HELP_TURN_INDEXES}`;

/** Idempotent; standalone (no FKs). */
export async function ensureLegacyHelpTurnsSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(LEGACY_HELP_TURN_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(LEGACY_HELP_TURN_INDEXES)) {
    await queryable.query(statement);
  }
}

export type LegacyHelpTurnStatus = 'generating' | 'completed' | 'failed';

export interface LegacyHelpTurnRow {
  turnId: string;
  tenantId: string;
  studentRef: string;
  originConversationRef: string | null;
  requestDigest: string;
  status: LegacyHelpTurnStatus;
  text: string | null;
  servedBy: 'primary' | 'fallback' | null;
  safety: Record<string, unknown> | null;
  groundingMode: 'scene' | 'insufficient' | null;
  errorCode: string | null;
  attemptIds: string[];
  budget: { estimate: number; counterKind: 'exact' | 'proxy' } | null;
  generatingAt: number;
  createdAt: number;
  completedAt: number | null;
}

interface RawRow extends Record<string, unknown> {
  turn_id: string;
  tenant_id: string;
  student_ref: string;
  origin_conversation_ref: string | null;
  request_digest: string;
  status: LegacyHelpTurnStatus;
  text: string | null;
  served_by: 'primary' | 'fallback' | null;
  safety: unknown;
  grounding_mode: 'scene' | 'insufficient' | null;
  error_code: string | null;
  attempt_ids: unknown;
  budget: unknown;
  generating_at: number;
  created_at: number;
  completed_at: number | null;
}

const COLUMNS = `turn_id, tenant_id, student_ref, origin_conversation_ref, request_digest, status, text,
  served_by, safety, grounding_mode, error_code, attempt_ids, budget, generating_at, created_at, completed_at`;

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function mapRow(row: RawRow): LegacyHelpTurnRow {
  return {
    turnId: row.turn_id,
    tenantId: row.tenant_id,
    studentRef: row.student_ref,
    originConversationRef: row.origin_conversation_ref,
    requestDigest: row.request_digest,
    status: row.status,
    text: row.text,
    servedBy: row.served_by,
    safety: json<Record<string, unknown>>(row.safety),
    groundingMode: row.grounding_mode,
    errorCode: row.error_code,
    attemptIds: json<string[]>(row.attempt_ids) ?? [],
    budget: json<{ estimate: number; counterKind: 'exact' | 'proxy' }>(row.budget),
    generatingAt: Number(row.generating_at),
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

export interface BeginLegacyHelpTurnInput {
  turnId: string;
  tenantId: string;
  studentRef: string;
  originConversationRef: string | null;
  requestDigest: string;
  /** Epoch seconds. */
  now: number;
}

/**
 * Insert the `generating` row. `inserted: false` returns the EXISTING row so
 * the service can replay / refuse per contracts §3.4.
 */
export async function beginLegacyHelpTurn(
  queryable: Queryable,
  input: BeginLegacyHelpTurnInput,
): Promise<{ inserted: boolean; row: LegacyHelpTurnRow }> {
  const result = await queryable.query<RawRow>(
    `INSERT INTO legacy_help_turns (
       turn_id, tenant_id, student_ref, origin_conversation_ref, request_digest, status,
       attempt_ids, generating_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'generating', '[]'::jsonb, $6, $6)
     ON CONFLICT (turn_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.turnId, input.tenantId, input.studentRef, input.originConversationRef, input.requestDigest, input.now],
  );
  if (result.rows[0]) return { inserted: true, row: mapRow(result.rows[0]) };
  const existing = await readLegacyHelpTurn(queryable, input.turnId);
  if (!existing) throw new Error('legacy help turn vanished after an idempotent insert');
  return { inserted: false, row: existing };
}

/**
 * Re-open a `failed` row, or a `generating` row older than `staleBefore`
 * (its instance is gone), as `generating`. `null` when the guard did not
 * match (someone else re-opened it first).
 */
export async function retakeLegacyHelpTurn(
  queryable: Queryable,
  turnId: string,
  options: { now: number; staleBefore: number },
): Promise<LegacyHelpTurnRow | null> {
  const result = await queryable.query<RawRow>(
    `UPDATE legacy_help_turns
        SET status = 'generating', generating_at = $2, error_code = NULL
      WHERE turn_id = $1
        AND (status = 'failed' OR (status = 'generating' AND generating_at < $3))
      RETURNING ${COLUMNS}`,
    [turnId, options.now, options.staleBefore],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export interface CompleteLegacyHelpTurnInput {
  text: string;
  servedBy: 'primary' | 'fallback';
  safety: Record<string, unknown> | null;
  groundingMode: 'scene' | 'insufficient';
  attemptIds: string[];
  budget: { estimate: number; counterKind: 'exact' | 'proxy' };
  /** Epoch seconds. */
  now: number;
}

export async function completeLegacyHelpTurn(
  queryable: Queryable,
  turnId: string,
  input: CompleteLegacyHelpTurnInput,
): Promise<LegacyHelpTurnRow | null> {
  const result = await queryable.query<RawRow>(
    `UPDATE legacy_help_turns
        SET status = 'completed', text = $2, served_by = $3, safety = $4::jsonb, grounding_mode = $5,
            attempt_ids = $6::jsonb, budget = $7::jsonb, error_code = NULL, completed_at = $8
      WHERE turn_id = $1 AND status = 'generating'
      RETURNING ${COLUMNS}`,
    [
      turnId,
      input.text,
      input.servedBy,
      input.safety === null ? null : JSON.stringify(input.safety),
      input.groundingMode,
      JSON.stringify(input.attemptIds),
      JSON.stringify(input.budget),
      input.now,
    ],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function failLegacyHelpTurn(
  queryable: Queryable,
  turnId: string,
  input: { errorCode: string; attemptIds?: string[]; now: number },
): Promise<LegacyHelpTurnRow | null> {
  const result = await queryable.query<RawRow>(
    `UPDATE legacy_help_turns
        SET status = 'failed', error_code = $2, attempt_ids = $3::jsonb, completed_at = $4
      WHERE turn_id = $1 AND status = 'generating'
      RETURNING ${COLUMNS}`,
    [turnId, input.errorCode, JSON.stringify(input.attemptIds ?? []), input.now],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function readLegacyHelpTurn(
  queryable: Queryable,
  turnId: string,
): Promise<LegacyHelpTurnRow | null> {
  const result = await queryable.query<RawRow>(
    `SELECT ${COLUMNS} FROM legacy_help_turns WHERE turn_id = $1`,
    [turnId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Retention (plan §5.1): rows older than 7 days are dropped, whatever their status. */
export async function deleteExpiredLegacyHelpTurns(
  queryable: Queryable,
  now: number,
  retentionS: number = LEGACY_HELP_TURN_RETENTION_S,
): Promise<number> {
  const result = await queryable.query<{ turn_id: string }>(
    `DELETE FROM legacy_help_turns WHERE created_at < $1 RETURNING turn_id`,
    [now - retentionS],
  );
  return result.rows.length;
}
