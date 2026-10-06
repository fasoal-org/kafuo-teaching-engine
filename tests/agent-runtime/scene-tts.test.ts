import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerTTSProviders: mocks.providers,
  resolveTTSApiKey: vi.fn(() => ''),
  resolveTTSBaseUrl: vi.fn(() => undefined),
  resolveTTSModel: vi.fn(() => ''),
}));

vi.mock('@/lib/audio/tts-providers', () => ({ generateTTS: mocks.generate }));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import type { Scene } from '@/lib/types/stage';

const scene = {
  id: 'scene-a',
  stageId: 'stage-a',
  order: 1,
  title: 'A',
  type: 'slide',
  content: { type: 'slide' },
  actions: [{ id: 'speech-a', type: 'speech', text: 'Hello' }],
} as Scene;

describe('scene TTS capability routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('honors the server capability force-off before synthesis', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': { disabled: true } });
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
    });
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stores generated narration bytes in classroom media', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': {} });
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3');
    const target = structuredClone(scene);
    const summary = await synthesizeSceneNarration({ scene: target, force: false });
    expect(summary).toMatchObject({ available: true, changed: true, generated: 1 });
    // The durable reference is the RELATIVE classroom-media path (origin-
    // independent), stamped on both `audioId` and the legacy `audioUrl` pair
    // the browser's narration consumers resolve (timeline status/preview,
    // playback fetch, exports) — so agent-generated narration is voiced and
    // playable on any deployment origin.
    expect(target.actions?.[0]).toMatchObject({
      audioId: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
      audioUrl: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'stage-a', mime: 'audio/mpeg' }),
    );
  });
});

describe('scene TTS skip rule and provenance (SATTS §7.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providers.mockReturnValue({ 'configured-tts': {} });
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockImplementation(async ({ prefix }: { prefix: string }) => `/api/classroom-media/stage-a/media/${prefix}-h.mp3`);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('flag off: the provider receives exactly the pre-SATTS config (non-OpenAI provider, speed undefined)', async () => {
    await synthesizeSceneNarration({ scene: structuredClone(scene), force: false });
    expect(mocks.generate.mock.calls[0]![0]).toEqual({
      providerId: 'configured-tts',
      modelId: '',
      apiKey: '',
      baseUrl: undefined,
      voice: '',
      speed: undefined,
    });
    expect(mocks.generate.mock.calls[0]![1]).toBe('Hello');
  });

  it('flag off: an Action with audio is skipped exactly as before; new audio gets provenance; prefix unchanged', async () => {
    const withAudio = structuredClone(scene);
    (withAudio.actions![0] as { audioId?: string }).audioId = 'old';
    expect(await synthesizeSceneNarration({ scene: withAudio, force: false })).toMatchObject({ skipped: 1, generated: 0 });
    const fresh = structuredClone(scene);
    await synthesizeSceneNarration({ scene: fresh, force: false });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'tts-speech-a' }));
    expect(fresh.actions![0]).toHaveProperty('audioProvenance.fingerprint');
  });

  it('flag on: legacy audio is kept, stale audio is regenerated, current audio is reused', async () => {
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    const legacy = structuredClone(scene);
    (legacy.actions![0] as { audioId?: string }).audioId = 'old';
    expect(await synthesizeSceneNarration({ scene: legacy, force: false })).toMatchObject({ skipped: 1, generated: 0 });

    const target = structuredClone(scene);
    await synthesizeSceneNarration({ scene: target, force: false, stage: { language: 'ar' } });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(await synthesizeSceneNarration({ scene: target, force: false, stage: { language: 'ar' } })).toMatchObject({ skipped: 1, generated: 0 });
    // A text change makes it stale → regenerated.
    (target.actions![0] as { text: string }).text = 'Hello again';
    expect(await synthesizeSceneNarration({ scene: target, force: false, stage: { language: 'ar' } })).toMatchObject({ generated: 1 });
  });
});
