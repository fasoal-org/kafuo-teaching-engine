import { describe, expect, it } from 'vitest';

import {
  applyOutlineFallbacks,
  buildCompleteScene,
  changeOutlineType,
  uniquifyMediaElementIds,
  type GeneratedSceneContent,
  type SceneOutline,
  type TeachingStageRef,
} from '@openmaic/generation';
import { nanoid } from 'nanoid';

const STAGE: TeachingStageRef = { key: 'lesson_introduction', flowIndex: 0 };

function outline(type: SceneOutline['type'], teachingStage?: TeachingStageRef): SceneOutline {
  return {
    id: 'outline-1',
    type,
    title: 'Intro',
    description: 'd',
    keyPoints: [],
    order: 1,
    ...(teachingStage !== undefined && { teachingStage }),
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

describe('teachingStage propagation (Kafuo integration plan §4.2.2)', () => {
  it.each(['slide', 'quiz', 'interactive', 'pbl'] as const)(
    'buildCompleteScene copies teachingStage exactly onto a %s scene',
    (type) => {
      const scene = buildCompleteScene(outline(type, STAGE), content(type), [], 'stage-x');
      expect(scene?.teachingStage).toEqual({ key: 'lesson_introduction', flowIndex: 0 });
    },
  );

  it.each(['slide', 'quiz', 'interactive', 'pbl'] as const)(
    'buildCompleteScene omits teachingStage when the outline has none (%s)',
    (type) => {
      const scene = buildCompleteScene(outline(type), content(type), [], 'stage-x');
      expect(scene?.teachingStage).toBeUndefined();
      expect('teachingStage' in (scene ?? {})).toBe(false);
    },
  );

  it('changeOutlineType preserves teachingStage across type changes', () => {
    for (const targetType of ['slide', 'quiz', 'interactive', 'pbl'] as const) {
      const changed = changeOutlineType(outline('slide', STAGE), targetType);
      expect(changed.teachingStage).toEqual(STAGE);
    }
  });

  it('outline normalization (uniquifyMediaElementIds) preserves teachingStage', () => {
    const result = uniquifyMediaElementIds([outline('slide', STAGE)]);
    expect(result[0]?.teachingStage).toEqual(STAGE);
  });

  it('applyOutlineFallbacks preserves teachingStage through fallback rewrites', () => {
    // interactive without widget config falls back to slide via a spread.
    const interactive = { ...outline('interactive', STAGE) } as SceneOutline;
    delete (interactive as Partial<SceneOutline>).interactiveConfig;
    delete (interactive as Partial<SceneOutline>).widgetType;
    delete (interactive as Partial<SceneOutline>).widgetOutline;
    const fallback = applyOutlineFallbacks(interactive, true);
    expect(fallback.type).toBe('slide');
    expect(fallback.teachingStage).toEqual(STAGE);
  });
});
