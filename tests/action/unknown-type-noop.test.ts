import { describe, expect, test, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import { ActionEngine } from '@/lib/action/engine';

const mocks = vi.hoisted(() => ({
  getWhiteboard: vi.fn(() => ({ success: true, data: { id: 'wb-1', elements: [] } })),
}));

vi.mock('katex', () => ({ default: { renderToString: vi.fn(() => '') } }));

vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({
    whiteboard: {
      get: mocks.getWhiteboard,
      addElement: vi.fn(),
    },
  }),
}));

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({ whiteboardOpen: false }),
  },
}));

vi.mock('@/lib/store/whiteboard-history', () => ({
  useWhiteboardHistoryStore: {
    getState: () => ({ pushSnapshot: vi.fn() }),
  },
}));

vi.mock('@/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false,
  useMediaGenerationStore: {
    getState: () => ({ tasks: {}, getTask: vi.fn() }),
    subscribe: vi.fn(),
  },
}));

vi.mock('@/lib/i18n', () => ({ getClientTranslation: () => '' }));

/**
 * Module 3/4 W3 regression (plan §10): unknown Action types execute as no-ops
 * — the execution switch has no `default`, and W3 must not change that. The
 * historical corpus holds hundreds of invented types; the write barrier's
 * leniency and this no-op ARE the TAE-RQ-031 compatibility mechanism.
 */
describe('ActionEngine unknown-type leniency (TAE-RQ-031)', () => {
  test('executing an unknown Action type is a silent no-op, not a failure', async () => {
    const stageStore = {
      getState: vi.fn(() => ({
        stage: { id: 'stage-hist' },
        scenes: [],
        currentSceneId: null,
      })),
      setState: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as StageStore;
    const engine = new ActionEngine(stageStore);

    await expect(
      engine.execute({
        id: 'action-legacy-1',
        type: 'legacy_confetti_burst',
        intensity: 11,
      } as never),
    ).resolves.toBeUndefined();
  });
});
