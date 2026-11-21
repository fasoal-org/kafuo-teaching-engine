/**
 * The narration generation issues, as pure functions shared by the package
 * build, the reviewer's audio repair and slide/quiz regeneration
 * (scene-narration-audio-regeneration-plan; clear quiz messages, 21 Nov 2026).
 * No TTS or store imports.
 */
import type { SpeechAction } from '@/lib/types/action';
import type { Scene, SceneGenerationIssue } from '@/lib/types/stage';

export const NARRATION_AUDIO_ISSUE_CODE = 'NARRATION_AUDIO_FAILED';
export const NARRATION_MISSING_ISSUE_CODE = 'NARRATION_MISSING';

/**
 * The narration rule (owner, 21 Nov 2026): a Kafuo slide scene is narrated, so a
 * `slide` scene must hold at least one spoken line. Quiz scenes (a question bank
 * included) are not narrated, and neither are interactive or pbl scenes.
 */
function mustBeNarrated(scene: Pick<Scene, 'type'>): boolean {
  return scene.type === 'slide';
}

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

/** True when a scene that must be narrated holds no spoken line at all (3-4 case). */
export function narrationMissing(scene: Pick<Scene, 'type' | 'actions'>): boolean {
  return mustBeNarrated(scene) && narrationAudioGap(scene).spoken === 0;
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

/**
 * The Scene's issues after its narration was (re)generated: both narration marks
 * are recomputed from the scene as it now stands — a slide that finally speaks
 * loses `NARRATION_MISSING`, one that still does not keeps it, and the audio mark
 * is set exactly as `issuesAfterAudioRepair` sets it. Used by the single-slide
 * regeneration and the audio repair, so a fixed slide is never kept flagged.
 */
export function issuesAfterNarrationRepair(
  issues: readonly SceneGenerationIssue[] | undefined,
  scene: Pick<Scene, 'type' | 'actions'>,
): SceneGenerationIssue[] | undefined {
  const withoutNarration = (issues ?? []).filter(
    (issue) =>
      issue.code !== NARRATION_AUDIO_ISSUE_CODE && issue.code !== NARRATION_MISSING_ISSUE_CODE,
  );
  const next = [...withoutNarration];
  if (narrationMissing(scene)) {
    next.push({
      code: NARRATION_MISSING_ISSUE_CODE,
      message:
        'the slide has no narration at all: no spoken line was generated for it; students would see it in silence',
    });
  }
  const withAudio = issuesAfterAudioRepair(next, narrationAudioGap(scene));
  return withAudio;
}
