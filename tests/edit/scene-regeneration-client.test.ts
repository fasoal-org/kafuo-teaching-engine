import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave, loadStageData } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: (...args: unknown[]) => loadStageData(...args),
}));

import { runSlideRegeneration } from '@/lib/edit/scene-regeneration-client';
import { migrateScene } from '@/lib/edit/slide-schema';
import {
  bindStageSceneRevs,
  clearStageSceneRevs,
  sceneRev,
} from '@/lib/persistence/scene-revision-registry';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * AT-C (single-slide-regeneration-plan §12.3–§12.4): the browser sequence
 * lock → drain → hold → POST → settle → apply → release, with DB X ==
 * displayed X asserted after every outcome. `fetch` is the server stub.
 */

const STAGE = 'stage-1';
const stage = (): Stage => ({ id: STAGE, name: STAGE, createdAt: 1, updatedAt: 1 });
const scene = (id: string, title = id, order = 1): Scene => ({
  id,
  stageId: STAGE,
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

interface FakeServer {
  db: { scene: Scene; rev: number };
  posts: number;
  fetch: typeof fetch;
}

function server(
  options: {
    onPost?: (db: FakeServer['db']) => Response | Promise<Response>;
    afterPost?: (db: FakeServer['db']) => void;
  } = {},
): FakeServer {
  const state: FakeServer = {
    db: { scene: scene('scene-1', 'original'), rev: 3 },
    posts: 0,
    fetch: vi.fn(),
  };
  state.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/regenerate') && init?.method === 'POST') {
      state.posts += 1;
      if (options.onPost) return options.onPost(state.db);
      state.db = { scene: scene('scene-1', 'regenerated'), rev: state.db.rev + 1 };
      const result = { scene: state.db.scene, rev: state.db.rev };
      options.afterPost?.(state.db);
      return Response.json({
        regenerationId: 'tsr-1',
        status: 'succeeded',
        replayed: false,
        sceneId: 'scene-1',
        scene: result.scene,
        resultSceneRev: result.rev,
        current: { rev: state.db.rev, scene: state.db.scene },
      });
    }
    if (href.includes('/scene-regenerations/')) {
      return Response.json({
        regenerationId: 'tsr-1',
        sceneId: 'scene-1',
        status: 'succeeded',
        errorCode: null,
        resultSceneRev: 4,
        scene: scene('scene-1', 'regenerated'),
        current: { rev: state.db.rev, scene: state.db.scene },
      });
    }
    throw new Error(`unexpected ${href}`);
  }) as typeof fetch;
  return state;
}

const input = {
  stageId: STAGE,
  sceneId: 'scene-1',
  instruction: 'make it simpler please',
  reason: 'wrong formula',
  idempotencyKey: 'key-12345678',
};

function displayed(): Scene | undefined {
  return useStageStore.getState().scenes.find((entry) => entry.id === 'scene-1');
}

beforeEach(() => {
  incrementalSave.mockReset().mockResolvedValue(undefined);
  loadStageData.mockReset().mockResolvedValue(null);
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stage(),
    scenes: [scene('scene-1', 'original', 1), scene('scene-2', 'two', 2)],
    currentSceneId: 'scene-1',
    chats: [],
  });
  bindStageSceneRevs(STAGE, { 'scene-1': 3, 'scene-2': 5 });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  clearStageSceneRevs();
});

describe('runSlideRegeneration', () => {
  it('flushes a pending edit before the POST, then shows exactly the DB copy with a success', async () => {
    const order: string[] = [];
    incrementalSave.mockImplementation(async () => {
      order.push('save');
    });
    const fake = server();
    const wrapped = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/regenerate')) order.push('post');
      return fake.fetch(url, init);
    }) as typeof fetch;
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });
    const outcome = await runSlideRegeneration(input, { fetchImpl: wrapped });
    expect(order).toEqual(['save', 'post']);
    expect(outcome).toEqual({ kind: 'success', regenerationId: 'tsr-1' });
    expect(displayed()).toEqual(migrateScene(fake.db.scene));
    expect(sceneRev(STAGE, 'scene-1')).toBe(fake.db.rev);
  });

  it('a flush failure sends no POST', async () => {
    incrementalSave.mockRejectedValue(new Error('offline'));
    const fake = server();
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });
    const outcome = await runSlideRegeneration(input, { fetchImpl: fake.fetch });
    expect(outcome).toEqual({ kind: 'not-durable' });
    expect(fake.posts).toBe(0);
  });

  it('a structure edit during the run is held, then written after release', async () => {
    const fake = server({
      afterPost: () => {
        useStageStore.getState().addScene(scene('scene-3', 'three', 3));
      },
    });
    const outcome = await runSlideRegeneration(input, { fetchImpl: fake.fetch });
    expect(outcome.kind).toBe('success');
    // Held while the barrier was up: nothing was written during the run.
    expect(incrementalSave).not.toHaveBeenCalled();
    await new Promise((settle) => setTimeout(settle, 700));
    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'structure' }]);
  });

  it('the slide changed again since the regeneration: no success, the current copy is shown', async () => {
    const fake = server({
      afterPost: (db) => {
        db.scene = scene('scene-1', 'edited elsewhere');
        db.rev += 1;
      },
    });
    const outcome = await runSlideRegeneration(input, { fetchImpl: fake.fetch });
    expect(outcome).toEqual({ kind: 'changed-since', regenerationId: 'tsr-1' });
    expect(displayed()).toEqual(migrateScene(fake.db.scene));
  });

  it('409 SCENE_CHANGED_DURING_REGENERATION: no success, the server copy is shown', async () => {
    loadStageData.mockResolvedValue({
      stage: stage(),
      scenes: [scene('scene-1', 'editor wins', 1), scene('scene-2', 'two', 2)],
      currentSceneId: 'scene-1',
      chats: [],
      sceneRevs: { 'scene-1': 4, 'scene-2': 5 },
    });
    const fake = server({
      onPost: () =>
        Response.json(
          { error: { code: 'SCENE_CHANGED_DURING_REGENERATION', message: 'changed' } },
          { status: 409 },
        ),
    });
    const outcome = await runSlideRegeneration(input, { fetchImpl: fake.fetch });
    expect(outcome).toMatchObject({
      kind: 'failed',
      status: 409,
      code: 'SCENE_CHANGED_DURING_REGENERATION',
    });
    expect(displayed()?.title).toBe('editor wins');
    expect(sceneRev(STAGE, 'scene-1')).toBe(4);
  });

  it('a late answer after the editor moved to another Stage is not applied', async () => {
    const fake = server({
      afterPost: () => {
        useStageStore.getState().clearStore();
        useStageStore.setState({ stage: { ...stage(), id: 'stage-2' }, scenes: [], chats: [] });
      },
    });
    const outcome = await runSlideRegeneration(input, { fetchImpl: fake.fetch });
    expect(outcome).toEqual({ kind: 'stale' });
    expect(useStageStore.getState().scenes).toEqual([]);
  });

  it('a transport failure retries with the SAME key', async () => {
    const fake = server();
    let failures = 1;
    const keys: string[] = [];
    const flaky = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/regenerate')) {
        keys.push(JSON.parse(String(init?.body)).idempotencyKey);
        if (failures-- > 0) throw new TypeError('network down');
      }
      return fake.fetch(url, init);
    }) as typeof fetch;
    const outcome = await runSlideRegeneration(input, { fetchImpl: flaky });
    expect(outcome.kind).toBe('success');
    expect(keys).toEqual(['key-12345678', 'key-12345678']);
  });
});
