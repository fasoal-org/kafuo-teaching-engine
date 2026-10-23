/**
 * Generate the NEW slide of a reviewer-generated insertion (reviewer-
 * generated-slide-for-lesson-part-plan §10.3). No authorization, no
 * persistence: the insertion service owns both. `regenerate-one-scene.ts` is
 * not modified; this module composes the same exported pieces:
 *
 * - content: `generateSceneContent` on the NORMALIZED planned outline, with no
 *   caller `editDirective` and no caller `baselineContent` (the generator's own
 *   native-visual correction and assistance authoring run as they always do,
 *   leak checks included);
 * - actions: `generateRegisterCompliantActions` around `generateSceneActions`,
 *   fallback defaults refused, with a sentinel for the new Scene in the page
 *   context;
 * - assembly: `buildCompleteScene` under the minted Scene id, the minted
 *   `ins_…` outline id (which resolves to no outline entry, D-6), and
 *   `assertGeneratedSlideScene`.
 *
 * Neither the reviewer's reason nor any edit directive is a parameter.
 */
import {
  assertGeneratedSlideScene,
  buildCompleteScene,
  generateSceneActions,
  generateSceneContent,
  type AICallFn,
  type PdfImage,
  type SceneActionsFallback,
  type SceneOutline,
} from '@openmaic/generation';

import type { AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene } from '@/lib/document-store/validators';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';
import { actionContext, filterKnownActions } from '@/lib/server/agent-runtime/generation-tools';
import { sceneContentStage } from '@/lib/server/agent-runtime/generation-ai-call';
import { generateRegisterCompliantActions } from '@/lib/server/classroom-generation';
import {
  resolveSpokenScriptOptions,
  type SpeechRegisterPolicy,
} from '@/lib/server/speech/register-policy';
import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
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
import type { AppScene, Scene } from '@/lib/types/stage';

export interface InsertOneSceneInput {
  /** The normalized planned outline (id = the minted `ins_…`, order = its position). */
  outline: SceneOutline;
  newSceneId: string;
  /** Every live Scene of the Stage BEFORE the insertion (page context + Action references). */
  scenes: readonly AppScene[];
  stage: AppStage;
  /** Only the eligible approved visuals linked to the chosen units (§10.4). */
  eligibleImages: readonly PdfImage[];
  aiCallFor: (stage: string) => AICallFn;
  assertRouteAvailable?: () => void;
  registerPolicy: SpeechRegisterPolicy | null;
  governed?: GovernedRegenerationContext;
  now?: () => number;
  /** Test seams. */
  generateContent?: typeof generateSceneContent;
  generateActions?: typeof generateSceneActions;
}

export type InsertOneSceneResult =
  | { ok: true; scene: AppScene }
  | { ok: false; code: TeachingPackageErrorCode; message: string; details?: unknown };

function failure(
  code: TeachingPackageErrorCode,
  message: string,
  details?: unknown,
): InsertOneSceneResult {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) };
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** On a voiced package the new slide is marked exactly as regeneration marks it (D-11). */
function withNarrationAudioMark(candidate: AppScene, scenes: readonly AppScene[]): AppScene {
  if (!stageHasNarrationAudio(scenes)) return candidate;
  const issues = issuesAfterAudioRepair(candidate.generationIssues, narrationAudioGap(candidate));
  const { generationIssues: _built, ...rest } = candidate;
  return (issues ? { ...rest, generationIssues: issues } : rest) as AppScene;
}

export async function insertOneScene(input: InsertOneSceneInput): Promise<InsertOneSceneResult> {
  const { outline, stage } = input;
  if (outline.type !== 'slide') {
    return failure('SCENE_CONTENT_GENERATION_FAILED', 'only a slide can be inserted');
  }
  const assertRoute = input.assertRouteAvailable ?? (() => {});
  const generateContent = input.generateContent ?? generateSceneContent;
  const generateActions = input.generateActions ?? generateSceneActions;
  const now = input.now ?? Date.now;

  // 1. Content — the normalized outline, never an edit mode.
  const selected = new Set(outline.suggestedImageIds ?? []);
  const assignedImages = input.eligibleImages.filter((image) => selected.has(image.id));
  const imageMapping = Object.fromEntries(assignedImages.map((image) => [image.id, image.src]));
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
      ...(assignedImages.length > 0 ? { assignedImages, imageMapping } : {}),
      ...(input.governed ? { resolvedSkills: input.governed.resolvedSkills } : {}),
      onFailure: (event) => {
        contentFailure = event;
      },
    });
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError) {
      return failure(error.code, error.message, error.details);
    }
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

  // 2. Actions under the register policy; fallback defaults refused.
  const sentinel = {
    id: input.newSceneId,
    order: outline.order,
    title: outline.title,
    actions: [],
  } as unknown as Scene;
  const sceneCtx = actionContext(
    [
      ...(input.scenes as Scene[]).map((scene) =>
        scene.order >= outline.order ? ({ ...scene, order: scene.order + 1 } as Scene) : scene,
      ),
      sentinel,
    ],
    sentinel,
  );
  const fallbackCode: TeachingPackageErrorCode = input.governed
    ? 'GOVERNED_ACTION_GENERATION_FAILED'
    : 'SCENE_ACTION_GENERATION_FAILED';
  let actions;
  try {
    const spokenScript = resolveSpokenScriptOptions(stage.language, input.registerPolicy);
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
            onFallback: (info) => {
              fellBack = info;
            },
          },
        );
        if (fellBack) {
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
      { title: outline.title, outlineId: outline.id },
      { outline, ctx: sceneCtx },
    );
  } catch (error) {
    assertRoute();
    if (error instanceof TeachingPackageError) {
      return failure(error.code, error.message, error.details);
    }
    throw error;
  }
  assertRoute();

  // 3. Assembly under the minted ids.
  const built = buildCompleteScene(outline, content, actions, stage.id, {
    sceneId: input.newSceneId,
  }) as AppScene | null;
  if (!built || built.content.type !== 'slide') {
    return failure('SCENE_CONTENT_GENERATION_FAILED', 'the slide could not be assembled');
  }
  const assembled: AppScene = {
    ...built,
    id: input.newSceneId,
    outlineId: outline.id,
    order: outline.order,
    teachingStage: outline.teachingStage,
    sourceContentUnitIds: [...(outline.sourceContentUnitIds ?? [])],
    ...(outline.teachingSkills ? { teachingSkills: outline.teachingSkills } : {}),
    createdAt: now(),
    updatedAt: now(),
  } as AppScene;
  try {
    assertGeneratedSlideScene(assembled);
  } catch (error) {
    return failure('SCENE_CONTENT_GENERATION_FAILED', (error as Error).message);
  }

  // 4. Validation (repeated in T2 on the exact snapshot).
  const findings = validateSceneActionStructure([...input.scenes, assembled], { stage }).filter(
    (finding) => finding.sceneId === assembled.id,
  );
  if (findings.length > 0) {
    const first = findings[0]!;
    return failure(first.code, first.message, { findings: findings.length });
  }
  const storable = omitUndefinedObjectMembers(withNarrationAudioMark(assembled, input.scenes));
  const validation = validateAppScene(storable);
  if (!validation.valid) {
    return failure(
      'SCENE_CONTENT_GENERATION_FAILED',
      `the generated slide is not a valid scene: ${validation.errors
        .map((error) => `${error.path || '/'}: ${error.message}`)
        .join('; ')}`,
    );
  }
  return { ok: true, scene: storable };
}
