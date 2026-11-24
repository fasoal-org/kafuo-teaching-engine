'use client';

import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';
import { useLineDirections } from '../hooks/useLineDirections';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

/**
 * Base text element component (read-only)
 * Renders static text content with styling
 */
export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { ref: textRef, innerHTML } = useLineDirections<HTMLDivElement>(elementInfo.content);

  return (
    <div
      className="base-element-text absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{
          transform: `rotate(${elementInfo.rotate}deg)`,
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
        }}
      >
        <div
          className="element-content relative p-[10px] leading-[1.5] break-words"
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <div
            ref={textRef}
            // Each paragraph takes its direction from its own text (useLineDirections: any
            // Arabic letter → rtl): the slide sits in a `dir="ltr"` frame, so an Arabic line
            // otherwise put its «.» and «•» on the wrong side. plaintext covers lines with no
            // letters only.
            className={`text ProseMirror-static relative [&_p:not([dir])]:[unicode-bidi:plaintext] [&_li:not([dir])]:[unicode-bidi:plaintext] ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
            dangerouslySetInnerHTML={innerHTML}
          />
        </div>
      </div>
    </div>
  );
}
