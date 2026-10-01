/**
 * The Free Chat query embedding (discovery-first plan P6, §5.4–§5.5).
 *
 * The query is embedded with the SELECTED RUN's `(provider, model, dims)`
 * (from `item_embedding_profile`), so its vector is comparable with the run's
 * stored chunk vectors (RET-01). The direct flow then passes the run ids to
 * `search_units`; this module only embeds.
 *
 *  - Provider allowlist: `openai` today. Anything else is
 *    `embedding_provider_unsupported` (no call is made).
 *  - The OpenAI key and base URL are the server-managed `openai` provider's
 *    (`OPENAI_API_KEY` / `server-providers.yml`), never a client key.
 *  - `dimensions` is sent only for `text-embedding-3*` models (the only ones
 *    that accept it). The caller checks the returned length against `dims`.
 *  - One attempt is bounded by `TUTOR_QUERY_EMBEDDING_TIMEOUT_MS`; ONE retry
 *    runs only on a timeout, network error, 429 or 5xx, and only inside
 *    `TUTOR_QUERY_EMBEDDING_BUDGET_MS` (both well under the turn budget).
 *  - No database connection is held here (the reader released it), and the
 *    text and the vector are never logged (RET-07).
 */
import { createLogger } from '@/lib/logger';
import { resolveApiKey, resolveBaseUrl } from '@/lib/server/provider-config';
import { proxyFetch } from '@/lib/server/proxy-fetch';

import { queryEmbeddingTimeouts } from './grounding-config';
import type {
  QueryEmbedder,
  QueryEmbeddingRequest,
  QueryEmbeddingResult,
} from './kafuo-grounding-reader';

const log = createLogger('QueryEmbedding');

export const EMBEDDING_PROVIDER_ALLOWLIST: ReadonlySet<string> = new Set(['openai']);
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** A retry is not started with less than this left in the budget. */
const MIN_RETRY_WINDOW_MS = 200;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface QueryEmbedderOptions {
  fetch?: FetchLike;
  /** Credentials for the allowlisted provider (default: the server-managed `openai` entry). */
  credentials?: (provider: string) => { apiKey: string; baseUrl?: string };
  timeouts?: () => { attemptTimeoutMs: number; budgetMs: number };
  /** Monotonic ms clock (default `performance.now`). */
  clock?: () => number;
}

class RetryableEmbeddingError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

class FinalEmbeddingError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

function serverCredentials(provider: string): { apiKey: string; baseUrl?: string } {
  return { apiKey: resolveApiKey(provider), baseUrl: resolveBaseUrl(provider) };
}

function supportsDimensions(model: string): boolean {
  return /^text-embedding-3/i.test(model);
}

export function createQueryEmbedder(options: QueryEmbedderOptions = {}): QueryEmbedder {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => proxyFetch(url, init));
  const credentials = options.credentials ?? serverCredentials;
  const timeouts = options.timeouts ?? (() => queryEmbeddingTimeouts());
  const clock = options.clock ?? (() => performance.now());

  async function attempt(
    request: QueryEmbeddingRequest,
    apiKey: string,
    baseUrl: string,
    timeoutMs: number,
  ): Promise<{ vector: number[]; tokens: number | null }> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: request.model,
          input: request.text,
          encoding_format: 'float',
          ...(supportsDimensions(request.model) ? { dimensions: request.dims } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'error';
      throw new RetryableEmbeddingError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableEmbeddingError(`http_${response.status}`);
    }
    if (!response.ok) throw new FinalEmbeddingError(`http_${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FinalEmbeddingError('invalid_body');
    }
    const record = (body ?? {}) as {
      data?: Array<{ embedding?: unknown }>;
      usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
    };
    const embedding = record.data?.[0]?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new FinalEmbeddingError('invalid_body');
    }
    const tokens = record.usage?.prompt_tokens ?? record.usage?.total_tokens;
    return {
      vector: embedding as number[],
      tokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null,
    };
  }

  return {
    async embed(request: QueryEmbeddingRequest): Promise<QueryEmbeddingResult> {
      const provider = request.provider.trim().toLowerCase();
      if (!EMBEDDING_PROVIDER_ALLOWLIST.has(provider)) {
        return { outcome: 'embedding_provider_unsupported' };
      }
      const { apiKey, baseUrl } = credentials(provider);
      if (!apiKey) {
        log.warn(
          JSON.stringify({ event: 'tutor.query_embedding_failed', provider, kind: 'no_api_key' }),
        );
        return { outcome: 'embedding_unavailable' };
      }
      const { attemptTimeoutMs, budgetMs } = timeouts();
      const startedAt = clock();
      let lastKind = 'error';
      for (let tries = 0; tries < 2; tries += 1) {
        const remaining = budgetMs - (clock() - startedAt);
        if (tries > 0 && remaining < MIN_RETRY_WINDOW_MS) break;
        try {
          const result = await attempt(
            request,
            apiKey,
            baseUrl || OPENAI_DEFAULT_BASE_URL,
            Math.max(1, Math.min(attemptTimeoutMs, remaining)),
          );
          return { outcome: 'ok', vector: result.vector, tokens: result.tokens };
        } catch (error) {
          lastKind =
            error instanceof RetryableEmbeddingError || error instanceof FinalEmbeddingError
              ? error.kind
              : 'error';
          if (!(error instanceof RetryableEmbeddingError)) break;
        }
      }
      log.warn(
        JSON.stringify({
          event: 'tutor.query_embedding_failed',
          provider,
          model: request.model,
          kind: lastKind,
        }),
      );
      return { outcome: 'embedding_unavailable' };
    },
  };
}
