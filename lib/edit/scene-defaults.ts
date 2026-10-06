import { nanoid } from 'nanoid';
import type { Scene, QuizContent } from '@/lib/types/stage';
import type { TeachingStageRef } from '@/lib/types/teaching-package';
import { createBlankSlideScene } from '@/lib/edit/slide-defaults';

export type EditableSceneType = 'slide' | 'quiz';

/** Build the valid empty content used when a quiz first enters authoring. */
export function createBlankQuizScene(stageId: string, title: string, order: number): Scene {
  const content: QuizContent = { type: 'quiz', questions: [] };

  return {
    id: nanoid(),
    stageId,
    type: 'quiz',
    title,
    order,
    content,
    actions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * The teaching stage a scene inserted at `insertIndex` inherits: the previous
 * scene's when inserting mid-list, the first scene's when inserting at 0, and
 * none when the stage's scenes carry no teaching stage (non-package stages).
 * Never inferred from titles, types, or order.
 */
export function teachingStageForInsertion(
  scenes: readonly Scene[],
  insertIndex: number,
): TeachingStageRef | undefined {
  const neighbor = scenes[insertIndex - 1] ?? scenes[0];
  return neighbor?.teachingStage;
}

export interface BlankSceneOptions {
  /**
   * Teaching-stage identity inherited from the neighboring scene when a new
   * scene is inserted into a Kafuo package stage. Never inferred from titles
   * or order; absent for non-package stages.
   */
  teachingStage?: TeachingStageRef;
}

/** Build a fresh scene for one of the page types exposed by the rail chooser. */
export function createBlankEditableScene(
  type: EditableSceneType,
  stageId: string,
  title: string,
  order: number,
  options: BlankSceneOptions = {},
): Scene {
  const base =
    type === 'slide'
      ? createBlankSlideScene(stageId, title, order)
      : createBlankQuizScene(stageId, title, order);
  return options.teachingStage ? { ...base, teachingStage: options.teachingStage } : base;
}

/**
 * Insert at an array index and keep persisted scene order aligned with the
 * visible rail. Clamping makes the helper safe for leading and trailing gaps.
 */
export function insertSceneAtIndex(
  scenes: readonly Scene[],
  scene: Scene,
  requestedIndex: number,
): Scene[] {
  const index = Math.max(0, Math.min(requestedIndex, scenes.length));
  const next = [...scenes.slice(0, index), scene, ...scenes.slice(index)];
  return next.map((item, itemIndex) =>
    item.order === itemIndex + 1 ? item : { ...item, order: itemIndex + 1 },
  );
}
