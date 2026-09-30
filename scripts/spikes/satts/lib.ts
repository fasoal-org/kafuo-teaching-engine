/**
 * Shared SATTS Wave 0 spike client (not shipped).
 * - Key: TTS_OPENAI_API_KEY, else OPENAI_API_KEY (the server's fallback), from process env,
 *   else read from .env.local without modifying it. The key is never printed or written.
 * - Every paid call goes through `speech()`, which appends to out/ledger.jsonl and hard-aborts
 *   when the running estimate reaches the cap.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getEncoding } from 'js-tiktoken';

export const ROOT = join(__dirname, '..', '..', '..');
export const OUT = join(__dirname, 'out');
const LEDGER = join(OUT, 'ledger.jsonl');

export const CAP_USD = 5;
export const ABORT_AT_USD = 4.5;
export const TEXT_USD_PER_TOKEN = 0.6 / 1e6; // [OPENAI P11]
export const AUDIO_USD_PER_TOKEN = 12 / 1e6; // [OPENAI P11]
/**
 * Audio tokens per second of output. Not documented by OpenAI (checked model + pricing pages 2026-09-28).
 * Pessimistic placeholder (INFERENCE) until T3 measures it; override with SATTS_AUDIO_TOK_PER_SEC.
 */
export const AUDIO_TOK_PER_SEC = Number(process.env.SATTS_AUDIO_TOK_PER_SEC || 25);

const enc = getEncoding('o200k_base');
export const tok = (s: string) => enc.encode(s).length;

function readEnvLocal(): Record<string, string> {
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(
      /^\s*(TTS_OPENAI_API_KEY|OPENAI_API_KEY|TTS_OPENAI_BASE_URL|OPENAI_BASE_URL)\s*=\s*(.*)\s*$/,
    );
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const fileEnv = readEnvLocal();
const pick = (k: string) => process.env[k] || fileEnv[k] || '';
const API_KEY = pick('TTS_OPENAI_API_KEY') || pick('OPENAI_API_KEY');
export const KEY_SOURCE = pick('TTS_OPENAI_API_KEY')
  ? 'TTS_OPENAI_API_KEY'
  : pick('OPENAI_API_KEY')
    ? 'OPENAI_API_KEY'
    : 'none';
const BASE_URL = (pick('TTS_OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, '');

export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}
export function writeOut(rel: string, data: string | Uint8Array) {
  const p = join(OUT, rel);
  ensureDir(dirname(p));
  writeFileSync(p, data);
  return p;
}

export interface LedgerRow {
  t: string;
  task: string;
  label: string;
  status: number;
  inputChars: number;
  inputTok: number;
  instrTok: number;
  audioSec: number | null;
  usage?: unknown;
  estUsd: number;
}

export function ledgerRows(): LedgerRow[] {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
export const spentUsd = () => ledgerRows().reduce((a, r) => a + r.estUsd, 0);

export function estimateUsd(inputTok: number, instrTok: number, audioSec: number) {
  return (
    (inputTok + instrTok) * TEXT_USD_PER_TOKEN + audioSec * AUDIO_TOK_PER_SEC * AUDIO_USD_PER_TOKEN
  );
}

/** Print a plan and abort if it would breach the cap. `audioSecEach` is a pessimistic guess. */
export function preflight(
  task: string,
  calls: { input: string; instructions?: string }[],
  audioSecEach: (s: string) => number,
) {
  const est = calls.reduce(
    (a, c) =>
      a +
      estimateUsd(tok(c.input), c.instructions ? tok(c.instructions) : 0, audioSecEach(c.input)),
    0,
  );
  const spent = spentUsd();
  console.log(
    `[${task}] planned calls=${calls.length}, est=$${est.toFixed(4)}, spent so far=$${spent.toFixed(4)}, cap=$${CAP_USD}`,
  );
  if (spent + est > ABORT_AT_USD) {
    console.error(`[${task}] ABORT: estimate would exceed $${ABORT_AT_USD}`);
    process.exit(2);
  }
}

/** ~Arabic speaking rate guess for preflight only: 12 chars/sec, ×1.5 pessimism. */
export const guessSec = (s: string) => (s.length / 12) * 1.5 + 1;

export interface SpeechReq {
  model?: string;
  voice: string;
  input: string;
  instructions?: string;
  response_format?: 'mp3' | 'wav' | 'pcm' | 'opus' | 'aac' | 'flac';
  speed?: number;
  stream_format?: 'sse' | 'audio';
}

export interface SpeechRes {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  ms: number;
  errorBody?: string;
}

const REDACT = new Set([
  'openai-organization',
  'openai-project',
  'set-cookie',
  'cf-ray',
  'x-request-id',
]);
export function redactHeaders(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k] = REDACT.has(k) ? '<redacted>' : v));
  return o;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rawSpeech(req: SpeechReq): Promise<{ res: Response; ms: number }> {
  if (!API_KEY) throw new Error('No OpenAI key in TTS_OPENAI_API_KEY / OPENAI_API_KEY');
  let attempt = 0;
  for (;;) {
    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (res.status === 429 && attempt < 2) {
      attempt++;
      await res.arrayBuffer().catch(() => undefined);
      await sleep(2000 * attempt);
      continue;
    }
    return { res, ms: Date.now() - t0 };
  }
}

/** Non-streaming call with ledger accounting. `durationOf` computes seconds from the returned bytes. */
export async function speech(
  task: string,
  label: string,
  req: SpeechReq,
  durationOf: (b: Uint8Array) => number | null,
): Promise<SpeechRes> {
  if (spentUsd() > ABORT_AT_USD) throw new Error(`cap reached ($${spentUsd().toFixed(3)})`);
  const { res, ms } = await rawSpeech({ response_format: 'mp3', speed: 1.0, ...req });
  const buf = new Uint8Array(await res.arrayBuffer());
  const ok = res.ok;
  const audioSec = ok ? durationOf(buf) : null;
  const inputTok = tok(req.input);
  const instrTok = req.instructions ? tok(req.instructions) : 0;
  const row: LedgerRow = {
    t: new Date().toISOString(),
    task,
    label,
    status: res.status,
    inputChars: req.input.length,
    inputTok,
    instrTok,
    audioSec,
    estUsd: ok ? estimateUsd(inputTok, instrTok, audioSec ?? guessSec(req.input)) : 0,
  };
  ensureDir(OUT);
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  await sleep(250);
  return {
    status: res.status,
    headers: redactHeaders(res.headers),
    body: ok ? buf : new Uint8Array(),
    ms,
    errorBody: ok ? undefined : new TextDecoder().decode(buf),
  };
}

export function appendLedger(row: LedgerRow) {
  ensureDir(OUT);
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
}

export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const p95 = s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  return { n: s.length, mean, p95, max: s[s.length - 1], min: s[0] };
}
