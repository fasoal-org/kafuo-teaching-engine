import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainOnShutdown,
  enqueueLedgerCompletion,
  LEDGER_RETRY_HORIZON_MS,
  LEDGER_RETRY_INTERVAL_MS,
  LEDGER_RETRY_MAX_ENTRIES,
  ledgerRetryQueueSize,
  onLedgerLateCompletion,
  resetLedgerRetryQueueForTests,
  tickLedgerRetryQueue,
} from '@/lib/server/teaching-model/ledger-retry-queue';

/**
 * Bounded in-memory ledger retry (Kafuo R1 plan §7.7 step 3): fault
 * injection — a completion write fails, is queued, later succeeds; the bound
 * and the horizon; SIGTERM drain attempts every entry once.
 */
describe('ledger retry queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLedgerRetryQueueForTests();
  });

  afterEach(() => {
    resetLedgerRetryQueueForTests();
    vi.useRealTimers();
  });

  it('retries a failed completion every 5 s until it succeeds, then reports the late completion', async () => {
    let failuresLeft = 2;
    const run = vi.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('db down');
      }
    });
    const late = vi.fn();
    onLedgerLateCompletion(late);

    expect(enqueueLedgerCompletion('a-1', run)).toBe(true);
    expect(ledgerRetryQueueSize()).toBe(1);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ledgerRetryQueueSize()).toBe(1);

    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(3);
    expect(ledgerRetryQueueSize()).toBe(0);
    expect(late).toHaveBeenCalledWith('a-1');

    // Idle queue: the timer is gone, nothing runs again.
    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_INTERVAL_MS * 3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('re-enqueueing the same attempt replaces the closure, never duplicates the entry', async () => {
    const first = vi.fn(async () => {
      throw new Error('x');
    });
    const second = vi.fn(async () => undefined);
    enqueueLedgerCompletion('a-2', first);
    enqueueLedgerCompletion('a-2', second);
    expect(ledgerRetryQueueSize()).toBe(1);
    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_INTERVAL_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(ledgerRetryQueueSize()).toBe(0);
  });

  it('abandons an entry after the 15 min horizon (the sweeper owns it from there)', async () => {
    const run = vi.fn(async () => {
      throw new Error('still down');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueLedgerCompletion('a-3', run);
    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_HORIZON_MS + LEDGER_RETRY_INTERVAL_MS * 2);
    expect(ledgerRetryQueueSize()).toBe(0);
    // Roughly one attempt per interval within the horizon, then a drop.
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(
      LEDGER_RETRY_HORIZON_MS / LEDGER_RETRY_INTERVAL_MS - 1,
    );
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('abandoned'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('refuses the 10,001st entry and says so', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < LEDGER_RETRY_MAX_ENTRIES; i += 1) {
      expect(enqueueLedgerCompletion(`bulk-${i}`, async () => undefined)).toBe(true);
    }
    expect(enqueueLedgerCompletion('one-too-many', async () => undefined)).toBe(false);
    expect(ledgerRetryQueueSize()).toBe(LEDGER_RETRY_MAX_ENTRIES);
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('queue full');
    errorSpy.mockRestore();
  });

  it('drainOnShutdown attempts every entry exactly once and clears the queue', async () => {
    const ok = vi.fn(async () => undefined);
    const bad = vi.fn(async () => {
      throw new Error('nope');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueLedgerCompletion('d-ok', ok);
    enqueueLedgerCompletion('d-bad', bad);
    const result = await drainOnShutdown();
    expect(result).toEqual({ attempted: 2, succeeded: 1 });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(ledgerRetryQueueSize()).toBe(0);
    // The timer was cleared: advancing time runs nothing.
    await vi.advanceTimersByTimeAsync(LEDGER_RETRY_INTERVAL_MS * 2);
    expect(bad).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    expect(await drainOnShutdown()).toEqual({ attempted: 0, succeeded: 0 });
  });

  it('a tick in flight does not overlap with the next one', async () => {
    let resolveFirst: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    enqueueLedgerCompletion('slow', slow);
    const first = tickLedgerRetryQueue();
    const overlapped = await tickLedgerRetryQueue();
    expect(overlapped).toEqual({ succeeded: [], failed: [], expired: [] });
    expect(slow).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    expect((await first).succeeded).toEqual(['slow']);
  });
});
