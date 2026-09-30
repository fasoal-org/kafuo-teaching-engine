/**
 * T5 — MP3 concatenation (I5). Not shipped.
 * (a) naive byte concat, (b) frame-level join (ID3 + Xing/Info/VBRI stripped), (c) single-request reference,
 * (d) WAV parts joined under one rewritten RIFF header (size comparison / fallback reference).
 * Join analysis decodes with macOS built-ins `afconvert`/`afinfo` (system tools, not project dependencies).
 * npx tsx scripts/spikes/satts/t5-concat.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_MODEL, SAUDI_INSTRUCTIONS_V1, SCREENING_SENTENCES } from './fixtures';
import { inspectMp3, mp3DurationSec, stripToFrames } from './inspect-mp3';
import { guessSec, OUT, preflight, speech, writeOut } from './lib';

const full = SCREENING_SENTENCES.find((s) => s.category === 'mixed-long')!.text;
// Split at two clause boundaries ("، ثم" and "، وفي"), keeping the comma with the left part.
const i1 = full.indexOf('، ثم') + 1;
const i2 = full.indexOf('، وفي') + 1;
const parts = [full.slice(0, i1).trim(), full.slice(i1, i2).trim(), full.slice(i2).trim()];

interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  fmt: Uint8Array;
  data: Uint8Array;
  rawHeader: { riffSize: number; dataSize: number };
}
function parseWav(b: Uint8Array): Wav {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const id = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  if (id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('not RIFF/WAVE');
  let o = 12;
  let fmt: Uint8Array | null = null;
  let data: Uint8Array | null = null;
  let dataSize = 0;
  while (o + 8 <= b.length) {
    const cid = id(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (cid === 'fmt ') fmt = b.slice(body, body + size);
    if (cid === 'data') {
      dataSize = size;
      const end = size === 0xffffffff || body + size > b.length ? b.length : body + size; // streaming placeholder sizes
      data = b.slice(body, end);
      break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt/data');
  const f = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  return {
    channels: f.getUint16(2, true),
    sampleRate: f.getUint32(4, true),
    bitsPerSample: f.getUint16(14, true),
    fmt,
    data,
    rawHeader: { riffSize: dv.getUint32(4, true), dataSize },
  };
}
function buildWav(fmt: Uint8Array, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + pcm.length);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, k) => (out[o + k] = c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, out.length - 8, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  const d = 20 + fmt.length;
  w(d, 'data');
  dv.setUint32(d + 4, pcm.length, true);
  out.set(pcm, d + 8);
  return out;
}

/** 10 ms RMS windows of a 16-bit mono PCM → silent runs (< -45 dBFS) of ≥ 30 ms. */
function silentRuns(pcm: Uint8Array, sr: number) {
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const win = Math.round(sr / 100);
  const n = Math.floor(pcm.length / 2);
  const runs: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let s = 0; s + win <= n; s += win) {
    let acc = 0;
    for (let k = 0; k < win; k++) {
      const v = dv.getInt16((s + k) * 2, true) / 32768;
      acc += v * v;
    }
    const db = 10 * Math.log10(acc / win + 1e-12);
    const t = s / sr;
    if (db < -45) {
      if (runStart < 0) runStart = t;
    } else if (runStart >= 0) {
      if (t - runStart >= 0.03) runs.push({ start: runStart, end: t });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ start: runStart, end: n / sr });
  return runs.map((r) => ({
    start: +r.start.toFixed(3),
    end: +r.end.toFixed(3),
    ms: Math.round((r.end - r.start) * 1000),
  }));
}
function decodeToPcm(mp3Path: string) {
  const wavPath = mp3Path.replace(/\.mp3$/, '.decoded.wav');
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', mp3Path, wavPath]);
  return parseWav(new Uint8Array(readFileSync(wavPath)));
}
const afinfoDuration = (p: string) => {
  const m = execFileSync('afinfo', [p])
    .toString()
    .match(/estimated duration:\s*([\d.]+)/);
  return m ? Number(m[1]) : null;
};

async function get(file: string, input: string, fmt: 'mp3' | 'wav') {
  const p = join(OUT, file);
  if (existsSync(p)) return new Uint8Array(readFileSync(p));
  const r = await speech(
    'T5',
    file,
    {
      model: PINNED_MODEL,
      voice: 'marin',
      input,
      instructions: SAUDI_INSTRUCTIONS_V1,
      response_format: fmt,
    },
    fmt === 'mp3'
      ? mp3DurationSec
      : (b) => {
          const w = parseWav(b);
          return w.data.length / (w.sampleRate * w.channels * (w.bitsPerSample / 8));
        },
  );
  if (r.status !== 200) throw new Error(`${file}: ${r.status} ${r.errorBody}`);
  writeOut(file, r.body);
  return r.body;
}

async function main() {
  preflight(
    'T5',
    [...parts, full, ...parts].map((input) => ({ input, instructions: SAUDI_INSTRUCTIONS_V1 })),
    guessSec,
  );
  const mp3Parts: Uint8Array[] = [];
  for (const [k, input] of parts.entries())
    mp3Parts.push(await get(`concat/part-${k + 1}.mp3`, input, 'mp3'));
  await get('concat/c-reference-single-request.mp3', full, 'mp3');

  const a = Buffer.concat(mp3Parts);
  const b = Buffer.concat(mp3Parts.map(stripToFrames));
  writeOut('concat/a-naive-bytes.mp3', a);
  writeOut('concat/b-frame-join.mp3', b);

  const wavParts: Wav[] = [];
  for (const [k, input] of parts.entries())
    wavParts.push(parseWav(await get(`concat/part-${k + 1}.wav`, input, 'wav')));
  const sameFmt = wavParts.every(
    (w) =>
      w.sampleRate === wavParts[0].sampleRate &&
      w.channels === wavParts[0].channels &&
      w.bitsPerSample === wavParts[0].bitsPerSample,
  );
  const d = buildWav(wavParts[0].fmt, Buffer.concat(wavParts.map((w) => w.data)));
  writeOut('concat/d-wav-join.wav', d);

  const files = [
    'part-1.mp3',
    'part-2.mp3',
    'part-3.mp3',
    'a-naive-bytes.mp3',
    'b-frame-join.mp3',
    'c-reference-single-request.mp3',
  ];
  const inspector: Record<string, unknown> = {};
  for (const f of files) {
    const p = join(OUT, 'concat', f);
    inspector[f] = {
      ...inspectMp3(new Uint8Array(readFileSync(p))),
      afinfoDurationSec: afinfoDuration(p),
    };
  }
  const partDur = mp3Parts.map(mp3DurationSec);
  const joins = [partDur[0], partDur[0] + partDur[1]].map((t) => +t.toFixed(3));

  // Silence analysis on decoded audio.
  const decodedB = decodeToPcm(join(OUT, 'concat', 'b-frame-join.mp3'));
  const decodedRef = decodeToPcm(join(OUT, 'concat', 'c-reference-single-request.mp3'));
  const partEdges = mp3Parts.map((_, k) => {
    const w = decodeToPcm(join(OUT, 'concat', `part-${k + 1}.mp3`));
    const runs = silentRuns(w.data, w.sampleRate);
    const dur = w.data.length / 2 / w.sampleRate;
    return {
      part: k + 1,
      decodedSec: +dur.toFixed(3),
      leadingSilenceMs: runs[0]?.start === 0 ? runs[0].ms : 0,
      trailingSilenceMs:
        runs.length && Math.abs(runs[runs.length - 1].end - dur) < 0.02
          ? runs[runs.length - 1].ms
          : 0,
    };
  });
  const bRuns = silentRuns(decodedB.data, decodedB.sampleRate);
  const atJoins = joins.map((t) => ({
    joinAtSec: t,
    silentRun: bRuns.find((r) => r.start - 0.05 <= t && r.end + 0.05 >= t) ?? null,
  }));
  const refRuns = silentRuns(decodedRef.data, decodedRef.sampleRate).filter((r) => r.start > 0.05);

  const wavInfo = wavParts.map((w, k) => ({
    part: k + 1,
    sampleRate: w.sampleRate,
    channels: w.channels,
    bitsPerSample: w.bitsPerSample,
    pcmBytes: w.data.length,
    headerRiffSize: w.rawHeader.riffSize,
    headerDataSize: w.rawHeader.dataSize,
    sec: +(w.data.length / (w.sampleRate * w.channels * (w.bitsPerSample / 8))).toFixed(3),
  }));
  const result = {
    parts,
    joinsAtSec: joins,
    inspector,
    partEdges,
    joinSilenceInB: atJoins,
    referencePausesSilentRuns: refRuns,
    bIdenticalToA: Buffer.compare(a, b) === 0,
    wav: {
      parts: wavInfo,
      sameFormat: sameFmt,
      joinedBytes: d.length,
      mp3JoinedBytes: b.length,
      sizeRatioWavOverMp3: +(d.length / b.length).toFixed(2),
      joinedSec: +(
        wavParts.reduce((s, w) => s + w.data.length, 0) /
        (wavParts[0].sampleRate * wavParts[0].channels * 2)
      ).toFixed(3),
    },
  };
  writeOut('concat/results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
