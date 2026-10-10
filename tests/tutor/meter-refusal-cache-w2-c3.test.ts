import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMeterRefusalCache,
  getMeterRefusalCache,
  refusalCacheKey,
  refusalCacheTtlSeconds,
  resetMeterRefusalCacheForTests,
} from '@/lib/server/tutor/meter-refusal-cache';
import {
  resolveTutorRuntimeDeps,
  setTutorRuntimeDepsForTests,
} from '@/lib/server/tutor/runtime-deps';

/** W2-C3 · ET-34: the per-instance cache of recent non-retryable meter refusals. */

const T0 = 1_800_000_000_000;
const KEY = refusalCacheKey({
  tenantId: '1',
  studentRef: 'ref',
  capability: 'help',
  scope: 'item:7',
});
const REFUSAL = { reason: 'help_allowance_exhausted', window: null, resetAt: null };

afterEach(() => {
  vi.unstubAllEnvs();
  resetMeterRefusalCacheForTests();
  setTutorRuntimeDepsForTests(undefined);
});

describe('createMeterRefusalCache', () => {
  it('remembers a refusal for the TTL, then forgets it', () => {
    const cache = createMeterRefusalCache(() => 60);
    cache.remember(KEY, REFUSAL, T0);
    expect(cache.get(KEY, T0 + 59_999)).toEqual(REFUSAL);
    expect(cache.get(KEY, T0 + 60_000)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('never outlives the refusal’s own reset instant', () => {
    const cache = createMeterRefusalCache(() => 60);
    const resetAt = new Date(T0 + 10_000).toISOString();
    cache.remember(KEY, { ...REFUSAL, resetAt }, T0);
    expect(cache.get(KEY, T0 + 9_999)).not.toBeNull();
    expect(cache.get(KEY, T0 + 10_000)).toBeNull();
    cache.remember(KEY, { ...REFUSAL, resetAt: new Date(T0 - 1).toISOString() }, T0);
    expect(cache.get(KEY, T0)).toBeNull();
  });

  it('never caches temporarily_unavailable, and a TTL of 0 disables it', () => {
    const cache = createMeterRefusalCache(() => 60);
    cache.remember(KEY, { ...REFUSAL, reason: 'temporarily_unavailable' }, T0);
    expect(cache.get(KEY, T0)).toBeNull();
    const off = createMeterRefusalCache(() => 0);
    off.remember(KEY, REFUSAL, T0);
    expect(off.get(KEY, T0)).toBeNull();
  });

  it('keys by tenant, student, capability and scope', () => {
    const cache = createMeterRefusalCache(() => 60);
    cache.remember(KEY, REFUSAL, T0);
    const other = refusalCacheKey({
      tenantId: '1',
      studentRef: 'ref',
      capability: 'help',
      scope: 'item:8',
    });
    expect(cache.get(other, T0)).toBeNull();
  });
});

describe('configuration and wiring', () => {
  it('TUTOR_REFUSAL_CACHE_SECONDS: default 60, 0 allowed, junk falls back', () => {
    expect(refusalCacheTtlSeconds()).toBe(60);
    vi.stubEnv('TUTOR_REFUSAL_CACHE_SECONDS', '0');
    expect(refusalCacheTtlSeconds()).toBe(0);
    vi.stubEnv('TUTOR_REFUSAL_CACHE_SECONDS', '15');
    expect(refusalCacheTtlSeconds()).toBe(15);
    vi.stubEnv('TUTOR_REFUSAL_CACHE_SECONDS', 'soon');
    expect(refusalCacheTtlSeconds()).toBe(60);
  });

  it('the process-wide cache is a singleton until reset', () => {
    const first = getMeterRefusalCache();
    expect(getMeterRefusalCache()).toBe(first);
    resetMeterRefusalCacheForTests();
    expect(getMeterRefusalCache()).not.toBe(first);
  });

  it('test deps carry no cache (existing suites are unaffected)', async () => {
    const deps = { pool: {}, kafuo: {}, now: Date.now } as never;
    setTutorRuntimeDepsForTests(deps);
    expect((await resolveTutorRuntimeDeps()).refusalCache).toBeUndefined();
  });
});
