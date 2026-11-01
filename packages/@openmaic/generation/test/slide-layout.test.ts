import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  arrangeGeneratedSlideLayout,
  generatedSlideLayoutIssue,
  normalizeGeneratedSlideLayout,
} from '../src/slide-layout.js';

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

// Geometry taken from lesson 306 (stage-QBoB76qbLxdL), 1 Nov 2026.
const shape = (id: string, left: number, top: number, width: number, height: number) =>
  element({
    id,
    type: 'shape',
    left,
    top,
    width,
    height,
    content: undefined,
  } as Partial<PPTElement>);
const text = (id: string, left: number, top: number, width: number, height: number, html: string) =>
  element({ id, left, top, width, height, content: html });
const line = (
  id: string,
  left: number,
  top: number,
  start: [number, number],
  end: [number, number],
  points: [string, string] = ['', ''],
) => ({ id, type: 'line', left, top, width: 3, start, end, points }) as unknown as PPTElement;
const byId = (elements: PPTElement[], id: string) =>
  elements.find((candidate) => candidate.id === id) as PPTElement & Record<string, number>;
const bottomOf = (el: PPTElement & Record<string, number>) => el.top + el.height;

describe('arrangeGeneratedSlideLayout', () => {
  it('leaves a sound slide untouched', () => {
    const slide = [
      text('title', 60, 50, 880, 68, '<p style="font-size:32px;">T</p>'),
      shape('box', 60, 150, 400, 200),
      text('inside', 80, 170, 360, 60, '<p style="font-size:18px;">Body</p>'),
    ];
    const arranged = arrangeGeneratedSlideLayout(slide);
    arranged.forEach((el, index) => expect(el).toBe(slide[index]));
  });

  it('fits a warning line under the boxes instead of pushing it onto them (slide 4)', () => {
    const slide = [
      text('title', 60, 55, 880, 68, '<p style="font-size:32px;">من الأمثلة إلى التخمين</p>'),
      shape('step1', 650, 145, 290, 190),
      text('step1-text', 665, 166, 260, 143, '<p style="font-size:18px;">١</p>'),
      shape('step3', 60, 145, 250, 190),
      line('arrow', 595, 238, [50, 0], [5, 0], ['', 'arrow']),
      shape('def1', 60, 365, 430, 104),
      text('def1-text', 80, 379, 390, 68, '<p style="font-size:16px;">التبرير</p>'),
      shape('def2', 510, 365, 430, 104),
      text('warning', 60, 480, 880, 64, '<p style="font-size:16px;">تنبيه</p>'),
    ];
    const arranged = normalizeGeneratedSlideLayout(arrangeGeneratedSlideLayout(slide));
    const warning = byId(arranged, 'warning');
    const def1 = byId(arranged, 'def1');
    expect(warning.top).toBeGreaterThanOrEqual(bottomOf(def1));
    expect(bottomOf(warning)).toBeLessThanOrEqual(512.5);
    // A box moves with its text.
    expect(byId(arranged, 'def1-text').top - def1.top).toBe(14);
    expect(generatedSlideLayoutIssue(arranged)).toBeNull();
  });

  it('separates the stored, already-overlapping warning line from the boxes (slide 4 as saved)', () => {
    const slide = [
      text('title', 60, 55, 880, 68, '<p style="font-size:32px;">من الأمثلة إلى التخمين</p>'),
      shape('def1', 60, 365, 430, 104),
      text('def1-text', 80, 379, 390, 68, '<p style="font-size:16px;">التبرير</p>'),
      shape('def2', 510, 365, 430, 104),
      text('def2-text', 530, 379, 390, 68, '<p style="font-size:16px;">التخمين</p>'),
      text('warning', 60, 448.5, 880, 44, '<p style="font-size:16px;">تنبيه</p>'),
    ];
    const arranged = normalizeGeneratedSlideLayout(arrangeGeneratedSlideLayout(slide));
    const warning = byId(arranged, 'warning');
    for (const id of ['def1', 'def2']) {
      expect(warning.top).toBeGreaterThanOrEqual(bottomOf(byId(arranged, id)));
      // The box still holds its text.
      expect(bottomOf(byId(arranged, id))).toBeGreaterThanOrEqual(
        bottomOf(byId(arranged, `${id}-text`)),
      );
    }
    expect(bottomOf(byId(arranged, 'def1'))).toBe(bottomOf(byId(arranged, 'def2')));
    expect(bottomOf(warning)).toBeLessThanOrEqual(512.5);
  });

  it('keeps slide 21 number line and moves its reminder line under the cards', () => {
    const slide = [
      shape('right', 510, 125, 430, 375),
      shape('left', 60, 125, 430, 375),
      text('right-body', 530, 185, 390, 116, '<p style="font-size:16px;">• عند ن = ١</p>'),
      line('axis', 555, 395, [0, 0], [320, 0], ['arrow', 'arrow']),
      line('tick0', 715, 385, [0, 0], [0, 20]),
      text('zero', 685, 405, 60, 44, '<p style="font-size:14px; text-align:center;">٠</p>'),
      text('left-body', 80, 185, 390, 116, '<p style="font-size:16px;">• ارسم</p>'),
      line('ray', 175, 435, [0, 0], [0, -70]),
      text('reminder', 80, 455, 840, 44, '<p style="font-size:16px;">تذكّر</p>'),
    ];
    const arranged = normalizeGeneratedSlideLayout(arrangeGeneratedSlideLayout(slide));
    expect(byId(arranged, 'axis')).toBe(slide[3]);
    const reminder = byId(arranged, 'reminder');
    expect(reminder.top).toBeGreaterThanOrEqual(bottomOf(byId(arranged, 'right')));
    expect(bottomOf(byId(arranged, 'right'))).toBeGreaterThanOrEqual(
      bottomOf(byId(arranged, 'zero')),
    );
    expect(bottomOf(reminder)).toBeLessThanOrEqual(512.5);
  });

  it('shrinks the last row font only down to 14px when gaps are not enough', () => {
    const shrink = (height: number) => {
      const slide = [
        text('a', 60, 50, 880, 200, '<p style="font-size:20px;">A</p>'),
        text('b', 60, 258, 880, height, '<p style="font-size:20px;">B</p>'),
      ];
      return (byId(arrangeGeneratedSlideLayout(slide), 'b') as unknown as { content: string })
        .content;
    };
    // 45.5px over a 300px box: scaled to fit.
    expect(shrink(300)).toBe('<p style="font-size:17px;">B</p>');
    // 145.5px over a 400px box would need 12.7px: held at the 14px floor.
    expect(shrink(400)).toBe('<p style="font-size:14px;">B</p>');
  });

  it('re-centres connector arrows in the gap between boxes (slide 2)', () => {
    const slide = [
      shape('first', 660, 390, 280, 55),
      shape('second', 360, 390, 280, 55),
      shape('third', 60, 390, 280, 55),
      line('a1', 645, 417, [0, 0], [-20, 0], ['', 'arrow']),
      line('a2', 345, 417, [0, 0], [-20, 0], ['', 'arrow']),
    ];
    const arranged = arrangeGeneratedSlideLayout(slide);
    const a1 = byId(arranged, 'a1') as unknown as { left: number; start: number[]; end: number[] };
    expect([a1.left + a1.start[0], a1.left + a1.end[0]]).toEqual([656, 644]);
    const a2 = byId(arranged, 'a2') as unknown as { left: number; start: number[]; end: number[] };
    expect([a2.left + a2.start[0], a2.left + a2.end[0]]).toEqual([356, 344]);
  });

  it('moves angle labels off the rays onto their bisectors (slide 21)', () => {
    const rays: [number, number][] = [
      [-55, -45],
      [65, -45],
      [0, -70],
    ];
    const slide = [
      ...rays.map((end, index) => line(`ray${index}`, 175, 435, [0, 0], end)),
      text('left45', 105, 390, 60, 44, '<p style="font-size:14px; text-align:center;">٤٥°</p>'),
      text('right45', 185, 390, 60, 44, '<p style="font-size:14px; text-align:center;">٤٥°</p>'),
    ];
    const arranged = arrangeGeneratedSlideLayout(slide);
    for (const id of ['left45', 'right45']) {
      const label = byId(arranged, id);
      const cx = label.left + label.width / 2;
      const cy = label.top + label.height / 2;
      const angle = Math.atan2(cy - 435, cx - 175);
      const between =
        id === 'left45'
          ? [Math.atan2(-45, -55), -Math.PI / 2]
          : [-Math.PI / 2, Math.atan2(-45, 65)];
      expect(angle).toBeGreaterThan(between[0]!);
      expect(angle).toBeLessThan(between[1]!);
    }
  });

  it('leaves number-line labels that sit clear of their ticks', () => {
    const slide = [
      line('axis', 555, 395, [0, 0], [320, 0], ['arrow', 'arrow']),
      line('tick0', 715, 385, [0, 0], [0, 20]),
      text('zero', 685, 405, 60, 44, '<p style="font-size:14px; text-align:center;">٠</p>'),
    ];
    const arranged = arrangeGeneratedSlideLayout(slide);
    expect(byId(arranged, 'zero')).toBe(slide[2]);
  });
});
