import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Free Chat query embedding (discovery-first P6, §5.5): provider
 * allowlist, the run's model and dims, one budgeted retry on retryable
 * failures only, and no text or vector in any log line.
 */

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const push = (...args: unknown[]) => logs.lines.push(args.map(String).join(' '));
    return { info: push, warn: push, error: push, debug: push };
  },
}));

import { queryEmbeddingTimeouts } from '@/lib/server/tutor/grounding/grounding-config';
import { createQueryEmbedder } from '@/lib/server/tutor/grounding/query-embedding';

const TEXT = 'اشرحلي المثال المضاد سرّي';
const VECTOR = [0.111111, -0.222222, 0.333333, 0.444444];
const REQUEST = { provider: 'openai', model: 'text-embedding-3-small', dims: 4, text: TEXT };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = (vector = VECTOR) => ({
  data: [{ embedding: vector }],
  usage: { prompt_tokens: 9, total_tokens: 9 },
});

function embedderWith(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  timeouts = { attemptTimeoutMs: 1_000, budgetMs: 2_500 },
) {
  const fetch = vi.fn(fetchImpl);
  const embedder = createQueryEmbedder({
    fetch,
    credentials: () => ({ apiKey: 'sk-test', baseUrl: 'https://embeddings.example/v1/' }),
    timeouts: () => timeouts,
  });
  return { fetch, embedder };
}

describe('createQueryEmbedder', () => {
  beforeEach(() => {
    logs.lines.length = 0;
  });

  it('embeds with the run model and dims (dimensions only for text-embedding-3*), returning the vector and tokens', async () => {
    const { fetch, embedder } = embedderWith(async () => json(200, okBody()));
    expect(await embedder.embed(REQUEST)).toEqual({ outcome: 'ok', vector: VECTOR, tokens: 9 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://embeddings.example/v1/embeddings');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-test' });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'text-embedding-3-small',
      input: TEXT,
      encoding_format: 'float',
      dimensions: 4,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    await embedder.embed({ ...REQUEST, model: 'text-embedding-ada-002', dims: 1536 });
    expect(JSON.parse(String(fetch.mock.calls[1]![1].body))).not.toHaveProperty('dimensions');
  });

  it('a provider outside the allowlist is embedding_provider_unsupported, with no call', async () => {
    const { fetch, embedder } = embedderWith(async () => json(200, okBody()));
    expect(await embedder.embed({ ...REQUEST, provider: 'qwen' })).toEqual({
      outcome: 'embedding_provider_unsupported',
    });
    expect(await embedder.embed({ ...REQUEST, provider: 'azure' })).toEqual({
      outcome: 'embedding_provider_unsupported',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('no server key → embedding_unavailable without a call', async () => {
    const fetch = vi.fn();
    const embedder = createQueryEmbedder({ fetch, credentials: () => ({ apiKey: '' }) });
    expect(await embedder.embed(REQUEST)).toEqual({ outcome: 'embedding_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a 503', () => json(503, { error: { message: TEXT } })],
    ['a 429', () => json(429, {})],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('retries ONCE after %s, then succeeds', async (_label, first) => {
    let calls = 0;
    const { fetch, embedder } = embedderWith(async () => {
      calls += 1;
      return calls === 1 ? first() : json(200, okBody());
    });
    expect(await embedder.embed(REQUEST)).toMatchObject({ outcome: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('two retryable failures → embedding_unavailable after exactly two attempts', async () => {
    const { fetch, embedder } = embedderWith(async () => json(500, {}));
    expect(await embedder.embed(REQUEST)).toEqual({ outcome: 'embedding_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 404])('a %i is final: no retry', async (status) => {
    const { fetch, embedder } = embedderWith(async () =>
      json(status, { error: { message: 'bad' } }),
    );
    expect(await embedder.embed(REQUEST)).toEqual({ outcome: 'embedding_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('an attempt is aborted at its timeout; the retry gets only what is left of the budget', async () => {
    const seen: number[] = [];
    const { fetch, embedder } = embedderWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const startedAt = performance.now();
          init.signal!.addEventListener('abort', () => {
            seen.push(performance.now() - startedAt);
            reject(init.signal!.reason);
          });
        }),
      { attemptTimeoutMs: 120, budgetMs: 200 },
    );
    const startedAt = performance.now();
    expect(await embedder.embed(REQUEST)).toEqual({ outcome: 'embedding_unavailable' });
    // 120 ms, then the 80 ms left → never past the budget (plus timer slack).
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(performance.now() - startedAt).toBeLessThan(450);
    expect(seen[0]).toBeGreaterThanOrEqual(100);
  });

  it('an invalid body is final (no retry); the caller checks the length against dims', async () => {
    const { fetch, embedder } = embedderWith(async () =>
      json(200, { data: [{ embedding: ['x'] }] }),
    );
    expect(await embedder.embed(REQUEST)).toEqual({ outcome: 'embedding_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);

    const short = embedderWith(async () => json(200, okBody([0.5, 0.5])));
    expect(await short.embedder.embed(REQUEST)).toMatchObject({
      outcome: 'ok',
      vector: [0.5, 0.5],
    });
  });

  it('never logs the text, the vector or a provider message', async () => {
    const { embedder } = embedderWith(async () =>
      json(503, { error: { message: `echo ${TEXT}` } }),
    );
    await embedder.embed(REQUEST);
    const ok = embedderWith(async () => json(200, okBody()));
    await ok.embedder.embed(REQUEST);
    const all = logs.lines.join('\n');
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(TEXT);
    expect(all).not.toContain('0.111111');
    expect(all).not.toContain('echo');
    expect(JSON.parse(logs.lines[0]!)).toEqual({
      event: 'tutor.query_embedding_failed',
      provider: 'openai',
      model: 'text-embedding-3-small',
      kind: 'http_503',
    });
  });
});

describe('TUTOR_QUERY_EMBEDDING_* timeouts', () => {
  it('default 3000 ms per attempt within a 5000 ms budget; bounded under the 10 s grounding budget', () => {
    expect(queryEmbeddingTimeouts({})).toEqual({ attemptTimeoutMs: 3_000, budgetMs: 5_000 });
    expect(
      queryEmbeddingTimeouts({
        TUTOR_QUERY_EMBEDDING_TIMEOUT_MS: '1500',
        TUTOR_QUERY_EMBEDDING_BUDGET_MS: '2500',
      }),
    ).toEqual({ attemptTimeoutMs: 1_500, budgetMs: 2_500 });
    expect(queryEmbeddingTimeouts({ TUTOR_QUERY_EMBEDDING_TIMEOUT_MS: '60000' })).toEqual({
      attemptTimeoutMs: 3_000,
      budgetMs: 5_000,
    });
    // The budget never undercuts one attempt.
    expect(
      queryEmbeddingTimeouts({
        TUTOR_QUERY_EMBEDDING_TIMEOUT_MS: '4000',
        TUTOR_QUERY_EMBEDDING_BUDGET_MS: '1000',
      }),
    ).toEqual({ attemptTimeoutMs: 4_000, budgetMs: 4_000 });
  });
});
