import { describe, expect, it } from 'vitest';

import {
  createBlankEditableScene,
  teachingStageForInsertion,
} from '@/lib/edit/scene-defaults';
import { duplicateSlideScene } from '@/lib/edit/slide-defaults';
import type { Scene } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const STAGE_A = { key: 'outcome_teaching_cards', flowIndex: 1 };
const STAGE_B = { key: 'outcome_worked_examples', flowIndex: 2 };

function scene(id: string, order: number, teachingStage?: Scene['teachingStage']): Scene {
  const base = makeSlideScene(id, 'stage-1', order, `Scene ${order}`);
  return teachingStage ? { ...base, teachingStage } : base;
}

describe('editor scene insertion/duplication teachingStage inheritance', () => {
  it('inserting mid-list inherits the previous scene’s teachingStage', () => {
    const scenes = [scene('s1', 1, STAGE_A), scene('s2', 2, STAGE_A), scene('s3', 3, STAGE_B)];
    expect(teachingStageForInsertion(scenes, 2)).toEqual(STAGE_A);
  });

  it('inserting at 0 inherits the first scene’s teachingStage', () => {
    const scenes = [scene('s1', 1, STAGE_A), scene('s2', 2, STAGE_B)];
    expect(teachingStageForInsertion(scenes, 0)).toEqual(STAGE_A);
  });

  it('returns none when no scene carries a teachingStage (non-package stage)', () => {
    const scenes = [scene('s1', 1), scene('s2', 2)];
    expect(teachingStageForInsertion(scenes, 1)).toBeUndefined();
    expect(teachingStageForInsertion(scenes, 0)).toBeUndefined();
  });

  it('createBlankEditableScene stamps the inherited teachingStage on the new scene', () => {
    const created = createBlankEditableScene('slide', 'stage-1', 'New', 2, {
      teachingStage: STAGE_A,
    });
    expect(created.teachingStage).toEqual(STAGE_A);
    // Without an inherited stage, no annotation is invented.
    const plain = createBlankEditableScene('quiz', 'stage-1', 'New', 2);
    expect(plain.teachingStage).toBeUndefined();
  });

  it('duplicating a slide preserves the original teachingStage', () => {
    const source = scene('s1', 1, STAGE_A);
    const copy = duplicateSlideScene(source, '(copy)', 2);
    expect(copy.teachingStage).toEqual(STAGE_A);
    // The duplicate must NOT inherit the source's outline identity…
    expect(copy.outlineId).toBeUndefined();
    // …but the teaching stage travels with the content.
    expect(copy.id).not.toBe(source.id);
  });
});
