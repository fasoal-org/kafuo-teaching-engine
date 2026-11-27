// @vitest-environment jsdom

/**
 * ED-11 (critical items before package regeneration, 27 Nov 2026): the legacy slide
 * canvas deletes its selection on Delete/Backspace — only after a press on the canvas,
 * never while typing, mid-crop or with an element picker armed, and never for a key
 * pressed elsewhere. Escape in a text box being typed in leaves the typing.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  canvas: {
    activeElementIdList: ['text-1'] as string[],
    clipingImageElementId: '',
    pickTarget: null as unknown,
    creatingElement: null,
    setCreatingElement: () => {},
  },
  deleteSelected: vi.fn(() => true),
}));

vi.mock('@/lib/config/feature-flags', () => ({ isEditorRendererEnabled: () => false }));
vi.mock('@/components/slide-renderer/Editor/Canvas', () => ({
  default: () =>
    createElement(
      'div',
      { 'data-testid': 'legacy-canvas' },
      createElement(
        'div',
        { className: 'editable-element-text' },
        createElement('div', { contentEditable: true, 'data-testid': 'text-editor' }),
      ),
    ),
}));
vi.mock('@/components/slide-renderer/Editor/SpotlightOverlay', () => ({
  SpotlightOverlay: () => null,
}));
vi.mock('@/components/slide-renderer/Editor/LaserPointerOverlay', () => ({
  LaserPointerOverlay: () => null,
}));
vi.mock('@/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/edit/surfaces/slide/AnchoredTextBar', () => ({
  AnchoredTextBar: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/AnchoredElementBar', () => ({
  AnchoredElementBar: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/ElementPickLayer', () => ({
  ElementPickLayer: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/ElementRefPinLayer', () => ({
  ElementRefPinLayer: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/RendererEditorCanvas', () => ({
  RendererEditorCanvas: () => null,
}));
vi.mock('@/components/edit/surfaces/slide/use-slide-surface', () => ({
  useSlideCanvasController: () => ({ controller: {}, gestureProps: {} }),
  useEditingTextElementId: () => undefined,
  useSelectedNonTextElement: () => null,
  useSyncEditingElementId: () => undefined,
  deleteSelectedSlideElements: state.deleteSelected,
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: { editingElementId: () => '' },
    getState: () => state.canvas,
  },
}));

import { SlideCanvas } from '@/components/edit/surfaces/slide/SlideCanvas';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let outside: HTMLButtonElement;

beforeEach(() => {
  state.deleteSelected.mockClear();
  state.canvas.activeElementIdList = ['text-1'];
  state.canvas.clipingImageElementId = '';
  state.canvas.pickTarget = null;
  const host = document.createElement('div');
  outside = document.createElement('button');
  document.body.append(host, outside);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(SlideCanvas)));
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const canvas = () => document.querySelector<HTMLElement>('[data-testid="legacy-canvas"]')!;
const press = (target: Element) =>
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }) as PointerEvent);
const key = (name: string, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

describe('the legacy slide canvas Delete key', () => {
  it('deletes the selection after a press on the canvas, and takes the key', () => {
    press(canvas());
    const event = key('Delete');
    expect(state.deleteSelected).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    key('Backspace');
    expect(state.deleteSelected).toHaveBeenCalledTimes(2);
  });

  it('ignores a key after a press elsewhere, or with the focus elsewhere', () => {
    press(outside);
    key('Delete');
    press(canvas());
    outside.focus();
    key('Delete', outside);
    expect(state.deleteSelected).not.toHaveBeenCalled();
  });

  it('never while typing in a text box, mid-crop, with a picker armed or with nothing selected', () => {
    const editor = document.querySelector<HTMLElement>('[data-testid="text-editor"]')!;
    press(editor);
    editor.focus();
    key('Delete', editor);
    editor.blur();
    press(canvas());
    state.canvas.clipingImageElementId = 'img-1';
    key('Delete');
    state.canvas.clipingImageElementId = '';
    state.canvas.pickTarget = { kind: 'cue' };
    key('Delete');
    state.canvas.pickTarget = null;
    state.canvas.activeElementIdList = [];
    key('Delete');
    expect(state.deleteSelected).not.toHaveBeenCalled();
  });

  it('Escape in a text box being typed in leaves the typing', () => {
    const editor = document.querySelector<HTMLElement>('[data-testid="text-editor"]')!;
    editor.focus();
    expect(document.activeElement).toBe(editor);
    key('Escape', editor);
    expect(document.activeElement).not.toBe(editor);
  });
});
