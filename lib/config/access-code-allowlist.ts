/**
 * The `ACCESS_CODE` allow-list: the `/api` requests `middleware.ts` lets
 * through without the `openmaic_access` cookie while the gate is on.
 *
 * Only the routes the Kafuo Backend (server to server) and the mobile app call
 * are here, and each one authenticates on its own. Everything else under
 * `/api` answers 401 until the browser has typed the access code.
 *
 * Edge-safe: no Node imports (middleware may run on the edge runtime).
 */
import type { NextRequest } from 'next/server';

/**
 * Exact paths. Health is public; the Teaching Package collection and the
 * Backend's legacy Help turn (`teaching-model/help-turns`) take the service key.
 */
const OPEN_EXACT_PATHS: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/teaching-packages',
  '/api/teaching-model/help-turns',
]);

/**
 * Prefixes, each ending at a `/` boundary so `/api/tutor/` never matches
 * `/api/tutorial` or `/api/tutor-x`. The access-code endpoints are the gate
 * itself; `teaching-packages/**` take the service key or a handoff token;
 * `tutor/**` take the service key (handoff mint), the handoff token (redeem),
 * the student grant bearer (Free Chat) or the learner grant cookie (Help).
 */
const OPEN_PREFIXES: readonly string[] = [
  '/api/access-code/',
  '/api/teaching-packages/',
  '/api/tutor/',
];

/** Same charset as `isValidClassroomId`; also rules out `%2F` and `..` tricks. */
const STAGE_ID = '[A-Za-z0-9_-]+';

/**
 * The learner's Stage document, as the mobile app reads it after redeeming a
 * learner handoff (`documentPath`). Read-only, one Stage, and only with a
 * grant cookie: the persistence route verifies the grant for that Stage and,
 * with `PERSISTENCE_DEV_TOKEN` unset, refuses every request no grant covers.
 */
const LEARNER_DOCUMENT_PATH = new RegExp(`^/api/persistence/documents/${STAGE_ID}$`);

/**
 * Must equal `TEACHING_PACKAGE_GRANT_COOKIE` (a test pins it): editor-grant.ts
 * imports node:crypto, which this module cannot.
 */
export const GRANT_COOKIE_NAME = 'teaching_package_grant';

/**
 * Stage images and narration audio, as signed at learner delivery
 * (`classroom-media-signature.ts`): the mobile player sends no credential, so
 * the link carries `exp` + `sig`, and the media route verifies them. An
 * unsigned link needs the access cookie like any other `/api` request.
 */
const CLASSROOM_MEDIA_PATH = new RegExp(`^/api/classroom-media/${STAGE_ID}/(media|audio)/.+`);

/** Whether a request may pass the `ACCESS_CODE` gate without the access cookie. */
export function isOpenApiRequest(
  request: Pick<NextRequest, 'nextUrl' | 'method' | 'cookies'>,
): boolean {
  const { pathname } = request.nextUrl;
  if (OPEN_EXACT_PATHS.has(pathname)) return true;
  if (OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (CLASSROOM_MEDIA_PATH.test(pathname)) {
    const search = request.nextUrl.searchParams;
    return Boolean(search.get('exp') && search.get('sig'));
  }
  return (
    LEARNER_DOCUMENT_PATH.test(pathname) &&
    Boolean(request.cookies.get(GRANT_COOKIE_NAME)?.value)
  );
}
