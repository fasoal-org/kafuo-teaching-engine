/**
 * Slide image plan D-1/D-4: one slide's visual is re-planned by the planner,
 * with its linked images attached, and only the visual fields + key points move.
 */
import { describe, expect, it } from 'vitest';
import type { AICallFn, PdfImage, SceneOutline } from '@openmaic/generation';

import { replanSlideVisuals } from '@/lib/server/teaching-package/replan-slide-visuals';

const outline: SceneOutline = {
  id: 'o-6',
  type: 'slide',
  order: 6,
  title: 'Inductive or deductive?',
  description: 'Compare the two kinds of reasoning',
  keyPoints: ['induction', 'deduction', 'difference'],
  slideType: 'content',
  contentRole: 'explanation',
  contentKind: 'comparison',
  teachingStage: { key: 'outcome_visual_explanations', flowIndex: 2 },
  sourceContentUnitIds: ['cu-1'],
  mediaGenerations: [{ type: 'image', elementId: 'gen_img_1', prompt: 'decoration' }],
};

const images: PdfImage[] = [
  {
    id: 'img_3',
    src: 'data:a',
    pageNumber: 4,
    caption: 'Inductive reasoning',
    sourceContentUnitIds: ['cu-1'],
  },
  {
    id: 'img_7',
    src: 'data:b',
    pageNumber: 5,
    caption: 'Deductive reasoning',
    sourceContentUnitIds: ['cu-1'],
  },
];

const GOOD = JSON.stringify({
  suggestedImageIds: ['img_3', 'img_7'],
  imagePlans: [
    { imageId: 'img_3', shows: 'examples to a rule', teachingPoint: 'induction generalises' },
    { imageId: 'img_7', shows: 'a rule to a case', teachingPoint: 'deduction applies' },
  ],
  visualPlan: { mode: 'image' },
  keyPoints: [
    'Induction: examples → rule (figure 1)',
    'Deduction: rule → case (figure 2)',
    'Direction is the difference',
  ],
});

function scripted(answers: string[], seen: unknown[][]): AICallFn {
  return async (_system, _user, attached) => {
    seen.push((attached ?? []).map((image) => image.id));
    return answers.shift() ?? '{}';
  };
}

const base = {
  linkedImages: images,
  imageSrc: (image: PdfImage) => image.src,
  sourceText: 'Induction goes from examples to a rule.',
  languageDirective: 'Arabic',
  reasons: ['has a textbook visual linked to the same Content Unit but did not select it'],
  check: () => [],
};

describe('replanSlideVisuals', () => {
  it('attaches the linked images and keeps the slide identity', async () => {
    const seen: unknown[][] = [];
    const result = await replanSlideVisuals({ ...base, outline, aiCall: scripted([GOOD], seen) });
    expect(seen).toEqual([['img_3', 'img_7']]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outline).toMatchObject({
      id: 'o-6',
      order: 6,
      contentKind: 'comparison',
      teachingStage: { flowIndex: 2 },
      sourceContentUnitIds: ['cu-1'],
      visualPlan: { mode: 'image' },
      suggestedImageIds: ['img_3', 'img_7'],
    });
    expect(result.outline.imagePlans).toHaveLength(2);
    expect(result.outline.mediaGenerations).toBeUndefined();
  });

  it('re-asks once when the answer names an image it was not given', async () => {
    const foreign = JSON.stringify({ ...JSON.parse(GOOD), suggestedImageIds: ['img_99'] });
    const seen: unknown[][] = [];
    const result = await replanSlideVisuals({
      ...base,
      outline,
      aiCall: scripted([foreign, GOOD], seen),
    });
    expect(result).toMatchObject({ ok: true, calls: 2 });
  });

  it("keeps exactly the reviewer's chosen images when only their notes are missing", async () => {
    const onlyFirst = JSON.stringify({
      ...JSON.parse(GOOD),
      suggestedImageIds: ['img_3'],
      imagePlans: [JSON.parse(GOOD).imagePlans[0]],
    });
    const result = await replanSlideVisuals({
      ...base,
      outline,
      requiredImageIds: ['img_3', 'img_7'],
      aiCall: scripted([onlyFirst, GOOD], []),
    });
    expect(result).toMatchObject({ ok: true, calls: 2 });
  });

  it('reports the remaining findings after the corrective re-ask', async () => {
    const result = await replanSlideVisuals({
      ...base,
      outline,
      check: () => ['still missing a note'],
      aiCall: scripted([GOOD, GOOD], []),
    });
    expect(result).toEqual({ ok: false, messages: ['still missing a note'], calls: 2 });
  });

  it('plans a native diagram with its note when no image is linked', async () => {
    const native = JSON.stringify({
      suggestedImageIds: [],
      imagePlans: [],
      visualPlan: {
        mode: 'native',
        diagram: { shows: 'two arrows', teachingPoint: 'opposite directions' },
      },
      keyPoints: ['a', 'b', 'c'],
    });
    const seen: unknown[][] = [];
    const result = await replanSlideVisuals({
      ...base,
      linkedImages: [],
      outline,
      aiCall: scripted([native], seen),
    });
    expect(seen).toEqual([[]]);
    expect(result.ok && result.outline.visualPlan).toEqual({
      mode: 'native',
      diagram: { shows: 'two arrows', teachingPoint: 'opposite directions' },
    });
    expect(result.ok && result.outline.suggestedImageIds).toBeUndefined();
  });
});
