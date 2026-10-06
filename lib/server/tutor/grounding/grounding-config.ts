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
 * sample and the boot check (below). The security pre-review's M-1 adds the
 * reader DSN's TLS and environment rules (`checkKafuoGroundingConnection`).
 */

import { accessSync, constants as fsConstants } from 'node:fs';

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

// ---------------------------------------------------------------------------
// The reader DSN: TLS and the libpq-style environment (security pre-review M-1)
// ---------------------------------------------------------------------------

/**
 * The ONLY hosts that may connect without TLS. This is an explicit exception
 * for local development, where the connection never leaves the machine; every
 * other host needs `sslmode=verify-full`.
 */
export const KAFUO_GROUNDING_LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * The only DSN query parameters accepted. node-postgres merges EVERY query
 * parameter over the pool config (`options`, `statement_timeout`, `host`,
 * `ssl`, `uselibpqcompat`, `application_name`, …), so any other one could
 * override the role settings (migration 294) or weaken TLS.
 */
export const KAFUO_GROUNDING_DSN_PARAMS: readonly string[] = ['sslmode', 'sslrootcert'];

/** The reader DSN after the checks below. Holds the password: never log it. */
export interface KafuoGroundingConnection {
  host: string;
  port: number;
  user: string;
  /** Absent → node-postgres falls back to `PGPASSWORD` / `.pgpass`. */
  password: string | undefined;
  database: string;
  /** `verify-full`: TLS with the certificate chain AND the host name checked. `off`: loopback only. */
  tls: 'verify-full' | 'off';
  /** `sslrootcert`: a CA bundle file (with `verify-full` only); null → the system CAs. */
  caFile: string | null;
}

export type KafuoGroundingConnectionCheck =
  | { ok: true; connection: KafuoGroundingConnection }
  | { ok: false; reason: string };

/** A value safe to echo in a refusal (never the DSN, a password or a path). */
function echo(value: string): string {
  return /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : '<redacted>';
}

function refused(reason: string): KafuoGroundingConnectionCheck {
  return { ok: false, reason };
}

/**
 * The M-1 rules for `KAFUO_GROUNDING_DATABASE_URL` and the environment that
 * node-postgres reads implicitly (`connection-parameters.js`). Pure and cheap
 * (no I/O); the boot check adds the CA file's readability.
 *
 *  - A `postgres://` or `postgresql://` URL that names the host, the user and the
 *    database itself (else `PGHOST` / `PGUSER` / `PGDATABASE` would fill them).
 *  - Query parameters: only `sslmode` and `sslrootcert`, each at most once.
 *  - `sslmode=verify-full` for every host. The one exception: a loopback host
 *    (`localhost`, `127.0.0.1`, `::1`) may have no `sslmode`, or `disable`.
 *    `require`, `prefer`, `verify-ca`, `no-verify` … are refused: node-postgres 8
 *    treats some as aliases of `verify-full` and pg 9 will not, so only the
 *    unambiguous mode is accepted.
 *  - `PGOPTIONS` must be unset: node-postgres sends it as startup options, which
 *    would override the reader role's settings (migration 294), and an explicit
 *    config value cannot suppress it (an empty value falls back to the env).
 *  - With `verify-full`, `PGSSLMODE` must be unset or `verify-full` too. The pool
 *    config passes `ssl` explicitly, so the pool ignores it anyway; this refusal
 *    keeps the environment from even suggesting a weaker mode.
 */
export function checkKafuoGroundingConnection(
  url: string,
  env: Env = process.env,
): KafuoGroundingConnectionCheck {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refused('it is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return refused('it must be a postgres:// or postgresql:// URL');
  }
  let host: string;
  let user: string;
  let password: string | undefined;
  let database: string;
  try {
    host = decodeURIComponent(parsed.hostname);
    user = decodeURIComponent(parsed.username);
    password = parsed.password === '' ? undefined : decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return refused('it has a malformed percent-encoding');
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || !user || !database) {
    return refused('it must name the host, the user and the database');
  }
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return refused('its port is invalid');

  for (const name of new Set(parsed.searchParams.keys())) {
    if (!KAFUO_GROUNDING_DSN_PARAMS.includes(name)) {
      return refused(
        `the DSN parameter "${echo(name)}" is not accepted (only sslmode, sslrootcert)`,
      );
    }
    if (parsed.searchParams.getAll(name).length > 1) {
      return refused(`the DSN parameter "${name}" is given twice`);
    }
  }
  const sslmode = parsed.searchParams.get('sslmode');
  const caFile = parsed.searchParams.get('sslrootcert');
  const loopback = KAFUO_GROUNDING_LOOPBACK_HOSTS.includes(host.toLowerCase());

  let tls: KafuoGroundingConnection['tls'];
  if (sslmode === 'verify-full') {
    tls = 'verify-full';
  } else if (loopback && (sslmode === null || sslmode === 'disable')) {
    tls = 'off';
  } else if (sslmode === null) {
    return refused('a non-loopback host needs sslmode=verify-full');
  } else {
    return refused(
      `sslmode=${echo(sslmode)} is not accepted; use sslmode=verify-full ` +
        '(no sslmode, or disable, only on a loopback host)',
    );
  }
  if (caFile !== null && (tls !== 'verify-full' || caFile.trim() === '')) {
    return refused('sslrootcert needs sslmode=verify-full and a file path');
  }

  if ((env.PGOPTIONS ?? '') !== '') {
    return refused(
      'PGOPTIONS is set; node-postgres would send it as startup options and override the ' +
        'reader role settings (migration 294). Unset it in the Teaching Engine environment',
    );
  }
  const envSslMode = (env.PGSSLMODE ?? '').trim();
  if (tls === 'verify-full' && envSslMode !== '' && envSslMode !== 'verify-full') {
    return refused(
      `PGSSLMODE=${echo(envSslMode)} is weaker than the DSN's sslmode=verify-full. ` +
        'Unset it, or set it to verify-full',
    );
  }

  return { ok: true, connection: { host, port, user, password, database, tls, caFile } };
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot fail-fast (P6, M-1): `direct` or `shadow` refuses to start when the
 * reader DSN is missing, breaks the M-1 rules above, or names an unreadable
 * `sslrootcert` — instead of silently serving `kafuo_http` (direct), never
 * comparing (shadow), or sending student text over an unverified connection.
 * The default `kafuo_http` checks nothing. No message echoes the DSN.
 */
export function validateKafuoGroundingConfig(env: Env = process.env): void {
  const source = groundingSourceSetting(env);
  if (source === 'kafuo_http') return;
  const url = kafuoGroundingDatabaseUrl(env);
  if (!url) {
    throw new Error(
      `[config] TUTOR_GROUNDING_SOURCE=${source} needs KAFUO_GROUNDING_DATABASE_URL ` +
        '(the kafuo_grounding_reader DSN). Set it, or set TUTOR_GROUNDING_SOURCE=kafuo_http.',
    );
  }
  const check = checkKafuoGroundingConnection(url, env);
  if (!check.ok) {
    throw new Error(
      `[config] TUTOR_GROUNDING_SOURCE=${source}: KAFUO_GROUNDING_DATABASE_URL is refused: ` +
        `${check.reason}. Fix it, or set TUTOR_GROUNDING_SOURCE=kafuo_http.`,
    );
  }
  if (check.connection.caFile !== null && !isReadableFile(check.connection.caFile)) {
    throw new Error(
      `[config] TUTOR_GROUNDING_SOURCE=${source}: the sslrootcert file named in ` +
        'KAFUO_GROUNDING_DATABASE_URL is not readable.',
    );
  }
}
