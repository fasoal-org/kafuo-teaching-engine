import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type {
  GenerationAttempt,
  ReviewEvent,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  resolveApproved: vi.fn(),
  getVersion: vi.fn(),
  listEvents: vi.fn(),
  getAttempt: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/resolve', () => ({
  listTeachingPackageVersions: mocks.listVersions,
  resolveApprovedTeachingPackage: mocks.resolveApproved,
  getTeachingPackageVersion: mocks.getVersion,
  listTeachingPackageReviewEvents: mocks.listEvents,
  getGenerationAttempt: mocks.getAttempt,
}));

import { GET as listVersionsRoute } from '@/app/api/teaching-packages/route';
import { GET as currentRoute } from '@/app/api/teaching-packages/current/route';
import { GET as versionRoute } from '@/app/api/teaching-packages/[id]/route';
import { GET as historyRoute } from '@/app/api/teaching-packages/[id]/history/route';
import { GET as attemptRoute } from '@/app/api/teaching-packages/generation-attempts/[attemptId]/route';

const SERVICE_KEY = 'read-route-service-key';

function authed(url: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${SERVICE_KEY}` } });
}

function version(partial: Partial<TeachingPackageVersion>): TeachingPackageVersion {
  return {
    id: 'tpv-read-1',
    tenantId: 'tenant-read',
    learningItem: { type: 'lesson', id: 'li-read' },
    version: 1,
    status: 'approved',
    currentStageId: 'stage-read-1',
    currentAttemptId: null,
    teachingModel: { key: 'g5', version: 'g5.v1' },
    predecessorVersionId: null,
    supersededByVersionId: null,
    submittedStageRev: null,
    createdAt: 1,
    updatedAt: 1,
    submittedAt: null,
    approvedAt: null,
    supersededAt: null,
    discardedAt: null,
    ...partial,
  };
}

function attempt(partial: Partial<GenerationAttempt>): GenerationAttempt {
  return {
    id: 'tpa-read-1',
    tenantId: 'tenant-read',
    learningItem: { type: 'lesson', id: 'li-read' },
    versionId: 'tpv-read-1',
    kind: 'initial',
    status: 'succeeded',
    requestId: null,
    requestDigest: null,
    generationRuns: 0,
    requestedByActorRef: 'actor-1',
    teachingModel: { key: 'g5', version: 'g5.v1' },
    inputSnapshot: {
      learningItem: { type: 'lesson', id: 'li-read' },
      teachingModel: { key: 'g5', version: 'g5.v1' },
      learningObjectives: [],
      contentUnitRefs: [],
      sourceRefs: [],
      generationContext: {},
      generationOptions: {},
      requirementDigest: '0'.repeat(64),
      requirementPreview: 'preview',
      pdfContentSummary: null,
      requestedAt: 1,
    },
    producedStageId: 'stage-read-1',
    stageId: 'stage-read-1',
    displacedAt: null,
    stageReleasedAt: null,
    progress: null,
    error: null,
    errorCode: null,
    errorRetryable: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', 'postgres://read-routes-test');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
});

describe('teaching package read routes', () => {
  it('answer a plain 404 when the API is not configured', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    const response = await listVersionsRoute(
      authed('http://localhost/api/teaching-packages?tenantId=tenant-read&learningItemType=lesson&learningItemId=li'),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('refuse a missing or wrong bearer token with 401', async () => {
    const url = 'http://localhost/api/teaching-packages?tenantId=tenant-read&learningItemType=lesson&learningItemId=li';
    const missing = await listVersionsRoute(new NextRequest(url));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'SERVICE_UNAUTHENTICATED' },
    });

    const wrong = await listVersionsRoute(
      new NextRequest(url, { headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);
  });

  it('list versions in version order for the learning item', async () => {
    mocks.listVersions.mockResolvedValue([
      version({ version: 1 }),
      version({ id: 'tpv-read-2', version: 2, status: 'draft' }),
    ]);
    const response = await listVersionsRoute(
      authed(
        'http://localhost/api/teaching-packages?tenantId=tenant-read&learningItemType=lesson&learningItemId=li-read',
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.versions).toHaveLength(2);
    expect(mocks.listVersions).toHaveBeenCalledWith({
      tenantId: 'tenant-read',
      learningItem: { type: 'lesson', id: 'li-read' },
    });
    expect(JSON.stringify(body)).not.toContain('ownerId');
  });

  it('reject an unsupported learning item type with 400', async () => {
    const response = await listVersionsRoute(
      authed('http://localhost/api/teaching-packages?tenantId=tenant-read&learningItemType=course&learningItemId=li'),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNSUPPORTED_LEARNING_ITEM_TYPE' },
    });
  });

  it('resolve current to none when no approved version exists', async () => {
    mocks.resolveApproved.mockResolvedValue({ kind: 'none' });
    const response = await currentRoute(
      authed(
        'http://localhost/api/teaching-packages/current?tenantId=tenant-read&learningItemType=section&learningItemId=li-read',
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: 'none' });
  });

  it('resolve current to the approved version and stage id', async () => {
    const approved = version({ status: 'approved' });
    mocks.resolveApproved.mockResolvedValue({
      kind: 'approved',
      version: approved,
      stageId: 'stage-read-1',
    });
    const response = await currentRoute(
      authed(
        'http://localhost/api/teaching-packages/current?tenantId=tenant-read&learningItemType=lesson&learningItemId=li-read',
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: 'approved',
      version: approved,
      stageId: 'stage-read-1',
    });
  });

  it('return version detail with editor urls and the producing attempt', async () => {
    mocks.getVersion.mockResolvedValue(version({ currentAttemptId: 'tpa-read-1' }));
    mocks.getAttempt.mockResolvedValue(attempt({}));
    const response = await versionRoute(
      authed('http://localhost/api/teaching-packages/tpv-read-1?tenantId=tenant-read'),
      {
        params: Promise.resolve({ id: 'tpv-read-1' }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.editorUrls).toEqual({
      classroom: '/classroom/stage-read-1',
      workspace: '/workspace?course=stage-read-1',
    });
    expect(body.currentAttempt).toMatchObject({ id: 'tpa-read-1', stageId: 'stage-read-1' });
    expect(JSON.stringify(body)).not.toContain('ownerId');
  });

  it('omit currentAttempt for a cloned successor (null currentAttemptId)', async () => {
    mocks.getVersion.mockResolvedValue(version({ currentAttemptId: null }));
    const response = await versionRoute(
      authed('http://localhost/api/teaching-packages/tpv-read-1?tenantId=tenant-read'),
      {
        params: Promise.resolve({ id: 'tpv-read-1' }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.currentAttempt).toBeUndefined();
  });

  it('answer 404 for an unknown version', async () => {
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    mocks.getVersion.mockRejectedValue(new TeachingPackageError('NOT_FOUND', 'not found'));
    const response = await versionRoute(
      authed('http://localhost/api/teaching-packages/tpv-absent?tenantId=tenant-read'),
      {
        params: Promise.resolve({ id: 'tpv-absent' }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('return the append-only review history', async () => {
    mocks.getVersion.mockResolvedValue(version({}));
    const events: ReviewEvent[] = [
      {
        id: 1,
        versionId: 'tpv-read-1',
        eventType: 'created',
        fromStatus: null,
        toStatus: 'draft',
        actorRef: 'actor-1',
        reason: null,
        comment: null,
        relatedVersionId: null,
        data: null,
        createdAt: 1,
      },
    ];
    mocks.listEvents.mockResolvedValue(events);
    const response = await historyRoute(
      authed('http://localhost/api/teaching-packages/tpv-read-1/history?tenantId=tenant-read'),
      { params: Promise.resolve({ id: 'tpv-read-1' }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events });
    expect(mocks.listEvents).toHaveBeenCalledWith('tpv-read-1');
  });

  it('return a generation attempt with status, progress, and lineage', async () => {
    mocks.getAttempt.mockResolvedValue(
      attempt({
        status: 'running',
        progress: { step: 'generating_scenes', progress: 40, message: 'm', scenesGenerated: 2 },
      }),
    );
    const response = await attemptRoute(
      authed('http://localhost/api/teaching-packages/generation-attempts/tpa-read-1?tenantId=tenant-read'),
      { params: Promise.resolve({ attemptId: 'tpa-read-1' }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempt).toMatchObject({
      id: 'tpa-read-1',
      status: 'running',
      versionId: 'tpv-read-1',
      stageId: 'stage-read-1',
      producedStageId: 'stage-read-1',
    });
    // The transient execution input was never persisted; the snapshot has no
    // secrets and no raw source content to leak.
    expect(JSON.stringify(body)).not.toContain('webSearchApiKey');
    expect(JSON.stringify(body)).not.toContain('pdfContent":');
  });

  it('refuse a missing tenantId with 400 TENANT_REQUIRED', async () => {
    const response = await listVersionsRoute(
      authed('http://localhost/api/teaching-packages?learningItemType=lesson&learningItemId=li'),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
    const current = await currentRoute(
      authed('http://localhost/api/teaching-packages/current?learningItemType=lesson&learningItemId=li'),
    );
    expect(current.status).toBe(400);
  });

  it('answer 404 for an unknown attempt', async () => {
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    mocks.getAttempt.mockRejectedValue(new TeachingPackageError('NOT_FOUND', 'not found'));
    const response = await attemptRoute(
      authed('http://localhost/api/teaching-packages/generation-attempts/tpa-absent?tenantId=tenant-read'),
      { params: Promise.resolve({ attemptId: 'tpa-absent' }) },
    );
    expect(response.status).toBe(404);
  });
});

/**
 * The generation endpoint contract, from OpenMAIC's side.
 *
 * A `POST /api/teaching-packages 405 Method Not Allowed` was observed at
 * runtime. 405 is the CORRECT answer: the collection route is the version
 * listing and exports `GET` only, so Next has no POST handler to call.
 * Generation lives one segment deeper, at `POST /api/teaching-packages/generate`.
 *
 * These tests pin that shape at the module boundary, so nobody closes the 405
 * by adding a POST handler, an alias or a redirect to the collection route —
 * which would give two generation entry points with different validation.
 */
describe('the teaching package route surface', () => {
  it('serves listing but NOT generation on the collection route', async () => {
    const collectionRoute = await import('@/app/api/teaching-packages/route');

    // Listing is the collection route's job.
    expect(typeof collectionRoute.GET).toBe('function');
    // And it is the only verb it answers. A POST handler here is precisely the
    // "compatibility alias" this contract forbids: Next's 405 is the contract.
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(collectionRoute).not.toHaveProperty(verb);
    }
  });

  it('accepts POST on the dedicated generate route', async () => {
    const generateRoute = await import('@/app/api/teaching-packages/generate/route');

    expect(typeof generateRoute.POST).toBe('function');
    // Generation is a command, not a readable collection.
    expect(generateRoute).not.toHaveProperty('GET');
  });

  it('cannot reach generation from the collection path alone', async () => {
    // The two routes are distinct modules at distinct paths: the generate
    // handler is reachable only through the extra `/generate` segment, so a
    // caller holding just the collection URL has no generation endpoint.
    const collectionRoute = await import('@/app/api/teaching-packages/route');
    const generateRoute = await import('@/app/api/teaching-packages/generate/route');

    expect(collectionRoute).not.toHaveProperty('POST');
    expect(generateRoute.POST).not.toBe(
      (collectionRoute as Record<string, unknown>).GET,
    );
    // Both are Node-runtime server routes; neither is an edge alias of the other.
    expect(collectionRoute.runtime).toBe('nodejs');
    expect(generateRoute.runtime).toBe('nodejs');
  });
});
