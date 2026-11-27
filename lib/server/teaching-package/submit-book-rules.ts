/**
 * g5.v12 (EN-6, critical items 27 Nov 2026): the book's coverage and order, re-checked at
 * Submit.
 *
 * The plan's gates run before any Scene is paid for. From there to Submit a person edits
 * the Stage (add, delete, drag, an AI insert, a review fix), and nothing re-checked the
 * book: Submit re-proved the flow, the games, the essential sections and the Skills, and
 * the AI reviewer's order findings are advisory only. So for a g5.v12 package the live
 * Stage is read as a plan again — each Scene's own citations, role and stage — and
 * diagnosed with the run's own rule set, rebuilt from what the attempt pinned: the typed
 * book, the lesson's parts, and the units the plan had to teach.
 *
 * Two refusals, both with a code the admin panel and the Agent API already read (no new
 * code reaches either):
 * - a section without its teaching slide, a check without its try-it or its solution, a
 *   solution before its try-it, or two checks on one slide is `ESSENTIAL_SECTION_UNCOVERED`
 *   with `details.unitIds`, which the Agent API turns into a "generate slide" fix (so it
 *   names only the units a new slide fixes: never a solution before its try-it), and the
 *   additive `details.findings` (`sceneId?`, `unitId?`, `code`, `message`) for each;
 * - a teaching slide out of the book's order is `TEACHING_MODEL_FLOW_MISMATCH` with
 *   `details.offendingSceneIds` and `reason: "book_order"`, which the editor highlights.
 *
 * Every other Teaching Model is not checked, exactly as before. Nothing here writes, and
 * no finding carries book text: ids, codes and the gate's own sentences only.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  readAllContentUnitsForVersion,
  readRetainedVersionContext,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  findBookCoverageGaps,
  isBookPartPlacementModel,
  isGuideAnswerModel,
  mergedCheckSlides,
  SUBMIT_RECHECKED_GAP_KINDS,
  withTypedPracticeUnits,
} from '@/lib/server/teaching-package/book-coverage';
import {
  bookPartMapFor,
  findBookOrderDiagnostics,
  listedPartUnitIds,
} from '@/lib/server/teaching-package/book-part-placement';
import { correctionCoverageBook } from '@/lib/server/teaching-package/outline-correction';
import {
  citedContentUnitIds,
  orderedScenes,
} from '@/lib/server/teaching-package/content-unit-coverage';
import { readSectionCoverageForVersion } from '@/lib/server/teaching-package/successor-model';
import { outlineFromScene, ownPlanSnapshot } from '@/lib/server/agent-runtime/generation-tools';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { TeachingModelLineage } from '@/lib/types/teaching-package';
import type { AppScene, Scene } from '@/lib/types/stage';

/** One book finding on the live Stage: the Scene it is about (none for a missing slide). */
export interface SubmitBookFinding {
  sceneId: string | null;
  /** The book unit the finding is about, when it is about one. */
  unitId: string | null;
  code: string;
  message: string;
  /**
   * A new slide cannot fix it (a solution before its try-it: move or delete that slide),
   * so its unit is not one of the refusal's `unitIds`, which the Agent API turns into a
   * "generate slide" fix (wave 1 review, L7).
   */
  notBySlide?: true;
}

export interface SubmitBookCheck {
  /** A section, a check pair or a merged check: `ESSENTIAL_SECTION_UNCOVERED`. */
  uncovered: SubmitBookFinding[];
  /** A slide out of the book's order: `TEACHING_MODEL_FLOW_MISMATCH`. */
  outOfOrder: SubmitBookFinding[];
}

/**
 * The live Stage as the plan the gates read: each Scene in play order, with its own
 * citations (`citedContentUnitIds`, Help's rule) and its own teaching stage. A Scene's
 * title, type and classification come from its own plan entry, never a neighbour's.
 */
function projectScenes(
  scenes: readonly AppScene[],
  outline: unknown,
): Array<{ scene: AppScene; outline: SceneOutline }> {
  const record = outline as Parameters<typeof citedContentUnitIds>[1];
  const snapshot = outline as AppDocumentOutline | undefined;
  return orderedScenes(scenes).map((scene) => ({
    scene,
    outline: {
      ...outlineFromScene(scene as unknown as Scene, ownPlanSnapshot(scene, snapshot, scenes)),
      id: scene.outlineId ?? scene.id,
      order: scene.order,
      ...(scene.teachingStage ? { teachingStage: scene.teachingStage } : {}),
      sourceContentUnitIds: citedContentUnitIds(scene, record),
      // What a slide says now is its Scene's, not its plan's: no gate here reads them.
      keyPoints: [],
      description: '',
    } as SceneOutline,
  }));
}

/**
 * Re-check a g5.v12 package's book coverage and order on its live Stage. `null` on every
 * other Teaching Model, and on a v12 package whose attempt pinned no book map or flow
 * (then, as for every gate without its authority, nothing is checked).
 */
export async function checkSubmitBookRules(
  pool: Queryable,
  version: { id: string; tenantId: string; teachingModel: TeachingModelLineage },
  scenes: readonly AppScene[],
  outline: unknown,
): Promise<SubmitBookCheck | null> {
  if (!isBookPartPlacementModel(version.teachingModel)) return null;
  const scope = { tenantId: version.tenantId };
  const snapshot = (await readRetainedVersionContext(pool, version.id, scope))?.inputSnapshot;
  const flow = snapshot?.teachingFlow;
  if (!snapshot?.bookStructure || !flow || flow.length === 0) return null;
  const [coverage, retained] = await Promise.all([
    readSectionCoverageForVersion(pool, version.id),
    readAllContentUnitsForVersion(pool, version.id, scope),
  ]);
  // The same typed book the run read (an untyped practice unit is an exercise), when the
  // retained units can be read; without them the parts cannot be rebuilt, so only the
  // book map's own required units and checks are checked.
  const book = isGuideAnswerModel(version.teachingModel)
    ? withTypedPracticeUnits(
        snapshot.bookStructure,
        retained.units.map((unit) => ({ id: unit.unitId, role: unit.role, subtype: unit.subtype })),
      )
    : snapshot.bookStructure;
  const parts =
    retained.units.length > 0
      ? bookPartMapFor(version.teachingModel, book, snapshot.learningObjectives, flow)
      : null;
  // The run's rule (wave 1 review, H1): a listed unit is required taught only when it has
  // retainable text — a retained row, the same rule and the same source the run read.
  const retainedIds = new Set(retained.units.map((unit) => String(unit.unitId)));
  const taughtContentUnitIds = parts
    ? [
        ...new Set([
          ...listedPartUnitIds(parts).filter((id) => retainedIds.has(id)),
          ...(coverage?.essentialContentUnitIds ?? []).map(String),
        ]),
      ]
    : undefined;
  const coverageBook = correctionCoverageBook(
    {
      essentialContentUnitIds: coverage?.essentialContentUnitIds,
      bookUnitFacts: undefined,
      ...(taughtContentUnitIds ? { taughtContentUnitIds } : {}),
    },
    book,
    version.teachingModel,
    undefined,
    parts,
  );
  if (!coverageBook) return null;
  const projected = projectScenes(scenes, outline);
  // By play position, never by outline id: two Scenes may share one plan entry (wave 1
  // review, L6).
  const sceneAt = (index: number | undefined): string | null =>
    index === undefined ? null : (projected[index]?.scene.id ?? null);
  const asPlanned = projected.map(({ outline: entry }) => entry);
  const cites = (entry: SceneOutline, unitId: string) =>
    (entry.sourceContentUnitIds ?? []).some((id) => String(id) === unitId);
  // A solution before its try-it is fixed by moving or deleting THAT slide, so the
  // finding names it (wave 1 re-review, N4): the first solution citing the check that
  // comes before the check's first try-it.
  const earlySolutionAt = (unitId: string): number | undefined => {
    const tryAt = asPlanned.findIndex(
      (entry) => entry.contentRole === 'check_understanding' && cites(entry, unitId),
    );
    if (tryAt < 0) return undefined;
    const at = asPlanned
      .slice(0, tryAt)
      .findIndex((entry) => entry.contentRole === 'worked_example' && cites(entry, unitId));
    return at < 0 ? undefined : at;
  };
  const gaps = findBookCoverageGaps(asPlanned, coverageBook)
    // The gaps that need no unit facts: a section without its slide, a check without its
    // try-it or its solution, a solution before its try-it. The recall and the exercises
    // blocks are judged against facts the attempt pinned only on a checkpoint (which items
    // survived the verse strip), so they are not re-judged here (review 27 Nov 2026, LOW).
    .filter((gap) => SUBMIT_RECHECKED_GAP_KINDS.has(gap.kind))
    .map((gap) => {
      const early = gap.kind === 'solution_before_try_it';
      return {
        sceneId: early ? sceneAt(earlySolutionAt(gap.unit.contentUnitId)) : null,
        unitId: gap.unit.contentUnitId,
        code: 'BOOK_COVERAGE_INCOMPLETE',
        message: gap.message,
        ...(early ? { notBySlide: true as const } : {}),
      };
    });
  const merged = mergedCheckSlides(asPlanned, coverageBook).map((group) => ({
    sceneId: sceneAt(group.index),
    unitId: null,
    code: 'CHECKS_MERGED',
    message: `slide ${group.index + 1} «${group.outline.title ?? ''}» sets or solves the checks ${group.units
      .map((unit) => unit.contentUnitId)
      .join(', ')} on one slide; one try-it slide and one solution slide per check`,
  }));
  const order = parts
    ? findBookOrderDiagnostics(asPlanned, parts, flow).map((diagnostic) => ({
        sceneId: sceneAt(diagnostic.outlineIndex),
        unitId: null,
        code: diagnostic.code,
        message: diagnostic.message,
      }))
    : [];
  return { uncovered: [...gaps, ...merged], outOfOrder: order };
}

/** The refusal for a section or a check pair the live Stage no longer has, or `null`. */
export function uncoveredSectionsRefusal(
  check: SubmitBookCheck | null,
): TeachingPackageError | null {
  if (!check || check.uncovered.length === 0) return null;
  const unitIds = [
    ...new Set(
      check.uncovered
        .filter((finding) => finding.notBySlide !== true)
        .map((finding) => finding.unitId)
        .filter((unitId): unitId is string => unitId !== null),
    ),
  ];
  return new TeachingPackageError(
    'ESSENTIAL_SECTION_UNCOVERED',
    `${check.uncovered.length} book section(s) are missing a slide the lesson must have (a teaching slide, a check's try-it or solution, or one check per slide); fix each before submitting`,
    {
      unitIds,
      findings: check.uncovered.map(({ sceneId, unitId, code, message }) => ({
        ...(sceneId ? { sceneId } : {}),
        ...(unitId ? { unitId } : {}),
        code,
        message,
      })),
    },
  );
}

/** The refusal for a slide the live Stage holds out of the book's order, or `null`. */
export function bookOrderRefusal(check: SubmitBookCheck | null): TeachingPackageError | null {
  if (!check || check.outOfOrder.length === 0) return null;
  const offendingSceneIds = [
    ...new Set(
      check.outOfOrder
        .map((finding) => finding.sceneId)
        .filter((sceneId): sceneId is string => sceneId !== null),
    ),
  ];
  return new TeachingPackageError(
    'TEACHING_MODEL_FLOW_MISMATCH',
    `the scene sequence does not follow the book (${check.outOfOrder[0]!.message}${
      check.outOfOrder.length > 1 ? `; +${check.outOfOrder.length - 1} more` : ''
    }); move each listed slide to its place in the book`,
    {
      reason: 'book_order',
      offendingSceneIds,
      findings: check.outOfOrder.map(({ sceneId, code, message }) => ({
        ...(sceneId ? { sceneId } : {}),
        code,
        message,
      })),
    },
  );
}
