import type {
  Action,
  InteractiveContent,
  PBLContent,
  PBLProject,
  PPTElement,
  QuizContent,
  QuizQuestion,
  Scene,
  SlideAssistance,
  SlideBackground,
  SlideContent,
  WidgetConfigBase,
  WidgetType,
} from '@openmaic/dsl';

/** AI-generated slide payload before it is assembled into a scene. */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
  /**
   * On-demand assistance authored for this slide, separately from the canvas.
   * Placed on `SlideContent.assistance` by the scene builder, and only for a
   * role that allows it.
   */
  assistance?: SlideAssistance;
}

/** AI-generated quiz payload before it is assembled into a scene. */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/** AI-generated interactive payload before it is assembled into a scene. */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfigBase;
}

/** AI-generated PBL payload. The persisted project contract is owned by the DSL. */
export interface GeneratedPBLContent {
  projectV2: PBLProject;
}

export type GeneratedSceneContent =
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent;

import type { SceneTeachingSkills, TeachingStageRef } from './outline-types.js';

export type CompleteSceneContent = SlideContent | QuizContent | InteractiveContent | PBLContent;

/**
 * Scene assembled by the package, including the originating outline identity
 * and — when the outline carried one — its teaching-stage reference, its
 * Teaching Skills carrier and its Content Unit citations
 * (`sourceContentUnitIds`, a `SceneCore` field of the contract), each copied
 * exactly (never re-derived) from outline to scene.
 */
export type CompleteScene = Scene<Action, CompleteSceneContent> & {
  outlineId: string;
  teachingStage?: TeachingStageRef;
  /** Teaching Skills assignment + classification (Module 2 W9), verbatim from the outline. */
  teachingSkills?: SceneTeachingSkills;
};

/** Widget configuration emitted by the model and normalized by the scene layer. */
export type WidgetConfig = WidgetConfigBase;
