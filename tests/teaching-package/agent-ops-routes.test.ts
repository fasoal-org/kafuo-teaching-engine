/**
 * Kafuo Agent API wave E3: the agent's teaching-package editor routes
 * (`agent-ops/[op]` POST, `agent-ops/ops/[opId]` GET) and the guarded
 * duplicate delete. The editor's services are mocked (their own behaviour is
 * covered by their own tests); these tests pin what the agent layer adds:
 * the refused list, the actor, the revision check, the dry run, the key and
 * the one-generation replay, the delete guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { AppScene } from '@/lib/types/stage';

type Row = { status: 'running' | 'succeeded' | 'failed'; requestDigest: string; sceneId: string };

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  pool: { query: () => undefined },
  version: {
    id: 'tpv-1',
    tenantId: 'tenant-7',
    status: 'draft',
    currentStageId: 'stage-1',
  } as Record<string, unknown>,
  stageRev: 12,
  document: null as unknown as { scenes: unknown[]; outline: unknown; stage: unknown },
  liveScenes: new Map<string, { scene: unknown; rev: number }>(),
  regenerations: new Map<string, Row>(),
  insertions: new Map<string, Row & { tenantId: string; stageId: string }>(),
  generations: 0,
  finishRun: [] as Array<() => void>,
  units: [] as unknown[],
  regenerateSlideScene: vi.fn(),
  insertGeneratedSlide: vi.fn(),
  regenerateSceneNarrationAudio: vi.fn(),
  setSceneTeachingSkills: vi.fn(),
  readInsertionContext: vi.fn(),
  deleteScene: vi.fn(),
  guardOptions: [] as unknown[],
  getVersion: vi.fn(),
  records: new Map<string, Record<string, unknown>>(),
  clock: 1_000_000,
}));

vi.mock('@/lib/server/teaching-package/agent-op-records', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/teaching-package/agent-op-records')>();
  const id = (versionId: string, op: string, key: string) => `${versionId}|${op}|${key}`;
  return {
    ...actual,
    readAgentOpRecord: async (
      _pool: unknown,
      key: { versionId: string; op: string; idempotencyKey: string },
    ) => mocks.records.get(id(key.versionId, key.op, key.idempotencyKey)) ?? null,
    claimNarration: async (
      _pool: unknown,
      input: {
        versionId: string;
        idempotencyKey: string;
        sceneId: string;
        requestDigest: string;
        now: number;
      },
    ) => {
      const at = id(input.versionId, 'narration-audio', input.idempotencyKey);
      const prior = mocks.records.get(at) as { status: string; leaseUntil: number } | undefined;
      if (prior && !(prior.status === 'running' && prior.leaseUntil <= input.now)) return false;
      mocks.records.set(at, {
        op: 'narration-audio',
        idempotencyKey: input.idempotencyKey,
        sceneId: input.sceneId,
        requestDigest: input.requestDigest,
        status: 'running',
        result: null,
        leaseUntil: input.now + actual.NARRATION_MARKER_LEASE_MS,
        createdAt: input.now,
      });
      return true;
    },
    completeNarration: async (
      _pool: unknown,
      input: { versionId: string; idempotencyKey: string; result: Record<string, unknown> },
    ) => {
      const row = mocks.records.get(id(input.versionId, 'narration-audio', input.idempotencyKey))!;
      Object.assign(row, { status: 'done', result: input.result, leaseUntil: null });
    },
    releaseNarration: async (
      _pool: unknown,
      input: { versionId: string; idempotencyKey: string },
    ) => {
      mocks.records.delete(id(input.versionId, 'narration-audio', input.idempotencyKey));
    },
    recordLinkDryRun: async (
      _pool: unknown,
      input: {
        versionId: string;
        idempotencyKey: string;
        sceneId: string;
        requestDigest: string;
        now: number;
      },
    ) => {
      mocks.records.set(id(input.versionId, 'link-dry-run', input.idempotencyKey), {
        op: 'link-dry-run',
        idempotencyKey: input.idempotencyKey,
        sceneId: input.sceneId,
        requestDigest: input.requestDigest,
        status: 'done',
        result: null,
        leaseUntil: null,
        createdAt: input.now,
      });
    },
  };
});

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (callback: () => unknown) => {
    mocks.afterCallbacks.push(callback);
  },
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: mocks.pool }),
}));
vi.mock('@/lib/server/teaching-package/resolve', () => ({
  getTeachingPackageVersion: mocks.getVersion,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({
    readFreshnessManifest: async () => ({ rev: mocks.stageRev }),
    loadDocument: async () => mocks.document,
  }),
}));
vi.mock('@/lib/persistence/owner-bound-document-store', () => ({
  createOwnerBoundDocumentStore: () => ({
    loadDocument: async () => mocks.document,
    deleteScene: mocks.deleteScene,
  }),
}));
vi.mock('@/lib/document-store/plain-json-store', () => ({
  withPlainJsonDocumentWrites: <T>(store: T) => store,
}));
vi.mock('@/lib/server/teaching-package/stage-guard', () => ({
  teachingPackageStageGuardFence: (_fence: unknown, options: unknown) => {
    mocks.guardOptions.push(options);
    return async () => undefined;
  },
}));
vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  readAllContentUnitsForVersion: async () => ({ units: mocks.units }),
}));
vi.mock('@/lib/server/teaching-package/governed-regeneration', () => ({
  resolveGovernedRegenerationContext: async () => undefined,
}));
vi.mock('@/lib/server/teaching-package/plan-inserted-slide', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/plan-inserted-slide')>()),
  planInsertedSlide: vi.fn(),
}));
vi.mock('@/lib/server/teaching-package/replan-moved-slide', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/replan-moved-slide')>()),
  replanMovedSlide: vi.fn(),
}));
vi.mock('@/lib/server/teaching-package/scene-regeneration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/scene-regeneration')>()),
  regenerateSlideScene: mocks.regenerateSlideScene,
  readSceneRegenerationForGrant: async (
    _pool: unknown,
    _grant: unknown,
    locate: { idempotencyKey: string },
  ) => {
    const row = mocks.regenerations.get(locate.idempotencyKey);
    if (!row) throw new TeachingPackageError('REGENERATION_NOT_FOUND', 'regeneration not found');
    return {
      regenerationId: `tsr-${locate.idempotencyKey}`,
      sceneId: row.sceneId,
      status: row.status,
      errorCode: null,
      resultSceneRev: row.status === 'succeeded' ? 4 : null,
      scene: null,
      current: null,
      requestedAt: 1,
      completedAt: null,
      restoredAt: null,
    };
  },
}));
vi.mock('@/lib/server/teaching-package/scene-regeneration-store', () => ({
  readSceneRegenerationByKey: async (_pool: unknown, _version: string, key: string) =>
    mocks.regenerations.get(key) ?? null,
  readLiveScene: async (_pool: unknown, _stage: string, sceneId: string) =>
    mocks.liveScenes.get(sceneId) ?? null,
  listRunningSceneRegenerations: async () =>
    [...mocks.regenerations.entries()]
      .filter(([, row]) => row.status === 'running')
      .map(([key, row]) => ({ sceneId: row.sceneId, regenerationId: `tsr-${key}` })),
}));
vi.mock('@/lib/server/teaching-package/scene-insertion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/scene-insertion')>()),
  insertGeneratedSlide: mocks.insertGeneratedSlide,
  readInsertionContext: mocks.readInsertionContext,
  readSceneInsertionForGrant: async (
    _pool: unknown,
    _grant: unknown,
    locate: { idempotencyKey: string },
  ) => {
    const row = mocks.insertions.get(locate.idempotencyKey);
    if (!row) throw new TeachingPackageError('INSERTION_NOT_FOUND', 'slide insertion not found');
    return {
      insertionId: `tpsi_${locate.idempotencyKey}`,
      status: row.status,
      errorCode: null,
      newSceneId: row.sceneId,
      resultSceneRev: null,
      scene: null,
      revTransitions: null,
      requestedAt: 1,
      completedAt: null,
      leaseRemainingMs: 1000,
    };
  },
}));
vi.mock('@/lib/server/teaching-package/scene-insertion-store', () => ({
  readSceneInsertionByKey: async (_pool: unknown, _version: string, key: string) =>
    mocks.insertions.get(key) ?? null,
  listRunningSceneInsertions: async () => [],
}));
vi.mock('@/lib/server/teaching-package/stage-generation-mutex', () => ({
  runningSceneInsertionId: async () => null,
}));
vi.mock('@/lib/server/teaching-package/scene-narration-audio', () => ({
  regenerateSceneNarrationAudio: mocks.regenerateSceneNarrationAudio,
}));
vi.mock('@/lib/server/teaching-package/scene-skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/scene-skills')>()),
  setSceneTeachingSkills: mocks.setSceneTeachingSkills,
}));

import * as opsRoute from '@/app/api/teaching-packages/[id]/agent-ops/[op]/route';
import * as statusRoute from '@/app/api/teaching-packages/[id]/agent-ops/ops/[opId]/route';
import { planDuplicateDelete } from '@/lib/server/teaching-package/delete-duplicate-scene';
import { sceneRegenerationRequestDigest } from '@/lib/server/teaching-package/scene-regeneration';

const SERVICE_KEY = 'agent-ops-route-key';
const TENANT = 'tenant-7';
const AGENT = 'agent:5';
const KEY = 'agt_3_0123456789abcdef0123456789abcdef01234567';

function slide(id: string, order: number, units: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    stageId: 'stage-1',
    type: 'slide',
    title: id,
    order,
    sourceContentUnitIds: units,
    content: { type: 'slide', canvas: { elements: [] } },
    actions: [],
    ...extra,
  } as unknown as AppScene;
}

function unit(unitId: string, orderIndex: number) {
  return {
    attemptId: 'tpa-1',
    tenantId: TENANT,
    unitId,
    orderIndex,
    role: 'explanation',
    subtype: null,
    title: `part ${unitId}`,
    normalizedText: 'نص الجزء',
    textLength: 8,
    contentRevisionId: null,
    approvedSnapshotId: null,
    createdAt: 1,
  };
}

function setDocument(scenes: AppScene[]) {
  mocks.document = { scenes, outline: null, stage: { id: 'stage-1' } };
  mocks.liveScenes = new Map(scenes.map((scene) => [scene.id, { scene, rev: 3 }]));
}

function post(op: string, body: Record<string, unknown>, authorized = true) {
  return opsRoute.POST(
    new NextRequest(`http://localhost/api/teaching-packages/tpv-1/agent-ops/${op}`, {
      method: 'POST',
      headers: {
        ...(authorized ? { authorization: `Bearer ${SERVICE_KEY}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'tpv-1', op }) },
  );
}

function getOp(opId: string) {
  return statusRoute.GET(
    new NextRequest(
      `http://localhost/api/teaching-packages/tpv-1/agent-ops/ops/${opId}?tenantId=${TENANT}`,
      { headers: { authorization: `Bearer ${SERVICE_KEY}` } },
    ),
    { params: Promise.resolve({ id: 'tpv-1', opId }) },
  );
}

const base = (extra: Record<string, unknown> = {}) => ({
  tenantContext: { tenantId: TENANT },
  actorRef: AGENT,
  expectedRevision: '12',
  ...extra,
});

const regenerateBody = (extra: Record<string, unknown> = {}) =>
  base({
    sceneId: 's1',
    instruction: 'اكتب الشريحة بلغة أبسط مع مثال',
    reason: 'the agent found the slide too dense',
    idempotencyKey: KEY,
    ...extra,
  });

/** A fake of the service's T1 and replay: one run per key, counted. */
function fakeRegeneration() {
  mocks.regenerateSlideScene.mockImplementation(
    async (
      _grant: unknown,
      sceneId: string,
      request: { idempotencyKey: string; instruction: string; reason: string },
      deps: { resolveGoverned: (...args: unknown[]) => Promise<unknown> },
    ) => {
      mocks.generations += 1;
      mocks.regenerations.set(request.idempotencyKey, {
        status: 'running',
        requestDigest: sceneRegenerationRequestDigest(sceneId, request),
        sceneId,
      });
      await deps.resolveGoverned(mocks.pool, 'tpv-1', {});
      await new Promise<void>((resolve) => mocks.finishRun.push(resolve));
      mocks.regenerations.get(request.idempotencyKey)!.status = 'succeeded';
      return { status: 200, body: { sceneId, replayed: false, resultSceneRev: 4 } };
    },
  );
}

beforeEach(() => {
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('TEACHING_PACKAGE_API_ENABLED', 'true');
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  mocks.afterCallbacks.length = 0;
  mocks.finishRun.length = 0;
  mocks.guardOptions.length = 0;
  mocks.regenerations.clear();
  mocks.insertions.clear();
  mocks.records.clear();
  vi.restoreAllMocks();
  mocks.generations = 0;
  mocks.stageRev = 12;
  mocks.version.status = 'draft';
  mocks.units = [unit('u1', 1), unit('u2', 2)];
  setDocument([slide('s1', 0, ['u1']), slide('s2', 1, ['u1']), slide('s3', 2, ['u2'])]);
  for (const fn of [
    mocks.regenerateSlideScene,
    mocks.insertGeneratedSlide,
    mocks.regenerateSceneNarrationAudio,
    mocks.setSceneTeachingSkills,
    mocks.readInsertionContext,
    mocks.deleteScene,
    mocks.getVersion,
  ]) {
    fn.mockReset();
  }
  mocks.getVersion.mockImplementation(async (id: string, scope: { tenantId: string }) => {
    if (scope.tenantId !== TENANT || id !== 'tpv-1') {
      throw new TeachingPackageError('NOT_FOUND', `teaching package ${id} not found`);
    }
    return mocks.version;
  });
  mocks.readInsertionContext.mockImplementation(async () => ({
    version: mocks.version,
    flow: null,
    governed: false,
    unsupportedReason: null,
    units: mocks.units,
    lineageStatus: 'own_attempt',
    gaps: undefined,
  }));
});

async function code(response: Response) {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

describe('agent-ops: refused list, auth and scope', () => {
  it.each([
    'submit',
    'approve',
    'reject',
    'publish',
    'regenerate-all-voiceover',
    'rebuild',
    'new-version',
    'discard',
    'move-part',
    'stage-skills',
  ])('%s is never offered: 422 AGENT_ACTION_NOT_ALLOWED, nothing runs', async (op) => {
    const response = await post(op, base());
    expect(response.status).toBe(422);
    expect(await code(response)).toBe('AGENT_ACTION_NOT_ALLOWED');
    expect(mocks.getVersion).not.toHaveBeenCalled();
  });

  it('an unknown op is a plain 404', async () => {
    expect((await post('teleport', base())).status).toBe(404);
  });

  it('no service key is 401', async () => {
    const response = await post('regenerate', regenerateBody(), false);
    expect(response.status).toBe(401);
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
  });

  it('an actor other than agent:<id> is refused', async () => {
    const response = await post(
      'regenerate',
      regenerateBody({ actorRef: 'teaching-package-editor:x' }),
    );
    expect(response.status).toBe(422);
    expect(await code(response)).toBe('AGENT_ACTION_NOT_ALLOWED');
  });

  it("another tenant's version is 404", async () => {
    const response = await post(
      'regenerate',
      regenerateBody({ tenantContext: { tenantId: 'tenant-8' } }),
    );
    expect(response.status).toBe(404);
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
  });

  it('a stale revision is 409 STALE_STATE before any service call', async () => {
    mocks.stageRev = 13;
    for (const [op, body] of [
      ['regenerate', regenerateBody()],
      ['narration-audio', base({ sceneId: 's1' })],
      ['delete', base({ sceneId: 's2', keepSceneId: 's1', reason: 'same slide twice' })],
      ['skills', base({ sceneId: 's1', primary: { skillId: 'chem', version: 'v1' } })],
    ] as const) {
      const response = await post(op, body);
      expect(response.status).toBe(409);
      const payload = (await response.json()) as { error: { code: string; details: unknown } };
      expect(payload.error.code).toBe('STALE_STATE');
      expect(payload.error.details).toMatchObject({ currentRevision: '13' });
    }
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
    expect(mocks.regenerateSceneNarrationAudio).not.toHaveBeenCalled();
    expect(mocks.setSceneTeachingSkills).not.toHaveBeenCalled();
    expect(mocks.deleteScene).not.toHaveBeenCalled();
  });
});

describe('agent-ops: regenerate', () => {
  it('answers 202 once the run row exists, as agent:<id>, with the key passed through', async () => {
    fakeRegeneration();
    const response = await post('regenerate', regenerateBody());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ opId: `rg_${KEY}`, status: 'running' });
    const [grant, sceneId, request, deps] = mocks.regenerateSlideScene.mock.calls[0]!;
    expect(grant).toMatchObject({ tenantId: TENANT, versionId: 'tpv-1', stageId: 'stage-1' });
    expect(sceneId).toBe('s1');
    expect(request).toMatchObject({ idempotencyKey: KEY });
    expect(deps.actor).toEqual({ actorRef: AGENT, sessionRef: null });
    expect(mocks.afterCallbacks).toHaveLength(1);
  });

  it('the same key twice runs once (one generation counted)', async () => {
    fakeRegeneration();
    expect((await post('regenerate', regenerateBody())).status).toBe(202);
    // The stage moved meanwhile: the replay is answered before the revision check.
    mocks.stageRev = 14;
    const again = await post('regenerate', regenerateBody());
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ opId: `rg_${KEY}`, status: 'running' });
    expect(mocks.generations).toBe(1);
    expect(mocks.regenerateSlideScene).toHaveBeenCalledTimes(1);
    mocks.finishRun.forEach((finish) => finish());
    await Promise.all(mocks.afterCallbacks.map((callback) => callback()));
    const status = await getOp(`rg_${KEY}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'done', sceneId: 's1' });
  });

  it('the same key with another body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    fakeRegeneration();
    await post('regenerate', regenerateBody());
    const other = await post('regenerate', regenerateBody({ reason: 'a different reason here' }));
    expect(other.status).toBe(409);
    expect(await code(other)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(mocks.generations).toBe(1);
  });

  it('a run that fails after its 202 is settled under after(), never an unhandled rejection', async () => {
    mocks.regenerateSlideScene.mockImplementation(
      async (
        _grant: unknown,
        _sceneId: string,
        _request: unknown,
        deps: { resolveGoverned: (...args: unknown[]) => Promise<unknown> },
      ) => {
        await deps.resolveGoverned(mocks.pool, 'tpv-1', {});
        throw new TeachingPackageError('SCENE_CONTENT_GENERATION_FAILED', 'the model failed');
      },
    );
    const response = await post('regenerate', regenerateBody());
    expect(response.status).toBe(202);
    expect(mocks.afterCallbacks).toHaveLength(1);
    await expect(Promise.resolve(mocks.afterCallbacks[0]!())).resolves.toBeUndefined();
  });

  it('a refusal before the run row is answered as itself (no 202)', async () => {
    mocks.regenerateSlideScene.mockRejectedValue(
      new TeachingPackageError('STAGE_LOCKED', 'the teaching package is not editable'),
    );
    const response = await post('regenerate', regenerateBody());
    expect(response.status).toBe(423);
    expect(await code(response)).toBe('STAGE_LOCKED');
  });

  it('a dry run calls no service and writes nothing', async () => {
    const response = await post(
      'regenerate',
      regenerateBody({ dryRun: true, idempotencyKey: undefined }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dryRun: true, wouldRun: true, sceneId: 's1' });
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
    expect(mocks.regenerations.size).toBe(0);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('a dry run still refuses a locked package', async () => {
    mocks.version.status = 'pending_review';
    const response = await post('regenerate', regenerateBody({ dryRun: true }));
    expect(response.status).toBe(423);
  });
});

describe('agent-ops: link a part (D-6)', () => {
  it('a dry run resolves the new part list and calls no model', async () => {
    const response = await post(
      'link',
      regenerateBody({ sceneId: 's3', unitId: 'u1', dryRun: true }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      sourceContentUnitIds: ['u1', 'u2'],
    });
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
  });

  it('a real link, after its dry run by the same key, is the add-only content-unit change', async () => {
    fakeRegeneration();
    const dry = await post('link', regenerateBody({ sceneId: 's3', unitId: 'u1', dryRun: true }));
    expect(dry.status).toBe(200);
    const response = await post('link', regenerateBody({ sceneId: 's3', unitId: 'u1' }));
    expect(response.status).toBe(202);
    const request = mocks.regenerateSlideScene.mock.calls[0]![2];
    expect(request.contentUnitChange).toEqual({ op: 'add', unitId: 'u1' });
  });

  it('D-6: a real link without a matching dry run is 409 LINK_DRY_RUN_REQUIRED', async () => {
    fakeRegeneration();
    const none = await post('link', regenerateBody({ sceneId: 's3', unitId: 'u1' }));
    expect(none.status).toBe(409);
    expect(await code(none)).toBe('LINK_DRY_RUN_REQUIRED');
    // A dry run of another part does not count.
    mocks.units = [unit('u1', 1), unit('u2', 2), unit('u3', 3)];
    await post('link', regenerateBody({ sceneId: 's3', unitId: 'u3', dryRun: true }));
    const other = await post('link', regenerateBody({ sceneId: 's3', unitId: 'u1' }));
    expect(await code(other)).toBe('LINK_DRY_RUN_REQUIRED');
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
  });

  it('D-6: a dry run older than 30 minutes no longer counts', async () => {
    fakeRegeneration();
    const start = Date.now();
    await post('link', regenerateBody({ sceneId: 's3', unitId: 'u1', dryRun: true }));
    vi.spyOn(Date, 'now').mockReturnValue(start + 31 * 60 * 1000);
    const late = await post('link', regenerateBody({ sceneId: 's3', unitId: 'u1' }));
    expect(late.status).toBe(409);
    expect(await code(late)).toBe('LINK_DRY_RUN_REQUIRED');
    expect(mocks.regenerateSlideScene).not.toHaveBeenCalled();
  });

  it('a part the slide already teaches is refused', async () => {
    const response = await post(
      'link',
      regenerateBody({ sceneId: 's1', unitId: 'u1', dryRun: true }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { details: { rule: string } } };
    expect(payload.error.details.rule).toBe('alreadyTaught');
  });
});

describe('agent-ops: generate, narration audio, skills', () => {
  it('generate passes the agent actor and the derived neighbour', async () => {
    mocks.insertGeneratedSlide.mockResolvedValue({
      status: 200,
      body: {
        insertion: { newSceneId: 'scene_ins_1', resultSceneRev: 1 },
        replayed: false,
      },
    });
    const response = await post(
      'generate',
      base({
        unitIds: ['u2'],
        afterSceneId: 's1',
        teachingStage: { key: 'explain', flowIndex: 1 },
        instruction: 'focus on the example',
        reason: 'part u2 has no slide',
        idempotencyKey: KEY,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ opId: `in_${KEY}`, status: 'done' });
    const [, request, deps] = mocks.insertGeneratedSlide.mock.calls[0]!;
    expect(request).toMatchObject({
      unitIds: ['u2'],
      afterSceneId: 's1',
      beforeSceneId: 's2',
      idempotencyKey: KEY,
    });
    expect(deps.actor).toEqual({ actorRef: AGENT, sessionRef: null });
  });

  const priorInsertion = () => ({
    status: 'running' as const,
    requestDigest: 'x',
    sceneId: 'scene_ins_1',
    tenantId: TENANT,
    stageId: 'stage-1',
    unitIds: ['u2', 'u4'],
    afterSceneId: 's1',
    // The derived neighbour the run saw: never compared (the run itself moved it).
    beforeSceneId: 's2',
    instruction: 'focus on the example',
    reason: 'part u2 has no slide',
    teachingStage: { key: 'explain', flowIndex: 1 },
  });
  const generateBody = (extra: Record<string, unknown> = {}) =>
    base({
      unitIds: ['u4', 'u2'],
      afterSceneId: 's1',
      instruction: 'focus on the example',
      reason: 'part u2 has no slide',
      idempotencyKey: KEY,
      ...extra,
    });

  it('generate with a key that already ran answers that run, no new generation', async () => {
    mocks.insertions.set(KEY, priorInsertion() as never);
    mocks.stageRev = 99;
    const response = await post('generate', generateBody());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ opId: `in_${KEY}`, status: 'running' });
    expect(mocks.insertGeneratedSlide).not.toHaveBeenCalled();
  });

  it.each([
    ['the parts', { unitIds: ['u2'] }],
    ['the anchor', { afterSceneId: 's3' }],
    ['the instruction', { instruction: 'another focus' }],
    ['the reason', { reason: 'another reason entirely' }],
    ['the named stage', { teachingStage: { key: 'practice', flowIndex: 2 } }],
  ])(
    'generate with the same key and other %s is 409 IDEMPOTENCY_KEY_REUSED',
    async (_label, extra) => {
      mocks.insertions.set(KEY, priorInsertion() as never);
      const response = await post('generate', generateBody(extra));
      expect(response.status).toBe(409);
      expect(await code(response)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(mocks.insertGeneratedSlide).not.toHaveBeenCalled();
    },
  );

  it('narration audio runs the editor service as agent:<id>; its dry run synthesizes nothing', async () => {
    mocks.regenerateSceneNarrationAudio.mockResolvedValue({
      sceneId: 's1',
      scene: {},
      rev: 4,
      generated: 2,
      missing: 0,
    });
    const dry = await post('narration-audio', base({ sceneId: 's1', dryRun: true }));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true, sceneId: 's1' });
    expect(mocks.regenerateSceneNarrationAudio).not.toHaveBeenCalled();
    const real = await post('narration-audio', base({ sceneId: 's1' }));
    expect(real.status).toBe(200);
    expect(await real.json()).toMatchObject({ status: 'done', generated: 2 });
    expect(mocks.regenerateSceneNarrationAudio.mock.calls[0]![2]).toMatchObject({
      actorRef: AGENT,
    });
  });

  it('narration audio by a key: a retry is "already applied", never a second synthesis', async () => {
    mocks.regenerateSceneNarrationAudio.mockResolvedValue({
      sceneId: 's1',
      scene: {},
      rev: 4,
      generated: 2,
      missing: 0,
    });
    const body = base({ sceneId: 's1', idempotencyKey: KEY });
    expect((await post('narration-audio', body)).status).toBe(200);
    mocks.stageRev = 13; // the write moved the stage: the retry is answered before the check
    const again = await post('narration-audio', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'done', replayed: true, generated: 2 });
    expect(mocks.regenerateSceneNarrationAudio).toHaveBeenCalledTimes(1);
  });

  it('narration audio by a key: a retry during a slow TTS run is 409 AGENT_OP_IN_PROGRESS', async () => {
    let finish: () => void = () => {};
    mocks.regenerateSceneNarrationAudio.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ sceneId: 's1', scene: {}, rev: 4, generated: 1, missing: 0 });
        }),
    );
    const body = base({ sceneId: 's1', idempotencyKey: KEY });
    const first = post('narration-audio', body);
    await vi.waitFor(() => expect(mocks.regenerateSceneNarrationAudio).toHaveBeenCalled());
    const during = await post('narration-audio', body);
    expect(during.status).toBe(409);
    expect(await code(during)).toBe('AGENT_OP_IN_PROGRESS');
    finish();
    expect((await first).status).toBe(200);
    expect(mocks.regenerateSceneNarrationAudio).toHaveBeenCalledTimes(1);
  });

  it('narration audio by a key: a failed synthesis frees the key', async () => {
    mocks.regenerateSceneNarrationAudio.mockRejectedValueOnce(
      new TeachingPackageError('NARRATION_AUDIO_GENERATION_FAILED', 'the voice did not answer'),
    );
    const body = base({ sceneId: 's1', idempotencyKey: KEY });
    expect((await post('narration-audio', body)).status).toBe(502);
    mocks.regenerateSceneNarrationAudio.mockResolvedValue({
      sceneId: 's1',
      scene: {},
      rev: 4,
      generated: 2,
      missing: 0,
    });
    expect((await post('narration-audio', body)).status).toBe(200);
    expect(mocks.regenerateSceneNarrationAudio).toHaveBeenCalledTimes(2);
  });

  it('skills: a retry when the slide already carries that primary is "already applied"', async () => {
    setDocument([
      slide('s1', 0, ['u1'], { teachingSkills: { primary: { skillId: 'chem', version: 'v1' } } }),
    ]);
    mocks.stageRev = 13;
    const response = await post(
      'skills',
      base({ sceneId: 's1', primary: { skillId: 'chem', version: 'v1' } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'done', alreadyApplied: true });
    expect(mocks.setSceneTeachingSkills).not.toHaveBeenCalled();
  });

  it('skills replaces only the primary, keeps supporting, and forwards the dry run', async () => {
    setDocument([
      slide('s1', 0, ['u1'], {
        teachingSkills: {
          classification: 'instructional',
          primary: { skillId: 'old', version: 'v1' },
          supporting: [{ skillId: 'sup', version: 'v2' }],
        },
      }),
    ]);
    mocks.setSceneTeachingSkills.mockResolvedValue({ updatedSceneIds: ['s1'] });
    const response = await post(
      'skills',
      base({ sceneId: 's1', primary: { skillId: 'chem', version: 'v1' }, dryRun: true }),
    );
    expect(response.status).toBe(200);
    const [, versionId, scope, assignments, options] = mocks.setSceneTeachingSkills.mock.calls[0]!;
    expect(versionId).toBe('tpv-1');
    expect(scope).toEqual({ tenantId: TENANT, actorRef: AGENT });
    expect(options).toEqual({ dryRun: true });
    expect(assignments[0].teachingSkills).toEqual({
      classification: 'instructional',
      primary: { skillId: 'chem', version: 'v1' },
      supporting: [{ skillId: 'sup', version: 'v2' }],
    });
  });
});

describe('agent-ops: delete a duplicate', () => {
  const del = (extra: Record<string, unknown> = {}) =>
    post(
      'delete',
      base({ sceneId: 's2', keepSceneId: 's1', reason: 'the same slide twice', ...extra }),
    );

  it('deletes a duplicate under the agent actor and returns the backup', async () => {
    const response = await del();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deleted: boolean;
      backup: Record<string, unknown>;
    };
    expect(body.deleted).toBe(true);
    // The agent read's slide form (spec §5.5), not the raw scene.
    expect(body.backup.scene_id).toBe('s2');
    expect(body.backup).toHaveProperty('slide_number');
    expect(body.backup).not.toHaveProperty('content');
    expect(body.backup).not.toHaveProperty('actions');
    expect(mocks.deleteScene).toHaveBeenCalledWith('stage-1', 's2');
    expect(mocks.guardOptions).toContainEqual({ sceneEvents: { actorRef: AGENT } });
  });

  it('a dry run returns the backup and deletes nothing', async () => {
    const response = await del({ dryRun: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dryRun: true,
      deleted: false,
      status: 'would_delete',
    });
    expect(mocks.deleteScene).not.toHaveBeenCalled();
  });

  it('refused when the kept slide does not teach a part the deleted one teaches', async () => {
    // s3 is the only slide teaching u2; the kept slide s1 does not teach it.
    const response = await del({ sceneId: 's3', keepSceneId: 's1' });
    expect(response.status).toBe(422);
    expect(await code(response)).toBe('SCENE_NOT_DUPLICATE');
    expect(mocks.deleteScene).not.toHaveBeenCalled();
  });

  it('refused with PART_WOULD_BE_UNTAUGHT when a part would be left with no slide', async () => {
    // The kept slide cites u2 but is a summary slide, which does not count as teaching.
    setDocument([
      slide('s1', 0, ['u1', 'u2'], { content: { type: 'slide', contentRole: 'summary' } }),
      slide('s2', 1, ['u1']),
      slide('s3', 2, ['u2']),
    ]);
    const response = await del({ sceneId: 's3', keepSceneId: 's1' });
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string; details: unknown } };
    expect(payload.error.code).toBe('PART_WOULD_BE_UNTAUGHT');
    expect(payload.error.details).toMatchObject({ unitIds: ['u2'] });
    expect(mocks.deleteScene).not.toHaveBeenCalled();
  });

  it('refused while a slide is being generated on the lesson', async () => {
    mocks.regenerations.set('k', { status: 'running', requestDigest: 'x', sceneId: 's1' });
    const response = await del();
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('STAGE_GENERATION_IN_PROGRESS');
  });
});

describe('planDuplicateDelete', () => {
  const units = [unit('u1', 1), unit('u2', 2)] as never;

  it('PART_WOULD_BE_UNTAUGHT when the kept slide does not count as teaching', () => {
    // The kept slide cites u2 but is a summary slide (not teaching): deleting s3
    // would leave u2 untaught.
    const scenes = [
      slide('s1', 0, ['u2'], { content: { type: 'slide', contentRole: 'summary' } }),
      slide('s3', 1, ['u2']),
    ];
    expect(() =>
      planDuplicateDelete({
        sceneId: 's3',
        keepSceneId: 's1',
        scenes,
        outline: null,
        units,
        flow: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'PART_WOULD_BE_UNTAUGHT' }));
  });

  it('refuses a bank quiz and a different type', () => {
    const scenes = [
      slide('s1', 0, ['u1']),
      { ...slide('q1', 1, ['u1']), type: 'quiz', questionSource: 'bank' } as unknown as AppScene,
    ];
    expect(() =>
      planDuplicateDelete({
        sceneId: 'q1',
        keepSceneId: 's1',
        scenes,
        outline: null,
        units,
        flow: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'SCENE_NOT_DUPLICATE' }));
  });

  it('refuses a slide that cites no lesson part (nothing proves it a duplicate)', () => {
    const scenes = [slide('s1', 0, []), slide('s2', 1, [])];
    expect(() =>
      planDuplicateDelete({
        sceneId: 's2',
        keepSceneId: 's1',
        scenes,
        outline: null,
        units,
        flow: null,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SCENE_NOT_DUPLICATE',
        details: { reason: 'cites_no_part' },
      }),
    );
  });

  it('refuses a kept slide in another teaching stage (its own, or its outline entry’s)', () => {
    const own = [
      slide('s1', 0, ['u1'], { teachingStage: { key: 'explain', flowIndex: 1 } }),
      slide('s2', 1, ['u1'], { teachingStage: { key: 'practice', flowIndex: 2 } }),
    ];
    expect(() =>
      planDuplicateDelete({
        sceneId: 's2',
        keepSceneId: 's1',
        scenes: own,
        outline: null,
        units,
        flow: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'SCENE_NOT_DUPLICATE' }));
    const viaOutline = [
      slide('s1', 0, ['u1'], { outlineId: 'o1' }),
      slide('s2', 1, ['u1'], { outlineId: 'o2' }),
    ];
    const outline = {
      outlines: [
        { id: 'o1', teachingStage: { key: 'explain', flowIndex: 1 } },
        { id: 'o2', teachingStage: { key: 'practice', flowIndex: 2 } },
      ],
    } as never;
    expect(() =>
      planDuplicateDelete({
        sceneId: 's2',
        keepSceneId: 's1',
        scenes: viaOutline,
        outline,
        units,
        flow: null,
      }),
    ).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'stage_mismatch' }) }),
    );
  });

  it('refuses a transition slide as a duplicate of a content slide (same kind only)', () => {
    // Both cite u1 in the same stage: only the slide kind tells them apart.
    const ownCanvas = [
      slide('s1', 0, ['u1'], {
        content: { type: 'slide', canvas: { type: 'content', elements: [] } },
      }),
      slide('t1', 1, ['u1'], {
        content: { type: 'slide', canvas: { type: 'transition', elements: [] } },
      }),
    ];
    expect(() =>
      planDuplicateDelete({
        sceneId: 't1',
        keepSceneId: 's1',
        scenes: ownCanvas,
        outline: null,
        units,
        flow: null,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SCENE_NOT_DUPLICATE',
        details: {
          reason: 'slide_type_mismatch',
          slideType: 'transition',
          keepSlideType: 'content',
        },
      }),
    );
    // The kind from the outline entry when the canvas carries none.
    const viaOutline = [
      slide('s1', 0, ['u1'], { outlineId: 'o1' }),
      slide('t1', 1, ['u1'], { outlineId: 'o2' }),
    ];
    const outline = {
      outlines: [
        { id: 'o1', slideType: 'content' },
        { id: 'o2', slideType: 'transition' },
      ],
    } as never;
    expect(() =>
      planDuplicateDelete({
        sceneId: 't1',
        keepSceneId: 's1',
        scenes: viaOutline,
        outline,
        units,
        flow: null,
      }),
    ).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'slide_type_mismatch' }),
      }),
    );
  });

  it('allows a true duplicate', () => {
    const scenes = [slide('s1', 0, ['u1', 'u2']), slide('s2', 1, ['u1'])];
    expect(
      planDuplicateDelete({
        sceneId: 's2',
        keepSceneId: 's1',
        scenes,
        outline: null,
        units,
        flow: null,
      }).citedUnitIds,
    ).toEqual(['u1']);
  });
});

describe('agent-ops/ops status', () => {
  it('an unknown op id is 404', async () => {
    expect((await getOp('zz_nothing')).status).toBe(404);
    expect((await getOp(`rg_${KEY}`)).status).toBe(404);
  });
});
