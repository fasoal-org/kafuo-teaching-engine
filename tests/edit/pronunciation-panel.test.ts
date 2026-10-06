// @vitest-environment jsdom
/**
 * The reviewer Pronunciation surfaces (plan §16.3) render only while the
 * server's scientific mode is active and only for viewers who may edit.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ mode: 'off' as string, mayEdit: true }));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ scientificSpeechMode: state.mode }),
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (s: unknown) => unknown) =>
    selector({ stage: { id: 'stage-1' }, setSpeechReadingMode: () => {} }),
}));
vi.mock('@/lib/classroom/generation-permission', () => ({ useMayGenerateForStage: () => state.mayEdit }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { PronunciationPanel, SpeechReadingModeSetting } from '@/components/edit/ActionsBar/PronunciationPanel';

function render(): HTMLElement {
  const host = document.createElement('div');
  act(() => {
    createRoot(host).render(
      createElement('div', null, createElement(PronunciationPanel, { actionId: 'a1' }), createElement(SpeechReadingModeSetting)),
    );
  });
  return host;
}

describe('Pronunciation surfaces gating', () => {
  it('hidden with the flag off', () => {
    state.mode = 'off';
    state.mayEdit = true;
    expect(render().querySelector('[data-testid]')).toBeNull();
  });

  it('hidden for a viewer who may not edit (learner/preview)', () => {
    state.mode = 'on';
    state.mayEdit = false;
    expect(render().querySelector('[data-testid]')).toBeNull();
  });

  it('shown to an editor with the flag on', () => {
    state.mode = 'on';
    state.mayEdit = true;
    const host = render();
    expect(host.querySelector('[data-testid="pronunciation-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="speech-reading-mode"]')).not.toBeNull();
  });
});
