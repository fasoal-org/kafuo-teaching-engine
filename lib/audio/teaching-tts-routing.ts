/**
 * Teaching Engine TTS model routing: the one table that picks provider, model
 * and voice from a Stage's language and subject. Pure and client-safe (no I/O,
 * no keys). Every Teaching Engine narration path resolves through it on the
 * server (`lib/server/speech/teaching-route.ts`); voice previews, which have no
 * Stage, are never routed.
 *
 * Precedence (first match wins):
 *   1. English (any language beginning with `en`)  → OpenAI gpt-4o-mini-tts, alloy
 *   2. Arabic + CHEMISTRY                           → Cartesia sonic-3.6, Reem
 *   3. Arabic + MATH | PHYSICS | ARABIC | BIOLOGY   → Qwen qwen-audio-3.0-tts-plus, longanlufeng
 *   otherwise `null`: the caller keeps its current resolution unchanged.
 *
 * A superadmin may instead configure a subject's route (provider + catalogue
 * voice) in the Kafuo admin panel. The Backend sends it in the generation
 * request and the Teaching Engine freezes it on the Stage as `Stage.ttsRoute`
 * (route id `configured`); a persisted route wins over this table (§3.3 of
 * docs/frds/tts-provider-routing-admin-config-plan.md). The table itself is
 * unchanged.
 */
import { TTS_PROVIDERS } from './constants';
import type { BuiltInTTSProviderId } from './types';

export type TeachingTtsRouteId =
  | 'en-openai'
  | 'ar-chemistry-cartesia'
  | 'ar-qwen-plus'
  | 'configured';

export interface TeachingTtsRoute {
  /** Stable identifier for logs and tests. */
  routeId: TeachingTtsRouteId;
  providerId: BuiltInTTSProviderId;
  modelId: string;
  voiceId: string;
  /** Normalised language family of the Stage (sent to providers that take a locale). */
  language: 'en' | 'ar';
}

export const QWEN_AUDIO_PLUS_MODEL_ID = 'qwen-audio-3.0-tts-plus';
export const QWEN_AUDIO_PLUS_VOICE_ID = 'longanlufeng';
/** Cartesia voice "Reem" (D-4, revised 2026-09-29). */
export const CARTESIA_REEM_VOICE_ID = '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72';

const QWEN_PLUS_SUBJECTS: ReadonlySet<string> = new Set(['MATH', 'PHYSICS', 'ARABIC', 'BIOLOGY']);

export function normalizeTeachingLanguage(language: unknown): 'en' | 'ar' | null {
  if (typeof language !== 'string') return null;
  const value = language.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('en')) return 'en';
  return value.split(/[-_]/)[0] === 'ar' ? 'ar' : null;
}

export function normalizeTeachingSubject(subjectCode: unknown): string | null {
  if (typeof subjectCode !== 'string') return null;
  const value = subjectCode.trim().toUpperCase();
  return value || null;
}

export function resolveTeachingTtsRoute(input: {
  language?: unknown;
  subjectCode?: unknown;
}): TeachingTtsRoute | null {
  const language = normalizeTeachingLanguage(input.language);
  if (language === 'en') {
    return {
      routeId: 'en-openai',
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      voiceId: 'alloy',
      language,
    };
  }
  if (language !== 'ar') return null;
  const subject = normalizeTeachingSubject(input.subjectCode);
  if (subject === 'CHEMISTRY') {
    return {
      routeId: 'ar-chemistry-cartesia',
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voiceId: CARTESIA_REEM_VOICE_ID,
      language,
    };
  }
  if (subject && QWEN_PLUS_SUBJECTS.has(subject)) {
    return {
      routeId: 'ar-qwen-plus',
      providerId: 'qwen-tts',
      modelId: QWEN_AUDIO_PLUS_MODEL_ID,
      voiceId: QWEN_AUDIO_PLUS_VOICE_ID,
      language,
    };
  }
  return null;
}

/** The providers a configured route may name: the ones with a server env prefix. */
export const TEACHING_TTS_PROVIDER_IDS = [
  'openai-tts',
  'cartesia-tts',
  'qwen-tts',
] as const satisfies readonly BuiltInTTSProviderId[];

export type TeachingTtsProviderId = (typeof TEACHING_TTS_PROVIDER_IDS)[number];

export function isTeachingTtsProviderId(value: unknown): value is TeachingTtsProviderId {
  return (
    typeof value === 'string' && (TEACHING_TTS_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** One catalogue voice a configured route may use, with the model it speaks with. */
export interface TeachingTtsCatalogVoice {
  id: string;
  name: string;
  language: 'en' | 'ar';
  modelId: string;
}

/**
 * A routable provider's Arabic and English catalogue voices (the static
 * `TTS_PROVIDERS` list, never a provider API). The model follows the voice:
 * its first compatible model, otherwise the provider's default model.
 */
export function teachingTtsCatalogVoices(
  providerId: TeachingTtsProviderId,
): TeachingTtsCatalogVoice[] {
  const provider = TTS_PROVIDERS[providerId];
  return provider.voices.flatMap((voice) => {
    const language = normalizeTeachingLanguage(voice.language);
    if (!language) return [];
    const modelId = voice.compatibleModels?.[0] ?? provider.defaultModelId;
    return [{ id: voice.id, name: voice.name, language, modelId }];
  });
}

/** The catalogue voice `voiceId` of `providerId`, or `null` when either is unknown. */
export function teachingTtsCatalogVoice(
  providerId: unknown,
  voiceId: unknown,
): TeachingTtsCatalogVoice | null {
  if (!isTeachingTtsProviderId(providerId) || typeof voiceId !== 'string') return null;
  return teachingTtsCatalogVoices(providerId).find((voice) => voice.id === voiceId) ?? null;
}

/**
 * The route persisted on a Stage (`Stage.ttsRoute`), or `null` when it is not
 * a catalogue route. The Stage document is client-writable (owner / editor
 * saves), so the stored value is re-checked here: the voice must still be a
 * catalogue voice of its provider in the same language, and the model one the
 * provider lists and the voice speaks with. The model is not required to equal
 * today's derived model, so a later default-model change never silences a
 * frozen lesson; a model removed from the catalogue does fail closed.
 */
export function configuredTeachingTtsRoute(value: unknown): TeachingTtsRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { providerId, modelId, voiceId, language } = record;
  if (record.routeId !== 'configured' || !isTeachingTtsProviderId(providerId)) return null;
  if (typeof modelId !== 'string' || typeof voiceId !== 'string') return null;
  const voice = teachingTtsCatalogVoice(providerId, voiceId);
  if (!voice || voice.language !== language) return null;
  const provider = TTS_PROVIDERS[providerId];
  if (!provider.models.some((model) => model.id === modelId)) return null;
  const compatible = provider.voices.find((entry) => entry.id === voiceId)?.compatibleModels;
  if (compatible && !compatible.includes(modelId)) return null;
  return { routeId: 'configured', providerId, modelId, voiceId, language: voice.language };
}
