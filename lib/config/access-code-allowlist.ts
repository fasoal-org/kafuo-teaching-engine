/**
 * The `ACCESS_CODE` allow-list: the `/api` requests `middleware.ts` lets
 * through without the `openmaic_access` cookie while the gate is on.
 *
 * Only the routes the Kafuo Backend (server to server) and the mobile app call
 * are here, and each one authenticates on its own. Everything else under
 * `/api` answers 401 until the browser has typed the access code, except the
 * Teaching Package editor table below (`isEditorGrantExemptRequest`), which the
 * middleware consults only after the closed-mode 503 and the access cookie.
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
    LEARNER_DOCUMENT_PATH.test(pathname) && Boolean(request.cookies.get(GRANT_COOKIE_NAME)?.value)
  );
}

/**
 * Teaching Package editor routes a browser holding only the editor-grant cookie
 * may reach without the access code (Roles phase 1, D-8 B / O1; reviewed list
 * in `docs/frds/roles/roles-module-phase-1-o1-route-inventory-review.md` §6).
 *
 * Presence only: the cookie value is not checked here. Each handler verifies
 * the grant itself (signature, expiry, tenant, Stage, capability, version
 * state) before reading or writing anything, which is the only reason a row
 * may be listed. Exact method (no HEAD, no OPTIONS) and an anchored path;
 * `:id` is one `STAGE_ID`-charset segment. The learner document read (row 11,
 * GET/HEAD `/api/persistence/documents/:id`) stays in `isOpenApiRequest`.
 * A test pins this table.
 *
 * Review rule for new rows: a row whose LAST segment is a dynamic `:id` is
 * allowed only if its handler re-verifies the grant for that exact id. The
 * middleware sees the path after Next strips a trailing `.rsc`, while the
 * router dispatches the unstripped path, so such a handler can receive an id
 * like `R.rsc` that the predicate never saw.
 */
export const EDITOR_GRANT_EXEMPT_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/api/stages/:id/teaching-skills'],
  ['PUT', '/api/stages/:id/teaching-skills'],
  ['PUT', '/api/stages/:id/scene-alignment-confirmations'],
  ['GET', '/api/stages/:id/scene-regeneration'],
  ['GET', '/api/stages/:id/scene-regenerations/:id'],
  ['POST', '/api/stages/:id/scene-regenerations/:id/restore'],
  ['GET', '/api/stages/:id/scene-revisions'],
  ['POST', '/api/stages/:id/scenes/:id/regenerate'],
  ['GET', '/api/stages/:id/scenes/:id/regenerate'],
  ['POST', '/api/stages/:id/scenes/:id/narration-audio'],
  ['PUT', '/api/persistence/documents/:id'],
  ['PUT', '/api/persistence/documents/:id/stage'],
  ['GET', '/api/persistence/documents/:id/scenes/:id'],
  ['PUT', '/api/persistence/documents/:id/scenes/:id'],
  ['DELETE', '/api/persistence/documents/:id/scenes/:id'],
];

/** Literal segments are lowercase words; `:id` becomes one `STAGE_ID` segment. */
function editorRoutePattern(path: string): RegExp {
  const segments = path.split('/').map((segment) => {
    if (segment === ':id') return STAGE_ID;
    if (!/^[a-z-]*$/.test(segment)) throw new Error(`Unexpected editor route segment: ${segment}`);
    return segment;
  });
  return new RegExp(`^${segments.join('/')}$`);
}

const EDITOR_GRANT_EXEMPTIONS = EDITOR_GRANT_EXEMPT_ROUTES.map(([method, path]) => ({
  method,
  pattern: editorRoutePattern(path),
}));

/**
 * Whether an editor-grant request may pass the `ACCESS_CODE` gate without the
 * access cookie. The query string is ignored. The pathname that must match is
 * the WHATWG-normalized one middleware receives, after Next strips a trailing
 * `.rsc` and the `/_next/data/<id>/…json` wrapper for middleware; it is not
 * the raw request path.
 */
export function isEditorGrantExemptRequest(
  request: Pick<NextRequest, 'nextUrl' | 'method' | 'cookies'>,
): boolean {
  if (!request.cookies.get(GRANT_COOKIE_NAME)?.value) return false;
  const method = request.method.toUpperCase();
  const { pathname } = request.nextUrl;
  return EDITOR_GRANT_EXEMPTIONS.some((row) => row.method === method && row.pattern.test(pathname));
}
