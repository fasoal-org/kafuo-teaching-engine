'use client';

import { useEffect, useRef } from 'react';
import Canvas from '@/components/slide-renderer/Editor/Canvas';
import { SpotlightOverlay } from '@/components/slide-renderer/Editor/SpotlightOverlay';
import { LaserPointerOverlay } from '@/components/slide-renderer/Editor/LaserPointerOverlay';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { isEditorRendererEnabled } from '@/lib/config/feature-flags';
import { useCanvasStore } from '@/lib/store/canvas';
import { AnchoredTextBar } from './AnchoredTextBar';
import { AnchoredElementBar } from './AnchoredElementBar';
import { ElementPickLayer } from './ElementPickLayer';
import { ElementRefPinLayer } from './ElementRefPinLayer';
import { EDITABLE_ELEMENT_ID_PREFIX } from './renderer-element-dom';
import {
  deleteSelectedSlideElements,
  useEditingTextElementId,
  useSelectedNonTextElement,
  useSlideCanvasController,
  useSyncEditingElementId,
} from './use-slide-surface';
import { isElementDeleteKey, isTextEditingTarget } from './delete-key';
import { RendererEditorCanvas } from './RendererEditorCanvas';

/** Switches between the preserved legacy editor and the renderer editor. */
export function SlideCanvas() {
  const { controller, gestureProps } = useSlideCanvasController();
  const useRendererEditor = isEditorRendererEnabled();
  const requestedEditingElementId = useCanvasStore.use.editingElementId();
  const editingElementId = useEditingTextElementId(
    useRendererEditor ? requestedEditingElementId : undefined,
  );
  const nonTextElement = useSelectedNonTextElement();
  useSyncEditingElementId(editingElementId, !useRendererEditor);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const canvas = useCanvasStore.getState();
      if (canvas.creatingElement) canvas.setCreatingElement(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ED-11 (critical items, 27 Nov 2026): the Delete key deletes the selected elements on
  // the legacy canvas (it had no key handler; only the toolbar's trash worked). Escape
  // in a text box being typed in leaves the typing and keeps the box selected, so Delete
  // then deletes the box — while typing, Delete still edits the text.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (useRendererEditor) return;
    // Only for the canvas: the teacher's last press was on it (review: a click on an
    // empty spot of another pane leaves the focus on <body> too).
    let lastPressOnCanvas = false;
    const onPointerDown = (event: PointerEvent) => {
      lastPressOnCanvas = Boolean(
        event.target instanceof Node && rootRef.current?.contains(event.target),
      );
    };
    const handler = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (event.key === 'Escape' && active instanceof HTMLElement) {
        if (isTextEditingTarget(active) && active.closest('.editable-element-text')) active.blur();
        return;
      }
      // A key pressed in a dialog, the rail or a toolbar is theirs.
      const focusOnCanvas =
        !active || active === document.body || Boolean(rootRef.current?.contains(active));
      if (!lastPressOnCanvas || !focusOnCanvas || !isElementDeleteKey(event, active)) return;
      const canvas = useCanvasStore.getState();
      // Never mid-crop or while an element picker is armed.
      if (canvas.activeElementIdList.length === 0 || canvas.clipingImageElementId) return;
      if (canvas.pickTarget) return;
      if (deleteSelectedSlideElements()) event.preventDefault();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', handler);
    };
  }, [useRendererEditor]);

  return (
    // `dir="ltr"`: elements and overlays sit at absolute coordinates, which an RTL page
    // (Arabic UI) must not mirror. The slide's own text keeps the direction it sets.
    <div ref={rootRef} dir="ltr" className="relative h-full w-full" {...gestureProps}>
      <SceneProvider controller={controller}>
        {useRendererEditor ? <RendererEditorCanvas /> : <Canvas />}
        <SpotlightOverlay domIdPrefix={EDITABLE_ELEMENT_ID_PREFIX} />
        <LaserPointerOverlay domIdPrefix={EDITABLE_ELEMENT_ID_PREFIX} />
      </SceneProvider>
      {!useRendererEditor && <AnchoredTextBar editingElementId={editingElementId} />}
      {!useRendererEditor && <AnchoredElementBar element={nonTextElement} />}
      <ElementRefPinLayer />
      <ElementPickLayer />
    </div>
  );
}
