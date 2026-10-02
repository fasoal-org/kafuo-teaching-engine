export type {
  AICallFn,
  AgentInfo,
  GeneratedSlideData,
  GenerationResult,
  SceneGenerationContext,
} from './pipeline-types.js';

export {
  extractInteractiveElements,
  extractWidgetConfig,
  generateSceneActions,
  generateSceneContent,
  GAME_DRAG_MAX_ATTEMPTS,
  generateWidgetContent,
  PBLGenerationError,
  resolveImageIds,
} from './scene-generator.js';
export type {
  ResolvedSkillDefinition,
  SceneActionsFallback,
  SceneActionsFallbackCode,
  SceneActionsOptions,
  SceneContentFailure,
  SceneContentFailureCode,
  SceneContentOptions,
  SceneFlowContext,
  SceneFlowPromptContext,
  SceneSkillPromptContext,
} from './scene-generator.js';
export { buildSceneFlowContext } from './scene-generator.js';
export { assertGeneratedSlideScene, buildCompleteScene } from './scene-builder.js';
export type { BuildCompleteSceneOptions } from './scene-builder.js';
export {
  isAbortError,
  isRetryableGenerationError,
  withGenerationRetry,
} from './generation-retry.js';
export type { GenerationRetryEvent, GenerationRetryOptions } from './generation-retry.js';
export { parseActionsFromStructuredOutput } from './action-parser.js';
export { postProcessInteractiveHtml } from './interactive-post-processor.js';
export {
  KAFUO_DRAG_RUNTIME_MARKER,
  formatGameDragCorrection,
  injectGameDragRuntime,
  validateGameDragContract,
  withGameDragCorrection,
  type GameDragIssue,
  type GameDragIssueCode,
} from './game-drag-runtime.js';
export { generatePBLV2ProjectSingleCall } from './pbl/planner-single-call.js';
export type { PlannerSingleCallFn } from './pbl/planner-single-call.js';
export type { PBLPlannerV2Input, PriorQuizResult } from './pbl/types.js';
export {
  MAX_SYNTHESIS_STAGES,
  PlannerV2Error,
  SCENARIO_SCHEMA_VERSION,
  applyPlannerProficiency,
  buildPlannerSystemPrompt,
  buildScenarioDesignBlock,
  emptyProject,
  instructorProjectAnchor,
  newId,
  normalizeSynthesisChecks,
  plannerCompletionGaps,
} from './pbl/planner-core.js';
export type { PlannerV2Callbacks, PlannerV2ProgressEvent } from './pbl/planner-core.js';
export { loadPBLV2Prompt } from './pbl/prompts/loader.js';
export {
  MAX_ENGAGEMENT_EVENTS,
  capEngagementEvents,
  microtaskEngagement,
  milestoneSynthesisSatisfied,
  recordEvent,
} from './pbl/operations/kernel/engagement.js';
export * from './pbl/operations/kernel/proficiency.js';
export * from './pbl/operations/kernel/progress.js';
export * from './pbl/operations/kernel/runtime-events.js';
export * from './pbl/operations/kernel/task-completion.js';
export type {
  CompleteScene,
  CompleteSceneContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSceneContent,
  GeneratedSlideContent,
  ScientificModel,
  WidgetConfig,
} from './scene-types.js';

export {
  DEFAULT_LANGUAGE_DIRECTIVE,
  OUTLINE_TEACHING_FLOW_ERROR,
  applyOutlineFallbacks,
  resolveImageTextPolicyText,
  withCorrectiveContext,
  buildOutlinePrompt,
  generateSceneOutlinesFromRequirements,
  sanitizeProceduralSkillOutline,
} from './outline-generator.js';
export type {
  OutlineFallbackOptions,
  OutlineGenerationOptions,
  OutlinePromptContext,
} from './outline-generator.js';
export { changeOutlineType } from './outline-type.js';
export {
  generatedSlideLayoutIssue,
  normalizeGeneratedSlideLayout,
  SLIDE_CANVAS_HEIGHT,
  SLIDE_CANVAS_WIDTH,
  SLIDE_SAFE_MARGIN,
} from './slide-layout.js';
export {
  OUTLINE_SLIDE_SEMANTICS_ERROR,
  OUTLINE_SLIDE_TYPES,
  formatOutlineSemanticsIssues,
  slideSemanticsFromOutline,
  stripEmptyOutlineSemantics,
  validateOutlineSlideSemantics,
} from './outline-semantics.js';
export type { OutlineSemanticsIssue } from './outline-semantics.js';
export {
  OUTLINE_SCENE_CONFIG_ERROR,
  SCENE_CAP_CONFLICT,
  SCENE_RUNTIME_UNAVAILABLE,
  OutlineSceneConfigError,
  SceneCapConflictError,
  SceneRuntimeUnavailableError,
  assertSceneHardLimits,
  assertSceneRuntimesAvailable,
  describeUnavailableRuntimes,
  formatOutlineSceneConfigIssues,
  validateOutlineSceneConfigs,
} from './outline-runtime.js';
export type {
  AvailableSceneRuntimes,
  OutlineSceneConfigIssue,
  RuntimeSceneFamily,
  SceneHardLimits,
} from './outline-runtime.js';
export {
  toAssistancePlan,
  toPlannerGuidance,
  toVisibleSlideInput,
} from './slide-generation-inputs.js';
export type { PlannerGuidance, VisibleSlideInput } from './slide-generation-inputs.js';
export {
  SLIDE_ROLE_VARIANTS,
  buildSlideNarrationRoleContext,
  buildSlideRoleContext,
} from './slide-role-guidance.js';
export type { SlideRoleContext, SlideRoleGuidanceInput } from './slide-role-guidance.js';
export {
  SPOKEN_SCRIPT_ASSETS,
  buildSpokenScriptContext,
  classifySceneTransition,
  describeSceneTransition,
  normalizeSpokenText,
  tokensMatch,
  topicTokens,
} from './narration-script.js';
export type {
  SceneTransition,
  SceneTransitionKind,
  SpokenScriptContext,
  SpokenScriptOptions,
} from './narration-script.js';
export {
  generateSlideAssistance,
  sanitizeAssistanceHtml,
  visibleCanvasText,
} from './slide-assistance.js';
export type { SlideAssistanceOptions } from './slide-assistance.js';
export { explanationLeakedOntoCanvas, findInternalLeaks } from './learner-facing.js';
export { buildMediaRegistry, unauthorizedConcreteSource } from './media-registry.js';
export {
  NATIVE_VISUAL_DIRECTIVE,
  ORIENTATION_VISUAL_MISSING,
  OrientationVisualMissingError,
  plannedVisualIssue,
  requiredSourceVisualIssue,
} from './visual-plan.js';
export type { MediaRegistry, UnauthorizedMediaReason } from './media-registry.js';
export { uniquifyMediaElementIds } from './outline-media.js';
export { partitionImagesForVision } from './outline-formatters.js';
export type { VisionImagePartition } from './outline-formatters.js';
export { parseJsonResponse } from './json-repair.js';
export type { JsonParsingOptions } from './json-repair.js';
export { noopGenerationLogger } from './logger.js';
export type { GenerationLogger } from './logger.js';
export {
  buildCourseContext,
  buildLanguageText,
  buildVisionUserContent,
  formatAgentsForPrompt,
  formatImageDescription,
  formatImagePlaceholder,
  formatTeacherPersonaForPrompt,
} from './prompt-formatters.js';
export type {
  ImageMapping,
  MediaGenerationRequest,
  PdfImage,
  AssistancePlan,
  VisualPlan,
  SceneOutline,
  SceneSkillRef,
  SceneTeachingSkills,
  SlideOutlineSemantics,
  TeachingFlowEntry,
  TeachingRequiredSkillRule,
  TeachingSkillCombinationRestriction,
  TeachingSkillPolicy,
  TeachingStageRef,
  UserRequirements,
  WidgetOutline,
  WidgetType,
} from './outline-types.js';

export * from './prompts/index.js';
