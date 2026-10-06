/**
 * Minimal MP3 inspector for the SATTS Wave 0 concatenation spike (I5). Not shipped.
 * Usage: npx tsx scripts/spikes/satts/inspect-mp3.ts <file.mp3> [...]
 *
 * Handles MPEG-1/2/2.5 Layer III, ID3v2 (+footer), ID3v1, Xing/Info (+LAME delay/padding) and VBRI.
 */
import { readFileSync } from 'node:fs';

const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

export interface FrameHeader {
  version: '1' | '2' | '2.5';
  layer: number;
  bitrateKbps: number;
  sampleRate: number;
  padding: number;
  channels: 1 | 2;
  samples: number;
  length: number;
}

export function parseFrameHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const vBits = (b[i + 1] >> 3) & 3;
  const lBits = (b[i + 1] >> 1) & 3;
  if (vBits === 1 || lBits !== 1) return null; // reserved version, or not Layer III
  const version = vBits === 3 ? '1' : vBits === 2 ? '2' : '2.5';
  const brIdx = (b[i + 2] >> 4) & 15;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const bitrateKbps = (version === '1' ? BR_V1_L3 : BR_V2_L3)[brIdx];
  const sampleRate = SR[version][srIdx];
  const padding = (b[i + 2] >> 1) & 1;
  const channels = ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2;
  const coef = version === '1' ? 144 : 72;
  const length = Math.floor((coef * bitrateKbps * 1000) / sampleRate) + padding;
  return {
    version,
    layer: 3,
    bitrateKbps,
    sampleRate,
    padding,
    channels,
    samples: version === '1' ? 1152 : 576,
    length,
  };
}

export interface Mp3Report {
  bytes: number;
  id3v2Bytes: number;
  id3v1: boolean;
  version: string | null;
  sampleRate: number | null;
  channels: number | null;
  frameCount: number; // audio frames, excluding a Xing/Info/VBRI header frame
  bitrates: number[];
  mode: 'CBR' | 'VBR' | 'n/a';
  durationSec: number;
  headerFrame: null | {
    kind: 'Xing' | 'Info' | 'VBRI';
    declaredFrames?: number;
    encoder?: string;
    encoderDelay?: number;
    encoderPadding?: number;
  };
  junkBytes: number;
  firstFrameOffset: number;
}

function id3v2Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function readHeaderFrame(b: Uint8Array, i: number, h: FrameHeader): Mp3Report['headerFrame'] {
  const side = h.version === '1' ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
  const x = i + 4 + side;
  const tag = ascii(b, x, 4);
  if (tag === 'Xing' || tag === 'Info') {
    const flags = (b[x + 4] << 24) | (b[x + 5] << 16) | (b[x + 6] << 8) | b[x + 7];
    let p = x + 8;
    let declaredFrames: number | undefined;
    if (flags & 1) {
      declaredFrames = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      p += 4;
    }
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    const encoder = ascii(b, p, 9)
      .replace(/[^\x20-\x7e]/g, '')
      .trim();
    let encoderDelay: number | undefined;
    let encoderPadding: number | undefined;
    if (/^(LAME|Lavc|Lavf|L3.99)/.test(encoder) && p + 24 <= b.length) {
      encoderDelay = (b[p + 21] << 4) | (b[p + 22] >> 4);
      encoderPadding = ((b[p + 22] & 0x0f) << 8) | b[p + 23];
    }
    return {
      kind: tag,
      declaredFrames,
      encoder: encoder || undefined,
      encoderDelay,
      encoderPadding,
    };
  }
  if (ascii(b, i + 36, 4) === 'VBRI') {
    const declaredFrames =
      ((b[i + 50] << 24) | (b[i + 51] << 16) | (b[i + 52] << 8) | b[i + 53]) >>> 0;
    return { kind: 'VBRI', declaredFrames };
  }
  return null;
}

/** Walks frames. Returns the report plus [start,end) byte ranges of audio frames (header frame excluded). */
export function walkMp3(b: Uint8Array): { report: Mp3Report; audioRanges: [number, number][] } {
  const id3v2Bytes = id3v2Size(b);
  const id3v1 = b.length >= 128 && ascii(b, b.length - 128, 3) === 'TAG';
  const end = id3v1 ? b.length - 128 : b.length;
  let i = id3v2Bytes;
  let junk = 0;
  const ranges: [number, number][] = [];
  const bitrates = new Set<number>();
  let first: FrameHeader | null = null;
  let firstOffset = -1;
  let headerFrame: Mp3Report['headerFrame'] = null;
  let samples = 0;
  while (i < end) {
    const h = parseFrameHeader(b, i);
    // require the next header to also be valid (or EOF) to avoid false syncs
    if (!h || (i + h.length < end && !parseFrameHeader(b, i + h.length) && i + h.length !== end)) {
      i++;
      junk++;
      continue;
    }
    if (!first) {
      first = h;
      firstOffset = i;
      headerFrame = readHeaderFrame(b, i, h);
      if (headerFrame) {
        i += h.length;
        continue;
      }
    }
    ranges.push([i, Math.min(i + h.length, end)]);
    bitrates.add(h.bitrateKbps);
    samples += h.samples;
    i += h.length;
  }
  const sr = first?.sampleRate ?? 0;
  return {
    report: {
      bytes: b.length,
      id3v2Bytes,
      id3v1,
      version: first?.version ?? null,
      sampleRate: first?.sampleRate ?? null,
      channels: first?.channels ?? null,
      frameCount: ranges.length,
      bitrates: [...bitrates].sort((a, c) => a - c),
      mode: bitrates.size === 0 ? 'n/a' : bitrates.size === 1 ? 'CBR' : 'VBR',
      durationSec: sr ? samples / sr : 0,
      headerFrame,
      junkBytes: junk,
      firstFrameOffset: firstOffset,
    },
    audioRanges: ranges,
  };
}

export const inspectMp3 = (b: Uint8Array) => walkMp3(b).report;
export const mp3DurationSec = (b: Uint8Array) => walkMp3(b).report.durationSec;

/** Audio frames only: no ID3v2, no ID3v1, no Xing/Info/VBRI frame. */
export function stripToFrames(b: Uint8Array): Uint8Array {
  const { audioRanges } = walkMp3(b);
  const total = audioRanges.reduce((a, [s, e]) => a + (e - s), 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const [s, e] of audioRanges) {
    out.set(b.subarray(s, e), o);
    o += e - s;
  }
  return out;
}

if (require.main === module) {
  for (const f of process.argv.slice(2)) {
    console.log(f);
    console.log(JSON.stringify(inspectMp3(new Uint8Array(readFileSync(f))), null, 2));
  }
}
