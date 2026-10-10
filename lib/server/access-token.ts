import { createHmac, timingSafeEqual } from 'crypto';

import { accessTokenMessage, readAccessToken } from '@/lib/server/startup-config';

/**
 * Create an HMAC-signed token: `v2.<issuedAtMs>.<signature>`. The format and
 * the 12-hour age rule live in `startup-config.ts`, shared with `middleware.ts`.
 */
export function createAccessToken(accessCode: string, nowMs: number = Date.now()): string {
  const message = accessTokenMessage(nowMs);
  const signature = createHmac('sha256', accessCode).update(message).digest('hex');
  return `${message}.${signature}`;
}

/**
 * Verify an HMAC-signed token against the access code. Refuses a malformed or
 * legacy (pre-v2) token, and one issued more than 12 hours ago.
 */
export function verifyAccessToken(
  token: string,
  accessCode: string,
  nowMs: number = Date.now(),
): boolean {
  const parts = readAccessToken(token, nowMs);
  if (!parts) return false;

  const expected = createHmac('sha256', accessCode).update(parts.message).digest('hex');

  const sigBuf = Buffer.from(parts.signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}
