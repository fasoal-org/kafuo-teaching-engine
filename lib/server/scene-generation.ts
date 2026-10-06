/**
 * App adapters around the store-independent @openmaic/generation scene layer.
 */

import type { LanguageModel } from 'ai';
import {
  applyOutlineFallbacks,
  assertGeneratedSlideScene,
  buildCompleteScene,
  buildLanguageText,
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type AgentInfo,
  type ImageMapping,
  type PdfImage,
  type GeneratedSceneContent,
  type SceneGenerationContext,
  type SceneOutline,
} from '@openmaic/generation';
import { callLLM } from '@/lib/ai/llm';
import type { StageAPI } from '@/lib/api/stage-api';
import { createLogger } from '@/lib/logger';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import type { Action } from '@/lib/types/action';
import type { Scene, SceneContent, TextDirection } from '@/lib/types/stage';

const log = createLogger('Generation');

/** Persist a package-built scene through the app's stage-store API. */
export function createSceneWithActions(
  outline: SceneOutline,
  content: GeneratedSceneContent,
  actions: Action[],
  api: StageAPI,
): string | null {
  const scene = buildCompleteScene(outline, content, actions, '');
  if (!scene) return null;
  // Fail instead of drop: a newly generated scene with missing or invalid
  // slide semantics — or independent practice without its separately authored
  // on-demand assistance — is refused rather than persisted.
  assertGeneratedSlideScene(scene);

  const result = api.scene.create({
    type: scene.type,
    title: scene.title,
    order: scene.order,
    // The package's PBL contract is runtime-compatible with the app overlay;
    // the app type retains stronger learner-state field types.
    content: scene.content as SceneContent,
    actions: scene.actions,
    outlineId: scene.outlineId,
    ...(scene.teachingStage !== undefined && { teachingStage: scene.teachingStage }),
    ...(scene.teachingSkills !== undefined && { teachingSkills: scene.teachingSkills }),
    ...(scene.sourceContentUnitIds !== undefined && {
      sourceContentUnitIds: scene.sourceContentUnitIds,
    }),
  });
  return result.success ? (result.data ?? null) : null;
}

/** Generate both halves and assemble a store-independent app scene. */
export async function buildSceneFromOutline(
  outline: SceneOutline,
  aiCall: AICallFn,
  stageId: string,
  assignedImages?: PdfImage[],
  imageMapping?: ImageMapping,
  languageModel?: LanguageModel,
  visionEnabled?: boolean,
  ctx?: SceneGenerationContext,
  agents?: AgentInfo[],
  onPhaseChange?: (phase: 'content' | 'actions') => void,
  userProfile?: string,
  languageDirective?: string,
  /** The Stage's authoritative base direction; undefined for a legacy Stage. */
  textDirection?: TextDirection,
): Promise<Scene | null> {
  const safeOutline = applyOutlineFallbacks(outline, !!languageModel, { logger: log });
  const langText = buildLanguageText(languageDirective, safeOutline.languageNote);

  onPhaseChange?.('content');
  const content = await generateSceneContent(safeOutline, aiCall, {
    assignedImages,
    imageMapping,
    visionEnabled,
    agents,
    languageDirective: langText,
    logger: log,
    ...(textDirection !== undefined ? { textDirection } : {}),
    ...(languageModel
      ? {
          pblLoopFallback: (input) =>
            generatePBLV2Project(input, languageModel, callLLM, { logger: log }),
        }
      : {}),
  });
  if (!content) return null;

  onPhaseChange?.('actions');
  const actions = await generateSceneActions(safeOutline, content, aiCall, {
    ctx,
    agents,
    userProfile,
    languageDirective: langText,
    logger: log,
  });

  const scene = buildCompleteScene(safeOutline, content, actions, stageId);
  if (scene) assertGeneratedSlideScene(scene);
  return scene as Scene | null;
}
