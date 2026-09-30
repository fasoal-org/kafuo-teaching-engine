/**
 * Stage 1: Generate scene outlines from user requirements.
 * Also contains outline fallback logic.
 */

import { nanoid } from 'nanoid';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from './constants.js';
import { parseJsonResponse } from './json-repair.js';
import { noopGenerationLogger, type GenerationLogger } from './logger.js';
import {
  formatImageDescription,
  formatImagePlaceholder,
  sortDocumentImagesForVision,
} from './outline-formatters.js';
import { uniquifyMediaElementIds } from './outline-media.js';
import {
  formatOutlineSemanticsIssues,
  stripEmptyOutlineSemantics,
  validateOutlineSlideSemantics,
} from './outline-semantics.js';
import type {
  ImageMapping,
  PdfImage,
  SceneOutline,
  TeachingFlowEntry,
  UserRequirements,
} from './outline-types.js';
import {
  OutlineSceneConfigError,
  SceneCapConflictError,
  SceneRuntimeUnavailableError,
  assertSceneHardLimits,
  assertSceneRuntimesAvailable,
  describeUnavailableRuntimes,
  formatOutlineSceneConfigIssues,
  validateOutlineSceneConfigs,
  type AvailableSceneRuntimes,
  type SceneHardLimits,
} from './outline-runtime.js';
import type { AICallFn, GenerationResult } from './pipeline-types.js';
import { buildPrompt, PROMPT_IDS } from './prompts/index.js';

export const DEFAULT_LANGUAGE_DIRECTIVE =
  'Teach in the language that matches the user requirement.';

/** Prefix used for model answers that do not carry the authoritative flow. */
export const OUTLINE_TEACHING_FLOW_ERROR = 'OUTLINE_TEACHING_FLOW_INVALID';

export interface OutlinePromptContext {
  /**
   * Which runtime scene families this generation can deliver. The planner is
   * told up front, so it does not plan an unavailable runtime; a plan that
   * still requires one is a typed `SCENE_RUNTIME_UNAVAILABLE` conflict, never a
   * slide. Absent → every family is available and the prompt is unchanged.
   */
  availableRuntimes?: AvailableSceneRuntimes;
  /**
   * The rejection reason of the previous attempt, fed back on a bounded
   * re-roll so the model corrects that answer instead of repeating it.
   */
  correctiveContext?: string;
  /**
   * The lesson's AUTHORITATIVE language (BCP-47) and base text direction —
   * copied from lesson metadata, never inferred from content. They drive the
   * embedded-text policy for generated images: a right-to-left lesson gets
   * text-free images (labels are authored as native slide text, which every
   * renderer shapes correctly). Absent → today's wording, unchanged.
   */
  language?: string;
  textDirection?: 'ltr' | 'rtl';
  /**
   * The server-owned language/register directive, derived from the lesson's
   * authoritative language and subject code (never from content). When
   * present the model is told the directive is fixed, its own
   * `languageDirective` is discarded in favour of this one, and every
   * outline's `languageNote` is dropped: the model has no authority over the
   * register. Absent → the templates render byte-identically and the model's
   * directive is used as before.
   */
  authoritativeLanguageDirective?: string;
  pdfText?: string;
  pdfImages?: PdfImage[];
  visionEnabled?: boolean;
  imageMapping?: ImageMapping;
  imageGenerationEnabled?: boolean;
  videoGenerationEnabled?: boolean;
  researchContext?: string;
  teacherContext?: string;
  /**
   * The authoritative ordered Teaching Model Flow (Kafuo integration). When
   * present, the prompt contract requires every outline to carry
   * `teachingStage: { key, flowIndex }` copied exactly from this list; absent
   * → the templates render byte-identically to the pre-teaching-flow prompts.
   */
  teachingFlow?: TeachingFlowEntry[];
  /**
   * The source text is an approved Kafuo normalized package projected as
   * Content Units. When true, the prompt contract requires every outline to
   * carry a non-empty `sourceContentUnitIds` copied from the
   * `[[CONTENT_UNIT id=...]]` markers — and never block ids, which the
   * projection does not show the model at all. Absent/false → the templates
   * render byte-identically to the pre-grounding prompts.
   */
  normalizedGrounding?: boolean;
  /**
   * This run is governed by Teaching Skills (Module 2 W10). The caller derives
   * the governance mode ONCE from the request marker and passes it here as a
   * value; it is never re-derived from `teachingFlow` entries. When true, the
   * templates render the Skill authority block and require every outline to
   * carry `teachingSkills` — classification plus, when instructional, exactly
   * one policy-permitted primary and intentional supporting refs — copied from
   * the per-position policies carried on the `teachingFlow` entries.
   * Absent/false → the templates render byte-identically to the pre-teaching-
   * skills prompts.
   */
  skillPolicy?: boolean;
}

export interface OutlineGenerationOptions extends Omit<
  OutlinePromptContext,
  'pdfText' | 'pdfImages'
> {
  logger?: GenerationLogger;
  /**
   * Operator-configured hard limits on runtime scene families. None exists by
   * default; when set and exceeded, generation stops with `SCENE_CAP_CONFLICT`
   * rather than trimming or converting scenes.
   */
  sceneHardLimits?: SceneHardLimits;
}

export interface OutlineFallbackOptions {
  allowProceduralSkill?: boolean;
  logger?: GenerationLogger;
}

function buildAvailableImages(
  pdfImages: PdfImage[] | undefined,
  context: OutlinePromptContext,
): { availableImagesText: string; visionImages?: Array<{ id: string; src: string }> } {
  let availableImagesText = 'No images available';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (context.visionEnabled && context.imageMapping) {
      const sortedImages = sortDocumentImagesForVision(pdfImages);
      const allWithSrc = sortedImages.filter((image) => context.imageMapping![image.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedImages.filter((image) => !context.imageMapping![image.id]);

      const visionDescriptions = visionSlice.map((image) => formatImagePlaceholder(image));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((image) =>
        formatImageDescription(image),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((image) => ({
        id: image.id,
        src: context.imageMapping![image.id],
        width: image.width,
        height: image.height,
      }));
    } else {
      availableImagesText = pdfImages.map((image) => formatImageDescription(image)).join('\n');
    }
  }

  return { availableImagesText, visionImages };
}

function buildSkillPolicyText(teachingFlow: TeachingFlowEntry[] | undefined): string {
  const formatRef = (ref: { skillId: string; version: string }) => `${ref.skillId}@${ref.version}`;
  return (teachingFlow ?? [])
    .map((entry, index) => {
      const policy = entry.skillPolicy;
      if (!policy) {
        return `${index}. stage="${entry.stage}" | NO POLICY PROJECTED`;
      }
      const required = policy.required.length
        ? policy.required
            .map((rule) => `${formatRef(rule.skill)} (scope=${rule.scope}, role=${rule.role})`)
            .join('; ')
        : 'none';
      const preferred = policy.preferred.length
        ? policy.preferred.map(formatRef).join(', ')
        : 'none';
      const allowed = policy.allowed.length ? policy.allowed.map(formatRef).join(', ') : 'none';
      const restrictions = policy.combinationRestrictions.length
        ? policy.combinationRestrictions
            .map((pair) => `(${formatRef(pair.skillA)} + ${formatRef(pair.skillB)})`)
            .join('; ')
        : 'none';
      return `${index}. stage="${entry.stage}" | required: ${required} | preferred: ${preferred} | allowed: ${allowed} | prohibited-to-combine: ${restrictions}`;
    })
    .join('\n');
}

/**
 * Validate the model's flow carriers before any Scene generation is allowed.
 *
 * The prompt requires these fields, but prompt text is not an enforcement
 * boundary: a model can still omit them. Refusing the outline answer here lets
 * the bounded outline correction loop repair a cheap planning call instead of
 * discovering the omission after every Scene and media asset was generated.
 */
function outlineTeachingFlowIssue(
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
  sourceImages: readonly PdfImage[] = [],
): string | null {
  if (outlines.length === 0) {
    return `${OUTLINE_TEACHING_FLOW_ERROR}: no outlines were returned for a ${flow.length}-position Teaching Model Flow`;
  }

  const indices: number[] = [];
  const countByFlowIndex = new Map<number, number>();
  for (const [outlineIndex, outline] of outlines.entries()) {
    const position = outline.teachingStage;
    const label = `outline #${outlineIndex + 1} (${JSON.stringify(outline.id)})`;
    if (!position) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} must carry teachingStage copied from the authoritative Teaching Model Flow`;
    }
    if (
      !Number.isInteger(position.flowIndex) ||
      position.flowIndex < 0 ||
      position.flowIndex >= flow.length
    ) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} has flowIndex ${String(position.flowIndex)} outside 0..${flow.length - 1}`;
    }
    const expectedKey = flow[position.flowIndex]!.stage;
    if (position.key !== expectedKey) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} has teachingStage.key ${JSON.stringify(position.key)} but flow[${position.flowIndex}].stage is ${JSON.stringify(expectedKey)}`;
    }
    if (
      expectedKey === 'lesson_opener' &&
      (outline.type !== 'slide' ||
        outline.slideType !== 'cover' ||
        outline.contentRole !== 'orientation' ||
        (outline.visualPlan?.mode !== 'image' && outline.visualPlan?.mode !== 'native'))
    ) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} covers lesson_opener but is not a visual cover; this stage requires exactly one cover/orientation slide with visualPlan.mode "image" or "native"`;
    }
    if (
      expectedKey === 'lesson_learning_map' &&
      (outline.type !== 'slide' ||
        outline.slideType !== 'content' ||
        outline.contentRole !== 'orientation')
    ) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} covers lesson_learning_map but is not a content/orientation slide; this stage requires a separate "what you will learn" slide`;
    }
    if (
      expectedKey === 'outcome_visual_explanations' &&
      (outline.type !== 'slide' ||
        outline.contentRole !== 'explanation' ||
        (outline.visualPlan?.mode !== 'image' && outline.visualPlan?.mode !== 'native'))
    ) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} covers outcome_visual_explanations but is not a visual explanation; every explanation requires type "slide", contentRole "explanation", and visualPlan.mode "image" or "native"`;
    }
    if (expectedKey === 'outcome_visual_explanations') {
      if (outline.mediaGenerations?.some((request) => request.type === 'image')) {
        return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} covers outcome_visual_explanations but requests an AI-generated image; explanation visuals must come from the authoritative textbook, or be a native diagram grounded only in the textbook content`;
      }

      const contentUnitIds = new Set(outline.sourceContentUnitIds ?? []);
      const groundedBookImages = sourceImages.filter((image) =>
        (image.sourceContentUnitIds ?? []).some((id) => contentUnitIds.has(id)),
      );
      const suggested = new Set(outline.suggestedImageIds ?? []);
      const selectedBookImages = sourceImages.filter((image) => suggested.has(image.id));

      if (groundedBookImages.length > 0) {
        const selectedGrounded = groundedBookImages.some((image) => suggested.has(image.id));
        if (outline.visualPlan?.mode !== 'image' || !selectedGrounded) {
          return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} has a textbook visual linked to the same Content Unit but did not select it; set visualPlan.mode "image" and include at least one matching id in suggestedImageIds`;
        }
      } else if (selectedBookImages.length > 0) {
        if (outline.visualPlan?.mode !== 'image') {
          return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} selected a textbook visual but visualPlan.mode is not "image"`;
        }
      } else if (outline.visualPlan?.mode !== 'native') {
        return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} has no selected textbook visual; use visualPlan.mode "native" so the explanation is visualised only from its authoritative source content`;
      }
    }
    if (expectedKey === 'outcome_check_understanding' && outline.type !== 'quiz') {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} covers outcome_check_understanding but has type ${JSON.stringify(outline.type)}; this stage requires exactly one quiz`;
    }
    if (
      expectedKey === 'lesson_learning_game' &&
      (outline.type !== 'interactive' || outline.widgetType !== 'game')
    ) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: ${label} covers lesson_learning_game but is not an interactive game; this stage requires type "interactive" and widgetType "game"`;
    }
    indices.push(position.flowIndex);
    countByFlowIndex.set(position.flowIndex, (countByFlowIndex.get(position.flowIndex) ?? 0) + 1);
  }

  const collapsed = indices.filter((value, index) => index === 0 || value !== indices[index - 1]);
  const expected = flow.map((_, index) => index);
  if (
    collapsed.length !== expected.length ||
    collapsed.some((value, index) => value !== expected[index])
  ) {
    return `${OUTLINE_TEACHING_FLOW_ERROR}: outline teachingStage sequence must cover the exact flow in order (collapsed [${collapsed.join(', ')}], expected [${expected.join(', ')}])`;
  }
  for (const [flowIndex, entry] of flow.entries()) {
    if (
      (entry.stage === 'lesson_opener' ||
        entry.stage === 'lesson_learning_map' ||
        entry.stage === 'outcome_check_understanding' ||
        entry.stage === 'lesson_learning_game') &&
      countByFlowIndex.get(flowIndex) !== 1
    ) {
      return `${OUTLINE_TEACHING_FLOW_ERROR}: flow[${flowIndex}] stage ${JSON.stringify(entry.stage)} requires exactly one outline, received ${countByFlowIndex.get(flowIndex) ?? 0}`;
    }
  }
  return null;
}

/**
 * Deterministically complete the textbook-visual carrier for governed
 * explanation outlines. Content Unit ↔ image associations are authoritative
 * input, so applying them here is not a model guess and costs no retry.
 * Validation below remains strict as the fail-closed boundary.
 */
function normalizeBookGroundedExplanationVisuals(
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
  sourceImages: readonly PdfImage[],
): SceneOutline[] {
  const orderedImages = sortDocumentImagesForVision([...sourceImages]);
  const imageById = new Map(orderedImages.map((image) => [image.id, image] as const));

  return outlines.map((outline) => {
    const position = outline.teachingStage;
    if (
      !position ||
      !Number.isInteger(position.flowIndex) ||
      position.flowIndex < 0 ||
      position.flowIndex >= flow.length ||
      flow[position.flowIndex]?.stage !== 'outcome_visual_explanations'
    ) {
      return outline;
    }

    const contentUnitIds = new Set(outline.sourceContentUnitIds ?? []);
    const grounded = orderedImages.filter((image) =>
      (image.sourceContentUnitIds ?? []).some((id) => contentUnitIds.has(id)),
    );
    const suggested = (outline.suggestedImageIds ?? []).filter((id) => imageById.has(id));
    const selectedGrounded = suggested.filter((id) => grounded.some((image) => image.id === id));
    const selectedBookImages = selectedGrounded.length
      ? selectedGrounded
      : grounded.length
        ? [grounded[0]!.id]
        : suggested;
    const nonImageMedia = (outline.mediaGenerations ?? []).filter(
      (request) => request.type !== 'image',
    );
    const {
      mediaGenerations: _discardedMedia,
      suggestedImageIds: _discardedIds,
      ...rest
    } = outline;

    return {
      ...rest,
      visualPlan: { mode: selectedBookImages.length > 0 ? 'image' : 'native' },
      ...(selectedBookImages.length > 0 ? { suggestedImageIds: selectedBookImages } : {}),
      ...(nonImageMedia.length > 0 ? { mediaGenerations: nonImageMedia } : {}),
    };
  });
}

/**
 * The embedded-text policy sentence for generated images — ALWAYS defined (the
 * loader leaves an undefined variable as a literal placeholder). Resolved from
 * authoritative lesson metadata only.
 */
export function resolveImageTextPolicyText(
  language: string | undefined,
  textDirection: 'ltr' | 'rtl' | undefined,
): string {
  if (textDirection === 'rtl') {
    return 'This lesson is written right-to-left, so generated images MUST be text-free: the prompt must say "no text, letters, numbers or labels in the image". Every label, title, legend or caption is authored as native slide text next to the image, never inside it.';
  }
  if (language) {
    return `Prefer text-free images; labelled diagrams are better built from native slide elements. If an image must contain text, the prompt must explicitly require all text to be in the lesson language (${language}).`;
  }
  return 'If the image contains text, labels, or annotations, the prompt must explicitly specify that all text in the image should be in the course language (for example, "all labels in Chinese" for zh-CN courses, "all labels in English" for en-US courses). For purely visual images without text, language does not matter';
}

/** Build the byte-stable system and user prompts for outline generation. */
export function buildOutlinePrompt(
  requirements: UserRequirements,
  context: OutlinePromptContext = {},
): { system: string; user: string } {
  const { pdfText, pdfImages } = context;
  const { availableImagesText } = buildAvailableImages(pdfImages, context);

  const userProfileText =
    requirements.userNickname || requirements.userBio
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
      : '';

  const imageEnabled = context.imageGenerationEnabled ?? false;
  const videoEnabled = context.videoGenerationEnabled ?? false;
  const mediaEnabled = imageEnabled || videoEnabled;
  const hasSourceImages = (pdfImages?.length ?? 0) > 0;

  const teachingFlow = context.teachingFlow;
  const hasTeachingFlow = Array.isArray(teachingFlow) && teachingFlow.length > 0;
  const teachingFlowText = hasTeachingFlow
    ? teachingFlow!
        .map(
          (entry, index) => `${index}. stage="${entry.stage}" instructions="${entry.instructions}"`,
        )
        .join('\n')
    : '';
  // The governance mode is an explicit declaration, never inferred from the
  // entries: a governed run whose flow lost its policies renders the block (and
  // is refused by the caller's Stage-1 gate), never a silently legacy prompt.
  const hasSkillPolicy = context.skillPolicy === true;
  const skillPolicyText = hasSkillPolicy ? buildSkillPolicyText(teachingFlow) : '';

  const unavailableRuntimesText = describeUnavailableRuntimes(context.availableRuntimes);

  const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement: requirements.requirement,
    pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
    availableImages: availableImagesText,
    userProfile: userProfileText,
    hasSourceImages,
    imageEnabled,
    videoEnabled,
    mediaEnabled,
    researchContext: context.researchContext || 'None',
    teacherContext: context.teacherContext || '',
    hasTeachingFlow,
    teachingFlowText,
    normalizedGrounding: context.normalizedGrounding ?? false,
    hasSkillPolicy,
    skillPolicyText,
    hasUnavailableRuntimes: unavailableRuntimesText !== '',
    unavailableRuntimesText,
    imageTextPolicy: resolveImageTextPolicyText(context.language, context.textDirection),
    hasAuthoritativeLanguageDirective: Boolean(context.authoritativeLanguageDirective),
    authoritativeLanguageDirective: context.authoritativeLanguageDirective ?? '',
  });

  if (!prompts) {
    throw new Error('Prompt template not found');
  }

  return context.correctiveContext
    ? {
        system: prompts.system,
        user: withCorrectiveContext(prompts.user, context.correctiveContext),
      }
    : prompts;
}

/**
 * Append the previous attempt's rejection to a re-roll's user prompt. The model
 * is asked to correct that answer; nothing is repaired on its behalf.
 */
export function withCorrectiveContext(userPrompt: string, correctiveContext: string): string {
  return `${userPrompt}\n\n---\n\n## Correction Required\n\nYour previous answer was REJECTED by validation:\n\n${correctiveContext}\n\nAnswer again with the complete JSON object, fixing every issue above. Do not change a scene's \`type\` to avoid an issue — supply what is missing.`;
}

/** Generate scene outlines from user requirements. */
export async function generateSceneOutlinesFromRequirements(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  options?: OutlineGenerationOptions,
): Promise<
  GenerationResult<{ languageDirective: string; courseTitle?: string; outlines: SceneOutline[] }>
> {
  const logger = options?.logger ?? noopGenerationLogger;
  const context: OutlinePromptContext = { ...options, pdfText, pdfImages };
  let prompts: { system: string; user: string };

  try {
    prompts = buildOutlinePrompt(requirements, context);
  } catch (error) {
    if (error instanceof Error && error.message === 'Prompt template not found') {
      return { success: false, error: 'Prompt template not found' };
    }
    throw error;
  }

  const { visionImages } = buildAvailableImages(pdfImages, context);

  try {
    const response = await aiCall(prompts.system, prompts.user, visionImages);
    const parsed = parseJsonResponse<
      { languageDirective: string; courseTitle?: string; outlines: SceneOutline[] } | SceneOutline[]
    >(response, { logger });

    let languageDirective: string;
    let courseTitle: string | undefined;
    let rawOutlines: SceneOutline[];

    if (Array.isArray(parsed)) {
      languageDirective = DEFAULT_LANGUAGE_DIRECTIVE;
      rawOutlines = parsed;
    } else if (parsed && parsed.outlines) {
      languageDirective = parsed.languageDirective || DEFAULT_LANGUAGE_DIRECTIVE;
      const rawTitle = parsed.courseTitle;
      courseTitle =
        typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : undefined;
      rawOutlines = parsed.outlines;
    } else {
      return { success: false, error: 'Failed to parse scene outlines response' };
    }

    if (!Array.isArray(rawOutlines)) {
      return { success: false, error: 'Failed to parse scene outlines response' };
    }

    // The server's register policy is authoritative: the model's directive is
    // discarded (never persisted), and so is any per-scene language note that
    // could re-introduce a register of the model's choosing.
    const authoritative = context.authoritativeLanguageDirective;
    if (authoritative) {
      if (languageDirective !== authoritative) {
        logger.warn(
          'Outline languageDirective discarded: the server language policy is authoritative',
        );
      }
      languageDirective = authoritative;
    }

    const rawEnriched = rawOutlines.map((outline, index) => {
      const enrichedOutline = {
        ...stripEmptyOutlineSemantics(outline),
        id: outline.id || nanoid(),
        order: index + 1,
      };
      if (!authoritative) return enrichedOutline;
      const { languageNote: _discarded, ...withoutNote } = enrichedOutline;
      return withoutNote;
    });
    const enriched =
      context.teachingFlow && context.teachingFlow.length > 0
        ? normalizeBookGroundedExplanationVisuals(
            rawEnriched,
            context.teachingFlow,
            pdfImages ?? [],
          )
        : rawEnriched;

    // Slide-semantics gate: every slide outline must come back explicitly and
    // validly classified (slideType + contentRole + a role-valid contentKind).
    // A violation is a bad model answer, reported as an ordinary generation
    // failure so the caller's existing re-roll applies — a missing or invalid
    // classification is never repaired by guessing one here.
    const semanticsIssues = validateOutlineSlideSemantics(enriched);
    if (semanticsIssues.length > 0) {
      const message = formatOutlineSemanticsIssues(semanticsIssues);
      logger.warn(message);
      return { success: false, error: message };
    }

    // Runtime-scene integrity: an interactive / pbl outline without its config
    // is a malformed plan — the same class of bad model answer, re-rolled with
    // its type intact. It is never downgraded to a slide.
    const configIssues = validateOutlineSceneConfigs(enriched);
    if (configIssues.length > 0) {
      const message = formatOutlineSceneConfigIssues(configIssues);
      logger.warn(message);
      return { success: false, error: message };
    }

    // A Teaching Model Flow is authoritative even when the optional Teaching
    // Skills contract marker is absent. Enforce its machine-readable carrier
    // immediately after parsing, before the expensive Scene phase.
    if (context.teachingFlow && context.teachingFlow.length > 0) {
      const issue = outlineTeachingFlowIssue(enriched, context.teachingFlow, pdfImages);
      if (issue) {
        logger.warn(issue);
        return { success: false, error: issue };
      }
    }

    // Planning conflicts are not bad answers to re-roll blindly: they throw
    // their typed, non-retryable error for the operator to resolve.
    assertSceneRuntimesAvailable(enriched, options?.availableRuntimes);
    assertSceneHardLimits(enriched, options?.sceneHardLimits);

    const result = uniquifyMediaElementIds(enriched);

    return { success: true, data: { languageDirective, courseTitle, outlines: result } };
  } catch (error) {
    if (error instanceof SceneRuntimeUnavailableError || error instanceof SceneCapConflictError) {
      throw error;
    }
    return { success: false, error: String(error) };
  }
}

export function sanitizeProceduralSkillOutline(outline: SceneOutline): SceneOutline {
  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

export function applyOutlineFallbacks(
  outline: SceneOutline,
  hasLanguageModel: boolean,
  options: OutlineFallbackOptions = {},
): SceneOutline {
  const logger = options.logger ?? noopGenerationLogger;
  if (outline.widgetType === 'procedural-skill' && !options.allowProceduralSkill) {
    logger.warn(
      `Procedural-skill outline "${outline.title}" is not enabled, falling back to diagram`,
    );
    return sanitizeProceduralSkillOutline(outline);
  }

  // A runtime scene is never downgraded to a slide. By generation time the
  // outline gate has already re-rolled malformed plans, so reaching either
  // branch means an edited / client-supplied outline or an unavailable runtime:
  // both stop with their typed error and the scene keeps its type.
  const configIssues = validateOutlineSceneConfigs([outline]);
  if (configIssues.length > 0) {
    throw new OutlineSceneConfigError(
      configIssues.map((issue) => ({ ...issue, index: (outline.order ?? 1) - 1 })),
    );
  }
  if (outline.type === 'pbl' && !hasLanguageModel) {
    throw new SceneRuntimeUnavailableError(
      (outline.order ?? 1) - 1,
      'pbl',
      'no language model is configured for project generation',
    );
  }
  return outline;
}
