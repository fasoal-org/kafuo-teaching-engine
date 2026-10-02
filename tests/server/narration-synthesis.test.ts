/**
 * Narration Synthesis Service integration (plan §13, §17): render → segment
 * → synthesise → join → persist → provenance → usage, with the provider mocked.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), usage: vi.fn(), info: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generate,
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));

import { readSpeechConfig } from '@/lib/server/speech/config';
import {
  assessNarrationAudio,
  recordReuse,
  synthesizeNarration,
  type SynthesisRequest,
} from '@/lib/server/speech/narration-synthesis';
import { prepareNarration } from '@/lib/server/speech/prepare';
import type { SpeechAction } from '@/lib/types/action';

/** Synthetic MPEG-2 L3 24 kHz mono frames long enough to pass the plausibility check. */
function mp3For(text: string): Uint8Array {
  const letters = [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  const frames = Math.ceil(letters / 16 / 0.024) + 2;
  const out = new Uint8Array(frames * 384);
  for (let i = 0; i < frames; i += 1) out.set([0xff, 0xf3, 0xc4, 0xc4], i * 384);
  return out;
}

const ON = {
  SCIENTIFIC_TTS_MODE: 'on',
  SCIENTIFIC_TTS_SUBJECTS: 'MATH',
  TTS_AR_PROVIDER: 'openai-tts',
  TTS_AR_MODEL: 'gpt-4o-mini-tts-2025-12-15',
  TTS_AR_VOICE: 'marin',
};
/** Development/testing only (O-4): speak the proposed wording. */
const ON_EXPERIMENTAL = { ...ON, SATTS_ALLOW_EXPERIMENTAL: 'true' };
/** The D-4 default (revised 2026-09-29): Cartesia Sonic 3.6 with "Reem". */
const ON_CARTESIA = { SCIENTIFIC_TTS_MODE: 'on', SCIENTIFIC_TTS_SUBJECTS: 'MATH' };
const stage = { subjectCode: 'MATH', language: 'ar-SA' };
const fallback = { providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', voice: 'alloy', speed: 1, apiKey: 'k' };
const creds = () => ({ available: true, apiKey: 'server-key' });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'satts-'));
  mocks.usage.mockReset();
  mocks.generate.mockReset().mockImplementation(async (_config: unknown, text: string) => ({
    audio: mp3For(text),
    format: 'mp3',
    completed: true,
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
  }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(action: SpeechAction, env: Record<string, string> = ON, overrides: Partial<SynthesisRequest> = {}) {
  const config = readSpeechConfig(env);
  const prepared = await prepareNarration({
    text: action.text,
    stage,
    stageId: 'stage-1',
    config,
    fallback,
    governedCredentials: creds,
    // These tests exercise the TTS_AR_* governed profile itself; Teaching
    // Engine routing (Arabic MATH → Qwen) is covered in tts-route-teaching-routing.
    route: null,
  });
  const outcome = await synthesizeNarration({
    action,
    stageId: 'stage-1',
    plan: prepared.plan,
    profile: prepared.profile,
    config,
    reason: 'initial',
    entry: 'batch',
    persist: { kind: 'audio-dir', rootDir: root },
    recordUsage: true,
    sleep: async () => {},
    ...overrides,
  });
  return { outcome, prepared, config };
}

describe('O-4 readiness gate (upgrade plan P3)', () => {
  it('while the policy is not approved, production sends the narration as authored', async () => {
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب \\frac{x^2}{2} الآن' };
    const { outcome, prepared } = await run(action);
    expect(outcome.outcome).toBe('generated');
    const [config, sent] = mocks.generate.mock.calls[0]!;
    expect(sent).toBe(action.text);
    expect(prepared.plan.path).toBe('scientific');
    expect(prepared.plan.warnings.map((w) => w.code)).toEqual(['SATTS_W_POLICY_NOT_APPROVED']);
    // Still the governed profile and provenance: only the rewriting is withheld.
    expect(config).toMatchObject({ providerId: 'openai-tts', voice: 'marin' });
    expect(outcome.provenance).toMatchObject({ policyStatus: 'experimental', subjectCode: 'MATH' });
  });

  it('SATTS_ALLOW_EXPERIMENTAL=true speaks the proposed wording, logged and stamped experimental', async () => {
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب \\frac{x^2}{2} الآن' };
    mocks.warn.mockClear();
    const { outcome, prepared } = await run(action, ON_EXPERIMENTAL);
    const [, sent] = mocks.generate.mock.calls[0]!;
    expect(sent).not.toContain('\\frac');
    expect(sent).toContain('سين تربيع');
    expect(prepared.plan.policyStatus).toBe('experimental');
    expect(outcome.provenance).toMatchObject({ policyStatus: 'experimental' });
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('SATTS_ALLOW_EXPERIMENTAL'));
  });

  it('the flag is off unless it is exactly `true`', () => {
    expect(readSpeechConfig(ON).allowExperimental).toBe(false);
    expect(readSpeechConfig({ ...ON, SATTS_ALLOW_EXPERIMENTAL: 'yes' }).allowExperimental).toBe(false);
    expect(readSpeechConfig(ON_EXPERIMENTAL).allowExperimental).toBe(true);
  });
});

describe('synthesizeNarration — governed scientific path', () => {
  it('sends the prepared text with the governed profile and never mutates the narration (AS-001)', async () => {
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب \\frac{x^2}{2} الآن' };
    const { outcome } = await run(action, ON_EXPERIMENTAL);
    expect(outcome.outcome).toBe('generated');
    expect(action.text).toBe('نحسب \\frac{x^2}{2} الآن');
    const [config, sent] = mocks.generate.mock.calls[0]!;
    expect(sent).not.toContain('\\frac');
    expect(config).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'marin',
      apiKey: 'server-key',
      responseFormat: 'mp3',
      streamFormat: 'sse',
      requestTimeoutMs: 90_000,
    });
    expect((config as { instructions: string }).instructions).toMatch(/Saudi/);
    expect(outcome.provenance).toMatchObject({
      policyVersion: expect.stringMatching(/^satts-ar-/),
      policyStatus: 'experimental',
      subjectCode: 'MATH',
      stageSubjectCode: 'MATH',
      deliveryProfile: 'ar-SA-saudi-edu-v1',
      modelId: 'gpt-4o-mini-tts-2025-12-15',
      segments: 1,
    });
    expect(outcome.audioRef).toMatch(/^\/api\/classroom-media\/stage-1\/audio\/tts-a1-[A-Za-z0-9_-]{12}\.mp3$/);
    expect(await readdir(join(root, 'stage-1', 'audio'))).toHaveLength(1);
  });

  it('records usage per provider call on the prepared characters, with exact tokens (FR-038)', async () => {
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب x² + 1' };
    const { outcome } = await run(action);
    expect(mocks.usage).toHaveBeenCalledOnce();
    const row = mocks.usage.mock.calls[0]![0];
    expect(row).toMatchObject({ kind: 'tts', unit: 'character', quantity: outcome.usage.preparedChars });
    expect(row.meta).toMatchObject({ inputTokens: 100, outputTokens: 200, estimated: false, entry: 'batch' });
    expect(row.meta.originalChars).toBe(action.text.length);
  });

  it('segments an oversized Action into ordered provider calls and joins one asset (AS-010)', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `ثم نحسب x^{${i}} + y_${i} في الخطوة`).join('، ');
    const { outcome } = await run({ id: 'long', type: 'speech', text }, ON_EXPERIMENTAL);
    expect(mocks.generate.mock.calls.length).toBeGreaterThan(1);
    for (const [, sent] of mocks.generate.mock.calls) expect((sent as string).length).toBeLessThanOrEqual(600);
    expect(outcome.provenance?.segments).toBe(mocks.generate.mock.calls.length);
    expect(await readdir(join(root, 'stage-1', 'audio'))).toHaveLength(1);
  });

  it('retries an incomplete stream once, then fails the Action all-or-nothing (M4, FR-032)', async () => {
    mocks.generate.mockImplementation(async (_c: unknown, text: string) => ({ audio: mp3For(text), format: 'mp3', completed: false }));
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب x²' };
    const { outcome } = await run(action);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ outcome: 'failed', error: { code: 'SATTS_E_PROVIDER_INCOMPLETE' } });
    expect(action).toEqual({ id: 'a1', type: 'speech', text: 'نحسب x²' });
    await expect(readdir(join(root, 'stage-1', 'audio'))).rejects.toThrow();
  });

  it('flags implausibly short audio as truncated (M4)', async () => {
    mocks.generate.mockImplementation(async () => ({ audio: mp3For('ا'), format: 'mp3', completed: true }));
    const { outcome } = await run({ id: 'a1', type: 'speech', text: 'نص طويل جدا '.repeat(20) });
    expect(outcome.error?.code).toBe('SATTS_E_PROVIDER_TRUNCATED');
  });

  it('retries a transient error within the bounded batch policy (B-2)', async () => {
    const { TTSRateLimitError } = await import('@/lib/audio/tts-providers');
    mocks.generate.mockRejectedValueOnce(new TTSRateLimitError('OpenAI', '429'));
    const { outcome } = await run({ id: 'a1', type: 'speech', text: 'نحسب x²' }, ON, { transientAttempts: 2 });
    expect(outcome.outcome).toBe('generated');
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
});

describe('synthesizeNarration — Cartesia default profile (D-4 revised)', () => {
  it('uses Cartesia sonic-3.6 with Reem by default: no instructions, no SSE, Arabic language, mp3', async () => {
    mocks.generate.mockImplementation(async (_config: unknown, text: string) => ({
      audio: mp3For(text),
      format: 'mp3',
    }));
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب x² + 1' };
    const { outcome } = await run(action, ON_CARTESIA);
    expect(outcome.outcome).toBe('generated');
    const [config] = mocks.generate.mock.calls[0]!;
    expect(config).toMatchObject({
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voice: '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72',
      responseFormat: 'mp3',
      language: 'ar-SA',
      requestTimeoutMs: 60_000,
    });
    expect(config).not.toHaveProperty('instructions');
    expect(config).not.toHaveProperty('streamFormat');
    expect(outcome.provenance).toMatchObject({ providerId: 'cartesia-tts', deliveryProfile: null, modelId: 'sonic-3.6' });
    // Per-character usage: no provider token counts, so the row is marked estimated.
    expect(mocks.usage.mock.calls[0]![0].meta).toMatchObject({ estimated: true });
  });

  it('still flags implausibly short audio as truncated without SSE', async () => {
    mocks.generate.mockImplementation(async () => ({ audio: mp3For('ab'), format: 'mp3' }));
    const { outcome } = await run({ id: 'a1', type: 'speech', text: 'نحسب الجذر التربيعي للعدد ستة عشر ثم نضيف إليه خمسة' }, ON_CARTESIA);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.error?.code).toBe('SATTS_E_PROVIDER_TRUNCATED');
  });
});

describe('assessNarrationAudio — reuse and targeted invalidation (FR-022, FR-025, FR-026)', () => {
  it('AS-006: editing one of three Actions makes only that one stale → one provider call', async () => {
    const texts = ['نحسب x²', 'ثم y³', 'وأخيرا z = 1'];
    const actions: SpeechAction[] = [];
    for (const [i, text] of texts.entries()) {
      const action: SpeechAction = { id: `a${i}`, type: 'speech', text };
      const { outcome } = await run(action);
      actions.push({ ...action, audioId: outcome.audioRef, audioProvenance: outcome.provenance });
    }
    mocks.generate.mockClear();
    actions[1] = { ...actions[1]!, text: 'ثم y² فقط' };
    const config = readSpeechConfig(ON);
    let calls = 0;
    for (const action of actions) {
      const { plan, profile } = await prepareNarration({ text: action.text, stage, stageId: 'stage-1', config, fallback, governedCredentials: creds, route: null });
      const assessment = assessNarrationAudio(action, plan, profile, config.mode);
      if (assessment.status === 'current') continue;
      expect(action.id).toBe('a1');
      expect(assessment).toMatchObject({ status: 'stale', reason: 'text' });
      calls += 1;
      await synthesizeNarration({ action, stageId: 'stage-1', plan, profile, config, reason: 'stale', entry: 'batch', persist: { kind: 'audio-dir', rootDir: root }, recordUsage: true });
    }
    expect(calls).toBe(1);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('a voice change marks audio stale with reason voice; legacy and missing are reported', async () => {
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب x²' };
    const { outcome } = await run(action);
    const stored = { ...action, audioId: outcome.audioRef, audioProvenance: outcome.provenance };
    const config = readSpeechConfig({ ...ON, TTS_AR_VOICE: 'cedar' });
    const { plan, profile } = await prepareNarration({ text: action.text, stage, stageId: 'stage-1', config, fallback, governedCredentials: creds, route: null });
    expect(assessNarrationAudio(stored, plan, profile, 'on')).toMatchObject({ status: 'stale', reason: 'voice' });
    expect(assessNarrationAudio({ ...action, audioId: 'x' }, plan, profile, 'on').status).toBe('legacy');
    expect(assessNarrationAudio(action, plan, profile, 'on').status).toBe('missing');
    expect(assessNarrationAudio({ ...stored, audioInvalidated: true }, plan, profile, 'on').status).toBe('missing');
    // Rollback (§18.3): with the flag off, scientific provenance counts as current.
    expect(assessNarrationAudio(stored, plan, profile, 'off').status).toBe('current');
  });
});

describe('SCIENTIFIC_TTS_MODE=off — today\'s request', () => {
  it('sends the original text with today\'s profile: no instructions, no SSE, no format', async () => {
    const action: SpeechAction = { id: 'a1', type: 'speech', text: 'نحسب \\frac{x^2}{2}' };
    await run(action, {});
    const [config, sent] = mocks.generate.mock.calls[0]!;
    expect(sent).toBe('نحسب \\frac{x^2}{2}');
    expect(config).toEqual({ providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', apiKey: 'k', voice: 'alloy', speed: 1, baseUrl: undefined });
  });

  it('shadow renders for diagnostics but still sends the original with today\'s profile', async () => {
    const { outcome, prepared } = await run({ id: 'a1', type: 'speech', text: 'نحسب x²' }, { SCIENTIFIC_TTS_MODE: 'shadow', TTS_AR_VOICE: 'marin' });
    expect(mocks.generate.mock.calls[0]![1]).toBe('نحسب x²');
    expect(prepared.plan.shadowPrepared).toContain('تربيع');
    expect(outcome.provenance?.policyVersion).toBeNull();
  });
});

describe('speech.narration.outcome events (FR-037, plan §16.1)', () => {
  const events = () =>
    mocks.info.mock.calls
      .filter(([name]) => name === 'speech.narration.outcome')
      .map(([, json]) => JSON.parse(json as string) as Record<string, unknown>);

  beforeEach(() => mocks.info.mockReset());

  it('emits one event per Action per pass with the §16.1 fields — generated', async () => {
    await run({ id: 'a1', type: 'speech', text: 'نحسب x²' });
    const [event, ...rest] = events();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      outcome: 'generated',
      reason: 'initial',
      path: 'scientific',
      entry: 'batch',
      subjectCode: 'MATH',
      policyVersion: expect.stringMatching(/^satts-ar-/),
      segments: 1,
      originalChars: 'نحسب x²'.length,
      preparedChars: expect.any(Number),
      warningCodes: expect.any(Array),
    });
  });

  it('failed', async () => {
    mocks.generate.mockImplementation(async (_c: unknown, text: string) => ({ audio: mp3For(text), format: 'mp3', completed: false }));
    await run({ id: 'a1', type: 'speech', text: 'نحسب x²' });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ outcome: 'failed', errorCode: 'SATTS_E_PROVIDER_INCOMPLETE' });
  });

  it('reused and skipped (no provider call)', async () => {
    const config = readSpeechConfig(ON);
    const { plan } = await prepareNarration({ text: 'نحسب x²', stage, stageId: 'stage-1', config, fallback, governedCredentials: creds, route: null });
    recordReuse('batch', { id: 'a1' }, plan, 'current');
    recordReuse('agent', { id: 'a2' }, plan, 'legacy');
    expect(events().map((e) => e.outcome)).toEqual(['reused', 'skipped']);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

