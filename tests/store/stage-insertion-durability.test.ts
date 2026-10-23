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
  bindStageSceneRevs,
  clearStageSceneRevs,
  sceneRev,
} from '@/lib/persistence/scene-revision-registry';
import {
  applyInsertionResult,
  beginStageInsertion,
  documentDirtSince,
  drainStageDocumentWrites,
  flushStageSave,
  hasDirectDocumentSave,
  isStageDocumentDurable,
  isStageEditingLocked,
  isStageWritesHeld,
  markStagePersistenceDirty,
  onStageSaveConflict,
  pendingDocumentRevisionMark,
  pendingStageDocumentKeys,
  peekStageSceneLoadToken,
  restorePendingStageChanges,
  useStageStore,
  type InsertionResultInput,
  type StageSaveConflict,
} from '@/lib/store/stage';
import type { PendingChange } from '@/lib/utils/stage-storage';
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * Reviewer-generated slide plan §5.1 (V2-2, V3-1, V3-2, V3.1-1, V3.1-2): the
 * store half of the insertion's client protocol — Stage-wide durability, the
 * direct-save registry and its hold deferral, the insertion handle, and the
 * synchronous result application over the union of local and server Scenes.
 */

const STAGE = 'stage-ins';
const OTHER = 'stage-other';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function titles(): string[] {
  return useStageStore.getState().scenes.map((entry) => entry.title);
}

function ids(): string[] {
  return useStageStore.getState().scenes.map((entry) => entry.id);
}

/** A prepared insertion: lock → prove → hold → re-prove → baseline. */
function preparedInsertion() {
  const handle = beginStageInsertion(STAGE);
  handle.lock();
  expect(isStageDocumentDurable(STAGE)).toBe(true);
  handle.holdWrites();
  expect(isStageDocumentDurable(STAGE)).toBe(true);
  return { handle, baseline: handle.captureBaseline() };
}

/**
 * The server after the insertion: N inserted after s1, s2 and s3 shifted. The
 * write rewrote every Scene, so every revision moved (before → after).
 */
const NEW = 'scene-new';
function insertionResult(): InsertionResultInput {
  return {
    newSceneId: NEW,
    revTransitions: {
      s1: { before: 1, after: 11 },
      s2: { before: 2, after: 12 },
      s3: { before: 3, after: 13 },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue(undefined);
  aggregateSave.mockReset().mockResolvedValue(undefined);
  loadStageData.mockReset().mockResolvedValue(null);
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stage(),
    scenes: [scene('s1', 'one', 1), scene('s2', 'two', 2), scene('s3', 'three', 3)],
    currentSceneId: 's1',
    chats: [],
  });
  bindStageSceneRevs(STAGE, { s1: 1, s2: 2, s3: 3 });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  clearStageSceneRevs();
  vi.useRealTimers();
});

describe('isStageDocumentDurable (API 3)', () => {
  it.each<[PendingChange, boolean]>([
    [{ kind: 'scene', sceneId: 's2' }, false],
    [{ kind: 'structure' }, false],
    [{ kind: 'stage' }, false],
    [{ kind: 'outline' }, false],
    [{ kind: 'currentScene' }, true],
    [{ kind: 'chats' }, true],
  ])('a pending %o → durable %s', (change, durable) => {
    markStagePersistenceDirty([change]);
    expect(isStageDocumentDurable(STAGE)).toBe(durable);
  });

  it('another Scene’s pending entry blocks the whole Stage', () => {
    useStageStore.getState().updateScene('s3', { title: 'edit' });
    expect(isStageDocumentDurable(STAGE)).toBe(false);
    expect(pendingStageDocumentKeys(STAGE)).toEqual(['scene:s3']);
  });

  it('a flush round in flight blocks until it settles', async () => {
    const save = deferred<undefined>();
    incrementalSave.mockReturnValueOnce(save.promise);
    useStageStore.getState().updateScene('s1', { title: 'edit' });
    const flush = flushStageSave();
    expect(isStageDocumentDurable(STAGE)).toBe(false);
    save.resolve(undefined);
    await flush;
    expect(isStageDocumentDurable(STAGE)).toBe(true);
  });
});

describe('the direct-save registry (API 2, V3-2)', () => {
  it('saveToStorage registers before its first await and unregisters on success', async () => {
    const write = deferred<undefined>();
    aggregateSave.mockReturnValueOnce(write.promise);
    const saving = useStageStore.getState().saveToStorage();
    // Same synchronous turn as the call.
    expect(hasDirectDocumentSave(STAGE)).toBe(true);
    expect(isStageDocumentDurable(STAGE)).toBe(false);
    write.resolve(undefined);
    await expect(saving).resolves.toBe(true);
    expect(hasDirectDocumentSave(STAGE)).toBe(false);
    expect(isStageDocumentDurable(STAGE)).toBe(true);
  });

  it('unregisters on a failed write', async () => {
    aggregateSave.mockRejectedValueOnce(new Error('offline'));
    const saving = useStageStore.getState().saveToStorage();
    expect(hasDirectDocumentSave(STAGE)).toBe(true);
    await expect(saving).resolves.toBe(false);
    expect(hasDirectDocumentSave(STAGE)).toBe(false);
  });

  it('unregisters on a stale drop', async () => {
    aggregateSave.mockResolvedValueOnce('stale-dropped');
    const saving = useStageStore.getState().saveToStorage();
    expect(hasDirectDocumentSave(STAGE)).toBe(true);
    await expect(saving).resolves.toBe(false);
    expect(hasDirectDocumentSave(STAGE)).toBe(false);
  });

  it('drainStageDocumentWrites awaits a direct save already running', async () => {
    const write = deferred<undefined>();
    aggregateSave.mockReturnValueOnce(write.promise);
    void useStageStore.getState().saveToStorage();
    let drained = false;
    const drain = drainStageDocumentWrites(STAGE).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    write.resolve(undefined);
    await drain;
    expect(isStageDocumentDurable(STAGE)).toBe(true);
  });
});

describe('the insertion hold and the saveToStorage deferral (API 5)', () => {
  it('a direct save while held writes nothing, re-marks the full aggregate and returns false', async () => {
    const { handle } = preparedInsertion();
    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(false);
    expect(aggregateSave).not.toHaveBeenCalled();
    expect(hasDirectDocumentSave(STAGE)).toBe(false);
    expect(pendingStageDocumentKeys(STAGE).sort()).toEqual(
      ['outline', 'scene:s1', 'scene:s2', 'scene:s3', 'stage', 'structure'].sort(),
    );
    // Held: the scheduler starts no round.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    handle.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(incrementalSave).toHaveBeenCalledOnce();
    const written = (incrementalSave.mock.calls[0]![1] as PendingChange[]).map((change) =>
      change.kind === 'scene' ? `scene:${change.sceneId}` : change.kind,
    );
    expect(written.sort()).toEqual(
      [
        'chats',
        'currentScene',
        'outline',
        'scene:s1',
        'scene:s2',
        'scene:s3',
        'stage',
        'structure',
      ].sort(),
    );
  });

  it('outside a hold saveToStorage writes as before', async () => {
    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(true);
    expect(aggregateSave).toHaveBeenCalledOnce();
  });

  it('the failed-deletion restore marks the same full-aggregate descriptor set', async () => {
    restorePendingStageChanges(STAGE, []);
    await flushStageSave();
    const written = (incrementalSave.mock.calls[0]![1] as PendingChange[]).map((change) =>
      change.kind === 'scene' ? `scene:${change.sceneId}` : change.kind,
    );
    expect(written.sort()).toEqual(
      [
        'chats',
        'currentScene',
        'outline',
        'scene:s1',
        'scene:s2',
        'scene:s3',
        'stage',
        'structure',
      ].sort(),
    );
  });
});

describe('the insertion handle (API 6–8)', () => {
  it('lock, hold and release', async () => {
    const handle = beginStageInsertion(STAGE);
    handle.lock();
    expect(isStageEditingLocked(STAGE)).toBe(true);
    expect(isStageWritesHeld(STAGE)).toBe(false);
    handle.holdWrites();
    expect(isStageWritesHeld(STAGE)).toBe(true);
    useStageStore.getState().updateScene('s1', { title: 'held edit' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    handle.release();
    expect(isStageEditingLocked(STAGE)).toBe(false);
    expect(isStageWritesHeld(STAGE)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(incrementalSave).toHaveBeenCalledOnce();
  });

  it('documentDirtSince is computed at call time', () => {
    const mark = pendingDocumentRevisionMark();
    expect(documentDirtSince(STAGE, mark)).toEqual([]);
    useStageStore.getState().updateScene('s2', { title: 'later' });
    markStagePersistenceDirty([{ kind: 'chats' }]);
    expect(documentDirtSince(STAGE, mark)).toEqual(['scene:s2']);
  });

  it('isCurrent: released, superseded, Stage switch and load-token change', () => {
    const released = beginStageInsertion(STAGE);
    released.release();
    expect(released.isCurrent()).toBe(false);

    const superseded = beginStageInsertion(STAGE);
    const newer = beginStageInsertion(STAGE);
    expect(superseded.isCurrent()).toBe(false);
    expect(newer.isCurrent()).toBe(true);
    newer.release();

    const reloaded = beginStageInsertion(STAGE);
    const before = peekStageSceneLoadToken();
    useStageStore.getState().clearStore();
    expect(peekStageSceneLoadToken()).toBe(before + 1);
    expect(reloaded.isCurrent()).toBe(false);
    reloaded.release();
  });
});

describe('applyInsertionResult (API 9, V3-1)', () => {
  const serverAfterInsertion = (overrides: Partial<Record<string, Scene | null>> = {}) => {
    const base: Record<string, Scene | null> = {
      s1: scene('s1', 'one', 1),
      [NEW]: scene(NEW, 'generated', 2),
      s2: scene('s2', 'two', 3),
      s3: scene('s3', 'three', 4),
      ...overrides,
    };
    const scenes = Object.values(base).filter((entry): entry is Scene => entry !== null);
    const revs: Record<string, number> = { s1: 11, [NEW]: 20, s2: 12, s3: 13 };
    for (const [id, value] of Object.entries(base)) if (value === null) delete revs[id];
    return { scenes, sceneRevs: revs };
  };

  it('is synchronous', () => {
    const { handle, baseline } = preparedInsertion();
    const outcome = applyInsertionResult(
      handle,
      serverAfterInsertion(),
      baseline,
      insertionResult(),
    );
    expect(typeof outcome).toBe('string');
    handle.release();
  });

  it('a clean Stage: applies the server Scenes, binds every revision and selects the new slide', () => {
    const { handle, baseline } = preparedInsertion();
    expect(applyInsertionResult(handle, serverAfterInsertion(), baseline, insertionResult())).toBe(
      'applied',
    );
    expect(ids()).toEqual(['s1', NEW, 's2', 's3']);
    expect(useStageStore.getState().currentSceneId).toBe(NEW);
    expect([sceneRev(STAGE, 's1'), sceneRev(STAGE, NEW), sceneRev(STAGE, 's3')]).toEqual([
      11, 20, 13,
    ]);
    handle.release();
  });

  it('a stale handle discards the response: no state change, no binding', () => {
    const { handle, baseline } = preparedInsertion();
    handle.release();
    expect(applyInsertionResult(handle, serverAfterInsertion(), baseline, insertionResult())).toBe(
      'stale',
    );
    expect(ids()).toEqual(['s1', 's2', 's3']);
    expect(sceneRev(STAGE, 's1')).toBe(1);
  });

  it('no proven revisions → unbound, nothing changes', () => {
    const { handle, baseline } = preparedInsertion();
    const { scenes } = serverAfterInsertion();
    expect(applyInsertionResult(handle, { scenes }, baseline, insertionResult())).toBe('unbound');
    expect(ids()).toEqual(['s1', 's2', 's3']);
    handle.release();
  });

  it('a mutation that lands during the clean-path fetch is kept (merged, not replaced)', () => {
    const { handle, baseline } = preparedInsertion();
    // Arrives while `loadStageData` is awaited (it bypassed the editing lock).
    useStageStore.getState().updateScene('s2', { title: 'edited during fetch' });
    expect(applyInsertionResult(handle, serverAfterInsertion(), baseline, insertionResult())).toBe(
      'merged',
    );
    expect(titles()).toEqual(['one', 'generated', 'edited during fetch', 'three']);
    expect(useStageStore.getState().scenes[2]!.order).toBe(3);
    // Only the insertion's shift touched s2 on the server: rebound, and the
    // pending entry stays so the next save writes the edit on top.
    expect(sceneRev(STAGE, 's2')).toBe(12);
    expect(documentDirtSince(STAGE, baseline.mark)).toEqual(['scene:s2']);
    handle.release();
  });

  it('keys are recomputed after the fetch: a second edit during the fetch is kept too', () => {
    const { handle, baseline } = preparedInsertion();
    useStageStore.getState().updateScene('s1', { title: 'first edit' });
    // ...the fetch starts; then a second edit arrives before it returns.
    useStageStore.getState().updateScene('s3', { title: 'second edit' });
    expect(applyInsertionResult(handle, serverAfterInsertion(), baseline, insertionResult())).toBe(
      'merged',
    );
    expect(titles()).toEqual(['first edit', 'generated', 'two', 'second edit']);
    handle.release();
  });

  it('a Scene another tab also changed keeps the local edit and its OLD expectation', () => {
    const { handle, baseline } = preparedInsertion();
    useStageStore.getState().updateScene('s2', { title: 'local' });
    // Another writer changed s2 after the insertion's write (12 → 15).
    const server = serverAfterInsertion({ s2: scene('s2', 'other tab', 3) });
    server.sceneRevs.s2 = 15;
    expect(applyInsertionResult(handle, server, baseline, insertionResult())).toBe('merged');
    expect(titles()[2]).toBe('local');
    expect(sceneRev(STAGE, 's2')).toBe(2);
    handle.release();
  });

  it('navigating away during the fetch → stale; the departing dirt keeps the departure-save path (V3.1-2)', async () => {
    const { handle, baseline } = preparedInsertion();
    // Held dirt: a mutation that bypassed the lock.
    useStageStore.getState().updateScene('s2', { title: 'held edit' });
    useStageStore.getState().setStage(stage(OTHER));
    expect(handle.isCurrent()).toBe(false);
    // The departure write runs under its existing semantics (it is not part
    // of the insertion's no-write invariant).
    await vi.waitFor(() =>
      expect(incrementalSave.mock.calls.some((call) => call[0] === STAGE)).toBe(true),
    );
    const departure = incrementalSave.mock.calls.find((call) => call[0] === STAGE);
    expect(departure![1]).toEqual([{ kind: 'scene', sceneId: 's2' }]);
    useStageStore.setState({ scenes: [scene('o1', 'other lesson', 1, OTHER)] });
    expect(applyInsertionResult(handle, serverAfterInsertion(), baseline, insertionResult())).toBe(
      'stale',
    );
    expect(ids()).toEqual(['o1']);
    expect(sceneRev(STAGE, 's2')).toBe(2);
    handle.release();
  });
});

describe('the local-wins merge over the union of Scene ids (V3.1-1)', () => {
  it('a dirty Scene deleted elsewhere is kept with its pending entry and old expectation', async () => {
    const conflicts: StageSaveConflict[] = [];
    const unsubscribe = onStageSaveConflict((conflict) => conflicts.push(conflict));
    const { handle, baseline } = preparedInsertion();
    useStageStore.getState().updateScene('s3', { title: 'edited here' });
    // Another tab deleted s3 during the run.
    const server = {
      scenes: [scene('s1', 'one', 1), scene(NEW, 'generated', 2), scene('s2', 'two', 3)],
      sceneRevs: { s1: 11, [NEW]: 20, s2: 12 },
    };
    const result: InsertionResultInput = {
      newSceneId: NEW,
      revTransitions: { s1: { before: 1, after: 11 }, s2: { before: 2, after: 12 } },
    };
    expect(applyInsertionResult(handle, server, baseline, result)).toBe('merged');
    expect(titles()).toContain('edited here');
    expect(sceneRev(STAGE, 's3')).toBe(3);
    expect(documentDirtSince(STAGE, baseline.mark)).toEqual(['scene:s3']);
    handle.release();

    // The next save carries the OLD expectation for a Scene that is gone: the
    // server refuses it (409), and the existing conflict path takes over with
    // its notice — never a silent drop, never a re-creation.
    incrementalSave.mockRejectedValueOnce(
      Object.assign(new Error('refused'), {
        status: 409,
        code: 'SCENE_REVISION_CONFLICT',
        details: { scenes: [{ id: 's3', currentRev: null }] },
      }),
    );
    loadStageData.mockResolvedValue({ stage: stage(), ...server, currentSceneId: 's1', chats: [] });
    await flushStageSave();
    expect(conflicts).toEqual([
      { stageId: STAGE, code: 'SCENE_REVISION_CONFLICT', sceneIds: ['s3'] },
    ]);
    expect(ids()).not.toContain('s3');
    unsubscribe();
  });

  it('a clean Scene deleted elsewhere is removed, and its binding with it', () => {
    const { handle, baseline } = preparedInsertion();
    useStageStore.getState().updateScene('s1', { title: 'edited here' });
    const server = {
      scenes: [scene('s1', 'one', 1), scene(NEW, 'generated', 2), scene('s2', 'two', 3)],
      sceneRevs: { s1: 11, [NEW]: 20, s2: 12 },
    };
    expect(applyInsertionResult(handle, server, baseline, insertionResult())).toBe('merged');
    expect(ids()).toEqual(['s1', NEW, 's2']);
    expect(titles()[0]).toBe('edited here');
    expect(sceneRev(STAGE, 's3')).toBeUndefined();
    expect(sceneRev(STAGE, 's1')).toBe(11);
    handle.release();
  });

  it('structure dirt + a remote deletion: the local list wins, minus the clean deletion', () => {
    const { handle, baseline } = preparedInsertion();
    // Reordered here during the fetch: s3, s1, s2.
    const [s1, s2, s3] = useStageStore.getState().scenes;
    useStageStore.getState().setScenes([
      { ...s3!, order: 1 },
      { ...s1!, order: 2 },
      { ...s2!, order: 3 },
    ]);
    // Another tab deleted s2 (clean here); the insertion put N after s1.
    const server = {
      scenes: [scene('s1', 'one', 1), scene(NEW, 'generated', 2), scene('s3', 'three', 3)],
      sceneRevs: { s1: 11, [NEW]: 20, s3: 13 },
    };
    const result: InsertionResultInput = {
      newSceneId: NEW,
      revTransitions: { s1: { before: 1, after: 11 }, s3: { before: 3, after: 13 } },
    };
    expect(applyInsertionResult(handle, server, baseline, result)).toBe('merged');
    expect(ids()).toEqual(['s3', 's1', NEW]);
    expect(useStageStore.getState().scenes.map((entry) => entry.order)).toEqual([1, 2, 3]);
    expect(sceneRev(STAGE, 's2')).toBeUndefined();
    expect([sceneRev(STAGE, 's1'), sceneRev(STAGE, 's3'), sceneRev(STAGE, NEW)]).toEqual([
      11, 13, 20,
    ]);
    expect(documentDirtSince(STAGE, baseline.mark)).toContain('structure');
    expect(useStageStore.getState().currentSceneId).toBe(NEW);
    handle.release();
  });

  it('structure dirt + a dirty Scene deleted elsewhere: kept, old expectation kept', () => {
    const { handle, baseline } = preparedInsertion();
    useStageStore.getState().updateScene('s2', { title: 'edited here' });
    const [s1, s2, s3] = useStageStore.getState().scenes;
    useStageStore.getState().setScenes([
      { ...s2!, order: 1 },
      { ...s1!, order: 2 },
      { ...s3!, order: 3 },
    ]);
    const server = {
      scenes: [scene('s1', 'one', 1), scene(NEW, 'generated', 2), scene('s3', 'three', 3)],
      sceneRevs: { s1: 11, [NEW]: 20, s3: 13 },
    };
    const result: InsertionResultInput = {
      newSceneId: NEW,
      revTransitions: { s1: { before: 1, after: 11 }, s3: { before: 3, after: 13 } },
    };
    expect(applyInsertionResult(handle, server, baseline, result)).toBe('merged');
    expect(ids()).toEqual(['s2', 's1', NEW, 's3']);
    expect(titles()[0]).toBe('edited here');
    expect(sceneRev(STAGE, 's2')).toBe(2);
    handle.release();
  });

  it('structure dirt: a Scene deleted here stays deleted; one created elsewhere is not adopted', () => {
    const { handle, baseline } = preparedInsertion();
    useStageStore.getState().deleteScene('s3');
    const server = {
      scenes: [
        scene('s1', 'one', 1),
        scene(NEW, 'generated', 2),
        scene('s2', 'two', 3),
        scene('s3', 'three', 4),
        scene('x9', 'other tab', 5),
      ],
      sceneRevs: { s1: 11, [NEW]: 20, s2: 12, s3: 13, x9: 30 },
    };
    expect(applyInsertionResult(handle, server, baseline, insertionResult())).toBe('merged');
    expect(ids()).toEqual(['s1', NEW, 's2']);
    // s3: only the shift touched it → its expectation moves, so the next whole
    // save deletes exactly what this tab saw. x9: no expectation → 409 recovery.
    expect(sceneRev(STAGE, 's3')).toBe(13);
    expect(sceneRev(STAGE, 'x9')).toBeUndefined();
    handle.release();
  });
});
