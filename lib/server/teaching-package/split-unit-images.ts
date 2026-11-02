/**
 * g5.v8 split-unit duplicate image (teacher-parity plan I-4.3).
 *
 * A book unit taught over several slides (lesson 306's example 4021: bus times,
 * then segment shapes) prints ONE image, and the planner may put it on every
 * slide of the unit. The image stays on the slide whose key points best match
 * it — the numbers and terms they share with its caption, figure label,
 * description and planned `shows` notes — and every other slide of that unit
 * showing it is handed to the existing per-slide visual re-plan without it
 * (`classroom-generation.ts`), which gives it a native diagram.
 *
 * Pure and deterministic. A tie keeps the earliest slide.
 */
import type { PdfImage } from '@openmaic/generation';

import { normalizeBookText } from '@/lib/server/teaching-package/hidden-step-types';
import type { SceneOutline } from '@/lib/types/generation';

export interface DuplicateSourceVisual {
  /** The slide that must drop the image. */
  outlineId: string;
  imageId: string;
  /** The slide that keeps it. */
  keptOnOutlineId: string;
}

function numbers(text: string): Set<string> {
  return new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map((value) => String(Number(value))));
}

function terms(text: string): Set<string> {
  return new Set(text.match(/[\p{L}]{3,}/gu) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared;
}

/** How well a slide's own text matches what the image shows: numbers count double. */
export function imageMatchScore(outline: SceneOutline, imageText: string): number {
  const slide = normalizeBookText([outline.title ?? '', ...(outline.keyPoints ?? [])].join('\n'));
  const image = normalizeBookText(imageText);
  return 2 * overlap(numbers(slide), numbers(image)) + overlap(terms(slide), terms(image));
}

function citedUnits(outline: SceneOutline): Set<string> {
  return new Set((outline.sourceContentUnitIds ?? []).map(String));
}

/**
 * Every slide that must drop a textbook image another slide of the same unit
 * keeps. Slides "of the same unit" are the holders of the image linked through
 * a cited unit they share (directly or via another holder).
 */
export function findSplitUnitDuplicateImages(
  outlines: readonly SceneOutline[],
  sourceImages: readonly PdfImage[],
): DuplicateSourceVisual[] {
  const duplicates: DuplicateSourceVisual[] = [];
  const byId = new Map(sourceImages.map((image) => [image.id, image] as const));
  const imageIds = [
    ...new Set(
      outlines.flatMap((outline) =>
        outline.type === 'slide' ? (outline.suggestedImageIds ?? []) : [],
      ),
    ),
  ];
  for (const imageId of imageIds) {
    const holders = outlines.filter(
      (outline) =>
        outline.type === 'slide' &&
        typeof outline.id === 'string' &&
        (outline.suggestedImageIds ?? []).includes(imageId),
    );
    if (holders.length < 2) continue;
    const image = byId.get(imageId);
    // What the image shows, by the book and by the OTHER slides' notes: a
    // slide's own note may describe its own topic, so it never scores itself.
    const imageTextFor = (scored: SceneOutline) =>
      [
        image?.caption ?? '',
        image?.figureLabel ?? '',
        image?.description ?? '',
        ...holders
          .filter((outline) => outline !== scored)
          .flatMap((outline) =>
            (outline.imagePlans ?? [])
              .filter((plan) => plan.imageId === imageId)
              .map((plan) => plan.shows ?? ''),
          ),
      ].join('\n');
    // Group the holders by shared cited units (connected components).
    const groups: SceneOutline[][] = [];
    for (const holder of holders) {
      const units = citedUnits(holder);
      const joined = groups.filter((group) =>
        group.some((other) => [...citedUnits(other)].some((id) => units.has(id))),
      );
      const merged = [...joined.flat(), holder];
      for (const group of joined) groups.splice(groups.indexOf(group), 1);
      groups.push(merged);
    }
    for (const group of groups) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((a, b) => outlines.indexOf(a) - outlines.indexOf(b));
      let keeper = ordered[0]!;
      let best = imageMatchScore(keeper, imageTextFor(keeper));
      for (const candidate of ordered.slice(1)) {
        const score = imageMatchScore(candidate, imageTextFor(candidate));
        if (score > best) {
          keeper = candidate;
          best = score;
        }
      }
      for (const outline of ordered) {
        if (outline === keeper) continue;
        duplicates.push({
          outlineId: outline.id!,
          imageId,
          keptOnOutlineId: keeper.id!,
        });
      }
    }
  }
  return duplicates;
}

export interface SplitUnitImageKeeper {
  imageId: string;
  /** The one slide of the unit that may show the image. */
  keeperId: string;
  /** Every other slide of the unit: never offered the image. */
  otherIds: string[];
  /**
   * False when nothing tells the slides apart (the best match score is tied):
   * the keeper is then only the earliest slide, and the caller lets the visual
   * re-plan look at the image before deciding.
   */
  decisive: boolean;
}

/**
 * The keeper of every textbook image linked to a unit taught over several
 * slides, decided BEFORE any visual re-plan so the image lands on the slide it
 * illustrates, not on whichever slide is re-planned first (lesson 306's
 * example 4021: bus times, then the 4, 10, 18, 28, 40 segments).
 *
 * In order: the keeper `decided` already (the split-unit duplicate step); else
 * the earliest slide that shows the image and keeps its selection
 * (`keepsImage`); else the slide whose title and key points best match the
 * image's caption, figure label, description and the other slides' `shows`
 * notes (numbers count double; a tie keeps the earliest and is not
 * `decisive`). Pure and deterministic.
 */
export function chooseSplitUnitImageKeepers(
  outlines: readonly SceneOutline[],
  sourceImages: readonly PdfImage[],
  options: {
    decided?: ReadonlyMap<string, string>;
    keepsImage?: (outline: SceneOutline, imageId: string) => boolean;
  } = {},
): SplitUnitImageKeeper[] {
  const keepers: SplitUnitImageKeeper[] = [];
  const slides = outlines.filter(
    (outline) => outline.type === 'slide' && typeof outline.id === 'string',
  );
  for (const image of sourceImages) {
    const units = new Set((image.sourceContentUnitIds ?? []).map(String));
    if (units.size === 0) continue;
    const unitSlides = slides.filter((outline) =>
      [...citedUnits(outline)].some((id) => units.has(id)),
    );
    if (unitSlides.length < 2) continue;
    const decidedId = options.decided?.get(image.id);
    let keeper = unitSlides.find((outline) => outline.id === decidedId);
    keeper ??= unitSlides.find(
      (outline) =>
        (outline.suggestedImageIds ?? []).includes(image.id) &&
        (options.keepsImage?.(outline, image.id) ?? false),
    );
    let decisive = keeper !== undefined;
    if (!keeper) {
      const imageTextFor = (scored: SceneOutline) =>
        [
          image.caption ?? '',
          image.figureLabel ?? '',
          image.description ?? '',
          ...unitSlides
            .filter((outline) => outline !== scored)
            .flatMap((outline) =>
              (outline.imagePlans ?? [])
                .filter((plan) => plan.imageId === image.id)
                .map((plan) => plan.shows ?? ''),
            ),
        ].join('\n');
      let best = -1;
      let runnerUp = -1;
      for (const candidate of unitSlides) {
        const score = imageMatchScore(candidate, imageTextFor(candidate));
        if (score > best) {
          keeper = candidate;
          runnerUp = best;
          best = score;
        } else if (score > runnerUp) {
          runnerUp = score;
        }
      }
      decisive = best > runnerUp;
    }
    keepers.push({
      imageId: image.id,
      keeperId: keeper!.id!,
      otherIds: unitSlides.filter((outline) => outline !== keeper).map((outline) => outline.id!),
      decisive,
    });
  }
  return keepers;
}
