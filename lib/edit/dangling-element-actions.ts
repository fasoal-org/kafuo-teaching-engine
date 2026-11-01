/**
 * A spotlight or laser Action points at one canvas element. When a person
 * deletes that element by hand, the Action points at nothing, and Submit's
 * Action gate refuses the package (`ACTION_REFERENCE_INVALID`). The Action has
 * no meaning without its element, so it goes with it.
 *
 * Only a manual deletion does this (owner decision, 1 Nov 2026): an undo,
 * a redo, an agent edit or a layout normalization never removes an Action.
 *
 * Pure: the slide edit session calls it on its manual write-throughs.
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
