/**
 * The classroom Stage id of a TE page path, for the client access-code guard
 * (owner, 21 Nov 2026).
 *
 * Pure and client-safe on purpose: the guard is a client component, so nothing here may
 * import server persistence (`lib/server/classroom-storage.ts` included). The charset is
 * `STAGE_ID` from the access-code allowlist — `[A-Za-z0-9_-]+` — which also rules out an
 * encoded slash, `..` and any multi-segment path.
 */

const STAGE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The Stage id when the pathname is exactly `/classroom/<id>`; `null` otherwise. */
export function classroomStageIdFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = /^\/classroom\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const stageId = match[1]!;
  return STAGE_ID_RE.test(stageId) ? stageId : null;
}
