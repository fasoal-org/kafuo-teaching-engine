import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { readSpeechConfig } from '@/lib/server/speech/config';
import {
  assessNarrationAudio,
  recordReuse,
  synthesizeNarration,
} from '@/lib/server/speech/narration-synthesis';
import { prepareNarration } from '@/lib/server/speech/prepare';
import { governedSubjectFromStore } from '@/lib/server/speech/speech-context';

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: string[];
}

export interface SceneTtsInput {
  scene: Scene;
  force: boolean;
  roster?: readonly GeneratedAgentConfig[] | null;
  signal?: AbortSignal;
  /** The document Stage: subject, language and reading mode for narration (SATTS §7.3). */
  stage?: Pick<Stage, 'subjectCode' | 'language' | 'speechReadingMode'> | null;
}

function enabledProviderIds(): TTSProviderId[] {
  return Object.entries(getServerTTSProviders())
    .filter(([id, config]) => id !== BROWSER_NATIVE_TTS_PROVIDER_ID && !config.disabled)
    .map(([id]) => id as TTSProviderId);
}

function narratorVoice(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig)?.voiceConfig;
}

/** Server-configured narration synthesis into the stage's classroom-media path. */
export async function synthesizeSceneNarration(input: SceneTtsInput): Promise<SceneTtsSummary> {
  const enabled = enabledProviderIds();
  const bound = narratorVoice(input.roster);
  const providerId = (
    bound?.providerId && enabled.includes(bound.providerId as TTSProviderId)
      ? bound.providerId
      : enabled[0]
  ) as TTSProviderId | undefined;
  if (!providerId) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const apiKey = resolveTTSApiKey(providerId);
  if (provider?.requiresApiKey && !apiKey) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const voice =
    bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || '';
  const modelId =
    resolveTTSModel(
      providerId,
      DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
      voice,
    ) || '';
  let generated = 0;
  let skipped = 0;
  const failed: string[] = [];
  const speechConfig = readSpeechConfig();
  for (const action of input.scene.actions ?? []) {
    if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
    const speech = action as SpeechAction;
    // Today's rule: an Action that already has audio is skipped unless forced.
    // With the scientific flag on, "current" replaces "has audio" (§7.3): legacy
    // audio is still skipped, stale audio is regenerated.
    if (!input.force && speechConfig.mode === 'off' && speech.audioId) {
      skipped += 1;
      continue;
    }
    if (input.signal?.aborted) throw new Error('aborted');
    try {
      const { plan, profile } = await prepareNarration({
        text: speech.text,
        stage: input.stage ?? null,
        stageId: input.scene.stageId,
        config: speechConfig,
        fallback: {
          providerId,
          modelId,
          voice,
          speed: speech.speed ?? 1,
          requestSpeed: speech.speed,
          requestModelId: modelId,
          apiKey,
          baseUrl: resolveTTSBaseUrl(providerId),
        },
        actionSpeed: speech.speed,
        governedSubjectLookup: governedSubjectFromStore,
      });
      if (!input.force && speechConfig.mode !== 'off') {
        const assessment = assessNarrationAudio(speech, plan, profile, speechConfig.mode);
        if (assessment.status === 'current' || assessment.status === 'legacy') {
          recordReuse('agent', speech, plan, assessment.status);
          skipped += 1;
          continue;
        }
      }
      const outcome = await synthesizeNarration({
        action: speech,
        stageId: input.scene.stageId,
        plan,
        profile,
        config: speechConfig,
        reason: input.force ? 'manual' : speech.audioId ? 'stale' : 'initial',
        entry: 'agent',
        persist: { kind: 'media' },
        // Usage on the agent path is not an approved off-mode change (DEC-003).
        recordUsage: speechConfig.mode !== 'off',
        signal: input.signal,
      });
      if (input.signal?.aborted) throw new Error('aborted');
      if (outcome.outcome === 'failed' || !outcome.audioRef) {
        failed.push(action.id);
        continue;
      }
      // The persisted reference is the RELATIVE classroom-media path (the
      // agent runtime has no request origin; relative stays valid on any
      // deployment origin — see classroom-media-bytes.ts). The browser's
      // narration consumers (timeline status/preview, playback, exports)
      // resolve a speech line through the legacy (audioId, audioUrl) pair:
      // `audioId` alone is never resolvable to bytes client-side, while a
      // present `audioUrl` marks the line voiced and is what the audio
      // element / fetch fallback plays. Stamp the same relative path on both.
      speech.audioId = outcome.audioRef;
      (speech as LegacySpeechAction).audioUrl = outcome.audioRef;
      speech.audioProvenance = outcome.provenance;
      generated += 1;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // A hung provider must fail the tool call with the retryable timeout
      // error instead of degrading into a per-action failure: the remaining
      // actions would hit the same hung upstream and the session would wedge.
      if (error instanceof TTSRequestTimeoutError) throw error;
      failed.push(action.id);
    }
  }
  return {
    available: true,
    changed: generated > 0,
    generated,
    skipped,
    failed,
  };
}
