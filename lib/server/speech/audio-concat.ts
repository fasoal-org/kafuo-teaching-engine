/**
 * Joins segment audio into one asset per Action (plan §13.2, Wave 0 M6).
 *
 * MP3 (default): frame-level join. Tag and header frames (ID3v2, ID3v1,
 * Xing/Info, VBRI) are stripped as a defence — today's API emits none — and
 * every part must share MPEG version, layer, sample rate, channel mode and
 * bitrate, or the join fails (the Action then fails all-or-nothing).
 *
 * WAV (fallback, implemented but unused in V1): the PCM data of every part
 * under ONE rewritten RIFF header — the API's headers carry 0xFFFFFFFF size
 * placeholders (M6), so they are never trusted.
 */

export class AudioConcatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioConcatError';
  }
}

interface Mp3Frame {
  offset: number;
  length: number;
  version: number; // 1, 2, 25 (2.5)
  layer: number;
  bitrate: number; // kbps
  sampleRate: number;
  channelMode: number;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
};

function readFrame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset]!;
  const b2 = bytes[offset + 1]!;
  const b3 = bytes[offset + 2]!;
  const b4 = bytes[offset + 3]!;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
  const versionBits = (b2 >> 3) & 0x3;
  const layerBits = (b2 >> 1) & 0x3;
  if (versionBits === 1 || layerBits !== 1) return null; // reserved version; Layer III only
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const bitrateIndex = (b3 >> 4) & 0xf;
  const sampleIndex = (b3 >> 2) & 0x3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const bitrate = (version === 1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version]![sampleIndex]!;
  const padding = (b3 >> 1) & 0x1;
  const length = Math.floor(((version === 1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding;
  return { offset, length, version, layer: 3, bitrate, sampleRate, channelMode: (b4 >> 6) & 0x3 };
}

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function hasId3v1(bytes: Uint8Array): boolean {
  const at = bytes.length - 128;
  return at >= 0 && bytes[at] === 0x54 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x47;
}

/** True when a frame is a Xing/Info or VBRI header frame (no audio). */
function isHeaderFrame(bytes: Uint8Array, frame: Mp3Frame): boolean {
  const mono = frame.channelMode === 3;
  const sideInfo = frame.version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const tagAt = (at: number, tag: string) =>
    [...tag].every((ch, i) => bytes[frame.offset + at + i] === ch.charCodeAt(0));
  return tagAt(4 + sideInfo, 'Xing') || tagAt(4 + sideInfo, 'Info') || tagAt(36, 'VBRI');
}

export interface Mp3Inspection {
  frames: Mp3Frame[];
  /** Seconds of audio (frame count × samples per frame / sample rate). */
  durationSeconds: number;
}

/** Parses the audio frames of one MP3 part, skipping tag/header frames. */
export function inspectMp3(bytes: Uint8Array): Mp3Inspection {
  const end = hasId3v1(bytes) ? bytes.length - 128 : bytes.length;
  let offset = id3v2Length(bytes);
  const frames: Mp3Frame[] = [];
  while (offset < end) {
    const frame = readFrame(bytes, offset);
    if (!frame || frame.length <= 4 || offset + frame.length > end) {
      if (frames.length === 0 && offset < end) throw new AudioConcatError('not an MPEG Layer III stream');
      break;
    }
    if (!(frames.length === 0 && isHeaderFrame(bytes, frame))) frames.push(frame);
    offset += frame.length;
  }
  if (frames.length === 0) throw new AudioConcatError('MP3 part has no audio frames');
  const first = frames[0]!;
  const samplesPerFrame = first.version === 1 ? 1152 : 576;
  return { frames, durationSeconds: (frames.length * samplesPerFrame) / first.sampleRate };
}

export function joinMp3(parts: readonly Uint8Array[]): { bytes: Uint8Array; durationSeconds: number } {
  if (parts.length === 0) throw new AudioConcatError('nothing to join');
  const inspected = parts.map(inspectMp3);
  const ref = inspected[0]!.frames[0]!;
  for (const part of inspected) {
    for (const frame of part.frames) {
      if (
        frame.version !== ref.version ||
        frame.sampleRate !== ref.sampleRate ||
        frame.channelMode !== ref.channelMode ||
        frame.bitrate !== ref.bitrate
      ) {
        throw new AudioConcatError('MP3 parts differ in version, sample rate, channels or bitrate');
      }
    }
  }
  const size = inspected.reduce((n, part) => n + part.frames.reduce((m, f) => m + f.length, 0), 0);
  const out = new Uint8Array(size);
  let at = 0;
  inspected.forEach((part, i) => {
    for (const frame of part.frames) {
      out.set(parts[i]!.subarray(frame.offset, frame.offset + frame.length), at);
      at += frame.length;
    }
  });
  return { bytes: out, durationSeconds: inspected.reduce((n, p) => n + p.durationSeconds, 0) };
}

interface WavPart {
  fmt: Uint8Array;
  data: Uint8Array;
  byteRate: number;
}

function readWav(bytes: Uint8Array): WavPart {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new AudioConcatError('not a WAV part');
  let at = 12;
  let fmt: Uint8Array | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const declared = view.getUint32(at + 4, true);
    if (id === 'data') {
      // Streaming placeholder sizes (0xFFFFFFFF) mean "to the end" (M6).
      const size = declared === 0xffffffff || at + 8 + declared > bytes.length ? bytes.length - at - 8 : declared;
      if (!fmt) throw new AudioConcatError('WAV data before fmt');
      const fmtView = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
      return { fmt, data: bytes.subarray(at + 8, at + 8 + size), byteRate: fmtView.getUint32(8, true) };
    }
    if (id === 'fmt ') fmt = bytes.subarray(at + 8, at + 8 + declared);
    at += 8 + declared + (declared % 2);
  }
  throw new AudioConcatError('WAV part has no data chunk');
}

export function joinWav(parts: readonly Uint8Array[]): { bytes: Uint8Array; durationSeconds: number } {
  if (parts.length === 0) throw new AudioConcatError('nothing to join');
  const read = parts.map(readWav);
  const fmt = read[0]!.fmt;
  for (const part of read) {
    if (part.fmt.length !== fmt.length || part.fmt.some((b, i) => b !== fmt[i])) {
      throw new AudioConcatError('WAV parts differ in format');
    }
  }
  const dataSize = read.reduce((n, part) => n + part.data.length, 0);
  const out = new Uint8Array(12 + 8 + fmt.length + 8 + dataSize);
  const view = new DataView(out.buffer);
  const writeTag = (at: number, text: string) => [...text].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  writeTag(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  const dataAt = 20 + fmt.length;
  writeTag(dataAt, 'data');
  view.setUint32(dataAt + 4, dataSize, true);
  let at = dataAt + 8;
  for (const part of read) {
    out.set(part.data, at);
    at += part.data.length;
  }
  return { bytes: out, durationSeconds: dataSize / read[0]!.byteRate };
}

/** Audio duration in seconds, or `null` when the format cannot be measured. */
export function audioDurationSeconds(bytes: Uint8Array, format: string): number | null {
  try {
    if (format === 'mp3') return inspectMp3(bytes).durationSeconds;
    if (format === 'wav') {
      const part = readWav(bytes);
      return part.data.length / part.byteRate;
    }
  } catch {
    return null;
  }
  return null;
}

/** Joins parts of one Action; a single part passes through unchanged. */
export function joinAudio(
  parts: readonly Uint8Array[],
  format: string,
): { bytes: Uint8Array; durationSeconds: number | null } {
  if (parts.length === 1) return { bytes: parts[0]!, durationSeconds: audioDurationSeconds(parts[0]!, format) };
  if (format === 'mp3') return joinMp3(parts);
  if (format === 'wav') return joinWav(parts);
  throw new AudioConcatError(`cannot join multi-segment ${format} audio`);
}
