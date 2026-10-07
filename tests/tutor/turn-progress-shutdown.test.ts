/**
 * TE-1 / D5: the SIGTERM chain in `@/lib/server/instrumentation-node` marks
 * this worker's in-flight tutor turns stale FIRST (while every pool is open),
 * and a failure there never stops the rest of the shutdown.
 *
 * Every seam the module composes is mocked (same approach as
 * `tests/persistence/instrumentation-node.test.ts`); `process.once` is spied,
 * so no real signal listener is installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEBHOOK_SCHEDULE_KEY = Symbol.for('openmaic.teaching-package.webhook-schedule');

function mockSeams(markInFlightTurnsStale: () => Promise<unknown>) {
  const order: string[] = [];
  const record = (label: string) => async () => {
    order.push(label);
  };
  const poolEnd = vi.fn(record('postgres-pool'));
  vi.doMock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
  vi.doMock('@/lib/persistence/asset-collector-schedule', () => ({
    startAssetCollectorSchedule: vi.fn(() => ({ stop: vi.fn(record('asset-collector')) })),
  }));
  vi.doMock('@/lib/server/config-validation', () => ({
    validateServerConfig: vi.fn(),
    validateSubjectRoutingConfig: vi.fn(),
  }));
  vi.doMock('@/lib/server/teaching-model/accounting-sweeper', () => ({
    startAccountingSweeper: vi.fn(() => ({ stop: vi.fn(record('accounting-sweeper')) })),
  }));
  vi.doMock('@/lib/server/teaching-model/meter-outbox-sweeper', () => ({
    startMeterOutboxSweeper: vi.fn(() => ({ stop: vi.fn(record('meter-outbox-sweeper')) })),
  }));
  vi.doMock('@/lib/server/teaching-model/ledger-retry-queue', () => ({
    drainOnShutdown: vi.fn(record('ledger-retry-drain')),
  }));
  vi.doMock('@/lib/server/teaching-package/safe-error', () => ({
    validateTeachingEngineIntegrationConfig: vi.fn(),
  }));
  vi.doMock('@/lib/server/teaching-package/webhook-delivery', () => ({
    startWebhookDeliverySchedule: vi.fn(() => ({ stop: vi.fn(record('webhook-schedule')) })),
  }));
  vi.doMock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: vi.fn(() => false) }));
  vi.doMock('@/lib/persistence/server-provider', () => ({
    getServerPersistenceProvider: vi.fn(async () => ({ pool: { end: poolEnd } })),
  }));
  vi.doMock('@/lib/server/tutor/turn-progress', () => ({
    markInFlightTurnsStale: vi.fn(async () => {
      order.push('tutor-turns-stale');
      return markInFlightTurnsStale();
    }),
  }));
  return { order, poolEnd };
}

function captureSigterm(): () => void {
  let sigterm: (() => void) | undefined;
  vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
    if (signal === 'SIGTERM') sigterm = handler;
    return process;
  }) as never);
  return () => {
    if (!sigterm) throw new Error('no SIGTERM handler registered');
    sigterm();
  };
}

describe('TE-1: SIGTERM marks in-flight tutor turns stale', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    (globalThis as Record<symbol, unknown>)[WEBHOOK_SCHEDULE_KEY] = undefined;
    vi.stubEnv('DATABASE_URL', 'postgres://turn-progress-shutdown');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as Record<symbol, unknown>)[WEBHOOK_SCHEDULE_KEY] = undefined;
    vi.resetModules();
  });

  it('marks first, before any drain and before the pool is closed', async () => {
    const harness = mockSeams(async () => ({ marked: 1, timedOut: false }));
    const sigterm = captureSigterm();
    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();
    expect(harness.order).toEqual([]);

    sigterm();
    await vi.waitFor(() => expect(harness.poolEnd).toHaveBeenCalled());
    expect(harness.order[0]).toBe('tutor-turns-stale');
    expect(harness.order.at(-1)).toBe('postgres-pool');
  });

  it('a failing mark never stops the rest of the shutdown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = mockSeams(async () => {
      throw new Error('db down');
    });
    const sigterm = captureSigterm();
    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();

    sigterm();
    await vi.waitFor(() => expect(harness.poolEnd).toHaveBeenCalled());
    expect(harness.order).toEqual([
      'tutor-turns-stale',
      'asset-collector',
      'webhook-schedule',
      'ledger-retry-drain',
      'accounting-sweeper',
      'meter-outbox-sweeper',
      'postgres-pool',
    ]);
    expect(errors).toHaveBeenCalledWith(
      '[instrumentation] Marking in-flight tutor turns stale failed',
      expect.any(Error),
    );
  });
});
