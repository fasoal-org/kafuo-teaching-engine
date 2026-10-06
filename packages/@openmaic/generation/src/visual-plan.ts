/**
 * Post-generation enforcement of a slide's planned visual (RSS 7.5.7). For the
 * lesson opening the generator must end in exactly one of two recorded states:
 * a visual is PRESENT (an image, or a native visual composition), or its
 * omission was JUSTIFIED by the planner. A bare opening is never shipped and
 * never merely logged.
 */
import type { PPTElement } from '@openmaic/dsl';
import type { ImageMapping, PdfImage, VisualPlan } from './outline-types.js';

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

/**
 * A selected textbook visual is a stronger contract than a generic image
 * plan: one of the exact, pre-authorised source images assigned to this slide
 * must survive onto the canvas. An AI placeholder or unrelated image cannot
 * satisfy it merely by having `type: "image"`.
 */
export function requiredSourceVisualIssue(
  assignedImages: readonly PdfImage[] | undefined,
  imageMapping: ImageMapping | undefined,
  elements: readonly PPTElement[],
): string | undefined {
  if (!assignedImages?.length) return undefined;
  const requiredSources = new Set(
    assignedImages
      .map((image) => imageMapping?.[image.id])
      .filter((source): source is string => typeof source === 'string' && source.length > 0),
  );
  if (requiredSources.size === 0) {
    return 'the selected textbook visual has no authorised serving source';
  }
  const present = elements.some((element) => {
    if (element.type !== 'image') return false;
    const source = (element as unknown as { src?: unknown }).src;
    return typeof source === 'string' && requiredSources.has(source);
  });
  return present ? undefined : 'the selected textbook visual is absent from the generated slide';
}

/** The edit directive that asks for the native-elements fallback. */
export const NATIVE_VISUAL_DIRECTIVE =
  'This slide must carry ONE meaningful supporting visual and currently has none. No suitable textbook image is available. Add a visual composed from native slide elements — a simple diagram, a chart, or an illustrative group of shapes and lines with short labels — using ONLY the facts, relationships and sequence already present in the authoritative source content for this slide. Do not invent examples, facts or context, and do not use any image or video element. Keep all existing teaching content.';
