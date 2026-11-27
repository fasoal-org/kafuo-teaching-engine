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

  // g5.v12 (critical items 27 Nov 2026, QZ-1 and QZ-6): the questions written from the book.
  const CHECK = 'Check: what is the pressure of a 900 N box on 3 m²?';
  const WITH_CHECK: SourceUnitText[] = [...UNITS, { id: '13', title: 'Check', text: CHECK }];
  const QUIZ_RESPONSE = JSON.stringify([
    {
      id: 'q1',
      type: 'single',
      question: 'q',
      options: [
        { label: 'a', value: 'A' },
        { label: 'b', value: 'B' },
      ],
      answer: ['A'],
    },
  ]);
  const quiz = (fields: Partial<SceneOutline> = {}): SceneOutline =>
    teaching({
      type: 'quiz',
      contentRole: undefined,
      sourceContentUnitIds: ['10', '11'],
      ...fields,
    });
  const questions = { checkUnitIds: ['13'] };

  it('QZ-1: a quiz is written from the text of the units it cites, with bookGroundedQuestions', async () => {
    const store: { user?: string } = {};
    await generateSceneContent(quiz(), capture(store, QUIZ_RESPONSE), {
      sourceUnits: WITH_CHECK,
      bookGroundedQuestions: questions,
    });
    expect(store.user).toContain('## Approved textbook source these questions test');
    expect(store.user).toContain(DEFINITION);
    expect(store.user).toContain(WORKED);
    expect(store.user).not.toContain(UNRELATED);
    expect(store.user).not.toContain(CHECK);
  });

  it('QZ-1: without bookGroundedQuestions the quiz prompt is byte-identical (every other model)', async () => {
    const bare: { user?: string } = {};
    const withUnits: { user?: string } = {};
    await generateSceneContent(quiz(), capture(bare, QUIZ_RESPONSE));
    await generateSceneContent(quiz(), capture(withUnits, QUIZ_RESPONSE), {
      sourceUnits: WITH_CHECK,
    });
    expect(withUnits.user).toBe(bare.user);
    expect(bare.user).not.toContain('Approved textbook source');
  });

  it('QZ-6: a try-it slide sets only its check unit’s own text, never the worked example', async () => {
    const store: { user?: string } = {};
    await generateSceneContent(
      teaching({ contentRole: 'check_understanding', sourceContentUnitIds: ['13', '11'] }),
      capture(store, CONTENT_RESPONSE),
      { sourceUnits: WITH_CHECK, bookGroundedQuestions: questions },
    );
    expect(store.user).toContain("### The textbook's own question this slide sets");
    expect(store.user).toContain(CHECK);
    expect(store.user).not.toContain(WORKED);
    expect(store.user).not.toContain('### Approved textbook source this slide teaches');
  });

  it('QZ-6 (review L1): a check unit that also prints a worked answer gives the try-it its question only', async () => {
    const merged: SourceUnitText[] = [
      { id: '14', title: 'Check', text: `${CHECK}\nالحل:\nP = 900 / 3 = 300 Pa` },
    ];
    const store: { user?: string } = {};
    await generateSceneContent(
      teaching({ contentRole: 'check_understanding', sourceContentUnitIds: ['14'] }),
      capture(store, CONTENT_RESPONSE),
      { sourceUnits: merged, bookGroundedQuestions: { checkUnitIds: ['14'] } },
    );
    expect(store.user).toContain(CHECK);
    expect(store.user).not.toContain('300 Pa');
    expect(store.user).not.toContain('الحل');
  });

  it('QZ-6: a solution slide keeps its source as before; a teaching slide is unchanged by the option', async () => {
    const solution: { user?: string } = {};
    await generateSceneContent(
      teaching({ contentRole: 'worked_example', sourceContentUnitIds: ['13', '11'] }),
      capture(solution, CONTENT_RESPONSE),
      { sourceUnits: WITH_CHECK, bookGroundedQuestions: questions },
    );
    expect(solution.user).toContain('### Approved textbook source this slide teaches');
    expect(solution.user).toContain(CHECK);
    expect(solution.user).toContain(WORKED);
    const plain: { user?: string } = {};
    const grounded: { user?: string } = {};
    await generateSceneContent(teaching({}), capture(plain, CONTENT_RESPONSE), {
      sourceUnits: WITH_CHECK,
    });
    await generateSceneContent(teaching({}), capture(grounded, CONTENT_RESPONSE), {
      sourceUnits: WITH_CHECK,
      bookGroundedQuestions: questions,
    });
    expect(grounded.user).toBe(plain.user);
    // A try-it slide without the option keeps its answer boundary: no source at all.
    const boundary: { user?: string } = {};
    await generateSceneContent(
      teaching({ contentRole: 'check_understanding', sourceContentUnitIds: ['13'] }),
      capture(boundary, CONTENT_RESPONSE),
      { sourceUnits: WITH_CHECK },
    );
    expect(boundary.user).not.toContain(CHECK);
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
