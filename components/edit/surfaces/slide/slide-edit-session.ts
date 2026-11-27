/**
 * Module-level slide-edit session — pure in-memory undo/redo for the editor
 * canvas.
 *
 * EditShell invokes a surface's `useSurfaceState()` and renders its
 * `SurfaceComponent` as siblings (state hook on the shell, canvas as a child
 * of the frame). They must share one `SlideEditHistory`, so it lives in a
 * store rather than component state — the same idiom the rest of the
 * renderer uses (useCanvasStore / useStageStore).
 *
 * Edits are written through to the canonical stage store by the canvas
 * controller (`useSlideCanvasController` in `use-slide-surface.ts`); this
 * store only tracks the undo/redo timeline of an in-progress editing
 * session. It deliberately does NOT persist to localStorage: the canonical
 * stage store is the source of truth and already auto-persists via Dexie,
 * so there is nothing "unsaved" to recover on reload — no "restore unsaved
 * changes" UX, by design.
 */

import { create } from 'zustand';
import {
  applyEditorTransaction,
  createEditorHistory,
  redoEditorTransaction,
  undoEditorTransaction,
  type EditorHistory,
  type EditorOperation,
  type EditorTransaction,
} from '@openmaic/editor/core';
import type { Action } from '@openmaic/dsl';
import {
  deletedElementIds,
  deletedNarratedImage,
  NARRATION_DELETED_IMAGE_ISSUE_CODE,
  pointerActionsOn,
  withActionsRestored,
  withoutActionsOnDeletedElements,
} from '@/lib/edit/dangling-element-actions';
import { commitSlideEdit } from '@/lib/edit/scene-edit-bridge';
import { migrateSlideContent } from '@/lib/edit/slide-schema';
import type { SlideEditHistory } from '@/lib/edit/slide-ops';
import { isStageEditingLocked, useStageStore } from '@/lib/store/stage';
import type { Scene, SlideContent } from '@/lib/types/stage';

/** How a history move reaches the stage store (see `writeThrough`). */
type WriteKind = 'manual' | 'history' | 'other';

/** ED-11: the pointer Actions one manual delete took with one element. */
interface TakenPointers {
  actions: Array<{ action: Action; index: number }>;
  /** That delete raised the deleted-image flag (D-5 A). */
  flagged: boolean;
  /** The element (and so its Actions) is away now. */
  away: boolean;
}

type GenerationIssue = NonNullable<Scene['generationIssues']>[number];

const DELETED_IMAGE_FLAG: GenerationIssue = {
  code: NARRATION_DELETED_IMAGE_ISSUE_CODE,
  message: 'The narration still describes an image that was deleted from this slide.',
};

/**
 * An AI slide insertion holds the Stage-wide editing lock
 * (reviewer-generated-slide-for-lesson-part-plan §5.1): every history move —
 * canvas gestures, toolbar ops, both editors' keyboard shortcuts, undo, redo,
 * and auto-height normalization — is refused, leaving history and the stage
 * store untouched (no dirt).
 */
const editingLocked = () => isStageEditingLocked(useStageStore.getState().stage?.id);

interface SlideEditSessionState {
  sceneId: string | null;
  history: EditorHistory | null;
  /** True while the legacy canvas holds an uncommitted pointer gesture locally. */
  gestureActive: boolean;

  /** Establish a fresh in-memory baseline for a scene. */
  seed: (sceneId: string, content: SlideContent) => void;
  /** Apply one canonical op (numeric inspectors, future affordances). */
  applyOp: (op: EditorOperation) => void;
  /** Apply a fully described editor transaction to the canonical document. */
  applyTransaction: (transaction: EditorTransaction) => void;
  /** Apply only while the transaction still belongs to the captured scene. */
  applyTransactionForScene: (sceneId: string, transaction: EditorTransaction) => void;
  /**
   * Fold a renderer-committed snapshot in. `isUserEdit` is the causal
   * discriminator: a real gesture commits synchronously inside a pointer
   * interaction, whereas the renderer's ResizeObserver normalization (text
   * auto-height) commits with no pointer gesture in flight. Non-user
   * commits update `present` only — no new undo step, so `past` is left
   * untouched (the reflow can chase a user resize and wiping the undo
   * stack would silently break undo). `future` IS cleared, though: once
   * `present` is replaced by the normalized content it has diverged from
   * whatever the redo branch pointed at, so those stale entries are no
   * longer valid continuations.
   */
  commitContent: (next: SlideContent, isUserEdit: boolean) => void;
  setGestureActive: (active: boolean) => void;
  undo: () => void;
  redo: () => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useSlideEditSession = create<SlideEditSessionState>((set, get) => {
  /**
   * Write the new canonical content through to the stage store (auto-save).
   * Single point of write-through so undo, redo, applyOp, user
   * commitContent, and ResizeObserver normalization all stay in lockstep
   * with `useStageStore`. Stage updates fire first so renderer subscribers
   * (SceneProvider reads via `currentSlideContent`) see the new content as
   * soon as React processes the next batch.
   */
  /**
   * ED-11 (critical items, 27 Nov 2026): what each manual delete of this session took
   * with its element — its spotlight/laser Actions (and whether that delete raised the
   * deleted-image flag) — so an undo that brings the element back brings them back, and
   * a redo of the delete takes them again. Cleared with the session (seed / end).
   */
  let taken = new Map<string, TakenPointers>();

  const withFlag = (issues: readonly GenerationIssue[], on: boolean): GenerationIssue[] => {
    const rest = issues.filter((issue) => issue.code !== NARRATION_DELETED_IMAGE_ISSUE_CODE);
    return on ? [...rest, DELETED_IMAGE_FLAG] : rest;
  };

  /** An undo or a redo: the Actions its manual deletes took go back, or away again. */
  const historyWrite = (sceneId: string, previous: SlideContent, next: SlideContent) => {
    const store = useStageStore.getState();
    const scene = store.scenes?.find((candidate) => candidate.id === sceneId);
    const back = deletedElementIds(next.canvas.elements, previous.canvas.elements);
    const gone = deletedElementIds(previous.canvas.elements, next.canvas.elements);
    let actions = scene?.actions;
    let changed = false;
    for (const id of back) {
      const entry = taken.get(id);
      if (!entry?.away) continue;
      actions = withActionsRestored(actions, entry.actions);
      entry.away = false;
      changed = true;
    }
    for (const id of gone) {
      const entry = taken.get(id);
      if (!entry || entry.away) continue;
      const ids = new Set(entry.actions.map(({ action }) => action.id));
      actions = (actions ?? []).filter((action) => !ids.has(action.id));
      entry.away = true;
      changed = true;
    }
    if (!changed) {
      store.updateScene(sceneId, { content: next });
      return;
    }
    // The deleted-image flag a delete raised stands exactly while one such image is away.
    const raised = [...taken.values()].filter((entry) => entry.flagged);
    const issues = scene?.generationIssues ?? [];
    const flagNow = raised.some((entry) => entry.away);
    const flagShown = issues.some((issue) => issue.code === NARRATION_DELETED_IMAGE_ISSUE_CODE);
    const nextIssues =
      raised.length > 0 && flagNow !== flagShown ? withFlag(issues, flagNow) : null;
    store.updateScene(sceneId, {
      content: next,
      actions: actions ?? [],
      ...(nextIssues ? { generationIssues: nextIssues.length > 0 ? nextIssues : undefined } : {}),
    });
  };

  /**
   * `manual`: a person's own canvas/toolbar edit; `history`: an undo or a redo;
   * `other`: an agent edit or a reflow.
   */
  const writeThrough = (next: SlideContent, kind: WriteKind = 'other') => {
    const { sceneId, history } = get();
    if (!sceneId) return;
    const store = useStageStore.getState();
    if (kind === 'history' && history) {
      historyWrite(sceneId, history.present, next);
      return;
    }
    if (kind !== 'manual' || !history) {
      store.updateScene(sceneId, { content: next });
      return;
    }
    const scene = store.scenes?.find((candidate) => candidate.id === sceneId);
    const deletedIds = deletedElementIds(history.present.canvas.elements, next.canvas.elements);
    // An element a person deletes takes its spotlight/laser Actions with it;
    // otherwise Submit refuses the package for an Action pointing at nothing.
    const actions = withoutActionsOnDeletedElements(scene?.actions, deletedIds);
    // The speech still describes a deleted image the narration pointed at
    // (D-5 A): flag the slide until its narration is regenerated or dismissed.
    // Read BEFORE the pointers are removed — they are the signal.
    const issues = scene?.generationIssues ?? [];
    const flag =
      deletedNarratedImage(history.present.canvas.elements, deletedIds, scene?.actions) &&
      !issues.some((issue) => issue.code === NARRATION_DELETED_IMAGE_ISSUE_CODE);
    if (actions) {
      // ED-11: kept for an undo; a later manual delete of a restored element records anew.
      const images = new Set(
        history.present.canvas.elements
          .filter((element) => element.type === 'image')
          .map((element) => element.id),
      );
      for (const [id, pointers] of pointerActionsOn(scene?.actions, deletedIds)) {
        taken.set(id, { actions: pointers, flagged: flag && images.has(id), away: true });
      }
    }
    store.updateScene(sceneId, {
      content: next,
      ...(actions ? { actions } : {}),
      ...(flag ? { generationIssues: [...issues, DELETED_IMAGE_FLAG] } : {}),
    });
  };

  const replace = (history: EditorHistory, kind: WriteKind = 'other') => {
    const { history: prev } = get();
    if (history === prev || editingLocked()) return;
    writeThrough(history.present, kind);
    set({ history });
  };

  const kindOf = (transaction: EditorTransaction): WriteKind =>
    transaction.origin === 'canvas' || transaction.origin === 'toolbar' ? 'manual' : 'other';

  return {
    sceneId: null,
    history: null,
    gestureActive: false,

    seed: (sceneId, content) => {
      // Adopt the live scene content as the in-memory baseline. We do NOT
      // write-through here: if the user makes no edits, the stage store
      // shouldn't receive a redundant write. Any schema migration the
      // first user edit triggers will naturally flow back through
      // commitContent's writeThrough.
      taken = new Map();
      set({
        sceneId,
        history: createEditorHistory(migrateSlideContent(content)),
        gestureActive: false,
      });
    },

    applyOp: (op) => {
      const { history } = get();
      if (!history) return;
      // Legacy toolbar actions may arrive after their selected element was
      // deleted. Keep that one-operation UI path a silent no-op as before;
      // explicit transactions remain strict so callers cannot hide invalid
      // batch operations behind this compatibility behavior.
      if (
        'elementId' in op &&
        !history.present.canvas.elements.some((element) => element.id === op.elementId)
      ) {
        return;
      }
      replace(
        applyEditorTransaction(history, {
          origin: 'toolbar',
          history: 'record',
          operations: [op],
        }),
        'manual',
      );
    },

    applyTransaction: (transaction) => {
      const { history } = get();
      if (!history) return;
      replace(applyEditorTransaction(history, transaction), kindOf(transaction));
    },

    applyTransactionForScene: (sceneId, transaction) => {
      const { history, sceneId: currentSceneId } = get();
      if (!history || currentSceneId !== sceneId) return;
      replace(applyEditorTransaction(history, transaction), kindOf(transaction));
    },

    commitContent: (next, isUserEdit) => {
      const { history } = get();
      if (!history) return;
      if (!isUserEdit) {
        // ResizeObserver / auto-height normalization: don't push an undo
        // step (the reflow can chase a user resize and wiping `past` would
        // silently break undo), but DO write through — the auto-fit height
        // IS the new canonical state. Clear `future`, though: `present` now
        // holds the normalized content, which has diverged from whatever
        // the redo branch pointed at, so replaying those stale entries
        // would discard this normalization. Leaving them would let a later
        // redo silently revert to pre-undo content (canvas/store divergence).
        if (editingLocked()) return;
        writeThrough(next);
        set({ history: { ...history, present: next, future: [] } });
        return;
      }
      // The legacy Canvas still emits complete snapshots while the renderer
      // editor is feature-flagged. Keep this compatibility bridge isolated
      // to that fallback until its React surface moves into @openmaic/editor.
      replace(
        commitSlideEdit(history as unknown as SlideEditHistory, next) as unknown as EditorHistory,
        'manual',
      );
    },

    setGestureActive: (gestureActive) => set({ gestureActive }),

    undo: () => {
      const { history } = get();
      if (!history) return;
      replace(undoEditorTransaction(history), 'history');
    },

    redo: () => {
      const { history } = get();
      if (!history) return;
      replace(redoEditorTransaction(history), 'history');
    },

    end: () => {
      taken = new Map();
      set({ sceneId: null, history: null, gestureActive: false });
    },
  };
});
