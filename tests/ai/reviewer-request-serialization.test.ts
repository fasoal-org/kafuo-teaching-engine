import { createAnthropic } from '@ai-sdk/anthropic';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

import { streamLLM } from '@/lib/ai/llm';
import { getModel, getModelInfo } from '@/lib/ai/providers';
import { ensureTeachingModelAttemptsSchema } from '@/lib/persistence/teaching-model-attempts';
import { executeTeachingStream } from '@/lib/server/teaching-model/execute';
import { REVIEWER_POLICY } from '@/lib/server/teaching-model/reviewer-policy';
import type { ResolvedTarget } from '@/lib/server/teaching-model/resolve-policy';

/**
 * Phase 0 (d) of the AI reviewer layer, proved without a paid call: the exact
 * request bodies the installed SDKs build for the reviewer's two models.
 *
 * Opus 5.5 must carry adaptive thinking (never `disabled`), an explicit
 * `output_config.effort: "high"`, the schema as `output_config.format`
 * (`json_schema`) and NO forced `tool_choice` (a 400 on Opus 5.5), streamed.
 * Sol must carry `reasoning.effort: "high"` on the Responses API.
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

describe('AI reviewer request serialization (ai-reviewer-layer plan §4.2, Phase 0 d)', () => {
  it('Opus 5.5 through the executor: adaptive thinking, effort high, json_schema format, no tool_choice, streamed', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '{"summary":"ok"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]);
    });
    const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fetchMock });
    const opus: ResolvedTarget = {
      role: 'primary',
      modelString: REVIEWER_POLICY.primary.model,
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      model: anthropic.chat('claude-opus-5-5'),
      modelInfo: getModelInfo('anthropic', 'claude-opus-5-5')!,
      thinking: REVIEWER_POLICY.primary.thinking,
      thinkingLabel: 'high',
      counterKind: 'proxy',
    };
    const db = new PGlite();
    await db.waitReady;
    await ensureTeachingModelAttemptsSchema(db as never);

    const result = await executeTeachingStream(
      { subjectCode: 'MATH', policyVersion: 'reviewer-test', primary: opus, fallback: opus },
      {
        tenantId: '1',
        capability: 'package_review',
        stage: 'package-review',
        origin: 'openmaic_runtime',
        association: { kind: 'generation', generationAttemptId: 'ga-1', reviewId: 'tpr-1' },
      },
      {
        system: 'checklist',
        prompt: 'book then slides',
        maxOutputTokens: 1000,
        output: {
          kind: 'json',
          validate: (text) => JSON.parse(text) as unknown,
          jsonSchema: SCHEMA,
        },
      },
      { onDelta() {}, onRestart() {}, onFinish() {} },
      { queryable: db as never, primaryOnly: true, workerId: 'w', idFactory: () => 'tma-1' },
    );

    expect(result.parsed).toEqual({ summary: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(captured?.tool_choice).toBeUndefined();
    expect(captured?.tools).toBeUndefined();
    await db.close();
  });

  it('GPT-6 Sol: Responses API with reasoning.effort high injected at the fetch boundary', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-6-sol' } })}`,
          `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } })}`,
          `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'ok' })}`,
          `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } })}`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } } } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;
    try {
      const { model } = getModel({ providerId: 'openai', modelId: 'gpt-6-sol', apiKey: 'sk-test' });
      const stream = streamLLM(
        { model, prompt: 'hi', maxRetries: 0 } as Parameters<typeof streamLLM>[0],
        'reviewer-serialization-test',
        REVIEWER_POLICY.fallback.thinking,
      );
      let text = '';
      for await (const part of stream.textStream) text += part;
      expect(text).toBe('ok');
      expect(requestUrl).toMatch(/\/responses$/);
      expect(requestBody).toMatchObject({
        model: 'gpt-6-sol',
        stream: true,
        reasoning: { effort: 'high' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
