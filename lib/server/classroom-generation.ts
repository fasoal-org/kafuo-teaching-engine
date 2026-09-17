import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  withGenerationRetry,
  buildVisionUserContent,
  type AICallFn,
  type AgentInfo,
  type PdfImage,
  type TeachingFlowEntry,
} from '@openmaic/generation';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import type { LanguageModel } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import {
  ClassroomAlreadyExistsError,
  CLASSROOM_ID_MAX_ATTEMPTS,
  generateClassroomId,
  persistClassroom,
  releaseClassroomReservation,
  reserveClassroom,
} from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import type {
  SourceVisualManifestEntry,
  TeachingFlowEntry as AppTeachingFlowEntry,
} from '@/lib/types/teaching-package';
import {
  applySourceVisualPrecedence,
  SourceVisualModelUnavailableError,
  SourceVisualProcessingError,
} from '@/lib/server/teaching-package/source-images';
import { resolveFlowSkillPolicies } from '@/lib/server/teaching-package/skill-policy';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

const log = createLogger('Classroom');

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[]; pdfImages?: PdfImage[] };
  /**
   * The authoritative ordered Kafuo Teaching Model Flow. When present, the
   * outline prompt contract requires `teachingStage: { key, flowIndex }` on
   * every outline and the final scenes are exact-flow gated before any
   * package binding. Absent → prompts and behavior are byte-identical to the
   * pre-integration path.
   */
  teachingFlow?: TeachingFlowEntry[];
  /**
   * `pdfContent.text` is an approved Kafuo normalized package projected as
   * Content Units (never Blocks). Propagated to the outline prompt, which then
   * requires `sourceContentUnitIds` on every outline. Absent → prompts and
   * behavior are byte-identical to the pre-grounding path.
   */
  normalizedGrounding?: boolean;
  /**
   * This run is governed by Teaching Skills (Module 2 W10). The caller derives
   * the mode ONCE from the request's `teachingSkills` contract marker and
   * passes it here as a value. Propagated to the outline prompt, which then
   * renders the Skill authority block and requires `teachingSkills`
   * (classification + policy-permitted primary/supporting) on every outline.
   * Absent → prompts and behavior are byte-identical to the pre-Module-2 path.
   */
  skillPolicy?: boolean;
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  /** The outlines the run produced — the exact-flow gate reads these. */
  outlines: SceneOutline[];
  scenesCount: number;
  createdAt: string;
}

/**
 * Injectable persistence for `generateClassroom` (plan §8.1). The default is
 * today's filesystem behavior; a Teaching Package sink persists the generated
 * document through the owner-bound store under the service owner instead. No
 * other logic in the pipeline depends on which sink is configured.
 */
export interface ClassroomPersistenceSink {
  reserve(buildStage: (id: string) => Stage): Promise<{ id: string; stage: Stage }>;
  persist(
    data: {
      id: string;
      stage: Stage;
      scenes: Scene[];
      outlines: SceneOutline[];
      /** Kafuo flow lineage + source-visual provenance (package sinks persist them). */
      teachingFlow?: AppTeachingFlowEntry[];
      sourceVisuals?: SourceVisualManifestEntry[];
    },
    baseUrl: string,
  ): Promise<{ id: string; url: string; stage: Stage; scenes: Scene[]; createdAt: string }>;
  release(id: string): Promise<void>;
}

/**
 * Source-visual channel for Kafuo runs (plan §4.3.6): the normalized images
 * (data URLs for the model's eyes) plus the materializer the Teaching Package
 * runner injects — only the SELECTED images are written under the reserved
 * Stage's media directory, and the manifest returns for the outline record.
 */
export interface SourceVisualChannel {
  images: PdfImage[];
  materialize: (
    stageId: string,
    selected: PdfImage[],
  ) => Promise<{
    servingMapping: Record<string, string>;
    manifest: SourceVisualManifestEntry[];
    failedIds: string[];
  }>;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

/**
 * Reserve the classroom id before generating any media or TTS.
 *
 * Media and TTS write into `<CLASSROOMS_DIR>/<id>/{media,audio}`, so the id must
 * be claimed first: if the collision were only detected at persist time, the
 * retry would already have written the new classroom's media into an existing
 * classroom's directory and the retried document's media URLs would still point
 * at that other id. The reservation is an exclusive create of the classroom file
 * with a placeholder document (`reserved: true`, empty scenes) — the only token
 * that atomically covers the whole collision namespace, because a classroom
 * created through `POST /api/classroom` has a JSON file but no directory.
 * `readClassroom` hides reserved documents, so an in-flight (or crashed)
 * reservation is never served as an empty classroom. On `EEXIST` a fresh id is
 * generated and retried, bounded exactly like the create route. The process now
 * owns the id, so the final persist is an ordinary overwrite of that same file.
 */
async function reserveGeneratedClassroom(
  buildStage: (id: string) => Stage,
): Promise<{ id: string; stage: Stage }> {
  for (let attempt = 0; ; attempt += 1) {
    const id = generateClassroomId();
    const stage = buildStage(id);
    try {
      await reserveClassroom(id, stage);
      return { id, stage };
    } catch (error) {
      if (
        !(error instanceof ClassroomAlreadyExistsError) ||
        attempt >= CLASSROOM_ID_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }
      log.warn(`Classroom id "${id}" already exists; reserving a fresh id`);
    }
  }
}

/** The default sink: exactly the filesystem behavior the pipeline always had. */
const filesystemClassroomSink: ClassroomPersistenceSink = {
  reserve: reserveGeneratedClassroom,
  persist: ({ id, stage, scenes }, baseUrl) => persistClassroom({ id, stage, scenes }, baseUrl),
  release: releaseClassroomReservation,
};

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
    persistence?: ClassroomPersistenceSink;
    sourceVisuals?: SourceVisualChannel;
    /**
     * Stage-1 gate (plan §4.3.8): runs on the outlines the model just returned,
     * BEFORE any Stage is reserved, any Scene is generated, and any media is
     * written. Throwing rejects the run at its cheapest point — the caller's
     * compensation has nothing to undo because nothing was reserved yet.
     */
    validateOutlines?: (outlines: SceneOutline[]) => void | Promise<void>;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;
  const sink = options.persistence ?? filesystemClassroomSink;
  const sourceImages = pdfContent?.pdfImages;
  const hasSourceVisuals = (sourceImages?.length ?? 0) > 0;
  // The vision channel maps each source image id to its data URL for the two
  // model calls that actually receive images.
  const sourceImageMapping: Record<string, string> = {};
  if (hasSourceVisuals) {
    for (const image of sourceImages!) sourceImageMapping[image.id] = image.src;
  }

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({ stage: 'generate-classroom' });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
      undefined,
      classroomThinking,
    );
    return result.text;
  };

  // Source-visual vision routing (plan §4.3.4): exactly two model calls ever
  // receive source images — outline generation and SLIDE content. When source
  // visuals exist, both must resolve a model reporting
  // `capabilities.vision === true`, and both attach the images through
  // `buildVisionUserContent`. No routing is added for quiz/interactive/PBL,
  // which never receive images. A model id absent from the catalog resolves
  // `modelInfo === undefined` and fails loudly here rather than degrading to
  // fake visual grounding.
  const callLLMWithVision = async (
    model: LanguageModel,
    outputWindow: number | undefined,
    thinking: ThinkingConfig | undefined,
    source: string,
    systemPrompt: string,
    userPrompt: string,
    images: Array<{ id: string; src: string; width?: number; height?: number }> | undefined,
  ) => {
    const result = await callLLM(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content:
              images && images.length > 0
                ? (buildVisionUserContent(userPrompt, images) as never)
                : userPrompt,
          },
        ],
        maxOutputTokens: outputWindow,
        maxRetries: 0,
      },
      source,
      undefined,
      thinking,
    );
    return result.text;
  };

  const requireVisionModel = (
    stage: LlmStage,
    resolvedModelInfo: { capabilities?: { vision?: boolean } } | null | undefined,
    modelString: string,
  ): void => {
    if (resolvedModelInfo?.capabilities?.vision !== true) {
      log.error(
        `Source visuals exist but the "${stage}" model "${modelString}" reports no vision capability`,
      );
      throw new SourceVisualModelUnavailableError([stage]);
    }
  };

  // The outline call's model: the `scene-outlines-stream` route when
  // configured, else the classroom model — whichever actually runs gets the
  // vision check when source visuals exist.
  let outlineModel: LanguageModel = languageModel;
  let outlineOutputWindow: number | undefined = modelInfo?.outputWindow;
  let outlineThinking: ThinkingConfig | undefined = classroomThinking;
  let outlineModelInfo = modelInfo;
  const outlineRoute = getStageModel('scene-outlines-stream');
  if (outlineRoute) {
    const resolved = await resolveModel({ stage: 'scene-outlines-stream' });
    outlineModel = resolved.model;
    outlineOutputWindow = resolved.modelInfo?.outputWindow;
    outlineThinking = resolved.thinkingConfig;
    outlineModelInfo = resolved.modelInfo;
    log.info(`Stage "scene-outlines-stream" routed to model: ${resolved.modelString}`);
  }
  const outlineAiCall: AICallFn = async (systemPrompt, userPrompt, images) => {
    if (hasSourceVisuals) {
      requireVisionCapableOutline();
    }
    return callLLMWithVision(
      outlineModel,
      outlineOutputWindow,
      outlineThinking,
      'generate-classroom',
      systemPrompt,
      userPrompt,
      images,
    );
  };
  function requireVisionCapableOutline(): void {
    requireVisionModel('scene-outlines-stream', outlineModelInfo, 'resolved-outline-model');
  }

  // Per-stage model resolution for the scene pipeline. The classroom used to
  // bind a single `languageModel` (from the `generate-classroom` stage) into one
  // `sceneAiCall` closure shared by scene-content and scene-actions. That made
  // every `MODEL_ROUTES` entry for `scene-content` / `scene-content:<type>` /
  // `scene-actions` a no-op on this path — the browser UI already routes each
  // stage independently via /api/generate/*, but the one-shot skill API did not.
  //
  // Each stage is resolved lazily and only when a route is actually configured
  // (getStageModel returns undefined), so unrouted deployments pay zero extra
  // cost and reuse the classroom model. Resolution failure (e.g. an unknown
  // provider in the route) degrades to the classroom model with a warn, mirroring
  // the existing web-search-query-rewrite handling below — a misconfigured
  // optional route never aborts classroom generation.
  const stageModelCache = new Map<
    LlmStage,
    {
      model: LanguageModel;
      outputWindow?: number;
      thinking: ThinkingConfig | undefined;
    }
  >();

  const resolveStageModel = async (
    stage: LlmStage,
  ): Promise<{
    model: LanguageModel;
    outputWindow?: number;
    thinking: ThinkingConfig | undefined;
  }> => {
    const cached = stageModelCache.get(stage);
    if (cached) return cached;

    // No route configured → reuse the classroom model, no extra resolution.
    if (!getStageModel(stage)) {
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }

    try {
      const resolved = await resolveModel({ stage });
      const entry = {
        model: resolved.model,
        outputWindow: resolved.modelInfo?.outputWindow,
        thinking: resolved.thinkingConfig,
      };
      log.info(`Stage "${stage}" routed to model: ${resolved.modelString}`);
      stageModelCache.set(stage, entry);
      return entry;
    } catch (err) {
      log.warn(
        `Stage "${stage}" route "${getStageModel(stage)}" could not be resolved; ` +
          `falling back to the generate-classroom model.`,
        err,
      );
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }
  };

  // scene-content routes per outline type via the composite key
  // `scene-content:<type>` (slide/quiz/interactive/pbl), falling back to the
  // base `scene-content` route — same resolution the browser UI uses at
  // /api/generate/scene-content. Returns the aiCall plus the resolved model
  // and thinking config, because PBL scene generation drives its own LLM
  // calls through the model object (generatePBLSceneContent) rather than the
  // aiCall closure, and consumes the route's thinking config separately.
  const resolveSceneContentCall = async (outlineType?: string) => {
    const stage = (outlineType ? `scene-content:${outlineType}` : 'scene-content') as LlmStage;
    const { model, outputWindow, thinking } = await resolveStageModel(stage);
    // Slide content is the ONLY scene call that receives source images; when
    // visuals exist, the actually-used model must be vision-capable.
    let slideModelInfo = modelInfo;
    if (hasSourceVisuals && outlineType === 'slide') {
      const route = getStageModel(stage);
      if (route) {
        const resolved = await resolveModel({ stage });
        slideModelInfo = resolved.modelInfo;
      } else {
        slideModelInfo = modelInfo;
      }
      requireVisionModel(stage, slideModelInfo, 'resolved-slide-model');
    }
    const aiCall: AICallFn = async (systemPrompt, userPrompt, images) => {
      if (images && images.length > 0) {
        return callLLMWithVision(
          model,
          outputWindow,
          thinking,
          'generate-classroom-scene',
          systemPrompt,
          userPrompt,
          images,
        );
      }
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        undefined,
        thinking,
      );
      return result.text;
    };
    return { aiCall, model, thinking };
  };

  // agent-profiles routes via the `agent-profiles` stage (matches the browser
  // UI's /api/generate/agent-profiles). Lazy + cached like the scene stages.
  let agentProfilesAiCall: AICallFn | undefined;
  const getAgentProfilesAiCall = async (): Promise<AICallFn> => {
    if (agentProfilesAiCall) return agentProfilesAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('agent-profiles');
    agentProfilesAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
        },
        'generate-classroom',
        undefined,
        thinking,
      );
      return result.text;
    };
    return agentProfilesAiCall;
  };

  // scene-actions routes via the `scene-actions` stage.
  let sceneActionsAiCall: AICallFn | undefined;
  const getSceneActionsAiCall = async (): Promise<AICallFn> => {
    if (sceneActionsAiCall) return sceneActionsAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('scene-actions');
    sceneActionsAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        undefined,
        thinking,
      );
      return result.text;
    };
    return sceneActionsAiCall;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: searchQueryModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      undefined,
      searchQueryThinking,
    );
    return result.text;
  };

  const requirements: UserRequirements = {
    requirement,
  };
  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          baiduSubSources: webSearchConfig.baiduSubSources,
          claudeModelId: webSearchConfig.claudeModelId,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinesResult = await generateSceneOutlinesFromRequirements(
    requirements,
    pdfText,
    hasSourceVisuals ? sourceImages : undefined,
    outlineAiCall,
    {
      imageGenerationEnabled: input.enableImageGeneration,
      videoGenerationEnabled: input.enableVideoGeneration,
      researchContext,
      // NO teacherContext — agents haven't been generated yet
      ...(hasSourceVisuals ? { imageMapping: sourceImageMapping, visionEnabled: true } : {}),
      ...(input.teachingFlow !== undefined && input.teachingFlow.length > 0
        ? { teachingFlow: input.teachingFlow }
        : {}),
      ...(input.normalizedGrounding ? { normalizedGrounding: true } : {}),
      ...(input.skillPolicy ? { skillPolicy: true } : {}),
    },
  );

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const { languageDirective, courseTitle, outlines } = outlinesResult.data;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  // Module 2 W11: pre-resolve the exact canonical Skill definitions ONCE per
  // run (the `resolvedVisionImages` precedent — bytes settled BEFORE any scene
  // prompt assembly) so the selected Skills govern generated narration,
  // questions, feedback, pacing, and interaction. Only the governed Kafuo path
  // supplies them; the Workbench, editor-regeneration, and scene-actions call
  // sites never pass `resolvedSkills`, so their prompts stay byte-identical.
  const resolvedSkills =
    input.skillPolicy && input.teachingFlow && input.teachingFlow.length > 0
      ? [...resolveFlowSkillPolicies(input.teachingFlow).entries()].map(([, definition]) => ({
          skillId: definition.skillId,
          version: definition.version,
          definition: definition.content,
        }))
      : undefined;

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Stage-1 outline gate. Deliberately BEFORE `sink.reserve` below: a run that
  // fails grounding must not cost a Stage reservation, 33 Scene generations, or
  // any media write. Throwing here reaches the caller with nothing to compensate.
  await options.validateOutlines?.(outlines);

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      const agentProfilesCall = await getAgentProfilesAiCall();
      agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  const { id: stageId, stage } = await sink.reserve((id) => ({
    id,
    name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    languageDirective,
    videoManifest: buildVideoManifestFromOutlines(outlines),
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // For LLM-generated agents, embed full configs so the client can
    // hydrate the agent registry without prior IndexedDB data.
    // For default agents, just record IDs — the client already has them.
    ...(agentMode === 'generate'
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        }),
  }));

  // Source-visual selection + materialization (plan §4.3.6): selection is the
  // union of the outlines' suggestedImageIds intersected with the normalized
  // source image ids; ONLY the selected images are materialized under the
  // reserved Stage's media directory. A materialization failure of a selected
  // image fails the run (never silently substituted by AI media).
  let sourceServingMapping: Record<string, string> = {};
  let sourceManifest: SourceVisualManifestEntry[] = [];
  if (hasSourceVisuals && options.sourceVisuals) {
    const availableIds = new Set(sourceImages!.map((image) => image.id));
    const selectedIds = new Set(outlines.flatMap((outline) => outline.suggestedImageIds ?? []));
    const selected = sourceImages!.filter((image) => selectedIds.has(image.id));
    const selectedActual = selected.filter((image) => availableIds.has(image.id));
    if (selectedActual.length > 0) {
      const materialized = await options.sourceVisuals.materialize(stageId, selectedActual);
      if (materialized.failedIds.length > 0) {
        throw new SourceVisualProcessingError(
          false,
          `source visual materialization failed for ${materialized.failedIds.length} selected image(s)`,
        );
      }
      sourceServingMapping = materialized.servingMapping;
      sourceManifest = materialized.manifest;
    }
  }

  // The reservation above claims the id; everything below owns it. If
  // generation throws before `persistClassroom` succeeds, release the
  // placeholder so a failed run does not burn the id or leave an unreadable
  // file behind. `persisted` is the completion marker.
  let persisted: Awaited<ReturnType<ClassroomPersistenceSink['persist']>> | undefined;
  try {
    const store = createInMemoryStore(stage);
    const api = createStageAPI(store);

    log.info('Stage 2: Generating scene content and actions...');
    let generatedScenes = 0;

    for (const [index, outline] of outlines.entries()) {
      const safeOutline = applyOutlineFallbacks(outline, true, {
        allowProceduralSkill: vocationalActive,
      });
      const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.max(progressStart, 31),
        message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });

      const reportSceneRetry = async (
        phase: 'content' | 'actions',
        event: { attempt: number; maxAttempts: number; reason: string },
      ) => {
        const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
        const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
        log.warn(`${message} — ${event.reason}`);
        await options.onProgress?.({
          step: 'generating_scenes',
          progress: Math.max(progressStart, 31),
          message,
          scenesGenerated: generatedScenes,
          totalScenes: outlines.length,
        });
      };

      // Resolve this scene's content model lazily, per outline type. The package
      // gets the provider-bound AICallFn and the app injects its agentic PBL loop
      // as the classified fallback, preserving single-call → loop routing.
      const contentCall = await resolveSceneContentCall(safeOutline.type);
      // The outline's assigned source visuals (slide scenes only): a visual
      // need the model fills by referencing the image id, resolved onto the
      // serving path after generation.
      const outlineAssignedImages =
        hasSourceVisuals && safeOutline.type === 'slide'
          ? (sourceImages?.filter((image) => safeOutline.suggestedImageIds?.includes(image.id)) ??
            [])
          : undefined;
      const content = await (async () => {
        try {
          return await withGenerationRetry(
            () =>
              generateSceneContent(safeOutline, contentCall.aiCall, {
                agents,
                languageDirective,
                allowProceduralSkill: vocationalActive,
                ...(resolvedSkills ? { resolvedSkills } : {}),
                ...(outlineAssignedImages && outlineAssignedImages.length > 0
                  ? {
                      assignedImages: outlineAssignedImages,
                      imageMapping: sourceServingMapping,
                      visionEnabled: true,
                      resolvedVisionImages: outlineAssignedImages.map((image) => ({
                        id: image.id,
                        src: sourceImageMapping[image.id] ?? image.src,
                        width: image.width,
                        height: image.height,
                      })),
                    }
                  : {}),
                ...(safeOutline.type === 'pbl'
                  ? {
                      pblLoopFallback: (input) =>
                        generatePBLV2Project(
                          input,
                          contentCall.model,
                          callLLM,
                          { logger: log },
                          contentCall.thinking,
                        ),
                    }
                  : {}),
              }),
            {
              label: `scene ${index + 1}/${outlines.length} content`,
              shouldRetryResult: (result) => result === null,
              onRetry: (event) => reportSceneRetry('content', event),
            },
          );
        } catch (error) {
          return containPBLGenerationError(error, safeOutline.title);
        }
      })();
      if (!content) {
        log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
        continue;
      }

      const actionsAiCall = await getSceneActionsAiCall();
      const actions = await withGenerationRetry(
        () =>
          generateSceneActions(safeOutline, content, actionsAiCall, {
            agents,
            languageDirective,
            ...(resolvedSkills ? { resolvedSkills } : {}),
          }),
        {
          label: `scene ${index + 1}/${outlines.length} actions`,
          onRetry: (event) => reportSceneRetry('actions', event),
        },
      );
      log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

      const sceneId = createSceneWithActions(safeOutline, content, actions, api);
      if (!sceneId) {
        log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
        continue;
      }

      generatedScenes += 1;
      const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(progressEnd, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }

    const scenes = store.getState().scenes;
    log.info(`Pipeline complete: ${scenes.length} scenes generated`);

    if (scenes.length === 0) {
      throw new Error('No scenes were generated');
    }

    // Per-visual-need source-visual precedence (plan §4.3.6): for each slide
    // scene, generated-image placeholders compete with the outline's unplaced
    // selected source visuals — the source visual wins that visual need and
    // its generation request is dropped; UNRELATED placeholder needs beyond
    // the selected source visuals keep their requests. AI image generation is
    // never disabled globally or per outline.
    if (Object.keys(sourceServingMapping).length > 0) {
      applySourceVisualPrecedence(scenes, outlines, sourceServingMapping);
    }

    // Phase: Media generation (after all scenes generated)
    if (input.enableImageGeneration || input.enableVideoGeneration) {
      await options.onProgress?.({
        step: 'generating_media',
        progress: 90,
        message: 'Generating media files',
        scenesGenerated: scenes.length,
        totalScenes: outlines.length,
      });

      try {
        const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
        replaceMediaPlaceholders(scenes, mediaMap);
        log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
      } catch (err) {
        log.warn('Media generation phase failed, continuing:', err);
      }
    }

    // Phase: TTS generation
    if (input.enableTTS) {
      await options.onProgress?.({
        step: 'generating_tts',
        progress: 94,
        message: 'Generating TTS audio',
        scenesGenerated: scenes.length,
        totalScenes: outlines.length,
      });

      try {
        await generateTTSForClassroom(scenes, stageId, options.baseUrl);
        log.info('TTS generation complete');
      } catch (err) {
        log.warn('TTS generation phase failed, continuing:', err);
      }
    }

    await options.onProgress?.({
      step: 'persisting',
      progress: 98,
      message: 'Persisting classroom data',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    // The id was reserved before media/TTS generation, so the process owns it and
    // this is an ordinary overwrite that replaces the placeholder.
    persisted = await sink.persist(
      {
        id: stageId,
        stage,
        scenes,
        outlines,
        ...(input.teachingFlow !== undefined && input.teachingFlow.length > 0
          ? { teachingFlow: input.teachingFlow }
          : {}),
        ...(sourceManifest.length > 0 ? { sourceVisuals: sourceManifest } : {}),
      },
      options.baseUrl,
    );

    log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

    await options.onProgress?.({
      step: 'completed',
      progress: 100,
      message: 'Classroom generation completed',
      scenesGenerated: persisted.scenes.length,
      totalScenes: outlines.length,
    });

    return {
      id: persisted.id,
      url: persisted.url,
      stage: persisted.stage,
      scenes: persisted.scenes,
      outlines,
      scenesCount: persisted.scenes.length,
      createdAt: persisted.createdAt,
    };
  } finally {
    if (!persisted) {
      await sink.release(stageId);
    }
  }
}
