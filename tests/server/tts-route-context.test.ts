/**
 * `/api/generate/tts` context resolution (plan §7.2, §15, §17 "Route"):
 * subject from the persisted Stage, never from the body; unauthorised →
 * general; dynamic speech uses a read grant and is not persisted; with the
 * flag off the route reads no Stage and sends today's request.
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

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'نحسب x² + 1',
      audioId: 'audio-1',
      ttsProviderId: 'openai-tts',
      ttsModelId: 'gpt-4o-mini-tts',
      ttsVoice: 'alloy',
      ttsApiKey: 'client-key',
      ...body,
    }),
  });
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/generate/tts/route');
  const response = await POST(request(body));
  return { status: response.status, json: await response.json() };
}

const mathStage = { stage: { subjectCode: 'MATH', language: 'ar-SA' }, access: 'owner', loadDocument: async () => null };

beforeEach(() => {
  vi.resetModules();
  mocks.generateTTS.mockReset().mockImplementation(async () => ({ audio: new Uint8Array([1]), format: 'mp3' }));
  mocks.loadStage.mockReset().mockResolvedValue(mathStage);
  mocks.usage.mockReset();
  delete process.env.TTS_OPENAI_API_KEY;
  delete process.env.TTS_OPENAI_MODELS;
});

afterEach(() => vi.unstubAllEnvs());

describe('SCIENTIFIC_TTS_MODE=off (default)', () => {
  it('reads the Stage (TTS routing); an unrouted Stage sends the original text with today\'s config', async () => {
    mocks.loadStage.mockResolvedValue({ ...mathStage, stage: { subjectCode: 'SOCIAL_STUDIES', language: 'ar-SA' } });
    const { status, json } = await post({ stageId: 'stage-1', actionId: 'a1' });
    expect(status).toBe(200);
    expect(mocks.loadStage).toHaveBeenCalledWith(expect.anything(), 'stage-1', 'write');
    const [config, text] = mocks.generateTTS.mock.calls[0]!;
    expect(text).toBe('نحسب x² + 1');
    expect(config).not.toHaveProperty('instructions');
    expect(config).not.toHaveProperty('streamFormat');
    expect(mocks.usage).toHaveBeenCalledWith({
      kind: 'tts',
      unit: 'character',
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      quantity: 'نحسب x² + 1'.length,
    });
    expect(json).toMatchObject({ audioId: 'audio-1', format: 'mp3' });
    expect(json).not.toHaveProperty('provenance');
  });
});

describe('SCIENTIFIC_TTS_MODE=on', () => {
  beforeEach(() => {
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    // The rendering path; without it the unapproved policy is gated (O-4, below).
    vi.stubEnv('SATTS_ALLOW_EXPERIMENTAL', 'true');
    // The Arabic MATH fixture routes to Qwen Plus (Teaching Engine TTS routing).
    vi.stubEnv('TTS_QWEN_API_KEY', 'server-qwen-key');
  });

  it('O-4: without SATTS_ALLOW_EXPERIMENTAL an unapproved policy sends the narration as authored', async () => {
    vi.stubEnv('SATTS_ALLOW_EXPERIMENTAL', '');
    const { json } = await post({ stageId: 'stage-1', actionId: 'a1' });
    expect(mocks.generateTTS.mock.calls[0]![1]).toBe('نحسب x² + 1');
    expect(json.provenance).toMatchObject({ subjectCode: 'MATH', policyStatus: 'experimental' });
  });

  it('takes the subject from the Stage and renders; a body subject is ignored', async () => {
    const { json } = await post({ stageId: 'stage-1', actionId: 'a1', subjectCode: 'CHEMISTRY', language: 'en' });
    expect(mocks.loadStage).toHaveBeenCalledWith(expect.anything(), 'stage-1', 'write');
    const sent = mocks.generateTTS.mock.calls[0]![1] as string;
    expect(sent).not.toBe('نحسب x² + 1');
    expect(sent).not.toContain('²');
    expect(json.provenance).toMatchObject({ subjectCode: 'MATH', stageSubjectCode: 'MATH' });
    // Usage is measured on what was sent (FR-038).
    expect(mocks.usage.mock.calls[0]![0].quantity).toBe(sent.length);
  });

  it('an unauthorised or unknown Stage runs the general path', async () => {
    mocks.loadStage.mockResolvedValue(null);
    await post({ stageId: 'stage-x' });
    expect(mocks.generateTTS.mock.calls[0]![1]).toBe('نحسب x² + 1');
  });

  it('no stageId (voice preview) keeps the general path', async () => {
    await post({});
    expect(mocks.loadStage).not.toHaveBeenCalled();
    expect(mocks.generateTTS.mock.calls[0]![1]).toBe('نحسب x² + 1');
  });

  it('dynamic speech needs only read access, is subject-aware, and returns no provenance', async () => {
    const { json } = await post({ stageId: 'stage-1', dynamic: true });
    expect(mocks.loadStage).toHaveBeenCalledWith(expect.anything(), 'stage-1', 'read');
    expect(mocks.generateTTS.mock.calls[0]![1]).not.toContain('²');
    expect(json).not.toHaveProperty('provenance');
  });

  it('a Stage store failure fails a persisted request closed, but dynamic speech falls back', async () => {
    const { SpeechContextUnavailableError } = await import('@/lib/server/speech/speech-context');
    mocks.loadStage.mockRejectedValue(new SpeechContextUnavailableError('db down'));
    const persisted = await post({ stageId: 'stage-1' });
    expect(persisted.status).toBe(503);
    expect(persisted.json.errorCode).toBe('SATTS_E_CONTEXT_UNAVAILABLE');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    const dynamic = await post({ stageId: 'stage-1', dynamic: true });
    expect(dynamic.status).toBe(200);
    expect(mocks.generateTTS.mock.calls[0]![1]).toBe('نحسب x² + 1');
  });
});
