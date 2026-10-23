import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave, aggregateSave, loadStageData } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue(undefined),
  aggregateSave: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => aggregateSave(...args),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: (...args: unknown[]) => loadStageData(...args),
}));

import {
  runSceneInsertion,
  type SceneInsertionRequest,
  type SceneInsertionStatus,
} from '@/lib/edit/scene-insertion-client';
import {
  bindStageSceneRevs,
  clearStageSceneRevs,
  sceneRev,
} from '@/lib/persistence/scene-revision-registry';
import {
  beginSceneRegeneration,
  flushStageSave,
  isStageEditingLocked,
  isStageWritesHeld,
  useStageStore,
} from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * Reviewer-generated slide plan §5.1 / §18 (V2-2, V3-1, V3-2, V3.1-1/2): the
 * browser protocol — preparation proves the whole Stage durable before any
 * POST, and the result is fetched first and applied synchronously.
 */

const STAGE = 'stage-ci';
const OTHER = 'stage-ci-other';
const NEW = 'scene-new';
const stage = (id = STAGE): Stage => ({ id, name: id, createdAt: 1, updatedAt: 1 });
const scene = (id: string, title = id, order = 1, stageId = STAGE): Scene => ({
  id,
  stageId,
  type: 'slide',
  title,
  order,
  content: {
    type: 'slide',
    canvas: {
      id: `canvas-${id}`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: ['#000'],
        fontColor: '#000',
        fontName: 'Inter',
      },
      elements: [],
    },
  },
});

const request: SceneInsertionRequest = {
  unitIds: ['cu_1'],
  afterSceneId: 's1',
  beforeSceneId: 's2',
  teachingStage: { key: 'explain', flowIndex: 1 },
  instruction: '',
  reason: 'unit 1 has no slide',
  idempotencyKey: 'insert-key-1',
};

const succeeded: SceneInsertionStatus = {
  insertionId: 'tpsi_1',
  status: 'succeeded',
  errorCode: null,
  newSceneId: NEW,
  resultSceneRev: 20,
  scene: scene(NEW, 'generated', 2),
  revTransitions: { s1: { before: 1, after: 11 }, s2: { before: 2, after: 12 } },
  requestedAt: 1,
  completedAt: 2,
};

const serverData = () => ({
  stage: stage(),
  scenes: [scene('s1', 'one', 1), scene(NEW, 'generated', 2), scene('s2', 'two', 3)],
  currentSceneId: 's1',
  chats: [],
  sceneRevs: { s1: 11, [NEW]: 20, s2: 12 },
});

function deferred<T>() {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

function fetchRouter(routes: { post?: Route; status?: Route }) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/scene-insertions')) {
      return (routes.post ?? (() => Response.json({ insertion: succeeded })))(init);
    }
    if (url.includes('/scene-insertions/')) {
      return (routes.status ?? (() => Response.json(succeeded)))(init);
    }
    return new Response('not found', { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const posts = (calls: Array<{ method: string }>) => calls.filter((call) => call.method === 'POST');

function titles(): string[] {
  return useStageStore.getState().scenes.map((entry) => entry.title);
}

beforeEach(() => {
  incrementalSave.mockReset().mockResolvedValue(undefined);
  aggregateSave.mockReset().mockResolvedValue(undefined);
  loadStageData.mockReset().mockResolvedValue(serverData());
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stage(),
    scenes: [scene('s1', 'one', 1), scene('s2', 'two', 2)],
    currentSceneId: 's1',
    chats: [],
  });
  bindStageSceneRevs(STAGE, { s1: 1, s2: 2 });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  clearStageSceneRevs();
  vi.useRealTimers();
});

describe('scene insertion client — result application (step 9)', () => {
  it('a clean Stage: POST, then fetch, then a synchronous clean apply', async () => {
    const { impl, calls } = fetchRouter({});
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toEqual({
      kind: 'success',
      insertionId: 'tpsi_1',
      sceneId: NEW,
      applied: 'applied',
    });
    expect(posts(calls)).toHaveLength(1);
    expect(titles()).toEqual(['one', 'generated', 'two']);
    expect(useStageStore.getState().currentSceneId).toBe(NEW);
    expect(sceneRev(STAGE, NEW)).toBe(20);
    // Exactly one read — its own; the insertion never runs the resync.
    expect(loadStageData).toHaveBeenCalledOnce();
    expect(isStageEditingLocked(STAGE)).toBe(false);
    expect(isStageWritesHeld(STAGE)).toBe(false);
  });

  it('never calls resyncStageScenesFromServer', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/edit/scene-insertion-client.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/resyncStageScenesFromServer\s*\(/);
  });

  it('a mutation during the clean-path fetch is seen at apply time and kept', async () => {
    const { impl } = fetchRouter({});
    loadStageData.mockImplementationOnce(async () => {
      // Lands while the read is awaited (it bypassed the editing lock).
      useStageStore.getState().updateScene('s2', { title: 'edited during fetch' });
      return serverData();
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toMatchObject({ kind: 'success', applied: 'merged' });
    expect(titles()).toEqual(['one', 'generated', 'edited during fetch']);
    // Only the insertion's shift touched s2: rebound, so the next save passes.
    expect(sceneRev(STAGE, 's2')).toBe(12);
  });

  it('on a dirty run, an additional mutation during the fetch is included too', async () => {
    let releasePost!: () => void;
    const gate = new Promise<void>((res) => {
      releasePost = res;
    });
    const { impl } = fetchRouter({
      post: async () => {
        await gate;
        return Response.json({ insertion: succeeded });
      },
    });
    const run = runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    await vi.waitFor(() => expect(isStageWritesHeld(STAGE)).toBe(true));
    // Dirt during the run…
    useStageStore.getState().updateScene('s1', { title: 'during the run' });
    loadStageData.mockImplementationOnce(async () => {
      // …and more during the fetch: both are in the at-apply set.
      useStageStore.getState().updateScene('s2', { title: 'during the fetch' });
      return serverData();
    });
    releasePost();
    const outcome = await run;
    expect(outcome).toMatchObject({ kind: 'success', applied: 'merged' });
    expect(titles()).toEqual(['during the run', 'generated', 'during the fetch']);
  });

  it('navigation during the fetch → saved-not-shown (stale); the other lesson is untouched', async () => {
    const { impl } = fetchRouter({});
    loadStageData.mockImplementationOnce(async () => {
      useStageStore.getState().setStage(stage(OTHER));
      useStageStore.setState({ scenes: [scene('o1', 'other lesson', 1, OTHER)] });
      return serverData();
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toEqual({
      kind: 'saved-not-shown',
      insertionId: 'tpsi_1',
      sceneId: NEW,
      reason: 'stale',
    });
    expect(titles()).toEqual(['other lesson']);
    expect(sceneRev(STAGE, NEW)).toBeUndefined();
  });

  it('navigating away while held dirt exists: the departure save runs, the result is stale (V3.1-2)', async () => {
    let releasePost!: () => void;
    const gate = new Promise<void>((res) => {
      releasePost = res;
    });
    const { impl } = fetchRouter({
      post: async () => {
        await gate;
        return Response.json({ insertion: succeeded });
      },
    });
    const run = runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    await vi.waitFor(() => expect(isStageWritesHeld(STAGE)).toBe(true));
    useStageStore.getState().updateScene('s2', { title: 'held edit' });
    useStageStore.getState().setStage(stage(OTHER));
    // The departure write keeps its existing navigation semantics.
    await vi.waitFor(() =>
      expect(incrementalSave.mock.calls.some((call) => call[0] === STAGE)).toBe(true),
    );
    releasePost();
    const outcome = await run;
    expect(outcome).toMatchObject({ kind: 'saved-not-shown', reason: 'stale' });
    expect(useStageStore.getState().stage?.id).toBe(OTHER);
  });

  it('a snapshot without proven revisions → saved-not-shown (unbound), nothing changes', async () => {
    const { impl } = fetchRouter({});
    const { sceneRevs: _revs, ...withoutRevs } = serverData();
    loadStageData.mockResolvedValueOnce(withoutRevs);
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toMatchObject({ kind: 'saved-not-shown', reason: 'unbound' });
    expect(titles()).toEqual(['one', 'two']);
    expect(sceneRev(STAGE, 's1')).toBe(1);
  });

  it('a server failure: no fetch, no application, local state byte-equal', async () => {
    const before = JSON.stringify(useStageStore.getState().scenes);
    const { impl } = fetchRouter({
      post: () =>
        Response.json(
          { error: { code: 'INSERTION_FLOW_INVALID', message: 'no', details: { reason: 'x' } } },
          { status: 422 },
        ),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toMatchObject({ kind: 'failed', status: 422, code: 'INSERTION_FLOW_INVALID' });
    expect(loadStageData).not.toHaveBeenCalled();
    expect(JSON.stringify(useStageStore.getState().scenes)).toBe(before);
  });

  it('polling gives up → unknown, no fetch; the key is kept by the caller', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: running }, { status: 202 }),
      status: () => Response.json(running),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, maxPolls: 2, pollIntervalMs: 1 },
    );
    expect(outcome).toEqual({ kind: 'unknown', insertionId: 'tpsi_1' });
    expect(loadStageData).not.toHaveBeenCalled();
  });

  it('a fetch error after success is retried while holding; persistent → saved-not-shown, untouched', async () => {
    const { impl } = fetchRouter({});
    loadStageData.mockRejectedValueOnce(new Error('offline'));
    const retried = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(retried).toMatchObject({ kind: 'success', applied: 'applied' });

    useStageStore.setState({ scenes: [scene('s1', 'one', 1), scene('s2', 'two', 2)] });
    bindStageSceneRevs(STAGE, { s1: 1, s2: 2 });
    loadStageData
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'));
    const outcome = await runSceneInsertion(
      {
        stageId: STAGE,
        request: { ...request, idempotencyKey: 'insert-key-2' },
        localGenerationRunning: false,
      },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'saved-not-shown', reason: 'fetch-error' });
    expect(titles()).toEqual(['one', 'two']);
  });

  it('a gateway timeout on the POST is retried with the SAME key, and the replay is polled', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    const bodies: string[] = [];
    let posts = 0;
    const { impl } = fetchRouter({
      post: (init) => {
        bodies.push(String(init?.body));
        posts += 1;
        // The proxy cut the first, long request (no TE error envelope).
        return posts === 1
          ? new Response('<html>504 Gateway Time-out</html>', { status: 504 })
          : Response.json({ insertion: running, replayed: true }, { status: 202 });
      },
      status: () => Response.json(succeeded),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('a TE error with a code on a 503 is a definite failure (not retried)', async () => {
    let posts = 0;
    const { impl } = fetchRouter({
      post: () => {
        posts += 1;
        return Response.json(
          { error: { code: 'TEACHING_MODEL_UNAVAILABLE', message: 'both routes failed' } },
          { status: 503 },
        );
      },
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'TEACHING_MODEL_UNAVAILABLE' });
    expect(posts).toBe(1);
  });

  it('ambiguous POST answers until the run deadline → unknown (keep the key), never failed', async () => {
    const { impl } = fetchRouter({ post: () => new Response('bad gateway', { status: 502 }) });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1, budgetMs: 30 },
    );
    expect(outcome).toEqual({ kind: 'unknown', insertionId: null });
    expect(isStageWritesHeld(STAGE)).toBe(false);
  });

  it('a network drop over many POST attempts keeps retrying the same key inside the deadline', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    const bodies: string[] = [];
    const { impl } = fetchRouter({
      post: (init) => {
        bodies.push(String(init?.body));
        if (bodies.length <= 6) throw new TypeError('network down');
        return Response.json({ insertion: running, replayed: true }, { status: 202 });
      },
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(bodies).toHaveLength(7);
    expect(new Set(bodies).size).toBe(1);
  });

  it('an unmapped TE INTERNAL_ERROR on the POST is retried with the same key (the replay answers)', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    const bodies: string[] = [];
    const { impl } = fetchRouter({
      post: (init) => {
        bodies.push(String(init?.body));
        return bodies.length === 1
          ? Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 })
          : Response.json({ insertion: running, replayed: true }, { status: 202 });
      },
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('the polling deadline follows the server-reported lease', async () => {
    let polls = 0;
    const leased = {
      ...succeeded,
      status: 'running' as const,
      revTransitions: null,
      leaseRemainingMs: 500,
    };
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: leased, replayed: true }, { status: 202 }),
      status: () => {
        polls += 1;
        return polls < 15 ? Response.json(leased) : Response.json(succeeded);
      },
    });
    // A run budget that alone would stop after the first poll or so.
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1, budgetMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(polls).toBe(15);
  });

  it('a plain 404 (edge, misroute) is transient; only the TE’s INSERTION_NOT_FOUND ends polling', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    let polls = 0;
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: running, replayed: true }, { status: 202 }),
      status: () => {
        polls += 1;
        return polls === 1 ? new Response('Not found', { status: 404 }) : Response.json(succeeded);
      },
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'success' });
  });

  it('the server lease can never outlast the editor’s run budget', async () => {
    const { MAX_SCENE_INSERTION_LEASE_SECONDS, sceneInsertionLeaseSeconds } =
      await import('@/lib/server/teaching-package/scene-insertion-store');
    const { INSERTION_RUN_BUDGET_MS } = await import('@/lib/edit/scene-insertion-client');
    expect(MAX_SCENE_INSERTION_LEASE_SECONDS * 1000 + 60_000).toBeLessThan(INSERTION_RUN_BUDGET_MS);
    vi.stubEnv('SCENE_INSERTION_LEASE_SECONDS', '5000');
    expect(sceneInsertionLeaseSeconds()).toBe(MAX_SCENE_INSERTION_LEASE_SECONDS);
    vi.stubEnv('SCENE_INSERTION_LEASE_SECONDS', '120');
    expect(sceneInsertionLeaseSeconds()).toBe(120);
    vi.unstubAllEnvs();
  });

  it('transient poll errors (transport, gateway, coded 500) keep polling — and keep holding', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    let polls = 0;
    const heldDuringPolls: boolean[] = [];
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: running, replayed: true }, { status: 202 }),
      status: () => {
        polls += 1;
        heldDuringPolls.push(isStageWritesHeld(STAGE) && isStageEditingLocked(STAGE));
        if (polls === 1) throw new TypeError('network down');
        if (polls === 2) return new Response('gateway', { status: 504 });
        if (polls === 3)
          return Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
        return Response.json(succeeded);
      },
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(polls).toBe(4);
    expect(heldDuringPolls).toEqual([true, true, true, true]);
    expect(isStageWritesHeld(STAGE)).toBe(false);
  });

  it('a definite 404 on the status read ends polling as unknown', async () => {
    const running = { ...succeeded, status: 'running' as const, revTransitions: null };
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: running, replayed: true }, { status: 202 }),
      status: () => Response.json({ error: { code: 'INSERTION_NOT_FOUND' } }, { status: 404 }),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, pollIntervalMs: 1 },
    );
    expect(outcome).toEqual({ kind: 'unknown', insertionId: 'tpsi_1' });
  });
});

describe('scene insertion client — preparation (steps 1–6)', () => {
  it('a non-anchor Scene whose save failed is refused: no POST, the edit kept', async () => {
    vi.useFakeTimers();
    incrementalSave.mockRejectedValue(new Error('offline'));
    useStageStore.getState().updateScene('s2', { title: 'unsaved edit' });
    const { impl, calls } = fetchRouter({});
    const outcome = await runSceneInsertion(
      {
        stageId: STAGE,
        request: { ...request, afterSceneId: null, beforeSceneId: 's1' },
        localGenerationRunning: false,
      },
      { fetchImpl: impl },
    );
    expect(outcome).toEqual({ kind: 'not-durable', pendingKeys: ['scene:s2'], conflict: false });
    expect(posts(calls)).toHaveLength(0);
    expect(titles()).toEqual(['one', 'unsaved edit']);
    expect(isStageEditingLocked(STAGE)).toBe(false);
  });

  it('pending structure dirt that cannot be saved is refused, and the reorder is kept', async () => {
    vi.useFakeTimers();
    incrementalSave.mockRejectedValue(new Error('offline'));
    const [s1, s2] = useStageStore.getState().scenes;
    useStageStore.getState().setScenes([
      { ...s2!, order: 1 },
      { ...s1!, order: 2 },
    ]);
    const { impl, calls } = fetchRouter({});
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toMatchObject({ kind: 'not-durable' });
    expect(posts(calls)).toHaveLength(0);
    expect(titles()).toEqual(['two', 'one']);
  });

  it('a flush round in flight: proceeds only after it settles and the Stage is durable', async () => {
    const save = deferred<undefined>();
    incrementalSave.mockReturnValueOnce(save.promise);
    useStageStore.getState().updateScene('s1', { title: 'autosaving' });
    const flushing = flushStageSave();
    const { impl, calls } = fetchRouter({});
    const run = runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    await Promise.resolve();
    expect(posts(calls)).toHaveLength(0);
    save.resolve(undefined);
    await flushing;
    const outcome = await run;
    expect(outcome).toMatchObject({ kind: 'success' });
  });

  it('a direct aggregate save already running: the drain awaits it before any POST (V3-2)', async () => {
    const write = deferred<undefined>();
    aggregateSave.mockReturnValueOnce(write.promise);
    void useStageStore.getState().saveToStorage();
    const order: string[] = [];
    const { impl } = fetchRouter({
      post: () => {
        order.push('post');
        return Response.json({ insertion: succeeded });
      },
    });
    const run = runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    await Promise.resolve();
    order.push('save settles');
    write.resolve(undefined);
    await expect(run).resolves.toMatchObject({ kind: 'success' });
    expect(order).toEqual(['save settles', 'post']);
  });

  it('a save conflict published during the drain is refused', async () => {
    incrementalSave.mockRejectedValueOnce(
      Object.assign(new Error('refused'), {
        status: 409,
        code: 'SCENE_REVISION_CONFLICT',
        details: { scenes: [{ id: 's2', currentRev: 7 }] },
      }),
    );
    loadStageData.mockResolvedValueOnce({
      ...serverData(),
      scenes: [scene('s1', 'one', 1), scene('s2', 'server two', 2)],
      sceneRevs: { s1: 1, s2: 7 },
    });
    useStageStore.getState().updateScene('s2', { title: 'local' });
    const { impl, calls } = fetchRouter({});
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    expect(outcome).toMatchObject({ kind: 'not-durable', conflict: true });
    expect(posts(calls)).toHaveLength(0);
  });

  it('a direct save during the run is deferred, then written by the flush after release', async () => {
    let releasePost!: () => void;
    const gate = new Promise<void>((res) => {
      releasePost = res;
    });
    const { impl } = fetchRouter({
      post: async () => {
        await gate;
        return Response.json({ insertion: succeeded });
      },
    });
    const run = runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl },
    );
    await vi.waitFor(() => expect(isStageWritesHeld(STAGE)).toBe(true));
    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(false);
    expect(aggregateSave).not.toHaveBeenCalled();
    releasePost();
    await run;
    await vi.waitFor(() => expect(incrementalSave).toHaveBeenCalled());
  });

  it('busy: a regeneration in this tab, or one held on the Stage, refuses without side effects', async () => {
    const { impl, calls } = fetchRouter({});
    await expect(
      runSceneInsertion(
        { stageId: STAGE, request, localGenerationRunning: true },
        { fetchImpl: impl },
      ),
    ).resolves.toEqual({ kind: 'busy' });
    const regeneration = beginSceneRegeneration(STAGE, 's1');
    regeneration.holdWrites();
    await expect(
      runSceneInsertion(
        { stageId: STAGE, request, localGenerationRunning: false },
        { fetchImpl: impl },
      ),
    ).resolves.toEqual({ kind: 'busy' });
    regeneration.release();
    await expect(
      runSceneInsertion(
        {
          stageId: STAGE,
          request,
          localGenerationRunning: false,
          gateRunning: [{ kind: 'regeneration', id: 'tsr-1', sceneId: 's2' }],
        },
        { fetchImpl: impl },
      ),
    ).resolves.toEqual({ kind: 'busy' });
    expect(calls).toHaveLength(0);
    expect(isStageEditingLocked(STAGE)).toBe(false);
  });
});
