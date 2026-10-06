// @vitest-environment jsdom

/**
 * The red generation-issue card on a rail thumbnail
 * (scene-narration-audio-regeneration-plan C7): the remedy follows the issue —
 * missing audio offers "Regenerate audio", any other issue offers regenerating
 * the slide or quiz, and both are offered when both kinds are present.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AR = JSON.parse(
  readFileSync(resolve(__dirname, '../../../lib/i18n/locales/ar-SA.json'), 'utf8'),
) as Record<string, unknown>;

function translate(key: string, options?: Record<string, unknown>): string {
  let value: unknown = AR;
  for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  if (typeof value !== 'string') return String(options?.defaultValue ?? key);
  return value;
}

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: translate, locale: 'ar-SA', setLocale: () => {} }),
}));
vi.mock('motion/react', () => ({
  Reorder: {
    Item: ({ children }: { children: ReactNode }) => createElement('li', null, children),
  },
}));
vi.mock('@/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: () => null,
}));
vi.mock('@/lib/hooks/use-near-viewport', () => ({ useNearViewport: () => false }));

import { ThumbItem } from '@/components/edit/SlideNavRail/ThumbItem';
import type { Scene } from '@/lib/types/stage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const AUDIO = { code: 'NARRATION_AUDIO_FAILED', message: 'narration audio could not be generated' };
const OTHER = { code: 'SPEECH_REGISTER_NONCOMPLIANT', message: 'register' };

function quiz(issues: Array<{ code: string; message: string }>): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'quiz',
    title: 'اختبار',
    order: 1,
    content: { type: 'quiz', questions: [] },
    actions: [{ id: 'a1', type: 'speech', text: 'نص' }],
    generationIssues: issues,
  } as unknown as Scene;
}

function mount(props: {
  scene: Scene;
  onRegenerate?: () => void;
  onRegenerateAudio?: () => void;
  regeneratingAudio?: boolean;
}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ThumbItem, {
        index: 0,
        active: false,
        canDelete: true,
        onActivate: () => {},
        onDuplicate: () => {},
        onDelete: () => {},
        ...props,
      }),
    ),
  );
  return host;
}

const audioButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[data-testid="scene-generation-issue-regenerate-audio"]');
const regenerateButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[data-testid="scene-generation-issue-regenerate"]');

describe('ThumbItem generation-issue card', () => {
  it('missing audio only: one "Regenerate audio" button, in Arabic, that calls the audio remedy', () => {
    const onRegenerateAudio = vi.fn();
    const host = mount({ scene: quiz([AUDIO]), onRegenerate: vi.fn(), onRegenerateAudio });
    expect(regenerateButton(host)).toBeNull();
    expect(audioButton(host)?.textContent).toBe('إعادة توليد الصوت');
    expect(host.textContent).toContain('لم يُولَّد صوت المعلّم');
    act(() => audioButton(host)!.click());
    expect(onRegenerateAudio).toHaveBeenCalledOnce();
  });

  it('another issue only: the regenerate-quiz button, no audio button', () => {
    const host = mount({ scene: quiz([OTHER]), onRegenerate: vi.fn(), onRegenerateAudio: vi.fn() });
    expect(audioButton(host)).toBeNull();
    expect(regenerateButton(host)?.textContent).toBe('إعادة توليد الاختبار');
  });

  it('both issues: both buttons', () => {
    const host = mount({
      scene: quiz([OTHER, AUDIO]),
      onRegenerate: vi.fn(),
      onRegenerateAudio: vi.fn(),
    });
    expect(audioButton(host)).not.toBeNull();
    expect(regenerateButton(host)).not.toBeNull();
  });

  it('while running: the audio button is disabled and says so', () => {
    const host = mount({
      scene: quiz([AUDIO]),
      onRegenerateAudio: vi.fn(),
      regeneratingAudio: true,
    });
    expect(audioButton(host)?.disabled).toBe(true);
    expect(audioButton(host)?.textContent).toBe('جارٍ توليد الصوت…');
  });

  it('without the gate (read grant / locked package): no buttons', () => {
    const host = mount({ scene: quiz([AUDIO, OTHER]) });
    expect(audioButton(host)).toBeNull();
    expect(regenerateButton(host)).toBeNull();
  });
});
