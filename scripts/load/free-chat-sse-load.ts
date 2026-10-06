/**
 * Full-chat SSE load for Free Chat (discovery-first plan P10, "Full chat").
 *
 * IT NEVER RUNS BY DEFAULT. Without an explicit `--target <url>` AND
 * `--i-understand-this-sends-load` it prints this usage and exits 2, before opening any
 * socket or starting the stub.
 *
 *   npx tsx scripts/load/free-chat-sse-load.ts \
 *     --target http://127.0.0.1:3005 --i-understand-this-sends-load \
 *     --sessions ./load-sessions.json --concurrency 20 --turns-per-session 3 \
 *     --source-label direct --stub-llm-port 4599 --stub-ttft-ms 400 \
 *     --out ./free-chat-load.json
 *
 * What it does: drives `POST /api/tutor/conversations/:id/messages` (SSE) with real student
 * grants, one in-flight turn per conversation (the TE refuses a second with 409), and
 * measures per turn, client side:
 *   - TTFT  = first `text_delta` − request sent (what the student perceives);
 *   - total = `done`/`error` event − request sent (not stream close: `title` may follow);
 *   - time to the `grounding` event, its `mode` (retrieved | reuse | none | clarification
 *     | insufficient) and `reason`.
 * The report splits by `--source-label` (kafuo_http | direct | shadow — the TE's own
 * `TUTOR_GROUNDING_SOURCE`, which the client cannot see) and by grounding outcome.
 * Pre-stream refusals (409/429/403/422/503) are counted apart, never as latency samples.
 * The server-side `first_delta_at − created_at` lives in the TE database and is not read.
 *
 * Sessions file (grants are secrets: never printed or written to the report):
 *   [{ "grant": "tsg.…", "conversationId": "conv-…" },
 *    { "grant": "tsg.…", "subjectCode": "MATH" }]      ← creates a conversation first
 * Questions: `--questions <file>` with a JSON array of strings, or an eval set
 * (`{ questions: [{ question }] }`); default: a few built-in Arabic questions.
 *
 * Stub LLM (`--stub-llm-port <port>`): an OpenAI-compatible server on 127.0.0.1 that
 * streams chat completions after a FIXED `--stub-ttft-ms`, then `--stub-tokens` tokens every
 * `--stub-token-interval-ms`, then `finish_reason: "stop"` and a `usage` chunk; and serves
 * `/v1/embeddings` with deterministic unit vectors of the requested `dimensions`. Start the
 * TE yourself with it configured (this script never restarts anything):
 *     OPENAI_BASE_URL=http://127.0.0.1:4599/v1 OPENAI_COMPAT_USE_STREAMING_CHAT=true \
 *     QWEN_BASE_URL=http://127.0.0.1:4599/v1
 * `OPENAI_BASE_URL` also redirects the TE's query embedding, so vectors come from the stub.
 *
 * Failure injection:
 *   through the stub   --inject-llm-error-rate <0..1>   chat completions answer 500
 *                      --inject-llm-stall-ms <ms>       extra delay before the first token
 *                      --inject-embedding-delay-ms <ms> embedding timeout (TE side)
 *                      --inject-embedding-error-rate <0..1>
 *   client side        --inject-client-abort-ms <ms>    disconnect mid-turn
 *   server side        set up out of band, then label it with --scenario and check it with
 *                      --expect-grounding insufficient (violations are counted):
 *                        reader_down        KAFUO_GROUNDING_DATABASE_URL to a closed port
 *                        statement_timeout  a scratch reader with a 1 ms statement_timeout
 *                        embedding_timeout  --inject-embedding-delay-ms above the TE timeout
 *                        pool_saturation    KAFUO_GROUNDING_POOL_MAX=1 and high concurrency
 *                        meter_unavailable  the Kafuo stub/staging meter answering 503
 *   Each grounding failure must end as a fast `insufficient`; meter behaviour must not change.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  aggregateTurns,
  newTurnRecord,
  observeFrame,
  SseFrameParser,
  type TurnRecord,
} from './free-chat-sse-stats';

export const USAGE = `free-chat-sse-load: sends real load. Refusing to run without
  --target <http(s) url>            the Teaching Engine base URL
  --i-understand-this-sends-load    explicit acknowledgement
  --sessions <file.json>            student grants (+ conversation ids or subject codes)
Options: --questions <file> --concurrency <n> --turns-per-session <n>
  --mode closed|open --rate <turns/s> --duration-s <s> --request-timeout-ms <ms>
  --source-label <kafuo_http|direct|shadow|...> --scenario <label> --expect-grounding <mode>
  --stub-llm-port <port> --stub-ttft-ms <ms> --stub-tokens <n> --stub-token-interval-ms <ms>
  --stub-embedding-dims <n> --inject-llm-error-rate <0..1> --inject-llm-stall-ms <ms>
  --inject-embedding-delay-ms <ms> --inject-embedding-error-rate <0..1>
  --inject-client-abort-ms <ms> --out <report.json>`;

export interface LoadOptions {
  target: string;
  sessionsFile: string;
  questionsFile: string | null;
  concurrency: number;
  turnsPerSession: number;
  mode: 'closed' | 'open';
  rate: number;
  durationS: number;
  requestTimeoutMs: number;
  sourceLabel: string;
  scenario: string;
  expectGrounding: string | null;
  stub: StubOptions | null;
  injectClientAbortMs: number | null;
  out: string | null;
}

export interface StubOptions {
  port: number;
  ttftMs: number;
  tokens: number;
  tokenIntervalMs: number;
  embeddingDims: number;
  llmErrorRate: number;
  llmStallMs: number;
  embeddingDelayMs: number;
  embeddingErrorRate: number;
}

export type ParsedArgs = { ok: true; options: LoadOptions } | { ok: false; error: string };

const FLAGS = new Set([
  '--i-understand-this-sends-load',
]);

/** Parse and validate; nothing is opened here. */
export function parseLoadArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) return { ok: false, error: `unexpected argument ${arg}` };
    if (FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
    values.set(arg, value);
    i += 1;
  }
  const target = values.get('--target');
  if (!target) return { ok: false, error: '--target is required' };
  if (!flags.has('--i-understand-this-sends-load')) {
    return { ok: false, error: '--i-understand-this-sends-load is required' };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, error: `--target ${target} is not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '--target must be http(s)' };
  }
  const sessionsFile = values.get('--sessions');
  if (!sessionsFile) return { ok: false, error: '--sessions is required' };

  const num = (flag: string, fallback: number, min: number, max: number): number | string => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) return `${flag} must be ${min}..${max}`;
    return value;
  };
  const numbers = {
    concurrency: num('--concurrency', 4, 1, 1000),
    turnsPerSession: num('--turns-per-session', 1, 1, 1000),
    rate: num('--rate', 1, 0.01, 1000),
    durationS: num('--duration-s', 30, 1, 3600),
    requestTimeoutMs: num('--request-timeout-ms', 120_000, 1000, 600_000),
    port: num('--stub-llm-port', 0, 1, 65535),
    ttftMs: num('--stub-ttft-ms', 300, 0, 60_000),
    tokens: num('--stub-tokens', 40, 1, 10_000),
    tokenIntervalMs: num('--stub-token-interval-ms', 20, 0, 10_000),
    embeddingDims: num('--stub-embedding-dims', 1536, 1, 4096),
    llmErrorRate: num('--inject-llm-error-rate', 0, 0, 1),
    llmStallMs: num('--inject-llm-stall-ms', 0, 0, 600_000),
    embeddingDelayMs: num('--inject-embedding-delay-ms', 0, 0, 600_000),
    embeddingErrorRate: num('--inject-embedding-error-rate', 0, 0, 1),
    clientAbortMs: num('--inject-client-abort-ms', 0, 0, 600_000),
  };
  for (const value of Object.values(numbers)) {
    if (typeof value === 'string') return { ok: false, error: value };
  }
  const n = numbers as Record<keyof typeof numbers, number>;
  const mode = values.get('--mode') ?? 'closed';
  if (mode !== 'closed' && mode !== 'open') return { ok: false, error: '--mode must be closed or open' };
  const stubRequested = values.has('--stub-llm-port');
  if (!stubRequested) {
    for (const flag of [
      '--inject-llm-error-rate',
      '--inject-llm-stall-ms',
      '--inject-embedding-delay-ms',
      '--inject-embedding-error-rate',
    ]) {
      if (values.has(flag)) return { ok: false, error: `${flag} needs --stub-llm-port` };
    }
  }
  return {
    ok: true,
    options: {
      target: url.toString().replace(/\/+$/, ''),
      sessionsFile,
      questionsFile: values.get('--questions') ?? null,
      concurrency: Math.floor(n.concurrency),
      turnsPerSession: Math.floor(n.turnsPerSession),
      mode,
      rate: n.rate,
      durationS: n.durationS,
      requestTimeoutMs: n.requestTimeoutMs,
      sourceLabel: values.get('--source-label') ?? 'unlabelled',
      scenario: values.get('--scenario') ?? 'baseline',
      expectGrounding: values.get('--expect-grounding') ?? null,
      stub: stubRequested
        ? {
            port: Math.floor(n.port),
            ttftMs: n.ttftMs,
            tokens: Math.floor(n.tokens),
            tokenIntervalMs: n.tokenIntervalMs,
            embeddingDims: Math.floor(n.embeddingDims),
            llmErrorRate: n.llmErrorRate,
            llmStallMs: n.llmStallMs,
            embeddingDelayMs: n.embeddingDelayMs,
            embeddingErrorRate: n.embeddingErrorRate,
          }
        : null,
      injectClientAbortMs: n.clientAbortMs > 0 ? n.clientAbortMs : null,
      out: values.get('--out') ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Stub LLM (OpenAI-compatible)
// ---------------------------------------------------------------------------

/** A deterministic unit vector for `text` (the same text always maps to the same vector). */
export function stubEmbedding(text: string, dims: number): number[] {
  const values: number[] = [];
  let counter = 0;
  while (values.length < dims) {
    const digest = createHash('sha256').update(`${counter}:${text}`).digest();
    for (let i = 0; i + 4 <= digest.length && values.length < dims; i += 4) {
      values.push(digest.readUInt32BE(i) / 0xffffffff - 0.5);
    }
    counter += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

/** The streamed chat completion as SSE `data:` payloads (without the `[DONE]` line). */
export function stubChatChunks(model: string, tokens: number): Array<Record<string, unknown>> {
  const created = Math.floor(Date.now() / 1000);
  const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created, model };
  const chunks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < tokens; i += 1) {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: i === 0 ? { role: 'assistant', content: 'هذا ' } : { content: `ردّ${i} ` },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  chunks.push({ ...base, choices: [], usage: stubUsage(tokens) });
  return chunks;
}

function stubUsage(tokens: number) {
  return { prompt_tokens: 100, completion_tokens: tokens, total_tokens: 100 + tokens };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface StubCounters {
  chat: number;
  chatErrors: number;
  embeddings: number;
  embeddingErrors: number;
  other: number;
}

export function startStubServer(
  options: StubOptions,
  random: () => number = Math.random,
): Promise<{ server: Server; counters: StubCounters }> {
  const counters: StubCounters = { chat: 0, chatErrors: 0, embeddings: 0, embeddingErrors: 0, other: 0 };
  const fail = (res: ServerResponse) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'injected failure', type: 'server_error' } }));
  };
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
      const body = await readBody(req);
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        counters.chat += 1;
        if (random() < options.llmErrorRate) {
          counters.chatErrors += 1;
          return fail(res);
        }
        const model = typeof body.model === 'string' ? body.model : 'stub';
        await sleep(options.ttftMs + options.llmStallMs);
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const chunks = stubChatChunks(model, options.tokens);
          for (let i = 0; i < chunks.length; i += 1) {
            if (i > 0 && i < options.tokens) await sleep(options.tokenIntervalMs);
            res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
          }
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ردّ تجريبي' }, finish_reason: 'stop' },
            ],
            usage: stubUsage(options.tokens),
          }),
        );
        return;
      }
      if (req.method === 'POST' && path.endsWith('/embeddings')) {
        counters.embeddings += 1;
        await sleep(options.embeddingDelayMs);
        if (random() < options.embeddingErrorRate) {
          counters.embeddingErrors += 1;
          return fail(res);
        }
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const dims = typeof body.dimensions === 'number' ? body.dimensions : options.embeddingDims;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            model: body.model ?? 'stub',
            data: inputs.map((input, index) => ({
              object: 'embedding',
              index,
              embedding: stubEmbedding(String(input ?? ''), dims),
            })),
            usage: { prompt_tokens: 8 * inputs.length, total_tokens: 8 * inputs.length },
          }),
        );
        return;
      }
      counters.other += 1;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `stub: no route ${req.method} ${path}` } }));
    })().catch(() => {
      if (!res.headersSent) fail(res);
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve({ server, counters }));
  });
}

// ---------------------------------------------------------------------------
// Sessions, questions and one turn
// ---------------------------------------------------------------------------

interface Session {
  index: number;
  grant: string;
  conversationId: string | null;
  subjectCode: string | null;
}

const DEFAULT_QUESTIONS = [
  'اشرحلي المثال المضاد',
  'يعني ايه التخمين',
  'ما هي عاصمة فرنسا',
  'اشرحلي التبرير الاستقرائي',
];

function loadSessions(file: string): Session[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { sessions?: unknown }).sessions;
  if (!Array.isArray(list) || list.length === 0) throw new Error('sessions file: expected a non-empty array');
  return list.map((entry, index) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.grant !== 'string' || !e.grant) throw new Error(`session ${index}: grant is required`);
    const conversationId = typeof e.conversationId === 'string' ? e.conversationId : null;
    const subjectCode = typeof e.subjectCode === 'string' ? e.subjectCode : null;
    if (!conversationId && !subjectCode) {
      throw new Error(`session ${index}: give conversationId or subjectCode`);
    }
    return { index, grant: e.grant, conversationId, subjectCode };
  });
}

function loadQuestions(file: string | null): string[] {
  if (!file) return DEFAULT_QUESTIONS;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown }).questions;
  if (!Array.isArray(list)) throw new Error('questions file: expected an array or { questions: [...] }');
  const questions = list
    .map((q) => (typeof q === 'string' ? q : (q as { question?: unknown })?.question))
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
  if (questions.length === 0) throw new Error('questions file: no questions');
  return questions;
}

async function ensureConversation(target: string, session: Session, runId: string): Promise<void> {
  if (session.conversationId) return;
  const res = await fetch(`${target}/api/tutor/conversations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.grant}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subjectCode: session.subjectCode, clientRequestId: `load-${runId}-${session.index}` }),
  });
  const body = (await res.json().catch(() => null)) as { conversation?: { id?: unknown } } | null;
  const id = body?.conversation?.id;
  if (!res.ok || typeof id !== 'string') {
    throw new Error(`session ${session.index}: creating a conversation answered ${res.status}`);
  }
  session.conversationId = id;
}

export async function runTurn(
  options: Pick<LoadOptions, 'target' | 'requestTimeoutMs' | 'injectClientAbortMs' | 'sourceLabel' | 'scenario'>,
  session: Session,
  text: string,
): Promise<TurnRecord> {
  const record = newTurnRecord(options.sourceLabel, options.scenario, session.index);
  const controller = new AbortController();
  const timers = [setTimeout(() => controller.abort(), options.requestTimeoutMs)];
  if (options.injectClientAbortMs !== null) {
    timers.push(setTimeout(() => controller.abort(), options.injectClientAbortMs));
  }
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
  try {
    const res = await fetch(
      `${options.target}/api/tutor/conversations/${encodeURIComponent(session.conversationId ?? '')}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.grant}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ clientMessageId: randomUUID(), text }),
        signal: controller.signal,
      },
    );
    record.httpStatus = res.status;
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('text/event-stream') || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
      record.status = 'http_refused';
      record.errorCode = typeof body?.error?.code === 'string' ? body.error.code : `http_${res.status}`;
      record.totalMs = null;
      return record;
    }
    const parser = new SseFrameParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      const frames = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
      for (const frame of frames) observeFrame(record, frame, elapsed());
      if (done) break;
    }
    return record;
  } catch (error) {
    if (record.totalMs === null) {
      record.status = controller.signal.aborted ? 'aborted' : 'network_error';
      record.errorCode = error instanceof Error ? error.name : 'unknown';
    }
    return record;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Load shapes
// ---------------------------------------------------------------------------

async function runClosed(options: LoadOptions, sessions: Session[], questions: string[]): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  const active = sessions.slice(0, Math.min(options.concurrency, sessions.length));
  let next = 0;
  await Promise.all(
    active.map(async (session) => {
      for (let turn = 0; turn < options.turnsPerSession; turn += 1) {
        const question = questions[next++ % questions.length];
        records.push(await runTurn(options, session, question));
      }
    }),
  );
  return records;
}

async function runOpen(
  options: LoadOptions,
  sessions: Session[],
  questions: string[],
): Promise<{ records: TurnRecord[]; skippedNoIdleSession: number }> {
  const records: TurnRecord[] = [];
  const idle = [...sessions];
  const inFlight: Promise<void>[] = [];
  let skipped = 0;
  let sent = 0;
  const interval = 1000 / options.rate;
  const end = performance.now() + options.durationS * 1000;
  while (performance.now() < end) {
    const session = idle.shift();
    if (!session) {
      skipped += 1; // never two turns on one conversation (the TE answers 409)
    } else {
      const question = questions[sent++ % questions.length];
      inFlight.push(
        runTurn(options, session, question).then((record) => {
          records.push(record);
          idle.push(session);
        }),
      );
    }
    await sleep(interval);
  }
  await Promise.all(inFlight);
  return { records, skippedNoIdleSession: skipped };
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseLoadArgs(argv);
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const options = parsed.options;
  const sessions = loadSessions(options.sessionsFile);
  const questions = loadQuestions(options.questionsFile);
  const runId = randomUUID().slice(0, 8);

  let stub: Awaited<ReturnType<typeof startStubServer>> | null = null;
  if (options.stub) {
    stub = await startStubServer(options.stub);
    console.error(`stub LLM on http://127.0.0.1:${options.stub.port}/v1 (TTFT ${options.stub.ttftMs} ms)`);
  }
  try {
    for (const session of sessions) await ensureConversation(options.target, session, runId);
    const startedAt = new Date().toISOString();
    const wallStart = performance.now();
    let records: TurnRecord[];
    let skippedNoIdleSession = 0;
    if (options.mode === 'open') {
      ({ records, skippedNoIdleSession } = await runOpen(options, sessions, questions));
    } else {
      records = await runClosed(options, sessions, questions);
    }
    const wallSeconds = (performance.now() - wallStart) / 1000;
    const report = {
      label:
        'Full chat, client side: TTFT = first text_delta − request sent; total = done/error ' +
        'event − request sent. Includes the network to the TE, grounding, the meter ' +
        'reservation and the stub LLM at a fixed TTFT; not production LLM latency.',
      runId,
      startedAt,
      wallSeconds,
      config: {
        targetHost: new URL(options.target).host,
        mode: options.mode,
        concurrency: options.concurrency,
        turnsPerSession: options.turnsPerSession,
        rate: options.mode === 'open' ? options.rate : null,
        durationS: options.mode === 'open' ? options.durationS : null,
        sessions: sessions.length,
        questions: questions.length,
        sourceLabel: options.sourceLabel,
        scenario: options.scenario,
        expectGrounding: options.expectGrounding,
        stub: options.stub,
        injectClientAbortMs: options.injectClientAbortMs,
      },
      skippedNoIdleSession,
      stubCounters: stub?.counters ?? null,
      aggregate: aggregateTurns(records, { expectGroundingMode: options.expectGrounding }),
      turns: records,
    };
    const json = JSON.stringify(report, null, 2);
    if (options.out) writeFileSync(options.out, json);
    else console.log(json);
    const agg = report.aggregate;
    console.error(
      `turns ${agg.turns} ${JSON.stringify(agg.byStatus)} refusals ${JSON.stringify(agg.refusals.byHttpStatus)}` +
        (agg.expectation ? ` expectation violations ${agg.expectation.violations}` : ''),
    );
    for (const [source, outcomes] of Object.entries(agg.bySource)) {
      for (const [outcome, stats] of Object.entries(outcomes)) {
        console.error(
          `  ${source} ${outcome}: n=${stats.turns} ttft p50=${stats.ttftMs.p50} p95=${stats.ttftMs.p95} ` +
            `total p50=${stats.totalMs.p50} p95=${stats.totalMs.p95} ms`,
        );
      }
    }
    return agg.expectation && agg.expectation.violations > 0 ? 1 : 0;
  } finally {
    if (stub) await new Promise<void>((resolve) => stub!.server.close(() => resolve()));
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
