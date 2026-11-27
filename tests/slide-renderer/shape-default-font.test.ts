import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';

import { BaseShapeElement } from '@/components/slide-renderer/components/element/ShapeElement/BaseShapeElement';

/**
 * ED-10 (critical items before package regeneration, 27 Nov 2026): a shape without text
 * of its own no longer defaults to «Microsoft YaHei» (a Chinese font teachers saw in the
 * font box); it inherits the app's font, like a new text box.
 */
const shape = (text?: PPTShapeElement['text']): PPTShapeElement =>
  ({
    id: 'shape-1',
    type: 'shape',
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    rotate: 0,
    viewBox: [200, 200],
    path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
    fixedRatio: false,
    fill: '#ffffff',
    ...(text ? { text } : {}),
  }) as PPTShapeElement;

describe('a shape’s default text font', () => {
  it('is the inherited app font, never Microsoft YaHei', () => {
    const markup = renderToStaticMarkup(createElement(BaseShapeElement, { elementInfo: shape() }));
    expect(markup).not.toMatch(/YaHei/i);
    expect(markup).not.toMatch(/font-family/i);
  });

  it('keeps a font the shape’s own text names', () => {
    const markup = renderToStaticMarkup(
      createElement(BaseShapeElement, {
        elementInfo: shape({
          content: '<p>نص</p>',
          align: 'middle',
          defaultFontName: 'Roboto',
          defaultColor: '#333333',
        }),
      }),
    );
    expect(markup).toContain('font-family:Roboto');
  });
});
