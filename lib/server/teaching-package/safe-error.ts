/**
 * Safe error description for logs (plan §4.4.6). Error MESSAGES routinely
 * embed URLs, hostnames, and upstream bodies — including signed retrieval
 * URLs whose query parameters are transient credentials. Structured error
 * logging therefore carries only `{name, code?, status?}` and never the
 * message or cause chain.
 */
export interface SafeErrorDescriptor {
  name: string;
  code?: string;
  status?: number;
}

export function describeErrorSafely(error: unknown): SafeErrorDescriptor {
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown; code?: unknown; status?: unknown };
    const descriptor: SafeErrorDescriptor = {
      name: typeof record.name === 'string' && record.name ? record.name : 'Error',
    };
    if (typeof record.code === 'string' && record.code) descriptor.code = record.code;
    if (typeof record.status === 'number' && Number.isFinite(record.status)) {
      descriptor.status = record.status;
    }
    return descriptor;
  }
  return { name: 'Error' };
}

/**
 * Kafuo-facing deployment fail-fast (plan §4.4.6), extracted so the boot check
 * is directly testable.
 *
 * `TEACHING_ENGINE_SERVICE_KEY` being set is what "the integration is enabled"
 * means here, and the invariants below hold in EVERY environment once it is:
 * a database to hold the delivery rows, a webhook destination, a dedicated
 * webhook secret, and that secret being a different value from the service key.
 *
 * These used to be checked in production only, so a development deployment with
 * a mistyped `TEACHING_ENGINE_WEBHOOK_URL`, a missing
 * `TEACHING_ENGINE_WEBHOOK_SECRET`, or a secret copy-pasted from the service key
 * booted quietly and then failed EVERY delivery — a 404 for the wrong path, a
 * 401 for the wrong secret. Those are precisely the historical failures this
 * check exists to turn into a boot error instead of a per-delivery one.
 *
 * Only the scheme stays production-specific: production demands `https://` by
 * default. Development may name an explicit `http://localhost` (or
 * `http://127.0.0.1`) receiver, and a local standalone production build may do
 * the same only through the explicit `TEACHING_ENGINE_ALLOW_INSECURE_LOCAL_WEBHOOK`
 * opt-in.
 *
 * `ACCESS_CODE` is no longer refused alongside the service key: the gate's
 * allow-list (`lib/config/access-code-allowlist.ts`) lets the Backend's and the
 * mobile app's routes through on their own credentials, so the handoff cannot
 * be silently broken by it (tests/middleware/access-code-gate.test.ts).
 *
 * No message contains a secret VALUE — only the env var name that is wrong.
 * A value would leak into logs, CI output and crash reporters.
 */
export function validateTeachingEngineIntegrationConfig(env: {
  serviceKey: string;
  isProduction: boolean;
  allowInsecureLoopbackWebhook: boolean;
  databaseUrl: string;
  webhookUrl: string;
  webhookSecret: string;
}): void {
  // Not enabled: nothing to validate, in any environment.
  if (!env.serviceKey) return;

  const where = env.isProduction ? ' in production' : '';
  if (!env.databaseUrl) {
    throw new Error(
      `INTEGRATION_NOT_CONFIGURED: DATABASE_URL is required when TEACHING_ENGINE_SERVICE_KEY is set${where}`,
    );
  }
  if (!env.webhookUrl) {
    throw new Error(
      `INTEGRATION_NOT_CONFIGURED: TEACHING_ENGINE_WEBHOOK_URL is required when TEACHING_ENGINE_SERVICE_KEY is set${where}`,
    );
  }
  if (
    !isAcceptableWebhookUrl(
      env.webhookUrl,
      env.isProduction,
      env.allowInsecureLoopbackWebhook,
    )
  ) {
    throw new Error(
      env.isProduction
        ? 'INTEGRATION_NOT_CONFIGURED: TEACHING_ENGINE_WEBHOOK_URL must be an https URL when TEACHING_ENGINE_SERVICE_KEY is set in production'
        : 'INTEGRATION_NOT_CONFIGURED: TEACHING_ENGINE_WEBHOOK_URL must be an https URL, or an explicit http://localhost / http://127.0.0.1 URL in development',
    );
  }
  if (!env.webhookSecret) {
    throw new Error(
      `INTEGRATION_NOT_CONFIGURED: TEACHING_ENGINE_WEBHOOK_SECRET is required when TEACHING_ENGINE_SERVICE_KEY is set${where}`,
    );
  }
  if (env.webhookSecret === env.serviceKey) {
    // Signing inbound webhooks with the service key would make possession of
    // either credential sufficient for both roles.
    throw new Error(
      'INTEGRATION_NOT_CONFIGURED: TEACHING_ENGINE_WEBHOOK_SECRET must differ from TEACHING_ENGINE_SERVICE_KEY',
    );
  }
}

/**
 * `https://` anywhere; additionally an explicit loopback `http://` host in
 * development, or in production with the local-only opt-in. Parsed rather than
 * prefix-matched, so `https://evil/?x=localhost` and
 * `http://localhost.attacker.test` are judged on their real host.
 */
function isAcceptableWebhookUrl(
  rawUrl: string,
  isProduction: boolean,
  allowInsecureLoopbackWebhook: boolean,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!isLoopback) return false;
  return !isProduction || allowInsecureLoopbackWebhook;
}
