/**
 * The AI reviewer's provider switch (ai-reviewer-layer plan D-3, §4.5, O-2).
 *
 *  - Opus answers `provider_credit_exhausted` → the executor already served
 *    the call from Sol; this module writes the global switch row so every
 *    later review goes straight to Sol, and emits ONE signed
 *    `teaching_engine.reviewer_provider_switched` through the outbox (the
 *    Backend emails the owner). The row write is conditional, so concurrent
 *    reviews that all hit the exhausted credit emit a single event.
 *  - O-2 default: once `next_probe_at` passes, ONE review claims the probe
 *    (a conditional UPDATE that also pushes `next_probe_at` 24 h on) and runs
 *    Opus primary / Sol fallback. Opus answering switches back and emits the
 *    event again; anything else leaves the reviewer on Sol for another 24 h.
 *
 * Epoch milliseconds, like the other TE teaching-package tables.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  REVIEWER_PROBE_INTERVAL_MS,
  type ReviewerProvider,
} from '@/lib/server/teaching-model/reviewer-policy';

const STATE_ID = 'reviewer';

export interface ReviewerProviderState {
  activeProvider: ReviewerProvider;
  switchedAt: number | null;
  reason: string | null;
  nextProbeAt: number | null;
}

export const DEFAULT_REVIEWER_PROVIDER_STATE: ReviewerProviderState = Object.freeze({
  activeProvider: 'anthropic',
  switchedAt: null,
  reason: null,
  nextProbeAt: null,
});

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToState(row: Record<string, unknown>): ReviewerProviderState {
  return {
    activeProvider: row.active_provider === 'openai' ? 'openai' : 'anthropic',
    switchedAt: num(row.switched_at),
    reason: typeof row.reason === 'string' ? row.reason : null,
    nextProbeAt: num(row.next_probe_at),
  };
}

export async function readReviewerProviderState(
  queryable: Queryable,
): Promise<ReviewerProviderState> {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT active_provider, switched_at, reason, next_probe_at
       FROM reviewer_provider_state WHERE id = $1`,
    [STATE_ID],
  );
  const row = result.rows[0];
  return row ? rowToState(row) : { ...DEFAULT_REVIEWER_PROVIDER_STATE };
}

export interface ReviewerRouteChoice {
  mode: 'opus' | 'sol';
  /** This call is the O-2 probe: an Opus answer switches the reviewer back. */
  probe: boolean;
}

/**
 * Which route the next reviewer call takes. On Sol with the probe due, the
 * probe is claimed atomically: only the caller whose UPDATE matched probes.
 */
export async function chooseReviewerRoute(
  queryable: Queryable,
  now: number,
): Promise<ReviewerRouteChoice> {
  const state = await readReviewerProviderState(queryable);
  if (state.activeProvider === 'anthropic') return { mode: 'opus', probe: false };
  if (state.nextProbeAt !== null && state.nextProbeAt > now) return { mode: 'sol', probe: false };
  const claimed = await queryable.query(
    `UPDATE reviewer_provider_state
        SET next_probe_at = $2, updated_at = $3
      WHERE id = $1 AND active_provider = 'openai'
        AND (next_probe_at IS NULL OR next_probe_at <= $3)
      RETURNING id`,
    [STATE_ID, now + REVIEWER_PROBE_INTERVAL_MS, now],
  );
  return claimed.rows.length > 0 ? { mode: 'opus', probe: true } : { mode: 'sol', probe: false };
}

/**
 * Switch to Sol. Returns the new state when THIS call switched, `null` when
 * the reviewer was already on Sol (no second event).
 */
export async function recordSwitchToSol(
  tx: Queryable,
  input: { now: number; reason: string },
): Promise<ReviewerProviderState | null> {
  const result = await tx.query<Record<string, unknown>>(
    `INSERT INTO reviewer_provider_state
       (id, active_provider, switched_at, reason, next_probe_at, updated_at)
     VALUES ($1, 'openai', $2, $3, $4, $2)
     ON CONFLICT (id) DO UPDATE SET
       active_provider = 'openai', switched_at = $2, reason = $3, next_probe_at = $4, updated_at = $2
     WHERE reviewer_provider_state.active_provider <> 'openai'
     RETURNING active_provider, switched_at, reason, next_probe_at`,
    [STATE_ID, input.now, input.reason, input.now + REVIEWER_PROBE_INTERVAL_MS],
  );
  const row = result.rows[0];
  return row ? rowToState(row) : null;
}

/** The O-2 probe answered on Opus: back to the normal route. */
export async function recordSwitchBackToOpus(
  tx: Queryable,
  input: { now: number },
): Promise<ReviewerProviderState | null> {
  const result = await tx.query<Record<string, unknown>>(
    `UPDATE reviewer_provider_state
        SET active_provider = 'anthropic', switched_at = $2, reason = 'probe_succeeded',
            next_probe_at = NULL, updated_at = $2
      WHERE id = $1 AND active_provider = 'openai'
      RETURNING active_provider, switched_at, reason, next_probe_at`,
    [STATE_ID, input.now],
  );
  const row = result.rows[0];
  return row ? rowToState(row) : null;
}
