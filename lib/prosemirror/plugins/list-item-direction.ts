import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/**
 * Owner, 24 Nov 2026: the slide sits in a `dir="ltr"` frame, so an Arabic list item's
 * marker stayed on the left. CSS cannot move a list marker (`unicode-bidi: plaintext`
 * leaves the item's `direction` alone), so each item takes `dir="auto"` in the editor
 * view only. The editor strips it again before saving (`stripEditorOnlyAttrs`), so the
 * stored slide content does not change.
 */
export const LIST_ITEM_DIRECTION_ATTR = ' dir="auto"';

export const listItemDirectionPlugin = () =>
  new Plugin({
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'list_item') {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir: 'auto' }));
          }
        });
        return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });

/** Removes the editor-only `dir="auto"` this plugin puts on list items. */
export const stripEditorOnlyAttrs = (html: string) =>
  html.split(`<li${LIST_ITEM_DIRECTION_ATTR}`).join('<li');
