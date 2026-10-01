/**
 * Free Chat grounding configuration (discovery-first plan P6/P7). Inline env
 * readers in the `lessonMatchThreshold` style: read on every call, never
 * memoized, so a rollback flip takes effect on the next turn.
 *
 *  - `TUTOR_GROUNDING_SOURCE`   kafuo_http (default) | shadow | direct
 *  - `TUTOR_GROUNDING_DIRECT_TENANTS`  comma list of tenant ids allowed on
 *    `direct`; `*` = all; unset/empty = none. `direct` is never effective for a
 *    tenant outside it, nor while no reader is wired (P6), so a student is
 *    served by `kafuo_http` unless BOTH are configured.
 *  - `TUTOR_ASSESSMENT_RULESET` r1 | discovery_v1. Unset → `discovery_v1` when
 *    the turn's effective source is `direct`, `r1` otherwise (so the default
 *    `kafuo_http` path sends today's exact `grounding/search` query).
 *  - `TUTOR_GROUNDING_AMBIGUOUS_SEARCH_MIN_SCORE` an `ambiguous` resolution is
 *    searched (≤ 3 items) only when EVERY candidate scores at least this;
 *    otherwise the student is asked to choose. Unset → always clarify. The
 *    number depends on D-7 (uncalibrated until P10).
 *  - `TUTOR_GROUNDING_EVIDENCE_FLOOR` minimum unit similarity (τ, D-7);
 *    default 0 (only an empty search is `below_evidence_floor`).
 */

export type GroundingSource = 'kafuo_http' | 'shadow' | 'direct';
export type AssessmentRuleset = 'r1' | 'discovery_v1';

type Env = Record<string, string | undefined>;

export function groundingSourceSetting(env: Env = process.env): GroundingSource {
  const raw = (env.TUTOR_GROUNDING_SOURCE ?? '').trim().toLowerCase();
  if (raw === 'direct' || raw === 'shadow') return raw;
  return 'kafuo_http';
}

export function isDirectGroundingTenant(tenantId: string, env: Env = process.env): boolean {
  const entries = (env.TUTOR_GROUNDING_DIRECT_TENANTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.includes('*') || entries.includes(tenantId);
}

export interface GroundingRoute {
  /** What `TUTOR_GROUNDING_SOURCE` asks for. */
  configured: GroundingSource;
  /** What serves this turn. */
  effective: GroundingSource;
  /** Why `direct` was configured but not effective. */
  fallbackReason?: 'tenant_not_allowed' | 'reader_not_wired';
}

export function resolveGroundingRoute(
  input: { tenantId: string; directAvailable: boolean },
  env: Env = process.env,
): GroundingRoute {
  const configured = groundingSourceSetting(env);
  if (configured !== 'direct') return { configured, effective: configured };
  if (!isDirectGroundingTenant(input.tenantId, env)) {
    return { configured, effective: 'kafuo_http', fallbackReason: 'tenant_not_allowed' };
  }
  if (!input.directAvailable) {
    return { configured, effective: 'kafuo_http', fallbackReason: 'reader_not_wired' };
  }
  return { configured, effective: 'direct' };
}

export function assessmentRuleset(
  effective: GroundingSource,
  env: Env = process.env,
): AssessmentRuleset {
  const raw = (env.TUTOR_ASSESSMENT_RULESET ?? '').trim().toLowerCase();
  if (raw === 'r1' || raw === 'discovery_v1') return raw;
  return effective === 'direct' ? 'discovery_v1' : 'r1';
}

/** `null` → an ambiguous resolution always asks the student (no number before D-7). */
export function ambiguousSearchMinScore(env: Env = process.env): number | null {
  const raw = env.TUTOR_GROUNDING_AMBIGUOUS_SEARCH_MIN_SCORE;
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function evidenceFloor(env: Env = process.env): number {
  const value = Number(env.TUTOR_GROUNDING_EVIDENCE_FLOOR);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0;
}
