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
 */
import type { BuiltInTTSProviderId } from './types';

export type TeachingTtsRouteId = 'en-openai' | 'ar-chemistry-cartesia' | 'ar-qwen-plus';

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
