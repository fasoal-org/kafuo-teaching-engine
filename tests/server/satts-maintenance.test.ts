/**
 * Operator maintenance logic (plan §13.4, §18.2, D-7): revalidation after a
 * policy bump (AS-007), the subject backfill proposal, and the read-only
 * legacy inventory.
 */
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/server/speech/delivery-instructions';
import { inventoryDocument, planSubjectBackfill, revalidateDocument, type MaintenanceDocument } from '@/lib/server/speech/maintenance';
import { renderScientificSpeech } from '@/lib/speech/scientific';
import { loadPolicyPack, type PolicyPack } from '@/lib/speech/scientific/policy';
import type { SpeechAudioProvenance } from '@/lib/types/action';

const base = loadPolicyPack('ar', { allowProposed: true });

/** A policy bump that changes only how the letter y is spoken. */
const bumped: PolicyPack = {
  ...base,
  policyVersion: 'satts-ar-9.0.0',
  // The renderer resolves by role and subject (upgrade plan P2).
  resolve: (query, mode, reading) =>
    query.role === 'variable' && query.token === 'y' && query.domain === 'MATH'
      ? { text: 'ياء', proposed: true }
      : base.resolve(query, mode, reading),
};

function provenanceFor(text: string, policy: PolicyPack): SpeechAudioProvenance {
  const prepared = renderScientificSpeech(
    {
      context: {
        originalText: text,
        subjectCode: 'MATH',
        subjectSource: 'stage',
        language: 'ar-SA',
        readingMode: 'natural',
        policyVersion: policy.policyVersion,
        policyStatus: 'experimental',
      },
    },
    policy,
  ).preparedText;
  return {
    fingerprint: 'fp1:any',
    policyVersion: policy.policyVersion,
    policyStatus: 'experimental',
    originalDigest: sha256Hex(text),
    responseFormat: 'mp3',
    subjectCode: 'MATH',
    language: 'ar-SA',
    readingMode: 'natural',
    providerId: 'openai-tts',
    modelId: 'gpt-4o-mini-tts-2025-12-15',
    voice: 'marin',
    speed: 1,
    preparedDigest: sha256Hex(prepared),
    segments: 1,
    preparedChars: prepared.length,
    originalChars: text.length,
    warningCount: 0,
    generatedAt: '2026-09-28T00:00:00.000Z',
    reason: 'initial',
  };
}

function document(): MaintenanceDocument {
  return {
    stage: { id: 'stage-1', subjectCode: 'MATH', language: 'ar-SA' },
    scenes: [
      {
        id: 'scene-1',
        actions: [
          { id: 'A', type: 'speech', text: 'نحسب y²', audioId: 'a', audioProvenance: provenanceFor('نحسب y²', base) },
          { id: 'B', type: 'speech', text: 'نحسب x²', audioId: 'b', audioProvenance: provenanceFor('نحسب x²', base) },
          { id: 'C', type: 'speech', text: 'بلا صوت' },
          { id: 'D', type: 'speech', text: 'صوت قديم x + 1', audioId: 'legacy' },
        ],
      },
    ],
  };
}

describe('revalidateDocument (AS-007)', () => {
  it('a bump that changes the digest of A only → A stale, B promotable; dry run writes nothing', () => {
    const doc = document();
    const before = JSON.stringify(doc);
    const { report } = revalidateDocument(doc, bumped);
    expect(report.stale).toEqual([{ actionId: 'A', reason: 'prepared' }]);
    expect(report.promotable).toEqual([{ actionId: 'B', from: base.policyVersion, to: 'satts-ar-9.0.0' }]);
    expect(report.skipped).toBe(2);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('apply rewrites only policyVersion on a copy, never the prepared digest or audio', () => {
    const doc = document();
    const { document: applied } = revalidateDocument(doc, bumped, { apply: true });
    const b = applied.scenes[0]!.actions![1] as { audioId: string; audioProvenance: SpeechAudioProvenance };
    expect(b.audioProvenance.policyVersion).toBe('satts-ar-9.0.0');
    expect(b.audioId).toBe('b');
    expect((doc.scenes[0]!.actions![1] as { audioProvenance: SpeechAudioProvenance }).audioProvenance.policyVersion).toBe(base.policyVersion);
  });
});

describe('planSubjectBackfill', () => {
  it('proposes only Stages without a subject whose governed attempt has a well-formed one', async () => {
    const proposals = await planSubjectBackfill(
      [{ id: 's1' }, { id: 's2', subjectCode: 'MATH' }, { id: 's3' }, { id: 's4' }],
      async (id) => ({ s1: 'PHYSICS', s3: null, s4: 'bad code' })[id] ?? null,
    );
    expect(proposals).toEqual([{ stageId: 's1', subjectCode: 'PHYSICS' }]);
  });
});

describe('inventoryDocument (D-7, read-only)', () => {
  it('counts legacy audio and legacy audio with expressions', () => {
    const row = inventoryDocument(document(), 'MATH', base);
    expect(row).toMatchObject({ speechActions: 4, legacyAudioActions: 1, legacyWithExpressions: 1 });
    expect(row!.regenerationChars).toBeGreaterThan(0);
    expect(inventoryDocument(document(), 'BIOLOGY', base)).toBeNull();
  });
});
