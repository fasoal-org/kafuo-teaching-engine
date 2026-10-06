// @vitest-environment jsdom
/**
 * AS-012 (web): the learner can tell the narration voice is AI-generated —
 * a persistent label next to the sound control and a one-time dismissible
 * notice, only when the scene has generated audio (D-3).
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ mode: 'on' as string, audioId: 'ast_1' as string | undefined }));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ scientificSpeechMode: state.mode }),
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (s: unknown) => unknown) =>
    selector({
      currentSceneId: 'sc',
      scenes: [{ id: 'sc', actions: [{ id: 'a', type: 'speech', text: 'x', audioId: state.audioId }] }],
    }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { AI_VOICE_NOTICE_KEY, AiVoiceDisclosure } from '@/components/canvas/ai-voice-disclosure';

function render(): HTMLElement {
  const host = document.createElement('div');
  act(() => createRoot(host).render(createElement(AiVoiceDisclosure)));
  return host;
}

beforeEach(() => {
  window.localStorage.clear();
  state.mode = 'on';
  state.audioId = 'ast_1';
});

describe('web AI-voice disclosure (FR-034, AS-012)', () => {
  it('shows the label and the first-play notice; dismissal is remembered on this device', () => {
    const host = render();
    expect(host.textContent).toContain('aiVoice.label');
    expect(host.querySelector('[data-testid="ai-voice-notice"]')?.textContent).toContain('aiVoice.notice');
    act(() => (host.querySelector('[data-testid="ai-voice-notice"] button') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="ai-voice-notice"]')).toBeNull();
    expect(window.localStorage.getItem(AI_VOICE_NOTICE_KEY)).toBe('1');
    const again = render();
    expect(again.textContent).toContain('aiVoice.label');
    expect(again.querySelector('[data-testid="ai-voice-notice"]')).toBeNull();
  });

  it('is not shown for captions-only playback (no generated audio)', () => {
    state.audioId = undefined;
    expect(render().querySelector('[data-testid="ai-voice-disclosure"]')).toBeNull();
  });

  it('is not shown with the scientific flag off (DEC-033)', () => {
    state.mode = 'off';
    expect(render().querySelector('[data-testid="ai-voice-disclosure"]')).toBeNull();
  });
});
