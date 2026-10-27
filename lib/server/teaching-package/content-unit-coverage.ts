/**
 * Lesson-part coverage and insertion geometry for a reviewer-generated slide
 * (reviewer-generated-slide-for-lesson-part-plan §8–§9). Pure: no I/O.
 *
 * - Citations mirror Help's rule EXACTLY (`help-service.ts`
 *   `citedContentUnitIds`, F8): a Scene's own `sourceContentUnitIds` when it
 *   carries the array (even empty), else the ids of the outline entry whose
 *   `id === scene.outlineId` — never matched by order, numeric ids read as
 *   strings. Help itself is not touched; parity is tested.
 * - Coverage is computed on read, never stored. A unit is covered when a live
 *   SLIDE cites it; other Scene types are reported separately.
 * - Positions are anchors (`afterSceneId` / `beforeSceneId`), not numbers.
 *   A stage is identified by `(key, flowIndex)`, never the key alone.
 */
import {
  scenePolicyFor,
  type OutlineDiagnostic,
  type SceneOutline,
  type TeachingSceneType,
} from '@openmaic/generation';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { ContentUnitRow } from '@/lib/persistence/teaching-package';
import { outlineFromScene } from '@/lib/server/agent-runtime/generation-tools';
import { NON_INSTRUCTIONAL_UNIT_ROLES } from '@/lib/server/teaching-package/content-units';
import { NON_TEACHING_SLIDE_ROLES } from '@/lib/server/teaching-package/outline-grounding';
import type { TeachingFlowEntry, TeachingStageRef } from '@/lib/types/teaching-package';
import type { AppScene, Scene } from '@/lib/types/stage';

/** The most units one inserted slide may cover (D-1). */
export const MAX_INSERTION_UNITS = 3;

type OutlineRecord = Pick<AppDocumentOutline, 'outlines'> | null | undefined;

/** The Content Units a Scene cites — Help's rule, byte for byte in behaviour. */
export function citedContentUnitIds(
  scene: Pick<AppScene, 'sourceContentUnitIds' | 'outlineId'>,
  outline: OutlineRecord,
): string[] {
  if (Array.isArray(scene.sourceContentUnitIds)) {
    return scene.sourceContentUnitIds.filter(
      (id): id is string => typeof id === 'string' && id !== '',
    );
  }
  const outlineId = scene.outlineId;
  if (typeof outlineId !== 'string' || outlineId === '') return [];
  const outlines = (outline as { outlines?: unknown } | null | undefined)?.outlines;
  if (!Array.isArray(outlines)) return [];
  const entry = outlines.find(
    (candidate): candidate is { id: string; sourceContentUnitIds?: unknown } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === outlineId,
  );
  const ids = entry?.sourceContentUnitIds;
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => (typeof id === 'number' && Number.isFinite(id) ? String(id) : id))
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

export function isInstructionalUnitRole(role: string): boolean {
  return !NON_INSTRUCTIONAL_UNIT_ROLES.has(role);
}

export interface UnitCoverage {
  id: string;
  order: number;
  title: string | null;
  role: string;
  instructional: boolean;
  textLength: number;
  coveredBySlideIds: string[];
  citedByOtherSceneIds: string[];
  covered: boolean;
}

/** Live Scenes by persisted `order` (ties by id, so the result is deterministic). */
export function orderedScenes<T extends Pick<AppScene, 'id' | 'order'>>(scenes: readonly T[]): T[] {
  return [...scenes].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A slide that teaches what it cites. An introduction, recap or check slide
 * citing a unit is no evidence the unit was taught — the same rule the
 * generation-time coverage check applies to outlines.
 */
export function isTeachingSlide(scene: Pick<AppScene, 'type' | 'content'>): boolean {
  if (scene.type !== 'slide') return false;
  const role = (scene.content as { contentRole?: unknown } | undefined)?.contentRole;
  return !(typeof role === 'string' && NON_TEACHING_SLIDE_ROLES.has(role));
}

/**
 * Sections the generated plan left untaught (`gapUnitIds`) and the slides
 * "Generate slide" built (`insertedSlideUnits`: Scene id → its lesson parts).
 * A gap section counts as taught only by a slide generated for it: a citation
 * added to a slide written about something else is not evidence it was taught.
 */
export interface CoverageGapEvidence {
  gapUnitIds: ReadonlySet<string>;
  insertedSlideUnits: ReadonlyMap<string, readonly string[]>;
}

/** Unit id → the Scenes that teach it, and → the Scenes that only cite it. */
function citationsByUnit(
  scenes: readonly AppScene[],
  outline: OutlineRecord,
  gaps?: CoverageGapEvidence,
): { slidesByUnit: Map<string, string[]>; othersByUnit: Map<string, string[]> } {
  const slidesByUnit = new Map<string, string[]>();
  const othersByUnit = new Map<string, string[]>();
  for (const scene of orderedScenes(scenes)) {
    const teaching = isTeachingSlide(scene);
    const generatedFor = gaps?.insertedSlideUnits.get(scene.id) ?? [];
    for (const unitId of new Set(citedContentUnitIds(scene, outline))) {
      const counts = teaching && (!gaps?.gapUnitIds.has(unitId) || generatedFor.includes(unitId));
      const target = counts ? slidesByUnit : othersByUnit;
      const list = target.get(unitId) ?? [];
      list.push(scene.id);
      target.set(unitId, list);
    }
  }
  return { slidesByUnit, othersByUnit };
}

/**
 * The essential sections no live slide teaches, in the order given — the
 * Submit coverage gate. Same rule as {@link computeContentUnitCoverage}, so a
 * section the editor shows as uncovered is exactly a section Submit refuses.
 */
export function findUntaughtEssentialSections(
  essentialUnitIds: readonly string[],
  scenes: readonly AppScene[],
  outline: OutlineRecord,
  gaps?: CoverageGapEvidence,
): string[] {
  const { slidesByUnit } = citationsByUnit(scenes, outline, gaps);
  return essentialUnitIds.filter((id) => !slidesByUnit.has(id));
}

export function computeContentUnitCoverage(
  units: readonly ContentUnitRow[],
  scenes: readonly AppScene[],
  outline: OutlineRecord,
  gaps?: CoverageGapEvidence,
): UnitCoverage[] {
  const { slidesByUnit, othersByUnit } = citationsByUnit(scenes, outline, gaps);
  return [...units]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((unit) => {
      const coveredBySlideIds = slidesByUnit.get(unit.unitId) ?? [];
      return {
        id: unit.unitId,
        order: unit.orderIndex,
        title: unit.title,
        role: unit.role,
        instructional: isInstructionalUnitRole(unit.role),
        textLength: unit.textLength,
        coveredBySlideIds,
        citedByOtherSceneIds: othersByUnit.get(unit.unitId) ?? [],
        covered: coveredBySlideIds.length > 0,
      };
    });
}

export interface InsertionAnchors {
  afterSceneId: string | null;
  beforeSceneId: string | null;
}

export type ResolvedPosition =
  | {
      ok: true;
      /** The new Scene's `order`; every live Scene with `order >= at` shifts by one. */
      at: number;
      after: AppScene | null;
      before: AppScene | null;
    }
  | { ok: false; reason: 'unknown_anchor' | 'not_adjacent' };

/** Resolve anchors to an adjacent gap of the ordered Scene list. */
export function resolveInsertionPosition(
  scenes: readonly AppScene[],
  anchors: InsertionAnchors,
): ResolvedPosition {
  const ordered = orderedScenes(scenes);
  const afterIndex =
    anchors.afterSceneId === null ? -1 : ordered.findIndex((s) => s.id === anchors.afterSceneId);
  const beforeIndex =
    anchors.beforeSceneId === null
      ? ordered.length
      : ordered.findIndex((s) => s.id === anchors.beforeSceneId);
  if ((anchors.afterSceneId !== null && afterIndex < 0) || beforeIndex < 0) {
    return { ok: false, reason: 'unknown_anchor' };
  }
  if (beforeIndex !== afterIndex + 1) return { ok: false, reason: 'not_adjacent' };
  const after = afterIndex >= 0 ? ordered[afterIndex]! : null;
  const before = beforeIndex < ordered.length ? ordered[beforeIndex]! : null;
  const at = after ? after.order + 1 : before ? before.order : 1;
  return { ok: true, at, after, before };
}

function stageOf(scene: Pick<AppScene, 'teachingStage'> | null): TeachingStageRef | null {
  const stage = scene?.teachingStage;
  return stage && typeof stage.key === 'string' && Number.isInteger(stage.flowIndex)
    ? { key: stage.key, flowIndex: stage.flowIndex }
    : null;
}

const sameStage = (a: TeachingStageRef, b: TeachingStageRef) =>
  a.key === b.key && a.flowIndex === b.flowIndex;

/**
 * The `(key, flowIndex)` stages a new slide may take between two anchors
 * (plan §9.2): `{L}` inside a run, `{L, R}` at a boundary, `{R}` at the start,
 * `{L}` at the end — each kept only when its flow entry exists, names that key,
 * allows a `slide`, and is not an `exactly_one` position already holding a
 * live Scene of ANY type. Ordered left first (the dialog's default).
 */
export function allowedStagesAt(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
  position: Extract<ResolvedPosition, { ok: true }>,
): TeachingStageRef[] {
  const left = stageOf(position.after);
  const right = stageOf(position.before);
  const candidates: TeachingStageRef[] = [];
  if (left) candidates.push(left);
  if (right && !(left && sameStage(left, right))) candidates.push(right);
  if (!position.after && !position.before && flow[0]) {
    candidates.push({ key: flow[0].stage, flowIndex: 0 });
  }
  return candidates.filter((candidate) => {
    const entry = flow[candidate.flowIndex];
    if (!entry || entry.stage !== candidate.key) return false;
    const policy = scenePolicyFor(entry);
    if (policy && !policy.sceneTypes.includes('slide' as TeachingSceneType)) return false;
    if (policy?.cardinality === 'exactly_one') {
      const occupied = scenes.some((scene) => {
        const stage = stageOf(scene);
        return stage !== null && sameStage(stage, candidate);
      });
      if (occupied) return false;
    }
    return true;
  });
}

export interface PositionOption extends InsertionAnchors {
  allowedStages: TeachingStageRef[];
}

/** Every gap of the Stage, from before the first Scene to after the last. */
export function insertionPositionOptions(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
): PositionOption[] {
  const ordered = orderedScenes(scenes);
  const options: PositionOption[] = [];
  for (let gap = 0; gap <= ordered.length; gap += 1) {
    const anchors = {
      afterSceneId: gap > 0 ? ordered[gap - 1]!.id : null,
      beforeSceneId: gap < ordered.length ? ordered[gap]!.id : null,
    };
    const resolved = resolveInsertionPosition(ordered, anchors);
    options.push({
      ...anchors,
      allowedStages: resolved.ok ? allowedStagesAt(ordered, flow, resolved) : [],
    });
  }
  return options;
}

/**
 * The default position for a slide covering `unitId` (plan §9.1): after the
 * last live slide citing the nearest PRECEDING covered unit; else before the
 * first slide citing the nearest FOLLOWING covered unit; else at the end.
 */
export function suggestInsertionPosition(
  unitId: string,
  coverage: readonly UnitCoverage[],
  scenes: readonly AppScene[],
): InsertionAnchors {
  const ordered = orderedScenes(scenes);
  const anchorsAfter = (sceneId: string): InsertionAnchors => {
    const index = ordered.findIndex((scene) => scene.id === sceneId);
    return { afterSceneId: sceneId, beforeSceneId: ordered[index + 1]?.id ?? null };
  };
  const anchorsBefore = (sceneId: string): InsertionAnchors => {
    const index = ordered.findIndex((scene) => scene.id === sceneId);
    return { afterSceneId: index > 0 ? ordered[index - 1]!.id : null, beforeSceneId: sceneId };
  };
  const units = [...coverage].sort((a, b) => a.order - b.order);
  const at = units.findIndex((unit) => unit.id === unitId);
  const position = (slideIds: readonly string[]) =>
    ordered.filter((scene) => slideIds.includes(scene.id));
  for (let index = at - 1; at >= 0 && index >= 0; index -= 1) {
    const slides = position(units[index]!.coveredBySlideIds);
    if (slides.length > 0) return anchorsAfter(slides[slides.length - 1]!.id);
  }
  for (let index = at + 1; at >= 0 && index < units.length; index += 1) {
    const slides = position(units[index]!.coveredBySlideIds);
    if (slides.length > 0) return anchorsBefore(slides[0]!.id);
  }
  return { afterSceneId: ordered[ordered.length - 1]?.id ?? null, beforeSceneId: null };
}

/** Every live Scene with `order >= at` moved down by one; nothing but `order` changes. */
export function shiftScenesForInsertion<T extends Pick<AppScene, 'order'>>(
  scenes: readonly T[],
  at: number,
): T[] {
  return scenes.map((scene) => (scene.order >= at ? { ...scene, order: scene.order + 1 } : scene));
}

/**
 * The real post-insertion Scene list with a placeholder for the new slide
 * (plan §9.3) — what `validateExactTeachingFlow` needs before any paid call.
 */
export function placeholderProjection(
  scenes: readonly AppScene[],
  at: number,
  placeholder: { id: string; outlineId: string; teachingStage: TeachingStageRef; stageId: string },
): AppScene[] {
  return [
    ...shiftScenesForInsertion(scenes, at),
    {
      id: placeholder.id,
      stageId: placeholder.stageId,
      type: 'slide',
      title: '',
      order: at,
      outlineId: placeholder.outlineId,
      teachingStage: placeholder.teachingStage,
    } as unknown as AppScene,
  ];
}

/**
 * The scene-policy projection of a Stage (plan §9.4): per live Scene in order,
 * its stored outline entry by `outlineId` AS STORED (its `teachingStage`
 * untouched) with the Scene's `order`; a Scene without a resolvable entry is
 * represented from its own fields. For policy diagnostics only — its
 * `teachingSkills` are never read for Skill validation (§10.8).
 */
export function policyOutlineProjection(
  scenes: readonly AppScene[],
  outline: OutlineRecord,
): SceneOutline[] {
  const byId = new Map(
    ((outline?.outlines ?? []) as SceneOutline[]).map((entry) => [entry.id, entry]),
  );
  return orderedScenes(scenes).map((scene) => {
    const stored = scene.outlineId !== undefined ? byId.get(scene.outlineId) : undefined;
    if (stored) return { ...stored, order: scene.order };
    const synthesized = outlineFromScene(scene as Scene, undefined) as SceneOutline;
    return {
      ...synthesized,
      ...(scene.teachingStage ? { teachingStage: scene.teachingStage } : {}),
      ...(scene.sourceContentUnitIds
        ? { sourceContentUnitIds: [...scene.sourceContentUnitIds] }
        : {}),
    } as SceneOutline;
  });
}

const STAGE_WIDE_CODES = new Set(['FLOW_SEQUENCE_INVALID', 'POSITION_CARDINALITY']);

/**
 * A diagnostic's stable identity across an insert (plan §9.4): outline-scoped
 * codes by `code | outlineId | field`; the stage-wide codes by
 * `code | flowIndex` (their first offending outline moves). Array indexes are
 * never part of it.
 */
export function diagnosticIdentity(diagnostic: OutlineDiagnostic): string {
  if (STAGE_WIDE_CODES.has(diagnostic.code)) {
    return `${diagnostic.code}|${diagnostic.flowIndex ?? ''}`;
  }
  return `${diagnostic.code}|${diagnostic.outlineId ?? ''}|${diagnostic.field ?? ''}`;
}

/**
 * The diagnostics the insertion would ADD: any on the new outline, plus any
 * identity present after and not before. Identities present before are
 * tolerated pre-existing drift (submit does not check scene policy, F15).
 */
export function newPolicyDiagnostics(
  before: readonly OutlineDiagnostic[],
  after: readonly OutlineDiagnostic[],
  newOutlineId: string,
): OutlineDiagnostic[] {
  const existing = new Set(before.map(diagnosticIdentity));
  return after.filter(
    (diagnostic) =>
      diagnostic.outlineId === newOutlineId || !existing.has(diagnosticIdentity(diagnostic)),
  );
}
