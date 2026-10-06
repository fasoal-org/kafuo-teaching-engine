/**
 * `/api/generate/tts` Teaching Engine TTS routing: provider, model and voice
 * come from the persisted Stage (never the body), in every SCIENTIFIC_TTS_MODE;
 * the routed provider is the one validated and executed; a missing routed key
 * never falls through to another provider; previews without a Stage are not routed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ generateTTS: vi.fn(), loadStage: vi.fn(), usage: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: { ...actual, existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)) },
    existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)),
  };
});
vi.mock('@/lib/audio/tts-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generateTTS,
}));
vi.mock('@/lib/server/speech/stage-access', () => ({ loadStageForSpeech: mocks.loadStage }));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));

const REEM = '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72';

function stageOf(language: string, subjectCode: string) {
  return { stage: { subjectCode, language }, access: 'owner', loadDocument: async () => null };
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/generate/tts/route');
  const response = await POST(
    new NextRequest('http://localhost/api/generate/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'ثم نكمل الدرس',
        audioId: 'audio-1',
        // The client's own selection: a different provider with its own key.
        ttsProviderId: 'elevenlabs-tts',
        ttsModelId: 'eleven_multilingual_v2',
        ttsVoice: 'client-voice',
        ttsApiKey: 'client-key',
        ttsProviderOptions: { voicePrompt: 'client option' },
        ...body,
      }),
    }),
  );
  return { status: response.status, json: await response.json() };
}

function sentConfig() {
  return mocks.generateTTS.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  mocks.generateTTS
    .mockReset()
    .mockImplementation(async () => ({ audio: new Uint8Array([1]), format: 'mp3' }));
  mocks.loadStage.mockReset();
  mocks.usage.mockReset();
  vi.stubEnv('TTS_OPENAI_API_KEY', 'server-openai-key');
  vi.stubEnv('TTS_CARTESIA_API_KEY', 'server-cartesia-key');
  vi.stubEnv('TTS_QWEN_API_KEY', 'server-qwen-key');
});

afterEach(() => vi.unstubAllEnvs());

describe('routing with SCIENTIFIC_TTS_MODE=off (default)', () => {
  it('English Chemistry → OpenAI gpt-4o-mini-tts / alloy, with server credentials only', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('en-US', 'CHEMISTRY'));
    const { status } = await post({ stageId: 'stage-1' });
    expect(status).toBe(200);
    expect(mocks.loadStage).toHaveBeenCalledWith(expect.anything(), 'stage-1', 'write');
    expect(sentConfig()).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      voice: 'alloy',
      apiKey: 'server-openai-key',
    });
    expect(sentConfig()).not.toHaveProperty('providerOptions');
    expect(mocks.usage.mock.calls[0]![0]).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
    });
  });

  it('Arabic Chemistry → Cartesia sonic-3.6 / Reem, with the Arabic language', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'CHEMISTRY'));
    await post({ stageId: 'stage-1' });
    expect(sentConfig()).toMatchObject({
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voice: REEM,
      apiKey: 'server-cartesia-key',
      language: 'ar',
    });
  });

  it('Arabic Math → Qwen qwen-audio-3.0-tts-plus / longanlufeng', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar', 'MATH'));
    await post({ stageId: 'stage-1' });
    expect(sentConfig()).toMatchObject({
      providerId: 'qwen-tts',
      modelId: 'qwen-audio-3.0-tts-plus',
      voice: 'longanlufeng',
      apiKey: 'server-qwen-key',
    });
  });

  it('ignores body language/subjectCode: the persisted Stage decides', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'MATH'));
    await post({ stageId: 'stage-1', language: 'en', subjectCode: 'CHEMISTRY' });
    expect(sentConfig()).toMatchObject({ providerId: 'qwen-tts' });
  });

  it('body language/subjectCode without a Stage route nothing', async () => {
    await post({
      language: 'en',
      subjectCode: 'CHEMISTRY',
      ttsProviderId: 'openai-tts',
      ttsModelId: 'tts-1',
      ttsVoice: 'nova',
    });
    expect(mocks.loadStage).not.toHaveBeenCalled();
    expect(sentConfig()).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'tts-1',
      voice: 'nova',
    });
  });

  it('dynamic discussion uses read access and is routed', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('en', 'MATH'));
    const { json } = await post({ stageId: 'stage-1', dynamic: true });
    expect(mocks.loadStage).toHaveBeenCalledWith(expect.anything(), 'stage-1', 'read');
    expect(sentConfig()).toMatchObject({ providerId: 'openai-tts', voice: 'alloy' });
    expect(json).not.toHaveProperty('provenance');
  });

  it('an unrouted Stage keeps the client provider resolution unchanged', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'SOCIAL_STUDIES'));
    await post({
      stageId: 'stage-1',
      ttsProviderId: 'openai-tts',
      ttsModelId: 'tts-1',
      ttsVoice: 'nova',
    });
    expect(sentConfig()).toMatchObject({
      providerId: 'openai-tts',
      modelId: 'tts-1',
      voice: 'nova',
      apiKey: 'server-openai-key',
    });
  });

  it("a voice preview (no Stage) is never routed and keeps today's request", async () => {
    await post({
      ttsProviderId: 'qwen-tts',
      ttsModelId: 'qwen3-tts-flash',
      ttsVoice: 'Cherry',
      ttsSpeed: 1.5,
    });
    expect(mocks.loadStage).not.toHaveBeenCalled();
    expect(sentConfig()).toMatchObject({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voice: 'Cherry',
      speed: 1.5,
    });
    expect(sentConfig()).not.toHaveProperty('language');
  });

  it('a Stage store failure fails persisted narration closed (it cannot be routed); dynamic falls back', async () => {
    const { SpeechContextUnavailableError } = await import('@/lib/server/speech/speech-context');
    mocks.loadStage.mockRejectedValue(new SpeechContextUnavailableError('db down'));
    const persisted = await post({ stageId: 'stage-1' });
    expect(persisted.status).toBe(503);
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    const dynamic = await post({
      stageId: 'stage-1',
      dynamic: true,
      ttsProviderId: 'openai-tts',
      ttsModelId: 'tts-1',
      ttsVoice: 'nova',
    });
    expect(dynamic.status).toBe(200);
    expect(sentConfig()).toMatchObject({ providerId: 'openai-tts', modelId: 'tts-1', voice: 'nova' });
  });
});

describe('a matched route never falls through to another provider', () => {
  it('missing routed key → MISSING_API_KEY, no synthesis, even though the client provider has a key', async () => {
    vi.stubEnv('TTS_QWEN_API_KEY', '');
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'BIOLOGY'));
    const { status, json } = await post({
      stageId: 'stage-1',
      ttsProviderId: 'openai-tts',
      ttsVoice: 'nova',
    });
    expect(status).toBe(400);
    expect(json.errorCode).toBe('MISSING_API_KEY');
    expect(json.error).toContain('ar-qwen-plus');
    expect(json.error).toContain('TTS_QWEN_API_KEY');
    expect(json.error).not.toContain('server-');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('a disabled routed provider → PROVIDER_DISABLED, no synthesis', async () => {
    vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
    mocks.loadStage.mockResolvedValue(stageOf('en', 'MATH'));
    const { status, json } = await post({ stageId: 'stage-1' });
    expect(status).toBe(403);
    expect(json.errorCode).toBe('PROVIDER_DISABLED');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('a disabled CLIENT provider does not block a routed request', async () => {
    vi.stubEnv('TTS_ELEVENLABS_ENABLED', 'false');
    mocks.loadStage.mockResolvedValue(stageOf('en', 'MATH'));
    const { status } = await post({ stageId: 'stage-1' });
    expect(status).toBe(200);
    expect(sentConfig()).toMatchObject({ providerId: 'openai-tts' });
  });
});

describe('routing with SCIENTIFIC_TTS_MODE=on', () => {
  beforeEach(() => {
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    vi.stubEnv('SCIENTIFIC_TTS_SUBJECTS', 'MATH,PHYSICS,CHEMISTRY');
    // The old global profile would take every Arabic Stage to Cartesia.
    vi.stubEnv('TTS_AR_PROFILE_SCOPE', 'all-arabic');
    vi.stubEnv('TTS_AR_VOICE', 'some-other-cartesia-voice');
  });

  it('the TTS_AR_* profile does not replace the routed Qwen selection; provenance carries the route', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'MATH'));
    const { json } = await post({ stageId: 'stage-1', actionId: 'a1' });
    expect(sentConfig()).toMatchObject({
      providerId: 'qwen-tts',
      modelId: 'qwen-audio-3.0-tts-plus',
      voice: 'longanlufeng',
    });
    expect(json.provenance).toMatchObject({
      providerId: 'qwen-tts',
      modelId: 'qwen-audio-3.0-tts-plus',
      voice: 'longanlufeng',
      subjectCode: 'MATH',
    });
  });

  it('Arabic Chemistry keeps the governed Cartesia shape with the routed Reem voice (not TTS_AR_VOICE)', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'CHEMISTRY'));
    const { json } = await post({ stageId: 'stage-1', actionId: 'a1' });
    expect(sentConfig()).toMatchObject({
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voice: REEM,
      responseFormat: 'mp3',
      language: 'ar-SA',
    });
    expect(json.provenance).toMatchObject({
      providerId: 'cartesia-tts',
      modelId: 'sonic-3.6',
      voice: REEM,
    });
  });

  it('a route change makes the stored audio stale (provider/model/voice are fingerprint inputs)', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'MATH'));
    const qwen = (await post({ stageId: 'stage-1', actionId: 'a1' })).json.provenance;
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'CHEMISTRY'));
    const cartesia = (await post({ stageId: 'stage-1', actionId: 'a1' })).json.provenance;
    expect(qwen.fingerprint).not.toBe(cartesia.fingerprint);
  });

  it('the assess route uses the routed profile, so routed audio is current (not perpetually stale)', async () => {
    mocks.loadStage.mockResolvedValue(stageOf('ar-SA', 'MATH'));
    const { json } = await post({ stageId: 'stage-1', actionId: 'a1' });
    const { POST: assess } = await import('@/app/api/generate/tts/assess/route');
    const response = await assess(
      new NextRequest('http://localhost/api/generate/tts/assess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stageId: 'stage-1',
          // The client's own (unrouted) selection.
          ttsProviderId: 'elevenlabs-tts',
          ttsVoice: 'client-voice',
          actions: [
            { id: 'a1', text: 'ثم نكمل الدرس', audioId: 'ast_1', audioProvenance: json.provenance },
          ],
        }),
      }),
    );
    const body = await response.json();
    expect(body.statuses.a1).toEqual({ status: 'current' });
  });
});
