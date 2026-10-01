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
 *
 * P6 adds the reader pool settings, the query-embedding timeouts, the shadow
 * sample and the boot check (below).
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

// ---------------------------------------------------------------------------
// P6: the direct read path (§5.5) and shadow comparison
// ---------------------------------------------------------------------------

/** An integer env value in `[min, max]`; anything else is `fallback`. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

/** `KAFUO_GROUNDING_DATABASE_URL`: the reader role's DSN (never logged). Empty → unset. */
export function kafuoGroundingDatabaseUrl(env: Env = process.env): string | null {
  const raw = (env.KAFUO_GROUNDING_DATABASE_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
}

/**
 * The reader pool and its semaphore (§5.5, RET-06). Read once, when the pool
 * is created (a pool cannot be resized in place).
 *
 *  - `KAFUO_GROUNDING_POOL_MAX` (8, 1..64): connections per instance AND the
 *    in-flight cap; a retrieval beyond it is `retrieval_busy` at once.
 *  - `KAFUO_GROUNDING_ADMISSION_TIMEOUT_MS` (300, 50..5000): `connectionTimeoutMillis`.
 *  - `KAFUO_GROUNDING_IDLE_TIMEOUT_MS` (30000, 1000..600000): `idleTimeoutMillis`.
 *  - `KAFUO_GROUNDING_QUERY_TIMEOUT_MS` (2500, 200..30000): a client-side backstop
 *    ABOVE the role's server-side `statement_timeout` (1,500 ms, migration 294);
 *    the reader never sends `statement_timeout` itself, so the role setting rules.
 */
export interface KafuoGroundingPoolSettings {
  max: number;
  admissionTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number;
}

export const KAFUO_GROUNDING_POOL_DEFAULTS: KafuoGroundingPoolSettings = {
  max: 8,
  admissionTimeoutMs: 300,
  idleTimeoutMs: 30_000,
  queryTimeoutMs: 2_500,
};

export function kafuoGroundingPoolSettings(env: Env = process.env): KafuoGroundingPoolSettings {
  const d = KAFUO_GROUNDING_POOL_DEFAULTS;
  return {
    max: boundedInt(env.KAFUO_GROUNDING_POOL_MAX, d.max, 1, 64),
    admissionTimeoutMs: boundedInt(
      env.KAFUO_GROUNDING_ADMISSION_TIMEOUT_MS,
      d.admissionTimeoutMs,
      50,
      5_000,
    ),
    idleTimeoutMs: boundedInt(env.KAFUO_GROUNDING_IDLE_TIMEOUT_MS, d.idleTimeoutMs, 1_000, 600_000),
    queryTimeoutMs: boundedInt(env.KAFUO_GROUNDING_QUERY_TIMEOUT_MS, d.queryTimeoutMs, 200, 30_000),
  };
}

/**
 * The query embedding (§5.5). One attempt is bounded by
 * `TUTOR_QUERY_EMBEDDING_TIMEOUT_MS` (3000, 200..8000); the single retry runs
 * only if it still fits in `TUTOR_QUERY_EMBEDDING_BUDGET_MS` (5000, 200..8000),
 * which stays under the 10 s the `kafuo_http` grounding call is allowed
 * (`KAFUO_INTEGRATION_TIMEOUT_MS`), so `direct` never waits longer than HTTP.
 */
export function queryEmbeddingTimeouts(env: Env = process.env): {
  attemptTimeoutMs: number;
  budgetMs: number;
} {
  const attemptTimeoutMs = boundedInt(env.TUTOR_QUERY_EMBEDDING_TIMEOUT_MS, 3_000, 200, 8_000);
  const budgetMs = boundedInt(env.TUTOR_QUERY_EMBEDDING_BUDGET_MS, 5_000, 200, 8_000);
  return { attemptTimeoutMs, budgetMs: Math.max(budgetMs, attemptTimeoutMs) };
}

/**
 * `TUTOR_GROUNDING_SHADOW_SAMPLE` (0..1, default 0.1): the share of `shadow`
 * retrieve turns that also run the direct path. Shadow doubles the query
 * embedding cost of a sampled turn, so it is sampled; dev acceptance runs set 1.
 */
export const DEFAULT_SHADOW_SAMPLE = 0.1;

export function shadowSampleRate(env: Env = process.env): number {
  const raw = env.TUTOR_GROUNDING_SHADOW_SAMPLE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SHADOW_SAMPLE;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_SHADOW_SAMPLE;
}

/**
 * Deterministic sampling on the turn id (FNV-1a → [0, 1)), so a retried
 * attempt of the same turn samples the same way and tests are stable.
 */
export function isShadowSampled(turnId: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  let hash = 0x811c9dc5;
  for (let index = 0; index < turnId.length; index += 1) {
    hash ^= turnId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000 < rate;
}

/**
 * Boot fail-fast (P6): `direct` or `shadow` without the reader DSN is a
 * deployment error — the process refuses to start instead of silently
 * serving `kafuo_http` (direct) or never comparing (shadow).
 */
export function validateKafuoGroundingConfig(env: Env = process.env): void {
  const source = groundingSourceSetting(env);
  if (source === 'kafuo_http') return;
  if (!kafuoGroundingDatabaseUrl(env)) {
    throw new Error(
      `[config] TUTOR_GROUNDING_SOURCE=${source} needs KAFUO_GROUNDING_DATABASE_URL ` +
        '(the kafuo_grounding_reader DSN). Set it, or set TUTOR_GROUNDING_SOURCE=kafuo_http.',
    );
  }
}
