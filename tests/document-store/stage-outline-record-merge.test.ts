import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = {
    putScene: vi.fn().mockResolvedValue(undefined),
    putStage: vi.fn().mockResolvedValue(undefined),
    saveDocument: vi.fn().mockResolvedValue(undefined),
  };
  return {
    loadDocument: vi.fn(),
    mutateDocument: vi.fn(
      async (
        _stageId: string,
        callback: (document: unknown, documentStore: typeof store) => Promise<void>,
      ) => callback(mocks.loadDocument(), store),
    ),
    putScene: store.putScene,
    putStage: store.putStage,
    saveDocument: store.saveDocument,
    saveCurrentScene: vi.fn().mockResolvedValue(undefined),
    saveChatSessions: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/document-store', () => ({
  mutateDocument: mocks.mutateDocument,
  saveCurrentScene: mocks.saveCurrentScene,
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: async (_id: string, scenes: unknown[]) => scenes,
}));
vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: (callback: () => unknown) => callback(),
  withRuntimeStorageExclusiveLockUntilSettled: (callback: () => unknown) => callback(),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: mocks.saveChatSessions,
  loadChatSessions: vi.fn().mockResolvedValue([]),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));

import { saveStageData, type StageStoreData } from '@/lib/utils/stage-storage';
import type {
  AppDocument,
  AppDocumentOutline,
} from '@/lib/document-store/persistence-types';
import type { Scene, Stage } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const STAGE_ID = 'stage-outline-merge';

function payload(overrides: Partial<StageStoreData> = {}): StageStoreData {
  return {
    stage: { id: STAGE_ID, name: 'Course' } as unknown as Stage,
    scenes: [makeSlideScene('scene-1', STAGE_ID, 1, 'One')] as Scene[],
    currentSceneId: 'scene-1',
    chats: [],
    outline: {
      outlines: [],
      generationComplete: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    ...overrides,
  };
}

function existingDocument(outline: Record<string, unknown>): AppDocument {
  return {
    stage: { id: STAGE_ID, name: 'Course' },
    scenes: [],
    outline: { createdAt: 111, updatedAt: 111, ...outline },
  } as unknown as AppDocument;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('outline-record sibling merge on save (plan §4.2.5)', () => {
  it('preserves producer, producerRef, teachingFlow and sourceVisuals when the store save payload rebuilds the outline', async () => {
    mocks.loadDocument.mockReturnValue(
      existingDocument({
        outlines: [],
        generationComplete: true,
        producer: 'server-job',
        producerRef: 'tpa-9',
        teachingFlow: [{ stage: 'lesson_introduction', instructions: 'i' }],
        sourceVisuals: [
          {
            id: 'src-1',
            contentResourceId: 'cs-1',
            pageNumber: 3,
            mimeType: 'image/png',
            sha256: '0'.repeat(64),
            servingPath: '/api/classroom-media/stage-x/media/src_1_ab.png',
          },
        ],
      }),
    );

    await saveStageData(STAGE_ID, payload(), 0);

    const saved = mocks.saveDocument.mock.calls[0]![0] as { outline: AppDocumentOutline };
    expect(saved.outline.producer).toBe('server-job');
    expect(saved.outline.producerRef).toBe('tpa-9');
    expect(saved.outline.teachingFlow).toEqual([
      { stage: 'lesson_introduction', instructions: 'i' },
    ]);
    expect(saved.outline.sourceVisuals).toHaveLength(1);
    // The original createdAt is retained, not re-stamped by the payload.
    expect(saved.outline.createdAt).toBe(111);
  });

  it('keeps prior semantics for non-package stages: a plain save does not invent package fields', async () => {
    mocks.loadDocument.mockReturnValue(existingDocument({ outlines: [] }));

    await saveStageData(STAGE_ID, payload(), 0);

    const saved = mocks.saveDocument.mock.calls[0]![0] as { outline: AppDocumentOutline };
    expect(saved.outline.teachingFlow).toBeUndefined();
    expect(saved.outline.sourceVisuals).toBeUndefined();
    expect(saved.outline.producer).toBeUndefined();
  });

  it('lets a payload that carries teachingFlow update it while retaining other siblings', async () => {
    mocks.loadDocument.mockReturnValue(
      existingDocument({
        outlines: [],
        producer: 'server-job',
        producerRef: 'tpa-1',
        teachingFlow: [{ stage: 'a', instructions: 'old' }],
      }),
    );

    await saveStageData(
      STAGE_ID,
      payload({
        outline: {
          outlines: [],
          generationComplete: true,
          teachingFlow: [
            { stage: 'lesson_introduction', instructions: 'new' },
            { stage: 'outcome_teaching_cards', instructions: 'cards' },
          ],
          createdAt: 222,
          updatedAt: 222,
        },
      }),
      0,
    );

    const saved = mocks.saveDocument.mock.calls[0]![0] as { outline: AppDocumentOutline };
    expect(saved.outline.teachingFlow).toHaveLength(2);
    expect(saved.outline.producer).toBe('server-job');
    expect(saved.outline.createdAt).toBe(111);
  });
});
