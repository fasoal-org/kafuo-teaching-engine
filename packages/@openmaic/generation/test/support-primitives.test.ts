import { describe, expect, it } from 'vitest';
import { parseActionsFromStructuredOutput, postProcessInteractiveHtml } from '@openmaic/generation';

describe('action parser', () => {
  it('repairs malformed structured output and preserves interleaving', () => {
    const actions = parseActionsFromStructuredOutput(
      '[{"type":"text","content":"Start"},{"type":"action","name":"widget_setState","params":{}}',
      'interactive',
      ['widget_setState'],
    );
    expect(actions).toEqual([
      expect.objectContaining({ type: 'speech', text: 'Start' }),
      expect.objectContaining({ type: 'widget_setState', state: {} }),
    ]);
  });

  it('filters slide-only actions from non-slide scenes', () => {
    expect(
      parseActionsFromStructuredOutput(
        '[{"type":"action","name":"spotlight","params":{"elementId":"x"}}]',
        'quiz',
      ),
    ).toEqual([]);
  });

  // An action item with no `name`/`tool_name` used to become `{ type: undefined }`
  // and survive every later filter, so the document store refused the whole Scene
  // and the package generation failed outright. One bad item may cost itself and
  // nothing more — the well-formed actions around it must still come through.
  it('drops action items whose type is missing or unknown, keeping the rest', () => {
    expect(
      parseActionsFromStructuredOutput(
        '[{"type":"action","params":{"elementId":"x"}},' +
          '{"type":"action","name":"not_a_real_action","params":{}},' +
          '{"type":"action","name":"spotlight","params":{"elementId":"x"}}]',
        'slide',
      ),
    ).toEqual([expect.objectContaining({ type: 'spotlight', elementId: 'x' })]);
  });

  it('never lets `params` override the validated type or the minted id', () => {
    const [action] = parseActionsFromStructuredOutput(
      '[{"type":"action","name":"spotlight","action_id":"a1",' +
        '"params":{"elementId":"x","type":"bogus","id":"spoofed"}}]',
      'slide',
    );
    expect(action).toMatchObject({ id: 'a1', type: 'spotlight', elementId: 'x' });
  });
});

describe('interactive HTML post-processing', () => {
  it('converts math, protects scripts, and injects KaTeX once', () => {
    const source =
      '<html><head></head><body>$x+1$<script>const price = "$5";</script></body></html>';
    const once = postProcessInteractiveHtml(source);
    const twice = postProcessInteractiveHtml(once);
    expect(once).toContain('\\(x+1\\)');
    expect(once).toContain('const price = "$5";');
    expect(once).toContain('katex.min.css');
    expect(twice.match(/katex\.min\.css/g) ?? []).toHaveLength(1);
  });
});
