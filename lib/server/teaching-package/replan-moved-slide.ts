/**
 * Re-plan a slide that gives up or takes a lesson part (owner, 14 Nov 2026).
 *
 * The first real move (lesson 311) showed that rewriting a slide from its OLD
 * stored key points and canvas leaves pieces of a moved-out part behind. So a
 * slide whose part list changes is planned again from the parts it now teaches
 * — their text, through the same planner «توليد شريحة لجزء من الدرس» uses
 * (`planInsertedSlide`) — and generated fresh from that plan.
 *
 * The plan only supplies what the slide says (key points, description, visuals,
 * assistance). Its title, place and classification — outline id, order,
 * teaching stage and Skills, slide type, content role and kind — stay the
 * slide's own, so the regeneration invariants hold and a move renames nothing.
 * The planner is never offered Skills: the slide keeps its own.
 *
 * No plan (no flow, no stage on the slide) is not a failure: the caller keeps
 * the edit-mode regeneration with the move directive.
 */
import { normalizeSourceGroundedVisuals, type SceneOutline } from '@openmaic/generation';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { AppDocumentOutline, AppStage } from '@/lib/document-store/persistence-types';
import type { ContentUnitRow } from '@/lib/persistence/teaching-package';
import type { AICallFn } from '@openmaic/generation';
import { readFlowForVersion } from '@/lib/server/teaching-package/exact-flow';
import { planInsertedSlide } from '@/lib/server/teaching-package/plan-inserted-slide';
import { INSERTION_PLANNER_STAGE } from '@/lib/server/teaching-package/routed-insertion-call';
import {
  readSacredQuotePins,
  sacredPolicyModeFor,
} from '@/lib/server/teaching-package/sacred-text';
import { eligibleVisualsForUnits } from '@/lib/server/teaching-package/scene-insertion';
import type { TeachingPackageErrorCode } from '@/lib/server/teaching-package/errors';
import { outlineFromScene } from '@/lib/server/agent-runtime/generation-tools';
import type { AppScene, Scene } from '@/lib/types/stage';
import type { TeachingStageRef } from '@/lib/types/teaching-package';

export { INSERTION_PLANNER_STAGE as REPLAN_PLANNER_STAGE };

export type ReplanMovedSlideResult =
  | { kind: 'planned'; outline: SceneOutline }
  /** No flow position for this slide: keep the directive-only regeneration. */
  | { kind: 'unplannable' }
  | { kind: 'failed'; code: TeachingPackageErrorCode; message: string; details?: unknown };

export interface ReplanMovedSlideInput {
  pool: ConnectableQueryable;
  versionId: string;
  /** The live slide before the regeneration. */
  scene: AppScene;
  scenes: readonly AppScene[];
  outlineRecord: AppDocumentOutline | null | undefined;
  /** Every Content Unit of the version. */
  units: readonly ContentUnitRow[];
  /** The slide's new lesson-part list. */
  unitIds: readonly string[];
  /** The reviewer's requirements only (untrusted focus for the planner); never a moved-out part's text. */
  instruction: string;
  stage: AppStage;
  languageDirective: string;
  aiCall: AICallFn;
  /** Test seams. */
  plan?: typeof planInsertedSlide;
  visuals?: typeof eligibleVisualsForUnits;
}

/** The slide's stage: its own, else its stored plan's. */
function stageOf(
  scene: AppScene,
  outlineRecord: AppDocumentOutline | null | undefined,
): TeachingStageRef | undefined {
  if (scene.teachingStage) return scene.teachingStage;
  const entry = outlineRecord?.outlines?.find((outline) => outline.id === scene.outlineId);
  return (entry as { teachingStage?: TeachingStageRef } | undefined)?.teachingStage;
}

/**
 * The slide's classification as the regeneration will keep it: the same
 * reading `regenerateOneScene` seeds from (`outlineFromScene`).
 */
function ownClassification(
  scene: AppScene,
  outlineRecord: AppDocumentOutline | null | undefined,
): { slideType?: string; contentRole?: string; contentKind?: string } {
  const own = outlineFromScene(scene as Scene, outlineRecord ?? undefined);
  return {
    ...(own.slideType !== undefined ? { slideType: own.slideType } : {}),
    ...(own.contentRole !== undefined ? { contentRole: own.contentRole } : {}),
    ...(own.contentKind !== undefined ? { contentKind: own.contentKind } : {}),
  };
}

export async function replanMovedSlide(
  input: ReplanMovedSlideInput,
): Promise<ReplanMovedSlideResult> {
  const flow = await readFlowForVersion(input.pool, input.versionId);
  const stageRef = stageOf(input.scene, input.outlineRecord);
  const flowEntry = stageRef && flow ? flow[stageRef.flowIndex] : undefined;
  if (!flow || !stageRef || !flowEntry) return { kind: 'unplannable' };

  const chosen = new Set(input.unitIds);
  const chosenUnits = input.units.filter((unit) => chosen.has(unit.unitId));
  const { visuals, visionImages } = await (input.visuals ?? eligibleVisualsForUnits)(
    input.pool,
    input.outlineRecord,
    input.unitIds,
  );
  const ordered = [...input.scenes].sort((a, b) => a.order - b.order);
  const at = ordered.findIndex((scene) => scene.id === input.scene.id);
  const previous = at > 0 ? ordered[at - 1] : undefined;
  const next = at >= 0 && at < ordered.length - 1 ? ordered[at + 1] : undefined;
  const eligibleImages = visuals.map((visual) => visual.image);

  const planned = await (input.plan ?? planInsertedSlide)({
    units: chosenUnits.map((unit) => ({
      id: unit.unitId,
      order: unit.orderIndex,
      role: unit.role,
      subtype: unit.subtype,
      title: unit.title,
      text: unit.normalizedText,
    })),
    unitIds: [...input.unitIds],
    flowEntry,
    teachingStage: stageRef,
    // The slide keeps its own Skills (applied after planning), so none are offered.
    allowedSkills: null,
    previousTitle: previous?.title ?? null,
    nextTitle: next?.title ?? null,
    language: input.stage.language ?? 'ar-SA',
    languageDirective: input.languageDirective,
    eligibleVisuals: visuals.map(({ entry }) => ({
      id: entry.id,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.caption ? { caption: entry.caption } : {}),
      ...(entry.figureLabel ? { figureLabel: entry.figureLabel } : {}),
    })),
    visionImages,
    instruction: input.instruction,
    outlineId: input.scene.outlineId ?? input.scene.id,
    order: input.scene.order,
    sacredMode: sacredPolicyModeFor({
      subjectCode: input.stage.subjectCode,
      pins: readSacredQuotePins(input.outlineRecord?.sacredQuotes),
      texts: chosenUnits.map((unit) => unit.normalizedText),
    }),
    // The slide's own classification, fixed: the planner plans for it and its
    // own guess is neither used nor validated (the first live move failed on one).
    fixedClassification: ownClassification(input.scene, input.outlineRecord),
    // The slide keeps its own Skills and classification (applied after planning),
    // so only the visual plan is normalized against the visuals offered here.
    check: (outline) => {
      const normalized = normalizeSourceGroundedVisuals([outline], flow, eligibleImages);
      return { ok: true, outline: normalized.outlines[0]!, repairs: normalized.repairs };
    },
    aiCall: input.aiCall,
  });
  if (!planned.ok) {
    return {
      kind: 'failed',
      code: planned.code,
      message: planned.message,
      ...(planned.details === undefined ? {} : { details: planned.details }),
    };
  }
  return { kind: 'planned', outline: planned.outline };
}
