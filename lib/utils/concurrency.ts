/** A FIFO counting semaphore: at most `size` `run()` callbacks execute at once. */
export function createConcurrencyLimiter(size: number) {
  const max = Math.max(1, Math.floor(size));
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    while (active < max && queue.length > 0) {
      active += 1;
      const start = queue.shift()!;
      start();
    }
  };

  return {
    run<R>(fn: () => Promise<R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        queue.push(() => {
          fn()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              pump();
            });
        });
        pump();
      });
    },
  };
}

/**
 * Start `fn` over every item with at most `limit` calls in flight at once, and
 * return one promise per item **immediately**, in input order — without awaiting
 * them. Each item acquires a `limit`-sized semaphore slot before `fn` runs, so
 * all the promises exist up front but only `limit` execute concurrently.
 *
 * This is the no-barrier primitive: the caller can `await` the promises in any
 * order (e.g. sequentially) and each resolves as soon as *its* work is done,
 * while later items keep running in the background. `shouldContinue` is checked
 * when an item reaches the front of the queue; once it returns false, the
 * remaining items resolve to `undefined` without running `fn`.
 *
 * `limit` is clamped to `[1, items.length]`, so a raw/too-large concurrency is
 * safe to pass.
 */
export function lazyBoundedMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldContinue?: () => boolean },
): Array<Promise<R | undefined>> {
  const shouldContinue = options?.shouldContinue ?? (() => true);
  const semaphore = createConcurrencyLimiter(Math.min(Math.floor(limit), items.length || 1));
  return items.map((item, index) =>
    semaphore.run(async () => (shouldContinue() ? fn(item, index) : undefined)),
  );
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once and await
 * them all (a barrier). Results are returned in input order; a slot is
 * `undefined` if its item was skipped because `shouldContinue` turned false.
 *
 * Prefer {@link lazyBoundedMap} when you can consume results incrementally —
 * this wrapper waits for every item before returning.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { shouldContinue?: () => boolean },
): Promise<Array<R | undefined>> {
  return Promise.all(lazyBoundedMap(items, limit, fn, options));
}

/**
 * Paces call starts: each `wait()` resolves at least `gapMs` after the previous
 * `wait()` ACTUALLY resolved, in call order, so a pool never bursts several
 * provider requests into the same second — even when one timer fires late, the
 * next start is measured from it rather than from a fixed schedule.
 * `gapMs <= 0` never waits.
 */
export function createStartSpacer(
  gapMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): { wait(): Promise<void> } {
  // Resolves to the time the previous caller actually started.
  let previousStart: Promise<number> = Promise.resolve(Number.NEGATIVE_INFINITY);
  return {
    wait() {
      if (!(gapMs > 0)) return Promise.resolve();
      const start = previousStart.then(async (previous) => {
        const delay = previous + gapMs - Date.now();
        if (delay > 0) await sleep(delay);
        return Date.now();
      });
      previousStart = start;
      return start.then(() => undefined);
    },
  };
}
