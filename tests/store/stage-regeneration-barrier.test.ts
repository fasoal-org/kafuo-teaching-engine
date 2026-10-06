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

import {
  bindStageSceneRevs,
  clearStageSceneRevs,
  sceneRev,
  stageSceneRevs,
} from '@/lib/persistence/scene-revision-registry';
import {
  beginSceneRegeneration,
  flushStageSave,
  isSceneDurable,
  onStageSaveConflict,
  replaceSceneFromServer,
  useStageStore,
  type StageSaveConflict,
} from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * Single-slide-regeneration-plan §11.5 + §12.3 (AT-RV 5/10, AT-C): the store
 * side of revision conflicts and of the regeneration lock / barrier.
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

function conflictError(status: 409 | 428, sceneIds: string[] = []) {
  return Object.assign(new Error('refused'), {
    status,
    code: status === 409 ? 'SCENE_REVISION_CONFLICT' : 'PRECONDITION_REQUIRED',
    details: { scenes: sceneIds.map((id) => ({ id, currentRev: 9 })) },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue(undefined);
  loadStageData.mockReset().mockResolvedValue(null);
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stage(),
    scenes: [scene('scene-1', 'one', 1), scene('scene-2', 'two', 2)],
    currentSceneId: 'scene-1',
    chats: [],
  });
  bindStageSceneRevs(STAGE, { 'scene-1': 3, 'scene-2': 5 });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  clearStageSceneRevs();
  vi.useRealTimers();
});

describe('revision conflicts in the autosave (§11.5)', () => {
  it('a 409 for one scene replaces it with the server copy, drops only its dirt, and notifies once', async () => {
    const conflicts: StageSaveConflict[] = [];
    const unsubscribe = onStageSaveConflict((conflict) => conflicts.push(conflict));
    loadStageData.mockResolvedValue({
      stage: stage(),
      scenes: [scene('scene-1', 'from server', 1), scene('scene-2', 'two', 2)],
      currentSceneId: 'scene-1',
      chats: [],
      sceneRevs: { 'scene-1': 9, 'scene-2': 5 },
    });
    incrementalSave.mockRejectedValueOnce(conflictError(409, ['scene-1']));
    useStageStore.getState().updateScene('scene-1', { title: 'local edit' });
    await flushStageSave();
    expect(incrementalSave).toHaveBeenCalledOnce();
    const shown = useStageStore.getState().scenes.find((entry) => entry.id === 'scene-1');
    expect(shown?.title).toBe('from server');
    expect(sceneRev(STAGE, 'scene-1')).toBe(9);
    expect(sceneRev(STAGE, 'scene-2')).toBe(5);
    expect(conflicts).toEqual([
      { stageId: STAGE, code: 'SCENE_REVISION_CONFLICT', sceneIds: ['scene-1'] },
    ]);
    // Not retried as-is: the dirt for scene-1 is gone.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(isSceneDurable(STAGE, 'scene-1')).toBe(true);
    unsubscribe();
  });

  it('other pending changes stay queued and are written after the reconcile', async () => {
    loadStageData.mockResolvedValue({
      stage: stage(),
      scenes: [scene('scene-1', 'from server', 1), scene('scene-2', 'two', 2)],
      currentSceneId: 'scene-1',
      chats: [],
      sceneRevs: { 'scene-1': 9, 'scene-2': 5 },
    });
    incrementalSave.mockImplementationOnce(async () => {
      // scene-2 is edited while the failing round is in flight.
      useStageStore.getState().updateScene('scene-2', { title: 'later edit' });
      throw conflictError(409, ['scene-1']);
    });
    useStageStore.getState().updateScene('scene-1', { title: 'local edit' });
    await flushStageSave().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(incrementalSave).toHaveBeenCalledTimes(2);
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-2' }]);
  });

  it('a 428 re-reads the whole stage, rebinds every revision and drops the document dirt', async () => {
    const conflicts: StageSaveConflict[] = [];
    const unsubscribe = onStageSaveConflict((conflict) => conflicts.push(conflict));
    loadStageData.mockResolvedValue({
      stage: stage(),
      scenes: [scene('scene-1', 'server one', 1)],
      currentSceneId: 'scene-1',
      chats: [],
      sceneRevs: { 'scene-1': 11 },
    });
    incrementalSave.mockRejectedValueOnce(conflictError(428));
    useStageStore.getState().updateScene('scene-2', { title: 'local' });
    await flushStageSave();
    expect(useStageStore.getState().scenes.map((entry) => entry.title)).toEqual(['server one']);
    expect(stageSceneRevs(STAGE)).toEqual({ 'scene-1': 11 });
    expect(conflicts[0]).toMatchObject({ code: 'PRECONDITION_REQUIRED' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

describe('the regeneration lock and barrier (§12.3)', () => {
  it('a pending edit makes the scene not durable; a successful drain makes it durable', async () => {
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });
    expect(isSceneDurable(STAGE, 'scene-1')).toBe(false);
    expect(isSceneDurable(STAGE, 'scene-2')).toBe(true);
    await flushStageSave();
    expect(isSceneDurable(STAGE, 'scene-1')).toBe(true);
  });

  it('a structure change makes every scene not durable (the whole document is rewritten)', () => {
    useStageStore.getState().addScene(scene('scene-3', 'three', 3));
    expect(isSceneDurable(STAGE, 'scene-1')).toBe(false);
  });

  it('a failed drain leaves the scene not durable (no POST may follow)', async () => {
    incrementalSave.mockRejectedValue(new Error('offline'));
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });
    await flushStageSave().catch(() => {});
    expect(isSceneDurable(STAGE, 'scene-1')).toBe(false);
  });

  it('holding writes stops every flush; release writes the held edit with no further mutation', async () => {
    const handle = beginSceneRegeneration(STAGE, 'scene-1');
    handle.holdWrites();
    useStageStore.getState().addScene(scene('scene-3', 'three', 3));
    await flushStageSave();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    handle.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'structure' }]);
  });

  it('the lock alone does not hold the pre-submit drain', async () => {
    const handle = beginSceneRegeneration(STAGE, 'scene-1');
    useStageStore.getState().updateScene('scene-1', { title: 'drain me' });
    await flushStageSave();
    expect(incrementalSave).toHaveBeenCalledOnce();
    handle.release();
  });

  it('replaceSceneFromServer applies without dirt, drops the pending write, keeps the selection, records the rev', async () => {
    useStageStore.getState().updateScene('scene-1', { title: 'stale local' });
    useStageStore.setState({ currentSceneId: 'scene-2' });
    const applied = replaceSceneFromServer(STAGE, scene('scene-1', 'regenerated', 1), 4);
    expect(applied?.title).toBe('regenerated');
    const state = useStageStore.getState();
    expect(state.scenes.find((entry) => entry.id === 'scene-1')).toBe(applied);
    expect(state.currentSceneId).toBe('scene-2');
    expect(sceneRev(STAGE, 'scene-1')).toBe(4);
    expect(isSceneDurable(STAGE, 'scene-1')).toBe(true);
    await flushStageSave();
    expect(incrementalSave).not.toHaveBeenCalled();
  });
});
