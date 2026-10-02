/**
 * One call that turns (text, Stage, today's profile) into the context, the
 * resolved profile and the narration plan — shared by the route, the batch and
 * the agent runtime so the three paths can no longer diverge (plan §6, R-8).
 *
 * It is also where the Teaching Engine TTS route applies: when the Stage's
 * language and subject match a route, the routed provider, model and voice
 * (with server credentials only) replace the caller's fallback and the
 * `TTS_AR_*` governed target, in every mode. Missing credentials are not an
 * error here — assessment still needs the routed fingerprint — and synthesis
 * then fails on the routed provider instead of falling through to another.
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
import { teachingRouteForStage, type TeachingTtsRoute } from './teaching-route';

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
  /** The Teaching Engine route applied, or `null` (caller's resolution kept). */
  route: TeachingTtsRoute | null;
}

/**
 * The routed fallback: provider, model and voice from the route; key and base
 * URL from the server only; the caller's speed kept; client provider options
 * (which belong to the client's provider) dropped.
 */
export function routedFallbackProfile(
  route: TeachingTtsRoute,
  fallback: Pick<FallbackProfile, 'speed' | 'requestSpeed'>,
  credentials: (providerId: string) => GovernedCredentials = serverGovernedCredentials,
): FallbackProfile {
  const creds = credentials(route.providerId);
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    requestModelId: route.modelId,
    voice: route.voiceId,
    speed: fallback.speed,
    ...('requestSpeed' in fallback ? { requestSpeed: fallback.requestSpeed } : {}),
    ...(creds.available ? { apiKey: creds.apiKey, baseUrl: creds.baseUrl } : {}),
    locale: route.language,
  };
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
  /**
   * Omitted (every production caller): the Stage's Teaching Engine route.
   * `null`: no routing — unit tests of the `TTS_AR_*` governed profile only.
   */
  route?: TeachingTtsRoute | null;
}): Promise<PreparedNarration> {
  const resolved = await resolveSpeechContext({
    originalText: input.text,
    stage: input.stage,
    stageId: input.stageId,
    config: input.config,
    policy: loadPolicyPack(null, { allowProposed: input.config.mode !== 'on' }),
    governedSubjectLookup: input.governedSubjectLookup,
  });
  const governedCredentials = input.governedCredentials ?? serverGovernedCredentials;
  const route = input.route === undefined ? teachingRouteForStage(input.stage) : input.route;
  const profile = resolveSpeechProfile({
    context: resolved.context,
    config: input.config,
    fallback: route
      ? routedFallbackProfile(route, input.fallback, governedCredentials)
      : input.fallback,
    actionSpeed: input.actionSpeed,
    governedCredentials,
    target: route
      ? { providerId: route.providerId, modelId: route.modelId, voice: route.voiceId }
      : null,
  });
  const plan = planNarration({
    text: input.text,
    context: resolved.context,
    stageSubjectCode: resolved.stageSubjectCode,
    profile,
    config: input.config,
    allowProposed: input.allowProposed,
  });
  return { ...resolved, profile, plan, route };
}
