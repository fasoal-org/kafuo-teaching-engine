/**
 * Only the lesson-plan (outline) call gets the longer per-attempt limit; every
 * other teaching stage keeps the executor's 110 s default.
 */
import { describe, expect, it } from 'vitest';

import { OUTLINE_TIMEOUT_MS, routedCallOptions } from '@/lib/server/classroom-generation';
import { DEFAULT_TIMEOUT_MS } from '@/lib/server/teaching-model/execute';

describe('routedCallOptions', () => {
  it('gives the outline call 180 s', () => {
    expect(OUTLINE_TIMEOUT_MS).toBe(180_000);
    expect(OUTLINE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(routedCallOptions('scene-outlines-stream', undefined)).toEqual({ timeoutMs: 180_000 });
  });

  it('keeps the default for every other stage, images passed through', () => {
    const images = [{ id: 'src-1', src: 'x' }];
    expect(routedCallOptions('scene-content', images)).toEqual({ images });
    expect(routedCallOptions('scene-actions', undefined)).toEqual({});
  });
});
