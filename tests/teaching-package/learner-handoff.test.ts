/**
 * The learner Stage handoff (Kafuo question-flow closure, B2): a learner session
 * pinned to an approved Teaching Engine version opens that version's Stage
 * read-only through the existing handoff/grant architecture. Only approved or
 * superseded (pinned history) versions are servable, the grant is `read`, and
 * the runtime sandbox key is stable for one learner session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const routeMocks = vi.hoisted(() => ({ getVersion: vi.fn() }));

vi.mock('@/lib/server/teaching-package/resolve', () => ({
  getTeachingPackageVersion: routeMocks.getVersion,
  getTeachingPackageVersionByToken: routeMocks.getVersion,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: vi.fn() } }),
}));

import {
  buildEditorGrantPayload,
  mintEditorHandoffToken,
  stableLearnerKey,
  verifyEditorHandoffToken,
} from '@/lib/server/teaching-package/editor-grant';

const SERVICE_KEY = 'learner-handoff-test-key';
const LEARNER_REF = 'a1B2c3D4e5F6g7H8i9J0kLmN';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://learner-handoff-test');
  vi.clearAllMocks();
});

const version = (status: string, stageId = 'stage-approved') => ({
  id: 'tpv-test-opaque-001',
  tenantId: 'tenant-l',
  status,
  currentStageId: stageId,
});

async function mint(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/teaching-packages/[id]/editor-handoff/route');
  return POST(
    new NextRequest('http://te.test/api/teaching-packages/tpv-test-opaque-001/editor-handoff', {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        actorRef: 'kafuo-learner',
        tenantContext: { tenantId: 'tenant-l' },
        ...body,
      }),
    }),
    { params: Promise.resolve({ id: 'tpv-test-opaque-001' }) },
  );
}

async function redeem(token: string) {
  const { GET } = await import('@/app/api/teaching-packages/editor-handoff/route');
  return GET(
    new NextRequest(
      `http://te.test/api/teaching-packages/editor-handoff?token=${encodeURIComponent(token)}`,
    ),
  );
}

describe('learner handoff mint', () => {
  it.each(['approved', 'superseded'])('mints a read handoff for a %s version', async (status) => {
    routeMocks.getVersion.mockResolvedValue(version(status));
    const response = await mint({ mode: 'learner', learnerRef: LEARNER_REF });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ capability: 'read', stageId: 'stage-approved' });
    const token = new URL(body.url, 'http://te.test').searchParams.get('token')!;
    const payload = verifyEditorHandoffToken(token)!;
    expect(payload).toMatchObject({
      purpose: 'learner',
      learnerRef: LEARNER_REF,
      versionId: 'tpv-test-opaque-001',
      capability: 'read',
    });
  });

  it.each(['draft', 'in_review', 'rejected', 'discarded'])(
    'refuses a learner handoff for a %s version',
    async (status) => {
      routeMocks.getVersion.mockResolvedValue(version(status));
      const response = await mint({ mode: 'learner', learnerRef: LEARNER_REF });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('INVALID_TRANSITION');
    },
  );

  it('refuses a learner ref that is not an opaque url-safe token', async () => {
    routeMocks.getVersion.mockResolvedValue(version('approved'));
    const response = await mint({ mode: 'learner', learnerRef: 'student 42' });
    expect(response.status).toBe(400);
  });

  it('keeps the existing preview and edit modes unchanged', async () => {
    routeMocks.getVersion.mockResolvedValue(version('draft'));
    expect((await mint({ mode: 'preview' })).status).toBe(200);
    expect((await mint({ mode: 'edit' })).status).toBe(200);
  });
});

describe('learner handoff redeem', () => {
  it('sets a read grant with a stable learner key and lands on the classroom player', async () => {
    const { token } = mintEditorHandoffToken({
      tenantId: 'tenant-l',
      versionId: 'tpv-test-opaque-001',
      stageId: 'stage-approved',
      capability: 'read',
      purpose: 'learner',
      learnerRef: LEARNER_REF,
    });
    routeMocks.getVersion.mockResolvedValue(version('approved'));
    const first = await redeem(token);
    const second = await redeem(token);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('http://te.test/classroom/stage-approved');
    const learnerKey = (response: Response) =>
      decodeURIComponent(
        response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith('teaching_package_learner_key='))!
          .split(';')[0]!
          .split('=')[1]!,
      );
    expect(learnerKey(first)).toMatch(/^tp:/);
    expect(learnerKey(first)).toBe(learnerKey(second));
    expect(learnerKey(first)).toBe(stableLearnerKey('tenant-l', 'tpv-test-opaque-001', LEARNER_REF));
  });

  it('refuses a learner token whose version was discarded after minting', async () => {
    const { token } = mintEditorHandoffToken({
      tenantId: 'tenant-l',
      versionId: 'tpv-test-opaque-001',
      stageId: 'stage-approved',
      capability: 'read',
      purpose: 'learner',
      learnerRef: LEARNER_REF,
    });
    routeMocks.getVersion.mockResolvedValue(version('discarded'));
    const response = await redeem(token);
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it('keeps a pre-existing token without a purpose valid', () => {
    const { token } = mintEditorHandoffToken({
      tenantId: 'tenant-l',
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'read',
    });
    const payload = verifyEditorHandoffToken(token)!;
    expect(payload.purpose).toBeUndefined();
    const { payload: grant } = buildEditorGrantPayload({
      tenantId: 'tenant-l',
      versionId: 'tpv-1',
      stageId: 'stage-x',
      capability: 'read',
    });
    expect(grant.learnerKey).toMatch(/^tp:/);
  });
});

describe('stable learner key', () => {
  it('is stable for one learner/version/tenant and differs across each', () => {
    const base = stableLearnerKey('tenant-l', 'tpv-1', LEARNER_REF);
    expect(stableLearnerKey('tenant-l', 'tpv-1', LEARNER_REF)).toBe(base);
    expect(stableLearnerKey('tenant-l', 'tpv-1', `${LEARNER_REF}x`)).not.toBe(base);
    expect(stableLearnerKey('tenant-l', 'tpv-2', LEARNER_REF)).not.toBe(base);
    expect(stableLearnerKey('tenant-m', 'tpv-1', LEARNER_REF)).not.toBe(base);
    expect(base).not.toContain(LEARNER_REF);
  });
});
