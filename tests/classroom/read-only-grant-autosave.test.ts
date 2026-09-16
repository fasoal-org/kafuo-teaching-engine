/**
 * A classroom opened through a READ Teaching Package grant (Kafuo Preview, and
 * learner playback) must issue no document mutation at all.
 *
 * The server already refuses them — `PUT /api/persistence/documents/<id>/stage`
 * answers `403 GRANT_READ_ONLY` (pinned in
 * `tests/teaching-package/persistence-route-grant.test.ts`). These tests pin the
 * client half: the request is never sent, because the store's document-write
 * gate fails closed for the whole grant session until the stage-meta sidecar
 * says the viewer may write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fullSave, incrementalSave } = vi.hoisted(() => ({
  fullSave: vi.fn(),
  incrementalSave: vi.fn(),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => fullSave(...args),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import {
  commitMigratedAgentConfigsToStore,
  resetLegacyAgentFallbackProbes,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import {
  applyStageDocumentWriteAccess,
  flushStageSave,
  markStagePersistenceDirty,
  resetStageDocumentWriteAccess,
  stageDocumentWriteAccess,
  useStageStore,
} from '@/lib/store/stage';
import { resetStageOwnershipSignals } from '@/lib/classroom/stage-ownership-signal';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';

const PREVIEW_STAGE = 'stage-preview';

function makeStage(id: string, generatedAgentConfigs?: Stage['generatedAgentConfigs']): Stage {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    ...(generatedAgentConfigs !== undefined ? { generatedAgentConfigs } : {}),
  };
}

function makeScene(id: string, stageId: string): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title: id,
    order: 1,
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
  };
}

function makeAgentConfig(id: string, extra: Partial<GeneratedAgentConfig> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    role: 'teacher',
    persona: 'Teach',
    avatar: 'A',
    color: '#000',
    priority: 1,
    ...extra,
  } satisfies GeneratedAgentConfig;
}

/**
 * Model a tab opened by an Editor-grant redeem. Only the readable companion
 * cookie is observable to page scripts — the grant itself is HttpOnly — so this
 * is everything the client can see, for a read grant and a write grant alike.
 */
function enterGrantSession(): void {
  vi.stubGlobal('document', { cookie: 'teaching_package_learner_key=tp%3Agrant-nonce-1' });
  resetStageDocumentWriteAccess();
}

/** The route's read-only refusal, as `HttpDocumentStore` surfaces it. */
function grantReadOnlyError(): Error & { status: number; code: string } {
  return Object.assign(new Error('this editor grant is read-only; the stage cannot be modified'), {
    status: 403,
    code: 'GRANT_READ_ONLY',
  });
}

function seedClassroom(stageId: string, configs?: Stage['generatedAgentConfigs']): void {
  useStageStore.setState({
    stage: makeStage(stageId, configs),
    scenes: [makeScene('scene-1', stageId)],
    currentSceneId: 'scene-1',
    chats: [],
  });
}

/** The loader's dependency bundle, wired to the real store-committing migration. */
function makeLoadDeps(
  classroomId: string,
  fallbacks: GeneratedAgentConfig[],
): Parameters<typeof runClassroomLoad>[0] {
  const settings = {
    agentMode: 'auto' as const,
    selectedAgentIds: [] as string[],
    agentSelectionIsUserSet: false,
    setAgentMode: vi.fn(),
    setSelectedAgentIds: vi.fn(),
    setAgentSelectionIsUserSet: vi.fn(),
  };
  return {
    classroomId,
    loadToken: 1,
    isCurrent: () => true,
    loadFromStorage: vi.fn().mockResolvedValue(undefined),
    getCurrentStage: () => useStageStore.getState().stage,
    fetchClassroom: vi.fn().mockResolvedValue(null),
    applyFallbackScenes: vi.fn().mockResolvedValue(false),
    loadRestoredMediaTasks: vi.fn().mockResolvedValue({}),
    applyRestoredMediaTasks: vi.fn(),
    discardRestoredMediaTasks: vi.fn(),
    loadLegacyAgentFallbacks: vi.fn().mockResolvedValue(fallbacks),
    // The real one: it mutates the in-memory stage and marks it dirty, which is
    // the confirmed path to the observed `/stage` PUT.
    commitMigratedAgentConfigs: commitMigratedAgentConfigsToStore,
    applyGeneratedAgents: vi.fn().mockReturnValue([]),
    getSettings: () => settings,
    getAgent: vi.fn().mockReturnValue(undefined),
    restoreAgentSelection: vi.fn().mockReturnValue({
      selection: { mode: 'preset', selectedAgentIds: [] },
      isUserSet: false,
    }),
    setError: vi.fn(),
    setLoading: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fullSave.mockReset().mockResolvedValue(undefined);
  incrementalSave.mockReset().mockResolvedValue({ failedChanges: [] });
  resetLegacyAgentFallbackProbes();
  resetStageOwnershipSignals();
  resetStageDocumentWriteAccess();
  useStageStore.getState().clearStore();
});

afterEach(() => {
  useStageStore.getState().clearStore();
  resetStageDocumentWriteAccess();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('read-only Teaching Package grant: the classroom writes no document', () => {
  it('parks the lazy roster migration instead of scheduling a Stage write, and discards it when read-only resolves', async () => {
    enterGrantSession();
    // A document whose roster predates voice persistence: exactly the shape
    // that sends the loader to the legacy mirror.
    seedClassroom(PREVIEW_STAGE, [makeAgentConfig('agent-a')]);
    const voiceDesign = { identity: 'bright', texture: 'clear', delivery: 'lively' };
    const deps = makeLoadDeps(PREVIEW_STAGE, [makeAgentConfig('agent-a', { voiceDesign })]);

    await runClassroomLoad(deps);

    // The migration landed in memory — playback still gets the merged roster…
    expect(useStageStore.getState().stage?.generatedAgentConfigs).toEqual([
      makeAgentConfig('agent-a', { voiceDesign }),
    ]);
    // …but nothing is scheduled while the grant's capability is unknown.
    expect(stageDocumentWriteAccess(PREVIEW_STAGE)).toBe('unresolved');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    expect(fullSave).not.toHaveBeenCalled();

    // The sidecar answers: a read grant is not the owner.
    useStageStore.getState().setViewerAccess({ isOwner: false, stageId: PREVIEW_STAGE });
    expect(stageDocumentWriteAccess(PREVIEW_STAGE)).toBe('read-only');

    // An explicit drain finds nothing to send, and no retry is ever armed.
    await flushStageSave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    expect(fullSave).not.toHaveBeenCalled();
  });

  it('sends nothing on an explicit drain while the grant capability is still unresolved', async () => {
    // The beforeunload / visibilitychange kick calls `flushStageSave` directly,
    // bypassing the debounce entirely — so the gate cannot live in the timer
    // alone.
    enterGrantSession();
    seedClassroom(PREVIEW_STAGE);
    markStagePersistenceDirty([{ kind: 'stage' }]);
    expect(stageDocumentWriteAccess(PREVIEW_STAGE)).toBe('unresolved');

    await flushStageSave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    expect(fullSave).not.toHaveBeenCalled();

    // The work is parked, not lost: a write grant still gets it.
    useStageStore.getState().setViewerAccess({ isOwner: true, stageId: PREVIEW_STAGE });
    await vi.advanceTimersByTimeAsync(500);
    expect(incrementalSave).toHaveBeenCalledOnce();
  });

  it('refuses every document mutation a resolved read-only classroom attempts', async () => {
    enterGrantSession();
    seedClassroom(PREVIEW_STAGE);
    useStageStore.getState().setViewerAccess({ isOwner: false, stageId: PREVIEW_STAGE });

    const store = useStageStore.getState();
    // Stage, scene, outline and current-scene — the whole enumerated surface.
    markStagePersistenceDirty([{ kind: 'stage' }]);
    store.updateScene('scene-1', { title: 'changed' });
    store.setOutlines([]);
    store.setCurrentSceneId('scene-1');
    // …and the direct aggregate save, which bypasses the pending map entirely.
    await expect(store.saveToStorage()).resolves.toBe(false);

    await flushStageSave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).not.toHaveBeenCalled();
    expect(fullSave).not.toHaveBeenCalled();
  });

  it('does not flush parked dirt when the viewer navigates away before the capability resolves', async () => {
    // `setStage`'s departing-stage flush calls the persistence layer DIRECTLY,
    // outside the pending map and outside the flush round — so it needs its own
    // gate, or it becomes the one request that escapes.
    enterGrantSession();
    seedClassroom(PREVIEW_STAGE);
    markStagePersistenceDirty([{ kind: 'stage' }]);
    expect(stageDocumentWriteAccess(PREVIEW_STAGE)).toBe('unresolved');

    useStageStore.getState().setStage(makeStage('stage-next'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(incrementalSave).not.toHaveBeenCalled();
    expect(fullSave).not.toHaveBeenCalled();
  });

  it('records nothing once a classroom is known to be read-only', () => {
    enterGrantSession();
    seedClassroom(PREVIEW_STAGE);
    useStageStore.getState().setViewerAccess({ isOwner: false, stageId: PREVIEW_STAGE });

    markStagePersistenceDirty([{ kind: 'stage' }]);
    // Nothing was queued at all, so even the departing-stage flush has nothing
    // to carry into the next classroom.
    useStageStore.getState().setStage(makeStage('stage-next'));
    expect(incrementalSave).not.toHaveBeenCalled();
  });

  it('keeps read-only playback from inheriting a write when the viewer moves to an editable classroom', async () => {
    enterGrantSession();
    seedClassroom(PREVIEW_STAGE);
    // Dirt queued before the answer arrives, then refused.
    markStagePersistenceDirty([{ kind: 'stage' }]);
    useStageStore.getState().setViewerAccess({ isOwner: false, stageId: PREVIEW_STAGE });

    // Navigating on: `setStage`'s departing flush must not become the one
    // request that escapes the gate.
    useStageStore.getState().setStage(makeStage('stage-editable'));
    applyStageDocumentWriteAccess('stage-editable', 'writable');
    await flushStageSave();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(incrementalSave.mock.calls[0]![0]).toBe('stage-editable');
    // Only the new stage's own structural dirt — nothing carried over.
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'structure' }, { kind: 'stage' }]);
  });
});

describe('write-grant edit mode stays editable', () => {
  it('releases work parked during the ownership window once the write grant resolves', async () => {
    enterGrantSession();
    seedClassroom('stage-draft', [makeAgentConfig('agent-a')]);
    const voiceDesign = { identity: 'bright', texture: 'clear', delivery: 'lively' };
    const deps = makeLoadDeps('stage-draft', [makeAgentConfig('agent-a', { voiceDesign })]);

    await runClassroomLoad(deps);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(incrementalSave).not.toHaveBeenCalled();

    // `mode=edit` on a draft mints a write grant; stage-meta reports it as owner.
    useStageStore.getState().setViewerAccess({ isOwner: true, stageId: 'stage-draft' });
    expect(stageDocumentWriteAccess('stage-draft')).toBe('writable');

    await vi.advanceTimersByTimeAsync(500);
    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(incrementalSave.mock.calls[0]![0]).toBe('stage-draft');
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'stage' }]);
  });

  it('keeps flushing ordinary edits after the write grant resolved', async () => {
    enterGrantSession();
    seedClassroom('stage-draft');
    useStageStore.getState().setViewerAccess({ isOwner: true, stageId: 'stage-draft' });

    useStageStore.getState().updateScene('scene-1', { title: 'edited' });
    await flushStageSave();

    expect(incrementalSave).toHaveBeenCalledOnce();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);
    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(true);
    expect(fullSave).toHaveBeenCalledOnce();
  });
});

describe('a queued write refused with GRANT_READ_ONLY is terminal', () => {
  it('stops retrying, keeps the dirt from coming back, and does not report success', async () => {
    enterGrantSession();
    seedClassroom('stage-raced');
    // The window loses the race: the write is already in flight when the route
    // refuses it.
    useStageStore.getState().setViewerAccess({ isOwner: true, stageId: 'stage-raced' });
    incrementalSave.mockRejectedValue(grantReadOnlyError());

    markStagePersistenceDirty([{ kind: 'stage' }]);
    await expect(flushStageSave()).resolves.toBeUndefined();

    expect(incrementalSave).toHaveBeenCalledOnce();
    // Terminal: the session converts itself to read-only rather than backing off.
    expect(stageDocumentWriteAccess('stage-raced')).toBe('read-only');
    expect(useStageStore.getState().readOnly).toBe(true);
    expect(useStageStore.getState().isOwner).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(incrementalSave).toHaveBeenCalledOnce();
  });

  it('reports a refused aggregate save as not durable', async () => {
    enterGrantSession();
    seedClassroom('stage-raced');
    useStageStore.getState().setViewerAccess({ isOwner: true, stageId: 'stage-raced' });
    fullSave.mockRejectedValue(grantReadOnlyError());

    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(false);
    expect(stageDocumentWriteAccess('stage-raced')).toBe('read-only');
  });

  it('still retries a genuinely transient failure', async () => {
    enterGrantSession();
    seedClassroom('stage-draft');
    useStageStore.getState().setViewerAccess({ isOwner: true, stageId: 'stage-draft' });
    incrementalSave.mockRejectedValue(new Error('network down'));

    markStagePersistenceDirty([{ kind: 'stage' }]);
    await expect(flushStageSave()).rejects.toThrow('network down');
    expect(stageDocumentWriteAccess('stage-draft')).toBe('writable');

    // The backoff timer is still armed: the dirt is retried, not discarded.
    incrementalSave.mockResolvedValue({ failedChanges: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(incrementalSave.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('sessions without a Teaching Package grant are untouched', () => {
  it('keeps an ordinary locally owned classroom immediately writable', async () => {
    // No grant cookie at all — the default must stay the upstream one.
    vi.stubGlobal('document', { cookie: '' });
    resetStageDocumentWriteAccess();
    seedClassroom('stage-local');

    expect(stageDocumentWriteAccess('stage-local')).toBe('writable');
    useStageStore.getState().updateScene('scene-1', { title: 'edited' });
    await flushStageSave();

    expect(incrementalSave).toHaveBeenCalledOnce();
    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(true);
  });
});
