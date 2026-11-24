import { useLayoutEffect, useMemo, useRef } from 'react';
import { applyLineDirections } from '@/lib/prosemirror/line-direction';

/**
 * Gives each paragraph and list item of a read-only slide text its own `dir`
 * (any Arabic letter → rtl) after React writes `html`, before the browser paints.
 * The stored HTML is not changed.
 *
 * `innerHTML` keeps one object per `html`: React writes `dangerouslySetInnerHTML`
 * again whenever the object changes, even with the same text, which would wipe the
 * `dir` set here on every parent re-render.
 */
export function useLineDirections<T extends HTMLElement>(html: string) {
  const ref = useRef<T>(null);
  const innerHTML = useMemo(() => ({ __html: html }), [html]);
  useLayoutEffect(() => {
    if (ref.current) applyLineDirections(ref.current);
  }, [innerHTML]);
  return { ref, innerHTML };
}
