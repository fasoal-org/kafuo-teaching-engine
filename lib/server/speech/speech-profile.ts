/**
 * One resolution of provider, model, voice, speed, format and delivery per
 * context (plan §12.2, §12.5). The governed Arabic profile is configuration
 * (`TTS_AR_*`), used only with `SCIENTIFIC_TTS_MODE=on`, an Arabic Stage in
 * scope, a pinned model with a capability row, a configured voice and a key.
 * Otherwise the caller's existing per-path resolution is returned unchanged.
 * A Teaching Engine route (`teaching-route.ts`) replaces the `TTS_AR_*`
 * provider, model and voice: the routed values are authoritative either way.
 */
import { isArabicLanguage, type SpeechContext } from '@/lib/speech/scientific/context';
import type { SpeechConfig } from './config';
import { DELIVERY_INSTRUCTIONS_AR_SA_V1, DELIVERY_PROFILE_ID } from './delivery-instructions';
import { providerCapability, type ProviderCapability } from './provider-capabilities';

export interface SpeechProfile {
  providerId: string;
  modelId: string;
  voice: string;
  speed: number;
  /** `null` = provider default (today's request shape). */
  responseFormat: 'mp3' | 'wav' | null;
  instructions: string | null;
  deliveryProfile: string | null;
  governed: boolean;
  capability: ProviderCapability | null;
  apiKey?: string;
  baseUrl?: string;
  providerOptions?: Record<string, unknown>;
  /**
   * The model id exactly as today's caller passed it to the provider (may be
   * `undefined`). Kept so the general path's provider config and usage row
   * stay identical; `modelId` is its fingerprint form.
   */
  requestModelId?: string;
  /** Likewise for speed: today's callers may pass `undefined`. */
  requestSpeed?: number;
  /**
   * Language for providers that take one (Cartesia), outside the governed
   * profile. Set only by a Teaching Engine route; the governed profile uses
   * `TTS_AR_LOCALE`.
   */
  locale?: string;
}

/** Today's resolution for a path (route: client values + pins; batch: pins; agent: roster). */
export type FallbackProfile = Omit<
  SpeechProfile,
  'responseFormat' | 'instructions' | 'deliveryProfile' | 'governed' | 'capability'
>;

export interface GovernedCredentials {
  apiKey?: string;
  baseUrl?: string;
  /** False when the governed provider is disabled or has no key. */
  available: boolean;
}

export function isGovernedScope(context: SpeechContext, config: SpeechConfig): boolean {
  if (config.mode !== 'on' || !isArabicLanguage(context.language)) return false;
  return config.profileScope === 'all-arabic' || context.subjectCode !== null;
}

/** The provider, model and voice the governed profile would use. */
export interface GovernedTarget {
  providerId: string;
  modelId: string;
  voice: string;
}

export function resolveSpeechProfile(input: {
  context: SpeechContext;
  config: SpeechConfig;
  fallback: FallbackProfile;
  /** Action-level speed (governed profile: speed 1.0 unless the Action sets one). */
  actionSpeed?: number;
  governedCredentials: (providerId: string) => GovernedCredentials;
  /** A Teaching Engine route; replaces `TTS_AR_PROVIDER`/`_MODEL`/`_VOICE`. */
  target?: GovernedTarget | null;
}): SpeechProfile {
  const { context, config, fallback } = input;
  const target: GovernedTarget = input.target ?? {
    providerId: config.arProvider,
    modelId: config.arModel,
    voice: config.arVoice,
  };
  const fallbackProfile: SpeechProfile = {
    ...fallback,
    responseFormat: null,
    instructions: null,
    deliveryProfile: null,
    governed: false,
    capability: providerCapability(fallback.providerId, fallback.modelId),
  };
  if (!isGovernedScope(context, config) || !target.voice) return fallbackProfile;
  const capability = providerCapability(target.providerId, target.modelId);
  if (!capability) return fallbackProfile;
  // A pinned snapshot is required where the provider offers one (§12.2).
  if (capability.pinnedModelRequired && !/\d{4}-\d{2}-\d{2}$/.test(target.modelId)) return fallbackProfile;
  const credentials = input.governedCredentials(target.providerId);
  if (!credentials.available) return fallbackProfile;
  const instructions = capability.supportsInstructions ? DELIVERY_INSTRUCTIONS_AR_SA_V1 : null;
  return {
    providerId: target.providerId,
    modelId: target.modelId,
    voice: target.voice,
    speed: input.actionSpeed ?? 1.0,
    responseFormat: 'mp3',
    instructions,
    deliveryProfile: instructions ? DELIVERY_PROFILE_ID : null,
    governed: true,
    capability,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
  };
}
