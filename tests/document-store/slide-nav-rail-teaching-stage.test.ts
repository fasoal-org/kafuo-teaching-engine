import { describe, expect, it } from 'vitest';

import {
  createBlankEditableScene,
  emptiedFlowPositions,
  inOrderOf,
  isBlankSlideScene,
  isOnlySceneAtItsPosition,
  keepsTeachingOrder,
  rebuildsBankCheckQuiz,
  teachingSkillsForInsertion,
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

  // Owner, 26 Nov 2026: an objective's check quiz holds its flow position alone.
  const EXPL_1 = { key: 'outcome_visual_explanations', flowIndex: 1 };
  const CHECK_1 = { key: 'outcome_check_understanding', flowIndex: 2 };
  const EXPL_2 = { key: 'outcome_visual_explanations', flowIndex: 3 };
  const CHECK_2 = { key: 'outcome_check_understanding', flowIndex: 4 };

  it('a page added right after a check quiz takes the next part’s position, never the quiz’s', () => {
    const scenes = [scene('s1', 1, EXPL_1), scene('q1', 2, CHECK_1), scene('s2', 3, EXPL_2)];
    expect(teachingStageForInsertion(scenes, 2, 'slide')).toEqual(EXPL_2);
    expect(teachingStageForInsertion(scenes, 2, 'quiz')).toEqual(EXPL_2);
  });

  it('no page is added after the lesson’s last check quiz (no valid position)', () => {
    const scenes = [scene('s1', 1, EXPL_1), scene('q1', 2, CHECK_1)];
    expect(teachingStageForInsertion(scenes, 2, 'slide')).toBeNull();
  });

  it('a quiz added where an objective’s check quiz was deleted takes that position back', () => {
    const scenes = [scene('s1', 1, EXPL_1), scene('s2', 2, EXPL_2), scene('q2', 3, CHECK_2)];
    expect(teachingStageForInsertion(scenes, 1, 'quiz')).toEqual(CHECK_1);
    // A slide there stays in its objective's slides.
    expect(teachingStageForInsertion(scenes, 1, 'slide')).toEqual(EXPL_1);
    // With the check quiz present, a quiz stays in the slides' position as before.
    const whole = [scene('s1', 1, EXPL_1), scene('q1', 2, CHECK_1), scene('s2', 3, EXPL_2)];
    expect(teachingStageForInsertion(whole, 1, 'quiz')).toEqual(EXPL_1);
  });

  it('g5.v1–v3 (worked examples before the check): an empty position is never taken as the check', () => {
    // Position 3 (this objective's worked examples) holds no scene any more.
    const EXPL = { key: 'outcome_visual_explanations', flowIndex: 2 };
    const CHECK = { key: 'outcome_check_understanding', flowIndex: 4 };
    const NEXT_EXPL = { key: 'outcome_visual_explanations', flowIndex: 5 };
    const NEXT_CHECK = { key: 'outcome_check_understanding', flowIndex: 7 };
    // This objective's worked examples are gone: a quiz after its slides stays a slide position.
    const noWorked = [
      scene('s1', 1, EXPL),
      scene('q1', 2, CHECK),
      scene('s2', 3, NEXT_EXPL),
      scene('w2', 4, { key: 'outcome_worked_examples', flowIndex: 6 }),
      scene('q2', 5, NEXT_CHECK),
    ];
    expect(teachingStageForInsertion(noWorked, 1, 'quiz')).toEqual(EXPL);
    // Even without a worked-examples scene left, a check right after is never doubled.
    const nextIsCheck = [scene('s1', 1, EXPL), scene('q1', 2, CHECK)];
    expect(teachingStageForInsertion(nextIsCheck, 1, 'quiz')).toEqual(EXPL);
    // A broken v3 lesson with no worked-example scene left: the check two positions after
    // the slides still tells the lesson's shape, so nothing is "repaired" into it.
    const v3Broken = [scene('s1', 1, EXPL), scene('q1', 2, CHECK), scene('s2', 3, NEXT_EXPL)];
    expect(teachingStageForInsertion(v3Broken, 3, 'quiz')).toEqual(NEXT_EXPL);
  });

  // Review, 26 Nov 2026.
  it('a page between two check quizzes whose objective lost every slide takes its slides position', () => {
    const scenes = [scene('s1', 1, EXPL_1), scene('q1', 2, CHECK_1), scene('q2', 3, CHECK_2)];
    expect(teachingStageForInsertion(scenes, 2, 'slide')).toEqual(EXPL_2);
    expect(teachingStageForInsertion(scenes, 2, 'quiz')).toEqual(EXPL_2);
  });

  it('g5.v2–v5: no page is added between the last check quiz and the learning game', () => {
    const GAME = { key: 'lesson_learning_game', flowIndex: 3 };
    const scenes = [scene('s1', 1, EXPL_1), scene('q1', 2, CHECK_1), scene('g', 3, GAME)];
    expect(teachingStageForInsertion(scenes, 2, 'slide')).toBeNull();
  });

  it('an objective’s last slide is kept even when its «جرّب بنفسك» quiz shares the position', () => {
    const slide = scene('s1', 1, EXPL_1);
    const attempt = { ...scene('try', 2, EXPL_1), type: 'quiz' } as Scene;
    const scenes = [slide, attempt, scene('q1', 3, CHECK_1)];
    expect(isOnlySceneAtItsPosition(scenes, slide)).toBe(true);
    expect(isOnlySceneAtItsPosition(scenes, attempt)).toBe(false);
  });

  it('a rebuilt check quiz is a question-bank quiz when its siblings are', () => {
    const bankCheck = { ...scene('q2', 3, CHECK_2), questionSource: 'bank' } as Scene;
    const scenes = [scene('s1', 1, EXPL_1), scene('s2', 2, EXPL_2), bankCheck];
    expect(rebuildsBankCheckQuiz(scenes, CHECK_1, 'quiz')).toBe(true);
    expect(rebuildsBankCheckQuiz(scenes, EXPL_1, 'quiz')).toBe(false);
    expect(rebuildsBankCheckQuiz(scenes, CHECK_1, 'slide')).toBe(false);
    const ownQuestions = [scene('s1', 1, EXPL_1), scene('q2', 2, CHECK_2)];
    expect(rebuildsBankCheckQuiz(ownQuestions, CHECK_1, 'quiz')).toBe(false);
  });

  it('the only scene of a flow position is the one the editor never deletes', () => {
    const scenes = [
      scene('s1', 1, EXPL_1),
      scene('q1', 2, CHECK_1),
      scene('s2', 3, EXPL_2),
      scene('s3', 4, EXPL_2),
    ];
    expect(isOnlySceneAtItsPosition(scenes, scenes[1]!)).toBe(true);
    expect(isOnlySceneAtItsPosition(scenes, scenes[0]!)).toBe(true);
    expect(isOnlySceneAtItsPosition(scenes, scenes[2]!)).toBe(false);
    // A non-package scene (no position) is never held back.
    expect(isOnlySceneAtItsPosition([scene('x', 1)], scene('x', 1))).toBe(false);
  });

  it('a drag keeps the teaching order only while it stays within its own part', () => {
    const s1 = scene('s1', 1, EXPL_1);
    const s1b = scene('s1b', 2, EXPL_1);
    const q1 = scene('q1', 3, CHECK_1);
    const s2 = scene('s2', 4, EXPL_2);
    expect(keepsTeachingOrder([s1, s1b, q1, s2])).toBe(true);
    // Swapping two slides of the same part is free.
    expect(keepsTeachingOrder([s1b, s1, q1, s2])).toBe(true);
    // A slide dropped into the next part (after its check quiz) breaks the order.
    expect(keepsTeachingOrder([s1, q1, s1b, s2])).toBe(false);
    // A slide of the next part dropped before an earlier part breaks it too.
    expect(keepsTeachingOrder([s2, s1, s1b, q1])).toBe(false);
    // Scenes without a position (non-package stages) never block a drag.
    expect(keepsTeachingOrder([scene('x', 1), s1, scene('y', 2), q1])).toBe(true);
  });

  it('a refused drop puts back only the order; a slide regenerated meanwhile keeps its content', () => {
    const before = [scene('a', 1, EXPL_1), scene('b', 2, CHECK_1), scene('c', 3, EXPL_2)];
    const regenerated = { ...before[0]!, title: 'Regenerated', order: 2 };
    const dropped = [{ ...before[1]!, order: 1 }, regenerated, { ...before[2]!, order: 3 }];
    const restored = inOrderOf(dropped, before);
    expect(restored?.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(restored?.map((entry) => entry.order)).toEqual([1, 2, 3]);
    expect(restored?.[0]?.title).toBe('Regenerated');
    // A scene added or removed during the drag: nothing is put back.
    expect(inOrderOf(dropped.slice(0, 2), before)).toBeNull();
  });

  // ED-3 (critical items, 27 Nov 2026): the one rule the rail and the server share.
  it('names the flow positions a save leaves without their page, and only those', () => {
    const s1 = scene('s1', 1, EXPL_1);
    const s1b = scene('s1b', 2, EXPL_1);
    const attempt = { ...scene('try', 3, EXPL_1), type: 'quiz' } as Scene;
    const q1 = { ...scene('q1', 4, CHECK_1), type: 'quiz' } as Scene;
    const s2 = scene('s2', 5, EXPL_2);
    const all = [s1, s1b, attempt, q1, s2];
    // Removing one of two slides, or the try-it quiz beside the slides, empties nothing.
    expect(emptiedFlowPositions(all, [s1, attempt, q1, s2])).toEqual([]);
    expect(emptiedFlowPositions(all, [s1, s1b, q1, s2])).toEqual([]);
    // The check quiz alone at its position, and the objective's last slides.
    expect(emptiedFlowPositions(all, [s1, s1b, attempt, s2])).toEqual([CHECK_1.flowIndex]);
    expect(emptiedFlowPositions(all, [attempt, q1, s2])).toEqual([EXPL_1.flowIndex]);
    // A page re-tagged away from its position empties it too.
    expect(
      emptiedFlowPositions(all, [s1, s1b, attempt, { ...q1, teachingStage: EXPL_2 }, s2]),
    ).toEqual([CHECK_1.flowIndex]);
    // A new page that takes the position keeps it held (a replacement, not a gap).
    const rebuilt = { ...scene('q1-new', 4, CHECK_1), type: 'quiz' } as Scene;
    expect(emptiedFlowPositions(all, [s1, s1b, attempt, rebuilt, s2])).toEqual([]);
    // A position the lesson had already lost is never asked about (it keeps saving).
    expect(emptiedFlowPositions([s1, s2], [s2, s1])).toEqual([]);
    // Non-package scenes carry no position.
    expect(emptiedFlowPositions([scene('x', 1)], [])).toEqual([]);
  });

  // ED-6 (critical items, 27 Nov 2026): a blank page on a Skills-governed package.
  it('a page added on a governed package carries the Skills of its position, never invented', () => {
    const skills = {
      primary: { skillId: 'explain', version: '1' },
      classification: 'instructional' as const,
    };
    const checkSkills = {
      primary: { skillId: 'check', version: '1' },
      classification: 'instructional' as const,
    };
    const s1 = { ...scene('s1', 1, EXPL_1), teachingSkills: skills };
    const q1 = { ...scene('q1', 2, CHECK_1), type: 'quiz', teachingSkills: checkSkills } as Scene;
    const s2 = scene('s2', 3, EXPL_2);
    const scenes = [s1, q1, s2];
    const copied = teachingSkillsForInsertion(scenes, 1, EXPL_1, 'slide');
    expect(copied).toEqual(skills);
    // A copy, never the sibling's own object.
    expect(copied).not.toBe(skills);
    // No scene at the position carries Skills: the nearest of the same stage does.
    expect(teachingSkillsForInsertion(scenes, 3, EXPL_2, 'slide')).toEqual(skills);
    // A rebuilt check quiz takes another check quiz's Skills, never a slide's.
    const CHECK_2 = { key: 'outcome_check_understanding', flowIndex: 4 };
    expect(teachingSkillsForInsertion(scenes, 3, CHECK_2, 'quiz')).toEqual(checkSkills);
    // A legacy package (no scene carries Skills) and a non-package page get none.
    expect(teachingSkillsForInsertion([s2], 1, EXPL_2, 'slide')).toBeUndefined();
    expect(teachingSkillsForInsertion(scenes, 1, undefined, 'slide')).toBeUndefined();
    const created = createBlankEditableScene('slide', 'stage-1', 'New', 2, {
      teachingStage: EXPL_1,
      teachingSkills: copied,
    });
    expect(created.teachingSkills).toEqual(skills);
    // The alignment baseline is never copied: the page still needs the reviewer's confirmation.
    expect(created.alignmentBaseline).toBeUndefined();
  });

  // ED-7 (critical items, 27 Nov 2026).
  it('a blank page is a slide with nothing on its canvas', () => {
    const blank = createBlankEditableScene('slide', 'stage-1', 'New', 1);
    expect(isBlankSlideScene(blank)).toBe(true);
    expect(isBlankSlideScene(createBlankEditableScene('quiz', 'stage-1', 'New', 1))).toBe(false);
    const filled = {
      ...blank,
      content: {
        ...(blank.content as Extract<Scene['content'], { type: 'slide' }>),
        canvas: {
          ...(blank.content as Extract<Scene['content'], { type: 'slide' }>).canvas,
          elements: [{ id: 't1', type: 'text' } as never],
        },
      },
    } as Scene;
    expect(isBlankSlideScene(filled)).toBe(false);
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
