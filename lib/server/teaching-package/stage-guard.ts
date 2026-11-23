/**
 * Teaching Package stage immutability guard (plan §6.1).
 *
 * The single authoritative "may this Stage change at all?" decision, evaluated
 * inside the owner-bound store's mutation transaction (the transaction already
 * holds `stage_meta FOR UPDATE`, so the guard runs after that lock and never
 * takes the lifecycle advisory lock — lock order stays `stage_meta →
 * versions`).
 *
 * The guard is capability-agnostic: it decides whether a Stage *can* change.
 * Whether a particular browser *may* change it is decided earlier by the
 * Editor grant (§12) — a `read` grant never reaches a write, regardless of
 * status.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { readStageReferences } from '@/lib/persistence/teaching-package';
import { TeachingPackageStageLockedError } from '@/lib/server/teaching-package/errors';
import { enqueueSceneChanged } from '@/lib/server/teaching-package/scene-webhook-events';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';

/** Modes the owner-bound store tags on its pending operations. */
export type StageGuardMode = 'create' | 'mutate' | 'delete' | 'read' | 'library';

export interface StageGuardOperation {
  stageId: string;
  mode: StageGuardMode;
  /** `library` = folder membership only, which is not Stage content. */
  scope?: 'content' | 'library';
}

const EDITABLE_STATUSES: readonly TeachingPackageStatus[] = ['draft', 'rejected'];

function isEditableStatus(status: TeachingPackageStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * Assert that the Stage may take this operation.
 *
 * 1. `scope === 'library'` → allowed (folder membership is not Stage content).
 * 2. Unreferenced by any version and not a retained displaced Stage → allowed
 *    (ordinary non-package Stage, or a displaced Stage already released by the
 *    retention policy; existing behavior).
 * 3. `delete` on a version-referenced or retained-displaced Stage → refused
 *    (`package-owned`): every version keeps exactly one valid Stage, and a
 *    retained displaced Stage is protected until released.
 * 4. `create`/`mutate` (the owner-bound store tags `saveDocument` as `create`
 *    even for overwrites) on a version in `in_review`/`approved`/`superseded`/
 *    `discarded` → refused with the status as the reason; retained-displaced
 *    only → refused with `displaced`.
 */
export async function assertStageWritable(
  queryable: Queryable,
  op: StageGuardOperation,
): Promise<{ editableVersionId: string | null }> {
  // The return value is informational (the scene events reuse the version this
  // read already found); every refusal is still a throw, exactly as before.
  const none = { editableVersionId: null };
  if (op.scope === 'library') return none;
  if (op.mode === 'read') return none;

  const references = await readStageReferences(queryable, op.stageId);
  const { versions, retainedDisplaced } = references;
  if (versions.length === 0 && !retainedDisplaced) return none;

  if (op.mode === 'delete') {
    throw new TeachingPackageStageLockedError(op.stageId, 'package-owned');
  }

  // mode === 'create' | 'mutate' (| 'library', mapped by the fence composer).
  const lockedBy = versions.find((version) => !isEditableStatus(version.status));
  if (lockedBy) {
    throw new TeachingPackageStageLockedError(op.stageId, lockedBy.status);
  }
  // An attempt row also retains the Stage that was successfully promoted to a
  // version's current working slot. That Stage is not displaced: while its
  // referencing version is editable, normal reviewer edits must remain
  // allowed. The attempt-only protection applies only after the Stage is no
  // longer referenced by any version.
  if (versions.length === 0 && retainedDisplaced) {
    throw new TeachingPackageStageLockedError(op.stageId, 'displaced');
  }
  // Every referencing version is editable here (a locked one threw above).
  return { editableVersionId: versions[0]?.id ?? null };
}

/** The operation shape the widened owner-bound `mutationFence` receives. */
export interface GuardedPendingOperation {
  stageId?: string;
  mode: StageGuardMode;
  scope: 'content' | 'library';
  /** A single-Scene write's target (`putScene` / `deleteScene`). */
  sceneId?: string;
  /** `putScene`'s read of the stored Scene before its write: no scene events. */
  lookup?: true;
}

/**
 * `teaching_package.scene_changed` for every other write (Agent API wave B, owner
 * «fix them all»): `false` when the caller sends its own, more specific event
 * (regeneration, insertion, restore, narration audio); else the actor to name.
 */
export type StageGuardSceneEvents = false | { actorRef?: string };

interface SceneSnapshot {
  versionId: string;
  /** Set for a single-Scene write: only that Scene is compared. */
  sceneId?: string;
  digests: Map<string, string>;
}

/**
 * A Scene's content digest. `jsonb::text` is canonical, so an unchanged Scene that a
 * whole-document save re-upserts keeps its digest. Position (`order`) and the
 * `updatedAt` stamp are left out: a pure reorder, or the slides an insertion shifts,
 * are not content edits.
 */
const SCENE_DIGEST = `md5((data - 'order' - 'updatedAt')::text)`;

/**
 * The scenes of an editable package stage, by content digest. `stage_meta` is locked
 * FIRST (`FOR UPDATE`, re-entrant with the owner-bound store's own lock), so a
 * concurrent writer cannot commit between this snapshot and the write: two writers
 * never attribute one change to both. Lock order stays versions (the guard's
 * `readStageReferences`) → `stage_meta` → the webhook advisory lock (at enqueue).
 */
async function snapshotPackageScenes(
  queryable: Queryable,
  stageId: string,
  versionId: string,
  sceneId: string | undefined,
): Promise<SceneSnapshot> {
  await queryable.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [stageId]);
  const scenes = sceneId
    ? await queryable.query<{ id: string; digest: string }>(
        `SELECT id, ${SCENE_DIGEST} AS digest FROM document_scenes
          WHERE stage_id = $1 AND id = $2`,
        [stageId, sceneId],
      )
    : await queryable.query<{ id: string; digest: string }>(
        `SELECT id, ${SCENE_DIGEST} AS digest FROM document_scenes WHERE stage_id = $1`,
        [stageId],
      );
  return {
    versionId,
    ...(sceneId ? { sceneId } : {}),
    digests: new Map(scenes.rows.map((row) => [row.id, row.digest])),
  };
}

/** A `prefix:id` actor ref kept as is; anything else becomes `unknown` (never content). */
const SAFE_ACTOR_REF = /^[a-z][a-z0-9_-]{0,40}:[A-Za-z0-9_.:@-]{1,160}$/;

export function sanitizeSceneEventActorRef(actorRef: string | undefined): string {
  if (!actorRef || !SAFE_ACTOR_REF.test(actorRef)) return 'unknown';
  // The outbox's content check refuses these substrings; never let an actor trip it.
  if (/contentResource|requirement|pdfContent/i.test(actorRef)) return 'unknown';
  return actorRef;
}

/**
 * Compose the guard into an owner-bound `mutationFence`. The optional caller
 * fence (the agent runner's lease fence) keeps running exactly as before, in
 * both phases; the guard itself acts only on `'before'`. `'library'`-mode
 * operations carry no `stageId` and are skipped by the `stageId` check.
 *
 * Unless `sceneEvents` is `false`, a content write to an editable package stage
 * also sends one `teaching_package.scene_changed` per scene it actually changed —
 * `edited`, `inserted` (a new scene id) or `deleted` — in the same transaction,
 * just before COMMIT (the `'after'` phase), so a failed write sends nothing.
 */
export function teachingPackageStageGuardFence(
  callerFence?: (queryable: Queryable) => Promise<void>,
  options: { sceneEvents?: StageGuardSceneEvents } = {},
): (
  queryable: Queryable,
  operation: GuardedPendingOperation,
  phase: 'before' | 'after',
) => Promise<void> {
  const snapshots = new WeakMap<Queryable, SceneSnapshot>();
  const sceneEvents = options.sceneEvents ?? {};
  return async (queryable, operation, phase) => {
    const contentWrite =
      operation.stageId !== undefined &&
      operation.mode !== 'read' &&
      operation.mode !== 'library' &&
      operation.scope !== 'library';
    if (phase === 'before' && operation.stageId && operation.mode !== 'read') {
      const { editableVersionId } = await assertStageWritable(queryable, {
        stageId: operation.stageId,
        mode: operation.mode === 'library' ? 'mutate' : operation.mode,
        scope: operation.scope,
      });
      // `putScene`'s lookup read writes nothing: no snapshot, no events.
      if (sceneEvents !== false && contentWrite && !operation.lookup && editableVersionId) {
        snapshots.set(
          queryable,
          await snapshotPackageScenes(
            queryable,
            operation.stageId,
            editableVersionId,
            operation.sceneId,
          ),
        );
      }
    }
    if (phase === 'after' && sceneEvents !== false && contentWrite) {
      const before = snapshots.get(queryable);
      snapshots.delete(queryable);
      if (before) await sendSceneChangesSafely(queryable, operation.stageId!, before, sceneEvents);
    }
    await callerFence?.(queryable);
  };
}

/**
 * The edit hook must never fail the write it reports: it runs under a savepoint, and
 * an error rolls back only the events (logged by name/code, never content). The
 * explicit send points (regeneration, insertion, restore, audio) are not wrapped.
 */
async function sendSceneChangesSafely(
  queryable: Queryable,
  stageId: string,
  before: SceneSnapshot,
  events: { actorRef?: string },
): Promise<void> {
  await queryable.query('SAVEPOINT tp_scene_events');
  try {
    await sendSceneChanges(queryable, stageId, before, events);
    await queryable.query('RELEASE SAVEPOINT tp_scene_events');
  } catch (error) {
    await queryable.query('ROLLBACK TO SAVEPOINT tp_scene_events');
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(
      'teaching package scene_changed not enqueued',
      JSON.stringify({
        stageId,
        error: error instanceof Error ? error.name : 'unknown',
        ...(typeof code === 'string' ? { code } : {}),
      }),
    );
  }
}

/** Whether a never-attempted `scene_changed` for this (version, scene, change) is pending. */
async function alreadyPending(
  queryable: Queryable,
  versionId: string,
  sceneId: string,
  change: string,
): Promise<boolean> {
  const result = await queryable.query<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM teaching_package_webhook_deliveries
        WHERE status = 'pending' AND attempts = 0 AND claimed_by IS NULL
          AND event_type = 'teaching_package.scene_changed'
          AND payload->>'versionId' = $1 AND payload->>'sceneId' = $2
          AND payload->>'change' = $3
     ) AS found`,
    [versionId, sceneId, change],
  );
  return result.rows[0]?.found === true;
}

async function sendSceneChanges(
  queryable: Queryable,
  stageId: string,
  before: SceneSnapshot,
  events: { actorRef?: string },
): Promise<void> {
  const after = before.sceneId
    ? await queryable.query<{ id: string; digest: string }>(
        `SELECT id, ${SCENE_DIGEST} AS digest FROM document_scenes
          WHERE stage_id = $1 AND id = $2`,
        [stageId, before.sceneId],
      )
    : await queryable.query<{ id: string; digest: string }>(
        `SELECT id, ${SCENE_DIGEST} AS digest FROM document_scenes
          WHERE stage_id = $1 ORDER BY scene_order, id`,
        [stageId],
      );
  const actorRef = sanitizeSceneEventActorRef(
    events.actorRef ?? `teaching-package-editor:${stageId}`,
  );
  const send = async (sceneId: string, change: 'edited' | 'inserted' | 'deleted') => {
    // Coalesce: the receiver re-reads the scene, so a second identical, not yet
    // attempted event adds nothing.
    if (await alreadyPending(queryable, before.versionId, sceneId, change)) return;
    await enqueueSceneChanged(queryable, {
      versionId: before.versionId,
      stageId,
      sceneId,
      change,
      actorRef,
    });
  };
  const seen = new Set<string>();
  for (const row of after.rows) {
    seen.add(row.id);
    const previous = before.digests.get(row.id);
    if (previous === row.digest) continue;
    await send(row.id, previous === undefined ? 'inserted' : 'edited');
  }
  for (const sceneId of [...before.digests.keys()].sort()) {
    if (!seen.has(sceneId)) await send(sceneId, 'deleted');
  }
}
