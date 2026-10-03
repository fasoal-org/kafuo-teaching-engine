import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  buildKafuoStartRequest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import type { GenerationAttempt } from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({
  getGenerationCorrection: vi.fn(),
  editGenerationCorrection: vi.fn(),
  resumeGenerationAttempt: vi.fn(),
  abandonGenerationAttempt: vi.fn(),
  runGenerationAttempt: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
  pool: { query: () => undefined },
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  // Capture after() callbacks so the test can drain them deterministically.
  after: (callback: () => unknown) => {
    mocks.afterCallbacks.push(callback);
  },
}));
vi.mock('@/lib/server/teaching-package/generation-correction', () => ({
  getGenerationCorrection: mocks.getGenerationCorrection,
  editGenerationCorrection: mocks.editGenerationCorrection,
  resumeGenerationAttempt: mocks.resumeGenerationAttempt,
  abandonGenerationAttempt: mocks.abandonGenerationAttempt,
}));
vi.mock('@/lib/server/teaching-package/generation-runner', () => ({
  runGenerationAttempt: mocks.runGenerationAttempt,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: mocks.pool }),
}));

import {
  GET as correctionGet,
  PATCH as correctionPatch,
} from '@/app/api/teaching-packages/generation-attempts/[attemptId]/correction/route';
import { POST as resumePost } from '@/app/api/teaching-packages/generation-attempts/[attemptId]/resume/route';
import { POST as abandonPost } from '@/app/api/teaching-packages/generation-attempts/[attemptId]/abandon/route';

const SERVICE_KEY = 'correction-route-key';
const ATTEMPT_ID = 'tpa-corr-1';
const TENANT = 'tenant-77';
const FRESH_URL = 'https://r2/pdf?X-Amz-Signature=fresh-signature';
const BASE = `http://localhost/api/teaching-packages/generation-attempts/${ATTEMPT_ID}`;

const ctx = () => ({ params: Promise.resolve({ attemptId: ATTEMPT_ID }) });

function attempt(partial: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    id: ATTEMPT_ID,
    tenantId: TENANT,
    learningItem: { type: 'lesson', id: '901' },
    versionId: null,
    kind: 'initial',
    status: 'queued',
    requestId: 'kafuo-req-77',
    requestDigest: 'a'.repeat(64),
    teachingSkillsContract: null,
    skillPolicyDigest: null,
    generationRuns: 1,
    requestedByActorRef: 'actor-1',
    teachingModel: { key: 'g5', version: 'g5.v1' },
    inputSnapshot: {
      learningItem: { type: 'lesson', id: '901' },
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
    ...partial,
  };
}

/** A routed subject (R1 contracts §6): `code` is the Backend's routing key. */
const ROUTED_SUBJECT = {
  id: '10',
  name: 'Science',
  code: 'BIOLOGY',
  nameAr: 'العلوم',
  nameEn: 'Science',
  academicLanguage: 'ar',
};

/** The attempt's own Kafuo request, re-sent with a fresh presigned URL. */
function kafuoRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'kafuo-req-77',
    tenantContext: { tenantId: TENANT },
    actorRef: 'actor-1',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Photosynthesis',
      unit: { id: '12', title: 'Unit 3' },
      curriculum: { id: '5', name: 'Science 5' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      subjectOffering: ROUTED_SUBJECT,
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
    contentResource: { id: 'cs-1', url: FRESH_URL },
    generation: { enableTTS: true },
    ...overrides,
  };
}

function resumeBody(overrides: Record<string, unknown> = {}) {
  return {
    tenantContext: { tenantId: TENANT },
    actorRef: 'admin-9',
    expectedRevision: 3,
    request: kafuoRequest(),
    ...overrides,
  };
}

function send(
  handler: (req: NextRequest, context: ReturnType<typeof ctx>) => Promise<Response>,
  path: string,
  method: string,
  body: unknown,
  authorized = true,
): Promise<Response> {
  return handler(
    new NextRequest(`${BASE}${path}`, {
      method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${SERVICE_KEY}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    ctx(),
  );
}

const correctionView = {
  attemptId: ATTEMPT_ID,
  revision: 3,
  phase: 'outline',
  outlines: [],
  blockingIssues: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.afterCallbacks.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', 'postgres://correction-route-test');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
});

function expectNoServiceCall() {
  expect(mocks.getGenerationCorrection).not.toHaveBeenCalled();
  expect(mocks.editGenerationCorrection).not.toHaveBeenCalled();
  expect(mocks.resumeGenerationAttempt).not.toHaveBeenCalled();
  expect(mocks.abandonGenerationAttempt).not.toHaveBeenCalled();
  expect(mocks.afterCallbacks).toHaveLength(0);
  expect(mocks.runGenerationAttempt).not.toHaveBeenCalled();
}

describe('service authentication and the configuration gate', () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    [
      'GET correction',
      () => correctionGet(new NextRequest(`${BASE}/correction?tenantId=${TENANT}`), ctx()),
    ],
    [
      'PATCH correction',
      () =>
        send(
          correctionPatch,
          '/correction',
          'PATCH',
          {
            tenantContext: { tenantId: TENANT },
            actorRef: 'admin-9',
            expectedRevision: 1,
            operations: [{ op: 'remove', outlineId: 'o-1' }],
          },
          false,
        ),
    ],
    ['POST resume', () => send(resumePost, '/resume', 'POST', resumeBody(), false)],
    [
      'POST abandon',
      () =>
        send(
          abandonPost,
          '/abandon',
          'POST',
          { tenantContext: { tenantId: TENANT }, actorRef: 'admin-9', reason: 'wrong book' },
          false,
        ),
    ],
  ];

  it.each(calls)('%s refuses a missing service key with 401', async (_label, call) => {
    const response = await call();
    expect(response.status).toBe(401);
    expectNoServiceCall();
  });

  it.each(calls)('%s answers a plain 404 when not configured', async (_label, call) => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect((await call()).status).toBe(404);
    expectNoServiceCall();
  });
});

describe('GET …/correction', () => {
  it('requires the tenant', async () => {
    const response = await correctionGet(
      new NextRequest(`${BASE}/correction`, {
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      }),
      ctx(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
    expectNoServiceCall();
  });

  it('passes the tenant-scoped view through', async () => {
    mocks.getGenerationCorrection.mockResolvedValue(correctionView);
    const response = await correctionGet(
      new NextRequest(`${BASE}/correction?tenantId=${TENANT}`, {
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      }),
      ctx(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ correction: correctionView });
    expect(mocks.getGenerationCorrection).toHaveBeenCalledWith(mocks.pool, ATTEMPT_ID, {
      tenantId: TENANT,
    });
  });

  it('maps CORRECTION_NOT_AWAITING to 409', async () => {
    mocks.getGenerationCorrection.mockRejectedValue(
      new TeachingPackageError('CORRECTION_NOT_AWAITING', 'not paused'),
    );
    const response = await correctionGet(
      new NextRequest(`${BASE}/correction?tenantId=${TENANT}`, {
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      }),
      ctx(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CORRECTION_NOT_AWAITING' },
    });
  });

  it('answers an opaque 500 for an unexpected failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getGenerationCorrection.mockRejectedValue(new Error('db exploded'));
    const response = await correctionGet(
      new NextRequest(`${BASE}/correction?tenantId=${TENANT}`, {
        headers: { authorization: `Bearer ${SERVICE_KEY}` },
      }),
      ctx(),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    consoleError.mockRestore();
  });
});

describe('PATCH …/correction', () => {
  const valid = {
    tenantContext: { tenantId: TENANT },
    actorRef: 'admin-9',
    expectedRevision: 3,
    operations: [
      { op: 'set', outlineId: 'o-1', field: 'contentRole', value: 'explanation' },
      { op: 'move', outlineId: 'o-2', toIndex: 0 },
      { op: 'remove', outlineId: 'o-3' },
    ],
  };

  it('forwards the parsed edit and answers the revalidated view', async () => {
    const updated = { ...correctionView, revision: 4 };
    mocks.editGenerationCorrection.mockResolvedValue(updated);
    const response = await send(correctionPatch, '/correction', 'PATCH', valid);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ correction: updated });
    expect(mocks.editGenerationCorrection).toHaveBeenCalledWith(mocks.pool, ATTEMPT_ID, {
      tenantId: TENANT,
      actorRef: 'admin-9',
      expectedRevision: 3,
      operations: valid.operations,
    });
  });

  it('refuses a body that is not a JSON object', async () => {
    const response = await send(correctionPatch, '/correction', 'PATCH', [1, 2]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expectNoServiceCall();
  });

  it('requires the actor', async () => {
    const response = await send(correctionPatch, '/correction', 'PATCH', {
      ...valid,
      actorRef: 42,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACTOR_REQUIRED' } });
    expectNoServiceCall();
  });

  it('requires the tenant', async () => {
    const { tenantContext: _omitted, ...withoutTenant } = valid;
    const response = await send(correctionPatch, '/correction', 'PATCH', withoutTenant);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
    expectNoServiceCall();
  });

  it.each([[undefined], [0], [-1], [1.5], ['3'], [null]])(
    'refuses expectedRevision %j with 400 INVALID_REQUEST',
    async (expectedRevision) => {
      const response = await send(correctionPatch, '/correction', 'PATCH', {
        ...valid,
        expectedRevision,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_REQUEST', message: expect.stringContaining('expectedRevision') },
      });
      expectNoServiceCall();
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['unknown op', [{ op: 'rename', outlineId: 'o-1' }]],
    ['no outlineId', [{ op: 'remove' }]],
    ['non-editable field', [{ op: 'set', outlineId: 'o-1', field: 'id', value: 'x' }]],
    ['set without value', [{ op: 'set', outlineId: 'o-1', field: 'contentRole' }]],
    ['move without integer index', [{ op: 'move', outlineId: 'o-1', toIndex: 'top' }]],
  ])('refuses operations (%s) with 400 INVALID_REQUEST', async (_label, operations) => {
    const response = await send(correctionPatch, '/correction', 'PATCH', {
      ...valid,
      operations,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expectNoServiceCall();
  });

  it('maps a stale revision (STALE_STATE) to 409', async () => {
    mocks.editGenerationCorrection.mockRejectedValue(
      new TeachingPackageError('STALE_STATE', 'reload it', { currentRevision: 5 }),
    );
    const response = await send(correctionPatch, '/correction', 'PATCH', valid);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'STALE_STATE', details: { currentRevision: 5 } },
    });
  });
});

describe('POST …/resume', () => {
  it('schedules exactly one resume run with the fresh URL in memory only (resumed=true)', async () => {
    const resumed = attempt({ status: 'queued' });
    mocks.resumeGenerationAttempt.mockResolvedValue({ attempt: resumed, resumed: true });

    const response = await send(resumePost, '/resume', 'POST', resumeBody());
    expect(response.status).toBe(202);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ attempt: { id: ATTEMPT_ID }, resumed: true });
    expect(text).not.toContain('fresh-signature');

    expect(mocks.resumeGenerationAttempt).toHaveBeenCalledTimes(1);
    const [poolArg, attemptIdArg, command] = mocks.resumeGenerationAttempt.mock.calls[0]!;
    expect(poolArg).toBe(mocks.pool);
    expect(attemptIdArg).toBe(ATTEMPT_ID);
    expect(command).toEqual({
      tenantId: TENANT,
      // The resuming administrator — not the original request's actor.
      actorRef: 'admin-9',
      expectedRevision: 3,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      learningItem: { type: 'lesson', id: '901' },
    });

    expect(mocks.afterCallbacks).toHaveLength(1);
    mocks.afterCallbacks[0]!();
    expect(mocks.runGenerationAttempt).toHaveBeenCalledTimes(1);
    const [runId, execution, kafuo, options] = mocks.runGenerationAttempt.mock.calls[0]!;
    expect(runId).toBe(ATTEMPT_ID);
    expect(execution).toMatchObject({ enableTTS: true, language: 'ar' });
    expect(kafuo).toMatchObject({
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: '901' } },
      contentResource: { id: 'cs-1', url: FRESH_URL },
      subjectCode: 'BIOLOGY',
    });
    expect(options).toEqual({ resume: true });
  });

  it('schedules no worker for an idempotent replay (resumed=false)', async () => {
    mocks.resumeGenerationAttempt.mockResolvedValue({
      attempt: attempt({ status: 'running' }),
      resumed: false,
    });
    const response = await send(resumePost, '/resume', 'POST', resumeBody());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      attempt: { id: ATTEMPT_ID, status: 'running' },
      resumed: false,
    });
    expect(mocks.afterCallbacks).toHaveLength(0);
    expect(mocks.runGenerationAttempt).not.toHaveBeenCalled();
  });

  it('refuses a re-sent request addressed to a different tenant', async () => {
    const response = await send(
      resumePost,
      '/resume',
      'POST',
      resumeBody({ request: kafuoRequest({ tenantContext: { tenantId: 'tenant-other' } }) }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expectNoServiceCall();
  });

  it('requires the tenant on the resume body', async () => {
    const { tenantContext: _omitted, ...withoutTenant } = resumeBody();
    const response = await send(resumePost, '/resume', 'POST', withoutTenant);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
    expectNoServiceCall();
  });

  it('requires the actor', async () => {
    const response = await send(resumePost, '/resume', 'POST', resumeBody({ actorRef: null }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ACTOR_REQUIRED' } });
    expectNoServiceCall();
  });

  it.each([[undefined], [0], [2.5], ['3']])(
    'refuses expectedRevision %j with 400 INVALID_REQUEST',
    async (expectedRevision) => {
      const response = await send(resumePost, '/resume', 'POST', resumeBody({ expectedRevision }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expectNoServiceCall();
    },
  );

  it.each([[undefined], ['a string'], [[1, 2]]])(
    'refuses a request that is not an object (%j)',
    async (request) => {
      const response = await send(resumePost, '/resume', 'POST', resumeBody({ request }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expectNoServiceCall();
    },
  );

  it('validates the re-sent request with the generate parser', async () => {
    const { contentResource: _omitted, ...withoutResource } = kafuoRequest();
    const response = await send(
      resumePost,
      '/resume',
      'POST',
      resumeBody({ request: withoutResource }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expectNoServiceCall();
  });

  it('refuses to resume an attempt started under a game-bearing flow (Kafuo Release 1)', async () => {
    const request = kafuoRequest({
      teachingModel: {
        key: 'g5',
        version: 'g5.v5',
        flow: [
          { stage: 'lesson_introduction', instructions: 'Introduce once.' },
          {
            stage: 'lesson_learning_game',
            instructions: 'Play.',
            scenePolicy: {
              sceneTypes: ['interactive'],
              widgetTypes: ['game'],
              cardinality: 'exactly_one',
            },
          },
        ],
      },
    });
    const response = await send(resumePost, '/resume', 'POST', resumeBody({ request }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('GAME_GENERATION_DEFERRED');
    expect(body.error.message).toContain('abandon it');
    expectNoServiceCall();
  });

  it('applies the enforced subject-routing refusal before any state changes', async () => {
    const request = kafuoRequest({
      learningItem: {
        ...kafuoRequest().learningItem,
        subjectOffering: { ...ROUTED_SUBJECT, code: null },
      },
    });
    const response = await send(resumePost, '/resume', 'POST', resumeBody({ request }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SUBJECT_ROUTE_UNAVAILABLE' },
    });
    expectNoServiceCall();
  });

  it.each([
    ['CORRECTION_NOT_AWAITING'],
    ['CORRECTION_INCOMPLETE'],
    ['CORRECTION_REQUEST_MISMATCH'],
    ['CORRECTION_SOURCE_DRIFT'],
    ['STALE_STATE'],
  ] as const)('maps %s to 409 and schedules nothing', async (code) => {
    mocks.resumeGenerationAttempt.mockRejectedValue(new TeachingPackageError(code, 'refused'));
    const response = await send(resumePost, '/resume', 'POST', resumeBody());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.afterCallbacks).toHaveLength(0);
    expect(mocks.runGenerationAttempt).not.toHaveBeenCalled();
  });

  it('the resume digest ignores the presigned URL (fresh URL ⇒ same digest)', () => {
    const digestOf = (url: string) => {
      const { request, aggregate } = parseKafuoGenerationRequest(
        kafuoRequest({ contentResource: { id: 'cs-1', url } }),
      );
      return buildKafuoStartRequest(request, aggregate).start.requestDigest;
    };
    expect(digestOf('https://r2/pdf?sig=original')).toBe(digestOf(FRESH_URL));
  });
});

describe('POST …/abandon', () => {
  const valid = {
    tenantContext: { tenantId: TENANT },
    actorRef: 'admin-9',
    reason: 'wrong book chapter',
  };

  it('forwards the abandon and answers { attempt, abandoned }', async () => {
    const failed = attempt({ status: 'failed', errorCode: 'ADMIN_CORRECTION_ABANDONED' });
    mocks.abandonGenerationAttempt.mockResolvedValue({ attempt: failed, abandoned: true });
    const response = await send(abandonPost, '/abandon', 'POST', valid);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      attempt: { id: ATTEMPT_ID, status: 'failed' },
      abandoned: true,
    });
    expect(mocks.abandonGenerationAttempt).toHaveBeenCalledWith(mocks.pool, ATTEMPT_ID, {
      tenantId: TENANT,
      actorRef: 'admin-9',
      reason: 'wrong book chapter',
    });
  });

  it('passes a missing or non-string reason to the service as empty and relays REASON_REQUIRED', async () => {
    mocks.abandonGenerationAttempt.mockRejectedValue(
      new TeachingPackageError('REASON_REQUIRED', 'a reason is required'),
    );
    for (const reason of [undefined, 42, '']) {
      const response = await send(abandonPost, '/abandon', 'POST', { ...valid, reason });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'REASON_REQUIRED' },
      });
    }
    for (const call of mocks.abandonGenerationAttempt.mock.calls) {
      expect(call[2].reason).toBe('');
    }
  });

  it('requires the actor and the tenant before the service is called', async () => {
    const noActor = await send(abandonPost, '/abandon', 'POST', { ...valid, actorRef: undefined });
    expect(noActor.status).toBe(400);
    await expect(noActor.json()).resolves.toMatchObject({ error: { code: 'ACTOR_REQUIRED' } });
    const { tenantContext: _omitted, ...withoutTenant } = valid;
    const noTenant = await send(abandonPost, '/abandon', 'POST', withoutTenant);
    expect(noTenant.status).toBe(400);
    await expect(noTenant.json()).resolves.toMatchObject({ error: { code: 'TENANT_REQUIRED' } });
    expectNoServiceCall();
  });

  it('maps CORRECTION_NOT_AWAITING to 409', async () => {
    mocks.abandonGenerationAttempt.mockRejectedValue(
      new TeachingPackageError('CORRECTION_NOT_AWAITING', 'not paused'),
    );
    const response = await send(abandonPost, '/abandon', 'POST', valid);
    expect(response.status).toBe(409);
  });
});
