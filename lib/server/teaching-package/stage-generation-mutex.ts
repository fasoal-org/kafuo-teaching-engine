/**
 * The Stage-wide paid-generation mutex shared by the reviewer-generated slide
 * insertion and the single-slide regeneration (reviewer-generated-slide plan
 * §11.2–§11.3, §11.7; R2). Both T1 paths take `stage_meta FOR UPDATE` first;
 * under that lock these helpers reclaim the Stage's expired insertion leases
 * and report a running insertion. They live in their own module so neither
 * store's T1 imports the other's.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { appendReviewEvent } from '@/lib/persistence/teaching-package';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';

/**
 * Reclaim every expired running insertion of the Stage: `failed /
 * LEASE_EXPIRED` plus a `scene_insertion_failed` event each. Call under
 * `stage_meta FOR UPDATE` (both T1 paths), or scoped to one row id (the
 * status read's lazy reclaim, which never touches `stage_meta`).
 */
export async function reclaimExpiredSceneInsertions(
  queryable: Queryable,
  where: { stageId: string } | { id: string },
  now: number,
): Promise<number> {
  const result = await queryable.query<{
    id: string;
    version_id: string;
    actor_ref: string;
    reason: string;
    new_scene_id: string;
  }>(
    'id' in where
      ? `UPDATE teaching_package_scene_insertions
            SET status = 'failed', error_code = 'LEASE_EXPIRED', completed_at = $2
          WHERE id = $1 AND status = 'running' AND lease_expires_at <= $2
          RETURNING id, version_id, actor_ref, reason, new_scene_id`
      : `UPDATE teaching_package_scene_insertions
            SET status = 'failed', error_code = 'LEASE_EXPIRED', completed_at = $2
          WHERE stage_id = $1 AND status = 'running' AND lease_expires_at <= $2
          RETURNING id, version_id, actor_ref, reason, new_scene_id`,
    ['id' in where ? where.id : where.stageId, now],
  );
  for (const row of result.rows) {
    const version = await queryable.query<{ status: string }>(
      'SELECT status FROM teaching_package_versions WHERE id = $1',
      [row.version_id],
    );
    const status = (version.rows[0]?.status ?? 'draft') as TeachingPackageStatus;
    await appendReviewEvent(queryable, {
      versionId: row.version_id,
      eventType: 'scene_insertion_failed',
      // An insertion never changes the version's status.
      fromStatus: status,
      toStatus: status,
      actorRef: row.actor_ref,
      reason: row.reason,
      data: {
        insertionId: row.id,
        newSceneId: row.new_scene_id,
        failureCode: 'LEASE_EXPIRED',
        completedAt: now,
      },
      createdAt: now,
    });
  }
  return result.rows.length;
}

/** The Stage's running insertion with a valid lease (after a reclaim: any running one). */
export async function runningSceneInsertionId(
  queryable: Queryable,
  stageId: string,
  now: number,
): Promise<string | null> {
  const result = await queryable.query<{ id: string }>(
    `SELECT id FROM teaching_package_scene_insertions
      WHERE stage_id = $1 AND status = 'running' AND lease_expires_at > $2
      ORDER BY requested_at LIMIT 1`,
    [stageId, now],
  );
  return result.rows[0]?.id ?? null;
}
