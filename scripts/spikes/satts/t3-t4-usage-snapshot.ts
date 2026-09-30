/**
 * T4 (snapshot pinning) + T3 (usage reporting). SATTS Wave 0. Not shipped.
 * npx tsx scripts/spikes/satts/t3-t4-usage-snapshot.ts
 */
import { PINNED_MODEL, SAUDI_INSTRUCTIONS_V1, SCREENING_SENTENCES } from './fixtures';
import { mp3DurationSec } from './inspect-mp3';
import {
  appendLedger,
  estimateUsd,
  guessSec,
  KEY_SOURCE,
  preflight,
  rawSpeech,
  redactHeaders,
  speech,
  tok,
  writeOut,
} from './lib';

async function sseCall(i: number, input: string) {
  const req = {
    model: PINNED_MODEL,
    voice: 'marin',
    input,
    instructions: SAUDI_INSTRUCTIONS_V1,
    response_format: 'mp3' as const,
    speed: 1.0,
    stream_format: 'sse' as const,
  };
  const { res, ms } = await rawSpeech(req);
  const headers = redactHeaders(res.headers);
  const text = await res.text();
  const events: unknown[] = [];
  const chunks: Uint8Array[] = [];
  let usage: unknown = null;
  // Events arrive as one `data:` line each (not always blank-line separated), so parse per line.
  let pendingEvent: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) {
      pendingEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    const eventName = pendingEvent;
    pendingEvent = null;
    if (data === '[DONE]') {
      events.push({ event: eventName, data: '[DONE]' });
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data);
    } catch {
      events.push({ unparsed: data.slice(0, 200) });
      continue;
    }
    if (typeof obj.audio === 'string') {
      chunks.push(new Uint8Array(Buffer.from(obj.audio, 'base64')));
      obj = { ...obj, audio: `<${(obj.audio as string).length} base64 chars omitted>` };
    }
    if (obj.usage) usage = obj.usage;
    events.push({ event: eventName, ...obj });
  }
  const audio = Buffer.concat(chunks);
  const dur = res.ok ? mp3DurationSec(new Uint8Array(audio)) : null;
  writeOut(`usage/sse-${i}.mp3`, audio);
  // Collapse repeated delta events for readability, keep full list in raw file.
  writeOut(
    `usage/sse-${i}-events.json`,
    JSON.stringify({ status: res.status, ms, headers, events }, null, 2),
  );
  const inputTok = tok(input);
  const instrTok = tok(SAUDI_INSTRUCTIONS_V1);
  appendLedger({
    t: new Date().toISOString(),
    task: 'T3',
    label: `sse-${i}`,
    status: res.status,
    inputChars: input.length,
    inputTok,
    instrTok,
    audioSec: dur,
    usage,
    estUsd: res.ok ? estimateUsd(inputTok, instrTok, dur ?? guessSec(input)) : 0,
  });
  const types = (events as { type?: string }[]).map((e) => e.type ?? '?');
  const summary: Record<string, number> = {};
  for (const t of types) summary[t] = (summary[t] ?? 0) + 1;
  return {
    i,
    status: res.status,
    ms,
    eventTypeCounts: summary,
    usage,
    audioBytes: audio.length,
    audioSec: dur,
    inputChars: input.length,
    o200kInputTok: inputTok,
    o200kInstrTok: instrTok,
  };
}

async function main() {
  console.log(`key source: ${KEY_SOURCE}`);
  const s = SCREENING_SENTENCES;
  preflight(
    'T3+T4',
    (process.argv.includes('--sse-only')
      ? [s[4], s[5], s[6]]
      : [s[0], s[0], s[1], s[2], s[3], s[4], s[5], s[6]]
    ).map((x) => ({ input: x.text, instructions: SAUDI_INSTRUCTIONS_V1 })),
    guessSec,
  );

  const results: Record<string, unknown> = {};
  const sseOnly = process.argv.includes('--sse-only');

  if (!sseOnly) {
    // T4 — pinned vs alias
    const t4: unknown[] = [];
    for (const model of [PINNED_MODEL, 'gpt-4o-mini-tts']) {
      const r = await speech(
        'T4',
        model,
        { model, voice: 'marin', input: s[0].text, instructions: SAUDI_INSTRUCTIONS_V1 },
        mp3DurationSec,
      );
      if (r.body.length) writeOut(`snapshot/${model}.mp3`, r.body);
      t4.push({
        model,
        status: r.status,
        ms: r.ms,
        bytes: r.body.length,
        audioSec: r.body.length ? mp3DurationSec(r.body) : null,
        headers: r.headers,
        errorBody: r.errorBody,
      });
    }
    results.T4 = t4;

    // T3 — non-streaming headers
    const t3ns: unknown[] = [];
    for (const [k, x] of [s[1], s[2], s[3]].entries()) {
      const r = await speech(
        'T3',
        `nonstream-${k + 1}`,
        { model: PINNED_MODEL, voice: 'marin', input: x.text, instructions: SAUDI_INSTRUCTIONS_V1 },
        mp3DurationSec,
      );
      if (r.body.length) writeOut(`usage/nonstream-${k + 1}.mp3`, r.body);
      t3ns.push({
        k: k + 1,
        status: r.status,
        ms: r.ms,
        bytes: r.body.length,
        audioSec: r.body.length ? mp3DurationSec(r.body) : null,
        headers: r.headers,
        errorBody: r.errorBody,
      });
    }
    results.T3_nonStreaming = t3ns;
  }

  // T3 — SSE
  const t3sse: unknown[] = [];
  for (const [k, x] of [s[4], s[5], s[6]].entries()) t3sse.push(await sseCall(k + 1, x.text));
  results.T3_sse = t3sse;

  writeOut(
    sseOnly ? 'usage/results-sse.json' : 'usage/results.json',
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
