// @vitest-environment jsdom

/**
 * W16 — the Teaching Skills inspection panel (teaching-skills plan §P Step 17 ·
 * §J · FR-TS-038/045/053 · AC-TS-026).
 *
 * Pins the three §J constraints the plan calls the reason the step exists:
 * all eight fields render; interactive and PBL Scenes are NOT silently
 * excluded (the panel is fed by the Scene-type-agnostic inspection API, and
 * attaches at the dock, never at surfaces/); read-only states refuse mutation
 * while editable ones permit it, within policy.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stage = vi.hoisted(() => ({ id: 'stage-panel' as string | null }));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: { stage: { id: string | null } | null }) => unknown) =>
    selector({ stage: stage.id ? { id: stage.id } : null }),
}));

import { TeachingSkillsPanel } from '@/components/edit/EditDock/TeachingSkillsPanel';

interface SceneView {
  sceneId: string;
  sceneType: string;
  flowPosition: { key: string; flowIndex: number } | null;
  classification: string | null;
  primary: { skillId: string; version: string } | null;
  supporting: Array<{ skillId: string; version: string }>;
  policy: {
    relationship: 'within-policy' | 'out-of-policy' | 'no-policy';
    allowed: Array<{ skillId: string; version: string }>;
    required: unknown[];
    preferred: unknown[];
  };
  alignment: { state: string; aligned: boolean; reason?: string; baselineOrigin?: string };
  failures: Array<{ code: string; message: string }>;
}

function sceneView(overrides: Partial<SceneView> & { sceneId: string }): SceneView {
  return {
    sceneType: 'slide',
    flowPosition: { key: 'lesson_introduction', flowIndex: 0 },
    classification: 'instructional',
    primary: { skillId: 'feynman-learning', version: 'v1' },
    supporting: [],
    policy: {
      relationship: 'within-policy',
      allowed: [
        { skillId: 'feynman-learning', version: 'v1' },
        { skillId: 'lecture-style', version: 'v1' },
      ],
      required: [],
      preferred: [],
    },
    alignment: { state: 'current', aligned: true, baselineOrigin: 'generation' },
    failures: [],
    ...overrides,
  };
}

function inspectionResponse(scenes: SceneView[], editable: boolean, capability = 'write') {
  return {
    governed: true,
    editable,
    capability,
    versionStatus: editable ? 'draft' : 'approved',
    scenes,
  };
}

let container: HTMLElement;
let root: Root;
const fetchMock = vi.fn();

async function renderAndWait(sceneId: string): Promise<void> {
  await act(async () => {
    root.render(createElement(TeachingSkillsPanel, { sceneId }));
  });
}

describe('TeachingSkillsPanel', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    stage.id = 'stage-panel';
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

  const respond = (payload: unknown) =>
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => payload,
    } as Response);

  it('renders nothing for a non-governed stage', async () => {
    respond({ governed: false });
    await renderAndWait('s1');
    expect(container.textContent).toBe('');
  });

  it('renders all eight fields for the current scene', async () => {
    respond(
      inspectionResponse(
        [
          sceneView({ sceneId: 'other' }),
          sceneView({
            sceneId: 's1',
            alignment: { state: 'stale', aligned: false, reason: 'material-change' },
            failures: [
              { code: 'SKILL_REQUIREMENT_UNSATISFIED', message: 'a required skill is missing' },
            ],
          }),
        ],
        true,
      ),
    );
    await renderAndWait('s1');
    const toggle = container.querySelector('[data-testid="teaching-skills-toggle"]')!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel = container.querySelector('[data-testid="teaching-skills-panel"]')!;
    expect(panel).not.toBeNull();
    // 1 classification, 2 primary, 3 supporting, 4 exact versions (id@version),
    // 5 policy relationship, 6 flow position, 7 alignment state, 8 failures.
    expect(
      panel.querySelector('[data-testid="teaching-skills-classification"]')!.textContent,
    ).toContain('instructional');
    expect(panel.querySelector('[data-testid="teaching-skills-primary"]')!.textContent).toContain(
      'feynman-learning@v1',
    );
    expect(
      panel.querySelector('[data-testid="teaching-skills-supporting"]')!.textContent,
    ).toContain('—');
    expect(panel.querySelector('[data-testid="teaching-skills-policy"]')!.textContent).toContain(
      'within policy',
    );
    expect(
      panel.querySelector('[data-testid="teaching-skills-flow-position"]')!.textContent,
    ).toContain('lesson_introduction');
    const alignment = panel.querySelector('[data-testid="teaching-skills-alignment"]')!;
    expect(alignment.getAttribute('data-state')).toBe('stale');
    expect(alignment.textContent).toContain('material-change');
    expect(panel.querySelector('[data-testid="teaching-skills-failures"]')!.textContent).toContain(
      'SKILL_REQUIREMENT_UNSATISFIED',
    );
  });

  it.each(['interactive', 'pbl'] as const)(
    'renders for a %s scene — not silently excluded',
    async (sceneType) => {
      respond(
        inspectionResponse(
          [
            sceneView({
              sceneId: 's1',
              sceneType,
              primary: { skillId: 'lecture-style', version: 'v1' },
              classification: 'instructional',
            }),
          ],
          true,
        ),
      );
      await renderAndWait('s1');
      const toggle = container.querySelector('[data-testid="teaching-skills-toggle"]')!;
      await act(async () => {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const panel = container.querySelector('[data-testid="teaching-skills-panel"]')!;
      expect(panel.getAttribute('data-scene-type')).toBe(sceneType);
      expect(panel.querySelector('[data-testid="teaching-skills-primary"]')!.textContent).toContain(
        'lecture-style@v1',
      );
    },
  );

  it('read-only states render no mutation controls and say why', async () => {
    respond(inspectionResponse([sceneView({ sceneId: 's1' })], false, 'read'));
    await renderAndWait('s1');
    const toggle = container.querySelector('[data-testid="teaching-skills-toggle"]')!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel = container.querySelector('[data-testid="teaching-skills-panel"]')!;
    expect(panel.querySelector('[data-testid="teaching-skills-classification-input"]')).toBeNull();
    expect(panel.querySelector('[data-testid="teaching-skills-primary-input"]')).toBeNull();
    expect(panel.querySelector('[data-testid="teaching-skills-confirm"]')).toBeNull();
    expect(panel.textContent).toContain('read-only');
  });

  it('editable states offer the policy-constrained correction and confirm actions', async () => {
    respond(
      inspectionResponse(
        [
          sceneView({
            sceneId: 's1',
            alignment: { state: 'stale', aligned: false, reason: 'material-change' },
          }),
        ],
        true,
      ),
    );
    await renderAndWait('s1');
    const toggle = container.querySelector('[data-testid="teaching-skills-toggle"]')!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel = container.querySelector('[data-testid="teaching-skills-panel"]')!;
    const classificationInput = panel.querySelector(
      '[data-testid="teaching-skills-classification-input"]',
    ) as HTMLSelectElement;
    const primaryInput = panel.querySelector(
      '[data-testid="teaching-skills-primary-input"]',
    ) as HTMLSelectElement;
    const confirm = panel.querySelector('[data-testid="teaching-skills-confirm"]')!;
    expect(classificationInput).not.toBeNull();
    // The primary selector offers the current value plus the policy-allowed
    // alternatives — exactly the permitted set, nothing outside it.
    expect([...primaryInput.options].map((option) => option.value)).toEqual([
      'feynman-learning@v1',
      'lecture-style@v1',
    ]);
    expect(confirm).not.toBeNull();

    // A classification correction issues the policy-constrained PUT.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await act(async () => {
      classificationInput.value = 'non-instructional';
      classificationInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const put = fetchMock.mock.calls.find((call) => String(call[1]?.method) === 'PUT')!;
    expect(put[0]).toBe('/api/stages/stage-panel/teaching-skills');
    expect(put[1].body).toContain('"classification":"non-instructional"');
  });

  it('attaches above the surface layer: mounted by EditDock, never referenced under surfaces/', () => {
    const editDock = readFileSync(
      path.join(process.cwd(), 'components/edit/EditDock/EditDock.tsx'),
      'utf8',
    );
    expect(editDock).toContain("from './TeachingSkillsPanel'");
    const surfacesDir = path.join(process.cwd(), 'components/edit/surfaces');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory: () => boolean;
        path: string;
      }>) {
        const full = path.join(entry.path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.tsx') &&
          readFileSync(full, 'utf8').includes('TeachingSkillsPanel')
        ) {
          offenders.push(full);
        }
      }
    };
    walk(surfacesDir);
    expect(offenders).toEqual([]);
  });
});
