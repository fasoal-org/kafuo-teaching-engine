/**
 * SATTS feature flags (plan §18.3). Read from the environment on each call so
 * tests and operators can change them without a restart. Everything defaults to
 * today's behaviour: `SCIENTIFIC_TTS_MODE` is `off` unless set.
 */
import {
  SCIENTIFIC_SUBJECT_CODES,
  type ScientificSubjectCode,
} from '@/lib/speech/scientific/context';

export type ScientificTtsMode = 'off' | 'shadow' | 'on';
export type ArabicProfileScope = 'scientific-subjects' | 'all-arabic';

export interface SpeechConfig {
  mode: ScientificTtsMode;
  subjects: ReadonlySet<ScientificSubjectCode>;
  profileScope: ArabicProfileScope;
  arProvider: string;
  arModel: string;
  /** D-4 (revised 2026-09-29): Cartesia "Reem" unless overridden. */
  arVoice: string;
  arLocale: string;
  /** Batch TTS: at most this many Actions synthesise at once (`TTS_AR_CONCURRENCY`, default 6). */
  arConcurrency: number;
  /**
   * Batch TTS: minimum gap between two Action starts (`TTS_BATCH_START_GAP_MS`,
   * default 1000; 0 = no pacing). Keeps a package build near 1 request/second,
   * a third of the Qwen 3 RPS account limit, with no start-up burst.
   */
  batchStartGapMs: number;
  /**
   * Batch TTS: a tighter in-flight cap for a provider whose plan limits concurrent
   * requests. Cartesia defaults to 2 (`TTS_CARTESIA_BATCH_CONCURRENCY`; the Free plan's
   * limit — Pro is 3), so a build never holds a third request it would refuse.
   */
  providerBatchConcurrency: Readonly<Record<string, number>>;
  /**
   * O-4 (upgrade plan P3): while the policy manifest is not approved, the
   * governed path sends the narration as authored. `SATTS_ALLOW_EXPERIMENTAL=true`
   * (development and testing only) speaks the proposed wording instead,
   * logged and stamped `policyStatus: experimental`.
   */
  allowExperimental: boolean;
}

/** D-4 revised 2026-09-29: Cartesia Sonic with the voice "Reem". */
export const DEFAULT_AR_PROVIDER = 'cartesia-tts';
export const DEFAULT_AR_MODEL = 'sonic-3.6';
export const DEFAULT_AR_VOICE = '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72';

export function readSpeechConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SpeechConfig {
  const rawMode = env.SCIENTIFIC_TTS_MODE?.trim().toLowerCase();
  const mode: ScientificTtsMode = rawMode === 'shadow' || rawMode === 'on' ? rawMode : 'off';
  const subjects = new Set<ScientificSubjectCode>();
  for (const part of (env.SCIENTIFIC_TTS_SUBJECTS ?? 'MATH').split(',')) {
    const code = part.trim().toUpperCase();
    if ((SCIENTIFIC_SUBJECT_CODES as readonly string[]).includes(code)) {
      subjects.add(code as ScientificSubjectCode);
    }
  }
  const concurrency = Number(env.TTS_AR_CONCURRENCY);
  const startGap = Number(env.TTS_BATCH_START_GAP_MS?.trim() || NaN);
  const cartesiaCap = Number(env.TTS_CARTESIA_BATCH_CONCURRENCY);
  return {
    mode,
    subjects,
    profileScope: env.TTS_AR_PROFILE_SCOPE?.trim() === 'all-arabic' ? 'all-arabic' : 'scientific-subjects',
    arProvider: env.TTS_AR_PROVIDER?.trim() || DEFAULT_AR_PROVIDER,
    arModel: env.TTS_AR_MODEL?.trim() || DEFAULT_AR_MODEL,
    arVoice: env.TTS_AR_VOICE?.trim() || DEFAULT_AR_VOICE,
    arLocale: env.TTS_AR_LOCALE?.trim() || 'ar-SA',
    arConcurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 6,
    batchStartGapMs: Number.isInteger(startGap) && startGap >= 0 ? startGap : 1000,
    providerBatchConcurrency: {
      'cartesia-tts': Number.isInteger(cartesiaCap) && cartesiaCap > 0 ? cartesiaCap : 2,
    },
    allowExperimental: env.SATTS_ALLOW_EXPERIMENTAL?.trim().toLowerCase() === 'true',
  };
}
