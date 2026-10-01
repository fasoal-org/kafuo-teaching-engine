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
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type SceneActionsFallback,
  type VisualPlan,
} from '@openmaic/generation';

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
import type { SpeechRegisterPolicy } from '@/lib/server/speech/register-policy';
import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
import { buildSceneAlignmentBaseline } from '@/lib/server/teaching-package/alignment';
import {
  TeachingPackageError,
  type TeachingPackageErrorCode,
} from '@/lib/server/teaching-package/errors';
import type { GovernedRegenerationContext } from '@/lib/server/teaching-package/governed-regeneration';
import { liftSlideImages } from '@/lib/server/teaching-package/scene-regeneration-images';
import type { SceneOutline } from '@/lib/types/generation';
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

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The fields a regeneration never changes (plan §7.3.2). */
export function regenerationInvariantViolations(pre: AppScene, candidate: AppScene): string[] {
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
  } else {
    violations.push('content.type');
  }
  check('teachingStage', pre.teachingStage, candidate.teachingStage);
  check('teachingSkills', pre.teachingSkills, candidate.teachingSkills);
  check('learningObjectives', pre.learningObjectives, candidate.learningObjectives);
  check('sourceContentUnitIds', pre.sourceContentUnitIds, candidate.sourceContentUnitIds);
  return violations;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function regenerateOneScene(
  input: RegenerateOneSceneInput,
): Promise<RegenerateOneSceneResult> {
  const pre = input.scene;
  if (pre.type !== 'slide' || pre.content.type !== 'slide') {
    return failure('SCENE_TYPE_NOT_REGENERABLE', 'only slides can be regenerated');
  }
  const assertRoute = input.assertRouteAvailable ?? (() => {});
  const generateContent = input.generateContent ?? generateSceneContent;
  const generateActions = input.generateActions ?? generateSceneActions;
  const now = input.now ?? Date.now;

  // 1. The outline, seeded from the persisted Scene and its stored plan. No AI
  //    image generation: planned media generations are stripped.
  const seeded = outlineFromScene(pre as Scene, input.outlineSnapshot);
  const { mediaGenerations: _stripped, ...withoutMedia } = seeded as SceneOutline & {
    mediaGenerations?: unknown;
  };
  const outline: SceneOutline = {
    ...withoutMedia,
    ...(pre.teachingStage ? { teachingStage: pre.teachingStage } : {}),
    ...(pre.teachingSkills ? { teachingSkills: pre.teachingSkills } : {}),
    ...(pre.sourceContentUnitIds ? { sourceContentUnitIds: [...pre.sourceContentUnitIds] } : {}),
  };
  const legacyInPlace =
    outline.slideType === undefined &&
    outline.contentRole === undefined &&
    outline.contentKind === undefined;

  // 2. Book images (§7.4).
  const lifted = liftSlideImages({
    canvas: pre.content.canvas,
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
      editDirective: input.instruction,
      baselineContent: baseline,
      ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
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
  const fallbackCode: TeachingPackageErrorCode = input.governed
    ? 'GOVERNED_ACTION_GENERATION_FAILED'
    : 'SCENE_ACTION_GENERATION_FAILED';
  let actions;
  try {
    actions = await generateRegisterCompliantActions(
      async (correctiveContext) => {
        let fellBack: SceneActionsFallback | undefined;
        const generated = await generateActions(
          outline,
          content,
          input.aiCallFor('scene-actions'),
          {
            ctx: actionContext(input.scenes as Scene[], pre as Scene),
            agents,
            languageDirective,
            ...(input.registerPolicy
              ? { spokenLanguagePolicy: input.registerPolicy.directive }
              : {}),
            ...(correctiveContext ? { correctiveContext } : {}),
            ...(input.governed ? { flowContext: input.governed.flowContext } : {}),
            ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
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
    );
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError)
      return failure(error.code, error.message, error.details);
    throw error;
  }
  assertRoute();

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
    ...built,
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
    ...(pre.sourceContentUnitIds !== undefined
      ? { sourceContentUnitIds: pre.sourceContentUnitIds }
      : {}),
  } as AppScene;
  if (input.governed) {
    // A governed regeneration is a fresh generation-origin baseline (W4.4).
    const stamped = buildSceneAlignmentBaseline(candidate, { origin: 'generation', now: now() });
    if (stamped) candidate = { ...candidate, alignmentBaseline: stamped };
  }

  // 6. Validation (repeated inside the store write).
  const violations = regenerationInvariantViolations(pre, candidate);
  if (violations.length > 0) {
    return failure(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the regenerated slide changed fields it must keep: ${violations.join(', ')}`,
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
  const storable = omitUndefinedObjectMembers(candidate);
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
