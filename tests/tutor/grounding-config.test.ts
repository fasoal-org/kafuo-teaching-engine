import { describe, expect, it } from 'vitest';

import {
  ambiguousSearchMinScore,
  assessmentRuleset,
  DEFAULT_SHADOW_SAMPLE,
  evidenceFloor,
  groundingSourceSetting,
  isDirectGroundingTenant,
  kafuoGroundingDatabaseUrl,
  kafuoGroundingPoolSettings,
  resolveGroundingRoute,
  shadowSampleRate,
  validateKafuoGroundingConfig,
} from '@/lib/server/tutor/grounding/grounding-config';

/**
 * Free Chat grounding configuration (discovery-first P6/P7): `kafuo_http` is
 * the default; `direct` needs the setting, the tenant allowlist AND a wired
 * reader; the assessment ruleset follows the effective source unless set.
 */

describe('TUTOR_GROUNDING_SOURCE', () => {
  it('defaults to kafuo_http; accepts shadow and direct; anything else is kafuo_http', () => {
    expect(groundingSourceSetting({})).toBe('kafuo_http');
    expect(groundingSourceSetting({ TUTOR_GROUNDING_SOURCE: 'direct' })).toBe('direct');
    expect(groundingSourceSetting({ TUTOR_GROUNDING_SOURCE: ' Shadow ' })).toBe('shadow');
    expect(groundingSourceSetting({ TUTOR_GROUNDING_SOURCE: 'pg' })).toBe('kafuo_http');
  });

  it('TUTOR_GROUNDING_DIRECT_TENANTS: comma list, * = all, unset = none', () => {
    expect(isDirectGroundingTenant('1', {})).toBe(false);
    expect(isDirectGroundingTenant('1', { TUTOR_GROUNDING_DIRECT_TENANTS: '' })).toBe(false);
    expect(isDirectGroundingTenant('1', { TUTOR_GROUNDING_DIRECT_TENANTS: '2, 1 ,3' })).toBe(true);
    expect(isDirectGroundingTenant('11', { TUTOR_GROUNDING_DIRECT_TENANTS: '1' })).toBe(false);
    expect(isDirectGroundingTenant('7', { TUTOR_GROUNDING_DIRECT_TENANTS: '*' })).toBe(true);
  });

  it('direct is effective only with the setting, an allowlisted tenant and a wired reader', () => {
    const env = { TUTOR_GROUNDING_SOURCE: 'direct', TUTOR_GROUNDING_DIRECT_TENANTS: '1' };
    expect(resolveGroundingRoute({ tenantId: '1', directAvailable: true }, env)).toEqual({
      configured: 'direct',
      effective: 'direct',
    });
    expect(resolveGroundingRoute({ tenantId: '2', directAvailable: true }, env)).toEqual({
      configured: 'direct',
      effective: 'kafuo_http',
      fallbackReason: 'tenant_not_allowed',
    });
    expect(resolveGroundingRoute({ tenantId: '1', directAvailable: false }, env)).toEqual({
      configured: 'direct',
      effective: 'kafuo_http',
      fallbackReason: 'reader_not_wired',
    });
    expect(resolveGroundingRoute({ tenantId: '1', directAvailable: true }, {})).toEqual({
      configured: 'kafuo_http',
      effective: 'kafuo_http',
    });
    expect(
      resolveGroundingRoute(
        { tenantId: '1', directAvailable: false },
        { TUTOR_GROUNDING_SOURCE: 'shadow' },
      ),
    ).toEqual({
      configured: 'shadow',
      effective: 'shadow',
    });
  });
});

describe('TUTOR_ASSESSMENT_RULESET and the D-7 knobs', () => {
  it('unset follows the effective source (direct → discovery_v1, else r1); an explicit value wins', () => {
    expect(assessmentRuleset('kafuo_http', {})).toBe('r1');
    expect(assessmentRuleset('shadow', {})).toBe('r1');
    expect(assessmentRuleset('direct', {})).toBe('discovery_v1');
    expect(assessmentRuleset('direct', { TUTOR_ASSESSMENT_RULESET: 'r1' })).toBe('r1');
    expect(assessmentRuleset('kafuo_http', { TUTOR_ASSESSMENT_RULESET: 'discovery_v1' })).toBe(
      'discovery_v1',
    );
    expect(assessmentRuleset('kafuo_http', { TUTOR_ASSESSMENT_RULESET: 'v9' })).toBe('r1');
  });

  it('the ambiguous-search floor is unset by default (always clarify) and the evidence floor defaults to 0', () => {
    expect(ambiguousSearchMinScore({})).toBeNull();
    expect(ambiguousSearchMinScore({ TUTOR_GROUNDING_AMBIGUOUS_SEARCH_MIN_SCORE: '4.5' })).toBe(
      4.5,
    );
    expect(ambiguousSearchMinScore({ TUTOR_GROUNDING_AMBIGUOUS_SEARCH_MIN_SCORE: 'x' })).toBeNull();
    expect(evidenceFloor({})).toBe(0);
    expect(evidenceFloor({ TUTOR_GROUNDING_EVIDENCE_FLOOR: '0.3' })).toBe(0.3);
    expect(evidenceFloor({ TUTOR_GROUNDING_EVIDENCE_FLOOR: '2' })).toBe(0);
  });
});

describe('P6: the reader pool, the shadow sample and the boot check', () => {
  it('pool settings default to max 8, 300 ms admission, 30 s idle, 2.5 s client backstop; out-of-range values fall back', () => {
    expect(kafuoGroundingPoolSettings({})).toEqual({
      max: 8,
      admissionTimeoutMs: 300,
      idleTimeoutMs: 30_000,
      queryTimeoutMs: 2_500,
    });
    expect(
      kafuoGroundingPoolSettings({
        KAFUO_GROUNDING_POOL_MAX: '4',
        KAFUO_GROUNDING_ADMISSION_TIMEOUT_MS: '500',
        KAFUO_GROUNDING_IDLE_TIMEOUT_MS: '10000',
        KAFUO_GROUNDING_QUERY_TIMEOUT_MS: '2000',
      }),
    ).toEqual({ max: 4, admissionTimeoutMs: 500, idleTimeoutMs: 10_000, queryTimeoutMs: 2_000 });
    expect(kafuoGroundingPoolSettings({ KAFUO_GROUNDING_POOL_MAX: '0' }).max).toBe(8);
    expect(kafuoGroundingPoolSettings({ KAFUO_GROUNDING_POOL_MAX: '65' }).max).toBe(8);
    expect(kafuoGroundingPoolSettings({ KAFUO_GROUNDING_POOL_MAX: '2.5' }).max).toBe(8);
  });

  it('TUTOR_GROUNDING_SHADOW_SAMPLE: 0..1, default 0.1', () => {
    expect(DEFAULT_SHADOW_SAMPLE).toBe(0.1);
    expect(shadowSampleRate({})).toBe(0.1);
    expect(shadowSampleRate({ TUTOR_GROUNDING_SHADOW_SAMPLE: '1' })).toBe(1);
    expect(shadowSampleRate({ TUTOR_GROUNDING_SHADOW_SAMPLE: '0' })).toBe(0);
    expect(shadowSampleRate({ TUTOR_GROUNDING_SHADOW_SAMPLE: '1.5' })).toBe(0.1);
    expect(shadowSampleRate({ TUTOR_GROUNDING_SHADOW_SAMPLE: 'x' })).toBe(0.1);
  });

  it('boot: direct or shadow without KAFUO_GROUNDING_DATABASE_URL refuses to start; kafuo_http never needs it', () => {
    expect(() => validateKafuoGroundingConfig({})).not.toThrow();
    expect(() =>
      validateKafuoGroundingConfig({ TUTOR_GROUNDING_SOURCE: 'kafuo_http' }),
    ).not.toThrow();
    expect(() => validateKafuoGroundingConfig({ TUTOR_GROUNDING_SOURCE: 'shadow' })).toThrow(
      /TUTOR_GROUNDING_SOURCE=shadow needs KAFUO_GROUNDING_DATABASE_URL/,
    );
    expect(() =>
      validateKafuoGroundingConfig({
        TUTOR_GROUNDING_SOURCE: 'direct',
        KAFUO_GROUNDING_DATABASE_URL: '  ',
      }),
    ).toThrow(/TUTOR_GROUNDING_SOURCE=direct needs KAFUO_GROUNDING_DATABASE_URL/);
    expect(() =>
      validateKafuoGroundingConfig({
        TUTOR_GROUNDING_SOURCE: 'direct',
        KAFUO_GROUNDING_DATABASE_URL: 'postgres://kafuo_grounding_reader:x@db/kafuo',
      }),
    ).not.toThrow();
    expect(kafuoGroundingDatabaseUrl({ KAFUO_GROUNDING_DATABASE_URL: ' ' })).toBeNull();
  });
});
