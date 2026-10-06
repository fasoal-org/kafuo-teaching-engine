/**
 * Server-to-server authentication for the Teaching Package API (plan §11).
 *
 * Kafuo Backend authenticates with a shared service key
 * (`Authorization: Bearer <TEACHING_ENGINE_SERVICE_KEY>`). The comparison uses
 * the SHA-256 digest + `timingSafeEqual` idiom of `lib/persistence/server-auth.ts`,
 * so the key is never compared in length-leaking constant-time-unsafe form.
 *
 * No cookie, no `withRequestOwnerId`: the caller is a machine, and the service
 * owner principal is fixed (`owner.ts`) — the actor attribution Kafuo wants is
 * the opaque `actorRef` carried in the body, never an owner id.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** The configured service key, trimmed; undefined when the operator set none. */
export function teachingEngineServiceKey(): string | undefined {
  const key = process.env.TEACHING_ENGINE_SERVICE_KEY?.trim();
  return key ? key : undefined;
}

/**
 * Verify the service credential on one request. Throws
 * `SERVICE_UNAUTHENTICATED` (401) when the header is missing, malformed, or
 * does not match the configured key — or when no key is configured at all.
 */
export function authenticateServiceRequest(req: Pick<Request, 'headers'>): void {
  const configured = teachingEngineServiceKey();
  const authorization = req.headers.get('authorization') ?? '';
  if (
    !configured ||
    !authorization.startsWith('Bearer ') ||
    !secureEqual(authorization.slice(7), configured)
  ) {
    throw new TeachingPackageError(
      'SERVICE_UNAUTHENTICATED',
      'a valid Teaching Engine service key is required (Authorization: Bearer <key>)',
    );
  }
}
