/**
 * Voice a regenerated or inserted Scene before it is saved (owner, 25 Nov 2026).
 *
 * A single-slide regeneration (and an AI slide insertion) never ran TTS: on a voiced
 * package the new Scene was saved with `NARRATION_AUDIO_FAILED` (D-10/D-11), so every
 * regenerated slide came back under the red "generation had a problem" card and the
 * teacher had to press "Regenerate audio". Teachers read that as a failed
 * regeneration, and a slide nobody re-voiced stayed silent for students.
 *
 * Voicing the CANDIDATE, before the run's own atomic write, keeps one write per
 * regeneration: the saved revision is the regeneration's own (so "Restore previous"
 * still works), and the editor holds the slide's writes only for the run it already
 * waits on. Any failure, or running past the run's deadline, keeps the candidate
 * exactly as before — marked, with the "Regenerate audio" button — and never fails the
 * regeneration. Only an evicted reviewer run (its own signal) stops it as `ABORTED`.
 *
 * Same synthesis as the audio repair (`scene-narration-audio.ts`): the Stage's frozen
 * TTS route, the package build's storage, two transient retries, and a provider error
 * fails only its own line. The alignment baseline the regeneration stamped is carried
 * forward over the audio references, as the audio repair does, so a voiced slide is not
 * "stale" at Submit. Nothing here logs lesson text.
 */
import type { AppStage } from '@/lib/document-store/persistence-types';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { carryAlignmentBaselineForward } from '@/lib/server/teaching-package/narration-audio-alignment';
import {
  NARRATION_AUDIO_ISSUE_CODE,
  issuesAfterAudioRepair,
  narrationAudioGap,
} from '@/lib/server/teaching-package/narration-audio-issue';
import type { AppScene, Scene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('RegeneratedSceneVoice');

/** The most the voice may take, whatever the run's own deadline (a hung provider). */
export const MAX_VOICE_MS = 4 * 60_000;

/** The voice stops this long before the regeneration's or insertion's lease ends. */
export const VOICE_LEASE_MARGIN_MS = 2 * 60_000;

export interface VoiceSceneDeps {
  synthesize?: typeof synthesizeSceneNarration;
  /** An evicted reviewer run's signal: stops the run as `ABORTED`. */
  signal?: AbortSignal;
  /** Epoch ms by which the voice must stop (the run's lease less a margin). */
  deadlineMs?: number;
  now?: () => number;
}

/**
 * The candidate with its spoken lines voiced and its audio mark recomputed, or the
 * candidate itself when it carries no audio mark (an unvoiced package, nothing to
 * say), the voice could not be generated, or the deadline came first.
 */
export async function voiceRegeneratedScene(
  candidate: AppScene,
  stage: Pick<
    AppStage,
    'generatedAgentConfigs' | 'subjectCode' | 'language' | 'speechReadingMode' | 'ttsRoute'
  >,
  deps: VoiceSceneDeps = {},
): Promise<AppScene> {
  if (
    !(candidate.generationIssues ?? []).some((issue) => issue.code === NARRATION_AUDIO_ISSUE_CODE)
  ) {
    return candidate;
  }
  const now = deps.now ?? Date.now;
  const budget = Math.min(MAX_VOICE_MS, (deps.deadlineMs ?? Infinity) - now());
  if (budget <= 0) {
    log.warn(
      `scene ${candidate.id}: no time left to voice the new narration; the audio mark stays`,
    );
    return candidate;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budget);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline.signal]) : deadline.signal;
  const working = structuredClone(candidate);
  try {
    const summary = await (deps.synthesize ?? synthesizeSceneNarration)({
      scene: working as Scene,
      force: false,
      roster: stage.generatedAgentConfigs ?? null,
      stage: {
        subjectCode: stage.subjectCode,
        language: stage.language,
        speechReadingMode: stage.speechReadingMode,
        ...(stage.ttsRoute !== undefined ? { ttsRoute: stage.ttsRoute } : {}),
      },
      persist: { kind: 'audio-dir' },
      transientAttempts: 2,
      entry: 'batch',
      signal,
    });
    if (deadline.signal.aborted && !deps.signal?.aborted) {
      log.warn(`scene ${candidate.id}: the voice ran past its time; the audio mark stays`);
      return candidate;
    }
    if (!summary.available || summary.generated === 0) {
      log.warn(
        `scene ${candidate.id}: the new narration was not voiced (${summary.available ? 'no line voiced' : 'voice provider unavailable'}); the audio mark stays`,
      );
      return candidate;
    }
  } catch (error) {
    if (deps.signal?.aborted) {
      throw new TeachingPackageError(
        'ABORTED',
        'the regeneration was stopped: the review run that asked for it was evicted; nothing was written',
      );
    }
    log.warn(
      `scene ${candidate.id}: the new narration could not be voiced; the audio mark stays`,
      error,
    );
    return candidate;
  } finally {
    clearTimeout(timer);
  }
  if (deps.signal?.aborted) {
    throw new TeachingPackageError(
      'ABORTED',
      'the regeneration was stopped: the review run that asked for it was evicted; nothing was written',
    );
  }
  const gap = narrationAudioGap(working);
  const issues = issuesAfterAudioRepair(working.generationIssues, gap);
  const { generationIssues: _marked, ...rest } = working;
  return carryAlignmentBaselineForward(
    candidate,
    omitUndefinedObjectMembers({
      ...rest,
      ...(issues ? { generationIssues: issues } : {}),
    } as AppScene),
  );
}
