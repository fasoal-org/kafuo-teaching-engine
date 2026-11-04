/**
 * g5.v7: re-plan a slide the book-coverage gate found missing (plan P-6,
 * `docs/frds/g5-v7-coverage-gap-auto-replan-plan-2026-10-31.md`).
 *
 * Runs on a candidate outline list BEFORE the run pauses for a person, and
 * only when every blocking finding is a book-coverage gap the plan can place
 * (`findBookCoverageGaps` gives each gap its anchor slide). Each gap gets ONE
 * slide from the reviewer-slide planner (`planInsertedSlide`, which re-asks
 * once on its own), inserted right after its anchor; the whole candidate is
 * then diagnosed again. At most {@link BOOK_COVERAGE_REPAIR_ROUNDS} rounds:
 * whatever is still open pauses on the existing correction path, unchanged.
 *
 * The planner's instruction is written here, never by the model, and names
 * only the role and the unit. Lesson text is never logged.
 */
import { scenePolicyFor, type AICallFn, type OutlineDiagnostic } from '@openmaic/generation';

import { createLogger } from '@/lib/logger';
import {
  BOOK_COVERAGE_INCOMPLETE,
  EXERCISE_CAP_EXCEEDED,
  EXERCISE_SELECTED_MISSING,
  EXERCISE_TOO_FEW,
  EXERCISE_UNSELECTED_CITED,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  duplicateSolutionSlides,
  findBookCoverageGaps,
  isSacredExerciseElement,
  RECALL_NOT_FIRST,
  recallPlacement,
  SOLUTION_SLIDES_DUPLICATED,
  WORKING_STEP_MISSING,
  type BookCoverageGap,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import { checkItemLabels } from '@/lib/server/teaching-package/hidden-step-types';
import {
  planInsertedSlide,
  type PlanCheck,
  type PlannerSkillOption,
  type PlannerUnit,
} from '@/lib/server/teaching-package/plan-inserted-slide';
import { withoutSacredItems } from '@/lib/server/teaching-package/sacred-text';
import type { SceneOutline } from '@/lib/types/generation';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';

const log = createLogger('BookCoverageRepair');

/** P-6: the missing part is re-planned at most twice. */
export const BOOK_COVERAGE_REPAIR_ROUNDS = 2;

export interface BookCoverageRepairContext {
  book: CoverageBookStructure;
  flow: readonly TeachingFlowEntry[];
  /** The retained source units the outline prompt read, with their text. */
  units: readonly PlannerUnit[];
  /** The position's Skills (governed runs); `null` on an ungoverned run. */
  skillOptions: ((entry: TeachingFlowEntry) => PlannerSkillOption[]) | null;
  language: string;
  languageDirective: string;
  /**
   * The screened (approved) textbook visuals the outline model saw. A slide must
   * select a visual linked to a unit it cites (`SOURCE_VISUAL_NOT_SELECTED`), so
   * the planner is offered exactly those, with their bytes.
   */
  visuals: ReadonlyArray<{
    id: string;
    src: string;
    width?: number;
    height?: number;
    description?: string;
    sourceContentUnitIds?: readonly string[];
  }>;
  /** The one full diagnosis of a candidate: normalized outlines + blocking findings. */
  diagnose: (outlines: SceneOutline[]) => {
    outlines: SceneOutline[];
    blocking: OutlineDiagnostic[];
  };
  /** Test seam. */
  plan?: typeof planInsertedSlide;
}

export interface BookCoverageRepairResult {
  outlines: SceneOutline[];
  blocking: OutlineDiagnostic[];
  inserted: number;
  /** g5.v8: solution slides merged away plus a recall slide moved (no model call). */
  restructured: number;
}

/**
 * g5.v8: a gap this module placed itself (an anchorless teaching gap), with
 * the content role its flow position allows.
 */
type PlacedGap = BookCoverageGap & { placedRole?: string };

/** The content role the missing slide must carry. */
function roleFor(gap: PlacedGap): string {
  if (gap.placedRole) return gap.placedRole;
  if (gap.kind === 'missing_solution') return 'worked_example';
  if (gap.kind === 'missing_try_it') return 'check_understanding';
  // g5.v8: the recall slide is an explanation (kind definition), not a new kind.
  if (gap.kind === 'missing_recall') return 'explanation';
  if (gap.unit.element === 'worked_example') return 'worked_example';
  if (gap.unit.element === 'try_it') return 'check_understanding';
  return 'explanation';
}

/**
 * The planner instruction for a gap; also the description of an admin-inserted
 * slide. `parity` (g5.v8) selects the one-solution-slide wording.
 */
export function instructionFor(gap: PlacedGap, parity = false): string {
  const id = gap.unit.contentUnitId;
  const example = gap.unit.pairedExampleUnitId;
  if (gap.kind === 'missing_solution' && gap.itemLabel) {
    // A per-item gap from an older pinned correction (D-2 B). Since 4 Nov 2026
    // the gate asks for one solution slide per check, without an item label.
    return (
      `Plan ONE solution slide (contentRole worked_example) for item ${gap.itemLabel} only of the book check in content unit ${id}: ` +
      `work that item alone step by step to a final answer with this part's decision rule, writing every hidden step as its own key point` +
      (example ? `, the way the book's example in unit ${example} is solved.` : '.') +
      ' The book prints no answer, so work it from the given data; a guess or prediction item gets a reasoned number stated as an estimate.'
    );
  }
  if (gap.kind === 'missing_recall') {
    return (
      `Plan the recall slide (contentRole explanation, contentKind definition) that opens part 1 and cites content units ${(gap.citeUnitIds ?? [id]).join(', ')}: ` +
      'the prior facts this lesson uses but does not teach, each in one line with a one-line example. Teach nothing new from this lesson.'
    );
  }
  if (gap.kind === 'missing_solution' && !parity) {
    // g5.v7 (E-5): the wording it shipped with, byte for byte.
    return (
      `Plan the solution slide (contentRole worked_example) for the book check in content unit ${id}: ` +
      `work each of its items step by step to a final answer with this part's decision rule` +
      (example ? `, the way the book's example in unit ${example} is solved.` : '.') +
      ' The book prints no answer, so work it from the given data; a guess or prediction item gets a reasoned number stated as an estimate.'
    );
  }
  if (gap.kind === 'missing_solution') {
    return (
      `Plan the solution slide (contentRole worked_example) for the book check in content unit ${id}: ` +
      `work ALL of its items together on this one slide, each step by step to a final answer with this part's decision rule` +
      (example ? `, the way the book's example in unit ${example} is solved.` : '.') +
      ' The book prints no answer, so work it from the given data; a guess or prediction item gets a reasoned number stated as an estimate.' +
      ' An item that leaves the sentence to the learner gets one correct model answer, stated as an example and never a Quran verse or hadith; never say the text is unclear and never send the learner to the book.'
    );
  }
  if (gap.kind === 'missing_try_it') {
    return (
      `Plan the try-it slide (contentRole check_understanding) that sets the book check in content unit ${id} ` +
      `for the learner, without its answer.`
    );
  }
  return `Plan the slide (contentRole ${roleFor(gap)}) that teaches content unit ${id} as the book prints it.`;
}

/** Only gaps the plan can place, and only when nothing else blocks. */
function repairableGaps(
  outlines: readonly SceneOutline[],
  blocking: readonly OutlineDiagnostic[],
  book: CoverageBookStructure,
  flow: readonly TeachingFlowEntry[],
): PlacedGap[] | null {
  if (blocking.length === 0) return null;
  // g5.v8: its own findings (caps, placement, visible working) are a person's to
  // fix and stay open, but they never stop the slides the plan can place.
  const parity = book.teacherParity === true;
  if (
    blocking.some(
      (issue) =>
        issue.code !== BOOK_COVERAGE_INCOMPLETE &&
        !(parity && TEACHER_PARITY_FINDINGS.has(issue.code)),
    )
  ) {
    return null;
  }
  // A check with no try-it is also reported as untaught; its one try-it slide
  // answers both, so it is planned once.
  const tryItMissing = new Set<string>();
  const found = findBookCoverageGaps(outlines, book).map((gap) =>
    parity ? placeAnchorlessTeaching(gap, outlines, book, flow) : gap,
  );
  for (const gap of found) {
    if (gap.kind === 'missing_try_it') tryItMissing.add(gap.unit.contentUnitId);
  }
  // g5.v8: a check solved before its try-it is a person's to move, so none of
  // its gaps are planned around it.
  const solvedEarly = new Set(
    parity
      ? found
          .filter((gap) => gap.kind === 'solution_before_try_it')
          .map((gap) => gap.unit.contentUnitId)
      : [],
  );
  const gaps = found.filter(
    (gap) =>
      !(gap.kind === 'missing_teaching' && tryItMissing.has(gap.unit.contentUnitId)) &&
      // g5.v8: a new kind the plan cannot place (no anchor) is left to a person
      // instead of blocking every other repair.
      !(parity && gap.anchorIndex === undefined && TEACHER_PARITY_KINDS.has(gap.kind)) &&
      // g5.v8 (lessons 314/315/318): any gap the plan cannot place stays open
      // for a person, but never stops the checks the plan can place.
      !(parity && (gap.anchorIndex === undefined || solvedEarly.has(gap.unit.contentUnitId))),
  );
  if (gaps.length === 0 || gaps.some((gap) => gap.anchorIndex === undefined)) return null;
  return gaps;
}

/** Intro-style book kinds: their slide orients the part when its position allows it. */
const INTRO_KIND = /INTRO|OPENING|PREFACE|OVERVIEW/i;

/**
 * g5.v8 (lessons 308/313/315/318): a teaching gap with no anchor (the unit
 * opens its part K, so no earlier slide of the part cites a neighbour) goes
 * immediately BEFORE the first slide citing a later unit of part K (its
 * transition or first explanation), taking that slide's teaching stage; when
 * part K has no slide yet, right after the last slide of part K-1. Its role is
 * the one that stage allows: explanation, or orientation for an intro. No
 * valid position or role: the gap stays anchorless, a person's.
 */
function placeAnchorlessTeaching(
  gap: BookCoverageGap,
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
  flow: readonly TeachingFlowEntry[],
): PlacedGap {
  if (gap.kind !== 'missing_teaching' || gap.anchorIndex !== undefined) return gap;
  const part = gap.unit.partIndex;
  if (part === undefined) return gap;
  const position = book.units.indexOf(gap.unit);
  const idsWhere = (predicate: (unit: BookCoverageGap['unit'], index: number) => boolean) =>
    new Set(book.units.filter(predicate).map((unit) => String(unit.contentUnitId)));
  const citesAny = (outline: SceneOutline, ids: ReadonlySet<string>) =>
    outline.type === 'slide' &&
    (outline.sourceContentUnitIds ?? []).some((id) => ids.has(String(id)));
  const later = idsWhere((unit, index) => index > position && unit.partIndex === part);
  const partIds = idsWhere((unit) => unit.partIndex === part);
  // E-4: an opening or exactly-one stage (lesson_opener, lesson_learning_map)
  // never takes a second slide, so its slides are never the one to go before.
  const singleStage = (outline: SceneOutline) => {
    const stage = outline.teachingStage;
    if (!stage) return false;
    if (/^lesson_(opener|learning_map)$/.test(stage.key)) return true;
    const entry = flow[stage.flowIndex];
    return entry?.stage === stage.key && scenePolicyFor(entry)?.cardinality === 'exactly_one';
  };
  const before = outlines.findIndex((outline) => citesAny(outline, later) && !singleStage(outline));
  let anchorIndex: number | undefined;
  let stageIndex: number | undefined;
  if (before > 0) {
    anchorIndex = before - 1;
    stageIndex = before;
  } else if (
    before < 0 &&
    !outlines.some((outline) => citesAny(outline, partIds) && !singleStage(outline))
  ) {
    const previous = idsWhere((unit) => unit.partIndex === part - 1);
    for (let index = outlines.length - 1; index >= 0; index -= 1) {
      if (citesAny(outlines[index]!, previous) && !singleStage(outlines[index]!)) {
        anchorIndex = index;
        stageIndex = index;
        break;
      }
    }
  }
  if (anchorIndex === undefined || stageIndex === undefined) return gap;
  const stage = outlines[stageIndex]?.teachingStage;
  const entry = stage ? flow[stage.flowIndex] : undefined;
  if (!stage || !entry) return gap;
  const allowed: readonly string[] | undefined =
    entry.stage === stage.key ? scenePolicyFor(entry)?.contentRoles : undefined;
  const intro = INTRO_KIND.test(String(gap.unit.kind ?? ''));
  const base = roleFor(gap);
  const preferred =
    intro && base === 'explanation'
      ? ['orientation', 'explanation']
      : base === 'explanation'
        ? ['explanation', 'orientation']
        : [base];
  const placedRole = allowed ? preferred.find((role) => allowed.includes(role)) : base;
  if (!placedRole) return gap;
  return {
    ...gap,
    anchorIndex,
    ...(stageIndex !== anchorIndex ? { stageFromIndex: stageIndex } : {}),
    placedRole,
  };
}

const TEACHER_PARITY_FINDINGS: ReadonlySet<string> = new Set([
  EXERCISE_CAP_EXCEEDED,
  EXERCISE_SELECTED_MISSING,
  EXERCISE_TOO_FEW,
  EXERCISE_UNSELECTED_CITED,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  WORKING_STEP_MISSING,
  RECALL_NOT_FIRST,
  SOLUTION_SLIDES_DUPLICATED,
]);

/** The most key points a merged solution slide keeps (its points join, never drop). */
const MERGED_SOLUTION_MAX_POINTS = 8;

/**
 * g5.v8 (owner, 4 Nov 2026), deterministic, no model call: each check keeps
 * ONE solution slide — the first; the others' cited units, key points and
 * selected visuals join it, and the others are removed. Exercise slides are
 * never touched. Returns the new list and how many slides were removed.
 */
export function mergeDuplicateSolutions(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; merged: number } {
  let current = [...outlines];
  let merged = 0;
  for (;;) {
    const group = duplicateSolutionSlides(current, book)[0];
    if (!group) break;
    const [keep, ...rest] = group.indexes;
    const others = rest.map((index) => current[index]!);
    const kept = current[keep!]!;
    const unique = <T>(values: T[]) => [...new Set(values.map(String))] as unknown as T[];
    // E-2: a removed slide's title (and a meaningful description) can carry a
    // worked step, so it joins the kept slide as that slide's first lines.
    const folded = (outline: SceneOutline) => {
      const title = outline.title?.trim() ?? '';
      const description = outline.description?.trim() ?? '';
      return [
        ...(title !== '' && title !== kept.title?.trim() ? [title] : []),
        ...(description !== '' && description !== title && description !== kept.description?.trim()
          ? [description]
          : []),
        ...(outline.keyPoints ?? []),
      ];
    };
    const keyPoints = [...(kept.keyPoints ?? []), ...others.flatMap(folded)];
    const images = unique([kept, ...others].flatMap((outline) => outline.suggestedImageIds ?? []));
    const plans = [kept, ...others].flatMap((outline) => outline.imagePlans ?? []);
    current[keep!] = {
      ...kept,
      sourceContentUnitIds: unique(
        [kept, ...others].flatMap((outline) => outline.sourceContentUnitIds ?? []),
      ),
      keyPoints: spreadOverPoints(keyPoints, MERGED_SOLUTION_MAX_POINTS),
      ...(images.length > 0 ? { suggestedImageIds: images } : {}),
      ...(plans.length > 0
        ? {
            imagePlans: plans.filter(
              (plan, i) => plans.findIndex((p) => p.imageId === plan.imageId) === i,
            ),
          }
        : {}),
    } as SceneOutline;
    const removed = new Set(rest);
    current = current.filter((_, index) => !removed.has(index));
    merged += rest.length;
  }
  return { outlines: current, merged };
}

/**
 * g5.v8, deterministic: a recall slide planned after part 1's first teaching
 * slide moves right before it, taking that slide's teaching stage.
 */
export function moveRecallFirst(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; moved: boolean } {
  const { recall, first } = recallPlacement(outlines, book);
  if (recall === undefined || first === undefined || recall < first) {
    return { outlines: [...outlines], moved: false };
  }
  const current = [...outlines];
  const [slide] = current.splice(recall, 1);
  const stage = current[first]!.teachingStage;
  current.splice(first, 0, { ...slide!, ...(stage ? { teachingStage: { ...stage } } : {}) });
  return { outlines: current, moved: true };
}

const TEACHER_PARITY_KINDS: ReadonlySet<string> = new Set(['missing_recall', 'missing_exercises']);

export async function repairBookCoverageGaps(
  candidate: readonly SceneOutline[],
  blocking: readonly OutlineDiagnostic[],
  aiCall: AICallFn,
  context: BookCoverageRepairContext,
): Promise<BookCoverageRepairResult> {
  let outlines = [...candidate];
  let open = [...blocking];
  let inserted = 0;
  let restructured = 0;
  // g5.v8: one solution slide per check and recall first are fixed without a
  // model call, before any slide is planned, then the candidate is re-diagnosed.
  if (
    context.book.teacherParity === true &&
    open.some(
      (issue) => issue.code === SOLUTION_SLIDES_DUPLICATED || issue.code === RECALL_NOT_FIRST,
    )
  ) {
    // E-3: a step is kept only when it adds no new finding code outside the
    // g5.v8 set; otherwise the plan stays as it was and the step counts 0.
    const before = new Set(blocking.map((issue) => issue.code));
    const accept = (next: readonly SceneOutline[]) => {
      const diagnosed = context.diagnose(
        next.map((outline, index) => ({ ...outline, order: index + 1 })),
      );
      const added = diagnosed.blocking.some(
        (issue) => !before.has(issue.code) && !TEACHER_PARITY_FINDINGS.has(issue.code),
      );
      if (added) return false;
      outlines = diagnosed.outlines;
      open = diagnosed.blocking;
      return true;
    };
    const merged = mergeDuplicateSolutions(outlines, context.book);
    const mergeKept = merged.merged > 0 && accept(merged.outlines);
    const moved = moveRecallFirst(outlines, context.book);
    const moveKept = moved.moved && accept(moved.outlines);
    restructured = (mergeKept ? merged.merged : 0) + (moveKept ? 1 : 0);
    if (merged.merged > 0 || moved.moved) {
      log.info(
        `book coverage repair: ${mergeKept ? merged.merged : 0} solution slide(s) merged${merged.merged > 0 && !mergeKept ? ' (rolled back)' : ''}, recall ${moveKept ? 'moved first' : moved.moved ? 'move rolled back' : 'unchanged'}, ${open.length} issue(s) open`,
      );
    }
  }
  // M-3 (4 Nov 2026 rule): on a g5.v8 run an exercise or «تأكد» check unit
  // reaches the planner and the fallback slide without its verse and hadith items.
  const sacredExercise = new Set(
    context.book.teacherParity === true
      ? context.book.units.filter(isSacredExerciseElement).map((unit) => String(unit.contentUnitId))
      : [],
  );
  const unitsById = new Map(
    context.units.map((unit) => [
      unit.id,
      sacredExercise.has(String(unit.id)) ? { ...unit, text: withoutSacredItems(unit.text) } : unit,
    ]),
  );

  for (let round = 1; round <= BOOK_COVERAGE_REPAIR_ROUNDS; round += 1) {
    const gaps = repairableGaps(outlines, open, context.book, context.flow);
    if (!gaps) break;
    // Insert from the last anchor backwards, so earlier anchors keep their index.
    // g5.v8 only: gaps sharing one anchor (a check's items) go in last-first, so
    // they land in book order; g5.v7 keeps its order exactly.
    const position = new Map(gaps.map((gap, index) => [gap, index] as const));
    const ordered = [...gaps].sort(
      (a, b) =>
        (b.anchorIndex ?? 0) - (a.anchorIndex ?? 0) ||
        (context.book.teacherParity ? position.get(b)! - position.get(a)! : 0),
    );
    let planned = 0;
    for (const gap of ordered) {
      const outline = await planGap(gap, round);
      if (!outline) continue;
      outlines.splice(gap.anchorIndex! + 1, 0, outline);
      planned += 1;
      // g5.v8: a new try-it's solution goes right after it in the same round,
      // so try-it → solution → per-item solutions fit the two rounds.
      if (context.book.teacherParity === true && gap.kind === 'missing_try_it') {
        const solution = await planGap(
          {
            kind: 'missing_solution',
            unit: gap.unit,
            message: '',
            anchorIndex: gap.anchorIndex! + 1,
          },
          round,
        );
        if (solution) {
          outlines.splice(gap.anchorIndex! + 2, 0, solution);
          planned += 1;
        }
      }
    }
    if (planned === 0) break;
    inserted += planned;
    const diagnosed = context.diagnose(
      outlines.map((outline, index) => ({ ...outline, order: index + 1 })),
    );
    outlines = diagnosed.outlines;
    open = diagnosed.blocking;
    log.info(
      `book coverage repair round ${round}: ${planned} slide(s) inserted, ${open.length} issue(s) open`,
    );
    if (open.length === 0) break;
  }
  return { outlines, blocking: open, inserted, restructured };

  /** One slide for `gap`, right after its anchor in the current `outlines`; `null` when none. */
  async function planGap(gap: PlacedGap, round: number): Promise<SceneOutline | null> {
    {
      const anchor = outlines[gap.anchorIndex!]!;
      // g5.v8 recall: the slide takes part 1's teaching stage, not the opener's;
      // a placed teaching gap takes the stage of the slide it goes before.
      const stageSlide =
        gap.stageFromIndex !== undefined ? (outlines[gap.stageFromIndex] ?? anchor) : anchor;
      const stage = stageSlide.teachingStage;
      const flowEntry = stage ? context.flow[stage.flowIndex] : undefined;
      if (!stage || !flowEntry) return null;
      const unitId = gap.unit.contentUnitId;
      const unitIds = gap.citeUnitIds?.length ? [...gap.citeUnitIds] : [unitId];
      const contextIds = [...unitIds, gap.unit.pairedExampleUnitId].filter(
        (id): id is string => typeof id === 'string',
      );
      const units = contextIds.flatMap((id) => {
        const unit = unitsById.get(id);
        return unit ? [unit] : [];
      });
      if (!units.some((unit) => unit.id === unitId)) return null;
      const role = roleFor(gap);
      const policy = flowEntry.stage === stage.key ? scenePolicyFor(flowEntry) : undefined;
      const unitVisuals = context.visuals.filter((visual) =>
        (visual.sourceContentUnitIds ?? []).some((id) => unitIds.includes(String(id))),
      );
      // g5.v8: one more solution slide of a check whose image another slide
      // already shows gets a native diagram, never the same image again (I-4.3).
      const shownElsewhere =
        context.book.teacherParity === true &&
        gap.itemLabel !== undefined &&
        outlines.some((outline) =>
          (outline.suggestedImageIds ?? []).some((id) =>
            unitVisuals.some((visual) => visual.id === id),
          ),
        );
      const linked = shownElsewhere ? [] : unitVisuals;
      const check = (outline: SceneOutline): PlanCheck => {
        const messages: string[] = [];
        if (outline.contentRole !== role || outline.slideType !== 'content') {
          messages.push(`the slide must be a content slide with contentRole ${role}`);
        }
        const selected = new Set(outline.suggestedImageIds ?? []);
        if (linked.length > 0 && !linked.some((visual) => selected.has(visual.id))) {
          messages.push(
            `set visualPlan.mode "image" and include one of these textbook visuals in suggestedImageIds: ${linked
              .map((visual) => visual.id)
              .join(', ')}`,
          );
        }
        // An inserted slide must never block on its own visual plan (lesson 318).
        if (outline.visualPlan?.mode === 'native' && !isTeachingNote(outline.visualPlan.diagram)) {
          messages.push(
            'a "native" visualPlan must carry "diagram": { "shows", "teachingPoint" } (both non-empty)',
          );
        }
        return messages.length === 0
          ? { ok: true, outline, repairs: [] }
          : { ok: false, fixable: true, code: 'INSERTION_PLAN_INVALID', messages };
      };
      // A check's items share kind, unit and anchor: the item keeps ids distinct.
      const outlineId = `${anchor.id}-book-${gap.kind}-${unitId}${gap.itemLabel ? `-${gap.itemLabel}` : ''}-r${round}`;
      const result = await (context.plan ?? planInsertedSlide)({
        units,
        unitIds,
        flowEntry,
        teachingStage: stage,
        allowedSkills: context.skillOptions ? context.skillOptions(flowEntry) : null,
        previousTitle: anchor.title ?? null,
        nextTitle: outlines[gap.anchorIndex! + 1]?.title ?? null,
        language: context.language,
        languageDirective: context.languageDirective,
        eligibleVisuals: linked.map((visual) => ({
          id: visual.id,
          ...(visual.description ? { description: visual.description } : {}),
        })),
        visionImages: linked.map((visual) => ({
          id: visual.id,
          src: visual.src,
          ...(visual.width !== undefined ? { width: visual.width } : {}),
          ...(visual.height !== undefined ? { height: visual.height } : {}),
        })),
        instruction: instructionFor(gap, context.book.teacherParity === true),
        outlineId,
        order: gap.anchorIndex! + 2,
        check,
        aiCall,
      });
      if (result.ok) return result.outline;
      {
        // The reason's template wording only: quoted values and any non-ASCII
        // run (lesson text) are blanked, and a provider's own error text is cut.
        const reason = result.message
          .replace(
            /the slide could not be planned \([\s\S]*$/,
            'the slide could not be planned (model call failed)',
          )
          .replace(/"[^"]*"/g, '"…"')
          .replace(/[^\x20-\x7E]+/g, '…')
          .slice(0, 400);
        log.warn(
          `book coverage repair could not plan a ${gap.kind} slide (${result.code}): ${reason}`,
        );
      }
      // g5.v8: a check's try-it or solution slide is built from the book itself
      // when the planner fails, so the run never pauses on it (lessons 314/315/318).
      if (context.book.teacherParity !== true) return null;
      if (
        gap.kind !== 'missing_try_it' &&
        gap.kind !== 'missing_solution' &&
        gap.placedRole === undefined
      ) {
        return null;
      }
      if (policy?.contentRoles && !policy.contentRoles.includes(role as never)) return null;
      const fallback = bookCheckSlide({
        gap,
        role,
        anchor,
        stageSlide,
        outlines,
        outlineId,
        text: unitsById.get(unitId)?.text ?? '',
        unitTitle: unitsById.get(unitId)?.title ?? null,
        language: context.language,
        imageId: linked[0]?.id,
        visualRequired: policy?.visual !== undefined,
      });
      const checked = check(fallback);
      if (!checked.ok) return null;
      log.info(`book coverage repair built a ${gap.kind} slide from the book check`);
      return checked.outline;
    }
  }
}

/** Both fields of a visual teaching note are non-empty strings. */
function isTeachingNote(note: unknown): boolean {
  const candidate = note as { shows?: unknown; teachingPoint?: unknown } | null | undefined;
  return (
    typeof candidate?.shows === 'string' &&
    candidate.shows.trim() !== '' &&
    typeof candidate.teachingPoint === 'string' &&
    candidate.teachingPoint.trim() !== ''
  );
}

/**
 * A complete visual teaching note read from the slide's own title and key
 * points, for a slide the engine (not the planner) builds: a native diagram
 * without one blocks as VISUAL_TEACHING_NOTE_MISSING.
 */
export function teachingNoteFrom(outline: {
  title?: string;
  keyPoints?: readonly string[];
  description?: string;
}): { shows: string; teachingPoint: string } {
  const title = (outline.title ?? '').trim();
  const point =
    (outline.keyPoints ?? []).map((text) => text.trim()).find((text) => text !== '') ??
    (outline.description ?? '').trim();
  const shows = (title || point || 'the book check').slice(0, 300);
  return { shows, teachingPoint: (point || shows).slice(0, 300) };
}

/**
 * The solution slide's title in the lesson's own language, read from the
 * try-it title it follows: «جرّب: تخمينات» → «الحل: تخمينات».
 */
export function solutionTitle(tryItTitle: string): string {
  const topic = tryItTitle.replace(/^[^:：]{1,20}[:：]\s*/, '').trim() || tryItTitle;
  return /[؀-ۿ]/.test(tryItTitle) ? `الحل: ${topic}` : `Solution: ${topic}`;
}

/** The try-it slide's title, in the lesson's language. */
function tryItTitle(topicSource: string, language: string): string {
  const topic = topicSource.replace(/^[^:：]{1,20}[:：]\s*/, '').trim() || topicSource;
  return /[؀-ۿ]/.test(topic) || language.startsWith('ar') ? `جرّب: ${topic}` : `Try it: ${topic}`;
}

/** The most key points a deterministic try-it slide carries. */
const TRY_IT_MAX_POINTS = 6;

/** The lines, in order, grouped into at most `max` points (a point joins its lines). */
function spreadOverPoints(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines];
  const points: string[] = [];
  const size = Math.ceil(lines.length / max);
  for (let start = 0; start < lines.length; start += size) {
    points.push(lines.slice(start, start + size).join('\n'));
  }
  return points;
}

/**
 * g5.v8: the deterministic try-it or solution slide of a book check. A try-it
 * sets the check's own lines (the book prints no answer); a solution carries
 * the try-it's items as its key points (one item's points for an item slide).
 * The visual is the check's textbook image, a native diagram with a complete
 * note when the position requires a visual, or none.
 */
function bookCheckSlide(input: {
  gap: PlacedGap;
  role: string;
  anchor: SceneOutline;
  /** The slide whose teaching stage and Skills the new slide takes. */
  stageSlide: SceneOutline;
  outlines: readonly SceneOutline[];
  outlineId: string;
  text: string;
  unitTitle: string | null;
  language: string;
  imageId: string | undefined;
  visualRequired: boolean;
}): SceneOutline {
  const { gap, anchor, stageSlide } = input;
  const unitId = gap.unit.contentUnitId;
  let title: string;
  let keyPoints: string[];
  if (gap.placedRole !== undefined) {
    // A placed teaching gap: the unit's own lines, as the book prints them.
    title = input.unitTitle?.trim() || unitId;
    keyPoints = spreadOverPoints(
      input.text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^\[\[/.test(line)),
      TRY_IT_MAX_POINTS,
    );
  } else if (gap.kind === 'missing_try_it') {
    title = tryItTitle(input.unitTitle?.trim() || anchor.title || unitId, input.language);
    // L-5: every line of the check is set; more than six lines share the six
    // points in book order, so no item is ever dropped.
    keyPoints = spreadOverPoints(
      input.text
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^\[\[/.test(line)),
      TRY_IT_MAX_POINTS,
    );
  } else {
    const tryIt =
      input.outlines.find(
        (outline) =>
          outline.contentRole === 'check_understanding' &&
          (outline.sourceContentUnitIds ?? []).some((id) => String(id) === unitId),
      ) ?? anchor;
    const label = gap.itemLabel;
    title = `${solutionTitle(tryIt.title ?? unitId)}${label ? ` (${label})` : ''}`;
    keyPoints = (tryIt.keyPoints ?? []).filter((point) => {
      if (label === undefined) return true;
      const labels = checkItemLabels(point);
      return labels.length === 1 && labels[0] === label;
    });
  }
  if (keyPoints.length === 0) keyPoints = [title];
  // A g5.v8-only slide.
  const description = instructionFor(gap, true);
  const note = teachingNoteFrom({ title, keyPoints, description });
  return {
    id: input.outlineId,
    type: 'slide',
    slideType: 'content',
    contentRole: input.role,
    title,
    keyPoints,
    description,
    order: gap.anchorIndex! + 2,
    ...(stageSlide.teachingStage ? { teachingStage: { ...stageSlide.teachingStage } } : {}),
    sourceContentUnitIds: [unitId],
    ...(input.imageId
      ? {
          suggestedImageIds: [input.imageId],
          imagePlans: [{ imageId: input.imageId, ...note }],
          visualPlan: { mode: 'image' },
        }
      : input.visualRequired
        ? { visualPlan: { mode: 'native', diagram: note } }
        : {}),
    ...(stageSlide.teachingSkills
      ? { teachingSkills: structuredClone(stageSlide.teachingSkills) }
      : {}),
  } as SceneOutline;
}
