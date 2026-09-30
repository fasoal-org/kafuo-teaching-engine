/** Fingerprint (plan §13.3, FR-024). */
import { describe, expect, it } from 'vitest';

import { computeFingerprint, fingerprintPrefix, type FingerprintInputs } from '@/lib/server/speech/fingerprint';

const base: FingerprintInputs = {
  originalText: 'نحسب x²',
  preparedDigest: 'p',
  subjectCode: 'MATH',
  language: 'ar-SA',
  readingMode: 'natural',
  providerId: 'openai-tts',
  modelId: 'gpt-4o-mini-tts-2025-12-15',
  voice: 'marin',
  speed: 1,
  responseFormat: 'mp3',
  deliveryDigest: 'd',
};

describe('computeFingerprint', () => {
  it('is deterministic and prefixed fp1:', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
    expect(computeFingerprint(base)).toMatch(/^fp1:[A-Za-z0-9_-]{43}$/);
    expect(fingerprintPrefix(computeFingerprint(base))).toHaveLength(12);
  });

  it.each([
    ['originalText', 'نحسب y²'],
    ['preparedDigest', 'q'],
    ['subjectCode', null],
    ['language', 'ar'],
    ['readingMode', 'accessible'],
    ['providerId', 'azure-tts'],
    ['modelId', 'gpt-4o-mini-tts-2025-03-20'],
    ['voice', 'cedar'],
    ['speed', 1.1],
    ['responseFormat', 'wav'],
    ['deliveryDigest', null],
  ] as const)('every material field changes the hash: %s', (field, value) => {
    expect(computeFingerprint({ ...base, [field]: value })).not.toBe(computeFingerprint(base));
  });

  it('non-material fields never change the hash (generatedAt, reason, policyVersion, ids)', () => {
    const withNoise = {
      ...base,
      generatedAt: '2026-09-28T00:00:00.000Z',
      reason: 'manual',
      policyVersion: 'satts-ar-9.9.9',
      stageId: 'stage-x',
      title: 'T',
    } as FingerprintInputs;
    expect(computeFingerprint(withNoise)).toBe(computeFingerprint(base));
  });
});
