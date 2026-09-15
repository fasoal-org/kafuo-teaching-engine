import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { GenerationAttempt } from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({
  startGenerationAttempt: vi.fn(),
  runGenerationAttempt: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  // Capture after() callbacks so the test can drain them deterministically.
  after: (callback: () => unknown) => {
    mocks.afterCallbacks.push(callback);
  },
}));
vi.mock('@/lib/server/teaching-package/generation', () => ({
  startGenerationAttempt: mocks.startGenerationAttempt,
}));
vi.mock('@/lib/server/teaching-package/generation-runner', () => ({
  runGenerationAttempt: mocks.runGenerationAttempt,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: { query: vi.fn() } }),
}));

import { POST } from '@/app/api/teaching-packages/generate/route';

const SERVICE_KEY = 'generate-route-key';

function attempt(): GenerationAttempt {
  return {
    id: 'tpa-route-1',
    learningItem: { type: 'lesson', id: 'li-route' },
    versionId: null,
    kind: 'initial',
    status: 'queued',
    requestId: null,
    requestedByActorRef: 'actor-1',
    teachingModel: { key: 'g5', version: 'g5.v1' },
    inputSnapshot: {
      learningItem: { type: 'lesson', id: 'li-route' },
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
    producedStageId: null,
    stageId: null,
    displacedAt: null,
    stageReleasedAt: null,
    progress: null,
    error: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
  };
}

const fullBody = {
  learningItem: { type: 'lesson', id: 'li-route' },
  teachingModel: { key: 'g5', version: 'g5.v1' },
  learningObjectives: [
    { objectiveRef: 'obj-1', snapshot: { statement: 'Explain photosynthesis' } },
  ],
  contentUnitRefs: ['cu-1'],
  sourceRefs: ['src-1'],
  generationContext: { unitName: 'Unit 3' },
  generation: {
    requirement: 'Teach photosynthesis',
    pdfContent: { text: 'pdf body text', images: ['data:image/png;base64,AA'] },
    enableWebSearch: true,
    webSearchProviderId: 'tavily',
    webSearchApiKey: 'sk-route-secret',
    webSearchModelId: 'search-x',
    enableImageGeneration: true,
    enableVideoGeneration: true,
    enableTTS: true,
    agentMode: 'generate',
  },
  actorRef: 'actor-1',
  requestId: 'kafuo-req-9',
};

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/teaching-packages/generate', {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.afterCallbacks.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', 'postgres://generate-route-test');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
});

describe('POST /api/teaching-packages/generate', () => {
  it('passes the full generation object through and never echoes secrets', async () => {
    const echoed = attempt();
    mocks.startGenerationAttempt.mockResolvedValue({
      attempt: echoed,
      execution: fullBody.generation,
    });

    const response = await post(fullBody);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.attempt.id).toBe('tpa-route-1');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-route-secret');
    expect(serialized).not.toContain('pdf body text');

    // startGenerationAttempt received every execution field unchanged.
    expect(mocks.startGenerationAttempt).toHaveBeenCalledTimes(1);
    const [poolArg, request] = mocks.startGenerationAttempt.mock.calls[0]!;
    expect(poolArg).toBeDefined();
    expect(request.generation).toEqual(fullBody.generation);
    expect(request.learningItem).toEqual(fullBody.learningItem);
    expect(request.teachingModel).toEqual(fullBody.teachingModel);
    expect(request.actorRef).toBe('actor-1');
    expect(request.requestId).toBe('kafuo-req-9');
    expect(request.learningObjectives).toEqual(fullBody.learningObjectives);

    // Draining after() hands the identical execution object to the runner.
    expect(mocks.afterCallbacks).toHaveLength(1);
    mocks.afterCallbacks[0]!();
    expect(mocks.runGenerationAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.runGenerationAttempt.mock.calls[0]![0]).toBe('tpa-route-1');
    expect(mocks.runGenerationAttempt.mock.calls[0]![1]).toEqual(fullBody.generation);
  });

  it('forwards versionId for regeneration', async () => {
    mocks.startGenerationAttempt.mockResolvedValue({
      attempt: attempt(),
      execution: fullBody.generation,
    });
    await post({ ...fullBody, versionId: 'tpv-7' });
    expect(mocks.startGenerationAttempt.mock.calls[0]![1].versionId).toBe('tpv-7');
  });

  it('answers a plain 404 when not configured', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect((await post(fullBody)).status).toBe(404);
  });

  it('refuses a missing service key with 401', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/teaching-packages/generate', {
        method: 'POST',
        body: JSON.stringify(fullBody),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a missing actor reference with 400', async () => {
    const response = await post({ ...fullBody, actorRef: undefined });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACTOR_REQUIRED' } });
  });

  it('maps GENERATION_IN_PROGRESS to 409', async () => {
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    mocks.startGenerationAttempt.mockRejectedValue(
      new TeachingPackageError('GENERATION_IN_PROGRESS', 'already running'),
    );
    const response = await post(fullBody);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'GENERATION_IN_PROGRESS' },
    });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });
});
