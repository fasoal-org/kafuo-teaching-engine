/**
 * `scripts/load/free-chat-sse-load.ts` (discovery-first P10): the stats helpers, the
 * incremental SSE parser, the never-by-default argument guard and the stub's payloads.
 * Nothing here opens a socket.
 */
import { describe, expect, it } from 'vitest';

import {
  main,
  parseLoadArgs,
  stubChatChunks,
  stubEmbedding,
} from '@/scripts/load/free-chat-sse-load';
import {
  aggregateTurns,
  newTurnRecord,
  observeFrame,
  percentile,
  SseFrameParser,
  summarize,
  type TurnRecord,
} from '@/scripts/load/free-chat-sse-stats';

describe('percentile / summarize', () => {
  it('interpolates between closest ranks like the Python benchmarks', () => {
    expect(percentile([40, 10, 20, 30], 50)).toBe(25);
    expect(percentile([1], 95)).toBe(1);
    expect(percentile([], 95)).toBeNull();
    expect(percentile([0, 100], 95)).toBe(95);
  });

  it('summarises with n, p50, p95, p99, max and mean', () => {
    expect(summarize([10, 20, 30, 40, 50])).toEqual({ n: 5, p50: 30, p95: 48, p99: 49.6, max: 50, mean: 30 });
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, p99: null, max: null, mean: null });
  });
});

describe('SseFrameParser', () => {
  it('reassembles frames split anywhere across chunks', () => {
    const parser = new SseFrameParser();
    const wire = 'event: turn_start\ndata: {"turnId":"t1","turnAttempt":1}\n\nevent: text_delta\ndata: {"delta":"مرحبا"}\n\n';
    const frames = [];
    for (let i = 0; i < wire.length; i += 7) frames.push(...parser.push(wire.slice(i, i + 7)));
    expect(frames).toEqual([
      { event: 'turn_start', data: { turnId: 't1', turnAttempt: 1 } },
      { event: 'text_delta', data: { delta: 'مرحبا' } },
    ]);
  });

  it('handles CRLF, a CR split from its LF, heartbeats and multi-line data', () => {
    const parser = new SseFrameParser();
    const frames = [
      ...parser.push(':heartbeat\r\n\r\nevent: grounding\r\ndata: {"mode":'),
      ...parser.push('"retrieved"}\r'),
      ...parser.push('\n\r\nevent: note\ndata: line one\ndata: line two\n\n'),
    ];
    expect(frames).toEqual([
      { event: 'grounding', data: { mode: 'retrieved' } },
      { event: 'note', data: 'line one\nline two' },
    ]);
  });

  it('flushes a final frame that lacks its blank line', () => {
    const parser = new SseFrameParser();
    expect(parser.push('event: done\ndata: {"servedBy":"primary"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'done', data: { servedBy: 'primary' } }]);
    expect(parser.flush()).toEqual([]);
  });
});

function turn(frames: Array<[string, unknown, number]>, source = 'direct'): TurnRecord {
  const record = newTurnRecord(source, 'baseline', 0);
  for (const [event, data, at] of frames) observeFrame(record, { event, data }, at);
  return record;
}

describe('observeFrame', () => {
  it('takes TTFT from the first text_delta and total from done, not from a later title', () => {
    const record = turn([
      ['turn_start', { turnId: 't' }, 5],
      ['grounding', { mode: 'retrieved' }, 40],
      ['text_delta', { delta: 'a' }, 450],
      ['text_delta', { delta: 'b' }, 470],
      ['done', { servedBy: 'primary' }, 900],
      ['title', { title: 'x' }, 1400],
    ]);
    expect(record).toMatchObject({
      status: 'done',
      turnStartMs: 5,
      groundingMs: 40,
      groundingMode: 'retrieved',
      ttftMs: 450,
      totalMs: 900,
      deltaCount: 2,
      servedBy: 'primary',
    });
  });

  it('records a restart and an error event with its code', () => {
    const record = turn([
      ['grounding', { mode: 'insufficient', reason: 'retrieval_unavailable' }, 30],
      ['text_delta', { delta: 'a' }, 300],
      ['restart', { servedBy: 'fallback' }, 320],
      ['error', { code: 'TEACHING_MODEL_UNAVAILABLE', retryable: true }, 700],
    ]);
    expect(record).toMatchObject({
      status: 'error_event',
      errorCode: 'TEACHING_MODEL_UNAVAILABLE',
      restarted: true,
      groundingReason: 'retrieval_unavailable',
      totalMs: 700,
    });
  });
});

describe('aggregateTurns', () => {
  const refused: TurnRecord = {
    ...newTurnRecord('direct', 'baseline', 3),
    status: 'http_refused',
    httpStatus: 409,
    errorCode: 'TURN_IN_PROGRESS',
  };
  const turns = [
    turn([['grounding', { mode: 'retrieved' }, 30], ['text_delta', {}, 400], ['done', {}, 800]]),
    turn([['grounding', { mode: 'retrieved' }, 50], ['text_delta', {}, 600], ['done', {}, 1000]]),
    turn([
      ['grounding', { mode: 'insufficient', reason: 'no_match' }, 20],
      ['text_delta', {}, 350],
      ['done', {}, 700],
    ]),
    turn([['grounding', { mode: 'none' }, 10], ['text_delta', {}, 300], ['done', {}, 500]], 'kafuo_http'),
    refused,
  ];

  it('splits by source and outcome and keeps refusals out of the latency stats', () => {
    const agg = aggregateTurns(turns);
    expect(agg.turns).toBe(5);
    expect(agg.byStatus).toEqual({ done: 4, http_refused: 1 });
    expect(agg.refusals).toEqual({ byHttpStatus: { '409': 1 }, byCode: { TURN_IN_PROGRESS: 1 } });
    expect(Object.keys(agg.bySource).sort()).toEqual(['direct', 'kafuo_http']);
    expect(agg.bySource.direct.all.turns).toBe(3);
    expect(agg.bySource.direct.retrieved.ttftMs).toMatchObject({ n: 2, p50: 500 });
    expect(agg.bySource.direct.retrieved.totalMs).toMatchObject({ n: 2, p50: 900 });
    expect(agg.bySource.direct.insufficient.reasons).toEqual({ no_match: 1 });
    expect(agg.bySource.kafuo_http.none.ttftMs.p50).toBe(300);
    expect(agg.expectation).toBeNull();
  });

  it('counts turns that break an expected grounding outcome (failure injection)', () => {
    const agg = aggregateTurns(turns, { expectGroundingMode: 'insufficient' });
    expect(agg.expectation).toMatchObject({ groundingMode: 'insufficient', streamedTurns: 4, violations: 3 });
    expect(agg.expectation?.groundingMs.n).toBe(4);
  });
});

describe('parseLoadArgs (never runs by default)', () => {
  const minimal = ['--target', 'http://127.0.0.1:3005', '--i-understand-this-sends-load', '--sessions', 's.json'];

  it('refuses no arguments, a missing target, a missing acknowledgement or a missing sessions file', () => {
    expect(parseLoadArgs([])).toEqual({ ok: false, error: '--target is required' });
    expect(parseLoadArgs(minimal.filter((a) => a !== '--i-understand-this-sends-load'))).toEqual({
      ok: false,
      error: '--i-understand-this-sends-load is required',
    });
    expect(parseLoadArgs(minimal.slice(2))).toMatchObject({ ok: false });
    expect(parseLoadArgs(minimal.slice(0, 3))).toEqual({ ok: false, error: '--sessions is required' });
    expect(parseLoadArgs(['--target', 'ftp://x', '--i-understand-this-sends-load', '--sessions', 's'])).toEqual({
      ok: false,
      error: '--target must be http(s)',
    });
  });

  it('requires the stub for stub-side injection and bounds the numbers', () => {
    expect(parseLoadArgs([...minimal, '--inject-llm-error-rate', '0.5'])).toEqual({
      ok: false,
      error: '--inject-llm-error-rate needs --stub-llm-port',
    });
    expect(parseLoadArgs([...minimal, '--concurrency', '0'])).toEqual({
      ok: false,
      error: '--concurrency must be 1..1000',
    });
  });

  it('accepts an explicit run and fills defaults', () => {
    const parsed = parseLoadArgs([...minimal, '--stub-llm-port', '4599', '--stub-ttft-ms', '250', '--source-label', 'direct']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options).toMatchObject({
      target: 'http://127.0.0.1:3005',
      mode: 'closed',
      concurrency: 4,
      sourceLabel: 'direct',
      stub: { port: 4599, ttftMs: 250, embeddingDims: 1536 },
    });
  });

  it('main exits 2 with no arguments, before reading any file or opening a socket', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      expect(await main([])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('--i-understand-this-sends-load');
  });
});

describe('stub payloads', () => {
  it('embeds deterministically as unit vectors of the requested size', () => {
    const a = stubEmbedding('اشرحلي المثال المضاد', 1536);
    expect(a).toHaveLength(1536);
    expect(stubEmbedding('اشرحلي المثال المضاد', 1536)).toEqual(a);
    expect(Math.sqrt(a.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 9);
    expect(stubEmbedding('other', 1536)).not.toEqual(a);
  });

  it('streams tokens, then finish_reason stop, then a usage chunk', () => {
    const chunks = stubChatChunks('gpt-stub', 3);
    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toMatchObject({ choices: [{ delta: { role: 'assistant' } }] });
    expect(chunks[3]).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
    expect(chunks[4]).toMatchObject({ choices: [], usage: { completion_tokens: 3 } });
  });
});
