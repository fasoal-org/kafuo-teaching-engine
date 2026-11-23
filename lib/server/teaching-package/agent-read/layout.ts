/**
 * Element boxes and overlap detection for the agent read API (Kafuo Agent API
 * plan §1.5: `elements[].bbox`, `layout.overlaps`). Pure: no I/O.
 *
 * - `bbox = [left, top, left + width, top + height]` in slide pixels (the
 *   1000 × 562.5 canvas). Rotation is ignored: the box is the unrotated one,
 *   the same frame the editor stores.
 * - Overlaps are checked between CONTENT boxes only: text, a shape that holds
 *   text, image (not `imageType: 'background'`), table, latex, chart and video.
 *   Decorative shapes (no text), lines and audio are ignored.
 * - A pair is reported only when the intersection is at least
 *   {@link MIN_OVERLAP_AREA_PX} px²: a 10 × 10 px touch is below one glyph at
 *   slide font sizes and is the rounding noise of boxes laid edge to edge.
 */
export const MIN_OVERLAP_AREA_PX = 100;

export type BBox = [number, number, number, number];

export interface LayoutOverlap {
  a: string;
  b: string;
  area_px: number;
}

type CanvasElement = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function elementBBox(element: CanvasElement): BBox {
  const left = num(element.left);
  const top = num(element.top);
  return [left, top, left + num(element.width), top + num(element.height)];
}

function shapeHasText(element: CanvasElement): boolean {
  const content = (element.text as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' && content.replace(/<[^>]*>/g, '').trim() !== '';
}

/** Whether an element takes part in the overlap check (content, not decoration). */
export function isLayoutContentElement(element: CanvasElement): boolean {
  switch (element.type) {
    case 'text':
    case 'table':
    case 'latex':
    case 'chart':
    case 'video':
      return true;
    case 'image':
      return element.imageType !== 'background';
    case 'shape':
      return shapeHasText(element);
    default:
      return false;
  }
}

function intersection(a: BBox, b: BBox): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Every pair of content boxes overlapping by at least the threshold, in element order. */
export function findLayoutOverlaps(
  elements: readonly CanvasElement[],
  minAreaPx: number = MIN_OVERLAP_AREA_PX,
): LayoutOverlap[] {
  const boxes = elements
    .filter(isLayoutContentElement)
    .map((element) => ({ id: String(element.id ?? ''), box: elementBBox(element) }));
  const overlaps: LayoutOverlap[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const area = intersection(boxes[i]!.box, boxes[j]!.box);
      if (area >= minAreaPx) {
        overlaps.push({ a: boxes[i]!.id, b: boxes[j]!.id, area_px: Math.round(area) });
      }
    }
  }
  return overlaps;
}
