/**
 * Context resolution (plan §8.1, FR-001, FR-004, AS-011): subject from the
 * persisted Stage or the governed attempt snapshot; never from text.
 */
import { describe, expect, it, vi } from 'vitest';

import { readSpeechConfig } from '@/lib/server/speech/config';
import { resolveSpeechContext, SpeechContextUnavailableError } from '@/lib/server/speech/speech-context';
import { loadPolicyPack } from '@/lib/speech/scientific/policy';

const policy = loadPolicyPack('ar', { allowProposed: false });
const on = readSpeechConfig({ SCIENTIFIC_TTS_MODE: 'on', SCIENTIFIC_TTS_SUBJECTS: 'MATH,PHYSICS' });

const resolve = (stage: Record<string, unknown> | null, config = on, lookup?: (id: string) => Promise<string | null>) =>
  resolveSpeechContext({ originalText: 'x² = 4', stage, stageId: 'stage-1', config, policy, governedSubjectLookup: lookup });

describe('resolveSpeechContext', () => {
  it('uses the Stage subject and language', async () => {
    const { context, stageSubjectCode } = await resolve({ subjectCode: 'MATH', language: 'ar-SA' });
    expect(context).toMatchObject({ subjectCode: 'MATH', subjectSource: 'stage', language: 'ar-SA', readingMode: 'natural' });
    expect(stageSubjectCode).toBe('MATH');
  });

  it('non-scientific, non-enabled and non-Arabic resolve to the general path', async () => {
    expect((await resolve({ subjectCode: 'BIOLOGY', language: 'ar' })).context.subjectCode).toBeNull();
    expect((await resolve({ subjectCode: 'BIOLOGY', language: 'ar' })).stageSubjectCode).toBe('BIOLOGY');
    expect((await resolve({ subjectCode: 'CHEMISTRY', language: 'ar' })).context.subjectCode).toBeNull();
    expect((await resolve({ subjectCode: 'MATH', language: 'en-US' })).context.subjectCode).toBeNull();
    expect((await resolve({ subjectCode: 'MATH' })).context.subjectCode).toBeNull();
  });

  it('AS-011: a legacy Stage without a subject is general and nothing is inferred from text', async () => {
    const lookup = vi.fn(async () => null);
    const { context } = await resolve({ language: 'ar' }, on, lookup);
    expect(context).toMatchObject({ subjectCode: null, subjectSource: 'none' });
    expect(lookup).toHaveBeenCalledWith('stage-1');
  });

  it('recovers the subject of a legacy governed Stage from the attempt snapshot', async () => {
    const { context } = await resolve({ language: 'ar-SA' }, on, async () => 'PHYSICS');
    expect(context).toMatchObject({ subjectCode: 'PHYSICS', subjectSource: 'governed-attempt' });
  });

  it('with the flag off, never looks anything up', async () => {
    const lookup = vi.fn(async () => 'MATH');
    await resolve({ language: 'ar' }, readSpeechConfig({}), lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a store failure is SATTS_E_CONTEXT_UNAVAILABLE, never a silent general path', async () => {
    await expect(
      resolve({ language: 'ar' }, on, async () => {
        throw new Error('db down');
      }),
    ).rejects.toBeInstanceOf(SpeechContextUnavailableError);
  });

  it('reading mode: accessible only when the Stage says so (D-4b)', async () => {
    expect((await resolve({ subjectCode: 'MATH', language: 'ar', speechReadingMode: 'accessible' })).context.readingMode).toBe('accessible');
    expect((await resolve({ subjectCode: 'MATH', language: 'ar', speechReadingMode: 'bogus' })).context.readingMode).toBe('natural');
  });
});

describe('readSpeechConfig', () => {
  it('defaults to off, MATH, scientific-subjects scope, Cartesia Sonic with Reem (D-4 revised)', () => {
    const config = readSpeechConfig({});
    expect(config).toMatchObject({ mode: 'off', profileScope: 'scientific-subjects', arProvider: 'cartesia-tts', arModel: 'sonic-3.6', arVoice: '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72', arConcurrency: 2 });
    expect([...config.subjects]).toEqual(['MATH']);
    expect(readSpeechConfig({ SCIENTIFIC_TTS_MODE: 'bogus' }).mode).toBe('off');
  });
});
