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
import type { AICallFn, OutlineDiagnostic } from '@openmaic/generation';

import { createLogger } from '@/lib/logger';
import {
  BOOK_COVERAGE_INCOMPLETE,
  EXERCISE_CAP_EXCEEDED,
  EXERCISE_SELECTED_MISSING,
  EXERCISE_TOO_FEW,
  EXERCISE_UNSELECTED_CITED,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  findBookCoverageGaps,
  WORKING_STEP_MISSING,
  type BookCoverageGap,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  planInsertedSlide,
  type PlanCheck,
  type PlannerSkillOption,
  type PlannerUnit,
} from '@/lib/server/teaching-package/plan-inserted-slide';
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
}

/** The content role the missing slide must carry. */
function roleFor(gap: BookCoverageGap): string {
  if (gap.kind === 'missing_solution') return 'worked_example';
  if (gap.kind === 'missing_try_it') return 'check_understanding';
  // g5.v8: the recall slide is an explanation (kind definition), not a new kind.
  if (gap.kind === 'missing_recall') return 'explanation';
  if (gap.unit.element === 'worked_example') return 'worked_example';
  if (gap.unit.element === 'try_it') return 'check_understanding';
  return 'explanation';
}

/** The planner instruction for a gap; also the description of an admin-inserted slide. */
export function instructionFor(gap: BookCoverageGap): string {
  const id = gap.unit.contentUnitId;
  const example = gap.unit.pairedExampleUnitId;
  if (gap.kind === 'missing_solution' && gap.itemLabel) {
    // g5.v8 (D-2 B): one solution slide per check item.
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
  if (gap.kind === 'missing_solution') {
    return (
      `Plan the solution slide (contentRole worked_example) for the book check in content unit ${id}: ` +
      `work each of its items step by step to a final answer with this part's decision rule` +
      (example ? `, the way the book's example in unit ${example} is solved.` : '.') +
      ' The book prints no answer, so work it from the given data; a guess or prediction item gets a reasoned number stated as an estimate.'
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
): BookCoverageGap[] | null {
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
  const found = findBookCoverageGaps(outlines, book);
  for (const gap of found) {
    if (gap.kind === 'missing_try_it') tryItMissing.add(gap.unit.contentUnitId);
  }
  const gaps = found.filter(
    (gap) =>
      !(gap.kind === 'missing_teaching' && tryItMissing.has(gap.unit.contentUnitId)) &&
      // g5.v8: a new kind the plan cannot place (no anchor) is left to a person
      // instead of blocking every other repair.
      !(parity && gap.anchorIndex === undefined && TEACHER_PARITY_KINDS.has(gap.kind)),
  );
  if (gaps.length === 0 || gaps.some((gap) => gap.anchorIndex === undefined)) return null;
  return gaps;
}

const TEACHER_PARITY_FINDINGS: ReadonlySet<string> = new Set([
  EXERCISE_CAP_EXCEEDED,
  EXERCISE_SELECTED_MISSING,
  EXERCISE_TOO_FEW,
  EXERCISE_UNSELECTED_CITED,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  WORKING_STEP_MISSING,
]);

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
  const unitsById = new Map(context.units.map((unit) => [unit.id, unit] as const));

  for (let round = 1; round <= BOOK_COVERAGE_REPAIR_ROUNDS; round += 1) {
    const gaps = repairableGaps(outlines, open, context.book);
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
      const anchor = outlines[gap.anchorIndex!]!;
      const stage = anchor.teachingStage;
      const flowEntry = stage ? context.flow[stage.flowIndex] : undefined;
      if (!stage || !flowEntry) continue;
      const unitId = gap.unit.contentUnitId;
      const unitIds = gap.citeUnitIds?.length ? [...gap.citeUnitIds] : [unitId];
      const contextIds = [...unitIds, gap.unit.pairedExampleUnitId].filter(
        (id): id is string => typeof id === 'string',
      );
      const units = contextIds.flatMap((id) => {
        const unit = unitsById.get(id);
        return unit ? [unit] : [];
      });
      if (!units.some((unit) => unit.id === unitId)) continue;
      const role = roleFor(gap);
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
        return messages.length === 0
          ? { ok: true, outline, repairs: [] }
          : { ok: false, fixable: true, code: 'INSERTION_PLAN_INVALID', messages };
      };
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
        instruction: instructionFor(gap),
        // A check's items share kind, unit and anchor: the item keeps ids distinct.
        outlineId: `${anchor.id}-book-${gap.kind}-${unitId}${gap.itemLabel ? `-${gap.itemLabel}` : ''}-r${round}`,
        order: gap.anchorIndex! + 2,
        check,
        aiCall,
      });
      if (!result.ok) {
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
        continue;
      }
      outlines.splice(gap.anchorIndex! + 1, 0, result.outline);
      planned += 1;
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
  return { outlines, blocking: open, inserted };
}
