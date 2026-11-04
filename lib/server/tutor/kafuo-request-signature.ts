/**
 * Kafuo → TE signed requests (D-05 Free Chat answer rating plan §3.1).
 *
 * The TE→Kafuo HMAC scheme run in the other direction: the SAME function
 * (`signWebhookDelivery`), the SAME secret (`TEACHING_ENGINE_WEBHOOK_SECRET` =
 * Kafuo `teaching_engine_webhook_secret`, read through `integrationSecret()`)
 * and the SAME headers:
 *   `X-Teaching-Engine-Timestamp: <unix seconds>`
 *   `X-Teaching-Engine-Signature: v1=<hex hmac-sha256(secret, "<timestamp>.<raw body>")>`
 * It sits on top of the service-key bearer, never instead of it.
 *
 * Fixed order, each step a refusal of its own:
 *  1. an empty or unset secret → 503 INTEGRATION_NOT_CONFIGURED (an HMAC with
 *     an empty key is forgeable, KAF-10), checked before anything else;
 *  2. a timestamp that is missing, not digits, or more than 300 s off → 400
 *     SIGNATURE_STALE;
 *  3. a missing or wrong signature → 401 SIGNATURE_INVALID, compared in
 *     constant time over the RAW body text (never re-serialized JSON);
 *  4. only then is the body parsed: not a JSON object → 400 INVALID_REQUEST;
 *  5. a missing or wrong `purpose` → 401 SIGNATURE_INVALID. One secret signs
 *     both directions, so the body names what it is for: a TE→Kafuo body
 *     lifted and replayed here carries no `purpose` and is refused.
 *
 * `verifyKafuoSignedRequest` returns the parsed object, so the verified bytes
 * and the body the route reads can never diverge. Nothing here logs.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  signWebhookDelivery,
  WEBHOOK_EVENT_HEADERS,
} from '@/lib/server/teaching-package/webhook-delivery';
import { integrationSecret } from '@/lib/server/tutor/kafuo-integration-client';

/** Freshness window, both ways round (the backend verifier's `freshness_seconds`). */
export const KAFUO_SIGNATURE_FRESHNESS_S = 300;

/** The one purpose a Kafuo-signed TE request carries today (D-05). */
export const FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE = 'free_chat_answer_ownership';

export interface KafuoSignatureOptions {
  /** Epoch ms clock; defaults to `Date.now`. */
  now?: () => number;
  /** The shared secret; defaults to `integrationSecret()`. */
  secret?: string;
}

/** The SHA-256 digest + `timingSafeEqual` idiom of `service-auth.ts`: no length leak. */
function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Steps 1–3: the secret, the freshness and the HMAC over the raw body text.
 * Throws a `TeachingPackageError`; returns nothing on success.
 */
export function verifyKafuoSignature(
  headers: Pick<Headers, 'get'>,
  rawBody: string,
  options: KafuoSignatureOptions = {},
): void {
  const secret = options.secret ?? integrationSecret();
  if (secret.trim() === '') {
    throw new TeachingPackageError(
      'INTEGRATION_NOT_CONFIGURED',
      'the Kafuo request signing secret is not configured',
    );
  }
  const timestamp = headers.get(WEBHOOK_EVENT_HEADERS.timestamp) ?? '';
  const nowS = (options.now ?? Date.now)() / 1000;
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(nowS - Number(timestamp)) > KAFUO_SIGNATURE_FRESHNESS_S
  ) {
    throw new TeachingPackageError(
      'SIGNATURE_STALE',
      `${WEBHOOK_EVENT_HEADERS.timestamp} must be unix seconds within ${KAFUO_SIGNATURE_FRESHNESS_S} s`,
    );
  }
  const signature = headers.get(WEBHOOK_EVENT_HEADERS.signature) ?? '';
  if (!secureEqual(signature, signWebhookDelivery(secret, timestamp, rawBody))) {
    throw new TeachingPackageError(
      'SIGNATURE_INVALID',
      `${WEBHOOK_EVENT_HEADERS.signature} does not match the request`,
    );
  }
}

/**
 * The full verifier (steps 1–5): returns the signed JSON object, whose
 * `purpose` is `free_chat_answer_ownership`.
 */
export function verifyKafuoSignedRequest(
  headers: Pick<Headers, 'get'>,
  rawBody: string,
  options: KafuoSignatureOptions = {},
): Record<string, unknown> {
  verifyKafuoSignature(headers, rawBody, options);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  if (record.purpose !== FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE) {
    throw new TeachingPackageError(
      'SIGNATURE_INVALID',
      'the signed body does not carry the expected purpose',
    );
  }
  return record;
}
