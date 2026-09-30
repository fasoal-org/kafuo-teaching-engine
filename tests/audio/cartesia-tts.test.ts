import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CARTESIA_API_VERSION, generateTTS } from '@/lib/audio/tts-providers';
import { providerCapability } from '@/lib/server/speech/provider-capabilities';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const REEM = '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72';

function mp3Bytes(): ArrayBuffer {
  // One MPEG-2 Layer III frame header (0xFFF3) is enough for the byte sniff.
  const data = new Uint8Array(32);
  data[0] = 0xff;
  data[1] = 0xf3;
  return data.buffer;
}

function okMp3() {
  const buffer = mp3Bytes();
  return { ok: true, status: 200, arrayBuffer: async () => buffer, headers: { get: () => 'audio/mpeg' } };
}

describe('Cartesia TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts to /tts/bytes with bearer auth, pinned API version, voice id, language and mp3 output', async () => {
    mockFetch.mockResolvedValueOnce(okMp3());

    const result = await generateTTS(
      {
        providerId: 'cartesia-tts',
        apiKey: 'sk-test',
        voice: REEM,
        modelId: 'sonic-3.6',
        language: 'ar-SA',
        responseFormat: 'mp3',
      },
      'مرحبا',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Cartesia-Version': CARTESIA_API_VERSION,
    });
    expect(JSON.parse(init.body)).toEqual({
      model_id: 'sonic-3.6',
      transcript: 'مرحبا',
      voice: { mode: 'id', id: REEM },
      language: 'ar',
      output_format: { container: 'mp3', sample_rate: 24000, bit_rate: 128000 },
      generation_config: { speed: 1 },
    });
    expect(result.format).toBe('mp3');
    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  it('omits language when none is given, clamps speed to the documented 0.6–1.5 range and trims the base URL', async () => {
    mockFetch.mockResolvedValueOnce(okMp3());
    await generateTTS(
      { providerId: 'cartesia-tts', apiKey: 'k', voice: REEM, baseUrl: 'https://example.test/', speed: 3 },
      'x',
    );
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.test/tts/bytes');
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty('language');
    expect(body.generation_config).toEqual({ speed: 1.5 });
    expect(body.model_id).toBe('sonic-3.6');
  });

  it('requires an API key', async () => {
    await expect(generateTTS({ providerId: 'cartesia-tts', voice: REEM }, 'x')).rejects.toThrow(/API key required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces provider errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"invalid voice"}',
      headers: { get: () => 'application/json' },
    });
    await expect(generateTTS({ providerId: 'cartesia-tts', apiKey: 'k', voice: 'nope' }, 'x')).rejects.toThrow(
      /Cartesia TTS API error/,
    );
  });

  it('has a governed capability row for versioned Sonic models only (no instructions, per-character usage)', () => {
    const cap = providerCapability('cartesia-tts', 'sonic-3.6');
    expect(cap).toMatchObject({ supportsInstructions: false, usageSource: 'none', localeParam: 'language' });
    expect(cap!.maxReliableSegmentChars).toBeLessThanOrEqual(cap!.maxInputChars);
    expect(providerCapability('cartesia-tts', 'sonic-latest')).toBeNull();
  });
});
