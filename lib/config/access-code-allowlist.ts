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
  // D-O1-2 (owner, 19 Oct 2026): the handler requires an edit/preview grant
  // for this Stage of its own tenant when the access cookie is absent.
  ['GET', '/api/stage-meta/:id'],
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
 * D-O1-R8 (owner, 19 Oct 2026), CSRF: the table's POST rows (6 restore,
 * 8 regenerate, 10 narration-audio) start paid or state-changing work and are
 * CORS "simple" requests, so a cross-origin page could send them with the
 * `SameSite=Lax` grant cookie and no preflight. On staging the admin, the
 * website and the TE share one host on different ports, so `same-site` is the
 * real attack and is refused too. PUT and DELETE rows always preflight; GET
 * rows change nothing.
 */
const SAME_ORIGIN_ONLY_METHODS: ReadonlySet<string> = new Set(['POST']);

/** The TE's public origin for this request (as `requestOrigin` in `lib/server/media-origin.ts`). */
function publicRequestOrigin(request: Pick<NextRequest, 'nextUrl' | 'headers'>): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost) {
    return `${request.headers.get('x-forwarded-proto') || 'http'}://${forwardedHost}`;
  }
  return request.nextUrl.origin;
}

/**
 * Whether the browser sent the request from the TE's own origin:
 * `Sec-Fetch-Site: same-origin` exactly (`same-site`, `cross-site` and `none`
 * are refused). Only when that header is absent, an `Origin` equal to the
 * request's public origin; neither header → refused.
 */
function isSameOriginRequest(request: Pick<NextRequest, 'nextUrl' | 'headers'>): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === publicRequestOrigin(request);
}

/**
 * Whether an editor-grant request may pass the `ACCESS_CODE` gate without the
 * access cookie. The query string is ignored. The pathname that must match is
 * the WHATWG-normalized one middleware receives, after Next strips a trailing
 * `.rsc` and the `/_next/data/<id>/…json` wrapper for middleware; it is not
 * the raw request path. POST rows also require a same-origin request
 * (`SAME_ORIGIN_ONLY_METHODS`), and the `/api/persistence/` rows are not
 * exempt while `PERSISTENCE_DEV_TOKEN` is set.
 */
export function isEditorGrantExemptRequest(
  request: Pick<NextRequest, 'nextUrl' | 'method' | 'cookies' | 'headers'>,
): boolean {
  if (!request.cookies.get(GRANT_COOKIE_NAME)?.value) return false;
  const method = request.method.toUpperCase();
  const { pathname } = request.nextUrl;
  // D-O1-1 (owner, 19 Oct 2026): the editor's own media reads carry the grant
  // cookie and no signed link. Reads of `media/` and `audio/` only; the handler
  // accepts only an edit/preview grant for this Stage of its own tenant, and a
  // learner grant still needs a signed link.
  if ((method === 'GET' || method === 'HEAD') && CLASSROOM_MEDIA_PATH.test(pathname)) {
    return true;
  }
  const row = EDITOR_GRANT_EXEMPTIONS.find(
    (entry) => entry.method === method && entry.pattern.test(pathname),
  );
  if (!row) return false;
  // D-O1-R4 (owner, 19 Oct 2026): the persistence rows (12-16) fail closed for
  // a request no grant covers only while `PERSISTENCE_DEV_TOKEN` is unset, so
  // with it set they keep the access code. Read per request, like
  // `ACCESS_CODE` in `middleware.ts`. Row 11 lives in `isOpenApiRequest`.
  if (process.env.PERSISTENCE_DEV_TOKEN && pathname.startsWith('/api/persistence/')) return false;
  return !SAME_ORIGIN_ONLY_METHODS.has(row.method) || isSameOriginRequest(request);
}
