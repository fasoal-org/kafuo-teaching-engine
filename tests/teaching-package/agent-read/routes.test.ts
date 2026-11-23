/**
 * Agent read routes (Kafuo Agent API A3): the service key is required (401),
 * the version is read under the caller's tenant (another tenant's → 404, and
 * no projection is read at all), and the projection is answered as is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(),
  loadScenes: vi.fn(),
  loadParts: vi.fn(),
  loadReadiness: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/resolve', () => ({
  getTeachingPackageVersion: mocks.getVersion,
}));
vi.mock('@/lib/server/teaching-package/agent-read/load', () => ({
  loadAgentScenes: mocks.loadScenes,
  loadAgentParts: mocks.loadParts,
  loadAgentReadiness: mocks.loadReadiness,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: vi.fn(async () => ({ pool: {} })),
}));

import { GET as scenesRoute } from '@/app/api/teaching-packages/[id]/agent-read/scenes/route';
import { GET as partsRoute } from '@/app/api/teaching-packages/[id]/agent-read/parts/route';
import { GET as readinessRoute } from '@/app/api/teaching-packages/[id]/agent-read/readiness/route';

const SERVICE_KEY = 'agent-read-service-key';
const VERSION = { id: 'tpv-agent-1', tenantId: 'tenant-a', currentStageId: 'stage-1' };

const routes = [
  ['scenes', scenesRoute, mocks.loadScenes],
  ['parts', partsRoute, mocks.loadParts],
  ['readiness', readinessRoute, mocks.loadReadiness],
] as const;

function request(name: string, tenantId: string, authorization?: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/teaching-packages/${VERSION.id}/agent-read/${name}?tenantId=${tenantId}`,
    authorization ? { headers: { authorization } } : undefined,
  );
}

const params = { params: Promise.resolve({ id: VERSION.id }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', 'postgres://agent-read-routes');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  mocks.getVersion.mockImplementation(async (id: string, scope: { tenantId: string }) => {
    if (id !== VERSION.id || scope.tenantId !== VERSION.tenantId) {
      throw new TeachingPackageError('NOT_FOUND', `teaching package ${id} not found`);
    }
    return VERSION;
  });
  for (const [name, , load] of routes) load.mockResolvedValue({ route: name });
});

describe.each(routes)('GET agent-read/%s', (name, route, load) => {
  it('refuses a missing or wrong service key with 401 and reads nothing', async () => {
    const missing = await route(request(name, 'tenant-a'), params);
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'SERVICE_UNAUTHENTICATED' },
    });
    const wrong = await route(request(name, 'tenant-a', 'Bearer not-the-key'), params);
    expect(wrong.status).toBe(401);
    expect(mocks.getVersion).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('answers 404 for another tenant and never loads the projection', async () => {
    const response = await route(request(name, 'tenant-b', `Bearer ${SERVICE_KEY}`), params);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(load).not.toHaveBeenCalled();
  });

  it('requires a tenant', async () => {
    const response = await route(
      new NextRequest(`http://localhost/api/teaching-packages/${VERSION.id}/agent-read/${name}`, {
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      }),
      params,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
  });

  it('answers the projection for the right tenant, never cached by HTTP', async () => {
    const response = await route(request(name, 'tenant-a', `Bearer ${SERVICE_KEY}`), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ route: name });
    expect(load).toHaveBeenCalledWith(expect.anything(), VERSION);
  });

  it('maps an engine refusal (stage not live) through the error envelope', async () => {
    load.mockRejectedValue(
      new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live'),
    );
    const response = await route(request(name, 'tenant-a', `Bearer ${SERVICE_KEY}`), params);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'STAGE_NOT_LIVE' } });
  });
});
