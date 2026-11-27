/**
 * Audio references and the alignment baseline, shared by the audio repair
 * (`scene-narration-audio.ts`) and the voice a regenerated slide gets before it is saved
 * (`regenerated-scene-voice.ts`). Moved here unchanged from `scene-narration-audio.ts`
 * (25 Nov 2026) so both can use them without an import cycle.
 */
import {
  deriveSceneAlignment,
  sceneMaterialFingerprint,
} from '@/lib/server/teaching-package/alignment';
import type { AppScene } from '@/lib/types/stage';

const AUDIO_FIELDS = ['audioId', 'audioUrl', 'audioProvenance', 'audioInvalidated'] as const;

/** The Scene with every speech Action's audio reference removed. */
export function withoutNarrationAudio(scene: AppScene): AppScene {
  return {
    ...scene,
    actions: (scene.actions ?? []).map((action) => {
      if (action.type !== 'speech') return action;
      const copy = { ...action } as Record<string, unknown>;
      for (const field of AUDIO_FIELDS) delete copy[field];
      return copy as unknown as typeof action;
    }),
  } as AppScene;
}

/**
 * Audio references are part of the material fingerprint (`actions` verbatim),
 * so voicing a line would turn an aligned Scene `stale / material-change` and
 * block Submit although no teaching content changed. When the Scene was
 * aligned before and ONLY audio references differ, its baseline is carried
 * forward with the new fingerprint (origin, actor and time kept). Anything
 * else keeps the baseline untouched.
 */
export function carryAlignmentBaselineForward(before: AppScene, after: AppScene): AppScene {
  const baseline = before.alignmentBaseline;
  if (!baseline || !deriveSceneAlignment(before).aligned) return after;
  if (
    sceneMaterialFingerprint(withoutNarrationAudio(before)) !==
    sceneMaterialFingerprint(withoutNarrationAudio(after))
  ) {
    return after;
  }
  return {
    ...after,
    alignmentBaseline: { ...baseline, fingerprint: sceneMaterialFingerprint(after) },
  };
}
