import type { PPTElement } from '@openmaic/dsl';

export const SLIDE_CANVAS_WIDTH = 1000;
export const SLIDE_CANVAS_HEIGHT = 562.5;
export const SLIDE_SAFE_MARGIN = 50;

// Lines and shapes are frequently used as full-bleed backgrounds, dividers,
// axes, and chart marks. Requiring those decorative primitives to stay inside
// the reading safe area rejects otherwise valid visual explanations (notably
// graphs) without protecting any readable content from player chrome.
const SAFE_AREA_CONTENT_TYPES = new Set([
  'text',
  'image',
  'chart',
  'table',
  'latex',
  'video',
  'audio',
  'code',
]);

type PositionedElement = PPTElement & {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

function hasFiniteBox(element: PositionedElement): element is PositionedElement & {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return (
    Number.isFinite(element.left) &&
    Number.isFinite(element.top) &&
    Number.isFinite(element.width) &&
    Number.isFinite(element.height) &&
    element.width! > 0 &&
    element.height! > 0
  );
}

/**
 * Fit readable/media content into the player-safe area without spending
 * another model call. Oversized elements are reduced to the safe-area size;
 * otherwise their dimensions are preserved and they are translated inward.
 * Decorative shapes and lines intentionally remain full-bleed.
 */
export function normalizeGeneratedSlideLayout(elements: readonly PPTElement[]): PPTElement[] {
  const safeWidth = SLIDE_CANVAS_WIDTH - SLIDE_SAFE_MARGIN * 2;
  const safeHeight = SLIDE_CANVAS_HEIGHT - SLIDE_SAFE_MARGIN * 2;

  return elements.map((element) => {
    if (!SAFE_AREA_CONTENT_TYPES.has(element.type)) return element;
    const geometry = element as PositionedElement;
    if (!hasFiniteBox(geometry)) return element;

    const width = Math.min(geometry.width, safeWidth);
    const height = Math.min(geometry.height, safeHeight);
    const left = Math.min(
      Math.max(geometry.left, SLIDE_SAFE_MARGIN),
      SLIDE_CANVAS_WIDTH - SLIDE_SAFE_MARGIN - width,
    );
    const top = Math.min(
      Math.max(geometry.top, SLIDE_SAFE_MARGIN),
      SLIDE_CANVAS_HEIGHT - SLIDE_SAFE_MARGIN - height,
    );

    if (
      left === geometry.left &&
      top === geometry.top &&
      width === geometry.width &&
      height === geometry.height
    ) {
      return element;
    }

    return { ...element, left, top, width, height } as PPTElement;
  });
}

/**
 * Refuse model-authored elements outside the same safe area required by the
 * slide prompt. A prompt instruction alone is not an enforcement boundary:
 * elements placed at the bottom edge are clipped by the player chrome even
 * though their raw geometry technically remains inside the canvas.
 */
export function generatedSlideLayoutIssue(elements: readonly PPTElement[]): string | null {
  const maxRight = SLIDE_CANVAS_WIDTH - SLIDE_SAFE_MARGIN;
  const maxBottom = SLIDE_CANVAS_HEIGHT - SLIDE_SAFE_MARGIN;

  for (const [index, element] of elements.entries()) {
    if (!SAFE_AREA_CONTENT_TYPES.has(element.type)) continue;
    const geometry = element as PositionedElement;
    if (!hasFiniteBox(geometry)) continue;
    const left = geometry.left;
    const top = geometry.top;
    const right = left + geometry.width;
    const bottom = top + geometry.height;
    if (
      left < SLIDE_SAFE_MARGIN ||
      top < SLIDE_SAFE_MARGIN ||
      right > maxRight ||
      bottom > maxBottom
    ) {
      return `element ${JSON.stringify(element.id || `#${index + 1}`)} is outside the 50px safe area (left=${left}, top=${top}, right=${right}, bottom=${bottom})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic re-arrangement (slide layout repair plan, 1 Nov 2026). The
// model places every element by absolute coordinates; these repairs fix the
// three faults seen in practice without another model call:
//   A. content taller than the safe area is fitted by shrinking the gaps
//      between rows (a box moves with everything inside it), then the font of
//      the last row's free text, instead of pushing one element onto another;
//   B. a connector arrow is re-centred in the gap between the two boxes it joins;
//   C. a short diagram label lying on a line moves off it (an angle label onto
//      its angle's bisector).
// ---------------------------------------------------------------------------

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Line = PPTElement & {
  type: 'line';
  left: number;
  top: number;
  start: [number, number];
  end: [number, number];
  points?: [string, string];
};

const MIN_ROW_GAP = 8;
const FIT_TOLERANCE = 2;
const ARROW_GAP_PADDING = 4;
const MIN_FONT_PX = 14;
const LABEL_MAX_CHARS = 6;
const LABEL_NUDGE_MAX = 24;

function isLine(element: PPTElement): element is Line {
  const line = element as Partial<Line>;
  return (
    element.type === 'line' &&
    Number.isFinite(line.left) &&
    Number.isFinite(line.top) &&
    Array.isArray(line.start) &&
    Array.isArray(line.end)
  );
}

function lineEnds(line: Line): [[number, number], [number, number]] {
  return [
    [line.left + line.start[0], line.top + line.start[1]],
    [line.left + line.end[0], line.top + line.end[1]],
  ];
}

function boxOf(element: PPTElement): Box | null {
  if (isLine(element)) {
    const [[x1, y1], [x2, y2]] = lineEnds(element);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
    };
  }
  const geometry = element as PositionedElement;
  if (!hasFiniteBox(geometry)) return null;
  return {
    left: geometry.left,
    top: geometry.top,
    right: geometry.left + geometry.width,
    bottom: geometry.top + geometry.height,
  };
}

function contains(outer: Box, inner: Box, tolerance = 2): boolean {
  return (
    inner.left >= outer.left - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

/** A shape covering most of the canvas is a background, never a layout box. */
function isBackground(element: PPTElement, box: Box): boolean {
  return (
    element.type === 'shape' &&
    (box.right - box.left) * (box.bottom - box.top) >=
      SLIDE_CANVAS_WIDTH * SLIDE_CANVAS_HEIGHT * 0.8
  );
}

function shiftVertically(element: PPTElement, delta: number): PPTElement {
  if (delta === 0) return element;
  const top = (element as PositionedElement).top ?? 0;
  return { ...element, top: top + delta } as PPTElement;
}

interface Group {
  members: number[];
  box: Box;
}

/** Each outermost box with everything inside it, then every free element alone. */
function layoutGroups(elements: readonly PPTElement[]): Group[] {
  const boxes = elements.map(boxOf);
  const containers = elements
    .map((element, index) => ({ element, index, box: boxes[index] }))
    .filter(
      (entry): entry is { element: PPTElement; index: number; box: Box } =>
        entry.element.type === 'shape' &&
        entry.box !== null &&
        !isBackground(entry.element, entry.box),
    );
  const owner = new Map<number, number>();
  elements.forEach((element, index) => {
    const box = boxes[index];
    if (!box || (element.type === 'shape' && isBackground(element, box))) return;
    let best: { index: number; area: number } | undefined;
    for (const container of containers) {
      if (container.index === index || !contains(container.box, box)) continue;
      const area =
        (container.box.right - container.box.left) * (container.box.bottom - container.box.top);
      // The outermost container owns the element, so a card moves as one.
      if (!best || area > best.area) best = { index: container.index, area };
    }
    owner.set(index, best ? best.index : index);
  });
  const byRoot = new Map<number, number[]>();
  for (const [index, root] of owner) {
    const resolved = owner.get(root) === root ? root : (owner.get(root) ?? root);
    byRoot.set(resolved, [...(byRoot.get(resolved) ?? []), index]);
  }
  return [...byRoot.values()].map((members) => {
    const memberBoxes = members.map((index) => boxes[index]!);
    return {
      members,
      box: {
        left: Math.min(...memberBoxes.map((box) => box.left)),
        top: Math.min(...memberBoxes.map((box) => box.top)),
        right: Math.max(...memberBoxes.map((box) => box.right)),
        bottom: Math.max(...memberBoxes.map((box) => box.bottom)),
      },
    };
  });
}

/** Groups merged into rows by vertical overlap, top to bottom. */
function layoutRows(groups: readonly Group[]): Group[] {
  const rows: Group[] = [];
  for (const group of [...groups].sort((a, b) => a.box.top - b.box.top)) {
    const row = rows[rows.length - 1];
    if (row && group.box.top < row.box.bottom - 1) {
      row.members.push(...group.members);
      row.box = {
        left: Math.min(row.box.left, group.box.left),
        top: row.box.top,
        right: Math.max(row.box.right, group.box.right),
        bottom: Math.max(row.box.bottom, group.box.bottom),
      };
    } else {
      rows.push({ members: [...group.members], box: { ...group.box } });
    }
  }
  return rows;
}

function scaleFontSizes(html: string, factor: number): string {
  return html.replace(/font-size:\s*([\d.]+)px/g, (_match, size: string) => {
    const next = Math.max(MIN_FONT_PX, Math.round(Number(size) * factor * 10) / 10);
    return `font-size:${next}px`;
  });
}

function smallestFontSize(html: string): number | null {
  const sizes = [...html.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
  return sizes.length > 0 ? Math.min(...sizes) : null;
}

function intersects(a: Box, b: Box, margin = 2): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > margin &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > margin
  );
}

const CONTAINER_BOTTOM_PADDING = 4;

/**
 * A (first step). A free text block that starts inside the lower part of a box
 * it does not belong to (a clamp or the model pushed it up) is put below that
 * box: the boxes it overlaps lose the empty space under their own contents
 * (all to the same bottom, so a row stays even), and the text goes under them.
 */
function separateFreeText(elements: PPTElement[]): PPTElement[] {
  const next = [...elements];
  const groups = layoutGroups(elements);
  // Only boxes with contents of their own: text over a lone decorative shape stays.
  const boxGroups = groups.filter(
    (group) =>
      group.members.length > 1 &&
      group.members.some((member) => elements[member]!.type === 'shape'),
  );
  for (const group of groups) {
    if (group.members.length !== 1) continue;
    const index = group.members[0]!;
    const textElement = next[index] as PositionedElement;
    if (textElement.type !== 'text' || !hasFiniteBox(textElement)) continue;
    const textBox = boxOf(textElement)!;
    const overlapped = boxGroups.filter(
      (candidate) => intersects(textBox, candidate.box) && textBox.top > candidate.box.top + 1,
    );
    if (overlapped.length === 0) continue;

    let rowBottom = 0;
    const roots: number[] = [];
    for (const candidate of overlapped) {
      const root = candidate.members.find((member) => {
        const box = boxOf(elements[member]!);
        return (
          elements[member]!.type === 'shape' &&
          box !== null &&
          box.top === candidate.box.top &&
          box.bottom === candidate.box.bottom
        );
      });
      const contentBottom = Math.max(
        candidate.box.top,
        ...candidate.members
          .filter((member) => member !== root)
          .map((member) => boxOf(next[member]!)?.bottom ?? candidate.box.top),
      );
      if (root !== undefined) roots.push(root);
      rowBottom = Math.max(
        rowBottom,
        root === undefined ? candidate.box.bottom : contentBottom + CONTAINER_BOTTOM_PADDING,
      );
    }
    for (const root of roots) {
      const shape = next[root] as PositionedElement & { top: number; height: number };
      if (shape.top + shape.height > rowBottom) {
        next[root] = { ...shape, height: rowBottom - shape.top } as PPTElement;
      }
    }
    const top = rowBottom + MIN_ROW_GAP;
    if (top > textElement.top!) next[index] = shiftVertically(textElement, top - textElement.top!);
  }
  return next;
}

/** A. Fit content taller than the safe area by closing row gaps, then shrinking the last row's text. */
function fitRowsVertically(elements: PPTElement[]): PPTElement[] {
  const maxBottom = SLIDE_CANVAS_HEIGHT - SLIDE_SAFE_MARGIN;
  const rows = layoutRows(layoutGroups(elements));
  if (rows.length === 0) return elements;
  // Only readable content overflows: a decorative bar may run to the edge.
  const contentBottom = Math.max(
    0,
    ...elements
      .filter((element) => SAFE_AREA_CONTENT_TYPES.has(element.type))
      .map((element) => boxOf(element)?.bottom ?? 0),
  );
  let overflow = contentBottom - maxBottom;
  // A pixel or two is the clamp's to absorb; re-flowing the slide for it is noise.
  if (overflow <= FIT_TOLERANCE) return elements;

  const next = [...elements];
  const gaps = rows
    .slice(1)
    .map((row, index) => Math.max(0, row.box.top - rows[index]!.box.bottom - MIN_ROW_GAP));
  const available = gaps.reduce((sum, gap) => sum + gap, 0);
  if (available > 0) {
    const ratio = Math.min(1, overflow / available);
    let shift = 0;
    rows.forEach((row, index) => {
      if (index > 0) shift += gaps[index - 1]! * ratio;
      const rounded = Math.ceil(shift * 2) / 2;
      for (const member of row.members) next[member] = shiftVertically(next[member]!, -rounded);
    });
    overflow -= available * ratio;
  }
  if (overflow <= 0.5) return next;

  // Still too tall: shrink the free text of the last row (never below MIN_FONT_PX).
  const last = rows[rows.length - 1]!;
  for (const member of last.members) {
    const element = next[member] as PositionedElement & { content?: string };
    if (element.type !== 'text' || typeof element.content !== 'string') continue;
    if (!hasFiniteBox(element)) continue;
    const smallest = smallestFontSize(element.content);
    if (smallest === null || smallest <= MIN_FONT_PX) continue;
    const factor = Math.max(MIN_FONT_PX / smallest, (element.height - overflow) / element.height);
    if (factor >= 1) continue;
    next[member] = {
      ...element,
      content: scaleFontSizes(element.content, factor),
      height: element.height * factor,
    } as PPTElement;
  }
  return next;
}

/** B. Re-centre a straight connector arrow in the gap between the two boxes it joins. */
function recenterArrows(elements: PPTElement[]): PPTElement[] {
  const groups = layoutGroups(elements).filter(
    (group) => !(group.members.length === 1 && isLine(elements[group.members[0]!]!)),
  );
  const containers = elements
    .map((element) => ({ element, box: boxOf(element) }))
    .filter(
      (entry): entry is { element: PPTElement; box: Box } =>
        entry.element.type === 'shape' &&
        entry.box !== null &&
        !isBackground(entry.element, entry.box),
    )
    .map((entry) => entry.box);
  return elements.map((element) => {
    if (!isLine(element) || !element.points?.includes('arrow')) return element;
    // A connector joins boxes: a double-headed axis, or any line drawn inside a
    // box (a number line, a diagram), is never one.
    if (element.points[0] === 'arrow' && element.points[1] === 'arrow') return element;
    const lineBox = boxOf(element)!;
    if (containers.some((box) => contains(box, lineBox))) return element;
    const shaped = element as {
      broken?: unknown;
      broken2?: unknown;
      curve?: unknown;
      cubic?: unknown;
    };
    if (shaped.broken || shaped.broken2 || shaped.curve || shaped.cubic) return element;
    const [[x1, y1], [x2, y2]] = lineEnds(element);
    const horizontal = Math.abs(y2 - y1) < 2 && Math.abs(x2 - x1) >= 2;
    const vertical = Math.abs(x2 - x1) < 2 && Math.abs(y2 - y1) >= 2;
    if (!horizontal && !vertical) return element;

    // Neighbours: boxes that span the arrow's cross-axis position.
    const cross = horizontal ? y1 : x1;
    const along = horizontal ? (x1 + x2) / 2 : (y1 + y2) / 2;
    const spans = groups
      .map((group) => group.box)
      .filter((box) =>
        horizontal
          ? box.top <= cross && box.bottom >= cross
          : box.left <= cross && box.right >= cross,
      )
      .map((box) =>
        horizontal ? { from: box.left, to: box.right } : { from: box.top, to: box.bottom },
      )
      .sort((a, b) => a.from - b.from);
    for (let index = 0; index + 1 < spans.length; index += 1) {
      const before = spans[index]!;
      const after = spans[index + 1]!;
      const centreBefore = (before.from + before.to) / 2;
      const centreAfter = (after.from + after.to) / 2;
      if (along < centreBefore || along > centreAfter) continue;
      // The arrow must actually reach into the gap between the two boxes.
      const [lineFrom, lineTo] = horizontal
        ? [lineBox.left, lineBox.right]
        : [lineBox.top, lineBox.bottom];
      if (lineFrom > after.from || lineTo < before.to) return element;
      // Already inside the gap: a sound arrow keeps its place and length.
      if (lineFrom >= before.to && lineTo <= after.from) return element;
      const gapStart = before.to + ARROW_GAP_PADDING;
      const gapEnd = after.from - ARROW_GAP_PADDING;
      if (gapEnd - gapStart < 4) return element;
      const length = Math.min(lineTo - lineFrom, gapEnd - gapStart);
      const middle = (gapStart + gapEnd) / 2;
      const forward = horizontal ? x2 > x1 : y2 > y1;
      const [low, high] = [middle - length / 2, middle + length / 2];
      const [from, to] = forward ? [low, high] : [high, low];
      if (horizontal) {
        const left = Math.min(from, to);
        return {
          ...element,
          left,
          top: y1,
          start: [from - left, 0],
          end: [to - left, 0],
        } as PPTElement;
      }
      const top = Math.min(from, to);
      return {
        ...element,
        left: x1,
        top,
        start: [0, from - top],
        end: [0, to - top],
      } as PPTElement;
    }
    return element;
  });
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Label = PositionedElement & {
  left: number;
  top: number;
  width: number;
  height: number;
  content: string;
};

/** The rectangle a short centred label's glyphs occupy. */
function labelGlyphBox(element: Label, text: string): Box {
  const font = smallestFontSize(element.content) ?? 16;
  const width = Math.max(2, [...text].length) * font * 0.6 + 4;
  const height = font * 1.3;
  const cx = element.left + element.width / 2;
  const cy = element.top + element.height / 2;
  return {
    left: cx - width / 2,
    right: cx + width / 2,
    top: cy - height / 2,
    bottom: cy + height / 2,
  };
}

function segmentHitsBox(a: [number, number], b: [number, number], box: Box): boolean {
  // Liang–Barsky clip of the segment against the box.
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: [number, number][] = [
    [-dx, a[0] - box.left],
    [dx, box.right - a[0]],
    [-dy, a[1] - box.top],
    [dy, box.bottom - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function moveLabelCentre(element: Label, cx: number, cy: number): PPTElement {
  return {
    ...element,
    left: Math.round((cx - element.width / 2) * 10) / 10,
    top: Math.round((cy - element.height / 2) * 10) / 10,
  } as PPTElement;
}

/** C. Move a short diagram label off the line it sits on. */
function clearDiagramLabels(elements: PPTElement[]): PPTElement[] {
  const segments = elements.filter(isLine).map(lineEnds);
  if (segments.length === 0) return elements;
  const near = (p: [number, number], q: [number, number]) =>
    Math.abs(p[0] - q[0]) <= 3 && Math.abs(p[1] - q[1]) <= 3;

  return elements.map((element) => {
    const label = element as PositionedElement & { content?: string };
    if (element.type !== 'text' || typeof label.content !== 'string' || !hasFiniteBox(label)) {
      return element;
    }
    const text = plainText(label.content);
    if (text.length === 0 || [...text].length > LABEL_MAX_CHARS) return element;
    // Measures and tick values only («٤٥°», «−١»): a point's letter label sits
    // on its vertex by design.
    if (!/[0-9٠-٩°]/.test(text)) return element;
    const typed = label as Label;
    const glyphs = labelGlyphBox(typed, text);
    const hit = segments.find(([a, b]) => segmentHitsBox(a, b, glyphs));
    if (!hit) return element;
    const cx = (glyphs.left + glyphs.right) / 2;
    const cy = (glyphs.top + glyphs.bottom) / 2;
    const halfDiagonal = Math.hypot(glyphs.right - glyphs.left, glyphs.bottom - glyphs.top) / 2;

    // An angle: two or more rays share the hit line's end point (the vertex).
    for (const vertex of hit) {
      const rays = segments
        .map(([a, b]) => (near(a, vertex) ? b : near(b, vertex) ? a : null))
        .filter((end): end is [number, number] => end !== null)
        .map((end) => ({
          angle: Math.atan2(end[1] - vertex[1], end[0] - vertex[0]),
          length: Math.hypot(end[0] - vertex[0], end[1] - vertex[1]),
        }))
        .sort((a, b) => a.angle - b.angle);
      if (rays.length < 2) continue;
      const labelAngle = Math.atan2(cy - vertex[1], cx - vertex[0]);
      // Sectors between neighbouring rays; keep the ones under 180°.
      const sectors = rays
        .map((ray, index) => {
          const nextRay = rays[(index + 1) % rays.length]!;
          let sweep = nextRay.angle - ray.angle;
          if (sweep <= 0) sweep += Math.PI * 2;
          return { from: ray.angle, sweep, length: Math.min(ray.length, nextRay.length) };
        })
        .filter((sector) => sector.sweep < Math.PI);
      if (sectors.length === 0) continue;
      const offset = (sector: { from: number; sweep: number }) => {
        const bisector = sector.from + sector.sweep / 2;
        const diff = Math.atan2(Math.sin(labelAngle - bisector), Math.cos(labelAngle - bisector));
        return Math.abs(diff);
      };
      const sector = sectors.reduce((best, candidate) =>
        offset(candidate) < offset(best) ? candidate : best,
      );
      const bisector = sector.from + sector.sweep / 2;
      const distance = Math.min(
        Math.max(sector.length * 0.6, (halfDiagonal + 3) / Math.sin(sector.sweep / 2)),
        sector.length + halfDiagonal,
      );
      return moveLabelCentre(
        typed,
        vertex[0] + Math.cos(bisector) * distance,
        vertex[1] + Math.sin(bisector) * distance,
      );
    }

    // Any other line: nudge the label along the line's normal until clear.
    const [a, b] = hit;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / length;
    let ny = (b[0] - a[0]) / length;
    if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let step = 2; step <= LABEL_NUDGE_MAX; step += 2) {
      const moved = {
        left: glyphs.left + nx * step,
        right: glyphs.right + nx * step,
        top: glyphs.top + ny * step,
        bottom: glyphs.bottom + ny * step,
      };
      if (!segments.some(([p, q]) => segmentHitsBox(p, q, moved))) {
        return moveLabelCentre(typed, cx + nx * step, cy + ny * step);
      }
    }
    return element;
  });
}

/**
 * Re-arrange a generated slide's elements deterministically (repairs A–C above).
 * Run before {@link normalizeGeneratedSlideLayout}; an already sound slide comes
 * back with every element unchanged.
 */
export function arrangeGeneratedSlideLayout(elements: readonly PPTElement[]): PPTElement[] {
  return clearDiagramLabels(recenterArrows(fitRowsVertically(separateFreeText([...elements]))));
}
