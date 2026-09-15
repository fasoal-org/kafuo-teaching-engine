import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  submitForReview: vi.fn(),
  startReviewEdit: vi.fn(),
  reject: vi.fn(),
  approve: vi.fn(),
  discardSuccessor: vi.fn(),
}));

vi.mock('@/lib/server/teaching-package/lifecycle', () => ({
  submitForReview: mocks.submitForReview,
  startReviewEdit: mocks.startReviewEdit,
  reject: mocks.reject,
  approve: mocks.approve,
  discardSuccessor: mocks.discardSuccessor,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: vi.fn() } }),
}));

import { POST } from '@/app/api/teaching-packages/[id]/transitions/route';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

const SERVICE_KEY = 'transitions-route-key';

function post(body: unknown, id = 'tpv-route-1'): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/teaching-packages/${id}/transitions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', 'postgres://transitions-route-test');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
});

describe('POST /api/teaching-packages/[id]/transitions', () => {
  it('answers a plain 404 when the API is not configured', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect((await post({ action: 'submit', actorRef: 'a' })).status).toBe(404);
  });

  it('refuses a request without the service key', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/teaching-packages/tpv-route-1/transitions', {
        method: 'POST',
        body: '{}',
      }),
      { params: Promise.resolve({ id: 'tpv-route-1' }) },
    );
    expect(response.status).toBe(401);
  });

  it('rejects an unknown action with 400', async () => {
    const response = await post({ action: 'publish', actorRef: 'actor-1' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects a missing actor reference with 400 ACTOR_REQUIRED', async () => {
    const response = await post({ action: 'submit' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACTOR_REQUIRED' } });
  });

  it('rejects a reject without a reason with 400 REASON_REQUIRED', async () => {
    const response = await post({ action: 'reject', actorRef: 'actor-1' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'REASON_REQUIRED' } });
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it('routes each action to its lifecycle command and returns the version', async () => {
    const version = { id: 'tpv-route-1', status: 'approved' };
    mocks.approve.mockResolvedValue(version);
    const response = await post({ action: 'approve', actorRef: 'reviewer-1', comment: 'lgtm' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version });
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.approve.mock.calls[0]![1]).toMatchObject({
      versionId: 'tpv-route-1',
      actorRef: 'reviewer-1',
      comment: 'lgtm',
    });
    expect(mocks.approve.mock.calls[0]![0]).toMatchObject({ query: expect.any(Function) });

    await post({ action: 'submit', actorRef: 'a1' });
    expect(mocks.submitForReview).toHaveBeenCalledTimes(1);
    await post({ action: 'start_edit', actorRef: 'a1' });
    expect(mocks.startReviewEdit).toHaveBeenCalledTimes(1);
    await post({ action: 'discard', actorRef: 'a1' });
    expect(mocks.discardSuccessor).toHaveBeenCalledTimes(1);
    await post({ action: 'reject', actorRef: 'a1', reason: 'r' });
    expect(mocks.reject).toHaveBeenCalledTimes(1);
  });

  it('forwards expectedStatus and maps service errors to the envelope', async () => {
    mocks.submitForReview.mockRejectedValue(
      new TeachingPackageError(
        'INVALID_TRANSITION',
        'cannot submit for review from status "approved"',
      ),
    );
    const response = await post({
      action: 'submit',
      actorRef: 'a1',
      expectedStatus: 'draft',
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(mocks.submitForReview.mock.calls[0]![1]).toMatchObject({ expectedStatus: 'draft' });
  });

  it('rejects an invalid expectedStatus with 400', async () => {
    const response = await post({ action: 'submit', actorRef: 'a1', expectedStatus: 'published' });
    expect(response.status).toBe(400);
    expect(mocks.submitForReview).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body with 400', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/teaching-packages/tpv-route-1/transitions', {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'text/plain' },
        body: 'not json',
      }),
      { params: Promise.resolve({ id: 'tpv-route-1' }) },
    );
    expect(response.status).toBe(400);
  });
});
