/**
 * Registration point for sweepers that later phases add (Kafuo R1 plan §9.4).
 *
 * `POST /api/internal/sweep` and `GET /api/health` are written in P2, before
 * the meter finalize outbox (P5) exists. Rather than editing those routes
 * again, P5 registers its sweeper here at boot and the routes pick it up.
 * Until something registers, the meter fields are `null` — "not present",
 * which the health consumer must distinguish from "present and stuck".
 *
 * `Symbol.for` memo so the instrumentation bundle (which registers) and the
 * route bundle (which reads) share one registry.
 */

export interface MeterSweepResult {
  claimed: number;
  delivered: number;
}

export interface MeterOutboxHealth {
  /** Epoch ms of the last completed sweep in this process, null before the first. */
  lastMeterSweepAt: number | null;
  pendingFinalizes: number | null;
  oldestPendingFinalizeAgeS: number | null;
}

export interface MeterOutboxSweeperHooks {
  runMeterOutboxSweepOnce(): Promise<MeterSweepResult>;
  readMeterOutboxHealth(): Promise<MeterOutboxHealth>;
}

/**
 * A retention pass run by the accounting sweeper on every tick (P6: the
 * 7-day `legacy_help_turns` delete). Receives the sweeper's pool and clock
 * (epoch seconds) and returns the number of rows removed.
 */
export type RetentionSweep = (
  queryable: { query(text: string, params?: unknown[]): Promise<unknown> },
  nowS: number,
) => Promise<number>;

const REGISTRY_KEY = Symbol.for('openmaic.teaching-model.sweep-registry');

interface Registry {
  meterOutbox?: MeterOutboxSweeperHooks;
  retention?: Map<string, RetentionSweep>;
}

function registry(): Registry {
  const globals = globalThis as Record<symbol, Registry | undefined>;
  return (globals[REGISTRY_KEY] ??= {});
}

export function registerRetentionSweep(name: string, sweep: RetentionSweep | undefined): void {
  const r = registry();
  r.retention ??= new Map();
  if (sweep) r.retention.set(name, sweep);
  else r.retention.delete(name);
}

export function getRetentionSweeps(): Array<[string, RetentionSweep]> {
  return [...(registry().retention ?? new Map<string, RetentionSweep>()).entries()];
}

export function registerMeterOutboxSweeper(hooks: MeterOutboxSweeperHooks | undefined): void {
  registry().meterOutbox = hooks;
}

export function getMeterOutboxSweeper(): MeterOutboxSweeperHooks | undefined {
  return registry().meterOutbox;
}
