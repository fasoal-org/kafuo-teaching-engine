// @vitest-environment jsdom

/**
 * Module 3/4 W5 — the reviewer's Action-finding surfaces (plan §7.5,
 * TAE-RQ-025/027), pinned at the component level:
 *
 * 1. The TIMELINE renders a finding marker on the offending Action row and
 *    not on clean rows — the marker is the timeline composing with the
 *    inspection response, not a second Action list (the C-8 reuse decision).
 * 2. The PANEL shows the Actions governance context as a summary that points
 *    at the timeline rows — count + finding count, never the Actions
 *    themselves.
 *
 * Both consume the same GET the Teaching Skills panel already reads, and both
 * stay hidden on non-governed stages.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stageState = vi.hoisted(() => ({
  stage: { id: 'stage-gov' as string | null },
  scenes: [] as Array<Record<string, unknown>>,
  currentSceneId: null as string | null,
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: typeof stageState) => unknown) => selector(stageState),
  flushStageSave: vi.fn(async () => undefined),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: Object.assign(() => null, {
    getState: () => ({
      setPickTarget: vi.fn(),
      setSpotlight: vi.fn(),
      setLaser: vi.fn(),
      clearLaser: vi.fn(),
      clearAllEffects: vi.fn(),
      pauseVideo: vi.fn(),
      setWhiteboardOpen: vi.fn(),
      setWhiteboardClearing: vi.fn(),
    }),
    use: {},
  }),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ ttsEnabled: false, ttsProviderId: 'browser-native-tts', selectedAgentIds: [] }),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ agents: {} }),
}));
vi.mock('@/lib/classroom/generation-permission', () => ({
  useMayGenerateForStage: () => false,
  mayGenerateForStage: () => false,
}));
vi.mock('@/lib/audio/regenerate-speech-tts', () => ({
  audioExists: vi.fn(() => false),
  audioObjectUrl: vi.fn(() => null),
  discardSpeechAudio: vi.fn(async () => undefined),
  regenerateSpeechAudio: vi.fn(async () => null),
  resolveLegacySpeechAudioId: vi.fn(() => undefined),
  resolveSpeechAudioId: vi.fn(() => undefined),
}));
vi.mock('@/components/edit/EditDock/dock-context', () => ({
  useEditDock: () => ({ collapsed: false, toggleCollapsed: () => {} }),
}));

import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import { TeachingSkillsPanel } from '@/components/edit/EditDock/TeachingSkillsPanel';
import { buildStageTeachingSkillsInspection } from '@/lib/server/teaching-package/scene-inspection';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';

const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'i',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [{ skillId: 'feynman-learning', version: 'v1' }],
      combinationRestrictions: [],
    },
  },
];

/**
 * A governed slide scene whose Actions: one clean speech, one dangling
 * spotlight reference (the reference category that survives the write
 * barrier — a string is DSL-valid — and only the canonical check flags).
 */
function governedScene(): Record<string, unknown> {
  return {
    id: 'scene-1',
    stageId: 'stage-gov',
    type: 'slide',
    order: 1,
    title: 'Scene 1',
    createdAt: 1,
    updatedAt: 1,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: {
      primary: { skillId: 'feynman-learning', version: 'v1' },
      classification: 'instructional',
    },
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        theme: {},
        elements: [],
      },
    },
    actions: [
      { id: 'a-clean', type: 'speech', text: 'Clean narration.' },
      { id: 'a-flagged', type: 'spotlight', elementId: 'el-missing' },
    ],
  };
}

/**
 * The inspection payload the API would answer, built by the REAL builder —
 * so this suite proves the marker against the true server projection (minus
 * HTTP), and fails with it if the projection stops carrying findings.
 */
function governedInspectionPayload(actions: Record<string, unknown>[] | null = null) {
  const scene = governedScene() as Record<string, unknown>;
  if (actions !== null) scene.actions = actions;
  return {
    governed: true,
    capability: 'read',
    versionStatus: 'in_review',
    editable: false,
    scenes: buildStageTeachingSkillsInspection([scene as never], FLOW, {})
      .scenes as unknown as Array<Record<string, unknown>>,
  };
}

let container: HTMLElement;
let root: Root;
const fetchMock = vi.fn();

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stageState.stage = { id: 'stage-gov' };
  stageState.scenes = [governedScene()];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('W5 — the timeline marks the offending Action row', () => {
  it('renders the finding marker on the flagged Action row and NOT on the clean row', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => governedInspectionPayload(),
    } as Response);
    await render(createElement(ActionsBar, { sceneId: 'scene-1' }));

    const markers = [
      ...container.querySelectorAll('[data-testid="action-finding-marker"]'),
    ] as HTMLElement[];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.getAttribute('data-action-id')).toBe('a-flagged');
    expect(markers[0]!.getAttribute('data-finding-codes')).toBe('ACTION_REFERENCE_INVALID');
    // The clean speech row carries no marker: markers key on the Action id.
    expect(markers.some((marker) => marker.getAttribute('data-action-id') === 'a-clean')).toBe(
      false,
    );
  });

  it('renders no marker on a non-governed stage — the reviewer surface self-hides', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ governed: false }) } as Response);
    await render(createElement(ActionsBar, { sceneId: 'scene-1' }));
    expect(container.querySelectorAll('[data-testid="action-finding-marker"]')).toHaveLength(0);
  });

  it('renders no marker when the inspection GET is unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false } as Response);
    await render(createElement(ActionsBar, { sceneId: 'scene-1' }));
    expect(container.querySelectorAll('[data-testid="action-finding-marker"]')).toHaveLength(0);
  });
});

describe('W5 — the panel summarizes Actions without listing them', () => {
  const openPanel = async () => {
    await render(createElement(TeachingSkillsPanel, { sceneId: 'scene-1' }));
    const toggle = container.querySelector('[data-testid="teaching-skills-toggle"]')!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return container.querySelector('[data-testid="teaching-skills-panel"]')!;
  };

  it('shows the count and a findings summary pointing at the timeline rows', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => governedInspectionPayload(),
    } as Response);
    const panel = await openPanel();
    const actions = panel.querySelector('[data-testid="teaching-skills-actions"]')!;
    expect(actions.textContent).toContain('2 in the timeline');
    expect(actions.textContent).toContain('1 structural finding');
    expect(actions.textContent).toContain('timeline');
    // The folded finding rides the failures channel — and NO Action narration
    // or per-Action list renders here; the timeline owns the Actions.
    expect(panel.querySelector('[data-testid="teaching-skills-failures"]')!.textContent).toContain(
      'ACTION_REFERENCE_INVALID',
    );
    expect(panel.textContent).not.toContain('Clean narration.');
  });

  it('says so when the Actions carry no structural findings', async () => {
    // A clean action set — the builder naturally yields zero findings.
    const payload = governedInspectionPayload([
      { id: 'a-clean', type: 'speech', text: 'Clean narration.' },
    ]);
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload } as Response);
    const panel = await openPanel();
    expect(panel.querySelector('[data-testid="teaching-skills-actions"]')!.textContent).toContain(
      'no structural findings',
    );
  });
});
