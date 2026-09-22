/**
 * Per-grant turn rate limit (Kafuo R1 plan §9.3, contracts §5 `RATE_LIMITED`).
 *
 * A token bucket per grant identity: capacity and refill are both
 * `TUTOR_TURNS_PER_MINUTE` (default 12), i.e. a full minute of turns may be
 * spent at once and then trickles back at one every `60 / N` seconds. It is
 * a per-instance abuse brake IN ADDITION to Kafuo's metering — the
 * entitlement authority stays Kafuo (§8.6), so this state is deliberately
 * in-memory: losing it on instance replacement costs nothing that matters
 * (F9), and it never touches the filesystem or the database.
 *
 * Buckets are keyed by the grant's identity (`student:<tenant>:<studentRef>`
 * or `learner:<tenant>:<learnerKey>`), so re-redeeming a handoff does not
 * hand a student a fresh allowance. Idle buckets are pruned so the map is
 * bounded by the number of recently active grants.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

const DEFAULT_TURNS_PER_MINUTE = 12;
/** A bucket untouched for this long is full again and can be forgotten. */
const IDLE_PRUNE_MS = 5 * 60 * 1000;
const PRUNE_EVERY_N_CALLS = 256;

export function turnsPerMinute(): number {
  const raw = Number(process.env.TUTOR_TURNS_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TURNS_PER_MINUTE;
}

interface Bucket {
  tokens: number;
  /** Epoch ms of the last refill computation. */
  updatedAt: number;
}

interface LimiterState {
  buckets: Map<string, Bucket>;
  calls: number;
}

const STATE_KEY = Symbol.for('openmaic.tutor.rate-limit');

function state(): LimiterState {
  const registry = globalThis as Record<symbol, LimiterState | undefined>;
  return (registry[STATE_KEY] ??= { buckets: new Map(), calls: 0 });
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until one token is available again (0 when allowed). */
  retryAfterS: number;
  remaining: number;
}

function prune(now: number, buckets: Map<string, Bucket>): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_PRUNE_MS) buckets.delete(key);
  }
}

/** Take one turn token for `key`. Pure bookkeeping — never throws. */
export function consumeTurnToken(key: string, now: number = Date.now()): RateLimitDecision {
  const limiter = state();
  limiter.calls += 1;
  if (limiter.calls % PRUNE_EVERY_N_CALLS === 0) prune(now, limiter.buckets);

  const capacity = turnsPerMinute();
  const refillPerMs = capacity / 60_000;
  let bucket = limiter.buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now };
    limiter.buckets.set(key, bucket);
  } else {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterS: 0, remaining: Math.floor(bucket.tokens) };
  }
  const deficitMs = (1 - bucket.tokens) / refillPerMs;
  return { allowed: false, retryAfterS: Math.max(1, Math.ceil(deficitMs / 1000)), remaining: 0 };
}

/** Take a token or throw `RATE_LIMITED` (429) with `details.retryAfterS`. */
export function enforceTurnRateLimit(key: string, now: number = Date.now()): RateLimitDecision {
  const decision = consumeTurnToken(key, now);
  if (!decision.allowed) {
    throw new TeachingPackageError(
      'RATE_LIMITED',
      `too many turns for this grant; retry after ${decision.retryAfterS}s`,
      { retryAfterS: decision.retryAfterS },
    );
  }
  return decision;
}

/** Test seam: the limiter is process-global, so suites reset it between cases. */
export function resetTurnRateLimitForTests(): void {
  const limiter = state();
  limiter.buckets.clear();
  limiter.calls = 0;
}
