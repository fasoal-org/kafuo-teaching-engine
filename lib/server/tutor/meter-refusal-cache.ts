/**
 * Recent Kafuo meter refusals, per student, capability and scope (Kafuo launch
 * plan Wave 2, ET-34).
 *
 * The H2 order runs `prepare` (assessment, the embedding / grounding lookup)
 * before the meter reserve, because the prompt must fit the budget before a unit
 * is reserved. So a student whose allowance is used up still cost one embedding
 * per message, every message. This cache closes that: a NON-retryable refusal
 * (allowance used, the daily safety cap, no Package feature, lesson access lost,
 * account inactive) is remembered for `TUTOR_REFUSAL_CACHE_SECONDS` (default 60,
 * `0` disables), or until the refusal's own `resetAt` if that comes first; the
 * next turn inside that window is refused before `prepare`, with the same
 * envelope, and makes no Kafuo, embedding or model call.
 *
 * Kafuo stays the authority: an entry only ever repeats a refusal Kafuo just
 * gave, and only for a minute. The cost of the minute is that a student who
 * upgrades right after a refusal waits up to that long. `temporarily_unavailable`
 * (retryable) is never cached. In-memory and per instance, like the turn rate
 * limiter (`rate-limit.ts`): losing it costs one embedding call, nothing more.
 * Bounded by pruning expired entries.
 */

const DEFAULT_TTL_SECONDS = 60;
const PRUNE_EVERY_N_CALLS = 256;

export function refusalCacheTtlSeconds(): number {
  const raw = process.env.TUTOR_REFUSAL_CACHE_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_TTL_SECONDS;
}

export interface CachedRefusal {
  reason: string;
  window: string | null;
  resetAt: string | null;
}

export interface MeterRefusalCache {
  /** The live refusal for `key`, if any (epoch ms clock). */
  get(key: string, nowMs: number): CachedRefusal | null;
  remember(key: string, refusal: CachedRefusal, nowMs: number): void;
}

export function refusalCacheKey(input: {
  tenantId: string;
  studentRef: string;
  capability: string;
  scope: string;
}): string {
  return `${input.tenantId}|${input.studentRef}|${input.capability}|${input.scope}`;
}

export function createMeterRefusalCache(
  ttlSeconds: () => number = refusalCacheTtlSeconds,
): MeterRefusalCache & { size(): number } {
  const entries = new Map<string, { refusal: CachedRefusal; expiresAtMs: number }>();
  let calls = 0;
  const prune = (nowMs: number) => {
    for (const [key, entry] of entries) if (entry.expiresAtMs <= nowMs) entries.delete(key);
  };
  return {
    get(key, nowMs) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(key);
        return null;
      }
      return entry.refusal;
    },
    remember(key, refusal, nowMs) {
      const ttl = ttlSeconds();
      if (ttl <= 0 || refusal.reason === 'temporarily_unavailable') return;
      let expiresAtMs = nowMs + ttl * 1000;
      const reset = refusal.resetAt ? Date.parse(refusal.resetAt) : Number.NaN;
      if (Number.isFinite(reset) && reset > nowMs) expiresAtMs = Math.min(expiresAtMs, reset);
      if (Number.isFinite(reset) && reset <= nowMs) return;
      entries.set(key, { refusal, expiresAtMs });
      calls += 1;
      if (calls % PRUNE_EVERY_N_CALLS === 0) prune(nowMs);
    },
    size() {
      return entries.size;
    },
  };
}

const CACHE_KEY = Symbol.for('openmaic.tutor.meter-refusal-cache');

/** The process-wide cache the production runtime deps carry. */
export function getMeterRefusalCache(): MeterRefusalCache {
  const registry = globalThis as Record<symbol, MeterRefusalCache | undefined>;
  return (registry[CACHE_KEY] ??= createMeterRefusalCache());
}

/** Test seam: drop the process-wide cache. */
export function resetMeterRefusalCacheForTests(): void {
  const registry = globalThis as Record<symbol, MeterRefusalCache | undefined>;
  registry[CACHE_KEY] = undefined;
}
