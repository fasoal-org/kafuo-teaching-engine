import { describe, expect, it } from 'vitest';

import { validateScene } from '@openmaic/dsl';
import {
  buildCompleteScene,
  changeOutlineType,
  uniquifyMediaElementIds,
  type GeneratedSceneContent,
  type SceneOutline,
} from '@openmaic/generation';
import { nanoid } from 'nanoid';

/**
 * Kafuo R1 P4 (plan §5.1): `SceneCore.sourceContentUnitIds` — the outline's
 * Content Unit citations copied verbatim onto the scene by all four builder
 * branches, beside `teachingStage`. Absent on the outline ⇒ absent on the
 * scene (unknown is never fabricated as an empty list).
 */

const UNITS = ['2900', '2901'];

function outline(type: SceneOutline['type'], sourceContentUnitIds?: string[]): SceneOutline {
  return {
    id: 'outline-1',
    type,
    title: 'Intro',
    description: 'd',
    keyPoints: [],
    order: 1,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    ...(sourceContentUnitIds !== undefined && { sourceContentUnitIds }),
    ...(type === 'quiz'
      ? { quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] } }
      : {}),
    ...(type === 'pbl'
      ? {
          pblConfig: {
            projectTopic: 't',
            projectDescription: 'd',
            targetSkills: ['s'],
            issueCount: 1,
          },
        }
      : {}),
  };
}

function content(type: SceneOutline['type']): GeneratedSceneContent {
  switch (type) {
    case 'slide':
      return { elements: [], background: { type: 'color', color: '#fff' } } as never;
    case 'quiz':
      return { questions: [] } as never;
    case 'interactive':
      return { html: '<p/>', widgetType: 'diagram', widgetConfig: {} } as never;
    case 'pbl':
      return { projectV2: { id: nanoid() } } as never;
  }
}

const KINDS = ['slide', 'quiz', 'interactive', 'pbl'] as const;

describe('sourceContentUnitIds propagation (Kafuo R1 plan §5.1)', () => {
  it.each(KINDS)(
    'buildCompleteScene copies the outline citations onto a %s scene, beside teachingStage',
    (type) => {
      const scene = buildCompleteScene(outline(type, UNITS), content(type), [], 'stage-x')!;
      expect(scene.sourceContentUnitIds).toEqual(UNITS);
      expect(scene.teachingStage).toEqual({ key: 'lesson_introduction', flowIndex: 0 });
      // A copy, never the outline's own array: a later outline mutation cannot
      // reach the persisted scene.
      expect(scene.sourceContentUnitIds).not.toBe(UNITS);
    },
  );

  it.each(KINDS)(
    'omits the field when the outline has none (%s) — absent means unknown',
    (type) => {
      const scene = buildCompleteScene(outline(type), content(type), [], 'stage-x')!;
      expect('sourceContentUnitIds' in scene).toBe(false);
    },
  );

  it('an empty citation list is copied as empty, not dropped (it is a statement, not unknown)', () => {
    const scene = buildCompleteScene(outline('slide', []), content('slide'), [], 'stage-x')!;
    expect(scene.sourceContentUnitIds).toEqual([]);
  });

  it('the built scene passes the DSL scene validator with and without the binding', () => {
    for (const ids of [UNITS, undefined]) {
      const scene = buildCompleteScene(outline('slide', ids), content('slide'), [], 'stage-x')!;
      expect(validateScene(scene)).toEqual({ valid: true });
    }
  });

  it('outline type changes and media-id normalisation preserve the citations', () => {
    for (const target of KINDS) {
      expect(changeOutlineType(outline('slide', UNITS), target).sourceContentUnitIds).toEqual(
        UNITS,
      );
    }
    expect(uniquifyMediaElementIds([outline('slide', UNITS)])[0]?.sourceContentUnitIds).toEqual(
      UNITS,
    );
  });
});
