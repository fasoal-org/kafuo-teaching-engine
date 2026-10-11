/**
 * HMAC-signed compact tokens shared by every grant the Teaching Engine mints
 * (Editor handoff/grant cookies, Kafuo R1 student handoff/grant — plan §9.3).
 *
 * Extracted verbatim from `editor-grant.ts` so the student grant (P5) signs
 * with the same idiom and the same secret instead of a second copy. Token
 * shape: `<base64url(JSON payload)>.<hex hmac-sha256(secret, payload JSON)>`.
 * Callers put the discriminator (`kind`) INSIDE the payload — one secret can
 * therefore sign several token families without any of them being
 * presentable as another (`verify…` checks `kind` after the signature).
 *
 * Signing mirrors the repo's HMAC + digest/timing-safe idioms
 * (`middleware.ts`, `lib/persistence/server-auth.ts`). The secret is
 * TEACHING_PACKAGE_GRANT_SECRET; in production it is REQUIRED and must differ
 * from the service key (`validateProductionStartupConfig` in
 * `lib/server/startup-config.ts`, readiness review ET-34), so the service-key
 * fallback below only ever applies in development.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The grant signing secret: TEACHING_PACKAGE_GRANT_SECRET, else (development
 * only; production refuses to start without it) the service key.
 */
export function grantSecret(): string {
  const override = process.env.TEACHING_PACKAGE_GRANT_SECRET?.trim();
  return override || process.env.TEACHING_ENGINE_SERVICE_KEY?.trim() || '';
}

export function sign(payloadJson: string): string {
  return createHmac('sha256', grantSecret()).update(payloadJson).digest('hex');
}

export function encodeSigned<T extends object>(payload: T): string {
  const payloadJson = JSON.stringify(payload);
  return `${Buffer.from(payloadJson, 'utf8').toString('base64url')}.${sign(payloadJson)}`;
}

/**
 * Verify the signature and parse the payload. `null` for a malformed token, a
 * signature mismatch (compared through SHA-256 digests with `timingSafeEqual`,
 * so length never leaks), or unparsable JSON. Expiry and `kind` are the
 * caller's checks — this layer only answers "was this signed by us, intact".
 */
export function decodeSigned<T>(token: string): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadJson = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  const signature = token.slice(dot + 1);
  const expected = sign(payloadJson);
  const left = createHash('sha256').update(signature).digest();
  const right = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(left, right)) return null;
  try {
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}
