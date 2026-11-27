// @vitest-environment jsdom

/**
 * ED-11 (critical items before package regeneration, 27 Nov 2026): the Delete key on a
 * selected element (a text box included) deletes it, the same manual delete as the
 * toolbar's trash; a text box being typed in keeps its own Delete. Undo and redo name
 * themselves for assistive technology.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isElementDeleteKey } from '@/components/edit/surfaces/slide/delete-key';
import { deleteSelectedSlideElements } from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { useCanvasStore } from '@/lib/store/canvas';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { SlideContent } from '@/lib/types/stage';

const key = (
  init: Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>> & {
    target?: EventTarget | null;
  },
) => ({
  key: 'Delete',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  isComposing: false,
  target: document.body as EventTarget | null,
  ...init,
});

describe('isElementDeleteKey', () => {
  it('takes Delete and Backspace on the canvas', () => {
    expect(isElementDeleteKey(key({}), document.body)).toBe(true);
    expect(isElementDeleteKey(key({ key: 'Backspace' }), document.body)).toBe(true);
    expect(isElementDeleteKey(key({ key: 'a' }), document.body)).toBe(false);
  });

  it('never while text is being typed, with a modifier or mid-composition', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const inner = document.createElement('p');
    editor.append(inner);
    const input = document.createElement('input');
    document.body.append(editor, input);
    try {
      expect(isElementDeleteKey(key({ target: inner }), editor)).toBe(false);
      expect(isElementDeleteKey(key({ target: input }), input)).toBe(false);
      expect(isElementDeleteKey(key({}), editor)).toBe(false);
      expect(isElementDeleteKey(key({ metaKey: true }), document.body)).toBe(false);
      expect(isElementDeleteKey(key({ ctrlKey: true }), document.body)).toBe(false);
      expect(isElementDeleteKey(key({ isComposing: true }), document.body)).toBe(false);
    } finally {
      editor.remove();
      input.remove();
    }
  });
});

describe('deleteSelectedSlideElements', () => {
  function content(): SlideContent {
    const slide = createDefaultSlide('slide-1');
    slide.elements.push(createDefaultTextElement('text-1'), createDefaultTextElement('text-2'));
    const locked = createDefaultTextElement('text-locked');
    slide.elements.push({ ...locked, lock: true });
    return { type: 'slide', canvas: slide };
  }
  const ids = () =>
    useSlideEditSession.getState().history!.present.canvas.elements.map((e) => e.id);

  beforeEach(() => {
    useSlideEditSession.getState().seed('scene-1', content());
    useCanvasStore.getState().setActiveElementIdList([]);
    useCanvasStore.getState().setActiveGroupElementId('');
  });
  afterEach(() => useSlideEditSession.getState().end());

  it('deletes the selected text boxes in one undo step and clears the selection', () => {
    useCanvasStore.getState().setActiveElementIdList(['text-1', 'text-2']);
    expect(deleteSelectedSlideElements()).toBe(true);
    expect(ids()).toEqual(['text-locked']);
    expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
    useSlideEditSession.getState().undo();
    expect(ids()).toEqual(['text-1', 'text-2', 'text-locked']);
  });

  it('keeps a locked element and does nothing without a selection', () => {
    useCanvasStore.getState().setActiveElementIdList(['text-locked']);
    expect(deleteSelectedSlideElements()).toBe(false);
    useCanvasStore.getState().setActiveElementIdList([]);
    expect(deleteSelectedSlideElements()).toBe(false);
    expect(ids()).toEqual(['text-1', 'text-2', 'text-locked']);
  });

  it('inside a group deletes only the selected member', () => {
    useCanvasStore.getState().setActiveElementIdList(['text-1', 'text-2']);
    useCanvasStore.getState().setActiveGroupElementId('text-2');
    expect(deleteSelectedSlideElements()).toBe(true);
    expect(ids()).toEqual(['text-1', 'text-locked']);
  });
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'en-US', setLocale: () => {} }),
}));

describe('the command bar', () => {
  const roots: Root[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('names undo and redo for assistive technology', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const { CommandBar } = await import('@/components/edit/EditShell/CommandBar');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(CommandBar, {
            title: 'Slide',
            history: { canUndo: true, canRedo: false, undo: vi.fn(), redo: vi.fn() },
          }),
        ),
      ),
    );
    expect(document.querySelector('[aria-label="edit.undo"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="edit.redo"]')).not.toBeNull();
  });

  it('the legacy canvas listens for the Delete key, beside its Escape handler', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/edit/surfaces/slide/SlideCanvas.tsx'),
      'utf8',
    );
    expect(source).toContain('isElementDeleteKey(event, active)');
    expect(source).toContain('deleteSelectedSlideElements()');
  });
});
