import { describe, expect, it } from 'vitest';

import { isQwenCloneVoice, TTS_PROVIDERS } from '@/lib/audio/constants';
import { resolveTeachingTtsRoute } from '@/lib/audio/teaching-tts-routing';

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
