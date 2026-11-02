/**
 * The size-capped raw outline answer kept for diagnosis (lesson 306, F-1): a
 * cut never leaves a lone surrogate, which Postgres JSONB refuses.
 */
import { describe, expect, it } from 'vitest';

import { captureOutlineAnswer } from '@/lib/server/classroom-generation';

const REPORT = { parse: null, malformed: [] };
const MATH_X = '\u{1D465}'; // 𝑥: one character, two UTF-16 code units

function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('captureOutlineAnswer', () => {
  it('keeps a short answer whole', () => {
    const capture = captureOutlineAnswer('{"outlines":[]}', REPORT);
    expect(capture.rawHead).toBe('{"outlines":[]}');
    expect(capture.rawTail).toBe('');
  });

  it('never splits a surrogate pair at either cut', () => {
    // A pair straddles the head cut (8191/8192) and the tail cut.
    const raw = 'a'.repeat(8_191) + MATH_X + 'b'.repeat(20_000) + MATH_X + 'c'.repeat(8_191);
    const capture = captureOutlineAnswer(raw, REPORT);
    expect(capture.rawLength).toBe(raw.length);
    expect(hasLoneSurrogate(capture.rawHead)).toBe(false);
    expect(hasLoneSurrogate(capture.rawTail)).toBe(false);
    expect(() => JSON.parse(JSON.stringify(capture))).not.toThrow();
  });
});
