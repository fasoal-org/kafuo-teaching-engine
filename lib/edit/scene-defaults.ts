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
/** The stages an objective's block opens with (g5.v2 teaching cards, v3+ explanations). */
const OBJECTIVE_OPENING_STAGE_KEYS: readonly string[] = [
  OBJECTIVE_EXPLANATION_STAGE_KEY,
  'outcome_teaching_cards',
];

/**
 * Whether this lesson's check quizzes sit right after their objective's slides (g5.v4+),
 * read from the lesson itself: no worked-examples stage, and every check quiz that
 * follows slides directly sits one position after them (g5.v1–v3 put worked examples
 * in between — review, 26 Nov 2026). No such check quiz at all → unknown → `false`.
 */
function checkSitsRightAfterSlides(scenes: readonly Scene[]): boolean {
  let previous: TeachingStageRef | undefined;
  let seen = false;
  for (const scene of scenes) {
    const stage = scene.teachingStage;
    if (!stage) continue;
    if (stage.key === OBJECTIVE_WORKED_EXAMPLES_STAGE_KEY) return false;
    if (
      stage.key === OBJECTIVE_CHECK_STAGE_KEY &&
      previous?.key === OBJECTIVE_EXPLANATION_STAGE_KEY
    ) {
      if (stage.flowIndex !== previous.flowIndex + 1) return false;
      seen = true;
    }
    previous = stage;
  }
  return seen;
}

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
 * - after a check quiz, a new page takes the next objective's opening position;
 * - a quiz added right after an objective's slides, where that objective's check quiz
 *   is missing (deleted), takes the check quiz's position, which repairs the lesson;
 * - a page added between two check quizzes whose objective lost all its slides takes
 *   that objective's slides position, which repairs the lesson (review, 26 Nov);
 * - anywhere else after a check quiz (after the lesson's last one, or before a
 *   lesson-level stage such as the learning game) there is no valid position: `null`.
 * The two repairs run only where the lesson shows its check quizzes right after their
 * slides (g5.v4+).
 */
export function teachingStageForInsertion(
  scenes: readonly Scene[],
  insertIndex: number,
  type: EditableSceneType = 'slide',
): TeachingStageRef | null | undefined {
  const previous = scenes[insertIndex - 1];
  const next = scenes[insertIndex];
  const before = previous?.teachingStage;
  const after = next?.teachingStage;
  const taken = (flowIndex: number) =>
    scenes.some((scene) => scene.teachingStage?.flowIndex === flowIndex);
  const repairable = checkSitsRightAfterSlides(scenes);
  if (type === 'quiz' && repairable && before?.key === OBJECTIVE_EXPLANATION_STAGE_KEY) {
    const checkAt = before.flowIndex + 1;
    if (
      !taken(checkAt) &&
      (!after || (after.flowIndex > checkAt && after.key !== OBJECTIVE_CHECK_STAGE_KEY))
    ) {
      return { key: OBJECTIVE_CHECK_STAGE_KEY, flowIndex: checkAt };
    }
  }
  if (before?.key === OBJECTIVE_CHECK_STAGE_KEY) {
    const slidesAt = before.flowIndex + 1;
    if (
      repairable &&
      after?.key === OBJECTIVE_CHECK_STAGE_KEY &&
      after.flowIndex > slidesAt &&
      !taken(slidesAt)
    ) {
      return { key: OBJECTIVE_EXPLANATION_STAGE_KEY, flowIndex: slidesAt };
    }
    return after && OBJECTIVE_OPENING_STAGE_KEYS.includes(after.key) ? after : null;
  }
  return (previous ?? scenes[0])?.teachingStage;
}

/**
 * Owner, 26 Nov 2026: a package scene alone at its flow position (an objective's check
 * quiz, an objective's last slide). Deleting it leaves that position empty, and the
 * lesson then refuses every new slide and Submit, so the editor never deletes it.
 * An objective's last SLIDE counts alone: a «جرّب بنفسك» practice quiz sharing its
 * position does not let the objective lose every slide (review, 26 Nov 2026).
 */
export function isOnlySceneAtItsPosition(
  scenes: readonly Pick<Scene, 'id' | 'type' | 'teachingStage'>[],
  scene: Pick<Scene, 'id' | 'type' | 'teachingStage'>,
): boolean {
  const position = scene.teachingStage?.flowIndex;
  if (position === undefined) return false;
  const rest = scenes.filter((other) => other.id !== scene.id);
  return emptiedFlowPositions([...rest, scene], rest).includes(position);
}

/**
 * ED-3 (critical items, 27 Nov 2026): the flow positions that `after` leaves without the
 * page `before` had there — the one rule behind the rail's delete guard, the server's
 * save guard and the course-edit tool's delete:
 * - a position some scene of `before` holds and no scene of `after` holds;
 * - an objective's slides position whose slides are all gone (a «جرّب بنفسك» quiz that
 *   shares the position never stands in for the objective's slides).
 * Only positions `before` held are judged, so a lesson whose order is already broken
 * keeps saving; scenes without a position (non-package stages) are never judged.
 */
export function emptiedFlowPositions(
  before: readonly Pick<Scene, 'type' | 'teachingStage'>[],
  after: readonly Pick<Scene, 'type' | 'teachingStage'>[],
): number[] {
  const held = new Set<number>();
  const slidesHeld = new Set<number>();
  for (const scene of after) {
    const position = scene.teachingStage?.flowIndex;
    if (position === undefined) continue;
    held.add(position);
    if (scene.type === 'slide') slidesHeld.add(position);
  }
  const emptied = new Set<number>();
  for (const scene of before) {
    const stage = scene.teachingStage;
    if (!stage) continue;
    const objectiveSlide = scene.type === 'slide' && stage.key === OBJECTIVE_EXPLANATION_STAGE_KEY;
    if (!held.has(stage.flowIndex) || (objectiveSlide && !slidesHeld.has(stage.flowIndex))) {
      emptied.add(stage.flowIndex);
    }
  }
  return [...emptied].sort((a, b) => a - b);
}

/**
 * ED-6 (critical items, 27 Nov 2026): the Teaching Skills a page added at `stage` carries —
 * a copy of a scene's at that same flow position (the policy there is the same), else of
 * the nearest scene of the same teaching stage (a flow item's Skill policy is projected
 * verbatim onto every position it expands to), the same scene type first. Without it a
 * blank page on a Skills-governed package has no classification and Submit refuses it.
 * `undefined` when no such scene carries Skills (a legacy package): nothing is invented.
 * Only the assignment is copied — never an alignment baseline, so the page still needs
 * the reviewer's alignment confirmation like any edited page.
 */
export function teachingSkillsForInsertion(
  scenes: readonly Pick<Scene, 'type' | 'teachingStage' | 'teachingSkills'>[],
  insertIndex: number,
  stage: TeachingStageRef | null | undefined,
  type: EditableSceneType,
): Scene['teachingSkills'] {
  if (!stage) return undefined;
  let chosen: Scene['teachingSkills'];
  let chosenRank = Infinity;
  let chosenDistance = Infinity;
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index]!;
    const own = scene.teachingStage;
    if (!scene.teachingSkills || !own || own.key !== stage.key) continue;
    // Same position before same stage; the same scene type before another one.
    const rank = (own.flowIndex === stage.flowIndex ? 0 : 2) + (scene.type === type ? 0 : 1);
    const distance = Math.abs(index - insertIndex);
    if (rank < chosenRank || (rank === chosenRank && distance < chosenDistance)) {
      chosen = scene.teachingSkills;
      chosenRank = rank;
      chosenDistance = distance;
    }
  }
  return chosen ? structuredClone(chosen) : undefined;
}

/**
 * ED-7 (critical items, 27 Nov 2026): a slide with nothing on its canvas — the page the
 * rail's «+ → Slide» adds. Regenerate cannot fill it (an empty result is refused,
 * f0f3e43f); «+ → Generate with AI» can.
 */
export function isBlankSlideScene(scene: Pick<Scene, 'type' | 'content'>): boolean {
  return (
    scene.type === 'slide' &&
    scene.content.type === 'slide' &&
    scene.content.canvas.elements.length === 0
  );
}

/**
 * Review, 26 Nov 2026: a check quiz the editor rebuilds where one was deleted is served
 * from the Kafuo question bank like its siblings — never an empty quiz of its own.
 */
export function rebuildsBankCheckQuiz(
  scenes: readonly Pick<Scene, 'teachingStage' | 'questionSource'>[],
  stage: TeachingStageRef | null | undefined,
  type: EditableSceneType,
): boolean {
  return (
    type === 'quiz' &&
    stage?.key === OBJECTIVE_CHECK_STAGE_KEY &&
    scenes.some(
      (scene) =>
        scene.teachingStage?.key === OBJECTIVE_CHECK_STAGE_KEY && scene.questionSource === 'bank',
    )
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
  /** ED-6: the Teaching Skills a governed package's new page carries ({@link teachingSkillsForInsertion}). */
  teachingSkills?: Scene['teachingSkills'];
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
  return {
    ...base,
    ...(options.teachingStage ? { teachingStage: options.teachingStage } : {}),
    ...(options.teachingSkills ? { teachingSkills: options.teachingSkills } : {}),
  };
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
