/**
 * Browser side of a reviewer's audio repair of one Scene
 * (scene-narration-audio-regeneration-plan). The same discipline as slide
 * regeneration (scene-regeneration-client.ts):
 *
 *   1 lock X            → beginSceneRegeneration
 *   2 drain             → flushStageSave, then prove X durable (else no POST)
 *   3 hold writes       → this tab's own saves cannot bump X's revision
 *   4 POST              → the server synthesizes and saves under X's revision
 *   5 apply             → replaceSceneFromServer (no dirt, revision recorded)
 *   6 release           → lock + hold lifted, held edits scheduled
 */
import {
  beginSceneRegeneration,
  flushStageSave,
  isSceneDurable,
  replaceSceneFromServer,
  resyncStageScenesFromServer,
  useStageStore,
} from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

/** The generation-issue code this remedy answers. */
export const NARRATION_AUDIO_ISSUE_CODE = 'NARRATION_AUDIO_FAILED';

export function hasNarrationAudioIssue(scene: Pick<Scene, 'generationIssues'>): boolean {
  return (scene.generationIssues ?? []).some((issue) => issue.code === NARRATION_AUDIO_ISSUE_CODE);
}

export type NarrationAudioOutcome =
  /** Every spoken line now has audio; the mark is gone. */
  | { kind: 'success'; generated: number }
  /** Some lines were voiced and saved; `missing` still have no audio. */
  | { kind: 'partial'; generated: number; missing: number }
  /** The slide's pending edits could not be saved first: nothing was sent. */
  | { kind: 'not-durable' }
  | { kind: 'failed'; status: number; code: string; message: string }
  /** The editor moved to another Stage; the late answer was not applied. */
  | { kind: 'stale' };

interface NarrationAudioResponse {
  sceneId: string;
  scene: Scene;
  rev: number;
  generated: number;
  missing: number;
}

export async function runNarrationAudioRegeneration(
  input: { stageId: string; sceneId: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<NarrationAudioOutcome> {
  const { stageId, sceneId } = input;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const handle = beginSceneRegeneration(stageId, sceneId);
  try {
    await flushStageSave().catch(() => {});
    if (!isSceneDurable(stageId, sceneId)) return { kind: 'not-durable' };
    handle.holdWrites();
    let response: Response;
    try {
      response = await fetchImpl(
        `/api/stages/${encodeURIComponent(stageId)}/scenes/${encodeURIComponent(sceneId)}/narration-audio`,
        { method: 'POST', credentials: 'same-origin' },
      );
    } catch (error) {
      return {
        kind: 'failed',
        status: 0,
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      const code = body?.error?.code ?? (response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
      if (code === 'SCENE_REVISION_CONFLICT' && useStageStore.getState().stage?.id === stageId) {
        // Show what the database holds now.
        await resyncStageScenesFromServer(stageId, [sceneId]).catch(() => {});
      }
      return {
        kind: 'failed',
        status: response.status,
        code,
        message: body?.error?.message ?? `the request failed (HTTP ${response.status})`,
      };
    }
    const result = (await response.json()) as NarrationAudioResponse;
    if (useStageStore.getState().stage?.id !== stageId) return { kind: 'stale' };
    replaceSceneFromServer(stageId, result.scene, result.rev);
    return result.missing > 0
      ? { kind: 'partial', generated: result.generated, missing: result.missing }
      : { kind: 'success', generated: result.generated };
  } finally {
    handle.release();
  }
}
