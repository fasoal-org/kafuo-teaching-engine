/**
 * What the browser can tell about a Teaching Package Editor grant, and what a
 * route refusal under one looks like.
 *
 * The grant itself is deliberately invisible to page scripts: the redeem
 * (`/api/teaching-packages/editor-handoff`) writes it HttpOnly and scoped to
 * `Path=/api`, so the ONLY thing client code can observe is the readable
 * companion learner-key cookie (`tp:<nonce>`). That cookie is written for every
 * redeem — preview, learner and edit alike — so it says "this tab is running
 * inside a grant session" and says NOTHING about the grant's capability.
 *
 * That asymmetry is the whole reason the classroom's document-write gate is a
 * TRI-state rather than a boolean. Capability is a server fact, delivered by
 * the stage-meta sidecar (`isOwner`, which counts a `write` grant and refuses a
 * `read` one) on a round trip that finishes AFTER the classroom has begun
 * loading. Until it lands, a grant session must behave as "not known to be
 * writable" — never as "writable" — or a load-time self-heal fires a document
 * mutation the server will refuse with 403 GRANT_READ_ONLY.
 */

/** The readable companion cookie an Editor-grant redeem sets alongside the grant. */
export const TEACHING_PACKAGE_LEARNER_COOKIE_NAME = 'teaching_package_learner_key';

/**
 * The grant session's learner partition (`tp:<nonce>`), or `undefined` outside
 * one. A partition name, not a credential: without the HttpOnly grant it
 * authorizes nothing, and the server only accepts it when it equals the
 * grant's own learner key.
 */
export function readGrantLearnerKeyCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${TEACHING_PACKAGE_LEARNER_COOKIE_NAME}=`)) continue;
    const value = trimmed.slice(TEACHING_PACKAGE_LEARNER_COOKIE_NAME.length + 1);
    try {
      const decoded = decodeURIComponent(value);
      return decoded.startsWith('tp:') ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * True when this tab was opened through an Editor-grant redeem, of ANY
 * capability. Read-only preview, learner playback and editable handoff all
 * answer `true`; only the capability probe can tell them apart.
 */
export function isTeachingPackageGrantSession(): boolean {
  return readGrantLearnerKeyCookie() !== undefined;
}

/**
 * Is this failure the persistence route's terminal read-only refusal?
 *
 * `app/api/persistence/[...path]/route.ts` answers `403 { error: { code:
 * 'GRANT_READ_ONLY' } }` for every mutating document request made under a
 * `read` grant, and `HttpDocumentStore` surfaces that as an error carrying the
 * route's `code`. It is terminal by construction: the grant's capability is
 * fixed for the session, so retrying the same write can only ever be refused
 * again. Duck-typed rather than `instanceof`-checked so a refusal keeps its
 * meaning through any wrapper the storage seam may add.
 */
export function isGrantReadOnlyRefusal(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === 'GRANT_READ_ONLY') return true;
    current = candidate.cause;
  }
  return false;
}
