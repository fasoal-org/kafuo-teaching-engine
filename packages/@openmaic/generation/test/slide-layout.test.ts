import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { generatedSlideLayoutIssue, normalizeGeneratedSlideLayout } from '../src/slide-layout.js';

const element = (overrides: Partial<PPTElement> = {}): PPTElement =>
  ({
    id: 'text-1',
    type: 'text',
    left: 60,
    top: 60,
    width: 880,
    height: 80,
    content: '<p>Safe</p>',
    ...overrides,
  }) as PPTElement;

describe('generatedSlideLayoutIssue', () => {
  it('accepts elements fully inside the 50px safe area', () => {
    expect(generatedSlideLayoutIssue([element()])).toBeNull();
  });

  it('rejects the bottom-edge footer shape that was clipped in the player', () => {
    expect(generatedSlideLayoutIssue([element({ id: 'footer', top: 540, height: 20 })])).toMatch(
      /footer.*outside the 50px safe area/,
    );
  });

  it('rejects overflow on every canvas edge', () => {
    expect(generatedSlideLayoutIssue([element({ left: 49 })])).not.toBeNull();
    expect(generatedSlideLayoutIssue([element({ top: 49 })])).not.toBeNull();
    expect(generatedSlideLayoutIssue([element({ left: 100, width: 851 })])).not.toBeNull();
    expect(generatedSlideLayoutIssue([element({ top: 100, height: 413 })])).not.toBeNull();
  });

  it('allows decorative shapes and graph axes to use the full canvas', () => {
    expect(
      generatedSlideLayoutIssue([
        element({ id: 'background', type: 'shape', left: 0, top: 0, width: 1000, height: 562.5 }),
        element({ id: 'axis', type: 'line', left: 25, top: 500, width: 925 }),
      ]),
    ).toBeNull();
  });

  it('moves bottom content into the safe area instead of rejecting the slide', () => {
    const normalized = normalizeGeneratedSlideLayout([
      element({ id: 'text_QBfiRQY4', left: 430, top: 485, width: 500, height: 52 }),
    ]);

    expect(normalized[0]).toMatchObject({
      id: 'text_QBfiRQY4',
      left: 430,
      top: 460.5,
      width: 500,
      height: 52,
    });
    expect(generatedSlideLayoutIssue(normalized)).toBeNull();
  });

  it('shrinks oversized readable content to the safe area', () => {
    const normalized = normalizeGeneratedSlideLayout([
      element({ left: -20, top: -10, width: 1200, height: 700 }),
    ]);

    expect(normalized[0]).toMatchObject({ left: 50, top: 50, width: 900, height: 462.5 });
    expect(generatedSlideLayoutIssue(normalized)).toBeNull();
  });

  it('does not move full-bleed decorative elements', () => {
    const background = element({
      id: 'background',
      type: 'shape',
      left: 0,
      top: 0,
      width: 1000,
      height: 562.5,
    });

    expect(normalizeGeneratedSlideLayout([background])[0]).toBe(background);
  });
});
