/**
 * Pure helpers for `free-chat-sse-load.ts` (discovery-first plan P10, "Full chat").
 * No I/O here, so Vitest covers them directly (`tests/scripts/free-chat-sse-load.test.ts`).
 *
 * Wire vocabulary (`lib/server/tutor/sse.ts`):
 *   turn_start → grounding {mode, reason?} → text_delta… → (restart → text_delta…)
 *   → done | error → title? (may follow done)
 *
 * Timing rules:
 *  - TTFT  = first `text_delta` − request sent (client side, what the student sees);
 *  - total = `done` or `error` event − request sent. NOT stream close: `title` can follow.
 *  - A pre-stream refusal (409/429/403/422/503 JSON) is a refusal, never a TTFT sample.
 */

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const position = ((ordered.length - 1) * p) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

export interface LatencySummary {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export function summarize(values: readonly number[]): LatencySummary {
  const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(values.length ? Math.max(...values) : null),
    mean: round(values.length ? values.reduce((a, b) => a + b, 0) / values.length : null),
  };
}

// ---------------------------------------------------------------------------
// Incremental SSE parsing
// ---------------------------------------------------------------------------

export interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Feed decoded text as it arrives; get whole frames back. Frames may be split across
 * chunks anywhere (inside a line, between `\r` and `\n`). Comment lines (`:heartbeat`) are
 * dropped. `data` is parsed as JSON when it parses, otherwise kept as text.
 */
export class SseFrameParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    // Normalise line endings, but keep a trailing lone `\r` until its `\n` arrives.
    const keepCr = this.buffer.endsWith('\r');
    const body = keepCr ? this.buffer.slice(0, -1) : this.buffer;
    const normalised = body.replace(/\r\n?/g, '\n');
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const end = normalised.indexOf('\n\n', start);
      if (end === -1) break;
      const frame = parseBlock(normalised.slice(start, end));
      if (frame) frames.push(frame);
      start = end + 2;
    }
    this.buffer = normalised.slice(start) + (keepCr ? '\r' : '');
    return frames;
  }

  /** The stream ended: a final block without its blank line still counts. */
  flush(): SseFrame[] {
    const rest = this.buffer.replace(/\r\n?/g, '\n');
    this.buffer = '';
    const frame = parseBlock(rest.replace(/\n+$/, ''));
    return frame ? [frame] : [];
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  let sawField = false;
  for (const line of block.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'data') {
      data.push(value);
      sawField = true;
    }
  }
  if (!sawField) return null;
  const raw = data.join('\n');
  let parsed: unknown = raw;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep the text */
    }
  } else {
    parsed = null;
  }
  return { event, data: parsed };
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

export type TurnStatus =
  | 'done' // a `done` event
  | 'error_event' // an SSE `error` event after the stream opened
  | 'http_refused' // a pre-stream JSON refusal (no stream)
  | 'network_error' // fetch failed / stream broke before a terminal event
  | 'aborted' // the client gave up (request timeout or --inject-client-abort-ms)
  | 'no_terminal'; // the stream ended without done/error

export interface TurnRecord {
  source: string;
  scenario: string;
  sessionIndex: number;
  status: TurnStatus;
  httpStatus: number | null;
  errorCode: string | null;
  groundingMode: string | null;
  groundingReason: string | null;
  restarted: boolean;
  servedBy: string | null;
  turnStartMs: number | null;
  groundingMs: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  deltaCount: number;
}

export function newTurnRecord(source: string, scenario: string, sessionIndex: number): TurnRecord {
  return {
    source,
    scenario,
    sessionIndex,
    status: 'no_terminal',
    httpStatus: null,
    errorCode: null,
    groundingMode: null,
    groundingReason: null,
    restarted: false,
    servedBy: null,
    turnStartMs: null,
    groundingMs: null,
    ttftMs: null,
    totalMs: null,
    deltaCount: 0,
  };
}

function field(data: unknown, key: string): unknown {
  return data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
}

/**
 * Apply one frame at `elapsedMs` since the request was sent. Returns true once the turn has
 * its terminal event (`done` or `error`); later frames (`title`) never move `totalMs`.
 */
export function observeFrame(record: TurnRecord, frame: SseFrame, elapsedMs: number): boolean {
  const terminal = record.totalMs !== null;
  switch (frame.event) {
    case 'turn_start':
      record.turnStartMs ??= elapsedMs;
      break;
    case 'grounding': {
      record.groundingMs ??= elapsedMs;
      const mode = field(frame.data, 'mode');
      const reason = field(frame.data, 'reason');
      record.groundingMode = typeof mode === 'string' ? mode : record.groundingMode;
      record.groundingReason = typeof reason === 'string' ? reason : record.groundingReason;
      break;
    }
    case 'text_delta':
      if (!terminal) {
        record.deltaCount += 1;
        record.ttftMs ??= elapsedMs;
      }
      break;
    case 'restart':
      record.restarted = true;
      break;
    case 'done':
      if (!terminal) {
        record.totalMs = elapsedMs;
        record.status = 'done';
        const servedBy = field(frame.data, 'servedBy');
        record.servedBy = typeof servedBy === 'string' ? servedBy : null;
      }
      return true;
    case 'error':
      if (!terminal) {
        record.totalMs = elapsedMs;
        record.status = 'error_event';
        const code = field(frame.data, 'code');
        record.errorCode = typeof code === 'string' ? code : 'unknown';
      }
      return true;
    default:
      break;
  }
  return terminal;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface OutcomeStats {
  turns: number;
  ttftMs: LatencySummary;
  totalMs: LatencySummary;
  groundingMs: LatencySummary;
  errorCodes: Record<string, number>;
  reasons: Record<string, number>;
}

export interface LoadAggregate {
  turns: number;
  byStatus: Record<string, number>;
  /** Pre-stream refusals, outside every latency statistic. */
  refusals: { byHttpStatus: Record<string, number>; byCode: Record<string, number> };
  restarts: number;
  /** source → grounding outcome (`retrieved`, `reuse`, `none`, `clarification`,
   *  `insufficient`, or `(no grounding event)`) → stats; `all` = every outcome. */
  bySource: Record<string, Record<string, OutcomeStats>>;
  expectation: null | {
    groundingMode: string;
    streamedTurns: number;
    violations: number;
    groundingMs: LatencySummary;
  };
}

function count(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

function outcomeStats(turns: readonly TurnRecord[]): OutcomeStats {
  const errorCodes: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.errorCode) count(errorCodes, turn.errorCode);
    if (turn.groundingReason) count(reasons, turn.groundingReason);
  }
  const values = (pick: (t: TurnRecord) => number | null) =>
    turns.map(pick).filter((v): v is number => v !== null);
  return {
    turns: turns.length,
    ttftMs: summarize(values((t) => t.ttftMs)),
    totalMs: summarize(values((t) => t.totalMs)),
    groundingMs: summarize(values((t) => t.groundingMs)),
    errorCodes,
    reasons,
  };
}

const STREAMED: ReadonlySet<TurnStatus> = new Set(['done', 'error_event', 'no_terminal']);

export function aggregateTurns(
  turns: readonly TurnRecord[],
  options: { expectGroundingMode?: string | null } = {},
): LoadAggregate {
  const byStatus: Record<string, number> = {};
  const byHttpStatus: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const turn of turns) {
    count(byStatus, turn.status);
    if (turn.status === 'http_refused') {
      count(byHttpStatus, String(turn.httpStatus ?? 'none'));
      count(byCode, turn.errorCode ?? 'unknown');
    }
  }
  const streamed = turns.filter((turn) => STREAMED.has(turn.status));
  const groups = new Map<string, Map<string, TurnRecord[]>>();
  for (const turn of streamed) {
    const bySource = groups.get(turn.source) ?? new Map<string, TurnRecord[]>();
    groups.set(turn.source, bySource);
    for (const key of ['all', turn.groundingMode ?? '(no grounding event)']) {
      const list = bySource.get(key) ?? [];
      list.push(turn);
      bySource.set(key, list);
    }
  }
  const bySource: Record<string, Record<string, OutcomeStats>> = {};
  for (const [source, outcomes] of groups) {
    bySource[source] = {};
    for (const [outcome, list] of outcomes) bySource[source][outcome] = outcomeStats(list);
  }
  const expected = options.expectGroundingMode ?? null;
  return {
    turns: turns.length,
    byStatus,
    refusals: { byHttpStatus, byCode },
    restarts: turns.filter((turn) => turn.restarted).length,
    bySource,
    expectation:
      expected === null
        ? null
        : {
            groundingMode: expected,
            streamedTurns: streamed.length,
            violations: streamed.filter((turn) => turn.groundingMode !== expected).length,
            groundingMs: summarize(
              streamed.map((t) => t.groundingMs).filter((v): v is number => v !== null),
            ),
          },
  };
}
