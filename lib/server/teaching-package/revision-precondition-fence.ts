/**
 * Mandatory revision preconditions for grant-delegated Scene writes
 * (single-slide-regeneration-plan §11).
 *
 * Every Editor-grant document write that can replace or delete a Scene —
 * `PUT /documents/<s>/scenes/<x>`, `DELETE /documents/<s>/scenes/<x>` and the
 * whole-document `PUT /documents/<s>` (which replaces every Scene and deletes
 * the absent ones) — carries the per-Scene revisions it was based on in the
 * `x-tp-expected-scene-revs` request header. The persistence route checks them
 * INSIDE the owner-bound write transaction through this fence:
 *
 * - `'before'` takes `stage_meta FOR UPDATE` first (so the check is serialized
 *   with every owner-bound writer, including the regeneration commit, and the
 *   lock order stays `stage_meta → versions` ahead of the stage guard), then
 *   compares the expected revisions with the live trigger-maintained ones;
 * - `'after'` reads the affected Scenes' new revisions, which the route
 *   returns in `x-tp-scene-revs-result` so the client learns the revision of
 *   exactly the bytes it wrote.
 *
 * A missing header answers `428 PRECONDITION_REQUIRED` (decided by the route
 * before any store exists); a mismatch answers `409 SCENE_REVISION_CONFLICT`
 * with the conflicting Scenes. Non-grant writes never reach this module.
 *
 * The fence runs in EVERY transaction the store opens (the owner-bound
 * `putScene` opens two: the lineage read and the write). The check is
 * read-only, so repeating it is harmless, and the last `'after'` — the write
 * transaction's — is the one whose revisions are reported.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

export const EXPECTED_SCENE_REVS_HEADER = 'x-tp-expected-scene-revs';
export const SCENE_REVS_RESULT_HEADER = 'x-tp-scene-revs-result';

/** The Scene-replacing document writes the rule covers. */
export type RevisionPreconditionTarget =
  | { kind: 'scene'; stageId: string; sceneId: string; method: 'PUT' | 'DELETE' }
  | { kind: 'document'; stageId: string };

/** `sceneId → rev` (a `null` result value means the Scene is not live). */
export type SceneRevisionMap = Record<string, number>;
export type SceneRevisionResult = Record<string, number | null>;

export interface SceneRevisionConflict {
  id: string;
  /** The live revision, or `null` when the Scene no longer exists. */
  currentRev: number | null;
}

/** Per-request state the fence fills and the route reads after the handler. */
export interface RevisionPreconditionState {
  refusal?: {
    status: 409;
    code: 'SCENE_REVISION_CONFLICT';
    message: string;
    scenes: SceneRevisionConflict[];
  };
  resultRevs?: SceneRevisionResult;
}

/**
 * The fence's refusal. Its message deliberately avoids the phrases the storage
 * handler's error classifier matches on (missing document / DSL version), so
 * it always surfaces as a plain failure the route then replaces.
 */
export class SceneRevisionConflictError extends Error {
  constructor(readonly scenes: SceneRevisionConflict[]) {
    super(`scene revision precondition failed for ${scenes.length} scene(s)`);
    this.name = 'SceneRevisionConflictError';
  }
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * The covered target of a document request, or `null` for everything the rule
 * does not cover (reads, `PUT …/stage`, `DELETE /documents/<s>`, unknown).
 * `path` is route-relative (`/documents/...`).
 */
export function revisionPreconditionTarget(
  method: string,
  path: string,
): RevisionPreconditionTarget | null {
  const upper = method.toUpperCase();
  const parts = path.split('?')[0]!.split('/').filter(Boolean);
  if (parts[0] !== 'documents' || parts.length < 2) return null;
  const stageId = decodeSegment(parts[1]!);
  if (!stageId) return null;
  if (parts.length === 2 && upper === 'PUT') return { kind: 'document', stageId };
  if (parts.length === 4 && parts[2] === 'scenes' && (upper === 'PUT' || upper === 'DELETE')) {
    const sceneId = decodeSegment(parts[3]!);
    if (!sceneId) return null;
    return { kind: 'scene', stageId, sceneId, method: upper };
  }
  return null;
}

/**
 * Parse the request header: URL-encoded JSON `{ sceneId: rev }` with
 * non-negative integer revisions. `null` = absent or malformed (both are a
 * missing precondition: nothing is ever written on a guess).
 */
export function parseExpectedSceneRevs(value: string | null | undefined): SceneRevisionMap | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const revs: SceneRevisionMap = {};
  for (const [sceneId, rev] of Object.entries(decoded as Record<string, unknown>)) {
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) return null;
    revs[sceneId] = rev;
  }
  return revs;
}

export function encodeSceneRevs(revs: SceneRevisionMap | SceneRevisionResult): string {
  return encodeURIComponent(JSON.stringify(revs));
}

async function readLiveSceneRevs(
  queryable: Queryable,
  stageId: string,
  sceneId?: string,
): Promise<Map<string, number>> {
  const result = await queryable.query<{ id: string; rev: number | string }>(
    `SELECT s.id, COALESCE(sr.rev, 0) AS rev
       FROM document_scenes s
       LEFT JOIN document_scene_revision sr
         ON sr.stage_id = s.stage_id AND sr.scene_id = s.id
      WHERE s.stage_id = $1 ${sceneId === undefined ? '' : 'AND s.id = $2'}`,
    sceneId === undefined ? [stageId] : [stageId, sceneId],
  );
  return new Map(result.rows.map((row) => [row.id, Number(row.rev)]));
}

/** The conflicts between the expected and the live revisions (empty = pass). */
export function revisionConflicts(
  target: RevisionPreconditionTarget,
  expected: SceneRevisionMap,
  live: ReadonlyMap<string, number>,
): SceneRevisionConflict[] {
  const conflicts: SceneRevisionConflict[] = [];
  if (target.kind === 'scene') {
    const liveRev = live.get(target.sceneId);
    const expectedRev = expected[target.sceneId];
    if (liveRev !== undefined) {
      // Replacing or deleting a live Scene needs its exact current base.
      if (expectedRev !== liveRev) conflicts.push({ id: target.sceneId, currentRev: liveRev });
    } else if (expectedRev !== undefined) {
      // Based on a Scene that is gone: deleted elsewhere since the load.
      conflicts.push({ id: target.sceneId, currentRev: null });
    }
    // Not live and no expectation: a creation (or a no-op delete).
    return conflicts;
  }
  // Whole document: every live Scene is replaced or deleted, so every live
  // Scene needs a matching expectation, and every expectation must still name
  // a live Scene at that revision.
  for (const [sceneId, liveRev] of live) {
    if (expected[sceneId] !== liveRev) conflicts.push({ id: sceneId, currentRev: liveRev });
  }
  for (const sceneId of Object.keys(expected)) {
    if (!live.has(sceneId)) conflicts.push({ id: sceneId, currentRev: null });
  }
  return conflicts;
}

interface FenceOperation {
  stageId?: string;
  mode: string;
}

/**
 * The owner-bound `mutationFence` half for one grant-delegated request.
 * Compose it FIRST (ahead of the stage guard).
 */
export function revisionPreconditionFence(
  target: RevisionPreconditionTarget,
  expected: SceneRevisionMap,
  state: RevisionPreconditionState,
): (queryable: Queryable, operation: FenceOperation, phase: 'before' | 'after') => Promise<void> {
  const sceneFilter = target.kind === 'scene' ? target.sceneId : undefined;
  return async (queryable, operation, phase) => {
    if (operation.stageId !== target.stageId || operation.mode === 'read') return;
    if (phase === 'before') {
      await queryable.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [
        target.stageId,
      ]);
      const live = await readLiveSceneRevs(queryable, target.stageId, sceneFilter);
      const conflicts = revisionConflicts(target, expected, live);
      if (conflicts.length > 0) {
        state.refusal = {
          status: 409,
          code: 'SCENE_REVISION_CONFLICT',
          message: 'this slide was changed elsewhere since it was loaded; the change was not saved',
          scenes: conflicts,
        };
        throw new SceneRevisionConflictError(conflicts);
      }
      return;
    }
    const live = await readLiveSceneRevs(queryable, target.stageId, sceneFilter);
    if (target.kind === 'scene') {
      state.resultRevs = { [target.sceneId]: live.get(target.sceneId) ?? null };
    } else {
      state.resultRevs = Object.fromEntries(live);
    }
  };
}
