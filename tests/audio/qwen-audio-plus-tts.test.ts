/**
 * `qwen-audio-3.0-tts-plus` goes to DashScope's SpeechSynthesizer endpoint
 * (international region) with `{ model, input: { text, voice } }` — no
 * `language_type: "Chinese"`, no rate — and its result URL is downloaded and
 * validated like every Qwen result. Qwen3 TTS keeps its request unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generateTTS,
  QwenTTSError,
  TTSInvalidResponseError,
  TTSRateLimitError,
} from '@/lib/audio/tts-providers';

const RESULT_URL = 'https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/tts/out.wav';
const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function audio(
  contentType = 'audio/wav',
  bytes = new Uint8Array([82, 73, 70, 70, 1, 2]),
): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

const plus = {
  providerId: 'qwen-tts' as const,
  modelId: 'qwen-audio-3.0-tts-plus',
  voice: 'longanlufeng',
  apiKey: 'test-key',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  speed: 1.4,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('Qwen-Audio 3.0 TTS Plus', () => {
  it('calls the international SpeechSynthesizer endpoint with the spike request shape', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { output: { audio: { url: RESULT_URL } } }))
      .mockResolvedValueOnce(audio());
    const result = await generateTTS(plus, 'مرحبا بكم');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      model: 'qwen-audio-3.0-tts-plus',
      input: { text: 'مرحبا بكم', voice: 'longanlufeng' },
    });
    expect(JSON.stringify(body)).not.toContain('language_type');
    expect(JSON.stringify(body)).not.toContain('Chinese');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    // The result URL is downloaded through the safe downloader.
    expect(String(fetchMock.mock.calls[1]![0])).toBe(RESULT_URL);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).redirect).toBe('error');
    expect(result).toEqual({ audio: new Uint8Array([82, 73, 70, 70, 1, 2]), format: 'wav' });
  });

  it('uses an operator-configured base URL (TTS_QWEN_BASE_URL) as given', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { output: { audio: { url: RESULT_URL } } }))
      .mockResolvedValueOnce(audio('audio/mpeg'));
    const result = await generateTTS(
      { ...plus, baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1/' },
      'x',
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    );
    expect(result.format).toBe('mp3');
  });

  it('maps HTTP 429 to TTSRateLimitError and other failures to QwenTTSError', async () => {
    fetchMock.mockResolvedValueOnce(json(429, { code: 'Throttling' }));
    await expect(generateTTS(plus, 'x')).rejects.toBeInstanceOf(TTSRateLimitError);
    fetchMock.mockResolvedValueOnce(json(400, { code: 'InvalidParameter' }));
    await expect(generateTTS(plus, 'x')).rejects.toMatchObject({
      name: 'QwenTTSError',
      httpStatus: 400,
    });
  });

  it('rejects a missing audio URL, a disallowed result host and a non-audio download', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { output: {} }));
    await expect(generateTTS(plus, 'x')).rejects.toBeInstanceOf(QwenTTSError);

    fetchMock.mockResolvedValueOnce(
      json(200, { output: { audio: { url: 'https://evil.example.com/a.wav' } } }),
    );
    await expect(generateTTS(plus, 'x')).rejects.toThrow(
      /host "evil\.example\.com" is not allowed/,
    );

    fetchMock
      .mockResolvedValueOnce(json(200, { output: { audio: { url: RESULT_URL } } }))
      .mockResolvedValueOnce(
        new Response('<html>error</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    await expect(generateTTS(plus, 'x')).rejects.toBeInstanceOf(TTSInvalidResponseError);
  });

  it('honours the caller AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return json(200, {});
    });
    await expect(generateTTS({ ...plus, signal: controller.signal }, 'x')).rejects.toThrow();
  });
});

describe('Qwen3 TTS is unchanged', () => {
  it('keeps the multimodal-generation request with language_type and rate', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { output: { audio: { url: RESULT_URL } } }))
      .mockResolvedValueOnce(audio());
    const result = await generateTTS(
      { ...plus, modelId: 'qwen3-tts-flash', voice: 'Cherry', speed: 1.2 },
      'hello',
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model: 'qwen3-tts-flash',
      input: { text: 'hello', voice: 'Cherry', language_type: 'Chinese' },
      parameters: { rate: 100 },
    });
    expect(result.format).toBe('wav');
  });
});
