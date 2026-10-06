/**
 * The placeholder package generation keeps for a governed slide it could not
 * generate (3 Oct 2026), and the `generationIssues` marker's write-boundary
 * validation.
 */
import { describe, expect, it } from 'vitest';
import { placeholderSlideContent } from '@/lib/server/teaching-package/placeholder-slide';
import { validateAppScene } from '@/lib/document-store/validators';

describe('placeholderSlideContent', () => {
  it('is built only from the outline: its title and its key points', () => {
    const content = placeholderSlideContent(
      { title: 'كيف نضع تخمينًا؟', keyPoints: ['النمط', 'التخمين'] },
      'rtl',
    );
    const html = content.elements
      .map((element) => (element as { content?: string }).content)
      .join('');
    expect(html).toContain('كيف نضع تخمينًا؟');
    expect(html).toContain('النمط');
    expect(html).toContain('text-align: right');
    expect(content.assistance?.hint).toBeTruthy();
    expect(content.assistance?.explanation).toBeTruthy();
  });

  it('escapes HTML and falls back to the description when there are no key points', () => {
    const content = placeholderSlideContent({ title: '<b>x</b>', description: 'a < b' });
    const html = content.elements
      .map((element) => (element as { content?: string }).content)
      .join('');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &lt; b');
    expect(html).toContain('text-align: left');
  });
});

describe('generationIssues on the write boundary', () => {
  const pbl = {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'pbl',
    title: 'Project',
    order: 1,
    content: { type: 'pbl', projectConfig: {} },
  };

  it('accepts a well-formed marker', () => {
    const result = validateAppScene({
      ...pbl,
      generationIssues: [{ code: 'ORIENTATION_VISUAL_MISSING', message: 'missing' }],
    });
    const errors = result.valid ? [] : result.errors;
    expect(errors.some((error) => error.path === '/generationIssues')).toBe(false);
  });

  it('refuses a malformed marker', () => {
    const result = validateAppScene({ ...pbl, generationIssues: [{ message: 'no code' }] });
    expect(result.valid).toBe(false);
    const errors = result.valid ? [] : result.errors;
    expect(errors.some((error) => error.path === '/generationIssues')).toBe(true);
  });
});
