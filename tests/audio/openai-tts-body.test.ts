/**
 * The exact OpenAI `/audio/speech` request body (plan §17 "Provider body",
 * closes the §4.7 gap). The general path — every call that does not carry the
 * governed profile's fields — must stay byte-identical to the pre-SATTS body.
 * Written against the unmodified provider first, then kept green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateTTS } from '@/lib/audio/tts-providers';

const fetchMock = vi.fn();

function mp3Response() {
  return new Response(new Uint8Array([0xff, 0xf3, 0x44, 0xc4]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => mp3Response());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const sentBody = () => (fetchMock.mock.calls[0]![1] as RequestInit).body as string;

describe('OpenAI TTS request body — general path is byte-identical', () => {
  it('openai-tts: model, input, voice, speed — nothing else', async () => {
    await generateTTS(
      { providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', apiKey: 'k', voice: 'alloy', speed: 1.2 },
      'مرحبا x²',
    );
    expect(sentBody()).toBe(
      '{"model":"gpt-4o-mini-tts","input":"مرحبا x²","voice":"alloy","speed":1.2}',
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/audio/speech');
  });

  it('openai-tts defaults: model alias and speed 1.0 when absent', async () => {
    await generateTTS({ providerId: 'openai-tts', apiKey: 'k', voice: 'marin' }, 'hi');
    expect(sentBody()).toBe('{"model":"gpt-4o-mini-tts","input":"hi","voice":"marin","speed":1}');
  });

  it('a custom OpenAI-compatible provider gets the same shape', async () => {
    await generateTTS(
      {
        providerId: 'custom-tts-local',
        modelId: 'my-model',
        apiKey: 'k',
        baseUrl: 'http://localhost:9999/v1',
        voice: 'v1',
      },
      'text',
    );
    expect(sentBody()).toBe('{"model":"my-model","input":"text","voice":"v1","speed":1}');
  });
});

describe('OpenAI TTS request body — governed profile fields (plan §8.6)', () => {
  const governed = {
    instructions: 'Read aloud.',
    responseFormat: 'mp3' as const,
  };

  it('adds instructions and response_format only for openai-tts + gpt-4o-mini-tts*', async () => {
    await generateTTS(
      { providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts-2025-12-15', apiKey: 'k', voice: 'marin', ...governed },
      'نص',
    );
    expect(sentBody()).toBe(
      '{"model":"gpt-4o-mini-tts-2025-12-15","input":"نص","voice":"marin","speed":1,"instructions":"Read aloud.","response_format":"mp3"}',
    );
  });

  it('never sends instructions to tts-1 or to a custom OpenAI-compatible provider', async () => {
    await generateTTS({ providerId: 'openai-tts', modelId: 'tts-1', apiKey: 'k', voice: 'alloy', instructions: 'x' }, 'a');
    expect(JSON.parse(sentBody())).not.toHaveProperty('instructions');
    fetchMock.mockClear();
    await generateTTS(
      {
        providerId: 'custom-tts-x',
        modelId: 'gpt-4o-mini-tts',
        apiKey: 'k',
        baseUrl: 'http://localhost:1/v1',
        voice: 'v',
        instructions: 'x',
        streamFormat: 'sse',
      },
      'a',
    );
    expect(sentBody()).toBe('{"model":"gpt-4o-mini-tts","input":"a","voice":"v","speed":1}');
  });

  it('SSE mode: joins audio deltas and returns exact usage and completion (M5)', async () => {
    const delta = (bytes: number[]) =>
      `data: {"type":"speech.audio.delta","audio":"${Buffer.from(bytes).toString('base64')}"}\n`;
    const stream =
      delta([1, 2]) +
      delta([3]) +
      'data: {"type":"speech.audio.done","usage":{"input_tokens":117,"output_tokens":236,"total_tokens":353}}\n' +
      'data: [DONE]\n';
    fetchMock.mockImplementationOnce(
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const result = await generateTTS(
      { providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts-2025-12-15', apiKey: 'k', voice: 'marin', streamFormat: 'sse', responseFormat: 'mp3' },
      'نص',
    );
    expect(JSON.parse(sentBody())).toMatchObject({ stream_format: 'sse' });
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      format: 'mp3',
      completed: true,
      usage: { inputTokens: 117, outputTokens: 236, totalTokens: 353 },
    });
  });

  it('SSE mode: a stream cut without speech.audio.done reports completed=false (M4)', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(`data: {"type":"speech.audio.delta","audio":"${Buffer.from([9]).toString('base64')}"}\n`, {
          status: 200,
        }),
    );
    const result = await generateTTS(
      { providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', apiKey: 'k', voice: 'marin', streamFormat: 'sse' },
      'x',
    );
    expect(result.completed).toBe(false);
    expect(result.usage).toBeUndefined();
  });
});
