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

/** An objective's slides, and the check quiz that closes them (g5 flows). */
export const OBJECTIVE_EXPLANATION_STAGE_KEY = 'outcome_visual_explanations';
export const OBJECTIVE_CHECK_STAGE_KEY = 'outcome_check_understanding';
const OBJECTIVE_WORKED_EXAMPLES_STAGE_KEY = 'outcome_worked_examples';

/**
 * The teaching stage a scene inserted at `insertIndex` inherits: the previous
 * scene's when inserting mid-list, the first scene's when inserting at 0, and
 * none (`undefined`) when the stage's scenes carry no teaching stage (non-package
 * stages). Never inferred from titles.
 *
 * Owner, 26 Nov 2026 — an objective's check quiz holds its flow position alone, so a
 * page added right after it inherited a position it can never share, and the lesson
 * then refused every new slide and Submit («the lesson's teaching order already has a
 * problem»):
 * - after a check quiz, a new page takes the next scene's position (the next part);
 * - a quiz added right after an objective's slides, where that objective's check quiz
 *   is missing (deleted), takes the check quiz's position, which repairs the lesson;
 * - after the lesson's last check quiz there is no valid position: `null`.
 */
export function teachingStageForInsertion(
  scenes: readonly Scene[],
  insertIndex: number,
  type: EditableSceneType = 'slide',
): TeachingStageRef | null | undefined {
  const previous = scenes[insertIndex - 1];
  const next = scenes[insertIndex];
  const before = previous?.teachingStage;
  // g5.v1–v3 put worked examples between an objective's slides and its check quiz,
  // so there the empty position after the slides is not the check's (review, 26 Nov).
  const checkFollowsSlides = !scenes.some(
    (scene) => scene.teachingStage?.key === OBJECTIVE_WORKED_EXAMPLES_STAGE_KEY,
  );
  if (type === 'quiz' && checkFollowsSlides && before?.key === OBJECTIVE_EXPLANATION_STAGE_KEY) {
    const checkAt = before.flowIndex + 1;
    const taken = scenes.some((scene) => scene.teachingStage?.flowIndex === checkAt);
    const after = next?.teachingStage;
    if (
      !taken &&
      (!after || (after.flowIndex > checkAt && after.key !== OBJECTIVE_CHECK_STAGE_KEY))
    ) {
      return { key: OBJECTIVE_CHECK_STAGE_KEY, flowIndex: checkAt };
    }
  }
  if (before?.key === OBJECTIVE_CHECK_STAGE_KEY) {
    const after = next?.teachingStage;
    return after && after.key !== OBJECTIVE_CHECK_STAGE_KEY ? after : null;
  }
  return (previous ?? scenes[0])?.teachingStage;
}

/**
 * Owner, 26 Nov 2026: a package scene alone at its flow position (an objective's check
 * quiz, an objective's last slide). Deleting it leaves that position empty, and the
 * lesson then refuses every new slide and Submit, so the editor never deletes it.
 */
export function isOnlySceneAtItsPosition(
  scenes: readonly Pick<Scene, 'id' | 'teachingStage'>[],
  scene: Pick<Scene, 'id' | 'teachingStage'>,
): boolean {
  const position = scene.teachingStage?.flowIndex;
  if (position === undefined) return false;
  return !scenes.some(
    (other) => other.id !== scene.id && other.teachingStage?.flowIndex === position,
  );
}

/**
 * Owner, 26 Nov 2026: whether a package's scenes still follow its teaching flow — their
 * flow positions never go back (a slide dragged into another part of the lesson makes
 * them go back, and the lesson then refuses every new slide and Submit). Scenes without
 * a position (non-package stages) are ignored, so their order is always kept.
 */
export function keepsTeachingOrder(scenes: readonly Pick<Scene, 'teachingStage'>[]): boolean {
  let last = -Infinity;
  for (const scene of scenes) {
    const position = scene.teachingStage?.flowIndex;
    if (position === undefined) continue;
    if (position < last) return false;
    last = position;
  }
  return true;
}

/**
 * The current scenes put back in `before`'s order — only the order: each scene keeps
 * its current content (review, 26 Nov 2026: a regeneration that finished during a
 * refused drag must not be undone). `null` when scenes were added or removed meanwhile.
 */
export function inOrderOf(
  current: readonly Scene[],
  before: readonly Pick<Scene, 'id'>[],
): Scene[] | null {
  if (current.length !== before.length) return null;
  const byId = new Map(current.map((scene) => [scene.id, scene] as const));
  const restored: Scene[] = [];
  for (const { id } of before) {
    const scene = byId.get(id);
    if (!scene) return null;
    restored.push(scene);
  }
  return restored.map((scene, index) =>
    scene.order === index + 1 ? scene : { ...scene, order: index + 1 },
  );
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
