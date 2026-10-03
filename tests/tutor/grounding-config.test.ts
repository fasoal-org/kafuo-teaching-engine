import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ambiguousSearchMinScore,
  assessmentRuleset,
  checkKafuoGroundingConnection,
  DEFAULT_SHADOW_SAMPLE,
  KAFUO_GROUNDING_LOOPBACK_HOSTS,
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
        KAFUO_GROUNDING_DATABASE_URL:
          'postgres://kafuo_grounding_reader:x@db/kafuo?sslmode=verify-full',
      }),
    ).not.toThrow();
    expect(kafuoGroundingDatabaseUrl({ KAFUO_GROUNDING_DATABASE_URL: ' ' })).toBeNull();
  });
});

describe('M-1: the reader DSN needs TLS (loopback excepted) and the libpq env cannot weaken it', () => {
  const REMOTE = 'postgres://kafuo_grounding_reader:s3cret@kafuo-db.example.com:25060/kafuo';
  const VERIFY_FULL = `${REMOTE}?sslmode=verify-full`;
  const boot = (url: string, extra: Record<string, string> = {}, source = 'direct') =>
    validateKafuoGroundingConfig({
      TUTOR_GROUNDING_SOURCE: source,
      KAFUO_GROUNDING_DATABASE_URL: url,
      ...extra,
    });
  const reason = (url: string, env: Record<string, string> = {}) => {
    const check = checkKafuoGroundingConnection(url, env);
    return check.ok ? null : check.reason;
  };

  it('the loopback exception is explicit: exactly localhost, 127.0.0.1 and ::1', () => {
    expect(KAFUO_GROUNDING_LOOPBACK_HOSTS).toEqual(['localhost', '127.0.0.1', '::1']);
  });

  it('accepts a loopback DSN without TLS (local dev), for shadow and direct', () => {
    for (const url of [
      'postgres://kafuo_grounding_reader:pw@localhost:5432/fasol_ai_tutor',
      'postgres://kafuo_grounding_reader:pw@127.0.0.1/fasol_ai_tutor',
      'postgresql://kafuo_grounding_reader:pw@[::1]:5432/fasol_ai_tutor',
      'postgres://kafuo_grounding_reader:pw@LOCALHOST/fasol_ai_tutor?sslmode=disable',
    ]) {
      const check = checkKafuoGroundingConnection(url, {});
      expect(check.ok && check.connection.tls, url).toBe('off');
      expect(() => boot(url), url).not.toThrow();
      expect(() => boot(url, {}, 'shadow'), url).not.toThrow();
    }
    // PGSSLMODE cannot weaken a connection that has no TLS; the pool passes ssl: false.
    expect(reason('postgres://r:pw@127.0.0.1/db', { PGSSLMODE: 'require' })).toBeNull();
  });

  it('refuses a remote DSN without sslmode, and never echoes the DSN', () => {
    expect(reason(REMOTE)).toBe('a non-loopback host needs sslmode=verify-full');
    expect(() => boot(REMOTE)).toThrow(
      /KAFUO_GROUNDING_DATABASE_URL is refused: a non-loopback host needs sslmode=verify-full/,
    );
    expect(() => boot(REMOTE, {}, 'shadow')).toThrow(/needs sslmode=verify-full/);
    try {
      boot(REMOTE);
    } catch (error) {
      expect(String(error)).not.toContain('s3cret');
      expect(String(error)).not.toContain('kafuo-db.example.com');
    }
    // A host that merely looks local is not loopback.
    expect(reason('postgres://r:pw@127.0.0.2/db')).toMatch(/needs sslmode=verify-full/);
    expect(reason('postgres://r:pw@localhost.example.com/db')).toMatch(/needs sslmode=verify-full/);
  });

  it('accepts sslmode=verify-full on a remote host and parses the parts the pool will use', () => {
    const check = checkKafuoGroundingConnection(
      'postgresql://kafuo_grounding_reader:p%40ss%3Aw%2Fd@kafuo-db.example.com:25060/kafuo?sslmode=verify-full',
      {},
    );
    expect(check).toEqual({
      ok: true,
      connection: {
        host: 'kafuo-db.example.com',
        port: 25060,
        user: 'kafuo_grounding_reader',
        password: 'p@ss:w/d',
        database: 'kafuo',
        tls: 'verify-full',
        caFile: null,
      },
    });
    expect(() => boot(VERIFY_FULL)).not.toThrow();
  });

  it('refuses every weaker or ambiguous sslmode', () => {
    for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify']) {
      expect(reason(`${REMOTE}?sslmode=${mode}`), mode).toMatch(/is not accepted|needs/);
      expect(() => boot(`${REMOTE}?sslmode=${mode}`), mode).toThrow(/is refused/);
    }
    // On loopback too: only no sslmode, disable or verify-full.
    expect(reason('postgres://r:pw@localhost/db?sslmode=require')).toMatch(
      /sslmode=require is not accepted/,
    );
  });

  it('refuses any DSN parameter node-postgres would merge over the pool config', () => {
    for (const param of [
      'options=-c%20statement_timeout%3D0',
      'statement_timeout=0',
      'host=evil.example.com',
      'uselibpqcompat=true',
      'ssl=false',
      'application_name=x',
      'sslcert=/tmp/c',
    ]) {
      expect(reason(`${VERIFY_FULL}&${param}`), param).toMatch(/is not accepted/);
      expect(reason(`postgres://r:pw@127.0.0.1/db?${param}`), param).toMatch(/is not accepted/);
    }
    expect(reason(`${VERIFY_FULL}&sslmode=disable`)).toMatch(/given twice/);
  });

  it('refuses a DSN that leaves the host, user or database to PGHOST / PGUSER / PGDATABASE', () => {
    expect(reason('postgres://127.0.0.1/db')).toMatch(/host, the user and the database/);
    expect(reason('postgres://r:pw@127.0.0.1/')).toMatch(/host, the user and the database/);
    expect(reason('postgres:///db?sslmode=verify-full')).toMatch(/host, the user and the database/);
    expect(reason('mysql://r:pw@127.0.0.1/db')).toMatch(/postgres:\/\//);
    expect(reason('not a url')).toBe('it is not a valid URL');
  });

  it('PGOPTIONS set is refused (boot and check), even on loopback; empty is fine', () => {
    const options = { PGOPTIONS: '-c statement_timeout=0' };
    expect(reason(VERIFY_FULL, options)).toMatch(/PGOPTIONS is set/);
    expect(reason('postgres://r:pw@127.0.0.1/db', options)).toMatch(/PGOPTIONS is set/);
    expect(() => boot(VERIFY_FULL, options)).toThrow(/PGOPTIONS is set/);
    expect(() => boot(VERIFY_FULL, { PGOPTIONS: '' })).not.toThrow();
  });

  it('PGSSLMODE weaker than the DSN mode is refused; verify-full or unset is fine', () => {
    for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify']) {
      expect(() => boot(VERIFY_FULL, { PGSSLMODE: mode }), mode).toThrow(
        new RegExp(`PGSSLMODE=${mode} is weaker`),
      );
    }
    expect(() => boot(VERIFY_FULL, { PGSSLMODE: 'verify-full' })).not.toThrow();
  });

  it('sslrootcert: only with verify-full, and boot refuses an unreadable file', () => {
    const readable = fileURLToPath(import.meta.url);
    const withCa = `${VERIFY_FULL}&sslrootcert=${encodeURIComponent(readable)}`;
    const check = checkKafuoGroundingConnection(withCa, {});
    expect(check.ok && check.connection.caFile).toBe(readable);
    expect(() => boot(withCa)).not.toThrow();
    const missing = `${VERIFY_FULL}&sslrootcert=${encodeURIComponent('/no/such/ca.crt')}`;
    expect(() => boot(missing)).toThrow(/sslrootcert file named in KAFUO_GROUNDING_DATABASE_URL/);
    expect(() => boot(missing)).not.toThrow(/no\/such/);
    expect(reason(`postgres://r:pw@127.0.0.1/db?sslrootcert=${readable}`)).toMatch(
      /sslrootcert needs sslmode=verify-full/,
    );
  });

  it('the default kafuo_http boot checks nothing (unaffected by the DSN or PGOPTIONS)', () => {
    expect(() =>
      validateKafuoGroundingConfig({ KAFUO_GROUNDING_DATABASE_URL: REMOTE, PGOPTIONS: '-c x=1' }),
    ).not.toThrow();
    expect(() =>
      validateKafuoGroundingConfig({ TUTOR_GROUNDING_SOURCE: 'kafuo_http', PGSSLMODE: 'disable' }),
    ).not.toThrow();
  });
});
