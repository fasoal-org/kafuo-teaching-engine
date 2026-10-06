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
import type { OutlineDiagnostic } from './outline-diagnostics.js';
import {
  formatOutlineSemanticsIssues,
  outlineSemanticsDiagnostics,
  repairOutlinesSlideSemantics,
  stripEmptyOutlineSemantics,
  validateOutlineSlideSemantics,
} from './outline-semantics.js';
import {
  describeScenePolicy,
  flowHasScenePolicies,
  narrowDiagnosticsToPositionPolicy,
  normalizeSourceGroundedVisuals,
  teachingFlowDiagnostics,
} from './teaching-flow-policy.js';
import type {
  ImageMapping,
  PdfImage,
  SceneOutline,
  TeachingFlowEntry,
  UserRequirements,
  WidgetType,
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
import {
  WIDGET_TYPE_PROHIBITED,
  describeProhibitedWidgetTypes,
  prohibitedWidgetDiagnostics,
} from './widget-type-policy.js';
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
   * Interactive widget types this generation must never plan (e.g. Kafuo
   * Release 1 defers `game`). The planner is told they cannot be delivered and
   * must not be disguised; an outline that would still build one is reported
   * as `WIDGET_TYPE_PROHIBITED` (admin-correctable). Absent/empty → the prompt
   * is byte-identical and nothing is checked.
   */
  prohibitedWidgetTypes?: readonly WidgetType[];
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
  /**
   * Return admin-correctable findings (role, slide type, flow position, scene
   * config) in `data.diagnostics` instead of failing the answer. Only a caller
   * that can pause for a person sets it; everyone else keeps the failure that
   * the bounded re-roll consumes. Parse failures, an empty answer to a flow
   * and typed planning conflicts still fail either way.
   */
  collectCorrectableIssues?: boolean;
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

/** What {@link analyzeOutlines} needs besides the outlines. */
export interface OutlineAnalysisContext {
  /** The authoritative ordered Teaching Model Flow, when the run has one. */
  teachingFlow?: readonly TeachingFlowEntry[];
  /** The source images offered to the planner (metadata is enough; bytes are not read). */
  sourceImages?: readonly PdfImage[];
  /** Widget types the run must never build (`WIDGET_TYPE_PROHIBITED`). */
  prohibitedWidgetTypes?: readonly WidgetType[];
}

/**
 * A candidate outline list after deterministic normalisation, with every
 * finding sorted by disposition. `repairs` were applied; the three
 * admin-correctable families block the run until they are empty.
 */
export interface OutlineAnalysis {
  outlines: SceneOutline[];
  /** Machine repairs applied to metadata (`disposition: 'repaired'`). */
  repairs: OutlineDiagnostic[];
  /** Slide-classification contract findings (role, slideType, assistance, visual plan). */
  semantics: OutlineDiagnostic[];
  /** Runtime scenes planned without the config their family needs. */
  sceneConfig: OutlineDiagnostic[];
  /** Interactive scenes that would build a caller-prohibited widget type. */
  widgets: OutlineDiagnostic[];
  /** Teaching Model Flow carrier, position-policy and sequence findings. */
  flow: OutlineDiagnostic[];
}

/** Every admin-correctable finding of an analysis, in check order. */
export function blockingOutlineDiagnostics(analysis: OutlineAnalysis): OutlineDiagnostic[] {
  return [...analysis.semantics, ...analysis.sceneConfig, ...analysis.widgets, ...analysis.flow];
}

/**
 * The ONE outline check, shared by generation, an administrator's correction
 * and the revalidation before a resume:
 *
 * 1. drop empty semantic fields (never a classification);
 * 2. repair metadata that cannot be valid beside the chosen purpose — an
 *    incompatible `contentKind` is dropped and the `contentRole` kept;
 * 3. complete textbook-grounded visual carriers from authoritative Content
 *    Unit ↔ image associations;
 * 4. report the slide-classification contract, runtime-scene config and
 *    Teaching Model Flow position policy as admin-correctable diagnostics.
 *
 * Idempotent: analysing its own output repairs nothing further.
 */
export function analyzeOutlines(
  outlines: readonly SceneOutline[],
  context: OutlineAnalysisContext = {},
): OutlineAnalysis {
  const stripped = outlines.map((outline) => stripEmptyOutlineSemantics(outline));
  const semanticRepair = repairOutlinesSlideSemantics(stripped);
  const flow =
    context.teachingFlow && context.teachingFlow.length > 0 ? context.teachingFlow : undefined;
  const visualRepair = flow
    ? normalizeSourceGroundedVisuals(semanticRepair.outlines, flow, context.sourceImages ?? [])
    : { outlines: semanticRepair.outlines, repairs: [] as OutlineDiagnostic[] };
  const normalized = visualRepair.outlines;

  const semanticsRaw = outlineSemanticsDiagnostics(normalized);
  const semantics = flow
    ? narrowDiagnosticsToPositionPolicy(semanticsRaw, normalized, flow)
    : semanticsRaw;
  const sceneConfig: OutlineDiagnostic[] = validateOutlineSceneConfigs(normalized).map((issue) => ({
    code: 'SCENE_CONFIG_INVALID',
    disposition: 'admin_correctable' as const,
    outlineIndex: issue.index,
    ...(normalized[issue.index]?.id ? { outlineId: normalized[issue.index]!.id } : {}),
    field: 'widgetOutline',
    message: issue.message,
  }));
  const flowDiagnostics = flow
    ? teachingFlowDiagnostics(normalized, flow, context.sourceImages ?? [])
    : [];

  return {
    outlines: normalized,
    repairs: [...semanticRepair.repairs, ...visualRepair.repairs],
    semantics,
    sceneConfig,
    widgets: prohibitedWidgetDiagnostics(normalized, context.prohibitedWidgetTypes),
    flow: flowDiagnostics,
  };
}

/**
 * The legacy one-line rejection for an analysis with blocking findings, in the
 * historical check order (classification, then runtime config, then flow) and
 * with the historical prefixes the bounded re-roll recognises.
 */
function legacyRejectionMessage(analysis: OutlineAnalysis): string | null {
  if (analysis.semantics.length > 0) {
    return formatOutlineSemanticsIssues(validateOutlineSlideSemantics(analysis.outlines));
  }
  if (analysis.sceneConfig.length > 0) {
    return formatOutlineSceneConfigIssues(validateOutlineSceneConfigs(analysis.outlines));
  }
  if (analysis.widgets.length > 0) {
    return `${WIDGET_TYPE_PROHIBITED}: ${analysis.widgets[0]!.message}`;
  }
  if (analysis.flow.length > 0) {
    return `${OUTLINE_TEACHING_FLOW_ERROR}: ${analysis.flow[0]!.message}`;
  }
  return null;
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
  // A position's machine-readable scene policy is rendered from the SAME value
  // the outline validator enforces (`scenePolicyFor`). Entries without one —
  // Teaching Model versions that predate scene policies — render exactly as
  // before, and their stage-keyed legacy rules are described by the fixed
  // prompt text they always had.
  const teachingFlowText = hasTeachingFlow
    ? teachingFlow!
        .map(
          (entry, index) =>
            `${index}. stage="${entry.stage}" instructions="${entry.instructions}"${
              entry.scenePolicy ? ` policy="${describeScenePolicy(entry.scenePolicy)}"` : ''
            }`,
        )
        .join('\n')
    : '';
  const hasScenePolicies = hasTeachingFlow && flowHasScenePolicies(teachingFlow);
  // The governance mode is an explicit declaration, never inferred from the
  // entries: a governed run whose flow lost its policies renders the block (and
  // is refused by the caller's Stage-1 gate), never a silently legacy prompt.
  const hasSkillPolicy = context.skillPolicy === true;
  const skillPolicyText = hasSkillPolicy ? buildSkillPolicyText(teachingFlow) : '';

  const unavailableRuntimesText = describeUnavailableRuntimes(context.availableRuntimes);
  const prohibitedWidgetTypesText = describeProhibitedWidgetTypes(context.prohibitedWidgetTypes);

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
    hasScenePolicies,
    // The fixed `outcome_visual_explanations` visual rule belongs to the
    // Teaching Model versions without scene policies; a policy-carrying flow
    // states its textbook-grounded positions through the policy instead.
    hasLegacyFlowVisualRule: hasTeachingFlow && !hasScenePolicies,
    normalizedGrounding: context.normalizedGrounding ?? false,
    hasSkillPolicy,
    skillPolicyText,
    hasUnavailableRuntimes: unavailableRuntimesText !== '',
    unavailableRuntimesText,
    hasProhibitedWidgetTypes: prohibitedWidgetTypesText !== '',
    prohibitedWidgetTypesText,
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

/** A successful outline answer. */
export interface OutlineGenerationData {
  languageDirective: string;
  courseTitle?: string;
  outlines: SceneOutline[];
  /**
   * Every repair applied (`repaired`) and — only with
   * `collectCorrectableIssues` — every admin-correctable finding still open.
   */
  diagnostics: OutlineDiagnostic[];
}

/** Generate scene outlines from user requirements. */
export async function generateSceneOutlinesFromRequirements(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  options?: OutlineGenerationOptions,
): Promise<GenerationResult<OutlineGenerationData>> {
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

    const hasFlow = context.teachingFlow !== undefined && context.teachingFlow.length > 0;
    // An empty answer to an authoritative flow has nothing a person could
    // correct: it stays an ordinary generation failure in every mode.
    if (hasFlow && rawEnriched.length === 0) {
      const message = `${OUTLINE_TEACHING_FLOW_ERROR}: no outlines were returned for a ${context.teachingFlow!.length}-position Teaching Model Flow`;
      logger.warn(message);
      return { success: false, error: message };
    }

    // The one outline check (shared with an administrator's correction and the
    // revalidation before a resume): metadata that cannot be valid beside the
    // chosen purpose is repaired and recorded — an incompatible contentKind is
    // dropped and the contentRole KEPT — and everything else is reported. A
    // missing, unknown or disallowed classification is never guessed.
    const analysis = analyzeOutlines(rawEnriched, {
      ...(hasFlow ? { teachingFlow: context.teachingFlow } : {}),
      sourceImages: pdfImages ?? [],
      ...(context.prohibitedWidgetTypes?.length
        ? { prohibitedWidgetTypes: context.prohibitedWidgetTypes }
        : {}),
    });
    const enriched = analysis.outlines;
    for (const repair of analysis.repairs) {
      logger.warn(`Outline repaired (${repair.code}) #${repair.outlineIndex}: ${repair.message}`);
    }

    // Blocking findings: by default a bad model answer, reported as an ordinary
    // generation failure with its historical prefix so the caller's bounded
    // re-roll applies. A caller that can pause for a person collects them
    // instead and decides (`collectCorrectableIssues`).
    const blocking = blockingOutlineDiagnostics(analysis);
    if (blocking.length > 0 && !options?.collectCorrectableIssues) {
      const message = legacyRejectionMessage(analysis)!;
      logger.warn(message);
      return { success: false, error: message };
    }

    // Planning conflicts are not bad answers to re-roll blindly: they throw
    // their typed, non-retryable error for the operator to resolve.
    assertSceneRuntimesAvailable(enriched, options?.availableRuntimes);
    assertSceneHardLimits(enriched, options?.sceneHardLimits);

    const result = uniquifyMediaElementIds(enriched);

    return {
      success: true,
      data: {
        languageDirective,
        courseTitle,
        outlines: result,
        diagnostics: [...analysis.repairs, ...blocking],
      },
    };
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
