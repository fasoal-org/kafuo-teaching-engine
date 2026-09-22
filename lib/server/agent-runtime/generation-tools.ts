import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  SLIDE_CONTENT_KINDS,
  SLIDE_CONTENT_KINDS_BY_ROLE,
  SLIDE_CONTENT_ROLES,
  SLIDE_TYPES,
  isActionType,
  isSlideContentKindForRole,
  isSlideContentRole,
  isSlideType,
} from '@openmaic/dsl';
import {
  assertGeneratedSlideScene,
  buildCompleteScene,
  validateOutlineSlideSemantics,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  type AICallFn,
  type ImageMapping,
  type PdfImage,
  type SceneContentFailureCode,
  type SceneGenerationContext,
} from '@openmaic/generation';

import { putSceneBringingCurrent } from './document-writes';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { buildSceneAlignmentBaseline } from '@/lib/server/teaching-package/alignment';
import type { GovernedRegenerationContext } from '@/lib/server/teaching-package/governed-regeneration';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import type { CourseToolDeps } from './course-tools';
import { runStageMutation } from './mutation-fence';
import { shiftCourseOrders } from './course-edit/tools';
import { createGenerationAiCallFactory, sceneContentStage } from './generation-ai-call';
import { synthesizeSceneNarration } from './scene-tts';
import { toGenerationContent } from './generation-content';
import { checkScenesAgainstSkill } from './skills';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { createLogger } from '@/lib/logger';

const MAX_GENERATE_SCENE_MEDIA = 8;
const SUPPORTED_SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);
const log = createLogger('AgentGenerationTools');

/**
 * The slide-classification contract, as the authoring agent sees it on the
 * tool itself — the same rules the `slide-classification-contract` prompt
 * snippet gives every outline planner.
 */
const SLIDE_CLASSIFICATION_TOOL_CONTRACT =
  'SLIDE CLASSIFICATION (a new slide page is refused without it): first decide the page type by the learner experience — answers captured/graded/retried = quiz; manipulate, simulate, drag/drop, keep state, or play a game = interactive; multi-step project or roleplay = pbl; otherwise slide. Never restate a quiz / interactive / pbl experience as a slide. For a slide set slideType (content is the default; at most one cover and one end per lesson) and, for every instructional slide, contentRole chosen by WHY the slide exists — orientation (the single opening: hook, context, objectives, big idea — never a separate learning-objectives page), explanation, example, worked_example, procedure, activity, practice, check_understanding, summary — never from the title or layout. explanation / activity / practice also need their contentKind; every other role omits it. A purely structural contents / transition / end page omits contentRole rather than inventing one. Replacing an existing slide keeps its classification unless you pass new values.';

const SceneParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  order: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('slide'),
    Type.Literal('quiz'),
    Type.Literal('interactive'),
    Type.Literal('pbl'),
  ]),
  widgetType: Type.Optional(
    Type.Union(
      [
        Type.Literal('simulation'),
        Type.Literal('diagram'),
        Type.Literal('code'),
        Type.Literal('game'),
        Type.Literal('visualization3d'),
      ],
      {
        description:
          'Interactive pages only: which widget to build. simulation = parameter explorer, diagram = flowchart/mindmap/hierarchy/system graph, code = programming challenge, game = quiz/puzzle/strategy/card/action, visualization3d = 3D scene. Defaults to simulation when omitted. procedural-skill stays gated behind task-engine mode and is not accepted here.',
      },
    ),
  ),
  widgetOutline: Type.Optional(
    Type.Unknown({
      description:
        'Interactive pages only: widget configuration object matching widgetType (e.g. { concept, keyVariables } for simulation, { diagramType, nodes } for diagram, { language } for code, { gameType, challenge } for game, { visualizationType, objects } for visualization3d). Must be a plain object. Defaults to { concept: title } when widgetType is set; when only widgetOutline is set, widgetType defaults to simulation.',
    }),
  ),
  slideType: Type.Optional(
    Type.Union(
      SLIDE_TYPES.map((value) => Type.Literal(value)),
      {
        description:
          'Slide pages only — REQUIRED for a new slide page: the structural place in the deck. content = the default for nearly every teaching slide; cover = the single lesson opening; end = the single genuine closing; contents / transition = only when genuinely needed.',
      },
    ),
  ),
  contentRole: Type.Optional(
    Type.Union(
      SLIDE_CONTENT_ROLES.map((value) => Type.Literal(value)),
      {
        description:
          'Slide pages only — REQUIRED for a new instructional slide (cover / content): WHY the slide exists, chosen by pedagogical intent, never from the title or layout. A purely structural contents / transition / end slide omits it. If the learner must submit answers, manipulate something, or be graded, the page is not a slide — use quiz / interactive / pbl.',
      },
    ),
  ),
  contentKind: Type.Optional(
    Type.Union(
      SLIDE_CONTENT_KINDS.map((value) => Type.Literal(value)),
      {
        description:
          'Slide pages only — REQUIRED with contentRole explanation (concept | definition | rule | observation), activity (investigation | source_analysis | reflection | production) or practice (guided | independent | higher_order); must be omitted for every other role.',
      },
    ),
  ),
  assistancePlan: Type.Optional(
    Type.Object(
      {
        hint: Type.Optional(Type.String({ minLength: 1 })),
        help: Type.Optional(Type.String({ minLength: 1 })),
        explanation: Type.Optional(Type.String({ minLength: 1 })),
      },
      {
        additionalProperties: false,
        description:
          'Slide pages only, and only with contentRole practice or check_understanding — REQUIRED (hint + explanation) for practice/independent. The HIDDEN plan for on-demand learner support: hint = what a nudge should point toward, help = the approach, explanation = the full solution path. It is never shown on the slide: put the solution path ONLY here, never in brief or materialFacts (those describe the task alone).',
      },
    ),
  ),
  brief: Type.String({ minLength: 1 }),
  instruction: Type.Optional(Type.String()),
  materialFacts: Type.Optional(Type.Array(Type.String())),
  media: Type.Optional(
    Type.Array(
      Type.Object({
        src: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        width: Type.Optional(Type.Number({ minimum: 1 })),
        height: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { maxItems: 8 },
    ),
  ),
});
const ListParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
});
const ActionsParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  sceneId: Type.Optional(Type.String()),
  order: Type.Optional(Type.Integer({ minimum: 1 })),
  styleDirective: Type.Optional(Type.String()),
  synthesizeAudio: Type.Optional(Type.Boolean()),
});
const DuplicateParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  templateSceneId: Type.Optional(Type.String()),
  templateOrder: Type.Optional(Type.Integer({ minimum: 1 })),
  targetOrder: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String()),
});

type ActionGenerator = typeof generateSceneActions;

export interface GenerationToolDeps extends CourseToolDeps {
  aiCall?: AICallFn;
  generateActions?: ActionGenerator;
  /**
   * Module 3/4 W4: resolves the governed regeneration context for a Stage's
   * version (durable marker only). Absent → the lazy default, which reads
   * package lineage when a DATABASE_URL is configured and answers undefined
   * for non-package Stages; injected explicitly by tests and any runtime with
   * its own pool.
   */
  resolveGovernedContext?: (
    stageId: string,
    scene: Pick<Scene, 'teachingStage'>,
  ) => Promise<GovernedRegenerationContext | undefined>;
}

function sceneIdFor(scenes: readonly Scene[], order: number) {
  const preferred = `scene-p${order}`;
  const taken = new Set(scenes.map((scene) => scene.id));
  if (!taken.has(preferred)) return preferred;
  let suffix = 2;
  while (taken.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function duplicateId(sessionId: string | undefined, callId: string) {
  const hash = createHash('sha256')
    .update(`${sessionId ?? ''}\0${callId}`)
    .digest('hex')
    .slice(0, 16);
  return `scene-dup-${hash}`;
}

function result(text: string, details: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text }], details, ...(isError ? { isError } : {}) };
}

/** The slide classification a persisted slide Scene carries, verbatim; never inferred. */
function slideSemanticsOf(
  scene: Scene | undefined,
): Pick<SceneOutline, 'slideType' | 'contentRole' | 'contentKind'> {
  if (!scene || scene.type !== 'slide' || scene.content.type !== 'slide') return {};
  const { canvas, contentRole, contentKind } = scene.content;
  return {
    ...(canvas?.type !== undefined && { slideType: canvas.type }),
    ...(contentRole !== undefined && { contentRole }),
    ...(contentKind !== undefined && { contentKind }),
  };
}

/**
 * A slide replaced in place keeps the on-demand assistance it already carries
 * unless the new content brings its own. Carried verbatim, never derived; the
 * scene builder still drops it if the slide's role does not allow assistance.
 */
function withCarriedAssistance<T extends object>(content: T, existing: Scene | undefined): T {
  if (!existing || existing.type !== 'slide' || existing.content.type !== 'slide') return content;
  const { assistance } = existing.content;
  if (assistance === undefined || !('elements' in content) || 'assistance' in content) {
    return content;
  }
  return { ...content, assistance };
}

function outlineFromScene(scene: Scene, snapshot: unknown): SceneOutline {
  const planned = (snapshot as AppDocumentOutline | undefined)?.outlines?.find(
    (entry) => entry.id === scene.outlineId || entry.order === scene.order,
  );
  return {
    ...planned,
    id: scene.outlineId ?? scene.id,
    order: scene.order,
    title: scene.title,
    type: scene.type as SceneOutline['type'],
    description: planned?.description ?? scene.title,
    keyPoints: planned?.keyPoints ?? [],
    // The persisted Scene is the fallback source of the classification when
    // the outline snapshot predates it (or is missing): read verbatim, never
    // inferred. A legacy slide that carries none yields none.
    ...(scene.type === 'slide' ? persistedSlideSemantics(scene, planned) : {}),
  };
}

/** Per field: the planned value when valid, else the persisted Scene's. */
function persistedSlideSemantics(
  scene: Scene,
  planned: Partial<SceneOutline> | undefined,
): Pick<SceneOutline, 'slideType' | 'contentRole' | 'contentKind'> {
  const stored = slideSemanticsOf(scene);
  const slideType = isSlideType(planned?.slideType) ? planned.slideType : stored.slideType;
  const fromPlan = isSlideContentRole(planned?.contentRole);
  const contentRole = fromPlan ? planned!.contentRole : stored.contentRole;
  const contentKind = fromPlan ? planned!.contentKind : stored.contentKind;
  return {
    ...(slideType !== undefined && { slideType }),
    ...(contentRole !== undefined && { contentRole }),
    ...(contentRole !== undefined &&
      isSlideContentKindForRole(contentRole, contentKind) && { contentKind }),
  };
}

function concreteMediaSrc(src: string): boolean {
  if (src.startsWith('/') && !src.startsWith('//')) return src.length > 1 && !/\s/.test(src);
  if (!/^https?:\/\//i.test(src)) return false;
  try {
    const url = new URL(src);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export interface UnresolvedMediaPlaceholder {
  elementId: string;
  type: 'image' | 'video';
  placeholder: string;
}

/** Find slide media elements that would still render as skeletons. */
export function collectUnresolvedMediaPlaceholders(scene: Scene): UnresolvedMediaPlaceholder[] {
  if (scene.type !== 'slide') return [];
  const placeholders: UnresolvedMediaPlaceholder[] = [];
  for (const element of scene.content.canvas.elements) {
    const candidate = element as unknown as {
      id?: string;
      type?: string;
      src?: string;
      mediaRef?: string;
    };
    if (!candidate.id) continue;
    if (candidate.type === 'image' && candidate.src && isMediaPlaceholder(candidate.src)) {
      placeholders.push({
        elementId: candidate.id,
        type: 'image',
        placeholder: candidate.src,
      });
    }
    if (
      candidate.type === 'video' &&
      (!candidate.src ||
        isMediaPlaceholder(candidate.src) ||
        (candidate.mediaRef ? isMediaPlaceholder(candidate.mediaRef) : false))
    ) {
      placeholders.push({
        elementId: candidate.id,
        type: 'video',
        placeholder:
          (candidate.src && isMediaPlaceholder(candidate.src) ? candidate.src : undefined) ??
          (candidate.mediaRef && isMediaPlaceholder(candidate.mediaRef)
            ? candidate.mediaRef
            : undefined) ??
          candidate.mediaRef ??
          '',
      });
    }
  }
  return placeholders;
}

function actionContext(scenes: readonly Scene[], current: Scene): SceneGenerationContext {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((scene) => scene.id === current.id);
  const previous = index > 0 ? ordered[index - 1] : undefined;
  return {
    pageIndex: Math.max(0, index) + 1,
    totalPages: ordered.length,
    allTitles: ordered.map((scene) => scene.title),
    previousSpeeches: (previous?.actions ?? [])
      .filter((action) => action.type === 'speech')
      .map((action) => action.text)
      .filter(Boolean)
      .slice(-3),
  };
}

/** Drop action names unknown to the current DSL before they reach persistence. */
export function filterKnownActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => isActionType(action.type));
}

export function buildGenerationTools(deps: GenerationToolDeps): AgentTool<never, never>[] {
  const routed = createGenerationAiCallFactory({ abortSignal: deps.abortSignal });
  const aiCallFor = (stage: Parameters<typeof routed>[0]) => deps.aiCall ?? routed(stage);
  const actionGenerator = deps.generateActions ?? generateSceneActions;
  // W4: the governed-context resolver. Default = lazy module read, so the
  // non-DB runtimes (and the unit harnesses) never touch package lineage
  // unless a DATABASE_URL exists.
  const resolveGoverned =
    deps.resolveGovernedContext ??
    (async (stageId: string, scene: Pick<Scene, 'teachingStage'>) => {
      const { resolveGovernedRegenerationContextForStage } =
        await import('@/lib/server/teaching-package/governed-regeneration');
      return resolveGovernedRegenerationContextForStage(stageId, scene);
    });

  /** Resolve the governed context for a Scene, or map the refusal to a tool error result. */
  const governedContextFor = async (
    stageId: string,
    scene: Pick<Scene, 'teachingStage'>,
    label: string,
  ): Promise<{ context?: GovernedRegenerationContext; refusal?: ReturnType<typeof result> }> => {
    try {
      return { context: await resolveGoverned(stageId, scene) };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'GOVERNED_FLOW_CONTEXT_UNRESOLVED';
      return {
        refusal: result(
          `${label} refused on a governed Stage: the authoritative governed context could not be resolved (${(error as Error).message}). Nothing was written.`,
          {
            error: code,
            stageId,
            ...(scene.teachingStage ? { stageKey: scene.teachingStage.key } : {}),
          },
          true,
        ),
      };
    }
  };

  /** W4.4: stamp a fresh generation-origin baseline on a governed regeneration. */
  const stampGenerationBaseline = (scene: Scene): Scene => {
    const baseline = buildSceneAlignmentBaseline(scene, { origin: 'generation', now: Date.now() });
    // An unclassified Scene gets NO baseline (the W15-FIX null return): it
    // derives validation-required, never a fabricated stale.
    return baseline ? { ...scene, alignmentBaseline: baseline } : scene;
  };

  const generateScene: AgentTool<typeof SceneParams> = {
    name: 'generate_scene',
    label: 'Generate page',
    description:
      'Generate and durably persist one page from an explicit title, type, and brief. Reusing an order replaces that page. Interactive pages accept widgetType (simulation/diagram/code/game/visualization3d) plus a matching widgetOutline object; both are rejected for other page types. ' +
      SLIDE_CLASSIFICATION_TOOL_CONTRACT,
    parameters: SceneParams,
    async execute(_callId, params, signal) {
      if (!Number.isInteger(params.order) || params.order < 1) {
        return result(
          'generate_scene needs a 1-based integer page order.',
          {
            error: 'invalid-order',
          },
          true,
        );
      }
      const doc = await deps.store.loadDocument(params.stageId);
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const existing = doc.scenes.find((scene) => scene.order === params.order);
      const title = params.title.trim();
      const brief = params.brief.trim();
      if (!title || !brief) {
        return result(
          'generate_scene needs a non-empty title and brief.',
          {
            error: 'missing-title-or-brief',
          },
          true,
        );
      }
      if (existing && !SUPPORTED_SCENE_TYPES.has(existing.type)) {
        return result(
          `Page ${params.order} has unsupported type "${existing.type}" and was left unchanged.`,
          { blocked: 'unsupported-type', sceneId: existing.id, type: existing.type },
          true,
        );
      }
      if (existing?.type === 'pbl' && params.type !== 'pbl') {
        return result(
          'The existing page is a PBL project. Delete it first or regenerate it as pbl; changing its type here would destroy the project.',
          { blocked: 'pbl-type-change', sceneId: existing.id, type: existing.type },
          true,
        );
      }
      if (params.instruction && params.type === 'pbl') {
        return result(
          'generate_scene cannot apply an instruction to a PBL page because the planner would drop it. Use patch_stage for a fine edit or regenerate without instruction.',
          { blocked: 'pbl-instruction-not-supported', sceneId: existing?.id },
          true,
        );
      }
      if (
        params.type !== 'interactive' &&
        (params.widgetType !== undefined || params.widgetOutline !== undefined)
      ) {
        return result(
          'generate_scene only accepts widgetType/widgetOutline for interactive pages.',
          { error: 'widget-requires-interactive', type: params.type },
          true,
        );
      }
      if (
        params.widgetOutline !== undefined &&
        (typeof params.widgetOutline !== 'object' ||
          params.widgetOutline === null ||
          Array.isArray(params.widgetOutline))
      ) {
        return result(
          'generate_scene needs widgetOutline to be an object matching widgetType.',
          { error: 'invalid-widget-outline' },
          true,
        );
      }
      const requestedMedia = params.media ?? [];
      if (requestedMedia.length > MAX_GENERATE_SCENE_MEDIA) {
        return result(
          `generate_scene accepts at most ${MAX_GENERATE_SCENE_MEDIA} media items.`,
          { error: 'too-many-media', maxItems: MAX_GENERATE_SCENE_MEDIA },
          true,
        );
      }
      const outline: SceneOutline = {
        id: existing?.outlineId ?? `p${params.order}`,
        order: params.order,
        title,
        type: params.type,
        description: brief,
        keyPoints: params.materialFacts ?? [],
        // Module 3/4 W4 (TAE-RQ-020): seed the governed lineage from the
        // Scene being replaced, so the replacement is BUILT governed — the
        // same flow position and Skill assignment, no reselection — rather
        // than repaired afterwards by carry-forward.
        ...(existing?.teachingStage ? { teachingStage: existing.teachingStage } : {}),
        ...(existing?.teachingSkills ? { teachingSkills: existing.teachingSkills } : {}),
        // Slide semantics ride the same seam: a slide regenerated in place
        // keeps the classification its original outline established, carried
        // verbatim from the Scene being replaced (canvas `type` + content
        // role/kind) so the replacement is BUILT classified. Nothing is
        // derived from the new brief or content; a legacy slide that carries
        // none seeds none, and a page changing scene type drops them.
        // The agent may reclassify by supplying new values; each supplied
        // field replaces the inherited one, nothing is defaulted.
        ...(params.type === 'slide' ? slideSemanticsOf(existing) : {}),
        ...(params.type === 'slide' && params.slideType ? { slideType: params.slideType } : {}),
        ...(params.type === 'slide' && params.assistancePlan
          ? { assistancePlan: params.assistancePlan }
          : {}),
        ...(params.type === 'slide' && params.contentRole
          ? {
              contentRole: params.contentRole,
              ...(params.contentKind ? { contentKind: params.contentKind } : {}),
            }
          : {}),
        ...(params.type === 'interactive' &&
        (params.widgetType !== undefined || params.widgetOutline !== undefined)
          ? {
              widgetType: params.widgetType ?? 'simulation',
              // Mirror the generator fallback so a bare widgetType still generates.
              widgetOutline: (params.widgetOutline as
                | SceneOutline['widgetOutline']
                | undefined) ?? {
                concept: title,
              },
            }
          : {}),
        ...(params.type === 'pbl'
          ? {
              pblConfig: {
                projectTopic: params.title.trim(),
                projectDescription: params.brief.trim(),
                targetSkills: params.materialFacts ?? [],
              },
            }
          : {}),
      };
      // A NEW slide page (or one the agent reclassifies) must be validly
      // classified — the same strict rule every other generation mode obeys.
      // A violation is an actionable tool error; nothing is defaulted. Only a
      // legacy slide regenerated in place with no new values stays
      // unclassified, exactly as it was.
      const legacyInPlace =
        params.type === 'slide' &&
        existing?.type === 'slide' &&
        outline.slideType === undefined &&
        outline.contentRole === undefined &&
        outline.contentKind === undefined;
      if (params.type === 'slide' && !legacyInPlace) {
        // A slide replaced in place keeps its existing on-demand assistance
        // (carried over below), so a fresh plan is only required when there is
        // none to carry.
        const carriesAssistance =
          params.assistancePlan === undefined &&
          existing?.type === 'slide' &&
          existing.content.type === 'slide' &&
          existing.content.assistance !== undefined;
        const issues = validateOutlineSlideSemantics([outline]).filter(
          (issue) => !(carriesAssistance && issue.field === 'assistancePlan'),
        );
        if (issues.length > 0) {
          return result(
            `This slide page is not validly classified: ${issues.map((issue) => issue.message).join('; ')}. ` +
              `Set slideType (${SLIDE_TYPES.join(' | ')}) and, for an instructional slide, contentRole (${SLIDE_CONTENT_ROLES.join(' | ')}); ` +
              `contentKind is required for ${Object.entries(SLIDE_CONTENT_KINDS_BY_ROLE)
                .filter(([, kinds]) => kinds.length > 0)
                .map(([role, kinds]) => `${role} (${kinds.join(' | ')})`)
                .join(', ')} and must be omitted otherwise. ` +
              `practice/independent also requires assistancePlan { hint, explanation }; assistancePlan is allowed only with practice or check_understanding. Nothing was written.`,
            { error: 'OUTLINE_SLIDE_SEMANTICS_INVALID', issues, order: params.order },
            true,
          );
        }
      }
      const baseline =
        params.instruction && existing?.type === 'slide'
          ? {
              elements: existing.content.canvas.elements,
              background: existing.content.canvas.background,
            }
          : undefined;
      const assignedImages: PdfImage[] = [];
      const imageMapping: ImageMapping = {};
      for (const [index, media] of (params.media ?? []).entries()) {
        const src = media.src.trim();
        const description = media.description.trim();
        if (!description) {
          return result(
            'Every media item needs a non-empty description.',
            {
              error: 'invalid-media-description',
              index,
            },
            true,
          );
        }
        if (isMediaPlaceholder(src) || !concreteMediaSrc(src)) {
          return result(
            'Every media item needs a concrete HTTP(S) URL or same-origin path, not a placeholder or data URL.',
            {
              error: isMediaPlaceholder(src) ? 'media-placeholder-src' : 'invalid-media-src',
              index,
            },
            true,
          );
        }
        const id = `img_${index + 1}`;
        assignedImages.push({
          id,
          src,
          description,
          pageNumber: index + 1,
          sourceDocumentName: 'page media input',
          ...(media.width ? { width: media.width } : {}),
          ...(media.height ? { height: media.height } : {}),
        });
        imageMapping[id] = src;
      }
      const agents = doc.stage.generatedAgentConfigs;
      // Module 3/4 W4 (TAE-RQ-018): on a governed Stage, the regeneration
      // happens under the authoritative context or refuses — never generic
      // generation with carriers copied back. A governed Stage REPLACING a
      // Scene with no teachingStage (or a NEW page, which has no position)
      // cannot resolve a context and refuses for that reason.
      const { context: governed, refusal: governedRefusal } = await governedContextFor(
        params.stageId,
        existing ?? { teachingStage: undefined },
        'generate_scene',
      );
      if (governedRefusal) return governedRefusal;
      let content: Awaited<ReturnType<typeof generateSceneContent>>;
      let contentFailure: SceneContentFailureCode | undefined;
      try {
        content = await generateSceneContent(outline, aiCallFor(sceneContentStage(params.type)), {
          agents,
          languageDirective: doc.stage.languageDirective ?? '',
          // The Stage's recorded base direction (authoritative lesson
          // metadata) governs a regenerated slide exactly as it governed the
          // original; a legacy Stage records none and the prompt is unchanged.
          ...(doc.stage.textDirection ? { textDirection: doc.stage.textDirection } : {}),
          allowProceduralSkill: true,
          ...(assignedImages.length ? { assignedImages, imageMapping } : {}),
          ...(params.instruction ? { editDirective: params.instruction } : {}),
          ...(baseline ? { baselineContent: baseline } : {}),
          ...(governed ? { resolvedSkills: governed.resolvedSkills } : {}),
          onFailure: (failure) => {
            contentFailure = failure.code;
          },
        });
      } catch (error) {
        if (error instanceof PBLGenerationError) {
          return result(
            `PBL generation failed and nothing was written. ${error.message}`,
            {
              error: 'pbl-planner-failed',
              order: params.order,
              title,
              sceneId: existing?.id,
              ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
              cause: error.message,
            },
            true,
          );
        }
        throw error;
      }
      if (signal?.aborted) throw new Error('aborted');
      if (!content) {
        const error = contentFailure ?? 'scene-content-generation-failed';
        log.warn({
          error,
          stageId: params.stageId,
          order: params.order,
          title,
          type: params.type,
          ...(existing ? { sceneId: existing.id } : {}),
        });
        const text =
          error === 'prompt-unavailable'
            ? 'Page content prompt could not be prepared; nothing was written.'
            : error === 'invalid-model-output'
              ? 'The model response could not be parsed into page content; nothing was written.'
              : 'Page content generation failed; nothing was written.';
        return result(
          text,
          {
            error,
            order: params.order,
            title,
            type: params.type,
            ...(existing ? { sceneId: existing.id } : {}),
          },
          true,
        );
      }
      const actions = filterKnownActions(
        await actionGenerator(outline, content, aiCallFor('scene-actions'), {
          // Page position, so first/last-page cues exist on the agent path too.
          ctx: actionContext(
            [
              ...doc.scenes.filter((item) => item.order !== params.order),
              { id: '\u0000new', order: params.order, title, actions: [] } as unknown as Scene,
            ],
            { id: '\u0000new' } as Scene,
          ),
          agents,
          languageDirective: doc.stage.languageDirective ?? '',
          // W4: the ONE resolved Flow position plus the resolved Skill
          // definitions — the same governed context the content pass used.
          ...(governed ? { flowContext: governed.flowContext } : {}),
          ...(governed ? { resolvedSkills: governed.resolvedSkills } : {}),
        }),
      );
      const built = buildCompleteScene(
        outline,
        withCarriedAssistance(content, existing),
        actions,
        params.stageId,
        {
          sceneId: existing?.id ?? sceneIdFor(doc.scenes, params.order),
        },
      );
      if (!built) return result('Page assembly failed; nothing was written.', {}, true);
      if (!legacyInPlace) assertGeneratedSlideScene(built);
      const scene = (governed ? stampGenerationBaseline(built as Scene) : built) as Scene;
      await runStageMutation(signal, () =>
        putSceneBringingCurrent(deps.store, params.stageId, scene),
      );
      const skill = deps.getActiveSkill?.() ?? null;
      const afterWrite = await deps.store.loadDocument(params.stageId);
      const skillViolations =
        skill && afterWrite ? checkScenesAgainstSkill(afterWrite.scenes, skill.constraints) : [];
      const persisted = afterWrite?.scenes.find((item) => item.id === scene.id) ?? scene;
      const mediaPlaceholders = collectUnresolvedMediaPlaceholders(persisted);
      deps.onCheckpoint({
        tool: 'generate_scene',
        stageId: params.stageId,
        sceneId: scene.id,
        order: scene.order,
        title: scene.title,
        sceneType: scene.type,
        skill: skill?.id,
        ...(skillViolations.length ? { skillViolations } : {}),
        detail: `page ${scene.order} persisted`,
      });
      return result(
        `Page ${scene.order} "${scene.title}" persisted.${
          skillViolations.length
            ? ` SKILL CONSTRAINT CHECK against "${skill?.id}": ${skillViolations.join('; ')}.`
            : ''
        }${
          mediaPlaceholders.length
            ? ` ${mediaPlaceholders.length} media placeholder(s) still render as skeletons.`
            : ''
        }`,
        {
          sceneId: scene.id,
          order: scene.order,
          type: scene.type,
          actionCount: actions.length,
          skill: skill?.id,
          ...(skillViolations.length ? { skillViolations } : {}),
          ...(mediaPlaceholders.length ? { mediaPlaceholders } : {}),
        },
      );
    },
  };

  const listScenes: AgentTool<typeof ListParams> = {
    name: 'list_scenes',
    label: 'List pages',
    description: 'List the pages currently persisted in a stage.',
    parameters: ListParams,
    async execute(_callId, params) {
      const doc = await deps.store.loadDocument(params.stageId);
      const pages = [...(doc?.scenes ?? [])]
        .sort((a, b) => a.order - b.order)
        .map(({ id, order, title, type }) => ({ id, order, title, type }));
      return result(`Persisted pages: ${pages.length}.`, { pageCount: pages.length, pages });
    },
  };

  const generateActionsTool: AgentTool<typeof ActionsParams> = {
    name: 'generate_actions',
    label: 'Generate page actions',
    description:
      'Regenerate playback actions for one persisted page, optionally backfilling narration audio.',
    parameters: ActionsParams,
    async execute(_callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      const scene = params.sceneId
        ? doc?.scenes.find((item) => item.id === params.sceneId)
        : doc?.scenes.find((item) => item.order === params.order);
      if (!doc || !scene) return result('Page not found. Call list_scenes.', {}, true);
      // Module 3/4 W4 (TAE-RQ-018/019): on a governed Stage the regenerated
      // Actions are produced under the authoritative context or the tool
      // refuses — never generic generation with the old carriers merely
      // preserved (the false-governance pattern W4 exists to close).
      const { context: governed, refusal: governedRefusal } = await governedContextFor(
        params.stageId,
        scene,
        'generate_actions',
      );
      if (governedRefusal) return governedRefusal;
      const outline = outlineFromScene(scene, doc.outline);
      const actions = filterKnownActions(
        await actionGenerator(
          outline,
          toGenerationContent(scene.content),
          aiCallFor('scene-actions'),
          {
            ctx: actionContext(doc.scenes, scene),
            agents: doc.stage.generatedAgentConfigs,
            languageDirective: doc.stage.languageDirective ?? '',
            userProfile: params.styleDirective,
            ...(governed ? { flowContext: governed.flowContext } : {}),
            ...(governed ? { resolvedSkills: governed.resolvedSkills } : {}),
          },
        ),
      );
      if (!actions.length)
        return result('No known actions were generated; the page was unchanged.', {}, true);
      // W4.4: a regeneration IS successful generation — a fresh
      // generation-origin baseline is stamped after the final Actions exist
      // (governed runs only; buildSceneAlignmentBaseline returns null for an
      // unclassified Scene, which then derives validation-required).
      const next = (
        governed ? stampGenerationBaseline({ ...scene, actions } as Scene) : { ...scene, actions }
      ) as Scene;
      await runStageMutation(signal, () =>
        putSceneBringingCurrent(deps.store, params.stageId, next),
      );
      deps.onCheckpoint({
        tool: 'generate_actions',
        stageId: params.stageId,
        sceneId: scene.id,
        order: scene.order,
        detail: `${actions.length} actions persisted`,
      });
      let audio;
      if (params.synthesizeAudio !== false) {
        audio = await (deps.synthesizeTts ?? synthesizeSceneNarration)({
          scene: next,
          force: false,
          roster: doc.stage.generatedAgentConfigs,
          signal,
        });
        if (audio.changed) {
          await runStageMutation(signal, () =>
            putSceneBringingCurrent(deps.store, params.stageId, next),
          );
          deps.onCheckpoint({
            tool: 'generate_actions',
            stageId: params.stageId,
            sceneId: scene.id,
            order: scene.order,
            detail: 'narration audio persisted',
          });
        }
      }
      return result(`Persisted ${actions.length} known actions for "${scene.title}".`, {
        sceneId: scene.id,
        actions,
        ...(audio ? { audio } : {}),
      });
    },
  };

  const duplicateScene: AgentTool<typeof DuplicateParams> = {
    name: 'duplicate_scene',
    label: 'Duplicate page',
    description:
      'Copy an existing page to a new position without actions. Replaying the same tool call is idempotent.',
    parameters: DuplicateParams,
    async execute(callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const scenes = [...doc.scenes].sort((a, b) => a.order - b.order);
      const id = duplicateId(deps.sessionId, callId);
      const replay = scenes.find((scene) => scene.id === id);
      if (replay)
        return result('This page was already duplicated. Nothing changed.', {
          sceneId: id,
          order: replay.order,
          replay: true,
        });
      const template = params.templateSceneId
        ? scenes.find((scene) => scene.id === params.templateSceneId)
        : scenes.find((scene) => scene.order === params.templateOrder);
      if (!template) return result('Template page not found.', {}, true);
      const at = Math.min(params.targetOrder, scenes.length + 1);
      const shifted = shiftCourseOrders(
        scenes,
        doc.outline as AppDocumentOutline | undefined,
        at,
        1,
      );
      const now = Date.now();
      const created = {
        ...structuredClone(template),
        id,
        outlineId: id,
        stageId: params.stageId,
        order: at,
        title: params.title?.trim() || template.title,
        actions: [],
        createdAt: now,
        updatedAt: now,
      } as Scene;
      await runStageMutation(signal, () =>
        deps.store.saveDocument({
          ...doc,
          scenes: [...shifted.scenes, created].sort((a, b) => a.order - b.order),
          outline: shifted.outline,
        }),
      );
      deps.onCheckpoint({
        tool: 'duplicate_scene',
        stageId: params.stageId,
        sceneId: id,
        order: at,
        detail: `duplicated ${template.id}`,
      });
      return result(`Duplicated "${template.title}" at order ${at}.`, { sceneId: id, order: at });
    },
  };

  return [generateScene, listScenes, generateActionsTool, duplicateScene] as unknown as AgentTool<
    never,
    never
  >[];
}

export const GENERATION_TOOL_NAMES = [
  'generate_scene',
  'list_scenes',
  'generate_actions',
  'duplicate_scene',
] as const;
