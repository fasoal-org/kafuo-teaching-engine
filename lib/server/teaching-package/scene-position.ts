/**
 * A scene's 1-based play position, the one source for every message that names a slide
 * («الشريحة 7: …»): the submit/approve gate (`lifecycle.ts`) and the package review's
 * findings (`package-review.ts`) both read it (review 21 Nov 2026 — the gate used the
 * array index and the findings `scene.order`, so they differed after a gap in `order`).
 *
 * Scenes are sorted by `order` (ties keep their array order), then numbered index + 1.
 * Pure: no I/O, no import beyond the type.
 */
export function scenePlayPositions(
  scenes: readonly { id: string; order?: number | null }[],
): Map<string, number> {
  const sorted = scenes
    .map((scene, index) => ({ id: scene.id, order: scene.order ?? 0, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index);
  return new Map(sorted.map((entry, at) => [entry.id, at + 1]));
}
