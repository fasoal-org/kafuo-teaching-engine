import { AsyncLocalStorage } from 'node:async_hooks';

import { callLLM } from '@/lib/ai/llm';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { createStageAPI } from '@/lib/api/stage-api';
import { generateId } from '@/lib/api/stage-api-defaults';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  analyzeOutlines,
  applyOutlineFallbacks,
  blockingOutlineDiagnostics,
  buildNarrationImageNotes,
  buildSceneSourceContext,
  formatBlockingOutlineDiagnostics,
  MAX_VISION_IMAGES,
  sortDocumentImagesForVision,
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  NATIVE_VISUAL_DIRECTIVE,
  OUTLINE_TEACHING_FLOW_ERROR,
  OrientationVisualMissingError,
  plannedVisualIssue,
  PBLGenerationError,
  withGenerationRetry,
  buildVisionUserContent,
  interactiveWidgetTypeOf,
  isProhibitedWidgetOutline,
  visibleCanvasText,
  type AICallFn,
  type AgentInfo,
  type OutlineAnswerReport,
  type OutlineDiagnostic,
  type PdfImage,
  type SceneActionsFallback,
  type SceneFlowContext,
  type SourceUnitText,
  type TeachingFlowEntry,
  type WidgetType,
} from '@openmaic/generation';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import {
  NARRATION_MISSING_ISSUE_CODE,
  narrationMissing,
} from '@/lib/server/teaching-package/narration-audio-issue';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import type { LanguageModel } from 'ai';
import type { ModelInfo, ThinkingConfig } from '@/lib/types/provider';
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
  dropUnmappedMediaPlaceholders,
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { SpeechAction } from '@/lib/types/action';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import {
  resolveTextDirection,
  type Scene,
  type SceneGenerationIssue,
  type Stage,
  type StageTtsRoute,
} from '@/lib/types/stage';
import {
  placeholderQuizContent,
  placeholderSlideContent,
} from '@/lib/server/teaching-package/placeholder-slide';
import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
import {
  guardedSceneContent,
  guideLeakIssue,
  type GuideAnswerGuard,
} from '@/lib/server/teaching-package/guide-answer-guard';
import { withoutHiddenAnswerKey } from '@/lib/server/teaching-package/guide-answers';
import { withGuideWrittenQuestions } from '@/lib/server/teaching-package/guide-written-attempts';
import { retitledExerciseSolution } from '@/lib/server/teaching-package/exercise-slide-title';
import {
  bankQuizActions,
  bankQuizContent,
  isBankCheckQuizOutline,
  markBankQuizScene,
} from '@/lib/server/teaching-package/bank-quiz-scene';
import type {
  OutlineAnswerCapture,
  SourceVisualManifestEntry,
  TeachingFlowEntry as AppTeachingFlowEntry,
  TeachingModelLineage,
} from '@/lib/types/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  formatSpeechRegisterCorrection,
  resolveSpeechRegisterPolicy,
  resolveSpokenScriptOptions,
  validateSpeechRegister,
  type SpeechRegisterIssue,
  type SpeechRegisterPolicy,
} from '@/lib/server/speech/register-policy';
import {
  formatNarrationSignpostingCorrection,
  validateNarrationSignposting,
  type NarrationSceneContext,
  type NarrationSignpostingIssue,
} from '@/lib/server/speech/narration-signposting';
import {
  formatLearnerFirstNarrationCorrection,
  validateLearnerFirstNarration,
  type LearnerFirstNarrationIssue,
  type NarrationCanvasElement,
} from '@/lib/server/speech/learner-first-narration';
import {
  detectLessonDigitStyle,
  normalizeQuizPoints,
  normalizeSceneDigits,
} from '@/lib/server/teaching-package/learner-first-source';
import {
  detectBookLogicNotation,
  isMathSubject,
  normalizeSceneLogicNotation,
} from '@/lib/server/teaching-package/math-logic-notation';
import {
  executeTeachingCall,
  TeachingModelUnavailableError,
  type TeachingCallContext,
} from '@/lib/server/teaching-model/execute';
import type { ResolvedSubjectPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { isSubjectCode } from '@/lib/server/teaching-model/subject-policy';
import {
  applySourceVisualPrecedence,
  SourceVisualModelUnavailableError,
  SourceVisualProcessingError,
} from '@/lib/server/teaching-package/source-images';
import { resolveFlowSkillPolicies } from '@/lib/server/teaching-package/skill-policy';
import { GenerationCorrectionRequiredError } from '@/lib/server/teaching-package/outline-correction';
import { BOOK_REPAIR_BLOCKING_CODES } from '@/lib/server/teaching-package/book-coverage-repair';
import { replanSlideVisuals } from '@/lib/server/teaching-package/replan-slide-visuals';
import { chooseSplitUnitImageKeepers } from '@/lib/server/teaching-package/split-unit-images';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

import { resolveImageTextPolicy } from '@/lib/server/visual-compliance/prompt-policy';
import {
  exerciseSceneIdsOf,
  sacredQuotesForPrompt,
  stripSacredExerciseItems,
  stripSacredNarration,
  stripSacredTextFromMediaRequests,
  usedSacredQuotePins,
  type SacredQuote,
  type SacredQuotePin,
} from '@/lib/server/teaching-package/sacred-text';

const log = createLogger('Classroom');

/**
 * How many Scenes' content is generated at once (1 Nov 2026, generation latency).
 * Content calls are independent per Scene, so the ~26 serial calls of a 21-Scene
 * lesson (about 6 of its 12 minutes) run 4 at a time; actions stay serial. The
 * call count and cost are unchanged. `TE_SCENE_CONTENT_CONCURRENCY=1` restores the
 * old one-at-a-time order. Clamped to [1, 8].
 */
export function sceneContentConcurrency(raw = process.env.TE_SCENE_CONTENT_CONCURRENCY): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(8, Math.max(1, parsed));
}

/**
 * A scene's Action generation, attempts in total, under a spoken-language
 * register policy: the first answer plus at most two re-rolls of THIS scene.
 */
export const SPEECH_REGISTER_MAX_ATTEMPTS = 3;

/** g5.v10: the learner-first narration check of one slide (plan W2). */
export interface LearnerFirstNarrationCheck<T> {
  check: (actions: T[]) => LearnerFirstNarrationIssue[];
  correction: (issues: readonly LearnerFirstNarrationIssue[]) => string;
  onUnresolved?: (issues: readonly LearnerFirstNarrationIssue[]) => void;
}

/**
 * g5.v10: the learner-first check of a slide against its own canvas, or
 * `undefined` for any other scene or Teaching Model (the loop is then unchanged).
 */
export function learnerFirstNarrationCheck<T extends { type: string; text?: unknown }>(
  enabled: boolean | undefined,
  content: unknown,
  onUnresolved?: (issues: readonly LearnerFirstNarrationIssue[]) => void,
  /** The slide's contentRole: a learner task (a try-it) is read, never solved. */
  contentRole?: string | null,
): LearnerFirstNarrationCheck<T> | undefined {
  if (!enabled || !content || typeof content !== 'object' || !('elements' in content)) {
    return undefined;
  }
  const elements = ((content as { elements?: unknown }).elements ?? []) as Array<{
    id?: unknown;
    type?: unknown;
  }>;
  const canvas: NarrationCanvasElement[] = elements.map((element) => ({
    id: String(element.id ?? ''),
    type: String(element.type ?? ''),
    text: visibleCanvasText([element as never])
      .replace(/\s+/g, ' ')
      .trim(),
  }));
  return {
    check: (actions) => validateLearnerFirstNarration(actions as never, canvas),
    correction: (issues) => formatLearnerFirstNarrationCorrection(issues, canvas, contentRole),
    ...(onUnresolved ? { onUnresolved } : {}),
  };
}

function spokenTexts(actions: ReadonlyArray<{ type: string; text?: unknown }>): string[] {
  return actions.flatMap((action) =>
    action.type === 'speech' && typeof action.text === 'string' ? [action.text] : [],
  );
}

/**
 * Generate one scene's Actions under the server's spoken-language register
 * policy. The narration is checked for its register and raw spoken notation
 * and — when the scene's position is known — for topic signposting. Any issue
 * re-rolls THIS scene only, with every issue merged into ONE corrective
 * context, up to {@link SPEECH_REGISTER_MAX_ATTEMPTS} attempts in total; then
 * the run fails with `SPEECH_REGISTER_NONCOMPLIANT` (typed issue codes in its
 * details), which is not an attempt-level retry code (the package is never
 * regenerated for it). Model-free default Actions are validated like any
 * answer. Without a policy the generator runs exactly once, as before.
 */
export async function generateRegisterCompliantActions<T extends { type: string; text?: unknown }>(
  generate: (correctiveContext?: string) => Promise<T[]>,
  policy: SpeechRegisterPolicy | null,
  scene: { title: string; outlineId: string },
  signposting?: NarrationSceneContext,
  /**
   * Package generation (3 Oct 2026): record a still-noncompliant narration on
   * the scene instead of failing the package. When supplied, the last answer is
   * returned after this is called; absent → the typed error is thrown as before.
   */
  onNoncompliant?: (error: TeachingPackageError) => void,
  /**
   * g5.v10 (learner-first plan W2): the slide's own canvas checks
   * (`validateLearnerFirstNarration`), re-rolled in the same loop. Issues left
   * after the last attempt never fail the scene: they are handed to
   * `onUnresolved` (the scene is marked for the reviewer). Absent → unchanged.
   */
  learnerFirst?: LearnerFirstNarrationCheck<T>,
): Promise<T[]> {
  if (!policy && !learnerFirst) return generate();
  let correctiveContext: string | undefined;
  let issues: SpeechRegisterIssue[] = [];
  let structure: NarrationSignpostingIssue[] = [];
  let firstIssues: LearnerFirstNarrationIssue[] = [];
  let last: T[] = [];
  // g5.v10: the last answer that met the register policy (only learner-first issues
  // left), so a learner-first re-roll can never turn a compliant narration into a failure.
  let registerClean: { actions: T[]; issues: LearnerFirstNarrationIssue[] } | null = null;
  for (let attempt = 1; attempt <= SPEECH_REGISTER_MAX_ATTEMPTS; attempt += 1) {
    const actions = await generate(correctiveContext);
    last = actions;
    const texts = spokenTexts(actions);
    issues = policy ? validateSpeechRegister(texts, policy) : [];
    structure = policy && signposting ? validateNarrationSignposting(texts, signposting) : [];
    firstIssues = learnerFirst ? learnerFirst.check(actions) : [];
    if (issues.length === 0 && structure.length === 0 && firstIssues.length === 0) return actions;
    if (issues.length === 0 && structure.length === 0) {
      registerClean = { actions, issues: firstIssues };
    }
    log.warn(
      `Scene "${scene.title}" narration breaks the ${policy?.register ?? 'learner-first'} narration policy (${[
        ...issues,
        ...structure,
        ...firstIssues,
      ]
        .map((issue) => issue.code)
        .join(', ')}); attempt ${attempt}/${SPEECH_REGISTER_MAX_ATTEMPTS}`,
    );
    correctiveContext = [
      ...(structure.length > 0 && signposting
        ? [formatNarrationSignpostingCorrection(structure, signposting)]
        : []),
      ...(issues.length > 0 && policy ? [formatSpeechRegisterCorrection(issues, policy)] : []),
      ...(firstIssues.length > 0 && learnerFirst ? [learnerFirst.correction(firstIssues)] : []),
    ].join('\n\n');
  }
  if (!policy || (issues.length === 0 && structure.length === 0)) {
    // Only learner-first issues are left: keep the last answer, mark the scene.
    if (firstIssues.length > 0) learnerFirst?.onUnresolved?.(firstIssues);
    return last;
  }
  if (registerClean) {
    // An earlier answer met the register policy: return it, marked, rather than fail.
    learnerFirst?.onUnresolved?.(registerClean.issues);
    return registerClean.actions;
  }
  if (firstIssues.length > 0) learnerFirst?.onUnresolved?.(firstIssues);
  const error = new TeachingPackageError(
    'SPEECH_REGISTER_NONCOMPLIANT',
    `scene ${JSON.stringify(scene.title)} narration still breaks the ${policy.register} narration policy after ${SPEECH_REGISTER_MAX_ATTEMPTS} attempts (${[
      ...issues,
      ...structure,
    ]
      .map((issue) => issue.code)
      .join(', ')})`,
    {
      outlineId: scene.outlineId,
      policyVersion: policy.version,
      register: policy.register,
      issues: [
        ...issues.map((issue) => ({ code: issue.code, evidence: issue.evidence })),
        ...structure.map((issue) => ({
          code: issue.code,
          transition: issue.transition,
          evidence: issue.evidence,
        })),
      ],
    },
  );
  if (!onNoncompliant) throw error;
  onNoncompliant(error);
  return last;
}

/**
 * Record generation issues on a kept scene, de-duplicated by code (3 Oct 2026).
 * Mutated in place, like the media pass's own scene edits, so every reference to
 * the scene (the store and any captured scene list) persists the same marker.
 */
/** Scene types a reviewer can regenerate one at a time (3 Oct 2026). */
function isReviewerRegenerable(type: string): boolean {
  return type === 'slide' || type === 'quiz';
}

/** The placeholder a governed slide/quiz position keeps when nothing usable came back. */
function placeholderContentFor(
  outline: { type: string; title: string; description?: string; keyPoints?: string[] },
  textDirection?: 'rtl' | 'ltr',
) {
  return outline.type === 'quiz'
    ? placeholderQuizContent(outline, textDirection)
    : placeholderSlideContent(outline, textDirection);
}

/**
 * Governed runs (3 Oct 2026): instead of pausing the attempt for an admin, a
 * structurally invalid Action (unknown type, malformed, or a dangling element /
 * media / agent reference) is removed from its scene and the scene is marked —
 * the reviewer regenerates it. Returns how many scenes were repaired.
 */
export function repairInvalidActions(scenes: Scene[], stage: Stage): number {
  const findings = validateSceneActionStructure(scenes, { stage });
  if (findings.length === 0) return 0;
  const bySceneId = new Map<string, typeof findings>();
  for (const finding of findings) {
    bySceneId.set(finding.sceneId, [...(bySceneId.get(finding.sceneId) ?? []), finding]);
  }
  for (const [sceneId, sceneFindings] of bySceneId) {
    const scene = scenes.find((item) => item.id === sceneId);
    if (!scene) continue;
    const invalidIds = new Set(
      sceneFindings.flatMap((finding) => (finding.actionId ? [finding.actionId] : [])),
    );
    const before = scene.actions?.length ?? 0;
    scene.actions = (scene.actions ?? []).filter((action) => {
      const id = (action as { id?: unknown }).id;
      return typeof id === 'string' && id !== '' && !invalidIds.has(id);
    }) as typeof scene.actions;
    const removed = before - (scene.actions?.length ?? 0);
    const first = sceneFindings[0]!;
    const merged = [...(scene.generationIssues ?? [])];
    if (!merged.some((issue) => issue.code === first.code)) {
      merged.push({
        code: first.code,
        message: `${removed} invalid narration/animation step(s) were removed: ${first.message}`,
      });
    }
    scene.generationIssues = merged;
  }
  return bySceneId.size;
}

function markSceneIssues(
  store: { getState: () => { scenes: Scene[] } },
  sceneId: string,
  issues: readonly SceneGenerationIssue[],
): void {
  const scene = store.getState().scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  const merged = [...(scene.generationIssues ?? [])];
  for (const issue of issues) {
    if (!merged.some((existing) => existing.code === issue.code)) {
      merged.push({ code: issue.code, message: issue.message });
    }
  }
  scene.generationIssues = merged;
}

/**
 * Marks every scene that has a spoken line (a speech Action with text) left
 * without generated audio after the TTS phase. Students would hear the device
 * voice (or nothing) for those lines instead of the teacher voice.
 */
export function markNarrationAudioGaps(
  store: { getState: () => { scenes: Scene[] } },
  scenes: readonly Scene[],
): void {
  for (const scene of scenes) {
    // 21 Nov 2026: a slide scene with no spoken line at all is marked too — before,
    // `spoken` was empty so `missing` was 0 and a silent slide carried no mark at
    // all (lesson 3-4 scene 4). Quiz (bank quizzes included), interactive and pbl
    // scenes are not narrated and never get this mark.
    if (narrationMissing(scene)) {
      markSceneIssues(store, scene.id, [
        {
          code: NARRATION_MISSING_ISSUE_CODE,
          message:
            'the slide has no narration at all: no spoken line was generated for it; students would see it in silence',
        },
      ]);
      log.warn(`Scene "${scene.title}" kept with no narration at all; marked for review`);
      continue;
    }
    const spoken = (scene.actions ?? []).filter(
      (action) => action.type === 'speech' && Boolean((action as SpeechAction).text),
    ) as SpeechAction[];
    const missing = spoken.filter((action) => !action.audioId).length;
    if (missing === 0) continue;
    markSceneIssues(store, scene.id, [
      {
        code: 'NARRATION_AUDIO_FAILED',
        message: `narration audio could not be generated for ${missing} of ${spoken.length} spoken line(s); students will not hear the teacher voice there`,
      },
    ]);
    log.warn(
      `Scene "${scene.title}" kept without audio for ${missing}/${spoken.length} spoken line(s); marked for review`,
    );
  }
}

/** Legacy outline attempts per run; governed package generation is single-shot. */
const MAX_OUTLINE_GATE_ATTEMPTS = 3;
/** The correction sent with the one re-ask of an unparseable governed scene answer. */
const INVALID_SCENE_OUTPUT_CORRECTION =
  'Your previous answer for this slide could not be used: it was not a valid JSON object with an "elements" array. Answer again with ONLY the complete slide JSON object in the required schema — no prose, no markdown fences, and no wrapper object around it.';
/** Corrective-context prefix for collected (admin-correctable) outline findings. */
const OUTLINE_CORRECTION_PREFIX = 'OUTLINE_CORRECTION_REQUIRED';
/** Outline-gate rejections that a corrective re-roll can fix. */
/**
 * Outline findings about a slide's visual that the per-slide visual re-plan
 * fixes (slide image plan D-1): the planner re-chooses the image and writes its
 * notes, instead of a deterministic image swap.
 */
const VISUAL_REPLAN_CODES: ReadonlySet<string> = new Set([
  'SOURCE_VISUAL_NOT_SELECTED',
  'VISUAL_TEACHING_NOTE_MISSING',
  'AI_IMAGE_NOT_ALLOWED',
  'VISUAL_MODE_MISMATCH',
  'VISUAL_REQUIRED',
]);
const OUTLINE_GATE_ERROR =
  /^(OUTLINE_SLIDE_SEMANTICS_INVALID|OUTLINE_SCENE_CONFIG_INVALID|OUTLINE_TEACHING_FLOW_INVALID)\b/;
/**
 * The outline generator's answer to an empty plan for an authoritative flow (P1,
 * §3b): `${OUTLINE_TEACHING_FLOW_ERROR}: no outlines were returned …`.
 */
const EMPTY_PLAN_ERROR = new RegExp(
  `^${OUTLINE_TEACHING_FLOW_ERROR}: no outlines were returned\\b`,
);

/** The routed lesson-plan (outline) stage and its own time limit per model attempt. */
const OUTLINE_STAGE = 'scene-outlines-stream';
export const OUTLINE_TIMEOUT_MS = 180_000;

/**
 * The executor options of one routed teaching call. The whole lesson plan is
 * one non-streamed call: a g5.v8 plan of ~35 slides took 97.5 s against the
 * 110 s default (lesson 306), so only the outline stage gets a longer limit.
 */
export function routedCallOptions(
  stage: string,
  images: ReadonlyArray<unknown> | undefined,
): { images?: ReadonlyArray<unknown>; timeoutMs?: number } {
  return {
    ...(images !== undefined ? { images } : {}),
    ...(stage === OUTLINE_STAGE ? { timeoutMs: OUTLINE_TIMEOUT_MS } : {}),
  };
}

/** Raw outline text kept whole up to this many UTF-16 code units… */
const OUTLINE_ANSWER_KEEP_WHOLE = 16_384;
/** …and beyond it, this many from each end. */
const OUTLINE_ANSWER_KEEP_EACH_END = 8_192;

/** A size-capped copy of one outline answer, for diagnosis (lesson 306, F-1). */
export function captureOutlineAnswer(
  raw: string,
  report: OutlineAnswerReport,
): OutlineAnswerCapture {
  const cut = raw.length > OUTLINE_ANSWER_KEEP_WHOLE;
  // Never split a surrogate pair: a lone surrogate is refused by Postgres JSONB.
  const isHigh = (at: number) => /[\uD800-\uDBFF]/.test(raw.charAt(at));
  const isLow = (at: number) => /[\uDC00-\uDFFF]/.test(raw.charAt(at));
  const headEnd = isHigh(OUTLINE_ANSWER_KEEP_EACH_END - 1)
    ? OUTLINE_ANSWER_KEEP_EACH_END - 1
    : OUTLINE_ANSWER_KEEP_EACH_END;
  const tailStart = isLow(raw.length - OUTLINE_ANSWER_KEEP_EACH_END)
    ? raw.length - OUTLINE_ANSWER_KEEP_EACH_END + 1
    : raw.length - OUTLINE_ANSWER_KEEP_EACH_END;
  return {
    parse: report.parse ? { ...report.parse } : null,
    malformed: [...report.malformed],
    rawLength: raw.length,
    rawHead: cut ? raw.slice(0, headEnd) : raw,
    rawTail: cut ? raw.slice(tailStart) : '',
  };
}

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

/**
 * The authority a governed run carries (Module 3/4 W1, plan §7.1.1). Built
 * ONCE by the generation runner from the Teaching Skills contract marker
 * alone; `input.governed !== undefined` is the SINGLE governed-mode predicate
 * for the whole pipeline. The mode is never inferred from `teachingFlow`
 * presence, Flow Instructions, `teachingStage`, `teachingSkills`, Skill
 * Policy, `resolvedSkills`, Scene content, or Action content — a run carrying
 * any of those without the contract marker is legacy.
 */
export interface GovernedGenerationContext {
  /** The parsed contract marker (TEACHING_SKILLS_CONTRACT_V1). */
  contract: string;
  /** The Teaching Model identity this run was authorized under. */
  teachingModel: TeachingModelLineage;
  /** The authoritative Flow — ORCHESTRATION ONLY, never handed to the generator. */
  flow: readonly TeachingFlowEntry[];
}

/**
 * Ledger attribution for a subject-routed run (Kafuo R1 contracts §1, §7):
 * every teaching call's `teaching_model_attempts` row is keyed by the
 * generation attempt, its run number and the learning item. `versionId` is
 * always null here — no version is bound while generation runs.
 */
export interface GenerationAttribution {
  tenantId: string;
  generationAttemptId: string;
  generationRun: number;
  learningItemType: string;
  learningItemId: string;
}

export interface GenerateClassroomInput {
  requirement: string;
  /**
   * The subject's resolved model policy (Kafuo R1 plan §7.2/§7.4, ROUTE-01),
   * resolved ONCE per attempt by the runner. Present ⇒ every teaching stage
   * (`generate-classroom`, `scene-outlines-stream`, `scene-content[:type]`
   * incl. slide assistance, `scene-actions`, `agent-profiles`) runs through
   * the teaching executor, Primary → Fallback, with a ledger row per provider
   * call and NO budget assertion; `MODEL_ROUTES` has no effect on those
   * stages. Utilities stay on their stage routes (`web-search-query-rewrite`
   * is the product-acknowledged exception, contracts §0 L5; the PBL loop
   * planner is not a Kafuo teaching stage). A call whose both routes fail
   * throws `TeachingModelUnavailableError`, which fails the run. Absent ⇒
   * prompts, models and behaviour are byte-identical to the unrouted path.
   */
  modelPolicy?: ResolvedSubjectPolicy;
  /**
   * The planning and review policy (package-planner-issue-resolve-plan-
   * 2026-11-22 §3c), used only with `modelPolicy`: the planner's outline call
   * (`scene-outlines-stream`) and every call made through `outlineAiCall`
   * (the book-coverage repair, the outline refinement and the plan review
   * layer) run on it; every other stage keeps `modelPolicy`. Absent ⇒
   * `modelPolicy` for planning too.
   */
  planPolicy?: ResolvedSubjectPolicy;
  /** Required with `modelPolicy`: what the ledger rows are attributed to. */
  attribution?: GenerationAttribution;
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
   * Interactive widget types this run must never generate (Kafuo Release 1:
   * `['game']`, set by the Teaching Package runner). The outline planner is told,
   * an outline that would still build one is an admin-correctable
   * `WIDGET_TYPE_PROHIBITED` finding (initial, re-asked and resumed outlines
   * alike), and a Scene that would build one is refused with
   * `GAME_GENERATION_DEFERRED` before any content call. Absent → prompts and
   * behavior are byte-identical.
   */
  prohibitedWidgetTypes?: readonly WidgetType[];
  /**
   * Quizzes carry only machine-gradable questions (Kafuo: the learner app grades
   * keyed answers only, so an open short answer would never be scored).
   */
  keyedQuizzesOnly?: boolean;
  /**
   * W6 one question source (Kafuo package runs): a quiz at an objective's
   * `outcome_check_understanding` position is a deterministic bank placeholder
   * (`{ questions: [] }`, `questionSource: 'bank'`, a model-free narration) —
   * no quiz-content call and no quiz-narration call. Absent → unchanged.
   */
  bankCheckQuizzes?: boolean;
  /**
   * `pdfContent.text` is an approved Kafuo normalized package projected as
   * Content Units (never Blocks). Propagated to the outline prompt, which then
   * requires `sourceContentUnitIds` on every outline. Absent → prompts and
   * behavior are byte-identical to the pre-grounding path.
   */
  normalizedGrounding?: boolean;
  /**
   * The approved Content Units' own text (the text the outline prompt read).
   * Each teaching slide's content and narration prompts receive the units that
   * slide cites — never the whole lesson. Absent → prompts are byte-identical.
   */
  sourceUnits?: readonly SourceUnitText[];
  /**
   * g5.v8 (teacher-parity plan I-2): worked-example canvases write every
   * hidden step from the plan as a visible line. Set by the caller from the
   * Teaching Model; absent → every prompt is byte-identical.
   */
  visibleWorkingSteps?: boolean;
  /**
   * g5.v10, the learner-first Teaching Model (plan
   * `g5-v10-weak-student-fixes-plan-2026-11-15.md`): slide canvases and
   * narration get the learner-first rules, the narration is checked against
   * its canvas, and the digits are normalised to the lesson's style. Set by the
   * caller from the Teaching Model; absent → every prompt is byte-identical.
   */
  learnerFirst?: boolean;
  /**
   * g5.v10 quality plan W4: the learner-first visual rules of the outline checks
   * (no visual on a part opener or contents slide, no book image on an exercise slide, a unit's
   * image once per lesson), with the book's exercise units. Absent → unchanged.
   */
  learnerFirstVisuals?: { exerciseUnitIds: readonly string[] };
  /**
   * g5.v11 (teacher-guide answer referee plan §8.3–8.5): the code check of the approved
   * answers. A solution slide or attempt whose answer disagrees, or a try-it slide or
   * attempt that states it before the try, is regenerated ONCE with a correction; what
   * is still wrong is settled (an attempt question removed, or the item's outlines
   * dropped from the lesson). Absent → every scene is generated exactly as before.
   */
  guideAnswerGuard?: GuideAnswerGuard;
  /**
   * g5.v11 only (owner, 17 Nov 2026): the teacher guide's answer drawings the run fetched
   * and verified (`src-guide-<n>`). NEVER offered to the outline planner (they are not in
   * `pdfContent.pdfImages`): the engine itself selects each on the worked-solution outline
   * that solves its question (`injectGuideAnswers` → `suggestedImageIds`). From there they
   * are stored, assigned and narrated like that slide's source visuals. Absent → as before.
   */
  guideAnswerFigures?: PdfImage[];
  /**
   * Quran and hadith (Kafuo plan Q-4 to Q-15): the protected quotes of the
   * approved source. Present → every learner-text prompt carries the fixed
   * policy and the cited quotes verbatim, narration and image prompts are
   * stripped of quote text before TTS and media, and the package pins the
   * quotes it shows. Absent → prompts and behaviour are unchanged.
   */
  sacredText?: {
    quotes: readonly SacredQuote[];
    mode?: 'full' | 'short';
    /**
     * g5.v8 (owner, 4 Nov 2026): the book's exercise and check units. Their
     * slides drop every verse or hadith item, shown and spoken. Absent: off.
     */
    exerciseUnitIds?: readonly string[];
  };
  /**
   * g5.v8 (teacher-parity plan I-4.3): the slides that show a textbook image
   * another slide of the same unit illustrates better. Each is sent to the
   * per-slide visual re-plan without that image, so it gets a native diagram
   * (or another linked image). Fresh plans only, never an administrator's
   * resumed candidate. Absent → no such step.
   */
  findDuplicateSourceVisuals?: (
    outlines: readonly SceneOutline[],
    sourceImages: readonly PdfImage[],
  ) => ReadonlyArray<{ outlineId: string; imageId: string; keptOnOutlineId: string }>;
  /**
   * The authority a governed run carries (Module 3/4 W1, TAE-RQ-009/015).
   * Built ONCE by the caller from the Teaching Skills contract marker alone —
   * presence IS governance, and nothing downstream may re-derive the mode from
   * Flow presence, carriers, or Scene fields. The outline prompt's Skill
   * contract and the per-Scene Flow context both derive from this value.
   * Absent → the run is legacy and every prompt renders byte-identically.
   */
  governed?: GovernedGenerationContext;
  /**
   * The authoritative language of instruction as a BCP-47 tag, copied by the
   * caller from its lesson/curriculum metadata (Kafuo: `learningItem.language`).
   * It is stamped on the Stage as `language`, and the base `textDirection`
   * resolved from it — once, here — is stamped beside it and handed to slide
   * content generation. Never inferred from the requirement, the source, or
   * generated text. Absent → the Stage carries neither field and every prompt
   * renders byte-identically to the direction-unaware path.
   */
  language?: string;
  /**
   * The authoritative Kafuo subject code (`subjectOffering.code`), copied by the
   * caller from its curriculum metadata. Stamped on the Stage as `subjectCode`
   * only when it is a known subject code; never inferred from content. Absent,
   * null or unknown → the Stage carries no subject (general narration path).
   */
  subjectCode?: string | null;
  /**
   * The superadmin-configured narration route for the subject, already
   * validated by the caller (Kafuo: `narration.ttsRoute` resolved against the
   * catalogue). Stamped on the Stage as `ttsRoute`, so every later narration of
   * the lesson keeps its voice. Absent → the default routing table.
   */
  ttsRoute?: StageTtsRoute | null;
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

/**
 * Resolve ONE Scene's exact authoritative Flow entry, in orchestration
 * (Module 3/4 W1, TAE-RQ-009/012 — plan §7.1.2). Teaching Model orchestration
 * resolves WHEN; Action generation only consumes it. The returned context is
 * the only Flow shape the generator ever sees — no array, no index lookup.
 *
 * Fail-closed: on a governed run, an outline without a `teachingStage`, an
 * out-of-range `flowIndex`, a stage/key mismatch against the authoritative
 * entry, or empty Flow Instructions refuses with GOVERNED_FLOW_CONTEXT_UNRESOLVED
 * BEFORE Action generation — a governed Scene can never be generated with the
 * Flow block silently omitted. The refusal is identity-only (§12.6): no
 * narration, no source prose. A non-governed run returns undefined, never
 * throws, and behaves exactly as before W1.
 */
export function resolveGovernedSceneFlowContext(
  governed: GovernedGenerationContext | undefined,
  outline: SceneOutline,
): SceneFlowContext | undefined {
  if (!governed) return undefined;
  const stage = outline.teachingStage;
  const identity = {
    teachingModel: `${governed.teachingModel.key}@${governed.teachingModel.version}`,
    stageKey: stage?.key,
    flowIndex: stage?.flowIndex,
  };
  function refuse(reason: string): never {
    throw new TeachingPackageError(
      'GOVERNED_FLOW_CONTEXT_UNRESOLVED',
      `cannot resolve the authoritative Flow entry for a governed scene (${reason})`,
      { ...identity, reason },
    );
  }
  if (!stage) refuse('outline has no teachingStage');
  const entry: AppTeachingFlowEntry | undefined = governed.flow[stage.flowIndex];
  if (!entry) refuse('teachingStage.flowIndex is out of range for the governed flow');
  if (entry.stage !== stage.key) refuse('flow entry stage does not match teachingStage.key');
  if (!entry.instructions.trim()) refuse('flow entry instructions are empty');
  return {
    teachingModelKey: governed.teachingModel.key,
    teachingModelVersion: governed.teachingModel.version,
    stageKey: entry.stage,
    flowIndex: stage.flowIndex,
    instructions: entry.instructions,
  };
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
  /**
   * Metadata repairs applied to the outlines (e.g. an incompatible
   * `contentKind` dropped, role kept) — recorded so they stay visible.
   */
  outlineRepairs: OutlineDiagnostic[];
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
      /** Q-14: sha256 + source block id of each Quran / hadith quote the package shows. */
      sacredQuotes?: SacredQuotePin[];
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

/**
 * Admin-correction support (slide-classification-admin-correction-plan §3),
 * present only for a run that can pause for a person (a Kafuo attempt).
 * Without it every prompt, gate and failure behaves exactly as before.
 */
export interface GenerationCorrectionOptions {
  /**
   * App-authority outline findings (Content-Unit grounding, Teaching Skill
   * selections), reported as admin-correctable diagnostics. Runs after the
   * authority gate (`validateOutlines`) and before any Stage reservation.
   */
  collectOutlineIssues?: (
    outlines: SceneOutline[],
  ) => OutlineDiagnostic[] | Promise<OutlineDiagnostic[]>;
  /** A finding a person ignored on the resumed checkpoint: it never pauses the run. */
  isIgnoredIssue?: (issue: OutlineDiagnostic) => boolean;
  /**
   * g5.v7 / g5.v8: the book units the Lesson Template requires. An outline
   * answer citing fewer than half of them is a broken answer (re-rolled once),
   * not a coverage gap. Absent → only the structural answer check applies.
   */
  requiredBookUnitIds?: readonly string[];
  /**
   * Lesson 306 (F-1): receives a capped copy of every outline answer that
   * needed an actual JSON repair, could not be parsed, or was refused as
   * broken — so the evidence survives a re-roll, a pause and a failure alike.
   * A failure here is logged and never changes the run.
   */
  onOutlineAnswer?: (capture: OutlineAnswerCapture) => void | Promise<void>;
  /**
   * P1 (package-planner-issue-resolve-plan-2026-11-22 §3b step 1): the free
   * rule fixes (no model call) run on the blocking candidate FIRST, before
   * `repairOutlines`. Returns the re-diagnosed candidate, or `null` when
   * nothing was changed. The caller records each fix.
   */
  autoFixOutlines?: (
    outlines: SceneOutline[],
    blocking: OutlineDiagnostic[],
  ) =>
    | { outlines: SceneOutline[]; blocking: OutlineDiagnostic[] }
    | null
    | Promise<{ outlines: SceneOutline[]; blocking: OutlineDiagnostic[] } | null>;
  /**
   * g5.v7 (P-6): given the blocking findings, re-plan what the plan left out
   * with the outline model and return the re-diagnosed candidate, or `null` to
   * pause unchanged. Called once, before the run pauses for a person. Since 22
   * Nov 2026 it runs after `autoFixOutlines`, and its own precondition keeps it
   * off while a stage or order issue is open (`BOOK_REPAIR_BLOCKING_CODES`).
   */
  repairOutlines?: (
    outlines: SceneOutline[],
    blocking: OutlineDiagnostic[],
    aiCall: AICallFn,
  ) => Promise<{ outlines: SceneOutline[]; blocking: OutlineDiagnostic[] } | null>;
  /**
   * P2 (package-planner-issue-resolve-plan-2026-11-22 §3b step 2, owner 22 Nov
   * 2026): the AI plan review layer, after the rule fixes and the book repair,
   * on what is still open. It is handed `outlineAiCall`, so it runs on the
   * planning route. Returns the re-diagnosed candidate, or `null` when no round
   * was kept. The caller records each fix.
   */
  reviewPlan?: (
    outlines: SceneOutline[],
    blocking: OutlineDiagnostic[],
    aiCall: AICallFn,
  ) => Promise<{ outlines: SceneOutline[]; blocking: OutlineDiagnostic[] } | null>;
  /**
   * g5.v12 (critical items 27 Nov 2026, EN-4): decides whether the planner is asked
   * again. Called once, with the first answer's outlines, before that plan costs an
   * image re-plan or a review. Returns the violations no deterministic fix repairs —
   * each is shown to the planner on the same routed outline call, once per run — or
   * `null` / nothing to keep the first answer. Never called on a resumed run (it makes
   * no outline call). A hook that throws changes nothing: the first answer stands.
   */
  reaskPlan?: (
    outlines: SceneOutline[],
  ) => Promise<OutlineDiagnostic[] | null> | OutlineDiagnostic[] | null;
  /**
   * Lesson 2-5 (17 Nov 2026, g5.v11): once the plan passed the gates (nothing blocks),
   * one more planning step that never pauses: a book example with no slide of its own
   * before its check is planned once; the refined plan, or `null` to keep it as it is.
   */
  refineOutlines?: (outlines: SceneOutline[], aiCall: AICallFn) => Promise<SceneOutline[] | null>;
  /**
   * The final plan, cleaned of planner-only text before any Scene is generated
   * (e.g. Content Unit id labels a key point copied from the exercises block).
   * Runs after the correction checkpoint, on fresh and resumed runs alike.
   */
  finalizeOutlines?: (outlines: SceneOutline[]) => SceneOutline[];
  /**
   * Resume from a saved, administrator-corrected outline candidate: no
   * research and no outline generation; the candidate is revalidated with the
   * same analysis before anything is reserved.
   */
  resumeOutlines?: {
    outlines: SceneOutline[];
    courseTitle: string | null;
    languageDirective: string;
  };
  /**
   * Resume a `scenes` checkpoint: the retained (unbound) Stage keeps every
   * valid Scene; only the listed outlines' Scenes (and any outline without a
   * Scene) are generated again, with their own media and narration audio, and
   * the same Stage id is persisted again.
   */
  resumeScenes?: {
    stageId: string;
    stage: Stage;
    scenes: Scene[];
    regenerateOutlineIds: readonly string[];
    sourceServingMapping: Record<string, string>;
    sourceManifest: SourceVisualManifestEntry[];
  };
}

/** The agents a retained Stage was generated with (resume of a `scenes` checkpoint). */
function agentsFromStage(stage: Stage): AgentInfo[] {
  const configs = (stage as { generatedAgentConfigs?: Array<Record<string, unknown>> })
    .generatedAgentConfigs;
  if (!Array.isArray(configs) || configs.length === 0) return getDefaultAgents();
  return configs.map((config) => ({
    id: String(config.id),
    name: String(config.name ?? ''),
    role: String(config.role ?? 'assistant'),
    persona: String(config.persona ?? ''),
  }));
}

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
    /** Pause-for-correction and resume support; absent → unchanged behaviour. */
    correction?: GenerationCorrectionOptions;
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

  // Subject routing (Kafuo R1 plan §7.4). `routed` is the single predicate:
  // when set, the teaching stages below never touch `resolveModel`,
  // `getStageModel` or `callLLM` directly — the executor owns the provider
  // call, the fallback and the ledger row. The policy without its attribution
  // is a caller defect: a ledger row must be attributable (contracts §7).
  if (input.modelPolicy && !input.attribution) {
    throw new Error('generateClassroom: modelPolicy requires attribution for the ledger');
  }
  const routed =
    input.modelPolicy && input.attribution
      ? {
          policy: input.modelPolicy,
          planPolicy: input.planPolicy ?? input.modelPolicy,
          attribution: input.attribution,
        }
      : null;

  // The base ("generate-classroom") model still serves the non-teaching
  // utilities of a routed run (web-search query rewrite, the PBL loop
  // planner), so it is resolved either way — but a routed run must not fail
  // on a missing DEFAULT_MODEL when the policy alone can carry the lesson.
  let base: Awaited<ReturnType<typeof resolveModel>> | null = null;
  try {
    base = await resolveModel({ stage: 'generate-classroom' });
  } catch (error) {
    if (!routed) throw error;
    log.warn(
      'No base model resolved for a subject-routed run; utilities use the subject primary',
      error,
    );
  }
  const languageModel: LanguageModel = base?.model ?? routed!.policy.primary.model;
  const modelInfo: ModelInfo | null | undefined = base
    ? base.modelInfo
    : routed?.policy.primary.modelInfo;
  const classroomThinking: ThinkingConfig | undefined =
    base?.thinkingConfig ?? routed?.policy.primary.thinking;
  if (base) {
    log.info(`Using server-configured model: ${base.modelString}`);
    // Fail fast if the resolved provider has no API key configured
    if (isProviderKeyRequired(base.providerId) && !base.apiKey) {
      throw new Error(
        `No API key configured for provider "${base.providerId}". ` +
          `Set the appropriate key in .env.local or server-providers.yml (e.g. ${base.providerId.toUpperCase()}_API_KEY).`,
      );
    }
  }
  if (routed) {
    log.info(
      `Subject route ${routed.policy.subjectCode} (${routed.policy.policyVersion}): ${routed.policy.primary.modelString} → ${routed.policy.fallback.modelString}`,
    );
    if (routed.planPolicy !== routed.policy) {
      log.info(
        `Planning route ${routed.planPolicy.subjectCode} (${routed.planPolicy.policyVersion}): ${routed.planPolicy.primary.modelString} → ${routed.planPolicy.fallback.modelString}`,
      );
    }
  }

  // The routed teaching call (plan §7.3): one executor invocation per AICallFn
  // call, keyed by stage. Prompts are handed over exactly as the unrouted path
  // sends them (system + user messages; source visuals through the same
  // `buildVisionUserContent`), so validators and output windows are
  // unchanged. `images` is passed explicitly so the executor plans
  // `primary_lacks_vision` (AMB-08) before any call.
  //
  // A `TeachingModelUnavailableError` means Primary AND Fallback failed for
  // this call. It is remembered here and re-raised at the pipeline's next
  // checkpoint (`assertRouteAvailable`), because the generators swallow call
  // errors into `null` / `success: false` / fallback Actions and would
  // otherwise re-roll the CALL — the plan re-rolls the RUN, in the runner.
  let routeFailure: TeachingModelUnavailableError | null = null;
  // 3 Oct 2026: while ONE governed slide/quiz is being generated, a NON-retryable
  // refusal (safety_refused / request_rejected) is that scene's problem, not the
  // run's — it is collected here instead of poisoning `routeFailure`, the scene
  // keeps a marked placeholder / default narration, and the run continues. A
  // retryable failure (the route is down) still fails the run as before.
  let sceneRefusalScope: { refusals: TeachingModelUnavailableError[] } | null = null;
  // Scene content is prefetched concurrently (see `SCENE_CONTENT_CONCURRENCY`), so a
  // content call cannot read the one shared `sceneRefusalScope`: it would record its
  // refusal on whichever Scene the loop happens to be on. Each prefetched content call
  // runs inside its own Scene's scope here; the loop's serial action calls still use
  // `sceneRefusalScope`.
  // `scope: null` is an explicit "no Scene scope" (a refusal then fails the run), so a
  // prefetched call never falls through to the loop's scope for a different Scene.
  // `sceneId` (S5.5 / S8-O1): the Scene a prefetched content call writes, carried in the
  // same per-Scene store for the same reason as its refusal scope.
  const contentRefusalScopes = new AsyncLocalStorage<{
    scope: { refusals: TeachingModelUnavailableError[] } | null;
    sceneId: string | null;
  }>();
  // S5.5 / S8-O1 (model per slide): each outline's Scene id is minted before its first
  // model call, so every ledger row of that Scene names it; `createSceneWithActions`
  // creates the Scene under the same id. The loop's serial calls (narration, a native
  // re-generation) name theirs through `loopSceneId`, set and cleared beside
  // `sceneRefusalScope`. Lesson-level calls (outline, plan review, agent profiles, the
  // web-search rewrite) keep `scene_id` NULL by design.
  // Keyed by the outline's POSITION in the plan, never by `outline.id`: the model writes
  // those ids and two outlines may share one, and each must still get its own Scene.
  const plannedSceneIds = new Map<number, string>();
  const plannedSceneIdOf = (outlineIndex: number): string => {
    let sceneId = plannedSceneIds.get(outlineIndex);
    if (!sceneId) {
      sceneId = generateId('scene');
      plannedSceneIds.set(outlineIndex, sceneId);
    }
    return sceneId;
  };
  let loopSceneId: string | null = null;
  const teachingContext = (stage: string): TeachingCallContext => {
    const holder = contentRefusalScopes.getStore();
    const sceneId = holder ? holder.sceneId : loopSceneId;
    return {
      tenantId: routed!.attribution.tenantId,
      capability: 'package_generation',
      stage,
      origin: 'openmaic_runtime',
      association: {
        kind: 'generation',
        generationAttemptId: routed!.attribution.generationAttemptId,
        generationRun: routed!.attribution.generationRun,
        versionId: null,
        learningItemType: routed!.attribution.learningItemType,
        learningItemId: routed!.attribution.learningItemId,
        ...(sceneId ? { sceneId } : {}),
      },
    };
  };
  const routedCall = async (
    stage: string,
    systemPrompt: string,
    userPrompt: string,
    images?: Array<{ id: string; src: string; width?: number; height?: number }>,
    // §3c: the planning calls pass `routed.planPolicy`; every other stage the generation policy.
    policy: ResolvedSubjectPolicy = routed!.policy,
  ): Promise<string> => {
    const withImages = images !== undefined && images.length > 0;
    try {
      const result = await executeTeachingCall(
        policy,
        teachingContext(stage),
        {
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: withImages
                ? (buildVisionUserContent(userPrompt, images) as never)
                : userPrompt,
            },
          ],
        },
        routedCallOptions(stage, withImages ? images : undefined),
      );
      return result.text;
    } catch (error) {
      if (error instanceof TeachingModelUnavailableError) {
        const holder = contentRefusalScopes.getStore();
        const refusalScope = holder ? holder.scope : sceneRefusalScope;
        if (!error.retryable && refusalScope) refusalScope.refusals.push(error);
        else routeFailure ??= error;
        // The generation package's retry helper reads `isRetryable` first:
        // the executor already spent the whole route, so a per-call retry
        // would only add attempts the run is going to discard.
        Object.assign(error, { isRetryable: false });
      }
      throw error;
    }
  };
  const assertRouteAvailable = (): void => {
    if (routeFailure) throw routeFailure;
  };

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    if (routed) return routedCall('generate-classroom', systemPrompt, userPrompt);
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
  // Not consulted on a subject-routed run: the policy is the only input.
  const outlineRoute = routed ? undefined : getStageModel('scene-outlines-stream');
  if (outlineRoute) {
    const resolved = await resolveModel({ stage: 'scene-outlines-stream' });
    outlineModel = resolved.model;
    outlineOutputWindow = resolved.modelInfo?.outputWindow;
    outlineThinking = resolved.thinkingConfig;
    outlineModelInfo = resolved.modelInfo;
    log.info(`Stage "scene-outlines-stream" routed to model: ${resolved.modelString}`);
  }
  const outlineAiCall: AICallFn = async (systemPrompt, userPrompt, images) => {
    // Routed: the executor plans the vision-capable target itself (AMB-08).
    // The planning and review route (§3c): the outline call itself and every
    // call made through `outlineAiCall` — `correction.repairOutlines`,
    // `correction.refineOutlines` and the plan review layer.
    if (routed) {
      return routedCall(
        'scene-outlines-stream',
        systemPrompt,
        userPrompt,
        images,
        routed.planPolicy,
      );
    }
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
    if (routed) {
      // Subject-routed: the composite stage label is the ledger `stage`
      // (`scene-content:slide` covers slide assistance too — it is the same
      // AICallFn); no stage route is consulted. The PBL loop planner keeps
      // the base model: it is not a Kafuo teaching stage (plan §7.2).
      const aiCall: AICallFn = (systemPrompt, userPrompt, images) =>
        routedCall(stage, systemPrompt, userPrompt, images);
      return { aiCall, model: languageModel, thinking: classroomThinking };
    }
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
    if (routed) {
      agentProfilesAiCall = (systemPrompt, userPrompt) =>
        routedCall('agent-profiles', systemPrompt, userPrompt);
      return agentProfilesAiCall;
    }
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
    if (routed) {
      sceneActionsAiCall = (systemPrompt, userPrompt) =>
        routedCall('scene-actions', systemPrompt, userPrompt);
      return sceneActionsAiCall;
    }
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

  const correction = options.correction;
  const resumeOutlines = correction?.resumeOutlines;
  const resumeScenes = correction?.resumeScenes;

  // Web search (optional, graceful degradation). A resumed run re-uses its
  // saved outline candidate, which is the only consumer of research context.
  let researchContext: string | undefined;
  if (input.enableWebSearch && !resumeOutlines) {
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

  // Bounded re-roll on the outline gate (RSS 7.2.3): a plan rejected for slide
  // classification or runtime-scene config is a bad model answer, re-rolled with
  // the issues as corrective context — never repaired or converted here. Typed
  // planning conflicts throw straight through. The Kafuo run-level retry stays
  // the outer safety net.
  const outlineLanguage = input.language?.trim() || undefined;
  const outlineTextDirection = resolveTextDirection(outlineLanguage);
  // The spoken-language register is server policy, derived ONCE from the
  // authoritative language and subject code — never from generated text, and
  // never the outline model's choice.
  const registerPolicy = resolveSpeechRegisterPolicy({
    language: input.language,
    subjectCode: input.subjectCode,
  });
  // The shared TTS-ready spoken-script + signposting policy, from the same
  // authoritative inputs (absent → Action prompts render exactly as before).
  const spokenScript = resolveSpokenScriptOptions(input.language, registerPolicy);
  // Quran and hadith (Q-4, S-9): the fixed policy and the protected quotes for
  // every learner-text prompt (`full`), or only the one short line (`short`);
  // absent → every prompt renders exactly as before.
  const sacredPrompt = input.sacredText
    ? {
        quotes: sacredQuotesForPrompt(input.sacredText.quotes),
        ...(input.sacredText.mode ? { mode: input.sacredText.mode } : {}),
      }
    : undefined;
  let courseTitle: string | undefined;
  let outlines: SceneOutline[];
  let modelLanguageDirective: string;
  // Admin-correctable findings of the final candidate, and the metadata repairs
  // applied to it (only ever non-empty for a run that supports correction).
  let outlineBlocking: OutlineDiagnostic[] = [];
  let outlineRepairs: OutlineDiagnostic[] = [];
  if (resumeOutlines) {
    // Resumed from an administrator-corrected checkpoint: NO outline call. The
    // saved candidate is revalidated with the same analysis the run uses.
    const analysis = analyzeOutlines(resumeOutlines.outlines, {
      ...(input.teachingFlow !== undefined && input.teachingFlow.length > 0
        ? { teachingFlow: input.teachingFlow }
        : {}),
      sourceImages: sourceImages ?? [],
      ...(input.prohibitedWidgetTypes?.length
        ? { prohibitedWidgetTypes: input.prohibitedWidgetTypes }
        : {}),
      ...(input.keyedQuizzesOnly ? { keyedQuizzesOnly: true } : {}),
      ...(input.learnerFirstVisuals ? { learnerFirstVisuals: input.learnerFirstVisuals } : {}),
    });
    outlines = analysis.outlines;
    outlineRepairs = analysis.repairs;
    outlineBlocking = blockingOutlineDiagnostics(analysis);
    courseTitle = resumeOutlines.courseTitle ?? undefined;
    modelLanguageDirective = resumeOutlines.languageDirective;
  } else {
    let outlinesResult:
      | Awaited<ReturnType<typeof generateSceneOutlinesFromRequirements>>
      | undefined;
    let correctiveContext: string | undefined;
    const maxOutlineGateAttempts = input.governed ? 1 : MAX_OUTLINE_GATE_ATTEMPTS;
    // Lesson 306 (F-1/F-3): a run that can pause for a person refuses a
    // structurally broken outline answer as a bad model answer, re-rolls it ONCE
    // per run on the same routed call (same stage, attempt and run), and keeps a
    // capped copy of every answer that needed a repair or was refused.
    const checkAnswers = Boolean(correction);
    let badAnswerRerollUsed = false;
    // The empty-plan re-plan below is one extra outline call too (g5.v12 EN-4 bound).
    let emptyPlanReplanned = false;
    let lastOutlineAnswer = '';
    const recordingOutlineCall: AICallFn = async (systemPrompt, userPrompt, images) => {
      lastOutlineAnswer = await outlineAiCall(systemPrompt, userPrompt, images);
      return lastOutlineAnswer;
    };
    // F-1: an answer that needed an actual JSON repair, could not be parsed,
    // or was refused is logged (method, size, verdict — never the text) and
    // its capped raw copy handed to the run's diagnosis store.
    const noteOutlineAnswer = async (result: NonNullable<typeof outlinesResult>) => {
      const report = result.answer;
      if (!report || (report.parse?.repair === 'none' && report.malformed.length === 0)) return;
      const capture = captureOutlineAnswer(lastOutlineAnswer, report);
      log.warn(
        `Outline answer ${report.malformed.length > 0 ? 'refused' : 'repaired'} (read as ${
          report.parse ? `${report.parse.extraction}/${report.parse.repair}` : 'unparsed'
        }; ${capture.rawLength} chars)${
          report.malformed.length > 0 ? `: ${report.malformed.join('; ')}` : ''
        }`,
      );
      try {
        await correction?.onOutlineAnswer?.(capture);
      } catch (error) {
        // Diagnosis must never change the run's outcome.
        log.warn('Could not store the outline answer diagnosis:', error);
      }
    };
    const callOutlines = (aiCallForOutline: AICallFn, rejectMalformedAnswer: boolean) =>
      generateSceneOutlinesFromRequirements(
        requirements,
        pdfText,
        hasSourceVisuals ? sourceImages : undefined,
        aiCallForOutline,
        {
          logger: log,
          ...(rejectMalformedAnswer ? { rejectMalformedAnswer: true } : {}),
          ...(rejectMalformedAnswer && correction?.requiredBookUnitIds?.length
            ? { requiredSourceUnitIds: correction.requiredBookUnitIds }
            : {}),
          imageGenerationEnabled: input.enableImageGeneration,
          videoGenerationEnabled: input.enableVideoGeneration,
          researchContext,
          // NO teacherContext — agents haven't been generated yet
          ...(hasSourceVisuals ? { imageMapping: sourceImageMapping, visionEnabled: true } : {}),
          ...(input.teachingFlow !== undefined && input.teachingFlow.length > 0
            ? { teachingFlow: input.teachingFlow }
            : {}),
          ...(input.normalizedGrounding ? { normalizedGrounding: true } : {}),
          ...(input.prohibitedWidgetTypes?.length
            ? { prohibitedWidgetTypes: input.prohibitedWidgetTypes }
            : {}),
          ...(input.keyedQuizzesOnly ? { keyedQuizzesOnly: true } : {}),
          ...(input.learnerFirstVisuals ? { learnerFirstVisuals: input.learnerFirstVisuals } : {}),
          // W1: the outline contract boolean DERIVES from the single governed-mode
          // predicate — no second discriminator exists anywhere in the pipeline.
          ...(input.governed ? { skillPolicy: true } : {}),
          ...(correctiveContext ? { correctiveContext } : {}),
          // Authoritative lesson language → embedded-text policy for planned
          // images (RTL lessons get text-free images with native labels).
          ...(outlineLanguage ? { language: outlineLanguage } : {}),
          ...(outlineTextDirection ? { textDirection: outlineTextDirection } : {}),
          ...(registerPolicy ? { authoritativeLanguageDirective: registerPolicy.directive } : {}),
          ...(sacredPrompt ? { sacredText: sacredPrompt } : {}),
          // A run that can pause for a person receives admin-correctable
          // findings as diagnostics instead of a failed answer.
          ...(correction ? { collectCorrectableIssues: true } : {}),
        },
      );
    for (let attempt = 1; attempt <= maxOutlineGateAttempts; attempt += 1) {
      outlinesResult = await callOutlines(recordingOutlineCall, checkAnswers);

      // A routed call whose both targets failed is not a bad answer to re-roll.
      assertRouteAvailable();
      await noteOutlineAnswer(outlinesResult);
      if (outlinesResult.badAnswer && !badAnswerRerollUsed) {
        // F-3: the same prompt again, once per run — before any visual re-plan,
        // book-coverage repair or pause could spend calls on a broken plan.
        badAnswerRerollUsed = true;
        log.warn(
          `Outline attempt ${attempt}/${maxOutlineGateAttempts}: bad model answer (${outlinesResult.badAnswer.code}); re-rolling the outline call once`,
        );
        await options.onProgress?.({
          step: 'generating_outlines',
          progress: 15,
          message: 'Generating scene outlines again: the first plan was not usable',
          scenesGenerated: 0,
        });
        outlinesResult = await callOutlines(recordingOutlineCall, checkAnswers);
        assertRouteAvailable();
        await noteOutlineAnswer(outlinesResult);
      }
      if (outlinesResult.badAnswer) {
        // Still broken after the one re-roll: today's behaviour, from THIS
        // answer — read through the unchecked path again, with no model call.
        log.warn(
          `Outline answer still not usable after the re-roll (${outlinesResult.badAnswer.code}); continuing with today's handling`,
        );
        const lastAnswer = lastOutlineAnswer;
        outlinesResult = await callOutlines(async () => lastAnswer, false);
      }
      const rejection = outlinesResult.success ? undefined : outlinesResult.error;
      // Collected findings get the SAME bounded re-roll a rejection always got;
      // only the last answer's findings reach a person.
      const collected = outlinesResult.success
        ? (outlinesResult.data?.diagnostics ?? []).filter(
            (diagnostic) => diagnostic.disposition === 'admin_correctable',
          )
        : [];
      if (collected.length > 0 && attempt < maxOutlineGateAttempts) {
        correctiveContext = formatBlockingOutlineDiagnostics(collected, OUTLINE_CORRECTION_PREFIX);
        log.warn(
          `Outline attempt ${attempt}/${maxOutlineGateAttempts} needs correction: ${correctiveContext}`,
        );
        continue;
      }
      if (!rejection || !OUTLINE_GATE_ERROR.test(rejection)) break;
      log.warn(`Outline attempt ${attempt}/${maxOutlineGateAttempts} rejected: ${rejection}`);
      correctiveContext = rejection;
    }

    // P1 (package-planner-issue-resolve-plan-2026-11-22 §3b step 1, owner 22 Nov
    // 2026: "NO_OUTLINES → re-plan once"): an empty plan for an authoritative flow
    // comes back from the outline generator as a failure
    // (`OUTLINE_TEACHING_FLOW_INVALID: no outlines were returned …`), which fails
    // this run. It is re-planned ONCE first, on the same routed outline call (the
    // planning route). A governed run is single-shot (`maxOutlineGateAttempts = 1`),
    // so this is one deliberate extra outline call; an ungoverned run already
    // re-rolled it in the loop above, and a plan the bad-answer re-roll already
    // re-asked is not asked a third time. A second empty plan fails as before.
    if (
      correction &&
      maxOutlineGateAttempts === 1 &&
      !badAnswerRerollUsed &&
      outlinesResult &&
      !outlinesResult.success &&
      EMPTY_PLAN_ERROR.test(outlinesResult.error ?? '')
    ) {
      log.warn('The outline call returned no slides; re-planning once');
      emptyPlanReplanned = true;
      await options.onProgress?.({
        step: 'generating_outlines',
        progress: 15,
        message: 'Generating scene outlines again: the first plan had no slides',
        scenesGenerated: 0,
      });
      outlinesResult = await callOutlines(recordingOutlineCall, checkAnswers);
      assertRouteAvailable();
      await noteOutlineAnswer(outlinesResult);
      if (outlinesResult.badAnswer) {
        // The same handling as a bad answer after the re-roll: read this answer
        // through the unchecked path, with no further model call.
        const lastAnswer = lastOutlineAnswer;
        outlinesResult = await callOutlines(async () => lastAnswer, false);
      }
    }

    // g5.v12 (EN-4, critical items 27 Nov 2026): ONE bounded re-ask of the planner with
    // the violations no deterministic fix repairs (the caller decides, from the fixes
    // that need no model), before the first plan costs an image re-plan or a review.
    // `MAX_GENERATION_RUNS` is not touched: this is the same run. A second answer that
    // still violates goes through every gate below and fails closed, as the first would.
    // Never on top of the bad-answer re-roll or the empty-plan re-plan: the run has had
    // its one extra outline call then (wave 1 review, M3).
    if (
      correction?.reaskPlan &&
      !badAnswerRerollUsed &&
      !emptyPlanReplanned &&
      outlinesResult?.success &&
      outlinesResult.data
    ) {
      let violations: OutlineDiagnostic[] | null = null;
      try {
        violations = await correction.reaskPlan(outlinesResult.data.outlines);
      } catch (error) {
        log.warn('Could not decide whether to ask the planner again:', error);
      }
      if (violations && violations.length > 0) {
        // The re-ask never fails a run: the first answer is kept until the second proves usable.
        const firstAnswer = outlinesResult;
        correctiveContext = formatBlockingOutlineDiagnostics(violations, OUTLINE_CORRECTION_PREFIX);
        log.warn(
          `Outline answer breaks ${violations.length} rule(s) no deterministic fix repairs; asking the planner once more`,
        );
        await options.onProgress?.({
          step: 'generating_outlines',
          progress: 15,
          message: 'Generating scene outlines again: the first plan broke the lesson’s book rules',
          scenesGenerated: 0,
        });
        outlinesResult = await callOutlines(recordingOutlineCall, checkAnswers);
        assertRouteAvailable();
        await noteOutlineAnswer(outlinesResult);
        // A second answer that is broken, or yields no plan at all, gives the first one
        // back: it goes through every gate below and fails closed there if it still
        // violates (review 27 Nov 2026, LOW; wave 1 review M3: a broken second answer is
        // never read unchecked over a good first one) — the re-ask never turns a pausing
        // plan into a failed run.
        if (outlinesResult.badAnswer || !outlinesResult?.success || !outlinesResult.data) {
          log.warn(
            'The planner’s second answer gave no usable plan; the first plan stands and goes through every gate',
          );
          outlinesResult = firstAnswer;
        }
      }
    }

    if (!outlinesResult?.success || !outlinesResult.data) {
      log.error('Failed to generate outlines:', outlinesResult?.error);
      throw new Error(outlinesResult?.error || 'Failed to generate scene outlines');
    }

    ({ courseTitle, outlines } = outlinesResult.data);
    modelLanguageDirective = outlinesResult.data.languageDirective;
    const diagnostics = outlinesResult.data.diagnostics ?? [];
    outlineRepairs = diagnostics.filter((diagnostic) => diagnostic.disposition === 'repaired');
    outlineBlocking = diagnostics.filter(
      (diagnostic) => diagnostic.disposition === 'admin_correctable',
    );
  }
  // Under a register policy the directive is the server's, whatever the
  // outline answered; it is what the Stage persists and every prompt receives.
  const languageDirective = registerPolicy?.directive ?? modelLanguageDirective;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  // Slide image plan (D-1/D-4): every image a slide shows comes from its
  // planner with its own teaching note. A slide whose visual finding the planner
  // can fix — or whose chosen image the outline call could not see — is
  // re-planned ALONE with its linked images attached, before any pause for a
  // person. A resumed checkpoint passes through the same step, so an older
  // candidate without notes is completed here rather than stuck. A `scenes`
  // checkpoint already built its slides from its outlines and is never re-planned.
  if (input.teachingFlow !== undefined && input.teachingFlow.length > 0 && !resumeScenes) {
    const flow = input.teachingFlow;
    const analyze = (candidates: SceneOutline[]) =>
      analyzeOutlines(candidates, {
        teachingFlow: flow,
        sourceImages: sourceImages ?? [],
        ...(input.prohibitedWidgetTypes?.length
          ? { prohibitedWidgetTypes: input.prohibitedWidgetTypes }
          : {}),
        ...(input.keyedQuizzesOnly ? { keyedQuizzesOnly: true } : {}),
        ...(input.learnerFirstVisuals ? { learnerFirstVisuals: input.learnerFirstVisuals } : {}),
      });
    const reasonsById = new Map<string, string[]>();
    // Outlines whose image SELECTION is in question (not only its notes).
    const reselect = new Set<string>();
    const addReason = (outlineId: string, reason: string) =>
      reasonsById.set(outlineId, [...(reasonsById.get(outlineId) ?? []), reason]);
    for (const diagnostic of outlineBlocking) {
      // A visual issue a person ignored is left as it is: no re-plan call.
      if (correction?.isIgnoredIssue?.(diagnostic)) continue;
      if (diagnostic.outlineId && VISUAL_REPLAN_CODES.has(diagnostic.code)) {
        addReason(diagnostic.outlineId, diagnostic.message);
        if (diagnostic.code !== 'VISUAL_TEACHING_NOTE_MISSING') reselect.add(diagnostic.outlineId);
      }
    }
    // g5.v8 (I-4.3): a split unit's image stays on the slide it illustrates;
    // every other slide of that unit showing it is re-planned without it.
    const withoutImages = new Map<string, Set<string>>();
    const duplicates =
      !resumeOutlines && hasSourceVisuals && input.findDuplicateSourceVisuals
        ? input.findDuplicateSourceVisuals(outlines, sourceImages ?? [])
        : [];
    for (const duplicate of duplicates) {
      addReason(
        duplicate.outlineId,
        `the textbook image ${duplicate.imageId} is shown on the slide it illustrates (${duplicate.keptOnOutlineId}); this slide teaches another part of the same unit, so do not show ${duplicate.imageId} here: plan a native diagram of this slide's own content (or another listed image)`,
      );
      reselect.add(duplicate.outlineId);
      const excluded = withoutImages.get(duplicate.outlineId) ?? new Set<string>();
      excluded.add(duplicate.imageId);
      withoutImages.set(duplicate.outlineId, excluded);
    }
    if (!resumeOutlines && hasSourceVisuals) {
      const seen = new Set(
        sortDocumentImagesForVision([...sourceImages!])
          .slice(0, MAX_VISION_IMAGES)
          .map((image) => image.id),
      );
      for (const outline of outlines) {
        const unseen = (outline.suggestedImageIds ?? []).filter((id) => !seen.has(id));
        if (outline.type === 'slide' && outline.id && unseen.length > 0) {
          addReason(
            outline.id,
            `the image(s) ${unseen.join(', ')} were not visible when this slide was planned; look at the attached image(s) and write each note from what it shows`,
          );
          reselect.add(outline.id);
        }
      }
    }
    // g5.v8 (I-4.3): each image of a unit taught over several slides has ONE
    // keeper, decided here before any re-plan — the slide it illustrates best,
    // never whichever slide is re-planned first. Once the keeper shows it, no
    // other slide of the unit is offered it; a keeper lacking it is re-planned
    // (first) when a sibling would otherwise have been offered it, so the image
    // is not lost. When nothing tells the slides apart (no image text to
    // match), every re-planned slide of the unit is offered the image and the
    // slides that took it are settled afterwards on the notes they wrote from it.
    const keptElsewhere = new Map<string, Map<string, string>>();
    const keeperIds = new Set<string>();
    const openImages = new Map<string, Set<string>>();
    if (!resumeOutlines && hasSourceVisuals && input.findDuplicateSourceVisuals) {
      const decided = new Map<string, Set<string>>();
      for (const duplicate of duplicates) {
        const kept = decided.get(duplicate.imageId) ?? new Set<string>();
        kept.add(duplicate.keptOnOutlineId);
        decided.set(duplicate.imageId, kept);
      }
      const keepers = chooseSplitUnitImageKeepers(outlines, sourceImages ?? [], {
        decided,
        keepsImage: (outline, imageId) =>
          !reselect.has(outline.id) && !withoutImages.get(outline.id)?.has(imageId),
      });
      for (const { imageId, keeperId, otherIds, decisive } of keepers) {
        if (!decisive) {
          openImages.set(
            imageId,
            new Set([...(openImages.get(imageId) ?? []), keeperId, ...otherIds]),
          );
          continue;
        }
        keeperIds.add(keeperId);
        for (const otherId of otherIds) {
          if (withoutImages.get(otherId)?.has(imageId)) continue;
          const kept = keptElsewhere.get(otherId) ?? new Map<string, string>();
          kept.set(imageId, keeperId);
          keptElsewhere.set(otherId, kept);
        }
        const keeper = outlines.find((outline) => outline.id === keeperId);
        if (
          keeper &&
          !(keeper.suggestedImageIds ?? []).includes(imageId) &&
          !reasonsById.has(keeperId) &&
          otherIds.some((id) => reselect.has(id))
        ) {
          addReason(
            keeperId,
            `the textbook image ${imageId} illustrates this slide best among the slides of its unit; show ${imageId} here (visualPlan.mode "image") and write its note from what it shows`,
          );
          reselect.add(keeperId);
        }
      }
    }
    if (reasonsById.size > 0) {
      const { aiCall: replanAiCall } = await resolveSceneContentCall('slide');
      let current = outlines;
      // Keepers first (g5.v8), so a sibling's check already sees the image shown.
      const replanOrder = [...reasonsById.keys()];
      const orderedIds = [
        ...replanOrder.filter((id) => keeperIds.has(id)),
        ...replanOrder.filter((id) => !keeperIds.has(id)),
      ];
      const replannedIds = new Set<string>();
      const replanOne = async (outlineId: string, reasons: readonly string[]) => {
        const index = current.findIndex((outline) => outline.id === outlineId);
        const outline = current[index];
        if (!outline) return;
        // Only the notes are missing (e.g. an administrator chose the images,
        // D-3): the re-plan keeps exactly the selected images and writes their
        // notes. Otherwise it re-chooses among the slide's linked images.
        const selected = outline.suggestedImageIds ?? [];
        const keepSelection = !reselect.has(outlineId) && selected.length > 0;
        const unitIds = new Set(outline.sourceContentUnitIds ?? []);
        let excluded = withoutImages.get(outlineId);
        // g5.v8 (I-4.3): the image's keeper already shows it — or is still to
        // be re-planned to show it (another keeper of the unit went first) —
        // so it is not offered here. A keeper that re-planned without taking it
        // leaves it to the rule below.
        const kept = [...(keptElsewhere.get(outlineId) ?? [])];
        const keptOnKeeper = kept.filter(([id, keeperId]) =>
          current.some(
            (entry) => entry.id === keeperId && (entry.suggestedImageIds ?? []).includes(id),
          ),
        );
        const keptForKeeper = kept.filter(
          ([id, keeperId]) =>
            !keptOnKeeper.some(([shown]) => shown === id) &&
            reasonsById.has(keeperId) &&
            !replannedIds.has(keeperId),
        );
        if (keptOnKeeper.length > 0 || keptForKeeper.length > 0) {
          excluded = new Set([
            ...(excluded ?? []),
            ...keptOnKeeper.map(([id]) => id),
            ...keptForKeeper.map(([id]) => id),
          ]);
        }
        // g5.v8 (I-4.3): an image another slide of the same unit already shows
        // (and keeps) is never offered again, so a re-plan cannot re-add it to
        // every slide of a split unit (lesson 306's check 4028).
        const shownOnUnit = new Map<string, string>();
        if (input.findDuplicateSourceVisuals && !keepSelection) {
          current.forEach((entry, at) => {
            if (at === index || entry.type !== 'slide' || !entry.id) return;
            if (!(entry.sourceContentUnitIds ?? []).some((id) => unitIds.has(id))) return;
            for (const id of entry.suggestedImageIds ?? []) {
              if (
                !withoutImages.get(entry.id)?.has(id) &&
                !keptElsewhere.get(entry.id)?.has(id) &&
                !openImages.has(id) &&
                !shownOnUnit.has(id)
              ) {
                shownOnUnit.set(id, entry.id);
              }
            }
          });
          if (shownOnUnit.size > 0) {
            excluded = new Set([...(excluded ?? []), ...shownOnUnit.keys()]);
          }
        }
        const linkedImages = keepSelection
          ? selected
              .map((id) => (sourceImages ?? []).find((image) => image.id === id))
              .filter((image): image is PdfImage => image !== undefined)
          : sortDocumentImagesForVision(
              (sourceImages ?? []).filter(
                (image) =>
                  !excluded?.has(image.id) &&
                  (image.sourceContentUnitIds ?? []).some((id) => unitIds.has(id)),
              ),
            );
        const replanned = await replanSlideVisuals({
          outline,
          linkedImages,
          ...(keepSelection ? { requiredImageIds: selected } : {}),
          imageSrc: (image) => sourceImageMapping[image.id] ?? image.src,
          sourceText: buildSceneSourceContext(outline, input.sourceUnits).sourceContextText,
          languageDirective,
          reasons: [
            ...reasons,
            ...keptOnKeeper.map(
              ([id, keptOn]) =>
                `the textbook image ${id} is already shown on ${keptOn}, the slide of this unit it illustrates best; do not show ${id} here: plan a native diagram of this slide's own content (or another listed image)`,
            ),
            ...keptForKeeper.map(
              ([id, keptOn]) =>
                `the textbook image ${id} is kept for ${keptOn}, the slide of this unit it illustrates best; do not show ${id} here: plan a native diagram of this slide's own content (or another listed image)`,
            ),
            ...[...shownOnUnit]
              .filter(
                ([id]) =>
                  !withoutImages.get(outlineId)?.has(id) && !kept.some(([keptId]) => keptId === id),
              )
              .map(
                ([id, keptOn]) =>
                  `the textbook image ${id} is already shown on ${keptOn}, another slide of this unit; do not show ${id} here: plan a native diagram of this slide's own content (or another listed image)`,
              ),
          ],
          check: (candidate) => [
            ...blockingOutlineDiagnostics(
              analyze(current.map((entry, at) => (at === index ? candidate : entry))),
            )
              .filter(
                (diagnostic) =>
                  diagnostic.outlineId === outlineId && VISUAL_REPLAN_CODES.has(diagnostic.code),
              )
              .map((diagnostic) => diagnostic.message),
            ...(candidate.suggestedImageIds ?? [])
              .filter((id) => excluded?.has(id))
              .map(
                (id) =>
                  `the textbook image ${id} belongs to another slide of this unit; do not show it here`,
              ),
          ],
          aiCall: replanAiCall,
        });
        assertRouteAvailable();
        replannedIds.add(outlineId);
        if (replanned.ok) {
          current = current.map((entry, at) => (at === index ? replanned.outline : entry));
          log.info(`Slide "${outline.title}" visual re-planned (${replanned.calls} call(s))`);
        } else {
          log.warn(
            `Slide "${outline.title}" visual re-plan failed: ${replanned.messages.join('; ')}`,
          );
        }
      };
      for (const outlineId of orderedIds) await replanOne(outlineId, reasonsById.get(outlineId)!);
      // g5.v8 (I-4.3): an image nothing could place in advance stays on the
      // slide its notes (written from the image itself) match best; every other
      // slide of the unit that took it is re-planned once more without it.
      if (openImages.size > 0 && input.findDuplicateSourceVisuals) {
        const late = new Map<string, string[]>();
        for (const duplicate of input.findDuplicateSourceVisuals(current, sourceImages ?? [])) {
          if (!openImages.get(duplicate.imageId)?.has(duplicate.outlineId)) continue;
          const excluded = withoutImages.get(duplicate.outlineId) ?? new Set<string>();
          excluded.add(duplicate.imageId);
          withoutImages.set(duplicate.outlineId, excluded);
          reselect.add(duplicate.outlineId);
          late.set(duplicate.outlineId, [
            ...(late.get(duplicate.outlineId) ?? []),
            `the textbook image ${duplicate.imageId} is already shown on ${duplicate.keptOnOutlineId}, the slide of this unit it illustrates best; do not show ${duplicate.imageId} here: plan a native diagram of this slide's own content (or another listed image)`,
          ]);
        }
        for (const [outlineId, reasons] of late) await replanOne(outlineId, reasons);
      }
      const analysis = analyze(current);
      outlines = analysis.outlines;
      outlineRepairs = [...outlineRepairs, ...analysis.repairs];
      outlineBlocking = blockingOutlineDiagnostics(analysis);
    }
  }

  // Module 2 W11: pre-resolve the exact canonical Skill definitions ONCE per
  // run (the `resolvedVisionImages` precedent — bytes settled BEFORE any scene
  // prompt assembly) so the selected Skills govern generated narration,
  // questions, feedback, pacing, and interaction. Only the governed Kafuo path
  // supplies them; the Workbench, editor-regeneration, and scene-actions call
  // sites never pass `resolvedSkills`, so their prompts stay byte-identical.
  // W1: gated on `input.governed` — the marker-only mode — never on Flow
  // presence; the governed context carries the authoritative Flow.
  const resolvedSkills = input.governed
    ? [...resolveFlowSkillPolicies(input.governed.flow).entries()].map(([, definition]) => ({
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

  // Admin-correction checkpoint (plan §3.2): still BEFORE any Stage reservation,
  // Scene, media or TTS. A candidate a person can fix pauses the run with
  // everything needed to resume — it is never compensated or failed. A resumed
  // `scenes` checkpoint already passed this point once and is not re-paused here.
  if (correction && !resumeScenes) {
    const appIssues = (await correction.collectOutlineIssues?.(outlines)) ?? [];
    const isIgnored = correction.isIgnoredIssue;
    const open = (issues: OutlineDiagnostic[]) =>
      isIgnored ? issues.filter((issue) => !isIgnored(issue)) : issues;
    let blocking = open([...outlineBlocking, ...appIssues]);
    // P1 order (package-planner-issue-resolve-plan-2026-11-22 §3b, owner 22 Nov
    // 2026): 1. the free rule fixes; 2. the book repair, which keeps itself off
    // while a stage or order issue is still open; 3. the plan review layer (P2);
    // 4. pause with what is left.
    if (blocking.length > 0 && correction.autoFixOutlines) {
      const fixed = await correction.autoFixOutlines(outlines, blocking);
      if (fixed) {
        outlines = fixed.outlines;
        blocking = open(fixed.blocking);
      }
    }
    if (blocking.length > 0 && correction.repairOutlines) {
      const repaired = await correction.repairOutlines(outlines, blocking, outlineAiCall);
      if (repaired) {
        outlines = repaired.outlines;
        blocking = open(repaired.blocking);
      }
    }
    if (blocking.length > 0 && correction.reviewPlan) {
      // A stage or order issue keeps the book repair off; when the review clears
      // them, the book gaps it could not place before are planned once more.
      const stageOrOrderOpen = (issues: OutlineDiagnostic[]) =>
        issues.some((issue) => BOOK_REPAIR_BLOCKING_CODES.has(issue.code));
      const hadStageOrOrder = stageOrOrderOpen(blocking);
      const reviewed = await correction.reviewPlan(outlines, blocking, outlineAiCall);
      // A planning route whose both targets failed during the review fails THIS
      // run here (the runner re-rolls it), before any pause or Stage reservation:
      // the review itself never rethrows a failed call.
      assertRouteAvailable();
      if (reviewed) {
        outlines = reviewed.outlines;
        blocking = open(reviewed.blocking);
        if (
          hadStageOrOrder &&
          !stageOrOrderOpen(blocking) &&
          blocking.length > 0 &&
          correction.repairOutlines
        ) {
          const repairedAgain = await correction.repairOutlines(outlines, blocking, outlineAiCall);
          assertRouteAvailable();
          if (repairedAgain) {
            outlines = repairedAgain.outlines;
            blocking = open(repairedAgain.blocking);
          }
        }
      }
    }
    if (blocking.length > 0) {
      log.warn(`Outline candidate paused for admin correction: ${blocking.length} issue(s)`);
      throw new GenerationCorrectionRequiredError({
        phase: 'outline',
        outlines,
        courseTitle: courseTitle ?? null,
        languageDirective,
        diagnostics: blocking,
        repairs: outlineRepairs,
      });
    }
    // Lesson 2-5 (17 Nov 2026): a book example taught only on a check's slides is planned
    // once before that check; one the plan cannot place is logged, never a pause.
    if (correction.refineOutlines) {
      const refined = await correction.refineOutlines(outlines, outlineAiCall);
      if (refined) outlines = refined;
    }
  }
  if (correction?.finalizeOutlines) {
    outlines = correction.finalizeOutlines(outlines);
  }
  // g5.v11 (owner, 17 Nov 2026): from here on, the slide images are the source visuals
  // plus the guide's answer drawings the engine just selected on solution outlines. The
  // planner above never saw a drawing; without any, everything below is as before.
  let guideFigures = input.guideAnswerFigures ?? [];
  // A lesson without book images never checked its slide model for vision (book images
  // fail the run without it). A drawing never does: without vision it is left out.
  if (guideFigures.length > 0 && !routed && !hasSourceVisuals) {
    const slideStage = 'scene-content:slide' as LlmStage;
    const slideModelInfo = getStageModel(slideStage)
      ? (await resolveModel({ stage: slideStage })).modelInfo
      : modelInfo;
    if (slideModelInfo?.capabilities?.vision !== true) {
      log.warn(
        "The slide model reports no vision capability; the guide's answer drawings are left out",
      );
      guideFigures = [];
    }
  }
  const guideFigureIds = new Set(guideFigures.map((figure) => figure.id));
  const slideImages =
    guideFigures.length > 0 ? [...(sourceImages ?? []), ...guideFigures] : sourceImages;
  const hasSlideImages = (slideImages?.length ?? 0) > 0;
  for (const figure of guideFigures) sourceImageMapping[figure.id] = figure.src;

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (resumeScenes) {
    // The retained Stage already names its agents; its Scenes were voiced by them.
    agents = agentsFromStage(resumeScenes.stage);
  } else if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      const agentProfilesCall = await getAgentProfilesAiCall();
      agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      // Not for a routed call whose whole route failed: that fails the run.
      assertRouteAvailable();
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  // Content language + base direction: lesson metadata from the caller,
  // resolved ONCE here. A tag the resolver cannot read yields no direction
  // (never a guess); the language is still recorded.
  const contentLanguage = input.language?.trim() || undefined;
  const textDirection = resolveTextDirection(contentLanguage);

  const { id: stageId, stage } = resumeScenes
    ? { id: resumeScenes.stageId, stage: resumeScenes.stage }
    : await sink.reserve((id) => ({
        id,
        name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
        description: undefined,
        languageDirective,
        ...(contentLanguage !== undefined ? { language: contentLanguage } : {}),
        ...(textDirection !== undefined ? { textDirection } : {}),
        ...(isSubjectCode(input.subjectCode) ? { subjectCode: input.subjectCode } : {}),
        ...(input.ttsRoute ? { ttsRoute: input.ttsRoute } : {}),
        ...(registerPolicy
          ? {
              speechRegister: {
                policyVersion: registerPolicy.version,
                register: registerPolicy.register,
              },
            }
          : {}),
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
  let sourceServingMapping: Record<string, string> = resumeScenes?.sourceServingMapping ?? {};
  let sourceManifest: SourceVisualManifestEntry[] = resumeScenes?.sourceManifest ?? [];
  // A retained Stage already holds its materialized source visuals.
  if (hasSourceVisuals && options.sourceVisuals && !resumeScenes) {
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
  // The selected answer drawings (owner, 17 Nov 2026) are stored beside them, on a resumed
  // Stage too when it does not hold one yet. FAIL-SOFT: a drawing that cannot be stored is
  // never assigned (below), and the lesson goes on without it.
  if (guideFigures.length > 0 && options.sourceVisuals) {
    const selectedIds = new Set(outlines.flatMap((outline) => outline.suggestedImageIds ?? []));
    const selected = guideFigures.filter(
      (figure) => selectedIds.has(figure.id) && !sourceServingMapping[figure.id],
    );
    if (selected.length > 0) {
      try {
        const materialized = await options.sourceVisuals.materialize(stageId, selected);
        const failed = new Set(materialized.failedIds);
        sourceServingMapping = {
          ...sourceServingMapping,
          ...Object.fromEntries(
            Object.entries(materialized.servingMapping).filter(([id]) => !failed.has(id)),
          ),
        };
        sourceManifest = [
          ...sourceManifest,
          ...materialized.manifest.filter((entry) => !failed.has(entry.id)),
        ];
      } catch (error) {
        log.warn(
          `The guide's answer drawing(s) ${selected.map((figure) => figure.id).join(', ')} could not be stored; left out:`,
          error instanceof Error ? error.name : 'error',
        );
      }
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
    let previousSpeeches: string[] = [];

    // Resume of a `scenes` checkpoint: every valid Scene of the retained Stage is
    // kept as-is; only the pending outlines (and any outline without a Scene)
    // are generated again.
    const regenerate = new Set(resumeScenes?.regenerateOutlineIds ?? []);
    const retainedByOutline = new Map<string, Scene>();
    for (const scene of resumeScenes?.scenes ?? []) {
      if (scene.outlineId && !regenerate.has(scene.outlineId)) {
        retainedByOutline.set(scene.outlineId, scene);
      }
    }
    // g5.v11 (re-review finding 6): an attempt and the solution slides it keys are one
    // unit. A kept attempt whose solution slide is generated (and settled) again is
    // generated again with it, so it never keeps asking a question that slide left out,
    // nor keeps a key that slide was settled without. Never set on any other run.
    if (input.guideAnswerGuard && resumeScenes) {
      for (const outline of outlines) {
        if (!retainedByOutline.has(outline.id)) continue;
        const solutions = input.guideAnswerGuard.solutionsOf(outline.id);
        if (solutions.some((id) => !retainedByOutline.has(id))) {
          retainedByOutline.delete(outline.id);
        }
      }
    }
    const retainedSceneIds = new Set<string>();

    // Pre-pass, before ANY content spend (the prefetch below starts calls at once):
    // a caller-prohibited widget (Kafuo Release 1 defers games) is refused, and on a
    // governed run each Scene's exact Flow entry is resolved fail-closed (W1,
    // TAE-RQ-009) — exactly the two refusals the loop used to make per Scene first.
    const prepared = outlines.map((outline, index) => {
      if (retainedByOutline.has(outline.id)) return null;
      const safeOutline = applyOutlineFallbacks(outline, true, {
        allowProceduralSkill: vocationalActive,
      });
      if (isProhibitedWidgetOutline(safeOutline, input.prohibitedWidgetTypes)) {
        throw new TeachingPackageError(
          'GAME_GENERATION_DEFERRED',
          `scene ${index + 1} (${JSON.stringify(safeOutline.title)}) would generate a "${interactiveWidgetTypeOf(safeOutline)}" widget, which this generation may not create (Kafuo Release 1 defers learning games)`,
          {
            outlineId: safeOutline.id,
            teachingStage: safeOutline.teachingStage,
            widgetType: interactiveWidgetTypeOf(safeOutline),
          },
        );
      }
      return {
        safeOutline,
        flowContext: resolveGovernedSceneFlowContext(input.governed, safeOutline),
      };
    });

    // Set when the loop exits (normally or by throwing) or a Scene's content rejects.
    let contentStopped = false;

    // One Scene's content, with no dependency on any other Scene: each content call
    // reads only its own outline and the run's fixed inputs. That is what makes the
    // prefetch safe — actions, which read `previousSpeeches`, stay in the serial loop.
    const produceSceneContent = async (index: number, safeOutline: SceneOutline) => {
      const contentRefusals: TeachingModelUnavailableError[] = [];
      // 3 Oct 2026: while ONE governed slide/quiz is generated, a non-retryable
      // refusal is that Scene's problem (see `sceneRefusalScope`).
      const governedScope = input.governed && isReviewerRegenerable(safeOutline.type);
      const reportContentRetry = async (event: {
        attempt: number;
        maxAttempts: number;
        reason: string;
      }) => {
        const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
        const message = `Retrying scene ${index + 1}/${outlines.length} content (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
        log.warn(`${message} — ${event.reason}`);
        // A prefetched Scene runs ahead of the loop, so the bar follows the Scenes the
        // loop has finished (never this Scene's own position, which would move it
        // backwards), and nothing is reported once the run has stopped.
        if (contentStopped) return;
        await options.onProgress?.({
          step: 'generating_scenes',
          progress: Math.max(
            30 + Math.floor((generatedScenes / Math.max(outlines.length, 1)) * 60),
            31,
          ),
          message,
          scenesGenerated: generatedScenes,
          totalScenes: outlines.length,
        });
      };
      const run = async () => {
        // Resolve this scene's content model lazily, per outline type. The package
        // gets the provider-bound AICallFn and the app injects its agentic PBL loop
        // as the classified fallback, preserving single-call → loop routing.
        // W6: a bank check quiz needs no content model and no narration model.
        const bankQuiz = Boolean(input.bankCheckQuizzes) && isBankCheckQuizOutline(safeOutline);
        const contentCall = bankQuiz ? null : await resolveSceneContentCall(safeOutline.type);
        // The outline's assigned source visuals (slide scenes only): a visual
        // need the model fills by referencing the image id, resolved onto the
        // serving path after generation. A guide answer drawing (g5.v11) is assigned
        // only once stored, and only while the outline generated selects it: a question
        // that left a settled slide (D-19) takes its drawing with it.
        const assignedImagesOf = (outline: SceneOutline) =>
          hasSlideImages && safeOutline.type === 'slide'
            ? (slideImages?.filter(
                (image) =>
                  outline.suggestedImageIds?.includes(image.id) &&
                  (!guideFigureIds.has(image.id) || sourceServingMapping[image.id] !== undefined),
              ) ?? [])
            : undefined;
        let contentFailure: { code: string; detail?: string } | undefined;
        // 3 Oct 2026: a governed slide problem is recorded on the scene and the
        // package keeps going — the reviewer regenerates the slide afterwards.
        const sceneIssues: SceneGenerationIssue[] = [];
        // `quizDirective` (g5.v11 only): a quiz reads its correction as the regeneration
        // requirements (`editDirective`), since `correctiveNote` is a slide option.
        // `fromOutline` (g5.v11 only, D-19): the settled outline of the last generation.
        const generateContent = async (
          correctiveNote?: string,
          quizDirective?: string,
          fromOutline: SceneOutline = safeOutline,
        ) => {
          if (!contentCall) return null;
          const outlineAssignedImages = assignedImagesOf(fromOutline);
          try {
            return await withGenerationRetry(
              () =>
                generateSceneContent(fromOutline, contentCall.aiCall, {
                  agents,
                  languageDirective,
                  ...(textDirection !== undefined ? { textDirection } : {}),
                  allowProceduralSkill: vocationalActive,
                  ...(input.prohibitedWidgetTypes?.length
                    ? { prohibitedWidgetTypes: input.prohibitedWidgetTypes }
                    : {}),
                  ...(resolvedSkills ? { resolvedSkills } : {}),
                  ...(input.sourceUnits?.length ? { sourceUnits: input.sourceUnits } : {}),
                  ...(sacredPrompt ? { sacredText: sacredPrompt } : {}),
                  ...(input.visibleWorkingSteps ? { visibleWorkingSteps: true } : {}),
                  ...(input.learnerFirst ? { learnerFirst: true } : {}),
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
                  ...(correctiveNote ? { correctiveNote } : {}),
                  ...(quizDirective ? { editDirective: quizDirective } : {}),
                  ...(input.governed
                    ? { onVisualIssue: (issue) => void sceneIssues.push(issue) }
                    : {}),
                  logger: log,
                  onFailure: (failure) => {
                    contentFailure = failure;
                  },
                }),
              {
                label: `scene ${index + 1}/${outlines.length} content`,
                // Governed package generation is intentionally single-shot per
                // scene. A rejected result must surface immediately instead of
                // silently multiplying model cost.
                ...(input.governed ? { maxRetries: 0 } : {}),
                // A null from a routed call whose route failed is not re-rolled
                // per call (plan §7.4): the run fails at the checkpoint below.
                shouldRetryResult: (result) => result === null && routeFailure === null,
                onRetry: (event) => reportContentRetry(event),
              },
            );
          } catch (error) {
            assertRouteAvailable();
            if (
              governedScope &&
              error instanceof TeachingModelUnavailableError &&
              !error.retryable
            ) {
              // Recorded on the scene below; the run continues.
              contentFailure = { code: 'model-refused', detail: error.message };
              return null;
            }
            return containPBLGenerationError(error, safeOutline.title);
          }
        };
        let content = bankQuiz ? bankQuizContent() : await generateContent();
        assertRouteAvailable();
        // Governed runs stay single-shot per scene, with ONE exception: an answer
        // that could not even be parsed (`invalid-model-output`) is re-asked once,
        // for THIS scene only and with a correction — one extra call instead of
        // losing every Scene already generated for the package.
        if (
          !content &&
          input.governed &&
          contentFailure?.code === 'invalid-model-output' &&
          routeFailure === null
        ) {
          log.warn(
            `Scene ${index + 1}/${outlines.length} content was not usable JSON; re-asking once: ${safeOutline.title}`,
          );
          await reportContentRetry({ attempt: 1, maxAttempts: 2, reason: 'invalid-model-output' });
          contentFailure = undefined;
          content = await generateContent(INVALID_SCENE_OUTPUT_CORRECTION);
          assertRouteAvailable();
        }
        // g5.v11 (teacher-guide plan §8.3–8.5): the approved answers are checked by
        // code. A finding regenerates THIS scene once, with a correction naming only the
        // correct final answers; what is still wrong is settled by D-19 (an attempt
        // question removed; an exercise left out of its slide; a check item generated
        // once more without its guide answer) — never a slide dropped, never a person.
        let guideOutline: SceneOutline | undefined;
        const guard = input.guideAnswerGuard;
        if (content && guard?.planOf(safeOutline.id)) {
          const checked = await guardedSceneContent(
            guard,
            safeOutline,
            content,
            async (fromOutline, correction) => {
              const generated =
                fromOutline.type === 'quiz'
                  ? await generateContent(undefined, correction, fromOutline)
                  : await generateContent(correction, undefined, fromOutline);
              assertRouteAvailable();
              return generated;
            },
            {
              onFinding: (findings) =>
                log.warn(
                  `Scene ${index + 1}/${outlines.length} disagrees with its checked answers (${[
                    ...new Set(findings.map((finding) => finding.code)),
                  ].join(', ')}); regenerating once: ${safeOutline.title}`,
                ),
            },
          );
          content = checked.content;
          if (checked.outline !== safeOutline) guideOutline = checked.outline;
          // Re-review finding 5c: a slide still stating a checked answer before the
          // learner's try is kept (D-19) and marked, so the reviewer's fix loop sees it.
          if (checked.leaks.length > 0) sceneIssues.push(guideLeakIssue(checked.leaks));
        }
        return {
          bankQuiz,
          content,
          contentFailure,
          sceneIssues,
          contentRefusals,
          ...(guideOutline ? { guideOutline } : {}),
        };
      };
      return contentRefusalScopes.run(
        {
          scope: governedScope ? { refusals: contentRefusals } : null,
          sceneId: plannedSceneIdOf(index),
        },
        run,
      );
    };

    // g5.v11 (D-19): the only outline that ever leaves the lesson for a checked answer is
    // an attempt left with no question; it leaves the persisted plan with its Scene.
    const droppedGuideOutlines = new Set<string>();
    const dropGuideOutlines = (ids: readonly string[]) => {
      for (const id of ids) droppedGuideOutlines.add(id);
      const before = store.getState().scenes;
      const kept = before.filter((scene) => !droppedGuideOutlines.has(scene.outlineId ?? ''));
      generatedScenes -= before.length - kept.length;
      store.setState({ scenes: kept });
      log.warn(`Removed ${ids.length} attempt(s) left with no question: ${ids.join(', ')}`);
    };

    // Up to SCENE_CONTENT_CONCURRENCY Scenes' content in flight at once, results awaited
    // in order by the loop. Once a route failure is recorded no new Scene starts.
    const sceneContents = lazyBoundedMap(
      outlines,
      sceneContentConcurrency(),
      async (outline, index) => {
        const ready = prepared[index];
        // g5.v11: an outline already dropped is never paid for.
        if (droppedGuideOutlines.has(outline.id)) return null;
        return ready ? produceSceneContent(index, ready.safeOutline) : null;
      },
      // Once the run is stopping for ANY reason (the loop threw, a Scene's content
      // rejected, the route failed), no further Scene starts: the serial loop never
      // spent past the Scene that failed, and the prefetch must not either.
      { shouldContinue: () => routeFailure === null && !contentStopped },
    );
    // A run that stops early must not leave a later Scene's rejection unobserved, and
    // a rejected Scene stops the pool from starting any more.
    for (const pending of sceneContents) {
      pending.catch(() => {
        contentStopped = true;
      });
    }

    let refusedScenes = 0;
    let firstRefusal: TeachingModelUnavailableError | undefined;
    try {
      for (const [index, outline] of outlines.entries()) {
        loopSceneId = null;
        if (droppedGuideOutlines.has(outline.id)) continue;
        const retained = retainedByOutline.get(outline.id);
        if (retained) {
          store.setState({ scenes: [...store.getState().scenes, retained] });
          retainedSceneIds.add(retained.id);
          generatedScenes += 1;
          previousSpeeches = spokenTexts(retained.actions ?? []);
          continue;
        }
        const safeOutline = prepared[index]!.safeOutline;
        loopSceneId = plannedSceneIdOf(index);
        const sceneRefusals: TeachingModelUnavailableError[] = [];
        sceneRefusalScope =
          input.governed && isReviewerRegenerable(safeOutline.type)
            ? { refusals: sceneRefusals }
            : null;
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

        // The content was started by the prefetch pool above (at most
        // `SCENE_CONTENT_CONCURRENCY` Scenes at once); the loop waits for THIS Scene's
        // result in order, while actions stay strictly serial for `previousSpeeches`.
        let produced = await sceneContents[index];
        assertRouteAvailable();
        if (!produced) continue; // only when a route failure stopped the pool (thrown above)
        const guideGuard = input.guideAnswerGuard;
        if (produced.content && guideGuard) {
          // An attempt comes BEFORE the solution slides of its items: their settlement (an
          // exercise left out, a check item without its guide answer) is awaited first.
          for (const solutionId of guideGuard.solutionsOf(safeOutline.id)) {
            const solutionIndex = outlines.findIndex((planned) => planned.id === solutionId);
            if (solutionIndex > index) {
              await sceneContents[solutionIndex];
              assertRouteAvailable();
            }
          }
          // Re-review finding 6: a check item its solution slide now solves without the
          // guide answer (D-19) loses its key here too — generated once more without it.
          const rekeyed = guideGuard.rekeyAttempt(produced.guideOutline ?? safeOutline);
          if (rekeyed) {
            log.warn(
              `Scene ${index + 1}/${outlines.length} keys an answer its solution slide no longer shows; regenerating it once without that key: ${safeOutline.title}`,
            );
            const again = await produceSceneContent(index, rekeyed);
            assertRouteAvailable();
            produced = { ...again, guideOutline: again.guideOutline ?? rekeyed };
          }
        }
        const { bankQuiz, contentFailure, sceneIssues } = produced;
        let content = produced.content;
        // g5.v11 (D-19): a settled outline (an exercise left out, an item without its
        // guide answer) replaces its plan entry, so the persisted plan, a later
        // regeneration and the reviewer read what the slide now does.
        const sceneOutline = produced.guideOutline ?? safeOutline;
        if (produced.guideOutline) {
          const settled = produced.guideOutline;
          outlines = outlines.map((planned) => (planned.id === settled.id ? settled : planned));
        }
        if (content && guideGuard) {
          const pruned = guideGuard.pruneAttempt(safeOutline, content);
          if ('drop' in pruned) {
            sceneRefusalScope = null;
            dropGuideOutlines([safeOutline.id]);
            continue;
          }
          // Owner (17 Nov 2026): the engine's written questions (a proof or «إجابة ممكنة»
          // item the lesson solves) go after the checked ones, before the narration.
          content = withGuideWrittenQuestions(
            pruned.content,
            guideGuard.writtenQuestionsOf(safeOutline.id),
          ) as typeof content;
        }
        // Review finding 1: an attempt's narration writer never reads its hidden key.
        const narrationOutline = guideGuard ? withoutHiddenAnswerKey(sceneOutline) : safeOutline;
        sceneRefusals.push(...produced.contentRefusals);
        const flowContext = prepared[index]!.flowContext;
        const regenerable = isReviewerRegenerable(safeOutline.type);
        if (!content && input.governed && regenerable) {
          // 3 Oct 2026: a slide or quiz can be regenerated by the reviewer, so it
          // never fails the package. Its flow position is kept with a placeholder
          // built from the outline alone, and the scene is marked for regeneration.
          const failureReason = contentFailure
            ? `${contentFailure.code}${contentFailure.detail ? `: ${contentFailure.detail}` : ''}`
            : 'no scene content was returned';
          sceneIssues.push({
            code:
              contentFailure?.code === 'model-refused'
                ? 'TEACHING_MODEL_REFUSED'
                : 'GOVERNED_SCENE_GENERATION_FAILED',
            message: `the ${safeOutline.type} could not be generated (${failureReason}); a placeholder was kept`,
          });
          log.warn(
            `Scene ${index + 1}/${outlines.length} could not be generated (${failureReason}); keeping a placeholder: ${safeOutline.title}`,
          );
          content = placeholderContentFor(safeOutline, textDirection);
        }
        if (!content) {
          // Module 3/4 W2 (TAE-RQ-017): on a governed run a dropped Scene is a
          // dropped Flow position. Skipping it here would surface later as a
          // misattributed TEACHING_MODEL_FLOW_MISMATCH; refuse with the
          // Scene-generation code instead. Non-governed runs keep the skip.
          // (A governed *slide* never reaches here: it is kept as a placeholder
          // above. Quiz / interactive / PBL positions have no reviewer remedy yet.)
          if (input.governed) {
            const failureReason = contentFailure
              ? `${contentFailure.code}${contentFailure.detail ? `: ${contentFailure.detail}` : ''}`
              : 'no scene content was returned';
            throw new TeachingPackageError(
              'GOVERNED_SCENE_GENERATION_FAILED',
              `scene ${index + 1} (${JSON.stringify(safeOutline.title)}) could not be generated: ${failureReason}`,
              {
                outlineId: safeOutline.id,
                teachingStage: safeOutline.teachingStage,
                failureCode: contentFailure?.code,
                failureDetail: contentFailure?.detail,
              },
            );
          }
          log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
          continue;
        }

        const actionsAiCall = bankQuiz ? null : await getSceneActionsAiCall();
        // Module 3/4 W2 (TAE-RQ-017): a governed run must never bind a fallback
        // Action sequence — the defaults are model-free, so they cannot be a
        // governed pedagogical result. The observer records whether THIS attempt
        // fell back; shouldRetryResult re-rolls while it did, and a fallback
        // surviving the full budget refuses with the run's own code below.
        // Non-governed callers keep today's contract exactly: first result wins.
        // Page position + the previous page's speech, so first/last-page cues,
        // same-session continuity and topic signposting exist on the server path.
        const sceneCtx = {
          pageIndex: index + 1,
          totalPages: outlines.length,
          allTitles: outlines.map((planned) => planned.title),
          previousSpeeches,
        };
        let actionsFellBack = false;
        // g5.v11 (teacher-guide plan §8.5): a narration that states a checked answer
        // before the try is asked once more with this note. Unset on every other run.
        let guideNarrationNote: string | undefined;
        const sceneIssuesBeforeActions = sceneIssues.length;
        // W6: the bank placeholder's narration is model-free and deterministic —
        // a successful Scene, never a fallback and never marked for review.
        const produceActions = async () =>
          !actionsAiCall
            ? bankQuizActions(input.language, input.subjectCode)
            : await generateRegisterCompliantActions(
                async (correctiveContext) => {
                  let attemptProducedFallback = false;
                  const generated = await withGenerationRetry(
                    () => {
                      attemptProducedFallback = false;
                      return generateSceneActions(narrationOutline, content, actionsAiCall, {
                        ctx: sceneCtx,
                        agents,
                        languageDirective,
                        ...(registerPolicy
                          ? { spokenLanguagePolicy: registerPolicy.directive }
                          : {}),
                        ...(spokenScript ? { spokenScript } : {}),
                        ...(guideNarrationNote || correctiveContext
                          ? {
                              correctiveContext: [guideNarrationNote, correctiveContext]
                                .filter(Boolean)
                                .join('\n\n'),
                            }
                          : {}),
                        // W1: the ONE resolved Flow position — the generator never sees the
                        // array and never performs the lookup itself.
                        ...(flowContext ? { flowContext } : {}),
                        ...(resolvedSkills ? { resolvedSkills } : {}),
                        ...(input.sourceUnits?.length ? { sourceUnits: input.sourceUnits } : {}),
                        ...(sacredPrompt ? { sacredText: sacredPrompt } : {}),
                        ...(input.learnerFirst ? { learnerFirst: true } : {}),
                        ...(safeOutline.type === 'slide' && hasSlideImages
                          ? {
                              imageNotes: buildNarrationImageNotes(
                                safeOutline,
                                slideImages,
                                sourceServingMapping,
                              ),
                            }
                          : {}),
                        ...(input.governed
                          ? {
                              onFallback: (info: SceneActionsFallback) => {
                                attemptProducedFallback = true;
                                log.warn(
                                  `Scene "${safeOutline.title}" actions fell back (${info.code}) on a governed run`,
                                );
                              },
                            }
                          : {}),
                      });
                    },
                    {
                      label: `scene ${index + 1}/${outlines.length} actions`,
                      ...(input.governed ? { maxRetries: 0 } : {}),
                      ...(input.governed
                        ? {
                            shouldRetryResult: () =>
                              attemptProducedFallback && routeFailure === null,
                          }
                        : {}),
                      onRetry: (event) => reportSceneRetry('actions', event),
                    },
                  );
                  // The Action generator falls back to a model-free sequence on a call
                  // failure; on a routed run a failed ROUTE must fail the run instead.
                  assertRouteAvailable();
                  // 3 Oct 2026: a governed fallback no longer fails the package — the
                  // model-free sequence is kept and the scene is marked for the reviewer.
                  actionsFellBack = Boolean(input.governed) && attemptProducedFallback;
                  return generated;
                },
                registerPolicy,
                { title: safeOutline.title, outlineId: safeOutline.id },
                { outline: narrationOutline, ctx: sceneCtx },
                input.governed
                  ? (error) => void sceneIssues.push({ code: error.code, message: error.message })
                  : undefined,
                // g5.v10: the narration is checked against this slide's own canvas;
                // what is still wrong after the last attempt marks the scene.
                learnerFirstNarrationCheck(
                  input.learnerFirst && safeOutline.type === 'slide',
                  content,
                  (issues) =>
                    sceneIssues.push(
                      ...issues.map((issue) => ({
                        code: issue.code,
                        message: `learner-first narration check: ${issue.evidence}`,
                      })),
                    ),
                  safeOutline.contentRole,
                ),
              );
        let actions = await produceActions();
        // g5.v11 (plan §8.5): a try-it slide's or an attempt's narration never states a
        // checked answer. One more narration with a correction naming no value; still
        // stating it (D-19) → an attempt gets the model-free narration, a try-it slide
        // keeps its own (marked for the reviewer). Nothing leaves the lesson for a narration.
        if (actionsAiCall && guideGuard?.planOf(safeOutline.id)) {
          const leaks = guideGuard.checkNarration(safeOutline, actions);
          if (leaks.length > 0) {
            log.warn(
              `Scene "${safeOutline.title}" narration states a checked answer before the try; asking once more`,
            );
            guideNarrationNote = guideGuard.correction(safeOutline, leaks);
            // The first narration's open issues are not the kept narration's.
            sceneIssues.length = sceneIssuesBeforeActions;
            actions = await produceActions();
            const left = guideGuard.checkNarration(safeOutline, actions);
            if (left.length > 0) {
              if (guideGuard.settleNarration(safeOutline, left) === 'model_free') {
                sceneIssues.length = sceneIssuesBeforeActions;
                actionsFellBack = false;
                actions = bankQuizActions(input.language, input.subjectCode);
              } else {
                // Re-review finding 5c: a slide's narration still stating it is kept and
                // marked, so the reviewer's fix loop sees that slide.
                sceneIssues.push(guideLeakIssue(left));
              }
            }
          }
        }
        if (actionsFellBack) {
          sceneIssues.push({
            code: 'GOVERNED_ACTION_GENERATION_FAILED',
            message:
              'the narration and actions could not be generated; a default narration was kept',
          });
        }
        log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

        let sceneId: string | null = null;
        let assemblyFailure: string | undefined;
        // The id its model calls were recorded under (S8-O1). A failed first assembly
        // created nothing, so the placeholder below reuses it. Never a reason to lose the
        // slide: an id already on the stage (not expected, ids are per position) gives way
        // to a fresh one, and only the ledger link is lost.
        let plannedSceneId: string | undefined = plannedSceneIdOf(index);
        if (store.getState().scenes.some((existing) => existing.id === plannedSceneId)) {
          log.warn(
            `Scene "${safeOutline.title}": planned id ${plannedSceneId} is already on the stage; a fresh id is used`,
          );
          plannedSceneId = undefined;
        }
        try {
          sceneId = createSceneWithActions(safeOutline, content, actions, api, plannedSceneId);
        } catch (error) {
          // A governed slide/quiz whose generated content cannot be assembled
          // (e.g. invalid slide semantics) is kept as a placeholder instead of
          // failing the package; anything else keeps today's contract.
          if (!input.governed || !regenerable) throw error;
          assemblyFailure = error instanceof Error ? error.message : String(error);
        }
        if (!sceneId && input.governed && regenerable) {
          sceneIssues.push({
            code: 'GOVERNED_SCENE_GENERATION_FAILED',
            message: `the generated ${safeOutline.type} could not be assembled (${assemblyFailure ?? 'scene creation failed'}); a placeholder was kept`,
          });
          log.warn(
            `Scene "${safeOutline.title}" could not be assembled; keeping a placeholder for review`,
          );
          sceneId = createSceneWithActions(
            safeOutline,
            placeholderContentFor(safeOutline, textDirection),
            actions,
            api,
            plannedSceneId,
          );
        }
        if (!sceneId) {
          log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
          continue;
        }
        if (bankQuiz) markBankQuizScene(store, sceneId);

        if (sceneRefusals.length > 0) {
          refusedScenes += 1;
          firstRefusal ??= sceneRefusals[0];
          if (!sceneIssues.some((issue) => issue.code === 'TEACHING_MODEL_REFUSED')) {
            sceneIssues.push({
              code: 'TEACHING_MODEL_REFUSED',
              message: `the AI refused part of this ${safeOutline.type} (${sceneRefusals[0]!.message}); defaults were kept`,
            });
          }
        }
        sceneRefusalScope = null;
        if (sceneIssues.length > 0) {
          markSceneIssues(store, sceneId, sceneIssues);
          log.warn(
            `Scene "${safeOutline.title}" kept with ${sceneIssues.length} generation issue(s) for review: ${sceneIssues
              .map((issue) => issue.code)
              .join(', ')}`,
          );
        }

        generatedScenes += 1;
        previousSpeeches = actions.flatMap((action) =>
          action.type === 'speech' && typeof action.text === 'string' ? [action.text] : [],
        );
        const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
        await options.onProgress?.({
          step: 'generating_scenes',
          progress: Math.min(progressEnd, 90),
          message: `Generated ${generatedScenes}/${outlines.length} scenes`,
          scenesGenerated: generatedScenes,
          totalScenes: outlines.length,
        });
      }
    } finally {
      // Normal end or a throw out of the loop: no prefetched Scene starts after it.
      contentStopped = true;
      loopSceneId = null;
    }

    sceneRefusalScope = null;
    // Every generated scene refused is not a scene problem — it is the route
    // (e.g. a rejected request for every call): fail the run as before.
    const freshCount = outlines.length - retainedSceneIds.size;
    if (input.governed && firstRefusal && refusedScenes >= freshCount) throw firstRefusal;

    // g5.v11: a dropped outline leaves the persisted plan too, so no outline is left
    // without its Scene and no media is made for it. Never set on any other run.
    if (droppedGuideOutlines.size > 0) {
      outlines = outlines.filter((outline) => !droppedGuideOutlines.has(outline.id));
    }

    const scenes = store.getState().scenes;
    // On a `scenes` resume only the newly generated Scenes need source-visual
    // precedence, media and narration audio; retained Scenes already have them.
    const freshScenes = resumeScenes
      ? scenes.filter((scene) => !retainedSceneIds.has(scene.id))
      : scenes;
    const freshOutlines = resumeScenes
      ? outlines.filter((outline) => !retainedByOutline.has(outline.id))
      : outlines;
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
      applySourceVisualPrecedence(freshScenes, freshOutlines, sourceServingMapping);
    }

    // Q-11: no Quran or hadith text ever reaches an image or video prompt, and
    // a prompt about scripture asks for no scripture in the picture.
    if (input.sacredText) {
      const stripped = stripSacredTextFromMediaRequests(freshOutlines, input.sacredText.quotes);
      if (stripped > 0) log.warn(`Removed sacred text from ${stripped} media prompt(s)`);
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
        const mediaMap = await generateMediaForClassroom(freshOutlines, stageId, options.baseUrl, {
          // Embedded-text policy from the Stage's AUTHORITATIVE direction only.
          textPolicy: resolveImageTextPolicy(stage.textDirection),
          withholdUnscreenedVideo: Boolean(input.governed),
          usageScope: input.attribution
            ? {
                tenantId: input.attribution.tenantId,
                learningItemId: input.attribution.learningItemId,
                generationAttemptId: input.attribution.generationAttemptId,
              }
            : undefined,
        });
        replaceMediaPlaceholders(scenes, mediaMap);
        log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
      } catch (err) {
        log.warn('Media generation phase failed, continuing:', err);
      }
    }

    // Only a screened-and-approved visual is mapped above. A placeholder that is
    // still unmapped here (generation failed, or every attempt was rejected /
    // unresolved) must not survive into the persisted Stage as a skeleton.
    const withheld = dropUnmappedMediaPlaceholders(scenes);
    if (withheld.size > 0) {
      log.warn(
        `Removed unmapped media placeholders from ${withheld.size} scene(s): ${[...withheld.values()].flat().join(', ')}`,
      );
    }

    // RSS 7.5.7 — a slide whose PLANNED visual was just withheld must not end
    // bare: regenerate it once with the native-elements fallback (and its
    // narration, since element ids change). Still missing → the generator
    // throws the typed ORIENTATION_VISUAL_MISSING; it is never a log line.
    for (const sceneId of withheld.keys()) {
      // S8-O1: this native re-generation's content and narration calls name the Scene.
      loopSceneId = sceneId;
      const scene = scenes.find((item) => item.id === sceneId);
      const planned = outlines.find((item) => item.id === scene?.outlineId);
      if (!scene || !planned || scene.content.type !== 'slide') continue;
      const canvas = scene.content.canvas;
      if (!plannedVisualIssue(planned.visualPlan, canvas.elements as never)) continue;
      log.warn(`Scene "${scene.title}" lost its planned visual; regenerating with native elements`);
      const nativeOutline = {
        ...planned,
        mediaGenerations: undefined,
        visualPlan: { mode: 'native' as const },
      };
      const contentCall = await resolveSceneContentCall('slide');
      const nativeIssues: SceneGenerationIssue[] = [];
      const nativeRefusals: TeachingModelUnavailableError[] = [];
      sceneRefusalScope = input.governed ? { refusals: nativeRefusals } : null;
      let regenerated: Awaited<ReturnType<typeof generateSceneContent>> = null;
      try {
        regenerated = await generateSceneContent(nativeOutline, contentCall.aiCall, {
          agents,
          languageDirective,
          ...(textDirection !== undefined ? { textDirection } : {}),
          editDirective: NATIVE_VISUAL_DIRECTIVE,
          baselineContent: { elements: canvas.elements as never, background: canvas.background },
          ...(input.visibleWorkingSteps ? { visibleWorkingSteps: true } : {}),
          ...(input.learnerFirst ? { learnerFirst: true } : {}),
          ...(sacredPrompt ? { sacredText: sacredPrompt } : {}),
          ...(input.governed ? { onVisualIssue: (issue) => void nativeIssues.push(issue) } : {}),
        });
      } catch (error) {
        assertRouteAvailable();
        if (!(error instanceof TeachingModelUnavailableError) || error.retryable) throw error;
        if (!input.governed) throw error;
        nativeIssues.push({ code: 'TEACHING_MODEL_REFUSED', message: error.message });
      }
      assertRouteAvailable();
      // g5.v11 (review finding 2): the native re-generation is checked like the first
      // one; a slide that now disagrees with (or states) a checked answer is not taken.
      const nativeGuard = input.guideAnswerGuard?.planOf(planned.id)
        ? input.guideAnswerGuard
        : undefined;
      const keepGuidedOriginal = (what: string) => {
        log.warn(
          `Scene "${scene.title}" native regeneration ${what} its checked answers; the original slide is kept`,
        );
        if (input.governed) {
          markSceneIssues(store, scene.id, [
            {
              code: 'ORIENTATION_VISUAL_MISSING',
              message: `the planned visual is missing: the native regeneration ${what} the checked answers`,
            },
          ]);
        }
        sceneRefusalScope = null;
      };
      if (
        nativeGuard &&
        regenerated &&
        'elements' in regenerated &&
        nativeIssues.length === 0 &&
        nativeGuard.checkContent(planned, regenerated).length > 0
      ) {
        keepGuidedOriginal('disagrees with');
        continue;
      }
      if (!regenerated || !('elements' in regenerated) || nativeIssues.length > 0) {
        const message = nativeIssues[0]?.message ?? 'native regeneration produced no slide';
        if (!input.governed) throw new OrientationVisualMissingError(scene.title, message);
        // 3 Oct 2026: keep the slide exactly as it was (elements and actions
        // still agree) and mark it; the reviewer regenerates it.
        markSceneIssues(store, scene.id, [
          {
            code:
              nativeIssues[0]?.code === 'TEACHING_MODEL_REFUSED'
                ? 'TEACHING_MODEL_REFUSED'
                : 'ORIENTATION_VISUAL_MISSING',
            message: `the planned visual is missing: ${message}`,
          },
        ]);
        log.warn(`Scene "${scene.title}" kept without its planned visual for review`);
        sceneRefusalScope = null;
        continue;
      }
      const nativeActionsAiCall = await getSceneActionsAiCall();
      const nativeRegisterIssues: SceneGenerationIssue[] = [];
      const nativeActions = await generateRegisterCompliantActions(
        (correctiveContext) =>
          generateSceneActions(nativeOutline, regenerated, nativeActionsAiCall, {
            agents,
            languageDirective,
            ...(registerPolicy ? { spokenLanguagePolicy: registerPolicy.directive } : {}),
            ...(spokenScript ? { spokenScript } : {}),
            ...(correctiveContext ? { correctiveContext } : {}),
            ...(input.sourceUnits?.length ? { sourceUnits: input.sourceUnits } : {}),
            ...(sacredPrompt ? { sacredText: sacredPrompt } : {}),
            ...(input.learnerFirst ? { learnerFirst: true } : {}),
          }),
        registerPolicy,
        { title: scene.title, outlineId: planned.id },
        undefined,
        input.governed
          ? (error) => void nativeRegisterIssues.push({ code: error.code, message: error.message })
          : undefined,
        learnerFirstNarrationCheck(
          input.learnerFirst,
          regenerated,
          (issues) =>
            nativeRegisterIssues.push(
              ...issues.map((issue) => ({
                code: issue.code,
                message: `learner-first narration check: ${issue.evidence}`,
              })),
            ),
          nativeOutline.contentRole,
        ),
      );
      assertRouteAvailable();
      sceneRefusalScope = null;
      if (nativeRefusals.length > 0) {
        // The narration call was refused: keep the slide as it was, marked.
        markSceneIssues(store, scene.id, [
          {
            code: 'TEACHING_MODEL_REFUSED',
            message: `the planned visual is missing; the AI refused its narration (${nativeRefusals[0]!.message})`,
          },
        ]);
        continue;
      }
      if (nativeGuard && nativeGuard.checkNarration(planned, nativeActions).length > 0) {
        keepGuidedOriginal('narration states');
        continue;
      }
      const nativeContent = nativeGuard
        ? nativeGuard.cleanWording(planned, regenerated)
        : regenerated;
      // Elements and actions are replaced together, only once both exist, so a
      // kept scene never pairs new element ids with old cues.
      canvas.elements = nativeContent.elements as never;
      scene.actions = nativeActions as never;
      if (nativeRegisterIssues.length > 0) markSceneIssues(store, scene.id, nativeRegisterIssues);
    }
    loopSceneId = null;

    if (input.guideAnswerGuard) {
      // Lesson 2-5 (17 Nov 2026): an exercise solution slide's title names exactly the
      // exercises its canvas solves (scene 35 kept «حل التمارين ٤–٦» over ex 20 alone);
      // the persisted plan says the same.
      for (const scene of freshScenes) {
        if (scene.type !== 'slide' || scene.content.type !== 'slide') continue;
        const retitled = retitledExerciseSolution(scene.title, scene.content.canvas);
        if (!retitled) continue;
        log.warn(
          `Exercise solution slide ${scene.outlineId ?? scene.id} retitled to the exercises it solves`,
        );
        scene.title = retitled.title;
        scene.content.canvas = retitled.content;
        outlines = outlines.map((outline) =>
          outline.id === scene.outlineId ? { ...outline, title: retitled.title } : outline,
        );
      }
    }

    // 3 Oct 2026: on a governed run an invalid Action no longer pauses the
    // attempt for an admin after persisting — it is removed here and its scene
    // is marked, so the runner's Action gate finds nothing and the package
    // completes for the reviewer. Before TTS, so no audio is made for it.
    if (input.governed) {
      const repaired = repairInvalidActions(scenes, stage);
      if (repaired > 0) {
        log.warn(`Removed invalid Actions from ${repaired} scene(s); marked them for review`);
      }
    }

    // g5.v10 (TD-4, owner D-2.8): one digit style per lesson, the book's — the
    // freshly generated slides and quizzes are normalised in place.
    if (input.learnerFirst) {
      const style = detectLessonDigitStyle(
        (input.sourceUnits ?? []).map((unit) => unit.text),
        input.language,
      );
      for (const scene of freshScenes) {
        normalizeSceneDigits(scene as never, style);
        // Quality plan W5: one point per choice question, two per short answer.
        normalizeQuizPoints(scene as never);
      }
    }

    // Owner, 23 Nov 2026 (lessons 1-2 / 1-3): a MATH lesson's slides keep the book's
    // logic notation — negation `\sim` / ∼ and truth values T / F — on every Teaching
    // Model, beside the digit style and from the same source text.
    if (isMathSubject(input.subjectCode) && input.sourceUnits?.length) {
      const notation = detectBookLogicNotation(input.sourceUnits.map((unit) => unit.text));
      let changed = 0;
      for (const scene of freshScenes) {
        changed += normalizeSceneLogicNotation(scene as never, notation);
      }
      if (changed > 0) log.warn(`Kept the book's logic notation in ${changed} slide value(s)`);
    }

    // Q-7 / Q-11 (owner decision): narration and characters never speak a Quran
    // verse or hadith; each spoken quote becomes «تأمّل الآية المعروضة» /
    // «تأمّل الحديث المعروض». Before TTS, so no audio of a quote is made.
    if (input.sacredText?.exerciseUnitIds) {
      // 4 Nov 2026: a verse or hadith is never an exercise or check item.
      const removed = stripSacredExerciseItems(freshScenes, input.sacredText.quotes, {
        exerciseSceneIds: exerciseSceneIdsOf(
          freshScenes,
          outlines,
          new Set(input.sacredText.exerciseUnitIds),
        ),
      });
      if (removed > 0) log.warn(`Removed verse or hadith items from ${removed} exercise scene(s)`);
    }
    if (input.sacredText) {
      const stripped = stripSacredNarration(freshScenes, input.sacredText.quotes);
      if (stripped > 0) log.warn(`Replaced spoken sacred text in ${stripped} narration line(s)`);
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
        const ttsSummary = await generateTTSForClassroom(freshScenes, stageId, options.baseUrl, {
          stage,
          usageScope: input.attribution
            ? {
                tenantId: input.attribution.tenantId,
                learningItemId: input.attribution.learningItemId,
                generationAttemptId: input.attribution.generationAttemptId,
              }
            : undefined,
        });
        log.info('TTS generation complete', ttsSummary ? JSON.stringify(ttsSummary) : '');
      } catch (err) {
        log.warn('TTS generation phase failed, continuing:', err);
      }
      // 3 Oct 2026: a spoken line left without audio — its synthesis failed,
      // the routed provider was unavailable, or the phase threw — no longer
      // passes silently. Its scene is marked for the reviewer ("N slides need
      // review") and the package still completes.
      markNarrationAudioGaps(store, freshScenes);
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
        // Q-14: the quotes this package shows, pinned (always present on a run
        // with the policy, so an editor write can never add an unpinned one).
        ...(input.sacredText
          ? { sacredQuotes: usedSacredQuotePins(scenes, input.sacredText.quotes) }
          : {}),
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
      outlineRepairs,
      scenesCount: persisted.scenes.length,
      createdAt: persisted.createdAt,
    };
  } finally {
    if (!persisted) {
      await sink.release(stageId);
    }
  }
}
