/**
 * Node-only process startup, split out of `instrumentation.ts`.
 *
 * WHY A SEPARATE MODULE: Next compiles `instrumentation.ts` for BOTH runtimes and
 * statically analyses the Edge copy for Node-only APIs. `register()`'s
 * `process.env.NEXT_RUNTIME !== 'nodejs'` guard is a RUNTIME check, so it cannot
 * stop a BUILD-time scan: the analyser still saw `process.once('SIGTERM', ...)`
 * sitting in the module and emitted
 *
 *   A Node.js API is used (process.once at line: 145) which is not supported in
 *   the Edge Runtime.
 *
 * Moving the whole Node-only body behind a dynamic `import()` that only the
 * nodejs branch evaluates means the Edge copy of `instrumentation.ts` contains
 * no `process.once` to find — the reference lives in a module the Edge bundle
 * never pulls in. This is the boundary Next documents for runtime-specific
 * instrumentation, and the same one the dynamic imports below already relied on
 * to keep `pg` out of the Edge bundle.
 *
 * Nothing here is suppressed or hidden from the analyser: `process.once` is still
 * written plainly, in a module that is only ever loaded on Node.
 *
 * `register` must return before the server is ready, so nothing here may block on
 * I/O. Starting a timer does not.
 */
export async function registerNodeInstrumentation(): Promise<void> {
  // The asset quota, read here rather than at the first persistence request.
  // The provider that consumes it is lazy and memoised, so a malformed ceiling
  // would otherwise let the process boot, pass its health check, and then fail
  // every persistence request -- documents and runtime included -- until it was
  // fixed and the process restarted. `register` runs before the server is
  // ready, so throwing here is what makes a misconfigured deployment fail to
  // start instead of failing to work. First, so the throw cannot skip the
  // teardown registration for something this function has already started.
  const { resolveAssetQuotaBytes } = await import('@/lib/persistence/asset-quota');
  resolveAssetQuotaBytes();

  // Imported dynamically so the Edge bundle never pulls in `pg`.
  const { startAssetCollectorSchedule } =
    await import('@/lib/persistence/asset-collector-schedule');
  const assetSchedule = startAssetCollectorSchedule();

  // Warn-first boot-time validation of model routing config (MODEL_ROUTES,
  // DEFAULT_MODEL, <PREFIX>_MODELS). Cheap and non-throwing: broken config
  // surfaces here as [config] warnings instead of failing at request time.
  // Imported dynamically so the Edge bundle never pulls in the fs/js-yaml
  // backed provider config it reads.
  const { validateServerConfig, validateSubjectRoutingConfig } = await import(
    '@/lib/server/config-validation'
  );
  validateServerConfig();
  // Kafuo R1 subject routing (plan §7.1): THROWS, unlike the warn-only check
  // above, when routing is enforced, the Teaching Package API is configured
  // and a policy model is unregistered or unkeyed — every teaching call would
  // otherwise refuse with SUBJECT_ROUTE_UNAVAILABLE. No-op with
  // TEACHING_SUBJECT_ROUTING=off.
  validateSubjectRoutingConfig();

  // Kafuo-facing deployment fail-fast (plan §4.4.6): throwing here makes a
  // misconfigured deployment fail to start instead of failing to work.
  {
    const { validateTeachingEngineIntegrationConfig } = await import(
      '@/lib/server/teaching-package/safe-error'
    );
    validateTeachingEngineIntegrationConfig({
      serviceKey: process.env.TEACHING_ENGINE_SERVICE_KEY?.trim() ?? '',
      isProduction: process.env.NODE_ENV === 'production',
      databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
      webhookUrl: process.env.TEACHING_ENGINE_WEBHOOK_URL?.trim() ?? '',
      webhookSecret: process.env.TEACHING_ENGINE_WEBHOOK_SECRET?.trim() ?? '',
      accessCode: process.env.ACCESS_CODE?.trim() ?? '',
    });
  }

  // Restart-safe webhook delivery: boot scan + interval sweep (also reclaims
  // stale generation attempts and emits their failure events).
  //
  // Starts only when the Teaching Package API is configured — the schedule's own
  // gate, the same one every `app/api/teaching-packages/**` route keys on. It runs
  // AFTER the fail-fast validation above, so a production deployment that is
  // half-configured still refuses to boot; the gate only decides whether a
  // deployment that legitimately has no Teaching Package integration (the usual
  // development case) sweeps for it. Previously it always started, and swept every
  // 30 s against an empty connection string.
  const { startWebhookDeliverySchedule } = await import(
    '@/lib/server/teaching-package/webhook-delivery'
  );
  const webhookSchedule = startWebhookDeliverySchedule();

  // Kafuo R1 ledger accounting sweeper (plan §7.7 step 4, §9.4): boot pass +
  // 60 s sweep + 30 s worker heartbeat, in every instance. Same gate as the
  // webhook schedule; `undefined` when the Teaching Package API is off.
  const { startAccountingSweeper } = await import(
    '@/lib/server/teaching-model/accounting-sweeper'
  );
  // Retention passes ride the same sweep (P6: legacy_help_turns, 7 days).
  const { registerLegacyHelpRetention } = await import('@/lib/server/tutor/legacy-help-service');
  registerLegacyHelpRetention();
  const accountingSweeper = startAccountingSweeper();

  // Kafuo R1 meter finalize outbox sweeper (plan §8.6, §9.4): boot pass +
  // 30 s sweep in every instance, lease-claimed so instances are replaceable.
  // Same gate; registers itself with the sweep registry for the internal
  // sweep route and the health block.
  const { startMeterOutboxSweeper } = await import(
    '@/lib/server/teaching-model/meter-outbox-sweeper'
  );
  const meterOutboxSweeper = startMeterOutboxSweeper();

  let runner: import('@/lib/server/agent-runtime/runner').AgentRunnerHandle | undefined;
  let extractionRunner:
    | import('@/lib/server/material-extraction/runner').MaterialExtractionRunnerHandle
    | undefined;
  let stopAgentEventNotifyBus: (() => Promise<void>) | null = null;
  try {
    const { isAgentRuntimeConfigured } = await import('@/lib/config/feature-flags');
    if (isAgentRuntimeConfigured()) {
      // One dedicated LISTEN connection per application instance. The HTTP
      // SSE routes and the runner share its in-process fanout registry; it is
      // not a pool client and never scales with the number of streams.
      const { startAgentEventNotifyBus } =
        await import('@/lib/server/agent-runtime/event-notify-bus');
      const eventNotifyBus = startAgentEventNotifyBus();
      stopAgentEventNotifyBus = () => eventNotifyBus.stop();
      // startAgentRunner only installs a timer. Store/schema initialization is
      // retained behind the store's lazy promise and never blocks register().
      const runtime = await import('@/lib/server/agent-runtime/runner');
      runner = runtime.startAgentRunner();
      const extraction = await import('@/lib/server/material-extraction/runner');
      extractionRunner = extraction.startMaterialExtractionRunner();
    }
  } catch (error) {
    console.error('[instrumentation] Agent runtime startup failed', error);
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Park sessions before any pool they use is closed. This preserves the
      // last durable entry-tree checkpoint for immediate takeover.
      try {
        await extractionRunner?.stop();
      } catch (error) {
        console.error('[instrumentation] Material extraction runner drain failed', error);
      }
      try {
        await runner?.stop();
      } catch (error) {
        console.error('[instrumentation] Agent runner drain failed', error);
      }
      try {
        await stopAgentEventNotifyBus?.();
      } catch (error) {
        console.error('[instrumentation] Agent event notify bus drain failed', error);
      }
      try {
        await assetSchedule?.stop();
      } catch (error) {
        console.error('[instrumentation] Asset collector drain failed', error);
      }
      try {
        // Optional: absent when the Teaching Package API is not configured.
        await webhookSchedule?.stop();
      } catch (error) {
        console.error('[instrumentation] Webhook delivery drain failed', error);
      }
      // Ledger accounting, BEFORE the pool is ended: the retry queue's drain
      // is the last chance for a deferred completion write to land (plan
      // §7.7 step 3), and the sweeper's timers must not fire against a
      // closed pool.
      try {
        const { drainOnShutdown } = await import(
          '@/lib/server/teaching-model/ledger-retry-queue'
        );
        await drainOnShutdown();
      } catch (error) {
        console.error('[instrumentation] Ledger retry queue drain failed', error);
      }
      try {
        await accountingSweeper?.stop();
      } catch (error) {
        console.error('[instrumentation] Accounting sweeper stop failed', error);
      }
      // Meter outbox, BEFORE the pool is ended: `stop()` waits for an
      // in-flight pass and releases this worker's leases (plan §9.4 item 4)
      // so a successor picks the rows up without waiting out the lease.
      try {
        await meterOutboxSweeper?.stop();
      } catch (error) {
        console.error('[instrumentation] Meter outbox sweeper stop failed', error);
      }
      const connectionString = process.env.DATABASE_URL?.trim();
      if (connectionString) {
        try {
          const { getServerPersistenceProvider } =
            await import('@/lib/persistence/server-provider');
          const { pool } = await getServerPersistenceProvider(connectionString);
          await pool.end();
        } catch (error) {
          console.error('[instrumentation] Persistence pool shutdown failed', error);
        }
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
