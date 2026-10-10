/**
 * Wave 1 · B2a — production startup guards (readiness review ET-31, ET-34).
 *
 * In production the TE refuses to start without `ACCESS_CODE` (unless the
 * explicit local opt-out `TE_ALLOW_OPEN_ACCESS` is set) and without a
 * `TEACHING_PACKAGE_GRANT_SECRET` that differs from the service key (no
 * opt-out). Development is unchanged. The guard runs FIRST in
 * `registerNodeInstrumentation`, before any schedule is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isOpenAccessOptOut,
  resolveAccessGateMode,
  validateProductionStartupConfig,
} from '@/lib/server/startup-config';

const ACCESS = 'staging-access-code-value';
const GRANT = 'grant-secret-value';
const SERVICE = 'service-key-value';

const prod = {
  isProduction: true,
  accessCode: ACCESS,
  allowOpenAccess: false,
  grantSecret: GRANT,
  serviceKey: SERVICE,
};

/** The thrown message, asserted to name the variable and never a value. */
function failure(env: Parameters<typeof validateProductionStartupConfig>[0]): string {
  try {
    validateProductionStartupConfig(env);
  } catch (error) {
    const message = (error as Error).message;
    for (const value of [ACCESS, GRANT, SERVICE]) expect(message).not.toContain(value);
    return message;
  }
  throw new Error('expected validateProductionStartupConfig to throw');
}

describe('validateProductionStartupConfig', () => {
  it('passes a complete production configuration', () => {
    expect(() => validateProductionStartupConfig(prod)).not.toThrow();
  });

  it('refuses production with an empty or blank ACCESS_CODE (ET-31)', () => {
    for (const accessCode of ['', '   ']) {
      expect(failure({ ...prod, accessCode })).toMatch(/ACCESS_CODE is required in production/);
    }
  });

  it('lets the explicit opt-out start production without ACCESS_CODE', () => {
    expect(() =>
      validateProductionStartupConfig({ ...prod, accessCode: '', allowOpenAccess: true }),
    ).not.toThrow();
  });

  it('refuses production without TEACHING_PACKAGE_GRANT_SECRET, with no opt-out (ET-34)', () => {
    for (const grantSecret of ['', '  ']) {
      expect(failure({ ...prod, grantSecret })).toMatch(
        /TEACHING_PACKAGE_GRANT_SECRET is required in production/,
      );
      // The ACCESS_CODE opt-out does not waive the grant secret.
      expect(failure({ ...prod, grantSecret, accessCode: '', allowOpenAccess: true })).toMatch(
        /TEACHING_PACKAGE_GRANT_SECRET is required in production/,
      );
    }
    // Also with no service key at all: grants would be signed with an empty key.
    expect(failure({ ...prod, grantSecret: '', serviceKey: '' })).toMatch(
      /TEACHING_PACKAGE_GRANT_SECRET is required/,
    );
  });

  it('refuses a grant secret equal to the service key', () => {
    expect(failure({ ...prod, grantSecret: SERVICE })).toMatch(
      /TEACHING_PACKAGE_GRANT_SECRET must differ from TEACHING_ENGINE_SERVICE_KEY/,
    );
    expect(failure({ ...prod, grantSecret: ` ${SERVICE} ` })).toMatch(/must differ/);
  });

  it('checks nothing outside production (development unchanged)', () => {
    expect(() =>
      validateProductionStartupConfig({
        isProduction: false,
        accessCode: '',
        allowOpenAccess: false,
        grantSecret: '',
        serviceKey: '',
      }),
    ).not.toThrow();
  });
});

describe('isOpenAccessOptOut / resolveAccessGateMode', () => {
  it('accepts only 1 / true as the opt-out', () => {
    for (const raw of ['1', 'true', 'TRUE', ' 1 ']) expect(isOpenAccessOptOut(raw), raw).toBe(true);
    for (const raw of [undefined, '', '0', 'false', 'yes', 'on']) {
      expect(isOpenAccessOptOut(raw), String(raw)).toBe(false);
    }
  });

  it('is gated with a code, open in development or with the opt-out, closed otherwise', () => {
    const mode = (accessCode: string | undefined, isProduction: boolean, allowOpenAccess = false) =>
      resolveAccessGateMode({ accessCode, isProduction, allowOpenAccess });
    expect(mode('code', true)).toBe('gated');
    expect(mode('code', false)).toBe('gated');
    expect(mode(undefined, false)).toBe('open');
    expect(mode('', false)).toBe('open');
    expect(mode('', true, true)).toBe('open');
    expect(mode(undefined, true)).toBe('closed');
    expect(mode('', true)).toBe('closed');
  });
});

/**
 * The wiring: the guard runs in `registerNodeInstrumentation`, before anything
 * is started. Only the first two seams are mocked; a throw from the guard must
 * reach neither, and a passing guard must reach the asset quota next.
 */
describe('registerNodeInstrumentation runs the guard first', () => {
  const resolveAssetQuotaBytes = vi.fn();
  const startAssetCollectorSchedule = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    resolveAssetQuotaBytes.mockReset();
    startAssetCollectorSchedule.mockReset();
    vi.doMock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes }));
    vi.doMock('@/lib/persistence/asset-collector-schedule', () => ({
      startAssetCollectorSchedule,
    }));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ACCESS_CODE', ACCESS);
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '');
    vi.stubEnv('TEACHING_PACKAGE_GRANT_SECRET', GRANT);
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE);
  });

  afterEach(() => {
    vi.doUnmock('@/lib/persistence/asset-quota');
    vi.doUnmock('@/lib/persistence/asset-collector-schedule');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function boot(): Promise<void> {
    const { registerNodeInstrumentation } = await import('@/lib/server/instrumentation-node');
    await registerNodeInstrumentation();
  }

  it('refuses to start in production with an empty ACCESS_CODE, before starting anything', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    await expect(boot()).rejects.toThrow(/ACCESS_CODE is required in production/);
    expect(resolveAssetQuotaBytes).not.toHaveBeenCalled();
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });

  it('refuses to start in production without TEACHING_PACKAGE_GRANT_SECRET, even with the opt-out', async () => {
    vi.stubEnv('TEACHING_PACKAGE_GRANT_SECRET', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '1');
    await expect(boot()).rejects.toThrow(/TEACHING_PACKAGE_GRANT_SECRET is required/);
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });

  it('passes a complete production configuration on to the next startup step', async () => {
    resolveAssetQuotaBytes.mockImplementation(() => {
      throw new Error('reached-asset-quota');
    });
    await expect(boot()).rejects.toThrow('reached-asset-quota');
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });

  it('passes the opt-out (local production-mode run) on to the next startup step', async () => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('TE_ALLOW_OPEN_ACCESS', '1');
    resolveAssetQuotaBytes.mockImplementation(() => {
      throw new Error('reached-asset-quota');
    });
    await expect(boot()).rejects.toThrow('reached-asset-quota');
  });

  it('checks nothing in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('TEACHING_PACKAGE_GRANT_SECRET', '');
    resolveAssetQuotaBytes.mockImplementation(() => {
      throw new Error('reached-asset-quota');
    });
    await expect(boot()).rejects.toThrow('reached-asset-quota');
  });
});
