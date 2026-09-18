/**
 * Module 3/4 W6.2 — flow-authority isolation (TAE-RQ-006/008, TAE-AC-003,
 * plan §7.6 item 2, turning §3.7's "no progression authority anywhere in
 * playback/execution" into something the build enforces).
 *
 * Two layers:
 *
 * 1. STATIC IMPORT BOUNDARY — no module under lib/playback/, lib/action/, or
 *    the generation package's scene-generator may import from
 *    lib/server/teaching-package/, lib/persistence/teaching-package, or any
 *    Kafuo client. A module that cannot even name the progression owner
 *    cannot write progression. Source-scan shape follows the repo's
 *    established guard precedent (tests/teaching-package/non-kafuo-call-sites
 *    .test.ts, tests/lint-llm-entry-guard.test.ts).
 *
 * 2. BEHAVIORAL — executing every canonical Action type, and failing every
 *    canonical Action type, leaves flow position and package state untouched:
 *    no teachingStage mutation, no scene mutation, no store write at all. The
 *    engine's only outputs are presentation effects (canvas store), the
 *    whiteboard API, the audio player and the widget callback — none of which
 *    is a progression write.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ACTION_TYPES, type Action } from '@openmaic/dsl';
import type { StageStore } from '@/lib/api/stage-api';
import { ActionEngine } from '@/lib/action/engine';

const repoRoot = join(process.cwd());

/** Production source files under a directory or single file (tests live in tests/). */
function productionSources(root: string): string[] {
  const full = join(repoRoot, root);
  if (statSync(full).isFile()) return [full];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(entryPath);
    }
  };
  walk(full);
  return out;
}

/** Every import specifier a module can carry: static, type-only, dynamic, require, re-export. */
const IMPORT_SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return found;
}

/** The guarded roots (plan §7.6: lib/playback/, lib/action/, scene-generator.ts). */
const GUARDED_ROOTS = [
  'lib/playback',
  'lib/action',
  'packages/@openmaic/generation/src/scene-generator.ts',
] as const;

/**
 * The forbidden dependents: the Teaching Package server surface, its
 * persistence, and every Kafuo client module (the kafuo-* files live under
 * lib/server/teaching-package/, so the substring covers both at once — and
 * stays correct if a Kafuo client ever moves).
 */
const FORBIDDEN = ['teaching-package', 'kafuo'];

describe('W6.2 static — playback and execution hold no progression dependency', () => {
  it('nothing under lib/playback/, lib/action/ or scene-generator.ts imports teaching-package or Kafuo', () => {
    const offenders: string[] = [];
    for (const root of GUARDED_ROOTS) {
      const files = productionSources(root);
      expect(files.length, `${root} must have production sources to guard`).toBeGreaterThan(0);
      for (const file of files) {
        for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
          if (FORBIDDEN.some((needle) => specifier.includes(needle))) {
            offenders.push(`${file} → '${specifier}'`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard itself is wired: a synthetic teaching-package import in lib/action/ would be flagged', () => {
    // The proof that the scan reads real specifiers, not just file names: run
    // the same matcher over an in-memory offender.
    const synthetic = `import { readFlowForVersion } from '@/lib/server/teaching-package/exact-flow';\nexport const a = 1;\n`;
    const flagged = specifiersOf(synthetic).filter((specifier) =>
      FORBIDDEN.some((needle) => specifier.includes(needle)),
    );
    expect(flagged).toEqual(['@/lib/server/teaching-package/exact-flow']);
  });
});

/** One structurally valid Action per canonical type, against a real roster and canvas. */
const VALID_BY_TYPE: Record<string, Record<string, unknown>> = {
  spotlight: { type: 'spotlight', elementId: 'el-1' },
  laser: { type: 'laser', elementId: 'el-1' },
  play_video: { type: 'play_video', elementId: 'video-1' },
  speech: { type: 'speech', text: 'Narration.' },
  wb_open: { type: 'wb_open' },
  wb_draw_text: { type: 'wb_draw_text', content: 'Note', x: 1, y: 1 },
  wb_draw_shape: { type: 'wb_draw_shape', shape: 'rect', x: 1, y: 1, width: 2, height: 2 },
  wb_draw_chart: {
    type: 'wb_draw_chart',
    chartType: 'bar',
    x: 1,
    y: 1,
    width: 2,
    height: 2,
    data: { rows: [] },
  },
  wb_draw_latex: { type: 'wb_draw_latex', latex: 'E=mc^2', x: 1, y: 1 },
  wb_draw_table: { type: 'wb_draw_table', x: 1, y: 1, width: 2, height: 2, data: [] },
  wb_draw_line: { type: 'wb_draw_line', startX: 0, startY: 0, endX: 1, endY: 1 },
  wb_draw_code: { type: 'wb_draw_code', language: 'ts', code: 'void', x: 1, y: 1 },
  wb_edit_code: { type: 'wb_edit_code', elementId: 'wb-el-1', operation: 'append' },
  wb_clear: { type: 'wb_clear' },
  wb_delete: { type: 'wb_delete', elementId: 'wb-el-1' },
  wb_close: { type: 'wb_close' },
  discussion: { type: 'discussion', topic: 'Check', agentId: 'agent-1' },
  widget_highlight: { type: 'widget_highlight', target: '#chart' },
  widget_setState: { type: 'widget_setState', state: { mode: 'idle' } },
  widget_annotation: { type: 'widget_annotation', target: '#chart .bar' },
  widget_reveal: { type: 'widget_reveal', target: '#answer' },
};

vi.mock('katex', () => ({ default: { renderToString: vi.fn(() => '') } }));

const apiMocks = vi.hoisted(() => ({
  whiteboard: {
    get: vi.fn(),
    addElement: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({
    whiteboard: apiMocks.whiteboard,
  }),
}));

const canvasMocks = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({
      // Open, so each wb_* action skips the ~2s open-animation delay — the
      // delay is presentation, not the boundary under test.
      whiteboardOpen: true,
      playingVideoElementId: undefined,
      setSpotlight: (...args: unknown[]) =>
        canvasMocks.calls.push(`spotlight:${JSON.stringify(args)}`),
      setLaser: (...args: unknown[]) => canvasMocks.calls.push(`laser:${JSON.stringify(args)}`),
      clearLaser: () => canvasMocks.calls.push('clearLaser'),
      clearAllEffects: () => canvasMocks.calls.push('clearAllEffects'),
      pauseVideo: () => canvasMocks.calls.push('pauseVideo'),
      playVideo: (elementId: string) => canvasMocks.calls.push(`playVideo:${elementId}`),
      setWhiteboardOpen: () => canvasMocks.calls.push('setWhiteboardOpen'),
      setWhiteboardClearing: () => canvasMocks.calls.push('setWhiteboardClearing'),
    }),
    subscribe: () => () => {},
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

describe('W6.2 behavioral — executing and failing every Action type writes no package state', () => {
  /**
   * A stage store whose EVERY method is a spy: the engine holds no path to a
   * package command unless it calls one of these, and the scenes array is
   * frozen so a mutation attempt throws instead of passing silently.
   */
  function guardedStageStore(): {
    store: StageStore;
    snapshot: string;
    setState: ReturnType<typeof vi.fn>;
  } {
    const scenes = [
      {
        id: 'scene-1',
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
        content: {
          type: 'slide',
          canvas: { elements: [{ id: 'video-1', type: 'video', src: '/v.mp4' }] },
        },
        actions: [] as Action[],
      },
    ];
    const setState = vi.fn();
    const store = {
      getState: () => ({
        stage: { id: 'stage-1' },
        scenes: Object.freeze(scenes),
        currentSceneId: 'scene-1',
      }),
      setState,
      subscribe: vi.fn(),
    } as unknown as StageStore;
    return { store, snapshot: JSON.stringify(scenes), setState };
  }

  it('every canonical type executes (or safely rejects) with flow position and scenes byte-identical', async () => {
    apiMocks.whiteboard.get.mockResolvedValue({
      success: true,
      data: { id: 'wb-1', elements: [] },
    });
    apiMocks.whiteboard.addElement.mockResolvedValue({ success: true });
    apiMocks.whiteboard.update.mockResolvedValue({ success: true });
    const { store, snapshot, setState } = guardedStageStore();
    const widgetMessages: string[] = [];
    const engine = new ActionEngine(store, null, (type) => {
      widgetMessages.push(type);
    });

    for (const [index, type] of [...ACTION_TYPES].entries()) {
      const action = { id: `a-${index}`, ...VALID_BY_TYPE[type] } as unknown as Action;
      // An execution may legitimately reject (a failing subsystem); what it
      // may NEVER do is write package state on the way down.
      await engine.execute(action).catch(() => undefined);
    }
    engine.dispose();

    const after = JSON.stringify(store.getState().scenes);
    expect(after).toBe(snapshot);
    expect(
      (store.getState().scenes as Array<{ teachingStage?: unknown }>)[0]!.teachingStage,
    ).toEqual({ key: 'lesson_introduction', flowIndex: 0 });
    // No Kafuo progression write, no teachingStage mutation, no package
    // command: the engine never touched the store's write surface at all.
    expect(setState).not.toHaveBeenCalled();
  });

  it('failing every canonical type still writes nothing', async () => {
    // Every subsystem the engine delegates to fails: the whiteboard API
    // refuses and the widget callback throws. Failure is the louder path —
    // a crash handler that "compensated" by writing state would show here.
    apiMocks.whiteboard.get.mockResolvedValue({ success: false });
    apiMocks.whiteboard.addElement.mockRejectedValue(new Error('wb down'));
    apiMocks.whiteboard.update.mockRejectedValue(new Error('wb down'));
    const { store, snapshot, setState } = guardedStageStore();
    const engine = new ActionEngine(store, null, () => {
      throw new Error('widget iframe gone');
    });

    for (const [index, type] of [...ACTION_TYPES].entries()) {
      const action = { id: `a-${index}`, ...VALID_BY_TYPE[type] } as unknown as Action;
      await engine.execute(action).catch(() => undefined);
    }
    engine.dispose();

    expect(JSON.stringify(store.getState().scenes)).toBe(snapshot);
    expect(setState).not.toHaveBeenCalled();
  });
});
