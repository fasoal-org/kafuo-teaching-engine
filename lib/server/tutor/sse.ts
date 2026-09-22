/**
 * SSE writer for the conversational turn routes (Kafuo R1 contracts §5).
 *
 * Wire: `event: <name>\ndata: <json>\n\n`, a `:heartbeat` comment every 15 s
 * (proxies close idle streams), `Content-Type: text/event-stream`. Same
 * vocabulary the classroom chat route streams by hand
 * (`app/api/chat/route.ts`), lifted into a reusable writer so Free Chat now
 * and Help later emit exactly one shape:
 *
 *   turn_start {turnId, turnAttempt} → grounding {mode, lessonTitle?}
 *   → text_delta {delta}… → (restart {servedBy:'fallback'} → text_delta…)
 *   → done {messageId, servedBy, safety?, accountingComplete: true}
 *   | error {code, retryable, window?, resetAt?}
 *   → title {title}? (may follow done)
 *
 * The body is a `ReadableStream` fed by its controller: writes never block
 * on the consumer (a slow client cannot stall the turn transaction), and the
 * stream's `cancel` — the HTTP layer's own disconnect signal — plus the
 * request signal both abort `signal`, which the turn runner hands to the
 * executor. Every write after that is a silent no-op. Writes are best
 * effort by design — the durable record is the database, never the stream.
 */

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export type TutorSseEvent =
  | 'turn_start'
  | 'grounding'
  | 'text_delta'
  | 'restart'
  | 'done'
  | 'error'
  | 'title';

export interface TurnStartEvent {
  turnId: string;
  turnAttempt: number;
}

export interface GroundingEvent {
  mode: string;
  lessonTitle?: string;
}

export interface DoneEvent {
  messageId: string;
  servedBy: 'primary' | 'fallback' | null;
  safety?: Record<string, unknown>;
  accountingComplete: true;
}

export interface ErrorEvent {
  code: string;
  retryable: boolean;
  message?: string;
  window?: string | null;
  resetAt?: string | null;
}

/** One SSE frame. `data` is JSON-serialised on one line (no raw newlines). */
export function formatSseEvent(event: TutorSseEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const SSE_HEARTBEAT_FRAME = ':heartbeat\n\n';

export interface TutorSseWriter {
  /** The streaming response to return from the route. */
  readonly response: Response;
  /** Aborted on client disconnect or `close()`; hand it to the executor. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  /** Raw event write (best effort). */
  event(name: TutorSseEvent, data: unknown): void;
  turnStart(data: TurnStartEvent): void;
  grounding(data: GroundingEvent): void;
  textDelta(delta: string): void;
  restart(servedBy?: 'fallback'): void;
  done(data: DoneEvent): void;
  error(data: ErrorEvent): void;
  title(title: string): void;
  /** Stop the heartbeat and end the stream. Idempotent. */
  close(): Promise<void>;
}

export interface TutorSseOptions {
  /** The request's signal: client disconnect. */
  requestSignal?: AbortSignal;
  heartbeatMs?: number;
  extraHeaders?: Record<string, string>;
}

export function createTutorSseWriter(options: TutorSseOptions = {}): TutorSseWriter {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    try {
      controller?.close();
    } catch {
      /* already closed or cancelled by the consumer */
    }
    if (!abort.signal.aborted) abort.abort();
  };

  const onDisconnect = () => {
    if (!abort.signal.aborted) abort.abort();
    finish();
  };

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      onDisconnect();
    },
  });

  const write = (text: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      onDisconnect();
    }
  };

  if (options.requestSignal) {
    if (options.requestSignal.aborted) onDisconnect();
    else options.requestSignal.addEventListener('abort', onDisconnect, { once: true });
  }

  const interval = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  if (interval > 0 && !closed) {
    heartbeat = setInterval(() => write(SSE_HEARTBEAT_FRAME), interval);
    (heartbeat as { unref?: () => void }).unref?.();
  }

  const response = new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(options.extraHeaders ?? {}),
    },
  });

  const event = (name: TutorSseEvent, data: unknown) => write(formatSseEvent(name, data));

  return {
    response,
    signal: abort.signal,
    get closed() {
      return closed;
    },
    event,
    turnStart: (data) => event('turn_start', data),
    grounding: (data) => event('grounding', data),
    textDelta: (delta) => {
      if (delta.length > 0) event('text_delta', { delta });
    },
    restart: (servedBy = 'fallback') => event('restart', { servedBy }),
    done: (data) => event('done', data),
    error: (data) => event('error', data),
    title: (title) => event('title', { title }),
    close: async () => {
      finish();
    },
  };
}

/** Parse a complete SSE body (tests, and Help's session replay reader). */
export function parseSseFrames(body: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const chunk of body.split('\n\n')) {
    const lines = chunk.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0 || lines.every((line) => line.startsWith(':'))) continue;
    let event = 'message';
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    const raw = data.join('\n');
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw */
    }
    frames.push({ event, data: parsed });
  }
  return frames;
}
