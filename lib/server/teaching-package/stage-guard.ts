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
): Promise<void> {
  if (op.scope === 'library') return;
  if (op.mode === 'read') return;

  const references = await readStageReferences(queryable, op.stageId);
  const { versions, retainedDisplaced } = references;
  if (versions.length === 0 && !retainedDisplaced) return;

  if (op.mode === 'delete') {
    throw new TeachingPackageStageLockedError(op.stageId, 'package-owned');
  }

  // mode === 'create' | 'mutate' (| 'library', mapped by the fence composer).
  const lockedBy = versions.find((version) => !isEditableStatus(version.status));
  if (lockedBy) {
    throw new TeachingPackageStageLockedError(op.stageId, lockedBy.status);
  }
  if (retainedDisplaced) {
    throw new TeachingPackageStageLockedError(op.stageId, 'displaced');
  }
}

/** The operation shape the widened owner-bound `mutationFence` receives. */
export interface GuardedPendingOperation {
  stageId?: string;
  mode: StageGuardMode;
  scope: 'content' | 'library';
}

/**
 * Compose the guard into an owner-bound `mutationFence`. The optional caller
 * fence (the agent runner's lease fence) keeps running exactly as before, in
 * both phases; the guard itself acts only on `'before'`. `'library'`-mode
 * operations carry no `stageId` and are skipped by the `stageId` check.
 */
export function teachingPackageStageGuardFence(
  callerFence?: (queryable: Queryable) => Promise<void>,
): (
  queryable: Queryable,
  operation: GuardedPendingOperation,
  phase: 'before' | 'after',
) => Promise<void> {
  return async (queryable, operation, phase) => {
    if (phase === 'before' && operation.stageId && operation.mode !== 'read') {
      await assertStageWritable(queryable, {
        stageId: operation.stageId,
        mode: operation.mode === 'library' ? 'mutate' : operation.mode,
        scope: operation.scope,
      });
    }
    await callerFence?.(queryable);
  };
}
