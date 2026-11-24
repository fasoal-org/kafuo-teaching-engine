// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { initProsemirrorEditor } from '@/lib/prosemirror';
import { stripEditorOnlyAttrs } from '@/lib/prosemirror/plugins/list-item-direction';

const html =
  '<ul><li><p style="text-align: right;">تصف النظرية مبدأً رئيسًا.</p></li></ul>' +
  '<ol><li><p>First step.</p></li></ol>';

describe('list item direction in the slide editor', () => {
  it('gives every list item dir="auto" in the editor view', () => {
    const dom = document.createElement('div');
    const view = initProsemirrorEditor(dom, html, {});
    const items = [...view.dom.querySelectorAll('li')];
    expect(items).toHaveLength(2);
    expect(items.every((li) => li.getAttribute('dir') === 'auto')).toBe(true);
    // Paragraphs keep their markup: the per-line direction there is CSS only.
    expect(view.dom.querySelector('p')?.hasAttribute('dir')).toBe(false);
    view.destroy();
  });

  it('strips the editor-only attribute so saved content is unchanged', () => {
    const dom = document.createElement('div');
    const view = initProsemirrorEditor(dom, html, {});
    const saved = stripEditorOnlyAttrs(view.dom.innerHTML);
    expect(saved).not.toContain('dir="auto"');
    expect(saved).toContain('<li><p');
    view.destroy();
  });
});
