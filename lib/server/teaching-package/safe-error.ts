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
 * Only two rules stay production-specific:
 *
 * * the scheme — production demands `https://`, while development may name an
 *   explicit `http://localhost` (or `http://127.0.0.1`) receiver, because that
 *   is the real local topology and the alternative is no local validation at all;
 * * the `ACCESS_CODE` incompatibility, unchanged, so a local operator poking at
 *   a gated dev instance is not newly refused a boot.
 *
 * No message contains a secret VALUE — only the env var name that is wrong.
 * A value would leak into logs, CI output and crash reporters.
 */
export function validateTeachingEngineIntegrationConfig(env: {
  serviceKey: string;
  isProduction: boolean;
  databaseUrl: string;
  webhookUrl: string;
  webhookSecret: string;
  accessCode: string;
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
  if (!isAcceptableWebhookUrl(env.webhookUrl, env.isProduction)) {
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
  // Production-only, unchanged: see the note above.
  if (env.isProduction && env.accessCode) {
    throw new Error(
      'INTEGRATION_ACCESS_CODE_INCOMPATIBLE: the Kafuo-facing deployment must not set ACCESS_CODE together with TEACHING_ENGINE_SERVICE_KEY',
    );
  }
}

/**
 * `https://` anywhere; additionally an explicit loopback `http://` host in
 * development. Parsed rather than prefix-matched, so `https://evil/?x=localhost`
 * and `http://localhost.attacker.test` are judged on their real host.
 */
function isAcceptableWebhookUrl(rawUrl: string, isProduction: boolean): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (isProduction || url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}
