import { describe, expect, it } from 'vitest';

import { isQwenCloneVoice, TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  configuredTeachingTtsRoute,
  isTeachingTtsProviderId,
  resolveTeachingTtsRoute,
  TEACHING_TTS_PROVIDER_IDS,
  teachingTtsCatalogVoice,
  teachingTtsCatalogVoices,
} from '@/lib/audio/teaching-tts-routing';

const OPENAI = {
  routeId: 'en-openai',
  providerId: 'openai-tts',
  modelId: 'gpt-4o-mini-tts',
  voiceId: 'alloy',
};
const CARTESIA = {
  routeId: 'ar-chemistry-cartesia',
  providerId: 'cartesia-tts',
  modelId: 'sonic-3.6',
  voiceId: '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72',
};
const QWEN_PLUS = {
  routeId: 'ar-qwen-plus',
  providerId: 'qwen-tts',
  modelId: 'qwen-audio-3.0-tts-plus',
  voiceId: 'longanlufeng',
};

describe('resolveTeachingTtsRoute', () => {
  it.each([
    ['en', 'MATH', OPENAI],
    ['en-US', 'CHEMISTRY', OPENAI],
    ['en-GB', 'ARABIC', OPENAI],
    ['ar', 'CHEMISTRY', CARTESIA],
    ['ar-SA', 'CHEMISTRY', CARTESIA],
    ['ar-SA', 'MATH', QWEN_PLUS],
    ['ar-SA', 'PHYSICS', QWEN_PLUS],
    ['ar-SA', 'ARABIC', QWEN_PLUS],
    ['ar-SA', 'BIOLOGY', QWEN_PLUS],
  ])('%s + %s → %o', (language, subjectCode, expected) => {
    expect(resolveTeachingTtsRoute({ language, subjectCode })).toMatchObject(expected);
  });

  it('English has the highest priority (English Chemistry is OpenAI, not Cartesia)', () => {
    expect(resolveTeachingTtsRoute({ language: 'en', subjectCode: 'CHEMISTRY' })?.providerId).toBe(
      'openai-tts',
    );
    // English needs no subject.
    expect(resolveTeachingTtsRoute({ language: 'en-US' })?.routeId).toBe('en-openai');
  });

  it('normalises case and whitespace of language and subject', () => {
    expect(
      resolveTeachingTtsRoute({ language: '  AR-sa ', subjectCode: ' chemistry ' }),
    ).toMatchObject(CARTESIA);
    expect(resolveTeachingTtsRoute({ language: 'Ar', subjectCode: 'math' })).toMatchObject(
      QWEN_PLUS,
    );
    expect(resolveTeachingTtsRoute({ language: ' EN-us ', subjectCode: 'biology' })).toMatchObject(
      OPENAI,
    );
    expect(resolveTeachingTtsRoute({ language: 'ar_SA', subjectCode: 'Physics' })).toMatchObject(
      QWEN_PLUS,
    );
  });

  it('an unknown subject, a missing language or a non-matching language keeps the current resolution (null)', () => {
    expect(
      resolveTeachingTtsRoute({ language: 'ar-SA', subjectCode: 'SOCIAL_STUDIES' }),
    ).toBeNull();
    expect(resolveTeachingTtsRoute({ language: 'ar-SA', subjectCode: 'ENGLISH' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: 'ar-SA' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: 'ar', subjectCode: '  ' })).toBeNull();
    expect(resolveTeachingTtsRoute({ subjectCode: 'MATH' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: '', subjectCode: 'MATH' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: '   ', subjectCode: 'CHEMISTRY' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: 'fr', subjectCode: 'MATH' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: 'arn', subjectCode: 'MATH' })).toBeNull();
    expect(resolveTeachingTtsRoute({ language: 42, subjectCode: 'MATH' })).toBeNull();
  });

  it('every routed provider, model and voice exists in the registry', () => {
    for (const route of [OPENAI, CARTESIA, QWEN_PLUS]) {
      const provider = TTS_PROVIDERS[route.providerId as keyof typeof TTS_PROVIDERS];
      expect(provider.models.map((m) => m.id)).toContain(route.modelId);
      const voice = provider.voices.find((v) => v.id === route.voiceId);
      expect(voice, `${route.providerId}/${route.voiceId}`).toBeDefined();
      if (voice?.compatibleModels) expect(voice.compatibleModels).toContain(route.modelId);
    }
  });

  it('longanlufeng is a Qwen catalog voice, never a clone', () => {
    expect(isQwenCloneVoice('longanlufeng')).toBe(false);
    const voice = TTS_PROVIDERS['qwen-tts'].voices.find((v) => v.id === 'longanlufeng');
    expect(voice?.compatibleModels).toEqual(['qwen-audio-3.0-tts-plus']);
  });
});

describe('Teaching Engine narration catalogue (superadmin routes, plan §3.1)', () => {
  it('lists exactly the three providers with a server env prefix', () => {
    expect([...TEACHING_TTS_PROVIDER_IDS]).toEqual(['openai-tts', 'cartesia-tts', 'qwen-tts']);
    expect(isTeachingTtsProviderId('cartesia-tts')).toBe(true);
    expect(isTeachingTtsProviderId('elevenlabs-tts')).toBe(false);
    expect(isTeachingTtsProviderId(undefined)).toBe(false);
  });

  it('offers Arabic and English voices only, each with the model the table uses', () => {
    expect(teachingTtsCatalogVoices('cartesia-tts')).toEqual([
      { id: CARTESIA.voiceId, name: 'Reem', language: 'ar', modelId: 'sonic-3.6' },
    ]);
    // Qwen's Mandarin/Cantonese and other-language presets are never offered.
    expect(teachingTtsCatalogVoices('qwen-tts')).toEqual([
      {
        id: 'longanlufeng',
        name: 'Longan Lufeng (longanlufeng)',
        language: 'ar',
        modelId: 'qwen-audio-3.0-tts-plus',
      },
    ]);
    const openai = teachingTtsCatalogVoices('openai-tts');
    expect(openai.every((voice) => voice.language === 'en')).toBe(true);
    expect(openai.find((voice) => voice.id === 'alloy')?.modelId).toBe('gpt-4o-mini-tts');
  });

  it('the catalogue reproduces every table route (provider + voice → the same model)', () => {
    for (const route of [OPENAI, CARTESIA, QWEN_PLUS]) {
      expect(teachingTtsCatalogVoice(route.providerId, route.voiceId)?.modelId).toBe(route.modelId);
    }
  });

  it('an unknown provider or a voice of another provider is not in the catalogue', () => {
    expect(teachingTtsCatalogVoice('elevenlabs-tts', 'any')).toBeNull();
    expect(teachingTtsCatalogVoice('cartesia-tts', 'longanlufeng')).toBeNull();
    expect(teachingTtsCatalogVoice('qwen-tts', 'Cherry')).toBeNull();
    expect(teachingTtsCatalogVoice('openai-tts', 42)).toBeNull();
  });

  it('a client-written Stage route outside the catalogue is refused (the Stage is client-writable)', () => {
    const persisted = {
      routeId: 'configured',
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voiceId: CARTESIA.voiceId,
      language: 'ar',
      settingKey: 'teaching_tts.route.MATH',
    };
    for (const injected of [
      // A Cartesia library voice that is not in the catalogue.
      { ...persisted, voiceId: '00000000-0000-0000-0000-000000000000' },
      // A model the provider does not list.
      { ...persisted, modelId: 'sonic-english' },
      // A listed model the voice does not speak with.
      { ...persisted, providerId: 'qwen-tts', voiceId: 'longanlufeng', modelId: 'qwen3-tts-flash' },
      // The voice's language changed.
      { ...persisted, language: 'en' },
    ]) {
      expect(configuredTeachingTtsRoute(injected), JSON.stringify(injected)).toBeNull();
    }
    // Another model the provider lists, compatible with the voice, stays frozen
    // (a later default-model change must not silence old lessons).
    expect(
      configuredTeachingTtsRoute({
        ...persisted,
        providerId: 'openai-tts',
        voiceId: 'alloy',
        modelId: 'tts-1',
        language: 'en',
      }),
    ).toMatchObject({ providerId: 'openai-tts', modelId: 'tts-1', voiceId: 'alloy' });
  });

  it('reads a well-formed persisted route as frozen and refuses a malformed one', () => {
    const persisted = {
      routeId: 'configured',
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voiceId: CARTESIA.voiceId,
      language: 'ar',
      settingKey: 'teaching_tts.route.MATH',
    };
    expect(configuredTeachingTtsRoute(persisted)).toEqual({
      routeId: 'configured',
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voiceId: CARTESIA.voiceId,
      language: 'ar',
    });
    for (const broken of [
      null,
      'cartesia-tts',
      [],
      { ...persisted, routeId: 'ar-qwen-plus' },
      { ...persisted, providerId: 'elevenlabs-tts' },
      { ...persisted, modelId: '' },
      { ...persisted, voiceId: undefined },
      { ...persisted, language: 'fr' },
    ]) {
      expect(configuredTeachingTtsRoute(broken), JSON.stringify(broken)).toBeNull();
    }
  });
});
