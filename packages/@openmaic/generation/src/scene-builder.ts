import { nanoid } from 'nanoid';
import {
  slideRoleAllowsAssistance,
  validateGeneratedSlideSemantics,
  type Action,
  type GeneratedSlideSemanticsOptions,
  type Slide,
  type SlideTheme,
} from '@openmaic/dsl';
import { OUTLINE_SLIDE_SEMANTICS_ERROR, slideSemanticsFromOutline } from './outline-semantics.js';
import type { SceneOutline } from './outline-types.js';
import type {
  CompleteScene,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSlideContent,
} from './scene-types.js';

export interface BuildCompleteSceneOptions {
  /**
   * Stable identity supplied by retrying/upserting consumers. Reusing it turns
   * a replay into the same logical scene instead of appending a duplicate.
   * The default remains a random `nanoid()` for drop-in compatibility.
   */
  sceneId?: string;
}

/** Build a complete, store-independent scene from generated primitives. */
export function buildCompleteScene(
  outline: SceneOutline,
  content:
    | GeneratedSlideContent
    | GeneratedQuizContent
    | GeneratedInteractiveContent
    | GeneratedPBLContent,
  actions: Action[],
  stageId: string,
  options: BuildCompleteSceneOptions = {},
): CompleteScene | null {
  const sceneId = options.sceneId ?? nanoid();
  const timestamps = { createdAt: Date.now(), updatedAt: Date.now() };

  if (outline.type === 'slide' && 'elements' in content) {
    const defaultTheme: SlideTheme = {
      backgroundColor: '#ffffff',
      themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
      outline: { color: '#d14424', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
    };
    // The outline's planned classification is authoritative and is copied
    // verbatim to where the shared contract places it: `slideType` becomes the
    // canvas's `Slide.type`, `contentRole` / `contentKind` sit on the
    // SlideContent beside the canvas. Never derived from the generated
    // elements or any text; an unclassified outline yields an unclassified
    // slide (no `type`, no role) exactly as before.
    const { slideType, contentRole, contentKind } = slideSemanticsFromOutline(outline);
    const canvas: Slide = {
      id: nanoid(),
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: defaultTheme,
      elements: content.elements,
      background: content.background,
      ...(slideType !== undefined && { type: slideType }),
    };
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'slide',
        canvas,
        ...(contentRole !== undefined && { contentRole }),
        ...(contentKind !== undefined && { contentKind }),
        // Separately authored on-demand assistance sits beside the canvas, never
        // on it, and only for a role that allows it.
        ...(content.assistance !== undefined &&
          slideRoleAllowsAssistance(contentRole) && { assistance: content.assistance }),
      },
      actions,
      ...timestamps,
      ...(outline.teachingStage !== undefined && { teachingStage: outline.teachingStage }),
      ...(outline.teachingSkills !== undefined && { teachingSkills: outline.teachingSkills }),
      ...(outline.sourceContentUnitIds !== undefined && {
        sourceContentUnitIds: [...outline.sourceContentUnitIds],
      }),
    };
  }

  if (outline.type === 'quiz' && 'questions' in content) {
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'quiz',
      title: outline.title,
      order: outline.order,
      content: { type: 'quiz', questions: content.questions },
      actions,
      ...timestamps,
      ...(outline.teachingStage !== undefined && { teachingStage: outline.teachingStage }),
      ...(outline.teachingSkills !== undefined && { teachingSkills: outline.teachingSkills }),
      ...(outline.sourceContentUnitIds !== undefined && {
        sourceContentUnitIds: [...outline.sourceContentUnitIds],
      }),
    };
  }

  if (outline.type === 'interactive' && 'html' in content) {
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'interactive',
      title: outline.title,
      order: outline.order,
      content: {
        type: 'interactive',
        url: '',
        html: content.html,
        widgetType: content.widgetType,
        widgetConfig: content.widgetConfig,
      },
      actions,
      ...timestamps,
      ...(outline.teachingStage !== undefined && { teachingStage: outline.teachingStage }),
      ...(outline.teachingSkills !== undefined && { teachingSkills: outline.teachingSkills }),
      ...(outline.sourceContentUnitIds !== undefined && {
        sourceContentUnitIds: [...outline.sourceContentUnitIds],
      }),
    };
  }

  if (outline.type === 'pbl' && 'projectV2' in content) {
    return {
      id: sceneId,
      outlineId: outline.id,
      stageId,
      type: 'pbl',
      title: outline.title,
      order: outline.order,
      content: { type: 'pbl', projectV2: content.projectV2 },
      actions,
      ...timestamps,
      ...(outline.teachingStage !== undefined && { teachingStage: outline.teachingStage }),
      ...(outline.teachingSkills !== undefined && { teachingSkills: outline.teachingSkills }),
      ...(outline.sourceContentUnitIds !== undefined && {
        sourceContentUnitIds: [...outline.sourceContentUnitIds],
      }),
    };
  }

  return null;
}

/**
 * Fail-instead-of-drop check for a NEWLY GENERATED scene: `buildCompleteScene`
 * stays lenient (an unclassified legacy outline yields an unclassified slide),
 * so a generation path calls this right after it to refuse a scene whose slide
 * semantics are missing or invalid rather than ship it unclassified. Throws the
 * same `OUTLINE_SLIDE_SEMANTICS_INVALID`-prefixed failure the outline gate
 * raises, which callers already treat as a retryable bad generation.
 *
 * Never call it on a persisted or imported scene — legacy slides are validly
 * unclassified.
 */
export function assertGeneratedSlideScene(
  scene: Pick<CompleteScene, 'content' | 'title'>,
  options: GeneratedSlideSemanticsOptions = {},
): void {
  const result = validateGeneratedSlideSemantics(scene.content, options);
  if (result.valid) return;
  const shown = result.errors.map((issue) => `${issue.path} ${issue.message}`).join('; ');
  throw new Error(
    `${OUTLINE_SLIDE_SEMANTICS_ERROR}: generated scene ${JSON.stringify(scene.title)} has invalid slide semantics: ${shown}`,
  );
}
