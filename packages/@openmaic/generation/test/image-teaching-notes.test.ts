/**
 * Slide image plan: every textbook image a slide shows reaches narration with
 * its OWN data (figure, caption, what it shows, what to notice), so the teacher
 * explains each image; slides without notes keep the prompt they always had.
 */
import { describe, expect, it } from 'vitest';

import {
  buildNarrationImageNotes,
  generateSceneActions,
  type AICallFn,
  type SceneOutline,
} from '../src/index.js';
import { slideOutline } from './scene-fixtures.js';

const ACTIONS_RESPONSE = JSON.stringify([{ type: 'text', content: 'Look at the two figures.' }]);

const outline: SceneOutline = {
  ...slideOutline(),
  contentRole: 'explanation',
  visualPlan: { mode: 'image' },
  suggestedImageIds: ['img_3', 'img_7'],
  imagePlans: [
    {
      imageId: 'img_3',
      shows: 'many examples leading to one rule',
      teachingPoint: 'induction goes from examples to a rule',
    },
    {
      imageId: 'img_7',
      shows: 'one rule applied to one case',
      teachingPoint: 'deduction goes from a rule to a case',
    },
  ],
};

const SOURCE_IMAGES = [
  { id: 'img_3', figureLabel: '2-1', caption: 'Inductive reasoning' },
  { id: 'img_7', figureLabel: '2-2', caption: 'Deductive reasoning' },
];
const SERVING = { img_3: '/media/s/img_3.png', img_7: '/media/s/img_7.png' };

const content = {
  elements: [
    { id: 'title_1', type: 'text', content: '<p>Induction or deduction?</p>' },
    { id: 'pic_a', type: 'image', src: '/media/s/img_3.png' },
    { id: 'pic_b', type: 'image', src: '/media/s/img_7.png' },
  ],
  background: { type: 'solid', color: '#fff' },
} as never;

function capture(store: { user?: string }): AICallFn {
  return async (_system, user) => {
    store.user = user;
    return ACTIONS_RESPONSE;
  };
}

describe('narration image notes', () => {
  it('keys each note by image id and serving path', () => {
    const notes = buildNarrationImageNotes(outline, SOURCE_IMAGES, SERVING);
    expect(notes['/media/s/img_3.png']).toEqual({
      figureLabel: '2-1',
      caption: 'Inductive reasoning',
      shows: 'many examples leading to one rule',
      teachingPoint: 'induction goes from examples to a rule',
    });
    expect(notes.img_7?.shows).toBe('one rule applied to one case');
  });

  it('gives narration every image with its own data and the rule to explain each', async () => {
    const store: { user?: string } = {};
    await generateSceneActions(outline, content, capture(store), {
      imageNotes: buildNarrationImageNotes(outline, SOURCE_IMAGES, SERVING),
    });
    expect(store.user).toContain(
      'id: "pic_a", type: "image", Textbook image — figure 2-1; caption "Inductive reasoning"; shows: many examples leading to one rule; the learner should notice: induction goes from examples to a rule',
    );
    expect(store.user).toContain('shows: one rule applied to one case');
    expect(store.user).toContain('Every textbook image above ("pic_a", "pic_b")');
  });

  it('keeps the old element line when there are no notes', async () => {
    const store: { user?: string } = {};
    await generateSceneActions(outline, content, capture(store));
    expect(store.user).toContain('id: "pic_a", type: "image", Image element');
    expect(store.user).not.toContain('Every textbook image above');
  });

  it('explains a planned native diagram from its note', async () => {
    const store: { user?: string } = {};
    const diagramSlide: SceneOutline = {
      ...slideOutline(),
      contentRole: 'explanation',
      visualPlan: {
        mode: 'native',
        diagram: {
          shows: 'vapour, cloud and rain in a loop',
          teachingPoint: 'water moves in a cycle',
        },
      },
    };
    await generateSceneActions(
      diagramSlide,
      { elements: [], background: { type: 'solid', color: '#fff' } } as never,
      capture(store),
    );
    expect(store.user).toContain(
      "The slide's diagram shows vapour, cloud and rain in a loop; explain it and point the learner to what to notice: water moves in a cycle.",
    );
  });
});
