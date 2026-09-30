/**
 * O-4 readiness gate, third state (upgrade plan P3): once the policy
 * manifest is approved, the governed path speaks the rendered SATTS wording
 * without any development flag. The manifest cannot be approved in this run
 * (a human gate, P8), so the policy module is mocked to an approved pack.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/speech/scientific/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/speech/scientific/policy')>();
  return {
    ...actual,
    // Every entry usable, reported as an approved production pack.
    loadPolicyPack: (language: string | null, options: Parameters<typeof actual.loadPolicyPack>[1] = {}) => ({
      ...actual.loadPolicyPack(language, { ...options, allowProposed: true }),
      status: 'approved' as const,
      allowProposed: options.allowProposed === true,
    }),
  };
});

import { readSpeechConfig } from '@/lib/server/speech/config';
import { planNarration } from '@/lib/server/speech/narration-synthesis';
import type { SpeechProfile } from '@/lib/server/speech/speech-profile';
import type { SpeechContext } from '@/lib/speech/scientific/context';

const text = 'نحسب \\frac{x^2}{2} الآن';
const context: SpeechContext = {
  originalText: text,
  subjectCode: 'MATH',
  subjectSource: 'stage',
  language: 'ar-SA',
  readingMode: 'natural',
  policyVersion: 'satts-ar-test',
  policyStatus: 'approved',
};
const profile = {
  providerId: 'cartesia-tts',
  modelId: 'sonic-3.6',
  voice: 'reem',
  speed: 1,
  responseFormat: 'mp3',
  capability: null,
  governed: true,
} as unknown as SpeechProfile;

describe('O-4 gate with an approved manifest', () => {
  it('renders the SATTS wording without the development flag, stamped approved', () => {
    const plan = planNarration({
      text,
      context,
      stageSubjectCode: 'MATH',
      profile,
      config: readSpeechConfig({ SCIENTIFIC_TTS_MODE: 'on', SCIENTIFIC_TTS_SUBJECTS: 'MATH' }),
    });
    expect(plan.sentText).not.toContain('\\frac');
    expect(plan.sentText).toContain('سين تربيع');
    expect(plan.policyStatus).toBe('approved');
    expect(plan.warnings.map((w) => w.code)).not.toContain('SATTS_W_POLICY_NOT_APPROVED');
  });
});
