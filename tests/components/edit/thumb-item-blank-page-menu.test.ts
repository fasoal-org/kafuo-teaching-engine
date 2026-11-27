// @vitest-environment jsdom

/**
 * ED-7 (critical items before package regeneration, 27 Nov 2026): a blank page's menu
 * offers «Generate with AI» (the route that fills it) instead of Regenerate, which an
 * empty result always refuses.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { createBlankEditableScene } from '@/lib/edit/scene-defaults';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Radix menus measure with ResizeObserver and scroll items into view.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function openMenu(props: { onRegenerate?: () => void; onGenerateWithAi?: () => void }) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ThumbItem, {
        scene: createBlankEditableScene('slide', 'stage-1', 'صفحة', 1),
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
  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="slide-nav-more"]')!;
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('a blank page’s menu', () => {
  it('offers «Generate with AI», which opens the insertion, and no Regenerate', () => {
    const onGenerateWithAi = vi.fn();
    openMenu({ onGenerateWithAi });
    const item = document.querySelector<HTMLElement>('[data-testid="slide-nav-generate-with-ai"]');
    expect(item?.textContent).toBe('توليد بالذكاء الاصطناعي');
    expect(document.querySelector('[data-testid="slide-nav-regenerate"]')).toBeNull();
    act(() => item!.click());
    expect(onGenerateWithAi).toHaveBeenCalledOnce();
  });

  it('shows Regenerate only when the rail passes it (a filled page)', () => {
    openMenu({ onRegenerate: vi.fn() });
    expect(document.querySelector('[data-testid="slide-nav-regenerate"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="slide-nav-generate-with-ai"]')).toBeNull();
  });
});
