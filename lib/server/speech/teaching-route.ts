/**
 * Server half of Teaching Engine TTS routing. The route comes from the
 * persisted Stage only (never a request body); credentials come from the
 * server configuration only (never a client key, never sent to a client).
 * A matched route never falls back to another provider: when its provider is
 * disabled or keyless, callers report that instead of picking a different one.
 *
 * Precedence (tts-provider-routing-admin-config-plan §3.3): a superadmin's
 * route frozen on the Stage (`Stage.ttsRoute`) first; a malformed one fails
 * closed; otherwise the unchanged table in `lib/audio/teaching-tts-routing.ts`.
 */
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  configuredTeachingTtsRoute,
  resolveTeachingTtsRoute,
  TEACHING_TTS_PROVIDER_IDS,
  teachingTtsCatalogVoices,
  type TeachingTtsCatalogVoice,
  type TeachingTtsProviderId,
  type TeachingTtsRoute,
  type TeachingTtsRouteId,
} from '@/lib/audio/teaching-tts-routing';
import {
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { SUBJECT_CODES } from '@/lib/server/teaching-model/subject-policy';
import type { StageSpeechFields } from './speech-context';

export type { TeachingTtsRoute } from '@/lib/audio/teaching-tts-routing';

/** The Stage's persisted route is present but not well formed: narration is refused. */
export class TeachingTtsRouteInvalidError extends Error {
  readonly code = 'TTS_ROUTE_INVALID';
  constructor() {
    super(
      'the Stage carries a malformed configured TTS route (Stage.ttsRoute); narration is refused rather than moved to another voice',
    );
    this.name = 'TeachingTtsRouteInvalidError';
  }
}

export function teachingRouteForStage(
  stage: Pick<StageSpeechFields, 'language' | 'subjectCode' | 'ttsRoute'> | null | undefined,
): TeachingTtsRoute | null {
  if (!stage) return null;
  if (stage.ttsRoute != null) {
    const configured = configuredTeachingTtsRoute(stage.ttsRoute);
    if (!configured) throw new TeachingTtsRouteInvalidError();
    return configured;
  }
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

/** The env var NAME holding a provider's server key (never its value). */
function keyEnvVarOf(providerId: string): string {
  return ENV_PREFIX[providerId] ? `${ENV_PREFIX[providerId]}_API_KEY` : 'the provider API key';
}

/** Operator-facing message for an unavailable routed provider (names the env var, never a value). */
export function routedProviderUnavailableMessage(
  route: Pick<TeachingTtsRoute, 'routeId' | 'modelId'> & { providerId: string },
  status: 'disabled' | 'missing-key',
): string {
  const where = `Teaching Engine TTS route ${route.routeId} (${route.providerId}/${route.modelId})`;
  if (status === 'disabled') return `${where}: the provider is disabled by the server`;
  return `${where}: no server API key configured (${keyEnvVarOf(route.providerId)})`;
}

export interface TeachingTtsCatalogProvider {
  id: TeachingTtsProviderId;
  name: string;
  available: boolean;
  unavailableReason: 'missing-key' | 'disabled' | null;
  /** The env var name an operator sets on the Teaching Engine; never a key value. */
  keyEnvVar: string;
  voices: TeachingTtsCatalogVoice[];
}

/** Today's table for one subject and language (`routeId: null` = no fixed route). */
export interface TeachingTtsCatalogDefault {
  subjectCode: string;
  language: 'ar' | 'en';
  routeId: TeachingTtsRouteId | null;
  providerId: string | null;
  modelId: string | null;
  voiceId: string | null;
}

export interface TeachingTtsCatalog {
  providers: TeachingTtsCatalogProvider[];
  defaults: TeachingTtsCatalogDefault[];
}

/**
 * The catalogue the Kafuo admin panel picks from (plan §3.1): the routable
 * providers with their server availability, their Arabic and English voices,
 * and today's default table per subject code and language. Secret-free: no
 * key, base URL or env value is read into it.
 */
export function buildTeachingTtsCatalog(): TeachingTtsCatalog {
  const providers = TEACHING_TTS_PROVIDER_IDS.map((id): TeachingTtsCatalogProvider => {
    const { status } = routedProviderStatus(id);
    return {
      id,
      name: TTS_PROVIDERS[id].name,
      available: status === 'ok',
      unavailableReason: status === 'ok' ? null : status,
      keyEnvVar: keyEnvVarOf(id),
      voices: teachingTtsCatalogVoices(id),
    };
  });
  const defaults = SUBJECT_CODES.flatMap((subjectCode) =>
    (['ar', 'en'] as const).map((language): TeachingTtsCatalogDefault => {
      const route = resolveTeachingTtsRoute({ language, subjectCode });
      return {
        subjectCode,
        language,
        routeId: route?.routeId ?? null,
        providerId: route?.providerId ?? null,
        modelId: route?.modelId ?? null,
        voiceId: route?.voiceId ?? null,
      };
    }),
  );
  return { providers, defaults };
}
