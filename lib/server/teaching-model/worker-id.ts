/**
 * Process identity for the teaching-model ledger (plan §7.7, §8.6).
 *
 * `hostname:pid:bootNonce`. The nonce is what makes the id unique across a
 * container restart that reuses the same hostname AND pid (Docker gives the
 * entrypoint pid 1 every time): without it, a replaced instance would look to
 * the sweeper like the same worker still heartbeating, and its orphaned
 * `started` rows would never be marked `process_exit_before_completion`.
 *
 * Memoized under a `Symbol.for` key so every module graph in the process
 * (Next dev HMR, the instrumentation bundle) reports the same worker id — the
 * heartbeat and the executor's started rows must agree.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

const WORKER_ID_KEY = Symbol.for('openmaic.teaching-model.worker-id');

export function currentWorkerId(): string {
  const registry = globalThis as Record<symbol, string | undefined>;
  const existing = registry[WORKER_ID_KEY];
  if (existing) return existing;
  const nonce = randomBytes(4).toString('hex');
  const id = `${hostname()}:${process.pid}:${nonce}`;
  registry[WORKER_ID_KEY] = id;
  return id;
}
