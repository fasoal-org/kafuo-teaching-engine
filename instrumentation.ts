/**
 * Process-scoped startup work.
 *
 * Next calls `register` once per server instance, before it serves a request.
 * That makes it the only place in this app where a background schedule can
 * live: a route module has no such guarantee — it can be instantiated more than
 * once and gets no shutdown hook — so anything periodic started from one is
 * really started per instantiation.
 *
 * `register` must return before the server is ready, so nothing here may block
 * on I/O. Starting a timer does not.
 *
 * This file is compiled for BOTH runtimes, and Next statically analyses the Edge
 * copy for Node-only APIs. A runtime guard cannot satisfy a build-time scan, so
 * everything Node-only — the schedules, the runner, the PostgreSQL pool and the
 * `SIGTERM`/`SIGINT` handlers — lives in `@/lib/server/instrumentation-node` and
 * is reached only through the guarded dynamic `import()` below. What stays here
 * must remain free of Node-only APIs.
 */
export async function register(): Promise<void> {
  // Also invoked for the Edge runtime, which has neither `pg` nor timers we
  // want; the persistence stack is Node-only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Dynamic and guarded: the Edge bundle never loads this module, so the
  // Node-only APIs it uses are never part of the Edge graph.
  const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
  await registerNodeInstrumentation();
}
