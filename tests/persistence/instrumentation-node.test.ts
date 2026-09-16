/**
 * Node-only process startup and its shutdown chain.
 *
 * `instrumentation.ts` is compiled for both runtimes and statically analysed for
 * the Edge bundle, so its Node-only body — including the `SIGTERM`/`SIGINT`
 * handlers — lives in `@/lib/server/instrumentation-node`. These tests cover
 * that module directly (signal registration, idempotency, teardown order) plus
 * the delegation boundary through `register()`.
 *
 * Every seam the module composes is mocked, leaving its own decisions as the
 * only real behaviour under test. No test may leave a signal listener, a
 * schedule, or a memoized handle behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WEBHOOK_SCHEDULE_KEY = Symbol.for('openmaic.teaching-package.webhook-schedule');

interface Harness {
  /** Teardown calls in the order they actually happened. */
  order: string[];
  resolveAssetQuotaBytes: ReturnType<typeof vi.fn>;
  validateServerConfig: ReturnType<typeof vi.fn>;
  validateTeachingEngineIntegrationConfig: ReturnType<typeof vi.fn>;
  startAssetCollectorSchedule: ReturnType<typeof vi.fn>;
  startWebhookDeliverySchedule: ReturnType<typeof vi.fn>;
  isAgentRuntimeConfigured: ReturnType<typeof vi.fn>;
  poolEnd: ReturnType<typeof vi.fn>;
  getServerPersistenceProvider: ReturnType<typeof vi.fn>;
}

function mockInstrumentationSeams(options?: { agentRuntime?: boolean }): Harness {
  const order: string[] = [];
  const record = (label: string) => async () => {
    order.push(label);
  };

  const harness: Harness = {
    order,
    resolveAssetQuotaBytes: vi.fn(),
    validateServerConfig: vi.fn(),
    validateTeachingEngineIntegrationConfig: vi.fn(),
    startAssetCollectorSchedule: vi.fn(() => ({ stop: vi.fn(record('asset-collector')) })),
    startWebhookDeliverySchedule: vi.fn(() => ({ stop: vi.fn(record('webhook-schedule')) })),
    isAgentRuntimeConfigured: vi.fn(() => options?.agentRuntime ?? false),
    poolEnd: vi.fn(record('postgres-pool')),
    getServerPersistenceProvider: vi.fn(),
  };
  harness.getServerPersistenceProvider = vi.fn(async () => ({ pool: { end: harness.poolEnd } }));

  vi.doMock('@/lib/persistence/asset-quota', () => ({
    resolveAssetQuotaBytes: harness.resolveAssetQuotaBytes,
  }));
  vi.doMock('@/lib/persistence/asset-collector-schedule', () => ({
    startAssetCollectorSchedule: harness.startAssetCollectorSchedule,
  }));
  vi.doMock('@/lib/server/config-validation', () => ({
    validateServerConfig: harness.validateServerConfig,
  }));
  vi.doMock('@/lib/server/teaching-package/safe-error', () => ({
    validateTeachingEngineIntegrationConfig: harness.validateTeachingEngineIntegrationConfig,
  }));
  vi.doMock('@/lib/server/teaching-package/webhook-delivery', () => ({
    startWebhookDeliverySchedule: harness.startWebhookDeliverySchedule,
  }));
  vi.doMock('@/lib/config/feature-flags', () => ({
    isAgentRuntimeConfigured: harness.isAgentRuntimeConfigured,
  }));
  vi.doMock('@/lib/server/agent-runtime/event-notify-bus', () => ({
    startAgentEventNotifyBus: vi.fn(() => ({ stop: vi.fn(record('event-notify-bus')) })),
  }));
  vi.doMock('@/lib/server/agent-runtime/runner', () => ({
    startAgentRunner: vi.fn(() => ({ stop: vi.fn(record('agent-runner')) })),
  }));
  vi.doMock('@/lib/server/material-extraction/runner', () => ({
    startMaterialExtractionRunner: vi.fn(() => ({
      stop: vi.fn(record('material-extraction')),
    })),
  }));
  vi.doMock('@/lib/persistence/server-provider', () => ({
    getServerPersistenceProvider: harness.getServerPersistenceProvider,
  }));

  return harness;
}

/**
 * The SIGTERM/SIGINT handlers the module installed, in registration order.
 *
 * `process.once` is spied rather than left real, so no test installs a listener
 * on the actual process; `vi.restoreAllMocks()` in `afterEach` puts it back.
 */
function captureSignalHandlers(): {
  registered: string[];
  handlerFor: (signal: string) => () => void;
} {
  const handlers = new Map<string, () => void>();
  const registered: string[] = [];
  vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
    registered.push(signal);
    handlers.set(signal, handler);
    return process;
  }) as never);
  return {
    registered,
    handlerFor: (signal) => {
      const handler = handlers.get(signal);
      if (!handler) throw new Error(`no handler registered for ${signal}`);
      return handler;
    },
  };
}

describe('node instrumentation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    (globalThis as Record<symbol, unknown>)[WEBHOOK_SCHEDULE_KEY] = undefined;
    // Every seam is mocked, so nothing may reach a real database.
    vi.stubEnv('DATABASE_URL', 'postgres://instrumentation-node');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
  });

  afterEach(() => {
    // `process.once` is spied, so no real listener is installed; restoring the
    // spy is what keeps the signal table clean for later tests.
    vi.restoreAllMocks();
    (globalThis as Record<symbol, unknown>)[WEBHOOK_SCHEDULE_KEY] = undefined;
    vi.resetModules();
  });

  it('installs one SIGTERM and one SIGINT handler', async () => {
    mockInstrumentationSeams();
    const signals = captureSignalHandlers();

    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();

    // `once`, not `on`: a second signal must not stack another teardown, and
    // exactly these two signals are handled.
    expect(signals.registered).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('drains in the required order and closes the pool last', async () => {
    const harness = mockInstrumentationSeams({ agentRuntime: true });
    const signals = captureSignalHandlers();

    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();
    expect(harness.order).toEqual([]);

    signals.handlerFor('SIGTERM')();
    await vi.waitFor(() => expect(harness.poolEnd).toHaveBeenCalled());

    // Sessions are parked before any pool they use is closed, and the shared
    // PostgreSQL pool is closed only after every consumer has drained.
    expect(harness.order).toEqual([
      'material-extraction',
      'agent-runner',
      'event-notify-bus',
      'asset-collector',
      'webhook-schedule',
      'postgres-pool',
    ]);
  });

  it('runs cleanup once however many signals arrive', async () => {
    const harness = mockInstrumentationSeams({ agentRuntime: true });
    const signals = captureSignalHandlers();

    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();

    // SIGTERM then SIGINT, plus a repeat of each: the memoized shutdown promise
    // is what makes the extra signals no-ops rather than a second teardown.
    signals.handlerFor('SIGTERM')();
    signals.handlerFor('SIGINT')();
    signals.handlerFor('SIGTERM')();
    await vi.waitFor(() => expect(harness.poolEnd).toHaveBeenCalled());

    expect(harness.order).toEqual([
      'material-extraction',
      'agent-runner',
      'event-notify-bus',
      'asset-collector',
      'webhook-schedule',
      'postgres-pool',
    ]);
    expect(harness.poolEnd).toHaveBeenCalledTimes(1);
  });

  it('still drains and closes the pool with the agent runtime disabled', async () => {
    const harness = mockInstrumentationSeams({ agentRuntime: false });
    const signals = captureSignalHandlers();

    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();
    signals.handlerFor('SIGTERM')();
    await vi.waitFor(() => expect(harness.poolEnd).toHaveBeenCalled());

    // The runner seams were never started, so they contribute no teardown step;
    // the remaining order is unchanged.
    expect(harness.order).toEqual(['asset-collector', 'webhook-schedule', 'postgres-pool']);
  });

  it('does not close a pool it never opened', async () => {
    const harness = mockInstrumentationSeams();
    vi.stubEnv('DATABASE_URL', '');
    const signals = captureSignalHandlers();

    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();
    signals.handlerFor('SIGTERM')();
    await vi.waitFor(() => expect(harness.order).toContain('asset-collector'));

    expect(harness.getServerPersistenceProvider).not.toHaveBeenCalled();
    expect(harness.order).not.toContain('postgres-pool');
  });

  it('keeps the production fail-fast validation on the startup path', async () => {
    const harness = mockInstrumentationSeams();
    captureSignalHandlers();

    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();

    expect(harness.resolveAssetQuotaBytes).toHaveBeenCalledOnce();
    expect(harness.validateServerConfig).toHaveBeenCalledOnce();
    expect(harness.validateTeachingEngineIntegrationConfig).toHaveBeenCalledOnce();
  });
});

describe('instrumentation runtime boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/server/instrumentation-node');
    vi.resetModules();
  });

  it('delegates to the node module on the Node.js runtime', async () => {
    const registerNodeInstrumentation = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/server/instrumentation-node', () => ({ registerNodeInstrumentation }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');
    await register();

    expect(registerNodeInstrumentation).toHaveBeenCalledOnce();
  });

  it('performs no node-only initialization on the Edge runtime', async () => {
    const registerNodeInstrumentation = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/server/instrumentation-node', () => ({ registerNodeInstrumentation }));
    const once = vi.spyOn(process, 'once');
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    const { register } = await import('@/instrumentation');
    await register();

    // The Edge path neither loads the node module nor installs a signal handler.
    expect(registerNodeInstrumentation).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
  });

  it('keeps every node-only signal API out of the edge-compiled module', async () => {
    // The build-time guarantee, asserted at the source: Next compiles this file
    // for the Edge bundle and scans it, so a `process.once` reintroduced here
    // would warn again ("A Node.js API is used (process.once ...)") however
    // correct the runtime guard is.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../instrumentation.ts', import.meta.url),
      'utf8',
    );

    for (const nodeOnlyApi of ['process.once', 'process.on(', 'process.exit', 'process.kill']) {
      expect(source).not.toContain(nodeOnlyApi);
    }
    // It reaches the Node-only body the one supported way.
    expect(source).toContain("await import('@/lib/server/instrumentation-node')");
  });
});
