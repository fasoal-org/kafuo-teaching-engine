/**
 * The browser half of the mandatory revision preconditions
 * (single-slide-regeneration-plan §11.2–§11.3).
 *
 * For every Teaching Package Stage this tab loaded under an Editor grant, the
 * registry remembers, per Scene, the trigger-maintained revision the content
 * in the store is based on. It is written ONLY by:
 *
 * - the load binding (`bindStageSceneRevs`, the "sandwich": revisions read
 *   before and after the document, accepted only when they agree);
 * - a successful write's `x-tp-scene-revs-result` response header
 *   (`applySceneRevsResult`), which carries the revisions read inside the
 *   write transaction — exactly the bytes this tab wrote;
 * - an explicit re-sync (`setSceneRev` after a conflict or a regeneration).
 *
 * Every grant-delegated write that can replace or delete a Scene sends the
 * relevant entries in `x-tp-expected-scene-revs` (`expectedSceneRevsHeader`).
 * A Stage the registry never bound sends nothing, which the server answers
 * with `428` — an unbound write is never applied as last-writer-wins.
 *
 * Scenes created locally and never saved have no entry. An entry for a
 * locally deleted Scene is kept until the delete (or a whole-document save
 * that drops it) succeeds.
 */

export const EXPECTED_SCENE_REVS_HEADER = 'x-tp-expected-scene-revs';
export const SCENE_REVS_RESULT_HEADER = 'x-tp-scene-revs-result';

const registry = new Map<string, Map<string, number>>();

type CoveredWrite =
  | { kind: 'document'; stageId: string }
  | { kind: 'scene'; stageId: string; sceneId: string; method: 'PUT' | 'DELETE' };

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parse a document-store request path (`/documents/<s>[/scenes/<x>]`, maybe prefixed). */
export function coveredDocumentWrite(method: string, pathOrUrl: string): CoveredWrite | null {
  const upper = method.toUpperCase();
  let pathname = pathOrUrl;
  try {
    pathname = new URL(pathOrUrl, 'http://local.invalid').pathname;
  } catch {
    return null;
  }
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.indexOf('documents');
  if (at < 0) return null;
  const rest = parts.slice(at);
  if (rest.length < 2) return null;
  const stageId = decode(rest[1]!);
  if (!stageId) return null;
  if (rest.length === 2 && upper === 'PUT') return { kind: 'document', stageId };
  if (rest.length === 4 && rest[2] === 'scenes' && (upper === 'PUT' || upper === 'DELETE')) {
    const sceneId = decode(rest[3]!);
    return sceneId ? { kind: 'scene', stageId, sceneId, method: upper } : null;
  }
  return null;
}

/** Replace the Stage's binding (load sandwich). */
export function bindStageSceneRevs(stageId: string, revs: Readonly<Record<string, number>>): void {
  registry.set(stageId, new Map(Object.entries(revs)));
}

export function clearStageSceneRevs(stageId?: string): void {
  if (stageId === undefined) registry.clear();
  else registry.delete(stageId);
}

export function hasStageSceneRevs(stageId: string): boolean {
  return registry.has(stageId);
}

export function stageSceneRevs(stageId: string): Record<string, number> | undefined {
  const entries = registry.get(stageId);
  return entries ? Object.fromEntries(entries) : undefined;
}

export function sceneRev(stageId: string, sceneId: string): number | undefined {
  return registry.get(stageId)?.get(sceneId);
}

/** Explicit re-sync of one Scene (`null` = it no longer exists). Ignored for an unbound Stage. */
export function setSceneRev(stageId: string, sceneId: string, rev: number | null): void {
  const entries = registry.get(stageId);
  if (!entries) return;
  if (rev === null) entries.delete(sceneId);
  else entries.set(sceneId, rev);
}

/**
 * The precondition header for a covered write of a bound Stage, or
 * `undefined` (not covered, or the Stage was never bound).
 */
export function expectedSceneRevsHeader(method: string, path: string): string | undefined {
  const write = coveredDocumentWrite(method, path);
  if (!write) return undefined;
  const entries = registry.get(write.stageId);
  if (!entries) return undefined;
  if (write.kind === 'document') {
    return encodeURIComponent(JSON.stringify(Object.fromEntries(entries)));
  }
  const rev = entries.get(write.sceneId);
  return encodeURIComponent(JSON.stringify(rev === undefined ? {} : { [write.sceneId]: rev }));
}

/**
 * The document store's per-request headers: the caller's own headers plus,
 * for a covered write of a bound Stage, the precondition. Shared by the
 * browser bootstrap and its tests so both send exactly the same header.
 */
export function withExpectedSceneRevs(
  base: Record<string, string>,
  context: { method: string; path: string },
): Record<string, string> {
  const expected = expectedSceneRevsHeader(context.method, context.path);
  return expected === undefined ? base : { ...base, [EXPECTED_SCENE_REVS_HEADER]: expected };
}

/** Learn the revisions a successful covered write produced. */
export function applySceneRevsResult(method: string, path: string, header: string | null): void {
  if (!header) return;
  const write = coveredDocumentWrite(method, path);
  if (!write || !registry.has(write.stageId)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(header));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const result = parsed as Record<string, unknown>;
  if (write.kind === 'document') {
    // A whole-document save returns every live Scene: the new binding.
    const next = new Map<string, number>();
    for (const [sceneId, rev] of Object.entries(result)) {
      if (typeof rev === 'number' && Number.isSafeInteger(rev)) next.set(sceneId, rev);
    }
    registry.set(write.stageId, next);
    return;
  }
  const rev = result[write.sceneId];
  setSceneRev(
    write.stageId,
    write.sceneId,
    typeof rev === 'number' && Number.isSafeInteger(rev) ? rev : null,
  );
}

/**
 * A `fetch` for the document store that learns the result revisions of every
 * successful covered write from the response.
 */
export function revisionAwareFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.ok) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method =
        init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
      applySceneRevsResult(method, url, response.headers.get(SCENE_REVS_RESULT_HEADER));
    }
    return response;
  };
}

export interface SceneRevisionManifest {
  rev: number;
  scenes: Array<{ id: string; order: number; rev: number }>;
}

/** `GET /api/stages/<id>/scene-revisions`; `null` when the tab holds no grant for it. */
export async function fetchSceneRevisions(
  stageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SceneRevisionManifest | null> {
  const response = await fetchImpl(`/api/stages/${encodeURIComponent(stageId)}/scene-revisions`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`scene revisions could not be read (HTTP ${response.status})`);
  }
  return (await response.json()) as SceneRevisionManifest;
}

export function manifestSceneRevs(manifest: SceneRevisionManifest): Record<string, number> {
  return Object.fromEntries(manifest.scenes.map((scene) => [scene.id, scene.rev]));
}
