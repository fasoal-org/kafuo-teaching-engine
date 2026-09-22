/**
 * Post-generation enforcement of a slide's planned visual (RSS 7.5.7). For the
 * lesson opening the generator must end in exactly one of two recorded states:
 * a visual is PRESENT (an image, or a native visual composition), or its
 * omission was JUSTIFIED by the planner. A bare opening is never shipped and
 * never merely logged.
 */
import type { PPTElement } from '@openmaic/dsl';
import type { VisualPlan } from './outline-types.js';

export const ORIENTATION_VISUAL_MISSING = 'ORIENTATION_VISUAL_MISSING';

/** A planned visual is still absent after the bounded regeneration. */
export class OrientationVisualMissingError extends Error {
  readonly code = ORIENTATION_VISUAL_MISSING;
  constructor(title: string, detail: string) {
    super(`${ORIENTATION_VISUAL_MISSING}: slide ${JSON.stringify(title)} — ${detail}`);
    this.name = 'OrientationVisualMissingError';
  }
}

/** Elements that can form a native visual composition. */
const NATIVE_VISUAL_TYPES: readonly string[] = ['shape', 'line', 'chart', 'table', 'latex'];

/**
 * Why the planned visual is missing from the built canvas, or `undefined` when
 * the plan is satisfied (or there is nothing to enforce). A native composition
 * always satisfies an `image` plan — it is the sanctioned fallback when no
 * approved image is available.
 */
export function plannedVisualIssue(
  plan: VisualPlan | undefined,
  elements: readonly PPTElement[],
): string | undefined {
  if (!plan || plan.mode === 'omitted') return undefined;
  const types = elements.map((element) => element.type as string);
  if (types.includes('image') || types.includes('video')) return undefined;
  if (types.includes('chart')) return undefined;
  const nativeCount = types.filter((type) => NATIVE_VISUAL_TYPES.includes(type)).length;
  if (nativeCount >= 3) return undefined;
  return plan.mode === 'image'
    ? 'the planned image is absent and no native visual composition replaces it'
    : 'the planned native visual composition is absent';
}

/** The edit directive that asks for the native-elements fallback. */
export const NATIVE_VISUAL_DIRECTIVE =
  'This slide must carry ONE meaningful supporting visual and currently has none. No image is available. Add a visual composed from native slide elements — a simple diagram, a chart, or an illustrative group of shapes and lines with short labels — that expresses the slide’s hook, context or big idea. Do not use any image or video element. Keep all existing teaching content.';
