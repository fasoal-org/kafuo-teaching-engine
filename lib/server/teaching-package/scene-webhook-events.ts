/**
 * The two scene-level webhook events (Kafuo Agent API plan §1.6, §5, wave B):
 *
 * - `teaching_package.scene_changed` — `{versionId, stageId, sceneId, change, actorRef}`,
 *   enqueued where a package scene write SUCCEEDS: a slide regeneration's commit,
 *   a generated slide's insertion, a regeneration restore and a narration audio
 *   repair (the reviewer's automatic fixes go through the same regeneration and
 *   audio paths, so they emit it too). Every other write to an editable package
 *   stage — editor saves, the generic persistence API, Skill / objective /
 *   alignment edits, agent tools — sends `edited` / `inserted` / `deleted` per
 *   scene whose content changed, from the stage guard (`stage-guard.ts`).
 * - `teaching_package.narration_audio_failed` — `{versionId, stageId, sceneId,
 *   lineIndexes}`, enqueued where a scene carrying `NARRATION_AUDIO_FAILED` is
 *   recorded: package generation's completion and every scene write above.
 *   `lineIndexes` are the 1-based positions among the scene's spoken lines (the
 *   agent read's `narration.lines[].index`) of the lines with no audio — exactly
 *   the lines the mark counts (`narrationAudioGap`).
 *
 * Both are enqueued with `enqueueWebhookEvent` INSIDE the transaction that made
 * the change, so a rolled-back write sends nothing; delivery and signing are the
 * existing outbox's. Ids only — never slide or narration content.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { NARRATION_AUDIO_ISSUE_CODE } from '@/lib/server/teaching-package/narration-audio-issue';
import { enqueueWebhookEvent } from '@/lib/server/teaching-package/webhook-events';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageAggregateKey } from '@/lib/types/teaching-package';

export type SceneChange =
  | 'edited'
  | 'regenerated'
  | 'inserted'
  | 'deleted'
  | 'narration_audio_regenerated'
  | 'restored';

/** 1-based indexes, among the spoken lines, of those with no audio id. */
export function missingAudioLineIndexes(scene: Pick<AppScene, 'actions'>): number[] {
  const indexes: number[] = [];
  let spoken = 0;
  for (const action of scene.actions ?? []) {
    const speech = action as { type?: unknown; text?: unknown; audioId?: unknown };
    if (speech.type !== 'speech' || !speech.text) continue;
    spoken += 1;
    if (!speech.audioId) indexes.push(spoken);
  }
  return indexes;
}

/** Whether the scene carries the narration-audio failure mark. */
export function hasNarrationAudioFailure(scene: Pick<AppScene, 'generationIssues'>): boolean {
  return (scene.generationIssues ?? []).some((issue) => issue.code === NARRATION_AUDIO_ISSUE_CODE);
}

/** The webhook aggregate of a version, read on the caller's transaction. */
async function aggregateOf(tx: Queryable, versionId: string): Promise<TeachingPackageAggregateKey> {
  const result = await tx.query<{
    tenant_id: string;
    learning_item_type: 'lesson' | 'section';
    learning_item_id: string;
  }>(
    `SELECT tenant_id, learning_item_type, learning_item_id
       FROM teaching_package_versions WHERE id = $1`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`teaching package version ${versionId} is missing`);
  return {
    tenantId: row.tenant_id,
    learningItem: { type: row.learning_item_type, id: row.learning_item_id },
  };
}

export async function enqueueSceneChanged(
  tx: Queryable,
  event: {
    versionId: string;
    stageId: string;
    sceneId: string;
    change: SceneChange;
    actorRef: string;
  },
): Promise<void> {
  const aggregate = await aggregateOf(tx, event.versionId);
  await enqueueWebhookEvent(tx, aggregate, 'teaching_package.scene_changed', () => ({
    versionId: event.versionId,
    stageId: event.stageId,
    sceneId: event.sceneId,
    change: event.change,
    actorRef: event.actorRef,
  }));
}

export async function enqueueNarrationAudioFailed(
  tx: Queryable,
  event: { versionId: string; stageId: string; sceneId: string; lineIndexes: number[] },
): Promise<void> {
  const aggregate = await aggregateOf(tx, event.versionId);
  await enqueueWebhookEvent(tx, aggregate, 'teaching_package.narration_audio_failed', () => ({
    versionId: event.versionId,
    stageId: event.stageId,
    sceneId: event.sceneId,
    lineIndexes: [...event.lineIndexes],
  }));
}

/** Enqueue `narration_audio_failed` when the written scene carries the mark (and a line lacks audio). */
export async function enqueueNarrationAudioFailedIfMarked(
  tx: Queryable,
  event: { versionId: string; stageId: string; scene: AppScene },
): Promise<void> {
  if (!hasNarrationAudioFailure(event.scene)) return;
  const lineIndexes = missingAudioLineIndexes(event.scene);
  if (lineIndexes.length === 0) return;
  await enqueueNarrationAudioFailed(tx, {
    versionId: event.versionId,
    stageId: event.stageId,
    sceneId: event.scene.id,
    lineIndexes,
  });
}

/**
 * Package generation's completion: one `narration_audio_failed` per live scene of
 * the new Stage that carries the mark, read on the completion transaction.
 */
export async function enqueueStageNarrationAudioFailures(
  tx: Queryable,
  event: { versionId: string; stageId: string },
): Promise<void> {
  const result = await tx.query<{ data: unknown }>(
    `SELECT data FROM document_scenes
      WHERE stage_id = $1 AND data->'generationIssues' @> $2::jsonb
      ORDER BY scene_order, id`,
    [event.stageId, JSON.stringify([{ code: NARRATION_AUDIO_ISSUE_CODE }])],
  );
  for (const row of result.rows) {
    const scene = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as AppScene;
    await enqueueNarrationAudioFailedIfMarked(tx, { ...event, scene });
  }
}
