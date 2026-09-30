/**
 * One call that turns (text, Stage, today's profile) into the context, the
 * resolved profile and the narration plan — shared by the route, the batch and
 * the agent runtime so the three paths can no longer diverge (plan §6, R-8).
 */
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { loadPolicyPack } from '@/lib/speech/scientific/policy';
import {
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import type { SpeechConfig } from './config';
import { planNarration, type NarrationPlan } from './narration-synthesis';
import {
  resolveSpeechContext,
  type GovernedSubjectLookup,
  type ResolvedSpeechContext,
  type StageSpeechFields,
} from './speech-context';
import {
  resolveSpeechProfile,
  type FallbackProfile,
  type GovernedCredentials,
  type SpeechProfile,
} from './speech-profile';

/** Server credentials for the governed provider (operator-owned, never client-supplied). */
export function serverGovernedCredentials(providerId: string): GovernedCredentials {
  if (isServerTTSProviderDisabled(providerId)) return { available: false };
  const apiKey = resolveTTSApiKey(providerId);
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (provider?.requiresApiKey && !apiKey) return { available: false };
  return { available: true, apiKey, baseUrl: resolveTTSBaseUrl(providerId) };
}

export interface PreparedNarration extends ResolvedSpeechContext {
  profile: SpeechProfile;
  plan: NarrationPlan;
}

export async function prepareNarration(input: {
  text: string;
  stage: StageSpeechFields | null;
  stageId?: string | null;
  config: SpeechConfig;
  fallback: FallbackProfile;
  actionSpeed?: number;
  governedSubjectLookup?: GovernedSubjectLookup;
  governedCredentials?: (providerId: string) => GovernedCredentials;
  /** Diagnostics/evaluation only (see `planNarration`). */
  allowProposed?: boolean;
}): Promise<PreparedNarration> {
  const resolved = await resolveSpeechContext({
    originalText: input.text,
    stage: input.stage,
    stageId: input.stageId,
    config: input.config,
    policy: loadPolicyPack(null, { allowProposed: input.config.mode !== 'on' }),
    governedSubjectLookup: input.governedSubjectLookup,
  });
  const profile = resolveSpeechProfile({
    context: resolved.context,
    config: input.config,
    fallback: input.fallback,
    actionSpeed: input.actionSpeed,
    governedCredentials: input.governedCredentials ?? serverGovernedCredentials,
  });
  const plan = planNarration({
    text: input.text,
    context: resolved.context,
    stageSubjectCode: resolved.stageSubjectCode,
    profile,
    config: input.config,
    allowProposed: input.allowProposed,
  });
  return { ...resolved, profile, plan };
}
