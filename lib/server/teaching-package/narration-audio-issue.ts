/**
 * The `NARRATION_AUDIO_FAILED` generation issue, as pure functions shared by
 * the reviewer's audio repair and slide/quiz regeneration
 * (scene-narration-audio-regeneration-plan). No TTS or store imports.
 */
import type { SpeechAction } from '@/lib/types/action';
import type { Scene, SceneGenerationIssue } from '@/lib/types/stage';

export const NARRATION_AUDIO_ISSUE_CODE = 'NARRATION_AUDIO_FAILED';

/** Spoken lines (speech Actions with text) and how many of them have no audio. */
export function narrationAudioGap(scene: Pick<Scene, 'actions'>): {
  spoken: number;
  missing: number;
} {
  const spoken = (scene.actions ?? []).filter(
    (action) => action.type === 'speech' && Boolean((action as SpeechAction).text),
  ) as SpeechAction[];
  return { spoken: spoken.length, missing: spoken.filter((action) => !action.audioId).length };
}

/** True when any Scene has a voiced speech line — the package uses TTS. */
export function stageHasNarrationAudio(scenes: readonly Pick<Scene, 'actions'>[]): boolean {
  return scenes.some((scene) =>
    (scene.actions ?? []).some(
      (action) => action.type === 'speech' && Boolean((action as SpeechAction).audioId),
    ),
  );
}

/**
 * The Scene's issues for its current audio: the audio mark is removed when
 * nothing is missing, else (re)stated with the count — the package build's
 * wording (`markNarrationAudioGaps`).
 */
export function issuesAfterAudioRepair(
  issues: readonly SceneGenerationIssue[] | undefined,
  gap: { spoken: number; missing: number },
): SceneGenerationIssue[] | undefined {
  const others = (issues ?? []).filter((issue) => issue.code !== NARRATION_AUDIO_ISSUE_CODE);
  const next =
    gap.missing > 0
      ? [
          ...others,
          {
            code: NARRATION_AUDIO_ISSUE_CODE,
            message: `narration audio could not be generated for ${gap.missing} of ${gap.spoken} spoken line(s); students will not hear the teacher voice there`,
          },
        ]
      : others;
  return next.length > 0 ? next : undefined;
}
