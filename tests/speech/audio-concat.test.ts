/**
 * Segment audio join (plan §13.2, Wave 0 M6): frame-level MP3 join with
 * defensive tag/header stripping and format verification; WAV fallback with
 * one rewritten RIFF header.
 */
import { describe, expect, it } from 'vitest';

import { AudioConcatError, inspectMp3, joinAudio, joinMp3, joinWav } from '@/lib/server/speech/audio-concat';

/** One MPEG-2 Layer III frame, 24 kHz mono 128 kbps (the API's measured shape, M6): 384 bytes. */
function frame(fill = 0, { bitrateIndex = 0xc, xing = false } = {}): Uint8Array {
  // MPEG-2 L3: 72 * 128000 / 24000 = 384 bytes.
  const length = Math.floor((72 * (bitrateIndex === 0xc ? 128 : 160) * 1000) / 24000);
  const out = new Uint8Array(length).fill(fill);
  out[0] = 0xff;
  out[1] = 0xf3; // MPEG-2, Layer III, no CRC
  out[2] = (bitrateIndex << 4) | (0x1 << 2); // 24 kHz
  out[3] = 0xc4; // mono
  if (xing) out.set([0x58, 0x69, 0x6e, 0x67], 4 + 9); // "Xing" after mono MPEG-2 side info
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('MP3 frame join', () => {
  it('matches naive concatenation for header-free API output and sums durations', () => {
    const a = concat(frame(1), frame(2));
    const b = concat(frame(3));
    const joined = joinMp3([a, b]);
    expect(joined.bytes).toEqual(concat(a, b));
    expect(joined.durationSeconds).toBeCloseTo((3 * 576) / 24000, 6);
  });

  it('strips ID3v2, ID3v1 and a Xing header frame defensively', () => {
    const id3v2 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 9, 9, 9, 9]);
    const id3v1 = new Uint8Array(128);
    id3v1.set([0x54, 0x41, 0x47]);
    const part = concat(id3v2, frame(0, { xing: true }), frame(7), id3v1);
    expect(inspectMp3(part).frames).toHaveLength(1);
    expect(joinMp3([part, frame(8)]).bytes).toEqual(concat(frame(7), frame(8)));
  });

  it('fails on parts that differ in bitrate (never joins silently)', () => {
    expect(() => joinMp3([frame(1), frame(2, { bitrateIndex: 0xd })])).toThrow(AudioConcatError);
  });

  it('a single segment passes through unchanged', () => {
    const one = frame(5);
    expect(joinAudio([one], 'mp3').bytes).toBe(one);
  });
});

describe('WAV fallback join (implemented, unused in V1)', () => {
  function wav(samples: number[], placeholder = true): Uint8Array {
    const data = new Uint8Array(new Int16Array(samples).buffer);
    const out = new Uint8Array(44 + data.length);
    const view = new DataView(out.buffer);
    const tag = (at: number, t: string) => [...t].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
    tag(0, 'RIFF');
    view.setUint32(4, placeholder ? 0xffffffff : out.length - 8, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, placeholder ? 0xffffffff : data.length, true);
    out.set(data, 44);
    return out;
  }

  it('rewrites one header over the placeholder sizes and concatenates PCM', () => {
    const joined = joinWav([wav([1, 2]), wav([3])]);
    const view = new DataView(joined.bytes.buffer);
    expect(view.getUint32(4, true)).toBe(joined.bytes.length - 8);
    expect(view.getUint32(40, true)).toBe(6);
    expect(Array.from(new Int16Array(joined.bytes.slice(44).buffer))).toEqual([1, 2, 3]);
    expect(joined.durationSeconds).toBeCloseTo(3 / 24000, 8);
  });
});
