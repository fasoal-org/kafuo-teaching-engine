/**
 * A spotlight or laser Action points at one canvas element. When a person
 * deletes that element by hand, the Action points at nothing, and Submit's
 * Action gate refuses the package (`ACTION_REFERENCE_INVALID`). The Action has
 * no meaning without its element, so it goes with it.
 *
 * Only a manual deletion does this (owner decision, 1 Nov 2026): an undo,
 * a redo, an agent edit or a layout normalization never removes an Action.
 *
 * Pure: the slide edit session calls these on its manual write-throughs.
 */
import type { Action } from '@openmaic/dsl';

const ELEMENT_POINTER_TYPES: ReadonlySet<string> = new Set(['spotlight', 'laser']);

/** The ids on `previous` that `next` no longer has. */
export function deletedElementIds(
  previous: readonly { id: string }[],
  next: readonly { id: string }[],
): Set<string> {
  const kept = new Set(next.map((element) => element.id));
  return new Set(previous.map((element) => element.id).filter((id) => !kept.has(id)));
}

/**
 * The marker a manual image delete leaves on its slide (D-5 A, 2 Nov 2026):
 * the spotlight/laser went with the image, but the speech Actions still
 * describe it. Stored as a `generationIssues` entry, so it persists with the
 * scene, a successful narration (or slide) regeneration builds the scene
 * without it, and the reviewer may dismiss it.
 */
export const NARRATION_DELETED_IMAGE_ISSUE_CODE = 'NARRATION_DESCRIBES_DELETED_IMAGE';

/**
 * Whether a deleted element was an image the narration pointed at — the
 * reliable signal that the speech describes it: a spotlight/laser on it.
 */
export function deletedNarratedImage(
  previous: readonly { id: string; type?: string }[],
  deletedIds: ReadonlySet<string>,
  actions: readonly Action[] | undefined,
): boolean {
  if (!actions?.length || deletedIds.size === 0) return false;
  const deletedImages = new Set(
    previous
      .filter((element) => element.type === 'image' && deletedIds.has(element.id))
      .map((element) => element.id),
  );
  if (deletedImages.size === 0) return false;
  return actions.some((action) => {
    if (!ELEMENT_POINTER_TYPES.has(action.type)) return false;
    const elementId = (action as unknown as { elementId?: unknown }).elementId;
    return typeof elementId === 'string' && deletedImages.has(elementId);
  });
}

/**
 * The Actions minus every spotlight/laser on a deleted element, or `null` when
 * none points at one (nothing to write).
 */
export function withoutActionsOnDeletedElements(
  actions: readonly Action[] | undefined,
  deletedIds: ReadonlySet<string>,
): Action[] | null {
  if (!actions?.length || deletedIds.size === 0) return null;
  const kept = actions.filter((action) => {
    if (!ELEMENT_POINTER_TYPES.has(action.type)) return true;
    const elementId = (action as unknown as { elementId?: unknown }).elementId;
    return typeof elementId !== 'string' || !deletedIds.has(elementId);
  });
  return kept.length === actions.length ? null : kept;
}
