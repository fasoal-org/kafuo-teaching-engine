/**
 * Meter finalize outbox (Kafuo R1 plan §5.1, §8.6; contracts §2.3).
 *
 * One row per Kafuo reservation (`reservation_id` PRIMARY KEY), inserted in
 * the SAME transaction that completes the turn, so a finalize can never be
 * lost once the turn outcome is committed — and never exist without it. The
 * instance that completed the turn delivers inline right after commit; any
 * row still `pending` is claimed under a lease by whichever instance's
 * sweeper runs next (`FOR UPDATE SKIP LOCKED`), so replaced instances lose
 * nothing and two live instances never deliver one row at the same time.
 *
 * No cross-row ordering: one reservation per `(turnId, turnAttempt)`, so
 * unlike the webhook outbox there is no "older pending row" guard.
 *
 * Terminal states: `delivered` (Kafuo `204`), `conflict` (`409`
 * `finalize_conflict` — Kafuo already closed the reservation differently;
 * never retried, reported), `terminal_failed` (unreachable past the stale
 * window, or an unknown reservation). Retention deletes `delivered` and
 * `conflict` rows 7 days after they became final and `terminal_failed` rows
 * after 30 days (they appear in the reconciliation report until then).
 *
 * Timestamps are DOUBLE PRECISION epoch SECONDS (contracts §1) — this table
 * follows the ledger, not the millisecond webhook table.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

export type FinalizeOutcome = 'delivered' | 'not_delivered';
export type FinalizeReason =
  | 'model_unavailable'
  | 'safety_boundary'
  | 'aborted'
  | 'budget_refused'
  | 'internal_error';
export type FinalizeStatus = 'pending' | 'delivered' | 'conflict' | 'terminal_failed';

/** Backoff: `5 s × 2^(attempts−1)`, capped at 5 min (plan §8.6). */
export const FINALIZE_BACKOFF_BASE_S = 5;
export const FINALIZE_BACKOFF_MAX_S = 5 * 60;
export const FINALIZE_RETENTION_DELIVERED_S = 7 * 24 * 60 * 60;
export const FINALIZE_RETENTION_TERMINAL_FAILED_S = 30 * 24 * 60 * 60;

const METER_FINALIZE_OUTBOX_TABLES = `
CREATE TABLE IF NOT EXISTS meter_finalize_outbox (
  reservation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  turn_id TEXT NOT NULL,
  turn_attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered','not_delivered')),
  reason TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','conflict','terminal_failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at DOUBLE PRECISION NOT NULL,
  claimed_by TEXT,
  claimed_until DOUBLE PRECISION,
  last_status INTEGER,
  last_error TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  delivered_at DOUBLE PRECISION,
  terminal_failed_at DOUBLE PRECISION
);
`;

const METER_FINALIZE_OUTBOX_INDEXES = `
CREATE INDEX IF NOT EXISTS mfo_status_next_attempt_idx
  ON meter_finalize_outbox (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS mfo_delivered_at_idx
  ON meter_finalize_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;
`;

export const METER_FINALIZE_OUTBOX_SCHEMA = `${METER_FINALIZE_OUTBOX_TABLES}
${METER_FINALIZE_OUTBOX_INDEXES}`;

/** Idempotent; safe at every boot and twice in a row. Standalone (no FKs). */
export async function ensureMeterFinalizeOutboxSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(METER_FINALIZE_OUTBOX_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(METER_FINALIZE_OUTBOX_INDEXES)) {
    await queryable.query(statement);
  }
}

/** The exact `POST /meters/finalize` body (contracts §2.3), signed at send time. */
export interface FinalizePayload {
  reservationId: string;
  outcome: FinalizeOutcome;
  reason: FinalizeReason | null;
  turnId: string;
}

export interface MeterFinalizeOutboxRow extends Record<string, unknown> {
  reservation_id: string;
  tenant_id: string;
  turn_id: string;
  turn_attempt: number;
  outcome: FinalizeOutcome;
  reason: FinalizeReason | null;
  payload: FinalizePayload;
  status: FinalizeStatus;
  attempts: number;
  next_attempt_at: number;
  claimed_by: string | null;
  claimed_until: number | null;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  terminal_failed_at: number | null;
}

const OUTBOX_COLUMNS = `reservation_id, tenant_id, turn_id, turn_attempt, outcome, reason, payload, status,
  attempts, next_attempt_at, claimed_by, claimed_until, last_status, last_error, created_at,
  delivered_at, terminal_failed_at`;

function normalizeRow(row: MeterFinalizeOutboxRow): MeterFinalizeOutboxRow {
  // `pg` hands JSONB back parsed; PGlite too. A string would be a driver
  // configured otherwise — parse rather than trust.
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return { ...row, payload: payload as FinalizePayload, attempts: Number(row.attempts) };
}

export interface EnqueueFinalizeInput {
  reservationId: string;
  tenantId: string;
  turnId: string;
  turnAttempt: number;
  outcome: FinalizeOutcome;
  reason?: FinalizeReason | null;
  /** Epoch seconds. */
  now: number;
}

/**
 * Insert the finalize row. Designed to run on the caller's transaction
 * `Queryable` — the turn completion transaction (§8.6 "Enqueue"). Due
 * immediately (`next_attempt_at = now`) so a sweeper on another instance can
 * pick it up should the inline delivery never happen. `false` when a row for
 * the reservation already exists (a replayed completion), which is the one
 * legitimate duplicate: nothing is overwritten.
 */
export async function enqueueFinalize(
  queryable: Queryable,
  input: EnqueueFinalizeInput,
): Promise<boolean> {
  const payload: FinalizePayload = {
    reservationId: input.reservationId,
    outcome: input.outcome,
    reason: input.reason ?? null,
    turnId: input.turnId,
  };
  const result = await queryable.query<{ reservation_id: string }>(
    `INSERT INTO meter_finalize_outbox (
       reservation_id, tenant_id, turn_id, turn_attempt, outcome, reason, payload, status,
       attempts, next_attempt_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', 0, $8, $8)
     ON CONFLICT (reservation_id) DO NOTHING
     RETURNING reservation_id`,
    [
      input.reservationId,
      input.tenantId,
      input.turnId,
      input.turnAttempt,
      input.outcome,
      input.reason ?? null,
      JSON.stringify(payload),
      input.now,
    ],
  );
  return result.rows.length === 1;
}

export interface ClaimOptions {
  workerId: string;
  batch: number;
  /** Epoch seconds the lease lasts until. */
  leaseUntil: number;
  /** Epoch seconds. */
  now: number;
}

/**
 * Claim due `pending` rows under a lease (§8.6 "Replay ownership"). A row is
 * due when `next_attempt_at <= now` and not held by a live lease. `FOR UPDATE
 * SKIP LOCKED` lets two live sweepers split a backlog without ever claiming
 * the same row; an expired lease is claimable again (the previous holder
 * died mid-delivery, or is about to find its update a no-op).
 */
export async function claimDueFinalizes(
  queryable: Queryable,
  options: ClaimOptions,
): Promise<MeterFinalizeOutboxRow[]> {
  const claimed = await queryable.query<MeterFinalizeOutboxRow>(
    `UPDATE meter_finalize_outbox AS o
        SET claimed_by = $1, claimed_until = $2
      WHERE o.reservation_id IN (
        SELECT candidate.reservation_id
          FROM meter_finalize_outbox AS candidate
         WHERE candidate.status = 'pending'
           AND candidate.next_attempt_at <= $3
           AND (candidate.claimed_until IS NULL OR candidate.claimed_until < $3)
         ORDER BY candidate.next_attempt_at, candidate.reservation_id
         LIMIT $4
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OUTBOX_COLUMNS}`,
    [options.workerId, options.leaseUntil, options.now, options.batch],
  );
  return claimed.rows.map(normalizeRow);
}

/**
 * Claim ONE specific pending row (the inline post-commit delivery, §8.6
 * "Enqueue"). `null` when it is not pending or a live lease holds it — the
 * sweeper (possibly on another instance) owns it then, and the caller simply
 * does not deliver.
 */
export async function claimFinalizeById(
  queryable: Queryable,
  reservationId: string,
  options: Omit<ClaimOptions, 'batch'>,
): Promise<MeterFinalizeOutboxRow | null> {
  const claimed = await queryable.query<MeterFinalizeOutboxRow>(
    `UPDATE meter_finalize_outbox AS o
        SET claimed_by = $1, claimed_until = $2
      WHERE o.reservation_id IN (
        SELECT candidate.reservation_id
          FROM meter_finalize_outbox AS candidate
         WHERE candidate.reservation_id = $4
           AND candidate.status = 'pending'
           AND (candidate.claimed_until IS NULL OR candidate.claimed_until < $3)
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${OUTBOX_COLUMNS}`,
    [options.workerId, options.leaseUntil, options.now, reservationId],
  );
  return claimed.rows[0] ? normalizeRow(claimed.rows[0]) : null;
}

/** Kafuo answered `204` (also for an identical repeat). Idempotent. */
export async function markFinalizeDelivered(
  queryable: Queryable,
  reservationId: string,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE meter_finalize_outbox
        SET status = 'delivered',
            attempts = attempts + 1,
            last_status = 204,
            last_error = NULL,
            delivered_at = $2,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE reservation_id = $1 AND status = 'pending'`,
    [reservationId, now],
  );
}

export interface RetryOptions {
  /** Epoch seconds. */
  now: number;
  lastStatus: number | null;
  lastError: string | null;
}

/**
 * Kafuo unreachable / 5xx / timeout: stay `pending`, back off
 * `5 s × 2^(attempts−1)` (attempts counted AFTER this one) capped at 5 min,
 * release the lease so any sweeper may retry. Returns the new `next_attempt_at`.
 */
export async function markFinalizeRetry(
  queryable: Queryable,
  reservationId: string,
  options: RetryOptions,
): Promise<number | null> {
  const result = await queryable.query<{ next_attempt_at: number }>(
    `UPDATE meter_finalize_outbox
        SET attempts = attempts + 1,
            next_attempt_at = $2 + LEAST($5::double precision, $4::double precision * power(2::double precision, attempts::double precision)),
            last_status = $3,
            last_error = $6,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE reservation_id = $1 AND status = 'pending'
      RETURNING next_attempt_at`,
    [
      reservationId,
      options.now,
      options.lastStatus,
      FINALIZE_BACKOFF_BASE_S,
      FINALIZE_BACKOFF_MAX_S,
      options.lastError,
    ],
  );
  return result.rows[0] ? Number(result.rows[0].next_attempt_at) : null;
}

/** Kafuo answered `409 finalize_conflict`: final, never retried (§8.6). */
export async function markFinalizeConflict(
  queryable: Queryable,
  reservationId: string,
  options: { now: number; lastError?: string | null },
): Promise<void> {
  await queryable.query(
    `UPDATE meter_finalize_outbox
        SET status = 'conflict',
            attempts = attempts + 1,
            last_status = 409,
            last_error = $3,
            terminal_failed_at = $2,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE reservation_id = $1 AND status = 'pending'`,
    [reservationId, options.now, options.lastError ?? 'finalize_conflict'],
  );
}

/** Past the stale window (or an unknown reservation): final, listed in the report. */
export async function markFinalizeTerminalFailed(
  queryable: Queryable,
  reservationId: string,
  options: RetryOptions,
): Promise<void> {
  await queryable.query(
    `UPDATE meter_finalize_outbox
        SET status = 'terminal_failed',
            attempts = attempts + 1,
            last_status = $3,
            last_error = $4,
            terminal_failed_at = $2,
            claimed_by = NULL,
            claimed_until = NULL
      WHERE reservation_id = $1 AND status = 'pending'`,
    [reservationId, options.now, options.lastStatus, options.lastError],
  );
}

/**
 * SIGTERM: drop this worker's leases so a successor picks the rows up
 * immediately instead of after the 60 s lease (plan §9.4 item 4). Returns
 * the number released.
 */
export async function releaseLeases(queryable: Queryable, workerId: string): Promise<number> {
  const result = await queryable.query<{ reservation_id: string }>(
    `UPDATE meter_finalize_outbox
        SET claimed_by = NULL, claimed_until = NULL
      WHERE claimed_by = $1 AND status = 'pending'
      RETURNING reservation_id`,
    [workerId],
  );
  return result.rows.length;
}

/** Retention (§8.6): 7 days for delivered/conflict, 30 days for terminal_failed. */
export async function deleteExpiredFinalizes(
  queryable: Queryable,
  now: number,
): Promise<{ deleted: number }> {
  const result = await queryable.query<{ reservation_id: string }>(
    `DELETE FROM meter_finalize_outbox
      WHERE (status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < $1)
         OR (status = 'conflict' AND terminal_failed_at IS NOT NULL AND terminal_failed_at < $1)
         OR (status = 'terminal_failed' AND terminal_failed_at IS NOT NULL AND terminal_failed_at < $2)
      RETURNING reservation_id`,
    [now - FINALIZE_RETENTION_DELIVERED_S, now - FINALIZE_RETENTION_TERMINAL_FAILED_S],
  );
  return { deleted: result.rows.length };
}

export interface MeterOutboxStatus {
  pendingFinalizes: number;
  /** Age in seconds of the oldest `pending` row; `null` when none. */
  oldestPendingFinalizeAgeS: number | null;
  conflictFinalizes: number;
  terminalFailedFinalizes: number;
}

/** Health / report block (plan §9.1). */
export async function readOutboxStatus(queryable: Queryable, now: number): Promise<MeterOutboxStatus> {
  const result = await queryable.query<{
    pending: number | string;
    oldest_created_at: number | string | null;
    conflict: number | string;
    terminal_failed: number | string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::int AS pending,
       min(created_at) FILTER (WHERE status = 'pending') AS oldest_created_at,
       count(*) FILTER (WHERE status = 'conflict')::int AS conflict,
       count(*) FILTER (WHERE status = 'terminal_failed')::int AS terminal_failed
     FROM meter_finalize_outbox`,
  );
  const row = result.rows[0];
  const oldest = row?.oldest_created_at;
  return {
    pendingFinalizes: Number(row?.pending ?? 0),
    oldestPendingFinalizeAgeS:
      oldest === null || oldest === undefined ? null : Math.max(0, Math.round(now - Number(oldest))),
    conflictFinalizes: Number(row?.conflict ?? 0),
    terminalFailedFinalizes: Number(row?.terminal_failed ?? 0),
  };
}

export async function readFinalize(
  queryable: Queryable,
  reservationId: string,
): Promise<MeterFinalizeOutboxRow | null> {
  const result = await queryable.query<MeterFinalizeOutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM meter_finalize_outbox WHERE reservation_id = $1`,
    [reservationId],
  );
  return result.rows[0] ? normalizeRow(result.rows[0]) : null;
}

/** Report helper: every non-delivered final row (conflict / terminal_failed), oldest first. */
export async function listUnresolvedFinalizes(
  queryable: Queryable,
  limit = 500,
): Promise<MeterFinalizeOutboxRow[]> {
  const result = await queryable.query<MeterFinalizeOutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM meter_finalize_outbox
      WHERE status IN ('conflict', 'terminal_failed')
      ORDER BY terminal_failed_at NULLS FIRST, reservation_id
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(normalizeRow);
}
