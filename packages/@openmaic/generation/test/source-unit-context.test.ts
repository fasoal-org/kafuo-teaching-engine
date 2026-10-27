/**
 * A teaching slide's content and narration prompts carry the approved text of
 * the Content Units THAT slide cites — and nothing else; check/practice slides
 * keep their answer boundary; callers without units render unchanged prompts.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSceneSourceContext,
  generateSceneActions,
  generateSceneContent,
  MAX_SCENE_SOURCE_CHARS,
  type AICallFn,
  type SceneOutline,
  type SourceUnitText,
} from '../src/index.js';
import { slideOutline } from './scene-fixtures.js';

const DEFINITION = 'Pressure is defined as the force acting per unit area: P = F / A.';
const WORKED =
  'Example: a 600 N box rests on 2 m². Step 1: write P = F / A. Step 2: substitute 600 / 2. Step 3: P = 300 Pa.';
const UNRELATED = 'Density is mass per unit volume.';

const UNITS: SourceUnitText[] = [
  { id: '10', title: 'Pressure', text: DEFINITION },
  { id: '11', title: 'Worked example: a box', text: WORKED },
  { id: '12', title: 'Density', text: UNRELATED },
];

const teaching = (fields: Partial<SceneOutline>): SceneOutline => ({
  ...slideOutline(),
  contentRole: 'explanation',
  sourceContentUnitIds: ['10', '11'],
  ...fields,
});

const CONTENT_RESPONSE = JSON.stringify({
  elements: [],
  background: { type: 'solid', color: '#fff' },
});
const ACTIONS_RESPONSE = JSON.stringify([{ type: 'text', content: 'First, the key idea.' }]);
const SLIDE_CONTENT = { elements: [], background: { type: 'solid', color: '#fff' } } as never;

function capture(store: { user?: string }, response: string): AICallFn {
  return async (_system, user) => {
    store.user = user;
    return response;
  };
}

describe('buildSceneSourceContext', () => {
  it('gives a slide exactly the units it cites, in citation order', () => {
    const context = buildSceneSourceContext(
      teaching({ sourceContentUnitIds: ['11', '10'] }),
      UNITS,
    );
    expect(context.hasSourceContext).toBe(true);
    expect(context.sourceContextText.indexOf(WORKED)).toBeLessThan(
      context.sourceContextText.indexOf(DEFINITION),
    );
    expect(context.sourceContextText).not.toContain(UNRELATED);
  });

  it('accepts numeric ids as the model copies them', () => {
    const context = buildSceneSourceContext(
      teaching({ sourceContentUnitIds: [10] as unknown as string[] }),
      UNITS,
    );
    expect(context.sourceContextText).toContain(DEFINITION);
  });

  it('never renders internal ids or markers', () => {
    const { sourceContextText } = buildSceneSourceContext(teaching({}), UNITS);
    expect(sourceContextText).not.toMatch(/\bid=|CONTENT_UNIT|\b1[0-2]\b/);
  });

  it('keeps the answer boundary: check and practice slides get no source', () => {
    for (const contentRole of [
      'check_understanding',
      'practice',
      'orientation',
      'summary',
    ] as const) {
      expect(buildSceneSourceContext(teaching({ contentRole }), UNITS).hasSourceContext).toBe(
        false,
      );
    }
  });

  it('gives worked-example and unclassified slides their source', () => {
    expect(
      buildSceneSourceContext(teaching({ contentRole: 'worked_example' }), UNITS).hasSourceContext,
    ).toBe(true);
    expect(
      buildSceneSourceContext(teaching({ contentRole: undefined }), UNITS).hasSourceContext,
    ).toBe(true);
  });

  it('is empty for non-slides, uncited slides and callers without units', () => {
    expect(buildSceneSourceContext(teaching({ type: 'quiz' }), UNITS).hasSourceContext).toBe(false);
    expect(
      buildSceneSourceContext(teaching({ sourceContentUnitIds: [] }), UNITS).hasSourceContext,
    ).toBe(false);
    expect(buildSceneSourceContext(teaching({}), undefined).hasSourceContext).toBe(false);
  });

  it('states a cut instead of dropping text silently', () => {
    const long: SourceUnitText[] = [
      { id: '10', title: 'Long', text: 'x'.repeat(MAX_SCENE_SOURCE_CHARS + 50) },
      { id: '11', title: 'After', text: WORKED },
    ];
    const context = buildSceneSourceContext(teaching({}), long);
    expect(context.clippedUnitIds).toEqual(['10', '11']);
    expect(context.sourceContextText).toContain('[the rest of this section is not shown');
    expect(context.sourceContextText).toContain('Source section 2: After\n[not shown');
  });
});

describe('scene prompts', () => {
  it('slide content receives the definition and worked-example steps', async () => {
    const store: { user?: string } = {};
    await generateSceneContent(teaching({}), capture(store, CONTENT_RESPONSE), {
      sourceUnits: UNITS,
    });
    expect(store.user).toContain('### Approved textbook source this slide teaches');
    expect(store.user).toContain(DEFINITION);
    expect(store.user).toContain(WORKED);
    expect(store.user).not.toContain(UNRELATED);
  });

  it('narration receives the same source for a teaching slide', async () => {
    const store: { user?: string } = {};
    await generateSceneActions(teaching({}), SLIDE_CONTENT, capture(store, ACTIONS_RESPONSE), {
      sourceUnits: UNITS,
    });
    expect(store.user).toContain(DEFINITION);
    expect(store.user).toContain(WORKED);
  });

  it('narration of a check slide never sees the worked solution', async () => {
    const store: { user?: string } = {};
    await generateSceneActions(
      teaching({ contentRole: 'check_understanding' }),
      SLIDE_CONTENT,
      capture(store, ACTIONS_RESPONSE),
      { sourceUnits: UNITS },
    );
    expect(store.user).not.toContain(WORKED);
  });

  it('renders byte-identical prompts when no units are supplied', async () => {
    const bare: { user?: string } = {};
    const withNone: { user?: string } = {};
    await generateSceneContent(teaching({}), capture(bare, CONTENT_RESPONSE));
    await generateSceneContent(teaching({}), capture(withNone, CONTENT_RESPONSE), {
      sourceUnits: [],
    });
    expect(withNone.user).toBe(bare.user);
    expect(bare.user).not.toContain('Approved textbook source');

    const bareActions: { user?: string } = {};
    const uncited: { user?: string } = {};
    await generateSceneActions(teaching({}), SLIDE_CONTENT, capture(bareActions, ACTIONS_RESPONSE));
    await generateSceneActions(
      teaching({ sourceContentUnitIds: ['99'] }),
      SLIDE_CONTENT,
      capture(uncited, ACTIONS_RESPONSE),
      { sourceUnits: UNITS },
    );
    expect(uncited.user).toBe(bareActions.user);
  });
});
