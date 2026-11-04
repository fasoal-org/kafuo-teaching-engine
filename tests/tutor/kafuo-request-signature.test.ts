import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  signWebhookDelivery,
  WEBHOOK_EVENT_HEADERS,
} from '@/lib/server/teaching-package/webhook-delivery';
import {
  FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE,
  KAFUO_SIGNATURE_FRESHNESS_S,
  verifyKafuoSignature,
  verifyKafuoSignedRequest,
} from '@/lib/server/tutor/kafuo-request-signature';

/**
 * Kafuo → TE request signature (D-05 plan §3.1): the TE→Kafuo webhook scheme
 * in the other direction, pinned by the SAME cross-repo vector
 * (`tests/fixtures/teaching-engine-webhook-signature-vector.json`) the backend
 * asserts, so both repos agree byte for byte.
 */

interface SignatureVector {
  secret: string;
  timestamp: string;
  rawBody: string;
  signatureInput: string;
  signature: string;
  headers: { eventId: string; timestamp: string; signature: string };
}

async function readVector(): Promise<SignatureVector> {
  return JSON.parse(
    await readFile(
      new URL('../fixtures/teaching-engine-webhook-signature-vector.json', import.meta.url),
      'utf8',
    ),
  ) as SignatureVector;
}

const SECRET = 'kafuo-request-signature-fixture';
const NOW_MS = 1_800_000_000_000;
const NOW_S = String(NOW_MS / 1000);
const now = () => NOW_MS;

const OWNERSHIP_BODY = JSON.stringify({
  purpose: FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE,
  tenantContext: { tenantId: '1' },
  studentRef: 'abcdefghijklmnopqrstuvwx',
  messageId: 'msg-0b9c8c5e-6c1b-4b5e-9a39-3f1f6a0c2d11',
});

function headersFor(timestamp: string | null, signature: string | null): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (timestamp !== null) headers.set(WEBHOOK_EVENT_HEADERS.timestamp, timestamp);
  if (signature !== null) headers.set(WEBHOOK_EVENT_HEADERS.signature, signature);
  return headers;
}

function signed(body: string, timestamp = NOW_S, secret = SECRET): Headers {
  return headersFor(timestamp, signWebhookDelivery(secret, timestamp, body));
}

/** The refusal a call throws, as `{ code, status }`. */
function refusal(run: () => unknown): { code: string; status: number } {
  try {
    run();
  } catch (error) {
    if (error instanceof TeachingPackageError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error('expected a TeachingPackageError');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the shared cross-repo signature vector', () => {
  it('verifies the vector exactly as Kafuo signs it (same input, function, headers)', async () => {
    const vector = await readVector();
    expect(WEBHOOK_EVENT_HEADERS.timestamp).toBe(vector.headers.timestamp);
    expect(WEBHOOK_EVENT_HEADERS.signature).toBe(vector.headers.signature);
    // Kafuo's compute_teaching_engine_signature: hex HMAC-SHA256(secret, "<ts>.<raw body>").
    const independent = `v1=${createHmac('sha256', vector.secret).update(vector.signatureInput).digest('hex')}`;
    expect(independent).toBe(vector.signature);

    const headers = new Headers({
      [vector.headers.timestamp]: vector.timestamp,
      [vector.headers.signature]: vector.signature,
    });
    expect(() =>
      verifyKafuoSignature(headers, vector.rawBody, {
        secret: vector.secret,
        now: () => Number(vector.timestamp) * 1000,
      }),
    ).not.toThrow();
  });

  it('refuses the vector body itself: a TE→Kafuo webhook replayed to the TE has no purpose (no reflection)', async () => {
    const vector = await readVector();
    const headers = new Headers({
      [vector.headers.timestamp]: vector.timestamp,
      [vector.headers.signature]: vector.signature,
    });
    expect(
      refusal(() =>
        verifyKafuoSignedRequest(headers, vector.rawBody, {
          secret: vector.secret,
          now: () => Number(vector.timestamp) * 1000,
        }),
      ),
    ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
  });
});

describe('verifyKafuoSignedRequest', () => {
  it('accepts a fresh, correctly signed ownership body and returns the parsed object', () => {
    const body = verifyKafuoSignedRequest(signed(OWNERSHIP_BODY), OWNERSHIP_BODY, {
      secret: SECRET,
      now,
    });
    expect(body).toEqual(JSON.parse(OWNERSHIP_BODY));
  });

  it('reads TEACHING_ENGINE_WEBHOOK_SECRET by default (the integrationSecret() helper)', () => {
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', `  ${SECRET}  `);
    expect(() =>
      verifyKafuoSignedRequest(signed(OWNERSHIP_BODY), OWNERSHIP_BODY, { now }),
    ).not.toThrow();
  });

  it('verifies the raw body bytes: a tampered body or re-serialized JSON is refused (401)', () => {
    const headers = signed(OWNERSHIP_BODY);
    const tampered = OWNERSHIP_BODY.replace('"tenantId":"1"', '"tenantId":"2"');
    expect(
      refusal(() => verifyKafuoSignedRequest(headers, tampered, { secret: SECRET, now })),
    ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
    // Same object, different bytes (whitespace): still refused.
    const reserialized = JSON.stringify(JSON.parse(OWNERSHIP_BODY), null, 1);
    expect(
      refusal(() => verifyKafuoSignedRequest(headers, reserialized, { secret: SECRET, now })),
    ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
  });

  it('refuses a tampered, missing, unprefixed or wrong-secret signature (401)', () => {
    const good = signWebhookDelivery(SECRET, NOW_S, OWNERSHIP_BODY);
    const flipped = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
    for (const signature of [flipped, null, '', good.slice(3), 'v1=']) {
      expect(
        refusal(() =>
          verifyKafuoSignedRequest(headersFor(NOW_S, signature), OWNERSHIP_BODY, {
            secret: SECRET,
            now,
          }),
        ),
      ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
    }
    expect(
      refusal(() =>
        verifyKafuoSignedRequest(
          signed(OWNERSHIP_BODY, NOW_S, 'some-other-secret'),
          OWNERSHIP_BODY,
          { secret: SECRET, now },
        ),
      ),
    ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
  });

  it('requires 300 s freshness both ways and a digits-only timestamp (400 SIGNATURE_STALE)', () => {
    expect(KAFUO_SIGNATURE_FRESHNESS_S).toBe(300);
    const at = (offsetS: number) => String(NOW_MS / 1000 + offsetS);
    // The edges pass.
    for (const offset of [-300, 300]) {
      expect(() =>
        verifyKafuoSignedRequest(signed(OWNERSHIP_BODY, at(offset)), OWNERSHIP_BODY, {
          secret: SECRET,
          now,
        }),
      ).not.toThrow();
    }
    // Stale, future, and not digits — each correctly signed over its own timestamp.
    for (const timestamp of [at(-301), at(301), '-5', '1.5e9', '1800000000.0', 'abc']) {
      expect(
        refusal(() =>
          verifyKafuoSignedRequest(signed(OWNERSHIP_BODY, timestamp), OWNERSHIP_BODY, {
            secret: SECRET,
            now,
          }),
        ),
      ).toEqual({ code: 'SIGNATURE_STALE', status: 400 });
    }
    // A missing timestamp header is "not digits".
    expect(
      refusal(() =>
        verifyKafuoSignedRequest(
          headersFor(null, signWebhookDelivery(SECRET, '', OWNERSHIP_BODY)),
          OWNERSHIP_BODY,
          { secret: SECRET, now },
        ),
      ),
    ).toEqual({ code: 'SIGNATURE_STALE', status: 400 });
  });

  it('refuses an empty or unset secret outright (503), even for an empty-key HMAC', () => {
    // An HMAC under an empty key is forgeable (KAF-10): it must never pass.
    const forged = signed(OWNERSHIP_BODY, NOW_S, '');
    for (const secret of ['', '   ']) {
      expect(
        refusal(() => verifyKafuoSignedRequest(forged, OWNERSHIP_BODY, { secret, now })),
      ).toEqual({ code: 'INTEGRATION_NOT_CONFIGURED', status: 503 });
    }
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', '');
    expect(refusal(() => verifyKafuoSignedRequest(forged, OWNERSHIP_BODY, { now }))).toEqual({
      code: 'INTEGRATION_NOT_CONFIGURED',
      status: 503,
    });
    // Checked first: a stale, unsigned request on an unconfigured TE is still 503.
    expect(
      refusal(() => verifyKafuoSignedRequest(headersFor(null, null), '{}', { secret: '', now })),
    ).toEqual({ code: 'INTEGRATION_NOT_CONFIGURED', status: 503 });
  });

  it('requires purpose "free_chat_answer_ownership" in the signed body (401)', () => {
    const base = JSON.parse(OWNERSHIP_BODY) as Record<string, unknown>;
    const withoutPurpose = { ...base };
    delete withoutPurpose.purpose;
    for (const variant of [
      withoutPurpose,
      { ...base, purpose: 'free_chat' },
      { ...base, purpose: 'FREE_CHAT_ANSWER_OWNERSHIP' },
      { ...base, purpose: [FREE_CHAT_ANSWER_OWNERSHIP_PURPOSE] },
      { ...base, purpose: null },
    ]) {
      const raw = JSON.stringify(variant);
      expect(
        refusal(() => verifyKafuoSignedRequest(signed(raw), raw, { secret: SECRET, now })),
      ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
    }
  });

  it('parses only after the signature: a signed body that is not a JSON object is 400 INVALID_REQUEST', () => {
    for (const raw of ['not json', '[]', '"free_chat_answer_ownership"', 'null', '']) {
      expect(
        refusal(() => verifyKafuoSignedRequest(signed(raw), raw, { secret: SECRET, now })),
      ).toEqual({ code: 'INVALID_REQUEST', status: 400 });
    }
    // The same non-JSON body with a bad signature is a signature refusal, not a parse error.
    expect(
      refusal(() =>
        verifyKafuoSignedRequest(headersFor(NOW_S, 'v1=00'), 'not json', { secret: SECRET, now }),
      ),
    ).toEqual({ code: 'SIGNATURE_INVALID', status: 401 });
  });
});
