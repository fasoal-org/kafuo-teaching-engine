/**
 * ED-11 (critical items before package regeneration, 27 Nov 2026): the Delete key did
 * nothing on a selected text box — only the toolbar's trash deleted it. The legacy
 * canvas had no key handler at all.
 *
 * Delete (or Backspace, the Mac's delete key) deletes the selected elements, but only
 * when the key is not editing text: never inside an input, a textarea, a select or
 * editable text (a text box being typed in keeps its caret and its own Delete), never
 * with a modifier and never mid-composition (an IME). Whether the canvas has a selection
 * is the caller's to check.
 */

/** Whether `target` takes the key for its own text editing. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return (
    element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  );
}

export function isElementDeleteKey(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented' | 'isComposing' | 'target'
  >,
  activeElement: Element | null,
): boolean {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isTextEditingTarget(event.target) && !isTextEditingTarget(activeElement);
}
