/**
 * Book images for a reviewer-driven slide regeneration
 * (single-slide-regeneration-plan §7.4).
 *
 * The slide generator's edit mode expects the baseline to reference images by
 * id, with the real sources handed over through `assignedImages` /
 * `imageMapping` (the channel initial generation uses); `resolveImageIds`
 * maps the ids back after generation and the media registry removes any
 * source the run did not hand over.
 *
 * - A baseline image whose `src` is a manifest `servingPath` becomes its
 *   manifest id (`src-N`): an `assignedImages` entry plus
 *   `imageMapping[src-N] = servingPath`.
 * - Any other concrete baseline `src` becomes `img_K`, in `imageMapping`
 *   ONLY — never in `assignedImages`, whose mapped sources are the required set
 *   of `requiredSourceVisualIssue`. A canvas keeping only a non-textbook image
 *   therefore never satisfies a textbook-visual plan.
 * - The authorized selected set — the outline's `suggestedImageIds` that
 *   resolve in the manifest — is offered too, even when absent from the
 *   canvas, exactly as initial generation offers it.
 * - `visualPlan.mode === 'image'` with no resolvable selected id refuses with
 *   `SOURCE_VISUAL_UNRESOLVED` before any model call: preservation is never
 *   claimed for a visual that cannot be identified.
 *
 * The contract itself is unchanged and enforced by the generator: with an
 * `image` plan, at least one authorized visual must be on the generated
 * canvas, else `ORIENTATION_VISUAL_MISSING`.
 */
import type {
  GeneratedSlideContent,
  ImageMapping,
  PdfImage,
  VisualPlan,
} from '@openmaic/generation';

import type { SourceVisualManifestEntry } from '@/lib/types/teaching-package';
import { isMediaPlaceholder } from '@/lib/store/media-generation';

export interface LiftedSlideImages {
  /** The baseline canvas with lifted image sources replaced by their ids. */
  baseline: GeneratedSlideContent;
  /** Authorized textbook visuals only (manifest ids). */
  assignedImages: PdfImage[];
  /** Every id the run hands over → its concrete source. */
  imageMapping: ImageMapping;
  /** The manifest ids of the authorized selected set. */
  authorizedIds: string[];
}

export type LiftSlideImagesResult =
  | { ok: true; lifted: LiftedSlideImages }
  | { ok: false; code: 'SOURCE_VISUAL_UNRESOLVED'; message: string };

function isConcreteSource(src: string): boolean {
  if (isMediaPlaceholder(src)) return false;
  if (src.startsWith('/') && !src.startsWith('//')) return src.length > 1 && !/\s/.test(src);
  return /^https?:\/\//i.test(src);
}

function toPdfImage(entry: SourceVisualManifestEntry): PdfImage {
  return {
    id: entry.id,
    src: entry.servingPath,
    pageNumber: entry.pageNumber ?? 0,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.width !== undefined ? { width: entry.width } : {}),
    ...(entry.height !== undefined ? { height: entry.height } : {}),
  };
}

export function liftSlideImages(input: {
  canvas: { elements: readonly unknown[]; background?: unknown };
  sourceVisuals?: readonly SourceVisualManifestEntry[];
  suggestedImageIds?: readonly string[];
  visualPlan?: VisualPlan;
}): LiftSlideImagesResult {
  const manifest = input.sourceVisuals ?? [];
  const byPath = new Map(manifest.map((entry) => [entry.servingPath, entry]));
  const byId = new Map(manifest.map((entry) => [entry.id, entry]));
  const authorizedIds = (input.suggestedImageIds ?? []).filter((id) => byId.has(id));
  if (input.visualPlan?.mode === 'image' && authorizedIds.length === 0) {
    return {
      ok: false,
      code: 'SOURCE_VISUAL_UNRESOLVED',
      message:
        'this slide plans a textbook visual, but none of its selected images can be identified in the lesson’s source visuals; nothing was generated',
    };
  }

  const assigned = new Map<string, PdfImage>();
  const imageMapping: ImageMapping = {};
  const assign = (entry: SourceVisualManifestEntry) => {
    if (!assigned.has(entry.id)) assigned.set(entry.id, toPdfImage(entry));
    imageMapping[entry.id] = entry.servingPath;
  };
  for (const id of authorizedIds) assign(byId.get(id)!);

  const otherIds = new Map<string, string>();
  const elements = input.canvas.elements.map((element) => {
    const candidate = element as { type?: unknown; src?: unknown };
    if (candidate.type !== 'image' || typeof candidate.src !== 'string') return element;
    const src = candidate.src;
    const entry = byPath.get(src);
    if (entry) {
      assign(entry);
      return { ...(element as object), src: entry.id };
    }
    if (!isConcreteSource(src)) return element;
    let id = otherIds.get(src);
    if (!id) {
      id = `img_${otherIds.size + 1}`;
      otherIds.set(src, id);
      imageMapping[id] = src;
    }
    return { ...(element as object), src: id };
  });

  return {
    ok: true,
    lifted: {
      baseline: {
        elements: elements as GeneratedSlideContent['elements'],
        background: input.canvas.background as GeneratedSlideContent['background'],
      },
      assignedImages: [...assigned.values()],
      imageMapping,
      authorizedIds,
    },
  };
}
