import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { lineDirection, stripLineDirections } from '../line-direction';

/**
 * Owner, 24 Nov 2026: each paragraph and list item in the slide editor takes `dir`
 * from its own text (`lineDirection`: any Arabic letter → right-to-left), so an
 * Arabic line puts «•» and the list marker on the right and «.» on the left even
 * when it starts with a Latin label such as «(1C)». The attribute is a view-only
 * decoration; the editor strips it before saving (`stripEditorOnlyAttrs`), so the
 * stored slide content does not change.
 */
export const lineDirectionPlugin = () =>
  new Plugin({
    props: {
      decorations(state) {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'paragraph' && node.type.name !== 'list_item') return;
          const dir = lineDirection(node.textContent);
          if (dir) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }));
        });
        return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });

/** Removes the editor-only `dir` this plugin puts on paragraphs and list items. */
export const stripEditorOnlyAttrs = stripLineDirections;
