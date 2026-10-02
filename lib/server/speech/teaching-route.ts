/**
 * Server half of Teaching Engine TTS routing. The route comes from the
 * persisted Stage only (never a request body); credentials come from the
 * server configuration only (never a client key, never sent to a client).
 * A matched route never falls back to another provider: when its provider is
 * disabled or keyless, callers report that instead of picking a different one.
 */
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { resolveTeachingTtsRoute, type TeachingTtsRoute } from '@/lib/audio/teaching-tts-routing';
import {
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import type { StageSpeechFields } from './speech-context';

export type { TeachingTtsRoute } from '@/lib/audio/teaching-tts-routing';

export function teachingRouteForStage(
  stage: Pick<StageSpeechFields, 'language' | 'subjectCode'> | null | undefined,
): TeachingTtsRoute | null {
  if (!stage) return null;
  return resolveTeachingTtsRoute({ language: stage.language, subjectCode: stage.subjectCode });
}

export type RoutedProviderStatus =
  | { status: 'ok'; apiKey?: string; baseUrl?: string }
  | { status: 'disabled' | 'missing-key' };

/** Server-only availability of a routed provider (operator config, never client input). */
export function routedProviderStatus(providerId: string): RoutedProviderStatus {
  if (isServerTTSProviderDisabled(providerId)) return { status: 'disabled' };
  const apiKey = resolveTTSApiKey(providerId);
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (provider?.requiresApiKey && !apiKey) return { status: 'missing-key' };
  return { status: 'ok', apiKey: apiKey || undefined, baseUrl: resolveTTSBaseUrl(providerId) };
}

const ENV_PREFIX: Partial<Record<string, string>> = {
  'openai-tts': 'TTS_OPENAI',
  'cartesia-tts': 'TTS_CARTESIA',
  'qwen-tts': 'TTS_QWEN',
};

/** Operator-facing message for an unavailable routed provider (names the env var, never a value). */
export function routedProviderUnavailableMessage(
  route: TeachingTtsRoute,
  status: 'disabled' | 'missing-key',
): string {
  const where = `Teaching Engine TTS route ${route.routeId} (${route.providerId}/${route.modelId})`;
  if (status === 'disabled') return `${where}: the provider is disabled by the server`;
  const keyVar = ENV_PREFIX[route.providerId]
    ? `${ENV_PREFIX[route.providerId]}_API_KEY`
    : 'the provider API key';
  return `${where}: no server API key configured (${keyVar})`;
}
