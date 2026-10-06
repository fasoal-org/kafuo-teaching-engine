import { describe, expect, it, vi } from 'vitest';

import { createStartSpacer, lazyBoundedMap, mapWithConcurrency } from '@/lib/utils/concurrency';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Later items resolve first, but results must stay aligned with input.
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms, i) => {
      await tick(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('never runs more than `limit` workers at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 9 }, (_, i) => i),
      3,
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(3); // never exceeds the pool
  });

  it('clamps the limit to the item count (no over-spawn)', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2], 100, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out).toEqual([1, 2]);
  });

  it('stops pulling new items once shouldContinue() turns false', async () => {
    const processed: number[] = [];
    let done = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      1,
      async (n) => {
        processed.push(n);
        done += 1;
        return n;
      },
      { shouldContinue: () => done < 3 },
    );
    // limit 1 + stop after 3 ⇒ items 4–6 are never started.
    expect(processed).toEqual([1, 2, 3]);
  });

  it('handles an empty list without spawning workers', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});

describe('lazyBoundedMap', () => {
  it('returns promises immediately and resolves them without a barrier', async () => {
    const started: number[] = [];
    const promises = lazyBoundedMap([0, 1, 2], 1, async (n) => {
      started.push(n);
      await tick();
      return n * 10;
    });
    expect(promises).toHaveLength(3); // the array of promises exists synchronously
    expect(await promises[0]).toBe(0); // the first resolves on its own…
    expect(started.length).toBeLessThan(3); // …without forcing the last item to run (no barrier)
    expect(await Promise.all(promises)).toEqual([0, 10, 20]); // order + values preserved
  });

  it('caps in-flight work at `limit`', async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      lazyBoundedMap(
        Array.from({ length: 8 }, (_, i) => i),
        3,
        async (n) => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
          return n;
        },
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('skips items via shouldContinue without running fn', async () => {
    const ran: number[] = [];
    let done = 0;
    const out = await Promise.all(
      lazyBoundedMap(
        [1, 2, 3, 4, 5],
        1,
        async (n) => {
          ran.push(n);
          done += 1;
          return n;
        },
        { shouldContinue: () => done < 2 },
      ),
    );
    expect(ran).toEqual([1, 2]); // fn ran only twice
    expect(out).toEqual([1, 2, undefined, undefined, undefined]); // skipped → undefined
  });
});

describe('createStartSpacer', () => {
  it('never waits when the gap is 0', async () => {
    const waits: number[] = [];
    const spacer = createStartSpacer(0, async (ms) => void waits.push(ms));
    await Promise.all([spacer.wait(), spacer.wait(), spacer.wait()]);
    expect(waits).toEqual([]);
  });

  it('starts each caller gapMs after the previous one actually started', async () => {
    const waits: number[] = [];
    const spacer = createStartSpacer(1000, async (ms) => void waits.push(ms));
    await Promise.all([spacer.wait(), spacer.wait(), spacer.wait()]);
    // The first starts now; each later one waits a full gap from the one before.
    expect(waits).toHaveLength(2);
    for (const ms of waits) {
      expect(ms).toBeGreaterThan(990);
      expect(ms).toBeLessThanOrEqual(1000);
    }
  });

  it('measures from a late start, never from a fixed schedule', async () => {
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const waits: number[] = [];
    // The first sleep overruns by 300 ms (a busy event loop).
    const spacer = createStartSpacer(1000, async (ms) => {
      waits.push(ms);
      clock += waits.length === 1 ? ms + 300 : ms;
    });
    await Promise.all([spacer.wait(), spacer.wait(), spacer.wait()]);
    nowSpy.mockRestore();
    // Second caller started at 1300, so the third still waits a full 1000.
    expect(waits).toEqual([1000, 1000]);
  });
});
