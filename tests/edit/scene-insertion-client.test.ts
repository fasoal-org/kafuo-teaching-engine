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
  INSERTION_ADMISSION_WINDOW_MS,
  INSERTION_CLOCK_MARGIN_MS,
  INSERTION_MAX_LEASE_MS,
  INSERTION_RELEASE_GRACE_MS,
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

/** The server clock the stubs report (server time, ms). */
const SERVER_NOW = 5_000_000;

/** The TE's own by-key 404: no row, `serverNow` read under the Stage lock. */
const absentByKey = (serverNow: number) =>
  Response.json(
    { error: { code: 'INSERTION_NOT_FOUND', message: 'not found', details: { serverNow } } },
    { status: 404 },
  );

function fetchRouter(routes: { post?: Route; status?: Route; key?: Route; gate?: Route }) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/scene-insertions')) {
      return (routes.post ?? (() => Response.json({ insertion: succeeded })))(init);
    }
    if (url.includes('/scene-insertions?key=')) {
      // Default: no row yet, admission still open.
      return (routes.key ?? (() => absentByKey(SERVER_NOW)))(init);
    }
    if (url.includes('/scene-insertions/')) {
      return (routes.status ?? (() => Response.json(succeeded)))(init);
    }
    if (url.endsWith('/scene-insertion')) {
      return (
        routes.gate ??
        (() =>
          Response.json({
            capability: 'write',
            editable: true,
            versionStatus: 'draft',
            supported: true,
            unsupportedReason: null,
            running: [],
            serverNow: SERVER_NOW,
          }))
      )(init);
    }
    return new Response('not found', { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/**
 * A fake monotonic clock and pause: no real lease is waited through. Every
 * pause records whether the Stage was still held at that moment.
 */
function fakeTime() {
  let now = 0;
  const heldAtPause: boolean[] = [];
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      heldAtPause.push(isStageWritesHeld(STAGE));
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    /** Server time moves with the fake clock (same rate). */
    serverNow: () => SERVER_NOW + now,
    heldAtPause,
  };
}

const runningStatus = { ...succeeded, status: 'running' as const, revTransitions: null };
const parsedBody = (init?: RequestInit) =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

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

  it('a row that never settles holds until it can no longer commit, then unknown — never earlier', async () => {
    const time = fakeTime();
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: runningStatus }, { status: 202 }),
      status: () => Response.json(runningStatus),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, clock: time.clock, sleep: time.sleep },
    );
    expect(outcome).toEqual({ kind: 'unknown', insertionId: 'tpsi_1' });
    // Released only past window + longest lease + grace, held at every pause.
    expect(time.now()).toBeGreaterThanOrEqual(
      INSERTION_ADMISSION_WINDOW_MS + INSERTION_MAX_LEASE_MS + INSERTION_RELEASE_GRACE_MS,
    );
    expect(time.heldAtPause.length).toBeGreaterThan(0);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
    expect(isStageWritesHeld(STAGE)).toBe(false);
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

  it('gateway answers until the window closes: failed only once the server attests no run can start', async () => {
    const time = fakeTime();
    const { impl, calls } = fetchRouter({
      post: () => new Response('bad gateway', { status: 502 }),
      key: () => absentByKey(time.serverNow()),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, clock: time.clock, sleep: time.sleep },
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'INSERTION_ADMISSION_CLOSED' });
    // Retries stopped at the window; the release waited for the server's word,
    // a clock margin past the deadline.
    expect(time.now()).toBeGreaterThan(INSERTION_ADMISSION_WINDOW_MS + INSERTION_CLOCK_MARGIN_MS);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
    const lastPost = calls.map((call) => call.method).lastIndexOf('POST');
    expect(calls.slice(lastPost + 1).every((call) => call.method === 'GET')).toBe(true);
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

  it('a long run is polled by id to its end, holding throughout, without another POST', async () => {
    const time = fakeTime();
    const { impl, calls } = fetchRouter({
      post: () => Response.json({ insertion: runningStatus, replayed: true }, { status: 202 }),
      // Commits 15 minutes in.
      status: () => Response.json(time.now() < 15 * 60_000 ? runningStatus : succeeded),
    });
    const outcome = await runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, clock: time.clock, sleep: time.sleep },
    );
    expect(outcome).toMatchObject({ kind: 'success', applied: 'applied' });
    expect(time.now()).toBeGreaterThanOrEqual(15 * 60_000);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
    expect(posts(calls)).toHaveLength(1);
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

  it('the release bound covers the server’s longest lease and fits its admission window', async () => {
    const { MAX_SCENE_INSERTION_LEASE_SECONDS, sceneInsertionLeaseSeconds } =
      await import('@/lib/server/teaching-package/scene-insertion-store');
    const { SCENE_INSERTION_MAX_ADMISSION_WINDOW_MS } =
      await import('@/lib/server/teaching-package/scene-insertion');
    expect(INSERTION_MAX_LEASE_MS).toBe(MAX_SCENE_INSERTION_LEASE_SECONDS * 1000);
    expect(INSERTION_ADMISSION_WINDOW_MS).toBeLessThanOrEqual(
      SCENE_INSERTION_MAX_ADMISSION_WINDOW_MS,
    );
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

describe('scene insertion client — admission and settling (step 8)', () => {
  const run = (impl: typeof fetch, time: ReturnType<typeof fakeTime>) =>
    runSceneInsertion(
      { stageId: STAGE, request, localGenerationRunning: false },
      { fetchImpl: impl, clock: time.clock, sleep: time.sleep },
    );

  it('earlier POSTs never reach the server; a late accepted POST loses its answer → settled by key, held to the end', async () => {
    const time = fakeTime();
    let admittedAt: number | null = null;
    const bodies: Array<Record<string, unknown>> = [];
    const { impl } = fetchRouter({
      post: (init) => {
        bodies.push(parsedBody(init));
        // Attempts until the last 10 s of the window never reach the TE…
        if (time.now() < INSERTION_ADMISSION_WINDOW_MS - 10_000) throw new TypeError('offline');
        // …this one does: admitted (server time before admitBy), its answer lost.
        admittedAt ??= time.now();
        throw new TypeError('connection reset');
      },
      key: () =>
        admittedAt === null ? absentByKey(time.serverNow()) : Response.json(runningStatus),
      // Its run commits 14 minutes after admission.
      status: () =>
        Response.json(
          admittedAt !== null && time.now() >= admittedAt + 14 * 60_000 ? succeeded : runningStatus,
        ),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success', applied: 'applied' });
    expect(admittedAt).not.toBeNull();
    // Never released before the late run committed.
    expect(time.now()).toBeGreaterThanOrEqual(admittedAt! + 14 * 60_000);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
    // One exact body on every attempt: same key, same server-time deadline.
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toMatchObject({
      idempotencyKey: request.idempotencyKey,
      admitBy: SERVER_NOW + INSERTION_ADMISSION_WINDOW_MS,
    });
    expect(isStageWritesHeld(STAGE)).toBe(false);
  });

  it('a request still waiting for the Stage lock after its POST timed out starts later — the hold waits for it', async () => {
    const time = fakeTime();
    const { impl } = fetchRouter({
      // The request reached the TE and waits on the lock; the client cuts it.
      post: () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
      // It takes the lock 90 s in (before admitBy) and starts its run.
      key: () =>
        time.now() >= 90_000 ? Response.json(runningStatus) : absentByKey(time.serverNow()),
      status: () => Response.json(time.now() >= 10 * 60_000 ? succeeded : runningStatus),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(time.now()).toBeGreaterThanOrEqual(10 * 60_000);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('offline once the POST left: held until nothing of it can still commit, then unknown', async () => {
    const time = fakeTime();
    const { impl, calls } = fetchRouter({
      post: () => {
        throw new TypeError('offline');
      },
      key: () => {
        throw new TypeError('offline');
      },
    });
    const outcome = await run(impl, time);
    expect(outcome).toEqual({ kind: 'unknown', insertionId: null });
    expect(time.now()).toBeGreaterThanOrEqual(
      INSERTION_ADMISSION_WINDOW_MS + INSERTION_MAX_LEASE_MS + INSERTION_RELEASE_GRACE_MS,
    );
    expect(time.heldAtPause.every(Boolean)).toBe(true);
    // POSTs only inside the window; key reads after it.
    expect(posts(calls).length).toBeGreaterThan(1);
    expect(isStageWritesHeld(STAGE)).toBe(false);
  });

  it('a truncated 202 body is ambiguous: the key settles it, without a second POST', async () => {
    const time = fakeTime();
    const { impl, calls } = fetchRouter({
      post: () =>
        new Response('{"insertion":{"insertionId":"tpsi_1","sta', {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      key: () => Response.json(runningStatus),
      status: () => Response.json(succeeded),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success', insertionId: 'tpsi_1' });
    expect(posts(calls)).toHaveLength(1);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('a 202 whose body read is interrupted is ambiguous too', async () => {
    const time = fakeTime();
    const cut = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"insertion":{"insertionId":'));
          controller.error(new TypeError('terminated'));
        },
      });
    const { impl } = fetchRouter({
      post: () => new Response(cut(), { status: 202 }),
      key: () => Response.json(runningStatus),
      status: () => Response.json(succeeded),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it.each([
    ['a foreign success body', { ok: true }],
    ['an empty insertion', { insertion: {} }],
    [
      'a success without its Scene id',
      { insertion: { insertionId: 'tpsi_1', status: 'succeeded' } },
    ],
  ])('%s is ambiguous: the same key and body are re-sent, never a failure', async (_label, bad) => {
    const time = fakeTime();
    const bodies: string[] = [];
    const { impl } = fetchRouter({
      post: (init) => {
        bodies.push(String(init?.body));
        return bodies.length === 1 ? Response.json(bad) : Response.json({ insertion: succeeded });
      },
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success', sceneId: NEW });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('same-key recovery reaching a stored failure reports it; nothing is applied', async () => {
    const time = fakeTime();
    const { impl } = fetchRouter({
      post: () => {
        throw new TypeError('connection reset');
      },
      key: () =>
        Response.json({
          ...succeeded,
          status: 'failed',
          errorCode: 'INSERTION_PLAN_INVALID',
          scene: null,
          revTransitions: null,
        }),
    });
    const before = JSON.stringify(useStageStore.getState().scenes);
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'INSERTION_PLAN_INVALID' });
    expect(loadStageData).not.toHaveBeenCalled();
    expect(JSON.stringify(useStageStore.getState().scenes)).toBe(before);
  });

  it('a refusal of a LATER attempt waits for the key: the earlier attempt may still start (and does)', async () => {
    const time = fakeTime();
    let attempts = 0;
    const { impl, calls } = fetchRouter({
      post: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('connection reset');
        return Response.json(
          { error: { code: 'STAGE_GENERATION_IN_PROGRESS', message: 'a regeneration runs' } },
          { status: 409 },
        );
      },
      // The first attempt was waiting behind that regeneration; it starts 30 s in.
      key: () =>
        time.now() < 30_000 ? absentByKey(time.serverNow()) : Response.json(runningStatus),
      status: () => Response.json(succeeded),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success' });
    // No POST after the refusal.
    expect(posts(calls)).toHaveLength(2);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('…and when the key stays empty past the deadline, that refusal is reported', async () => {
    const time = fakeTime();
    let attempts = 0;
    const { impl } = fetchRouter({
      post: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('connection reset');
        return Response.json(
          { error: { code: 'STAGE_GENERATION_IN_PROGRESS', message: 'a regeneration runs' } },
          { status: 409 },
        );
      },
      key: () => absentByKey(time.serverNow()),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'STAGE_GENERATION_IN_PROGRESS' });
    expect(time.now()).toBeGreaterThan(INSERTION_ADMISSION_WINDOW_MS);
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('a LATER attempt’s INSERTION_ADMISSION_CLOSED still waits for the key, past the clock margin', async () => {
    const time = fakeTime();
    let attempts = 0;
    const { impl } = fetchRouter({
      post: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('connection reset');
        return Response.json(
          { error: { code: 'INSERTION_ADMISSION_CLOSED', message: 'too late' } },
          { status: 409 },
        );
      },
      key: () => absentByKey(time.serverNow()),
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'INSERTION_ADMISSION_CLOSED' });
    expect(attempts).toBe(2);
    // Trusted only once the server's clock is a margin past the deadline.
    expect(time.serverNow()).toBeGreaterThan(
      SERVER_NOW + INSERTION_ADMISSION_WINDOW_MS + INSERTION_CLOCK_MARGIN_MS,
    );
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('IDEMPOTENCY_KEY_REUSED is definite on any attempt (ours can never start under that key)', async () => {
    const time = fakeTime();
    let attempts = 0;
    const { impl } = fetchRouter({
      post: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('connection reset');
        return Response.json(
          { error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'another request' } },
          { status: 409 },
        );
      },
    });
    expect(await run(impl, time)).toMatchObject({
      kind: 'failed',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(attempts).toBe(2);
  });

  it('a code-less 4xx status line on the only POST is its refusal — no long hold', async () => {
    const time = fakeTime();
    const { impl, calls } = fetchRouter({
      post: () => new Response('Not found', { status: 404 }),
    });
    expect(await run(impl, time)).toMatchObject({ kind: 'failed', status: 404, code: 'NOT_FOUND' });
    expect(posts(calls)).toHaveLength(1);
    expect(time.now()).toBe(0);
  });

  it.each([408, 429])(
    'a code-less %i is a gateway’s: ambiguous, the same body is re-sent',
    async (code) => {
      const time = fakeTime();
      const bodies: string[] = [];
      const { impl } = fetchRouter({
        post: (init) => {
          bodies.push(String(init?.body));
          return bodies.length === 1
            ? new Response('slow down', { status: code })
            : Response.json({ insertion: succeeded });
        },
      });
      expect(await run(impl, time)).toMatchObject({ kind: 'success' });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    },
  );

  it('a by-key 404 without a server clock never settles the key', async () => {
    const time = fakeTime();
    const { impl } = fetchRouter({
      post: () => {
        throw new TypeError('offline');
      },
      key: () =>
        Response.json({ error: { code: 'INSERTION_NOT_FOUND', message: 'no' } }, { status: 404 }),
    });
    expect(await run(impl, time)).toEqual({ kind: 'unknown', insertionId: null });
    expect(time.now()).toBeGreaterThanOrEqual(
      INSERTION_ADMISSION_WINDOW_MS + INSERTION_MAX_LEASE_MS + INSERTION_RELEASE_GRACE_MS,
    );
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('past the release bound, one last read still settles: by key (a run that committed late)…', async () => {
    const time = fakeTime();
    const releaseAt =
      INSERTION_ADMISSION_WINDOW_MS + INSERTION_MAX_LEASE_MS + INSERTION_RELEASE_GRACE_MS;
    const { impl } = fetchRouter({
      post: () => {
        throw new TypeError('offline');
      },
      key: () => {
        if (time.now() < releaseAt) throw new TypeError('offline');
        return Response.json(succeeded);
      },
    });
    expect(await run(impl, time)).toMatchObject({ kind: 'success', applied: 'applied' });
  });

  it('…and by id (the lazy reclaim settles an expired lease as a failure)', async () => {
    const time = fakeTime();
    const releaseAt =
      INSERTION_ADMISSION_WINDOW_MS + INSERTION_MAX_LEASE_MS + INSERTION_RELEASE_GRACE_MS;
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: runningStatus, replayed: true }, { status: 202 }),
      status: () =>
        time.now() < releaseAt
          ? Response.json(runningStatus)
          : Response.json({ ...runningStatus, status: 'failed', errorCode: 'LEASE_EXPIRED' }),
    });
    expect(await run(impl, time)).toMatchObject({ kind: 'failed', code: 'LEASE_EXPIRED' });
    expect(time.heldAtPause.every(Boolean)).toBe(true);
  });

  it('a TE refusal of the status read itself (403 READ_ONLY_GRANT) ends polling as unknown', async () => {
    const time = fakeTime();
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: runningStatus, replayed: true }, { status: 202 }),
      status: () =>
        Response.json(
          { error: { code: 'READ_ONLY_GRANT', message: 'read only' } },
          { status: 403 },
        ),
    });
    expect(await run(impl, time)).toEqual({ kind: 'unknown', insertionId: 'tpsi_1' });
  });

  it('no server clock: nothing is sent, the Stage is released, the key is kept (unknown)', async () => {
    const time = fakeTime();
    const { impl, calls } = fetchRouter({ gate: () => new Response('down', { status: 503 }) });
    const outcome = await run(impl, time);
    expect(outcome).toEqual({ kind: 'unknown', insertionId: null });
    expect(posts(calls)).toHaveLength(0);
    expect(isStageWritesHeld(STAGE)).toBe(false);
  });

  it('a malformed status read is transient and never applied', async () => {
    const time = fakeTime();
    let reads = 0;
    const { impl } = fetchRouter({
      post: () => Response.json({ insertion: runningStatus, replayed: true }, { status: 202 }),
      status: () => {
        reads += 1;
        return reads === 1 ? Response.json({}) : Response.json(succeeded);
      },
    });
    const outcome = await run(impl, time);
    expect(outcome).toMatchObject({ kind: 'success' });
    expect(reads).toBe(2);
    expect(loadStageData).toHaveBeenCalledOnce();
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
