/**
 * Single-use handoff nonces (Kafuo launch plan Wave 2, ET-16 (a)).
 *
 * A handoff token (student `free_chat` handoff, learner Stage handoff) used to
 * be redeemable any number of times until it expired (5 min), each redeem
 * minting a fresh grant. Every redeem now CLAIMS the token's nonce first; the
 * second claim of the same nonce is refused, so a token is good for exactly one
 * grant.
 *
 * Storage is Postgres (`tutor_handoff_redemptions`), the only durable store on
 * the Kafuo path (plan §9.4), so the rule holds across instances: the claim is
 * one `INSERT … ON CONFLICT DO NOTHING RETURNING`, atomic under concurrency. The
 * row keeps a SHA-256 digest of `kind|nonce` (never the nonce itself) until the
 * handoff's own expiry plus a grace minute; a token past its expiry is refused
 * by the verifier anyway, so pruning older rows (opportunistically, on claim)
 * never re-opens one. The table is created at boot with the other persistence
 * schemas (`server-provider.ts` → `ensureHandoffNonceSchema`); the store also
 * ensures it once per pool (idempotent DDL) for a pool created elsewhere.
 *
 * FAIL CLOSED (G2, V2 item 4): when the database cannot be reached, or the
 * schema cannot be ensured, the claim throws `HANDOFF_STORE_UNAVAILABLE` (503,
 * retryable) and no grant is minted. (It used to fall back to per-process memory,
 * which let a second instance redeem the same token during an outage.) The memory
 * map is only the fast path for a replay on the same instance: it records a nonce
 * after a durable answer, never instead of one. It is bounded by pruning expired
 * entries.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

const log = createLogger('TutorHandoffNonce');

/** Rows outlive the handoff's expiry by this much before pruning (seconds). */
export const HANDOFF_NONCE_GRACE_S = 60;
/** `Retry-After` of a fail-closed redeem (seconds). */
export const HANDOFF_STORE_RETRY_AFTER_S = 5;
const PRUNE_EVERY_N_CLAIMS = 64;

export type HandoffKind = 'student-handoff' | 'learner-handoff';

export interface HandoffNonceClaim {
  kind: HandoffKind;
  nonce: string;
  tenantId: string;
  /** The handoff's own expiry, epoch ms. */
  expiresAtMs: number;
  /** Epoch ms. */
  nowMs: number;
}

/** `true` when this call claimed the nonce; `false` when it was already redeemed. */
export interface HandoffNonceStore {
  claim(input: HandoffNonceClaim): Promise<boolean>;
}

const HANDOFF_NONCE_DDL = [
  `CREATE TABLE IF NOT EXISTS tutor_handoff_redemptions (
     nonce_digest TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     tenant_id TEXT NOT NULL,
     expires_at DOUBLE PRECISION NOT NULL,
     redeemed_at DOUBLE PRECISION NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS thr_expires_at_idx ON tutor_handoff_redemptions (expires_at)`,
];

export function handoffNonceDigest(kind: HandoffKind, nonce: string): string {
  return createHash('sha256').update(`${kind}|${nonce}`).digest('hex');
}

/** Idempotent; safe at every call and twice in a row. */
export async function ensureHandoffNonceSchema(queryable: Queryable): Promise<void> {
  for (const statement of HANDOFF_NONCE_DDL) await queryable.query(statement);
}

/** The Postgres store over one pool (schema ensured once per pool). */
export function createPgHandoffNonceStore(queryable: Queryable): HandoffNonceStore {
  let schema: Promise<void> | null = null;
  let claims = 0;
  return {
    async claim(input) {
      schema ??= ensureHandoffNonceSchema(queryable).catch((error) => {
        schema = null;
        throw error;
      });
      await schema;
      const nowS = input.nowMs / 1000;
      const result = await queryable.query<{ nonce_digest: string }>(
        `INSERT INTO tutor_handoff_redemptions (nonce_digest, kind, tenant_id, expires_at, redeemed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (nonce_digest) DO NOTHING
         RETURNING nonce_digest`,
        [
          handoffNonceDigest(input.kind, input.nonce),
          input.kind,
          input.tenantId,
          input.expiresAtMs / 1000,
          nowS,
        ],
      );
      claims += 1;
      if (claims % PRUNE_EVERY_N_CLAIMS === 0) {
        await queryable
          .query(`DELETE FROM tutor_handoff_redemptions WHERE expires_at < $1`, [
            nowS - HANDOFF_NONCE_GRACE_S,
          ])
          .catch(() => {});
      }
      return result.rows.length === 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Process memory: the same-instance fast path and the outage fallback.

interface MemoryState {
  /** digest → expiry epoch ms. */
  seen: Map<string, number>;
}

const MEMORY_KEY = Symbol.for('openmaic.tutor.handoff-nonces');

function memory(): MemoryState {
  const registry = globalThis as Record<symbol, MemoryState | undefined>;
  return (registry[MEMORY_KEY] ??= { seen: new Map() });
}

function pruneMemory(nowMs: number): void {
  const { seen } = memory();
  for (const [digest, expiresAt] of seen) {
    if (expiresAt + HANDOFF_NONCE_GRACE_S * 1000 < nowMs) seen.delete(digest);
  }
}

/** Test seam: forget every nonce this process has seen. */
export function resetHandoffNonceMemoryForTests(): void {
  memory().seen.clear();
}

// ---------------------------------------------------------------------------
// Resolution (test override → Postgres through the tutor runtime pool).

const OVERRIDE_KEY = Symbol.for('openmaic.tutor.handoff-nonce-store-override');

/** Test seam: replace the durable store (`undefined` clears the override). */
export function setHandoffNonceStoreForTests(store: HandoffNonceStore | undefined): void {
  const registry = globalThis as Record<symbol, { store?: HandoffNonceStore } | undefined>;
  registry[OVERRIDE_KEY] = store ? { store } : undefined;
}

/**
 * Test double: a durable-store stand-in over one Set (atomic within a process).
 * For route tests that run without a database; never used in production.
 */
export function createMemoryHandoffNonceStoreForTests(): HandoffNonceStore {
  const claimed = new Set<string>();
  return {
    async claim(input) {
      const digest = handoffNonceDigest(input.kind, input.nonce);
      if (claimed.has(digest)) return false;
      claimed.add(digest);
      return true;
    },
  };
}

const PG_STORES = new WeakMap<object, HandoffNonceStore>();

async function durableStore(): Promise<HandoffNonceStore> {
  const registry = globalThis as Record<symbol, { store?: HandoffNonceStore } | undefined>;
  const override = registry[OVERRIDE_KEY]?.store;
  if (override) return override;
  const { resolveTutorRuntimeDeps } = await import('@/lib/server/tutor/runtime-deps');
  const { pool } = await resolveTutorRuntimeDeps();
  const key = pool as unknown as object;
  let store = PG_STORES.get(key);
  if (!store) {
    store = createPgHandoffNonceStore(pool as unknown as Queryable);
    PG_STORES.set(key, store);
  }
  return store;
}

/**
 * Claim a handoff nonce: `true` the first time, `false` on any later redeem of
 * the same token. Throws `HANDOFF_STORE_UNAVAILABLE` (503, retryable,
 * `details.retryAfterS`) when the durable store cannot answer: fail closed, no
 * grant is minted (the redeem routes map it through their error envelope).
 */
export async function claimHandoffNonce(input: HandoffNonceClaim): Promise<boolean> {
  const digest = handoffNonceDigest(input.kind, input.nonce);
  const { seen } = memory();
  if (seen.has(digest)) return false;
  pruneMemory(input.nowMs);
  let claimed: boolean;
  try {
    claimed = await (await durableStore()).claim(input);
  } catch (error) {
    log.warn(
      JSON.stringify({
        event: 'tutor.handoff_nonce_store_unavailable',
        kind: input.kind,
        error: describeErrorSafely(error).name,
      }),
    );
    throw new TeachingPackageError(
      'HANDOFF_STORE_UNAVAILABLE',
      'the handoff could not be redeemed right now; try again shortly',
      { retryAfterS: HANDOFF_STORE_RETRY_AFTER_S },
    );
  }
  // A durable answer (claimed here, or already redeemed elsewhere): the next
  // replay on this instance is answered from memory.
  seen.set(digest, input.expiresAtMs);
  return claimed;
}
