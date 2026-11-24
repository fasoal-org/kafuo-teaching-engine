// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { initProsemirrorEditor } from '@/lib/prosemirror';
import { stripEditorOnlyAttrs } from '@/lib/prosemirror/plugins/line-direction';
import { applyLineDirections, lineDirection } from '@/lib/prosemirror/line-direction';

const html =
  '<p style="text-align: right;">(1C) انظر إلى متتابعة المثلثات.</p>' +
  '<p>10, 4, −2, −8, ...</p>' +
  '<ul><li><p style="text-align: right;">تصف النظرية مبدأً رئيسًا.</p></li></ul>' +
  '<ol><li><p>First step.</p></li></ol>';

describe('slide line direction', () => {
  it('makes any line with an Arabic letter rtl, even when it starts with a Latin label', () => {
    expect(lineDirection('(1C) انظر إلى متتابعة المثلثات.')).toBe('rtl');
    expect(lineDirection('• هل النظرية اسم آخر للقانون؟')).toBe('rtl');
    expect(lineDirection('An English line.')).toBe('ltr');
    expect(lineDirection('10, 4, −2, −8, ...')).toBeNull();
    expect(lineDirection('')).toBeNull();
  });

  it('gives editor paragraphs and list items their dir in the view only', () => {
    const dom = document.createElement('div');
    const view = initProsemirrorEditor(dom, html, {});
    const dirs = [...view.dom.querySelectorAll('p, li')].map((el) => el.getAttribute('dir'));
    // (1C) line, numbers line, Arabic li + its p, English li + its p
    expect(dirs).toEqual(['rtl', null, 'rtl', 'rtl', 'ltr', 'ltr']);
    view.destroy();
  });

  it('strips the editor-only dir so saved content is unchanged', () => {
    const dom = document.createElement('div');
    const view = initProsemirrorEditor(dom, html, {});
    const saved = stripEditorOnlyAttrs(view.dom.innerHTML);
    expect(saved).not.toMatch(/ dir="/);
    expect(saved).toContain('<li><p');
    expect(saved).toContain('<p style="text-align: right;">(1C)');
    view.destroy();
  });

  it('sets dir on read-only slide HTML without touching the text', () => {
    const root = document.createElement('div');
    root.innerHTML = html;
    applyLineDirections(root);
    const first = root.querySelector('p')!;
    expect(first.getAttribute('dir')).toBe('rtl');
    expect(first.textContent).toBe('(1C) انظر إلى متتابعة المثلثات.');
    expect(root.querySelectorAll('p')[1].hasAttribute('dir')).toBe(false);
  });
});
