/**
 * Production startup guards and the `ACCESS_CODE` gate rules they share with
 * `middleware.ts` (readiness review ET-31, ET-34).
 *
 * Edge-safe: no Node imports. `middleware.ts` imports the gate and cookie rules
 * from here, so this module must stay free of `crypto`, `fs`, `pg` and friends.
 * The HMAC itself is computed by each caller (Web Crypto in the middleware,
 * `node:crypto` in `access-token.ts`); only the token FORMAT and its age rule
 * live here, so the two verifiers cannot drift.
 *
 * No error message contains a secret VALUE — only the env var name that is
 * wrong. A value would leak into logs, CI output and crash reporters.
 */

/**
 * The explicit opt-out for a LOCAL production-mode run (`pnpm build && pnpm
 * start`, e2e): `TE_ALLOW_OPEN_ACCESS=1` lets the server start, and serve
 * every route, without `ACCESS_CODE`. Never set it on a server. Same `1`/`true`
 * convention as the repo's other opt-ins.
 */
export function isOpenAccessOptOut(raw: string | undefined): boolean {
  return ['1', 'true'].includes(raw?.trim().toLowerCase() ?? '');
}

/**
 * How the middleware treats an `/api` request that is not on the allow-list:
 * - `gated`: `ACCESS_CODE` is set; a valid access cookie is required (401).
 * - `open`: no `ACCESS_CODE` in development, or with the explicit opt-out;
 *   every request passes, as before.
 * - `closed`: no `ACCESS_CODE` in production; refused with 503. The startup
 *   guard below normally stops such a process from booting; this is the
 *   defense in depth for a process that started anyway.
 */
export type AccessGateMode = 'gated' | 'open' | 'closed';

export function resolveAccessGateMode(input: {
  /** The raw `ACCESS_CODE`, exactly as the middleware compares it. */
  accessCode: string | undefined;
  isProduction: boolean;
  allowOpenAccess: boolean;
}): AccessGateMode {
  if (input.accessCode) return 'gated';
  if (!input.isProduction || input.allowOpenAccess) return 'open';
  return 'closed';
}

/**
 * Production fail-fast, called first in `registerNodeInstrumentation` so a
 * misconfigured deployment fails to start instead of serving.
 *
 * - `ACCESS_CODE` (ET-31): without it every LLM/TTS route is a public proxy on
 *   the server's provider keys. The `TE_ALLOW_OPEN_ACCESS` opt-out skips only
 *   this check.
 * - `TEACHING_PACKAGE_GRANT_SECRET` (ET-34): without it every grant, handoff
 *   token and signed media link is signed with the service key (or, with no
 *   service key, with an empty key). It must also differ from the service key,
 *   or possession of one credential would be enough for both roles. No opt-out.
 *
 * Outside production nothing is checked: development keeps today's behaviour.
 */
export function validateProductionStartupConfig(env: {
  isProduction: boolean;
  accessCode: string;
  allowOpenAccess: boolean;
  grantSecret: string;
  serviceKey: string;
}): void {
  if (!env.isProduction) return;

  if (!env.accessCode.trim() && !env.allowOpenAccess) {
    throw new Error(
      'STARTUP_CONFIG_INVALID: ACCESS_CODE is required in production (set TE_ALLOW_OPEN_ACCESS=1 only for a local production-mode run)',
    );
  }
  const grantSecret = env.grantSecret.trim();
  if (!grantSecret) {
    throw new Error(
      'STARTUP_CONFIG_INVALID: TEACHING_PACKAGE_GRANT_SECRET is required in production',
    );
  }
  if (grantSecret === env.serviceKey.trim()) {
    throw new Error(
      'STARTUP_CONFIG_INVALID: TEACHING_PACKAGE_GRANT_SECRET must differ from TEACHING_ENGINE_SERVICE_KEY',
    );
  }
}

// --- The admin access cookie (`openmaic_access`) -----------------------------

/**
 * Server-side lifetime of the access cookie, and its browser `maxAge`. An admin
 * types the code again after this.
 */
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Tolerated clock skew between instances for an issued-at in the future. */
export const ACCESS_TOKEN_FUTURE_SKEW_MS = 60 * 1000;

/**
 * Token shape: `v2.<issuedAtMs>.<hex hmac-sha256(ACCESS_CODE, "v2.<issuedAtMs>")>`.
 * The version is inside the signed message, so a v1 signature (`<ms>.<hmac(ms)>`)
 * can never verify as v2. v1 cookies are refused: admins type the code once.
 */
export const ACCESS_TOKEN_VERSION = 'v2';

/** The message the HMAC covers for a given issued-at. */
export function accessTokenMessage(issuedAtMs: number): string {
  return `${ACCESS_TOKEN_VERSION}.${issuedAtMs}`;
}

/**
 * Split a token and apply the age rule BEFORE any HMAC work. `null` for a
 * malformed or legacy token, an issued-at older than the max age, or one
 * further in the future than the skew allows. The caller then checks
 * `signature` against the HMAC of `message`.
 */
export function readAccessToken(
  token: string,
  nowMs: number,
): { message: string; signature: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, issuedAt, signature] = parts;
  if (version !== ACCESS_TOKEN_VERSION) return null;
  if (!/^\d{1,16}$/.test(issuedAt) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  const issuedAtMs = Number(issuedAt);
  const fresh =
    Number.isSafeInteger(issuedAtMs) &&
    nowMs - issuedAtMs <= ACCESS_TOKEN_MAX_AGE_SECONDS * 1000 &&
    issuedAtMs <= nowMs + ACCESS_TOKEN_FUTURE_SKEW_MS;
  if (!fresh) return null;
  return { message: `${version}.${issuedAt}`, signature };
}
