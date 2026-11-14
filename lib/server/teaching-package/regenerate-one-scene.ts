/**
 * Generate the replacement for ONE slide Scene (single-slide-regeneration-plan
 * §7). No authorization, no persistence: the caller (the regeneration service)
 * owns both.
 *
 * Built on the same pieces the agent's `generate_scene` tool uses — the
 * persisted Scene seeds its own outline (`outlineFromScene`), the content pass
 * runs in edit mode with the reviewer's instruction and the lifted baseline,
 * on-demand assistance is carried, the classification is asserted — plus the
 * package pipeline's guards: the spoken-language register re-roll
 * (`generateRegisterCompliantActions`), fallback Actions refused, the Action
 * structure gate, and the invariants that keep everything but the canvas and
 * narration identical to the pre-image.
 *
 * `instruction` is the ONLY reviewer text this module receives. The audit
 * `reason` is deliberately not a parameter, so it can never reach a prompt.
 */
import {
  assertGeneratedSlideScene,
  buildCompleteScene,
  buildNarrationImageNotes,
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type GeneratedSlideContent,
  type NarrationImageNote,
  type SceneActionsFallback,
  type VisualPlan,
} from '@openmaic/generation';

import { NARRATION_DELETED_IMAGE_ISSUE_CODE } from '@/lib/edit/dangling-element-actions';
import type { AppDocumentOutline, AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene } from '@/lib/document-store/validators';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';
import {
  actionContext,
  filterKnownActions,
  outlineFromScene,
  withCarriedAssistance,
} from '@/lib/server/agent-runtime/generation-tools';
import { sceneContentStage } from '@/lib/server/agent-runtime/generation-ai-call';
import { generateRegisterCompliantActions } from '@/lib/server/classroom-generation';
import {
  resolveSpokenScriptOptions,
  type SpeechRegisterPolicy,
} from '@/lib/server/speech/register-policy';
import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
import { buildSceneAlignmentBaseline } from '@/lib/server/teaching-package/alignment';
import {
  TeachingPackageError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import type { GovernedRegenerationContext } from '@/lib/server/teaching-package/governed-regeneration';
import {
  issuesAfterAudioRepair,
  narrationAudioGap,
  stageHasNarrationAudio,
} from '@/lib/server/teaching-package/narration-audio-issue';
import { liftSlideImages } from '@/lib/server/teaching-package/scene-regeneration-images';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import { isTeacherParityModel } from '@/lib/server/teaching-package/book-coverage';
import {
  pinnedQuotesIn,
  readSacredQuotePins,
  sacredPolicyModeFor,
  sacredQuotesForPrompt,
  shownSceneTexts,
  singleSceneExerciseScope,
  singleSceneSacredFindings,
  stripSacredExerciseItems,
  stripSacredNarration,
  withCandidateQuotes,
  type SacredQuote,
  type SacredQuotePin,
} from '@/lib/server/teaching-package/sacred-text';
import type { SceneOutline } from '@/lib/types/generation';
import type { TeachingModelLineage } from '@/lib/types/teaching-package';
import type { AppScene, Scene } from '@/lib/types/stage';

export interface RegenerateOneSceneInput {
  /** The pre-image (a slide Scene). */
  scene: AppScene;
  /** Every Scene of the Stage, the pre-image included (page context + Action references). */
  scenes: readonly AppScene[];
  stage: AppStage;
  outlineSnapshot?: AppDocumentOutline;
  /** The reviewer's requirements for the AI — the edit directive. */
  instruction: string;
  /**
   * D-5 A (2 Nov 2026): regenerate the slide's narration (its Actions) only.
   * The canvas is kept exactly as stored — no content model call, no image
   * re-offer — so an image the reviewer deleted never comes back.
   */
  narrationOnly?: boolean;
  /**
   * Owner, 14 Nov 2026 (a lesson part moved between slides): the slide's new
   * lesson-part list. The whole slide is rewritten, the candidate carries this
   * list, and the invariant check expects it instead of the pre-image's. Absent
   * → the list is kept exactly. A slide only; never with `narrationOnly`.
   */
  sourceContentUnitIds?: readonly string[];
  /**
   * With `sourceContentUnitIds`: the slide planned again from its new parts'
   * text (`replan-moved-slide.ts`). The slide is then generated FRESH from this
   * plan — no old canvas baseline, no old key points — keeping only its own place
   * and classification. Absent → the edit-mode rewrite of the current slide.
   */
  replannedOutline?: SceneOutline;
  /**
   * The package version's Teaching Model: a g5.v8 (teacher-parity) package
   * regenerates a solving slide under the visible-working rule, as its run did.
   */
  teachingModel?: TeachingModelLineage | null;
  /**
   * g5.v8 (4 Nov 2026): the book's exercise and «تأكد» check unit ids. Present
   * (with a teacher-parity model) → a slide citing one shows no verse or hadith item.
   */
  sacredExerciseUnitIds?: readonly string[];
  aiCallFor: (stage: string) => AICallFn;
  /** Re-raise a route failure the generators swallowed (routed runs). */
  assertRouteAvailable?: () => void;
  registerPolicy: SpeechRegisterPolicy | null;
  governed?: GovernedRegenerationContext;
  /** Refuse model-free fallback Actions (every package regeneration does). */
  refuseFallbackActions: boolean;
  now?: () => number;
  /** Test seams. */
  generateContent?: typeof generateSceneContent;
  generateActions?: typeof generateSceneActions;
}

export type RegenerateOneSceneResult =
  | { ok: true; scene: AppScene }
  | { ok: false; code: TeachingPackageErrorCode; message: string; details?: unknown };

function failure(
  code: TeachingPackageErrorCode,
  message: string,
  details?: unknown,
): RegenerateOneSceneResult {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) };
}

/**
 * Quran and hadith (plan Q-4, Q-5, Q-7, Q-14) on a package generated under the
 * rule (its outline record carries pins): the pre-image's pinned quotes are the
 * exact book text the prompts may show. A package without pins is unchanged.
 */
function sacredContextOf(
  input: RegenerateOneSceneInput,
): { pins: SacredQuotePin[]; quotes: SacredQuote[] } | null {
  const pins = readSacredQuotePins(input.outlineSnapshot?.sacredQuotes);
  if (!pins) return null;
  return { pins, quotes: pinnedQuotesIn(shownSceneTexts([input.scene]), pins) };
}

function sacredPromptOf(input: RegenerateOneSceneInput) {
  const sacred = sacredContextOf(input);
  if (!sacred) return {};
  // S-9 (L-2): decided per LESSON like the planner — the full block when the
  // package pins any book quote or the Stage is ARABIC, else the short line.
  const mode = sacredPolicyModeFor({ subjectCode: input.stage.subjectCode, pins: sacred.pins });
  return { sacredText: { quotes: sacredQuotesForPrompt(sacred.quotes), mode } };
}

/** Narration stripped of quotes, then the one-scene checks; a finding writes nothing. */
function sacredTextRefusal(
  input: RegenerateOneSceneInput,
  candidate: AppScene,
): RegenerateOneSceneResult | null {
  const sacred = sacredContextOf(input);
  if (!sacred) return null;
  // S-5: the candidate's own pinned quotes too, so its narration repair and
  // checks know every quote it shows.
  const quotes = withCandidateQuotes(candidate, sacred.pins, sacred.quotes);
  // H-2 (4 Nov 2026 rule): an exercise or check slide of a g5.v8 package drops
  // its verse and hadith items before the narration repair and the checks.
  const scope = isTeacherParityModel(input.teachingModel)
    ? singleSceneExerciseScope(
        candidate,
        [
          ...(candidate.sourceContentUnitIds ?? []),
          ...(input.outlineSnapshot?.outlines.find((outline) => outline.id === candidate.outlineId)
            ?.sourceContentUnitIds ?? []),
        ],
        input.sacredExerciseUnitIds,
      )
    : undefined;
  if (scope) stripSacredExerciseItems([candidate], quotes, scope);
  stripSacredNarration([candidate], quotes);
  const findings = singleSceneSacredFindings(candidate, sacred.pins, quotes, scope);
  if (findings.length === 0) return null;
  return failure(
    'SACRED_TEXT_ALTERED',
    `${findings.map((finding) => `${finding.code}: ${finding.message}`).join('; ')}; nothing was written`,
    { findings: findings.map((finding) => finding.code) },
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The fields a regeneration never changes (plan §7.3.2). `sourceContentUnitIds`
 * is the one exception, and only when a lesson part was moved (owner, 14 Nov
 * 2026): then the candidate must carry exactly `expectedUnitIds`.
 */
export function regenerationInvariantViolations(
  pre: AppScene,
  candidate: AppScene,
  expectedUnitIds?: readonly string[],
): string[] {
  const violations: string[] = [];
  const check = (field: string, before: unknown, after: unknown) => {
    if (!deepEqual(before, after)) violations.push(field);
  };
  check('id', pre.id, candidate.id);
  check('order', pre.order, candidate.order);
  check('type', pre.type, candidate.type);
  check('stageId', pre.stageId, candidate.stageId);
  check('outlineId', pre.outlineId, candidate.outlineId);
  if (pre.content.type === 'slide' && candidate.content.type === 'slide') {
    check('canvas.type', pre.content.canvas.type, candidate.content.canvas.type);
    check('contentRole', pre.content.contentRole, candidate.content.contentRole);
    check('contentKind', pre.content.contentKind, candidate.content.contentKind);
  } else if (pre.content.type !== 'quiz' || candidate.content.type !== 'quiz') {
    violations.push('content.type');
  }
  check('teachingStage', pre.teachingStage, candidate.teachingStage);
  check('teachingSkills', pre.teachingSkills, candidate.teachingSkills);
  check('learningObjectives', pre.learningObjectives, candidate.learningObjectives);
  check(
    'sourceContentUnitIds',
    expectedUnitIds ? [...expectedUnitIds] : pre.sourceContentUnitIds,
    candidate.sourceContentUnitIds,
  );
  return violations;
}

/**
 * The outline seeded from the persisted Scene, with the fields a regeneration
 * must keep taken from the pre-image ONLY. The stored plan may carry values the
 * persisted Scene never received (package Scenes are stored without
 * `sourceContentUnitIds`), and `buildCompleteScene` copies them from the
 * outline — which would fail the invariant check after both model calls.
 */
function seededOutline(pre: AppScene, snapshot: AppDocumentOutline | undefined): SceneOutline {
  const seeded = outlineFromScene(pre as Scene, snapshot);
  const {
    mediaGenerations: _stripped,
    teachingStage: _plannedStage,
    teachingSkills: _plannedSkills,
    sourceContentUnitIds: _plannedUnits,
    ...withoutMedia
  } = seeded as SceneOutline & { mediaGenerations?: unknown };
  return {
    ...withoutMedia,
    ...(pre.teachingStage ? { teachingStage: pre.teachingStage } : {}),
    ...(pre.teachingSkills ? { teachingSkills: pre.teachingSkills } : {}),
    ...(pre.sourceContentUnitIds ? { sourceContentUnitIds: [...pre.sourceContentUnitIds] } : {}),
  };
}

/**
 * The re-plan's content (key points, description, visuals, assistance) with the
 * slide's own title, place and classification (owner, 14 Nov 2026), so the
 * regeneration invariants hold and a move renames nothing: title, outline id,
 * type, order, slide type, content role and kind, teaching stage and Skills
 * come from the seeded outline.
 */
function withSlideIdentity(
  planned: SceneOutline,
  seeded: SceneOutline,
  unitIds: readonly string[] | undefined,
): SceneOutline {
  const {
    mediaGenerations: _media,
    slideType: _slideType,
    contentRole: _contentRole,
    contentKind: _contentKind,
    teachingStage: _stage,
    teachingSkills: _skills,
    sourceContentUnitIds: _units,
    ...content
  } = planned as SceneOutline & { mediaGenerations?: unknown };
  return {
    ...content,
    id: seeded.id,
    type: seeded.type,
    order: seeded.order,
    title: seeded.title,
    ...(seeded.slideType !== undefined ? { slideType: seeded.slideType } : {}),
    ...(seeded.contentRole !== undefined ? { contentRole: seeded.contentRole } : {}),
    ...(seeded.contentKind !== undefined ? { contentKind: seeded.contentKind } : {}),
    ...(seeded.teachingStage !== undefined ? { teachingStage: seeded.teachingStage } : {}),
    ...(seeded.teachingSkills !== undefined ? { teachingSkills: seeded.teachingSkills } : {}),
    ...(unitIds ? { sourceContentUnitIds: [...unitIds] } : {}),
  };
}

/**
 * A regeneration writes new narration and never synthesizes audio (4 Oct
 * 2026). On a package that uses TTS, its unvoiced lines are marked exactly as
 * the package build marks them, so the reviewer sees "Regenerate audio"
 * instead of a silent slide with no mark.
 */
function withNarrationAudioMark(candidate: AppScene, scenes: readonly AppScene[]): AppScene {
  if (!stageHasNarrationAudio(scenes)) return candidate;
  const issues = issuesAfterAudioRepair(candidate.generationIssues, narrationAudioGap(candidate));
  const { generationIssues: _built, ...rest } = candidate;
  return (issues ? { ...rest, generationIssues: issues } : rest) as AppScene;
}

/** A legacy Scene without `outlineId` keeps none (the outline id is its own id). */
function withPreImageOutlineId(pre: AppScene, built: AppScene): AppScene {
  if (pre.outlineId !== undefined) return built;
  const { outlineId: _seeded, ...rest } = built;
  return rest as AppScene;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function regenerateOneScene(
  input: RegenerateOneSceneInput,
): Promise<RegenerateOneSceneResult> {
  const pre = input.scene;
  if (
    input.sourceContentUnitIds &&
    (input.narrationOnly || pre.type !== 'slide' || pre.content.type !== 'slide')
  ) {
    return failure(
      'SCENE_TYPE_NOT_REGENERABLE',
      'only a whole slide can take or give up a lesson part',
    );
  }
  if (input.narrationOnly && (pre.type !== 'slide' || pre.content.type !== 'slide')) {
    return failure(
      'SCENE_TYPE_NOT_REGENERABLE',
      'only a slide’s narration can be regenerated alone',
    );
  }
  if (isBankQuizScene(pre)) {
    // W6: the questions live in the Kafuo question bank; nothing is generated.
    return failure(
      'BANK_QUIZ_NOT_REGENERABLE',
      'this quiz shows the approved question-bank questions; it cannot be regenerated',
    );
  }
  if (pre.type === 'quiz' && pre.content.type === 'quiz') return regenerateQuizScene(input);
  if (pre.type !== 'slide' || pre.content.type !== 'slide') {
    return failure('SCENE_TYPE_NOT_REGENERABLE', 'only slides and quizzes can be regenerated');
  }
  if (input.narrationOnly) return regenerateSlideNarration(input);
  const assertRoute = input.assertRouteAvailable ?? (() => {});
  const generateContent = input.generateContent ?? generateSceneContent;
  const now = input.now ?? Date.now;

  // 1. The outline, seeded from the persisted Scene and its stored plan. No AI
  //    image generation: planned media generations are stripped. A moved lesson
  //    part (owner, 14 Nov 2026) replaces the content fields with the re-plan.
  const seeded = seededOutline(pre, input.outlineSnapshot);
  const replanned = input.replannedOutline
    ? withSlideIdentity(input.replannedOutline, seeded, input.sourceContentUnitIds)
    : null;
  const outline = replanned ?? seeded;
  const legacyInPlace =
    outline.slideType === undefined &&
    outline.contentRole === undefined &&
    outline.contentKind === undefined;

  // 2. Book images (§7.4). A re-planned slide starts from an empty canvas: only the
  //    visuals its new plan selects are offered, never the old slide's images.
  const lifted = liftSlideImages({
    canvas: replanned
      ? { elements: [], background: pre.content.canvas.background }
      : pre.content.canvas,
    sourceVisuals: input.outlineSnapshot?.sourceVisuals,
    suggestedImageIds: outline.suggestedImageIds,
    // The app outline type predates the planner field; the stored plan carries it.
    visualPlan: (outline as { visualPlan?: VisualPlan }).visualPlan,
  });
  if (!lifted.ok) return failure(lifted.code, lifted.message);
  const { baseline, assignedImages, imageMapping } = lifted.lifted;
  const hasImageMapping = Object.keys(imageMapping).length > 0;

  // 3. Content (single shot), in edit mode.
  const stage = input.stage;
  const agents = stage.generatedAgentConfigs;
  const languageDirective = input.registerPolicy?.directive ?? stage.languageDirective ?? '';
  let contentFailure: { code: string; detail?: string } | undefined;
  let content: Awaited<ReturnType<typeof generateSceneContent>>;
  try {
    content = await generateContent(outline, input.aiCallFor(sceneContentStage('slide')), {
      agents,
      languageDirective,
      ...(stage.textDirection ? { textDirection: stage.textDirection } : {}),
      allowProceduralSkill: true,
      ...(assignedImages.length > 0 ? { assignedImages } : {}),
      ...(hasImageMapping ? { imageMapping } : {}),
      // A re-planned slide is generated fresh from its plan, as an inserted slide
      // is; every other regeneration edits the current slide.
      ...(replanned ? {} : { editDirective: input.instruction, baselineContent: baseline }),
      ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
      ...(isTeacherParityModel(input.teachingModel) ? { visibleWorkingSteps: true } : {}),
      ...sacredPromptOf(input),
      onFailure: (event) => {
        contentFailure = event;
      },
    });
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError)
      return failure(error.code, error.message, error.details);
    if (codeOf(error) === 'ORIENTATION_VISUAL_MISSING') {
      return failure('ORIENTATION_VISUAL_MISSING', (error as Error).message);
    }
    throw error;
  }
  assertRoute();
  if (!content || !('elements' in content)) {
    return failure(
      input.governed ? 'GOVERNED_SCENE_GENERATION_FAILED' : 'SCENE_CONTENT_GENERATION_FAILED',
      'the slide content could not be generated; nothing was written',
      contentFailure ? { failure: contentFailure.code } : undefined,
    );
  }

  // 4. Actions under the register policy; fallback defaults refused.
  // Each lifted book image reaches narration with its own planned note.
  const imageNotes = hasImageMapping
    ? buildNarrationImageNotes(outline, assignedImages, imageMapping)
    : undefined;
  // A moved lesson part (owner, 14 Nov 2026): the narration follows the move too,
  // so the narration model gets the same directive as the content model.
  const generatedActions = await slideActions(input, outline, content, {
    imageNotes,
    ...(input.sourceContentUnitIds ? { directive: input.instruction } : {}),
  });
  if (!generatedActions.ok) return generatedActions;
  const actions = generatedActions.actions;

  // 5. Assembly: same id, carried assistance, the pre-image's canvas frame.
  const built = buildCompleteScene(
    outline,
    withCarriedAssistance(content, pre as Scene),
    actions,
    pre.stageId,
    { sceneId: pre.id },
  ) as AppScene | null;
  if (!built || built.content.type !== 'slide') {
    return failure('SCENE_CONTENT_GENERATION_FAILED', 'the slide could not be assembled');
  }
  if (!legacyInPlace) {
    try {
      assertGeneratedSlideScene(built);
    } catch (error) {
      return failure('SCENE_CONTENT_GENERATION_FAILED', (error as Error).message);
    }
  }
  const preCanvas = pre.content.canvas;
  let candidate: AppScene = {
    ...withPreImageOutlineId(pre, built),
    createdAt: pre.createdAt,
    updatedAt: now(),
    content: {
      ...built.content,
      canvas: {
        ...built.content.canvas,
        id: preCanvas.id,
        viewportSize: preCanvas.viewportSize,
        viewportRatio: preCanvas.viewportRatio,
        theme: preCanvas.theme,
      },
    },
    ...(pre.teachingStage !== undefined ? { teachingStage: pre.teachingStage } : {}),
    ...(pre.teachingSkills !== undefined ? { teachingSkills: pre.teachingSkills } : {}),
    ...(pre.learningObjectives !== undefined ? { learningObjectives: pre.learningObjectives } : {}),
    // A moved lesson part (owner, 14 Nov 2026) sets the new list; otherwise kept.
    ...(input.sourceContentUnitIds
      ? { sourceContentUnitIds: [...input.sourceContentUnitIds] }
      : pre.sourceContentUnitIds !== undefined
        ? { sourceContentUnitIds: pre.sourceContentUnitIds }
        : {}),
  } as AppScene;
  if (input.governed) {
    // A governed regeneration is a fresh generation-origin baseline (W4.4).
    const stamped = buildSceneAlignmentBaseline(candidate, { origin: 'generation', now: now() });
    if (stamped) candidate = { ...candidate, alignmentBaseline: stamped };
  }

  // 6. Validation (repeated inside the store write).
  return validatedSlideCandidate(input, candidate);
}

/** Step 6 of a slide regeneration: invariants, Actions, the write boundary. */
function validatedSlideCandidate(
  input: RegenerateOneSceneInput,
  candidate: AppScene,
): RegenerateOneSceneResult {
  const pre = input.scene;
  const sacredRefusal = sacredTextRefusal(input, candidate);
  if (sacredRefusal) return sacredRefusal;
  const violations = regenerationInvariantViolations(pre, candidate, input.sourceContentUnitIds);
  if (violations.length > 0) {
    return failure(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the regenerated slide changed fields it must keep: ${violations.join(', ')}`,
    );
  }
  const others = input.scenes.filter((scene) => scene.id !== pre.id);
  const findings = validateSceneActionStructure([...others, candidate], {
    stage: input.stage,
  }).filter((finding) => finding.sceneId === pre.id);
  if (findings.length > 0) {
    const first = findings[0]!;
    return failure(first.code, first.message, { findings: findings.length });
  }
  const storable = omitUndefinedObjectMembers(withNarrationAudioMark(candidate, input.scenes));
  const validation = validateAppScene(storable);
  if (!validation.valid) {
    return failure(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the regenerated slide is not a valid scene: ${validation.errors
        .map((error) => `${error.path || '/'}: ${error.message}`)
        .join('; ')}`,
    );
  }
  return { ok: true, scene: storable };
}

type RegenerationFailure = Extract<RegenerateOneSceneResult, { ok: false }>;
type SlideActionsResult =
  | { ok: true; actions: ReturnType<typeof filterKnownActions> }
  | RegenerationFailure;

/**
 * Step 4 of a slide regeneration: the Actions under the register policy, with
 * model-free fallback Actions refused. `directive` (narration-only) carries the
 * reviewer's requirements to the narration model.
 */
async function slideActions(
  input: RegenerateOneSceneInput,
  outline: SceneOutline,
  content: GeneratedSlideContent,
  options: { imageNotes?: Record<string, NarrationImageNote>; directive?: string },
): Promise<SlideActionsResult> {
  const pre = input.scene;
  const assertRoute = input.assertRouteAvailable ?? (() => {});
  const generateActions = input.generateActions ?? generateSceneActions;
  const agents = input.stage.generatedAgentConfigs;
  const languageDirective = input.registerPolicy?.directive ?? input.stage.languageDirective ?? '';
  const fallbackCode: TeachingPackageErrorCode = input.governed
    ? 'GOVERNED_ACTION_GENERATION_FAILED'
    : 'SCENE_ACTION_GENERATION_FAILED';
  const { imageNotes, directive } = options;
  let actions;
  try {
    const sceneCtx = actionContext(input.scenes as Scene[], pre as Scene);
    const spokenScript = resolveSpokenScriptOptions(input.stage.language, input.registerPolicy);
    actions = await generateRegisterCompliantActions(
      async (registerCorrection) => {
        const correctiveContext =
          [directive, registerCorrection].filter(Boolean).join('\n\n') || undefined;
        let fellBack: SceneActionsFallback | undefined;
        const generated = await generateActions(
          outline,
          content,
          input.aiCallFor('scene-actions'),
          {
            ctx: sceneCtx,
            agents,
            languageDirective,
            ...(input.registerPolicy
              ? { spokenLanguagePolicy: input.registerPolicy.directive }
              : {}),
            ...(spokenScript ? { spokenScript } : {}),
            ...(correctiveContext ? { correctiveContext } : {}),
            ...(input.governed ? { flowContext: input.governed.flowContext } : {}),
            ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
            ...(imageNotes ? { imageNotes } : {}),
            ...sacredPromptOf(input),
            onFallback: (info) => {
              fellBack = info;
            },
          },
        );
        if (fellBack && input.refuseFallbackActions) {
          assertRoute();
          throw new TeachingPackageError(
            fallbackCode,
            'the narration could not be generated (the model answer was unusable); nothing was written',
            { fallback: fellBack.code },
          );
        }
        return filterKnownActions(generated);
      },
      input.registerPolicy,
      { title: pre.title, outlineId: outline.id },
      { outline, ctx: sceneCtx },
    );
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError)
      return failure(error.code, error.message, error.details) as RegenerationFailure;
    throw error;
  }
  assertRoute();
  return { ok: true, actions };
}

/**
 * D-5 A (2 Nov 2026): a slide's narration regenerated alone, after the
 * reviewer deleted an image the old narration described. The canvas is the
 * stored one, untouched: no content call, no image re-offer (a full
 * regeneration offers the outline's selected images again, so a deleted
 * Ministry logo could come back). Only images still on the canvas reach the
 * narration with their planned notes. Everything else — Action gate,
 * invariants, audio mark, write boundary — is the slide path's.
 */
async function regenerateSlideNarration(
  input: RegenerateOneSceneInput,
): Promise<RegenerateOneSceneResult> {
  const pre = input.scene;
  if (pre.content.type !== 'slide') {
    return failure(
      'SCENE_TYPE_NOT_REGENERABLE',
      'only a slide’s narration can be regenerated alone',
    );
  }
  const now = input.now ?? Date.now;
  const canvas = pre.content.canvas;
  const shownSources = new Set(
    canvas.elements
      .map((element) => (element.type === 'image' ? (element as { src?: unknown }).src : undefined))
      .filter((src): src is string => typeof src === 'string'),
  );
  const shown = (input.outlineSnapshot?.sourceVisuals ?? []).filter((entry) =>
    shownSources.has(entry.servingPath),
  );
  const shownIds = new Set(shown.map((entry) => entry.id));
  const seeded = seededOutline(pre, input.outlineSnapshot);
  // The outline keeps only the images still shown: a deleted one has no note.
  const outline: SceneOutline = {
    ...seeded,
    ...(seeded.suggestedImageIds
      ? { suggestedImageIds: seeded.suggestedImageIds.filter((id) => shownIds.has(id)) }
      : {}),
  };
  const notes =
    shown.length > 0
      ? buildNarrationImageNotes(
          outline,
          shown.map((entry) => ({ id: entry.id })),
          Object.fromEntries(shown.map((entry) => [entry.id, entry.servingPath])),
        )
      : {};
  const generated = await slideActions(
    input,
    outline,
    { elements: canvas.elements, background: canvas.background } as GeneratedSlideContent,
    {
      ...(Object.keys(notes).length > 0 ? { imageNotes: notes } : {}),
      directive: `Rewrite only this slide's narration. The slide's canvas is final: describe and point at only the elements listed above, never an image or element that is not listed. The reviewer's requirements:\n${input.instruction}`,
    },
  );
  if (!generated.ok) return generated;

  const { generationIssues: preIssues, ...rest } = pre;
  const remaining = (preIssues ?? []).filter(
    (issue) => issue.code !== NARRATION_DELETED_IMAGE_ISSUE_CODE,
  );
  const candidate = {
    ...rest,
    actions: generated.actions,
    updatedAt: now(),
    ...(remaining.length > 0 ? { generationIssues: remaining } : {}),
  } as AppScene;
  return validatedSlideCandidate(input, candidate);
}

/**
 * A reviewer's regeneration of one quiz Scene (3 Oct 2026) — the slide path's
 * contract, minus the canvas: the outline seeded from the persisted Scene, the
 * reviewer's requirements (with the current questions) as the edit directive,
 * single-shot content, Actions under the register policy with fallbacks
 * refused, and the same invariant, Action and write-boundary validation.
 */
async function regenerateQuizScene(
  input: RegenerateOneSceneInput,
): Promise<RegenerateOneSceneResult> {
  const pre = input.scene;
  if (pre.content.type !== 'quiz') {
    return failure('SCENE_TYPE_NOT_REGENERABLE', 'only slides and quizzes can be regenerated');
  }
  const assertRoute = input.assertRouteAvailable ?? (() => {});
  const generateContent = input.generateContent ?? generateSceneContent;
  const generateActions = input.generateActions ?? generateSceneActions;
  const now = input.now ?? Date.now;

  const outline: SceneOutline = { ...seededOutline(pre, input.outlineSnapshot), type: 'quiz' };

  const stage = input.stage;
  const agents = stage.generatedAgentConfigs;
  const languageDirective = input.registerPolicy?.directive ?? stage.languageDirective ?? '';
  const editDirective = `${input.instruction}\n\nThe quiz's current questions, to be rewritten according to the requirements above for the same learning objective:\n${JSON.stringify(pre.content.questions)}`;
  let contentFailure: { code: string; detail?: string } | undefined;
  let content: Awaited<ReturnType<typeof generateSceneContent>>;
  try {
    content = await generateContent(outline, input.aiCallFor(sceneContentStage('quiz')), {
      agents,
      languageDirective,
      editDirective,
      ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
      ...sacredPromptOf(input),
      onFailure: (event) => {
        contentFailure = event;
      },
    });
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError)
      return failure(error.code, error.message, error.details);
    throw error;
  }
  assertRoute();
  if (!content || !('questions' in content) || content.questions.length === 0) {
    return failure(
      input.governed ? 'GOVERNED_SCENE_GENERATION_FAILED' : 'SCENE_CONTENT_GENERATION_FAILED',
      'the quiz could not be generated; nothing was written',
      contentFailure ? { failure: contentFailure.code } : undefined,
    );
  }

  const fallbackCode: TeachingPackageErrorCode = input.governed
    ? 'GOVERNED_ACTION_GENERATION_FAILED'
    : 'SCENE_ACTION_GENERATION_FAILED';
  let actions;
  try {
    const sceneCtx = actionContext(input.scenes as Scene[], pre as Scene);
    const spokenScript = resolveSpokenScriptOptions(input.stage.language, input.registerPolicy);
    actions = await generateRegisterCompliantActions(
      async (correctiveContext) => {
        let fellBack: SceneActionsFallback | undefined;
        const generated = await generateActions(
          outline,
          content,
          input.aiCallFor('scene-actions'),
          {
            ctx: sceneCtx,
            agents,
            languageDirective,
            ...(input.registerPolicy
              ? { spokenLanguagePolicy: input.registerPolicy.directive }
              : {}),
            ...(spokenScript ? { spokenScript } : {}),
            ...(correctiveContext ? { correctiveContext } : {}),
            ...(input.governed ? { flowContext: input.governed.flowContext } : {}),
            ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
            ...sacredPromptOf(input),
            onFallback: (info) => {
              fellBack = info;
            },
          },
        );
        if (fellBack && input.refuseFallbackActions) {
          assertRoute();
          throw new TeachingPackageError(
            fallbackCode,
            'the narration could not be generated (the model answer was unusable); nothing was written',
            { fallback: fellBack.code },
          );
        }
        return filterKnownActions(generated);
      },
      input.registerPolicy,
      { title: pre.title, outlineId: outline.id },
      { outline, ctx: sceneCtx },
    );
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError)
      return failure(error.code, error.message, error.details);
    throw error;
  }
  assertRoute();

  const built = buildCompleteScene(outline, content, actions, pre.stageId, {
    sceneId: pre.id,
  }) as AppScene | null;
  if (!built || built.content.type !== 'quiz') {
    return failure('SCENE_CONTENT_GENERATION_FAILED', 'the quiz could not be assembled');
  }
  let candidate: AppScene = {
    ...withPreImageOutlineId(pre, built),
    createdAt: pre.createdAt,
    updatedAt: now(),
    ...(pre.teachingStage !== undefined ? { teachingStage: pre.teachingStage } : {}),
    ...(pre.teachingSkills !== undefined ? { teachingSkills: pre.teachingSkills } : {}),
    ...(pre.learningObjectives !== undefined ? { learningObjectives: pre.learningObjectives } : {}),
    ...(pre.sourceContentUnitIds !== undefined
      ? { sourceContentUnitIds: pre.sourceContentUnitIds }
      : {}),
  } as AppScene;
  if (input.governed) {
    const stamped = buildSceneAlignmentBaseline(candidate, { origin: 'generation', now: now() });
    if (stamped) candidate = { ...candidate, alignmentBaseline: stamped };
  }

  const sacredRefusal = sacredTextRefusal(input, candidate);
  if (sacredRefusal) return sacredRefusal;
  const violations = regenerationInvariantViolations(pre, candidate);
  if (violations.length > 0) {
    return failure(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the regenerated quiz changed fields it must keep: ${violations.join(', ')}`,
    );
  }
  const others = input.scenes.filter((scene) => scene.id !== pre.id);
  const findings = validateSceneActionStructure([...others, candidate], { stage }).filter(
    (finding) => finding.sceneId === pre.id,
  );
  if (findings.length > 0) {
    const first = findings[0]!;
    return failure(first.code, first.message, { findings: findings.length });
  }
  const storable = omitUndefinedObjectMembers(withNarrationAudioMark(candidate, input.scenes));
  const validation = validateAppScene(storable);
  if (!validation.valid) {
    return failure(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the regenerated quiz is not a valid scene: ${validation.errors
        .map((error) => `${error.path || '/'}: ${error.message}`)
        .join('; ')}`,
    );
  }
  return { ok: true, scene: storable };
}
