import { describe, expect, it } from 'vitest';

import {
  createTutorSseWriter,
  formatSseEvent,
  parseSseFrames,
  SSE_HEARTBEAT_FRAME,
} from '@/lib/server/tutor/sse';

/** SSE writer for the turn routes (contracts §5). */

async function readAll(response: Response): Promise<string> {
  return new Response(response.body).text();
}

describe('formatSseEvent / parseSseFrames', () => {
  it('writes `event:` + one-line `data:` frames and parses them back', () => {
    const frame = formatSseEvent('text_delta', { delta: 'سطر\nثانٍ' });
    expect(frame).toBe('event: text_delta\ndata: {"delta":"سطر\\nثانٍ"}\n\n');
    expect(parseSseFrames(`${SSE_HEARTBEAT_FRAME}${frame}`)).toEqual([
      { event: 'text_delta', data: { delta: 'سطر\nثانٍ' } },
    ]);
  });
});

describe('createTutorSseWriter', () => {
  it('streams the contract vocabulary in order with the event-stream headers', async () => {
    const writer = createTutorSseWriter({ heartbeatMs: 0 });
    expect(writer.response.headers.get('content-type')).toContain('text/event-stream');
    expect(writer.response.headers.get('cache-control')).toContain('no-store');
    writer.turnStart({ turnId: 't1', turnAttempt: 1 });
    writer.grounding({ mode: 'retrieved', lessonTitle: 'الدرس' });
    writer.textDelta('مرحبا ');
    writer.textDelta(''); // empty deltas are not frames
    writer.restart();
    writer.textDelta('كامل');
    writer.done({ messageId: 'm1', servedBy: 'fallback', accountingComplete: true });
    writer.title('عنوان');
    await writer.close();
    expect(writer.closed).toBe(true);
    const frames = parseSseFrames(await readAll(writer.response));
    expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'restart', 'text_delta', 'done', 'title']);
    expect(frames[3]!.data).toEqual({ servedBy: 'fallback' });
    expect(frames[5]!.data).toEqual({ messageId: 'm1', servedBy: 'fallback', accountingComplete: true });
    expect(frames[6]!.data).toEqual({ title: 'عنوان' });
  });

  it('emits :heartbeat comments on the interval', async () => {
    const writer = createTutorSseWriter({ heartbeatMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    writer.error({ code: 'TEACHING_MODEL_UNAVAILABLE', retryable: true });
    await writer.close();
    const body = await readAll(writer.response);
    expect(body.split(SSE_HEARTBEAT_FRAME).length - 1).toBeGreaterThanOrEqual(2);
    expect(parseSseFrames(body)).toEqual([{ event: 'error', data: { code: 'TEACHING_MODEL_UNAVAILABLE', retryable: true } }]);
  });

  it('aborts its signal on client disconnect and ignores later writes', async () => {
    const controller = new AbortController();
    const writer = createTutorSseWriter({ requestSignal: controller.signal, heartbeatMs: 0 });
    writer.turnStart({ turnId: 't', turnAttempt: 1 });
    expect(writer.signal.aborted).toBe(false);
    controller.abort();
    expect(writer.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writer.closed).toBe(true);
    writer.textDelta('lost');
    const frames = parseSseFrames(await readAll(writer.response));
    expect(frames.map((f) => f.event)).toEqual(['turn_start']);
  });

  it('close is idempotent and aborts the signal', async () => {
    const writer = createTutorSseWriter({ heartbeatMs: 0 });
    await writer.close();
    await writer.close();
    expect(writer.signal.aborted).toBe(true);
  });
});
