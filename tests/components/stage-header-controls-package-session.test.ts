// @vitest-environment jsdom

/**
 * Owner, 21 Nov 2026: a Teaching Package classroom opened from the admin panel
 * (an editor-grant session, marked by the readable `teaching_package_learner_key`
 * cookie) hides the stage header's theme picker and settings button. Every other
 * classroom keeps both.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));
vi.mock('@/lib/store', () => ({
  useStageStore: (select: (state: unknown) => unknown) =>
    select({ scenes: [], generatingOutlines: [], failedOutlines: [] }),
}));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: (select: (state: unknown) => unknown) => select({ tasks: {} }),
}));
vi.mock('@/lib/store/video-render', () => ({
  useVideoRenderStore: (select: (state: unknown) => unknown) =>
    select({ status: 'idle', percent: 0 }),
}));
vi.mock('@/lib/export/use-export-pptx', () => ({
  useExportPPTX: () => ({ exporting: false, exportPPTX: vi.fn(), exportResourcePack: vi.fn() }),
}));
vi.mock('@/lib/export/use-export-classroom', () => ({
  useExportClassroom: () => ({ exporting: false, exportClassroomZip: vi.fn() }),
}));
vi.mock('@/lib/export/use-export-script', () => ({
  isScriptExportReady: () => false,
  useExportScript: () => ({ exporting: false, exportScriptDocx: vi.fn(), exportScriptMd: vi.fn() }),
}));
vi.mock('@/lib/config/feature-flags', () => ({ isVideoExportEnabled: () => false }));
vi.mock('@/components/stage/video-export-dialog', () => ({ VideoExportDialog: () => null }));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));

import { HeaderControls } from '@/components/stage/header-controls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEARNER_COOKIE = 'teaching_package_learner_key';
const mounted: Array<{ root: Root; host: HTMLElement }> = [];

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(HeaderControls, {}));
  });
  mounted.push({ root, host });
  return host;
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  document.cookie = `${LEARNER_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
});

describe('HeaderControls in a Teaching Package classroom', () => {
  it('keeps the theme picker and the settings button outside a package classroom', async () => {
    const host = await render();
    expect(host.querySelector('[aria-label="settings.theme"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="settings.title"]')).not.toBeNull();
  });

  it('hides both in an editor-grant session', async () => {
    document.cookie = `${LEARNER_COOKIE}=${encodeURIComponent('tp:session-key')}; path=/`;
    const host = await render();
    expect(host.querySelector('[aria-label="settings.theme"]')).toBeNull();
    expect(host.querySelector('[aria-label="settings.title"]')).toBeNull();
  });
});
