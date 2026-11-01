/**
 * A spotlight or laser Action points at one canvas element. When an editor
 * deletes that element, the Action points at nothing, and Submit's Action gate
 * refuses the package (`ACTION_REFERENCE_INVALID`). The Action has no meaning
 * without its element, so it goes with it.
 *
 * Pure: the slide edit session calls it on every write-through.
 */
import type { Action } from '@openmaic/dsl';

const ELEMENT_POINTER_TYPES: ReadonlySet<string> = new Set(['spotlight', 'laser']);

/**
 * The Actions minus every spotlight/laser whose element is not on the canvas,
 * or `null` when none is dangling (nothing to write).
 */
export function withoutDanglingElementActions(
  actions: readonly Action[] | undefined,
  elementIds: ReadonlySet<string>,
): Action[] | null {
  if (!actions?.length) return null;
  const kept = actions.filter((action) => {
    if (!ELEMENT_POINTER_TYPES.has(action.type)) return true;
    const elementId = (action as unknown as { elementId?: unknown }).elementId;
    return typeof elementId !== 'string' || elementIds.has(elementId);
  });
  return kept.length === actions.length ? null : kept;
}
