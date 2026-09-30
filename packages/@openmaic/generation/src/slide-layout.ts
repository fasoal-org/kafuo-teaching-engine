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
