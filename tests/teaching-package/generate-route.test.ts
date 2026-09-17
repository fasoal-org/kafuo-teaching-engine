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
    tenantId: '__legacy__',
    learningItem: { type: 'lesson', id: 'li-route' },
    versionId: null,
    kind: 'initial',
    status: 'queued',
    requestId: null,
    requestDigest: null,
    teachingSkillsContract: null,
    skillPolicyDigest: null,
    generationRuns: 0,
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
    errorCode: null,
    errorRetryable: null,
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
      created: true,
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
      created: true,
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

  it('maps a legacy body shape to the explicit __legacy__ tenant namespace', async () => {
    mocks.startGenerationAttempt.mockResolvedValue({
      attempt: attempt(),
      execution: fullBody.generation,
      created: true,
    });
    await post(fullBody);
    expect(mocks.startGenerationAttempt.mock.calls[0]![1].tenantId).toBe('__legacy__');
  });

  it('refuses a Kafuo-shaped body without tenantContext with 400 TENANT_REQUIRED', async () => {
    const response = await post({ ...fullBody, contentResource: { id: 'cs-1', url: 'https://r2/pdf' } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
    expect(mocks.startGenerationAttempt).not.toHaveBeenCalled();
  });

  it('accepts a Kafuo-shaped body with tenantContext and forwards the tenant', async () => {
    mocks.startGenerationAttempt.mockResolvedValue({
      attempt: attempt(),
      execution: fullBody.generation,
      created: true,
    });
    const response = await post({
      requestId: 'kafuo-req-77',
      tenantContext: { tenantId: 'tenant-77' },
      actorRef: 'actor-1',
      learningItem: {
        type: 'lesson',
        id: '901',
        title: 'Photosynthesis',
        unit: { id: '12', title: 'Unit 3' },
        curriculum: { id: '5', name: 'Science 5' },
        curriculumVersion: { id: '8', versionLabel: '2026-A' },
        language: 'ar',
      },
      learningObjectives: [
        { objectiveRef: '7001', snapshot: { statement: 'Explain photosynthesis.' } },
      ],
      teachingModel: {
        key: 'g5',
        version: 'g5.v1',
        flow: [{ stage: 'lesson_introduction', instructions: 'Introduce once.' }],
      },
      contentResource: { id: 'cs-1', url: 'https://r2/pdf' },
      // Kafuo requests carry capability switches only (no provider passthrough).
      generation: { enableTTS: true },
    });
    expect(response.status).toBe(202);
    expect(mocks.startGenerationAttempt.mock.calls[0]![1].tenantId).toBe('tenant-77');
  });

  it('rejects a learningItem that tries to carry tenantId', async () => {
    const response = await post({
      ...fullBody,
      tenantContext: { tenantId: 'tenant-77' },
      contentResource: { id: 'cs-1', url: 'https://r2/pdf' },
      learningItem: { ...fullBody.learningItem, tenantId: 'tenant-evil' },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  describe('idempotency replays are returned, never re-executed', () => {
    /** A Kafuo-shaped body, so both route paths can be driven from one place. */
    const kafuoBody = {
      requestId: 'kafuo-req-replay',
      tenantContext: { tenantId: 'tenant-77' },
      actorRef: 'actor-1',
      learningItem: {
        type: 'lesson',
        id: '901',
        title: 'Photosynthesis',
        unit: { id: '12', title: 'Unit 3' },
        curriculum: { id: '5', name: 'Science 5' },
        curriculumVersion: { id: '8', versionLabel: '2026-A' },
        language: 'ar',
      },
      learningObjectives: [
        { objectiveRef: '7001', snapshot: { statement: 'Explain photosynthesis.' } },
      ],
      teachingModel: {
        key: 'g5',
        version: 'g5.v1',
        flow: [{ stage: 'lesson_introduction', instructions: 'Introduce once.' }],
      },
      contentResource: { id: 'cs-1', url: 'https://r2/pdf' },
      generation: { enableTTS: true },
    };

    it.each([
      ['legacy', () => fullBody],
      ['Kafuo-shaped', () => kafuoBody],
    ])('schedules exactly one runner callback for a newly created attempt (%s)', async (_label, body) => {
      mocks.startGenerationAttempt.mockResolvedValue({
        attempt: attempt(),
        execution: fullBody.generation,
        created: true,
      });

      const response = await post(body());
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ attempt: { id: 'tpa-route-1' } });
      expect(mocks.afterCallbacks).toHaveLength(1);
      mocks.afterCallbacks[0]!();
      expect(mocks.runGenerationAttempt).toHaveBeenCalledTimes(1);
    });

    // The confirmed production failure: the Admin replayed one idempotency key,
    // Kafuo replayed the requestId, and the route re-ran the FAILED attempt —
    // which flipped it back to `running` and died as ATTEMPT_RECLAIMED_STALE.
    // Every replayed status must schedule nothing, terminal or not.
    const statuses = ['queued', 'running', 'succeeded', 'failed'] as const;
    for (const shape of ['legacy', 'Kafuo-shaped'] as const) {
      it.each(statuses)(
        `schedules no callback for a replayed %s attempt (${shape})`,
        async (status) => {
          const replayed: GenerationAttempt = { ...attempt(), status };
          mocks.startGenerationAttempt.mockResolvedValue({
            attempt: replayed,
            execution: fullBody.generation,
            created: false,
          });

          const response = await post(shape === 'legacy' ? fullBody : kafuoBody);

          // The 202 and the attempt body are unchanged — only the execution is
          // withheld.
          expect(response.status).toBe(202);
          await expect(response.json()).resolves.toMatchObject({
            attempt: { id: 'tpa-route-1', status },
          });
          expect(mocks.afterCallbacks).toHaveLength(0);
          expect(mocks.runGenerationAttempt).not.toHaveBeenCalled();
        },
      );
    }
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
