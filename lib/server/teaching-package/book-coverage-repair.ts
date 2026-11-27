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
  CHECKS_MERGED,
  EXERCISE_CAP_EXCEEDED,
  EXERCISE_SELECTED_MISSING,
  EXERCISE_TOO_FEW,
  EXERCISE_UNSELECTED_CITED,
  EXERCISE_UNUSABLE_CITED,
  EXERCISES_MISPLACED,
  duplicateSolutionSlides,
  findBookCoverageGaps,
  IDEAS_MERGED,
  ideasMergedSlides,
  isIdeaUnit,
  isSacredExerciseElement,
  mergedCheckSlides,
  missingExampleGaps,
  RECALL_NOT_FIRST,
  recallPlacement,
  SOLUTION_SLIDES_DUPLICATED,
  EXAMPLE_TAUGHT_TWICE,
  examplesTaughtTwice,
  teaches,
  titleOnlyTransitions,
  TITLE_ONLY_SLIDE,
  WORKING_STEP_MISSING,
  type BookCoverageGap,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  CHECK_BEFORE_ITS_PART,
  SLIDE_OUT_OF_BOOK_ORDER,
} from '@/lib/server/teaching-package/book-part-placement';
import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
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
type PlacedGap = BookCoverageGap & {
  placedRole?: string;
  /**
   * 21 Nov 2026: a `missing_try_it` planned in the place of a dropped «جرّب» repeat
   * (`dropExamplesTaughtTwice`); the check's solution already there stays the only one.
   */
  inRepeatPlace?: true;
};

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
  if (gap.kind === 'missing_example') {
    // Lesson 2-5 (17 Nov 2026, g5.v11): the book example a check is tried after.
    return (
      `Plan the worked-example slide (contentRole worked_example) that teaches the book's example in content unit ${id} ` +
      "step by step, every part of it, with the book's own method and numbers, as the book prints it. " +
      'It comes BEFORE the learner tries the check that follows it: cite only this unit, never a check, and solve no check item.'
    );
  }
  return `Plan the slide (contentRole ${roleFor(gap)}) that teaches content unit ${id} as the book prints it.`;
}

/**
 * The issues that stop the book repair (package-planner-issue-resolve-plan-
 * 2026-11-22 §3b, prompt P1 item 4): its anchors and `placeAnchorlessTeaching`
 * read each slide's teaching stage and the slide order, so while a stage or an
 * order issue is open a placed slide could land in the wrong stage.
 */
export const BOOK_REPAIR_BLOCKING_CODES: ReadonlySet<string> = new Set([
  'TEACHING_STAGE_MISSING',
  'TEACHING_STAGE_MISMATCH',
  'TEACHING_STAGE_INVALID',
  'FLOW_SEQUENCE_INVALID',
  'POSITION_CARDINALITY',
]);

/**
 * Only gaps the plan can place, and only when no stage or order issue is open.
 *
 * Owner change (22 Nov 2026, package-planner-issue-resolve-plan §3b): any other
 * open issue (a Teaching Skill, a visual, a grounding finding) no longer stops
 * the gaps the plan can place. Those issues stay open for the plan review layer
 * or a person. Before it, one such issue switched the whole repair off.
 */
function repairableGaps(
  outlines: readonly SceneOutline[],
  blocking: readonly OutlineDiagnostic[],
  book: CoverageBookStructure,
  flow: readonly TeachingFlowEntry[],
): PlacedGap[] | null {
  if (blocking.length === 0) return null;
  const parity = book.teacherParity === true;
  if (blocking.some((issue) => BOOK_REPAIR_BLOCKING_CODES.has(issue.code))) return null;
  // Something of the book's must still be open: a book finding a person ignored
  // is filtered out of `blocking`, and is never re-planned behind their back.
  if (
    !blocking.some(
      (issue) =>
        issue.code === BOOK_COVERAGE_INCOMPLETE ||
        (parity && TEACHER_PARITY_FINDINGS.has(issue.code)),
    )
  ) {
    return null;
  }
  const { planned: gaps } = classifyBookGaps(outlines, book, flow);
  if (gaps.length === 0 || gaps.some((gap) => gap.anchorIndex === undefined)) return null;
  return gaps;
}

/**
 * The plan's book gaps, and which of them the repair's rounds plan (`planned`) and which
 * stay open for the plan review, a planner re-ask or a person (`left`).
 *
 * A check with no try-it is also reported as untaught; its one try-it slide answers
 * both, so the teaching gap is planned once.
 *
 * g5.v8 (lessons 314/315/318): a gap the plan cannot place (no anchor) is left to a
 * person instead of blocking every other repair, and a check solved before its try-it is
 * a person's to move, so none of its gaps is planned around it.
 */
function classifyBookGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
  flow: readonly TeachingFlowEntry[],
): { planned: PlacedGap[]; left: PlacedGap[] } {
  const parity = book.teacherParity === true;
  const found = findBookCoverageGaps(outlines, book).map((gap) =>
    parity ? placeAnchorlessTeaching(gap, outlines, book, flow) : gap,
  );
  const tryItMissing = new Set<string>();
  for (const gap of found) {
    if (gap.kind === 'missing_try_it') tryItMissing.add(gap.unit.contentUnitId);
  }
  const solvedEarly = new Set(
    parity
      ? found
          .filter((gap) => gap.kind === 'solution_before_try_it')
          .map((gap) => gap.unit.contentUnitId)
      : [],
  );
  const candidates = found.filter(
    (gap) => !(gap.kind === 'missing_teaching' && tryItMissing.has(gap.unit.contentUnitId)),
  );
  const placeable = (gap: PlacedGap) =>
    gap.anchorIndex !== undefined && !solvedEarly.has(gap.unit.contentUnitId);
  return {
    planned: parity ? candidates.filter(placeable) : candidates,
    left: parity ? candidates.filter((gap) => !placeable(gap)) : [],
  };
}

/**
 * g5.v12 (EN-4, critical items 27 Nov 2026): the book gaps the repair's rounds will NOT
 * plan — a gap no slide of the plan places, or one of a check solved before its try-it.
 * Read without a model call, so the runner can tell a violation a deterministic fix
 * repairs from one only the planner (asked again) or a person can repair.
 */
export function unplaceableBookGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
  flow: readonly TeachingFlowEntry[],
): BookCoverageGap[] {
  return classifyBookGaps(outlines, book, flow).left;
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
  // g5.v12: an orientation slide never teaches an idea (M1), so an idea's slide is an
  // explanation or it is not placed — never an orientation the gate would still count
  // as a gap (wave 1 re-review, N1).
  const ideaOnV12 = book.bookPartPlacement === true && isIdeaUnit(gap.unit);
  const preferred =
    ideaOnV12 && base === 'explanation'
      ? ['explanation']
      : intro && base === 'explanation'
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
  EXAMPLE_TAUGHT_TWICE,
]);

/** The most key points a merged solution slide keeps (its points join, never drop). */
const MERGED_SOLUTION_MAX_POINTS = 8;

/**
 * g5.v8 (owner, 4 Nov 2026), deterministic, no model call: each check keeps
 * ONE solution slide — the first; the others' cited units, key points and
 * selected visuals join it, and the others are removed. Exercise slides are
 * never touched. Returns the new list and how many slides were removed.
 */
/**
 * 21 Nov 2026 (owner, slide findings point 3), deterministic, no model call: the slides
 * `examplesTaughtTwice` names are dropped — the first `worked_example` slide of the
 * example keeps its teaching, and a «جرّب» repeat that checks nothing goes entirely. The
 * example's own try-it slide is then planned by the missing-try-it machinery in the
 * dropped «جرّب» slide's place (`tryItAfter`: check unit id → the id of the kept slide
 * right before it), so it never lands after the check's solution (review 21 Nov 2026).
 * A «جرّب»-shaped slide is a repeat only when the example's check exists in the book map
 * (otherwise it is the v8 "one similar item" slide and stays); a check is never invented.
 */
export function dropExamplesTaughtTwice(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; dropped: number; tryItAfter: Map<string, string> } {
  const groups = examplesTaughtTwice(outlines, book);
  const tryItAfter = new Map<string, string>();
  if (groups.length === 0) return { outlines: [...outlines], dropped: 0, tryItAfter };
  const drop = new Set(groups.flatMap((group) => group.indexes));
  for (const group of groups) {
    const checkId = book.units.find(
      (unit) =>
        unit.element === 'try_it' && String(unit.pairedExampleUnitId) === String(group.unitId),
    )?.contentUnitId;
    if (checkId === undefined || tryItAfter.has(checkId)) continue;
    const repeat = group.indexes.find(
      (index) => outlines[index]!.contentRole === 'check_understanding',
    );
    if (repeat === undefined) continue;
    let before = repeat - 1;
    while (before >= 0 && drop.has(before)) before -= 1;
    // Never ahead of the example itself (review 21 Nov 2026): a «جرّب» repeat placed before
    // the example's first teaching slide re-plans the try-it right after that slide.
    const first = group.firstIndex;
    if (first !== undefined && before < first && !drop.has(first)) before = first;
    if (before >= 0) tryItAfter.set(checkId, outlines[before]!.id);
  }
  return {
    outlines: outlines.filter((_outline, index) => !drop.has(index)),
    dropped: drop.size,
    tryItAfter,
  };
}

export function mergeDuplicateSolutions(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; merged: number; recited: number } {
  let current = [...outlines];
  let merged = 0;
  let recited = 0;
  const examples = new Set(
    book.units
      .filter((unit) => unit.element === 'worked_example')
      .map((unit) => String(unit.contentUnitId)),
  );
  for (;;) {
    const group = duplicateSolutionSlides(current, book)[0];
    if (!group) break;
    // Lesson 2-5 (17 Nov 2026, g5.v11 `examplesKept`): a slide that teaches ANOTHER book example (not the
    // check's own paired one) and also cites the check is that example's slide, never a
    // second solution: it keeps its place and only stops citing the check. Merging it
    // folded Example 3 into check 2's solution, so check 3 was tried with no example.
    const paired = book.units.find(
      (unit) => unit.contentUnitId === group.unitId,
    )?.pairedExampleUnitId;
    const teachesOther = (index: number) =>
      (current[index]!.sourceContentUnitIds ?? []).some(
        (id) => examples.has(String(id)) && String(id) !== paired,
      );
    const exampleSlides = book.examplesKept ? group.indexes.filter(teachesOther) : [];
    if (exampleSlides.length > 0 && exampleSlides.length < group.indexes.length) {
      for (const index of exampleSlides) {
        const slide = current[index]!;
        current[index] = {
          ...slide,
          sourceContentUnitIds: (slide.sourceContentUnitIds ?? []).filter(
            (id) => String(id) !== group.unitId,
          ),
        } as SceneOutline;
        recited += 1;
      }
      log.info(
        `book coverage repair: ${exampleSlides.length} example slide(s) kept apart from the solution of check ${group.unitId}`,
      );
      continue;
    }
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
  return { outlines: current, merged, recited };
}

/** The most key points a merged exercise slide keeps. */
const MERGED_EXERCISE_MAX_POINTS = 12;

/**
 * g5.v10 (learner-first, 15 Nov 2026), deterministic, no model call: the planner put one
 * exercise per slide (item 195: five exercise slides for a block of two). The exercise
 * slides are regrouped onto exactly the engine's selection slides (`selectExercises`),
 * each keeping its exercises' key points in order, at the place of the first exercise
 * slide. Anything that does not fit the selection (a unit outside it) leaves the plan as
 * it was. Returns the new list and how many slides were removed.
 */
export function mergeExerciseSlides(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; merged: number } {
  const unchanged = { outlines: [...outlines], merged: 0 };
  const policy = book.exercisePolicy;
  const selection = book.learnerFirst ? selectExercises(book, book.unitFacts) : null;
  if (!policy || !selection) return unchanged;
  const exerciseIds = new Set(
    book.units
      .filter((unit) => unit.element === 'exercise')
      .map((unit) => String(unit.contentUnitId)),
  );
  const isExerciseSlide = (outline: SceneOutline) =>
    teaches(outline) &&
    (outline.sourceContentUnitIds ?? []).some((id) => exerciseIds.has(String(id)));
  const indexes = outlines.flatMap((outline, index) => (isExerciseSlide(outline) ? [index] : []));
  if (indexes.length <= policy.maxExerciseSlides) return unchanged;
  const slideOf = new Map<string, number>();
  for (const [slide, ids] of selection.slides.entries()) {
    for (const id of ids) {
      // A multi-question unit split over two selection slides has no single home.
      if (slideOf.has(String(id))) return unchanged;
      slideOf.set(String(id), slide);
    }
  }
  const groups: SceneOutline[][] = selection.slides.map(() => []);
  for (const index of indexes) {
    const outline = outlines[index]!;
    const units = (outline.sourceContentUnitIds ?? [])
      .map(String)
      .filter((id) => exerciseIds.has(id));
    const slide = slideOf.get(units[0] ?? '');
    if (slide === undefined || units.some((id) => slideOf.get(id) !== slide)) return unchanged;
    groups[slide]!.push(outline);
  }
  if (groups.some((group) => group.length === 0)) return unchanged;
  // The merged titles follow the lesson's digits (item 195 titles: «تمارين ١–٢»).
  const arabicDigits = /[٠-٩]/.test(indexes.map((index) => outlines[index]!.title ?? '').join(''));
  const numeral = (n: number) =>
    arabicDigits ? String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!) : String(n);
  const merged = groups.map((group, slide) => {
    const [first] = group;
    const unique = [...new Set(group.flatMap((o) => (o.sourceContentUnitIds ?? []).map(String)))];
    return {
      ...first!,
      title: `تمارين (${numeral(slide + 1)})`,
      sourceContentUnitIds: unique,
      keyPoints: spreadOverPoints(
        group.flatMap((o) => [o.title, ...(o.keyPoints ?? [])].filter(Boolean)),
        MERGED_EXERCISE_MAX_POINTS,
      ),
    } as SceneOutline;
  });
  const first = indexes[0]!;
  const removed = new Set(indexes);
  const result: SceneOutline[] = [];
  outlines.forEach((outline, index) => {
    if (index === first) result.push(...merged);
    if (!removed.has(index)) result.push(outline);
  });
  return { outlines: result, merged: indexes.length - merged.length };
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

/** The g5.v12 rules a deterministic restructure answers (each is its own finding's fix). */
const BOOK_PART_RESTRUCTURES: ReadonlySet<string> = new Set([
  CHECKS_MERGED,
  IDEAS_MERGED,
  TITLE_ONLY_SLIDE,
]);

/**
 * The codes a g5.v12 restructure may bring out without rolling back: every g5.v8 code,
 * and the book-part ones — a split asks for the solution slides it makes missing, and the
 * slides it adds or removes sit where the book-part placement (run right after the
 * repair) puts them. The g5.v8 codes are IN the set: on v12 the v8 restructures run
 * after the v12 ones, each under this same accept.
 */
const BOOK_PART_EXPECTED: ReadonlySet<string> = new Set([
  ...TEACHER_PARITY_FINDINGS,
  BOOK_COVERAGE_INCOMPLETE,
  SLIDE_OUT_OF_BOOK_ORDER,
  CHECK_BEFORE_ITS_PART,
  ...BOOK_PART_RESTRUCTURES,
]);

/**
 * An id no outline of the plan holds yet.
 */
function freshId(outlines: readonly SceneOutline[], base: string): string {
  const taken = new Set(outlines.map((outline) => outline.id));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * The try-it slide of ONE check, built as the book prints the check: its own lines, in
 * order, without an answer (the fallback slide of a missing try-it). The first slide of a
 * split keeps the merged slide's id, stage and Skills.
 */
function tryItOfCheck(
  merged: SceneOutline,
  check: BookCoverageGap['unit'],
  first: boolean,
  outlines: readonly SceneOutline[],
  context: BookCoverageRepairContext,
): SceneOutline {
  const unitId = check.contentUnitId;
  const source = context.units.find((unit) => unit.id === unitId);
  const lines = (source?.text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^\[\[/.test(line));
  const title = tryItTitle(source?.title?.trim() || merged.title || unitId, context.language);
  const description = instructionFor({
    kind: 'missing_try_it',
    unit: check,
    message: '',
  });
  const keyPoints =
    lines.length > 0 ? spreadOverPoints(lines, TRY_IT_MAX_POINTS) : [...(merged.keyPoints ?? [])];
  if (keyPoints.length === 0) keyPoints.push(title);
  // The merged slide's own image stays only when it belongs to this check and already
  // has its teaching note; a position that requires a visual gets a native diagram.
  const planned = new Set((merged.imagePlans ?? []).map((plan) => plan.imageId));
  const own = new Set(
    context.visuals
      .filter((visual) => (visual.sourceContentUnitIds ?? []).some((id) => String(id) === unitId))
      .map((visual) => visual.id),
  );
  const kept = first
    ? (merged.suggestedImageIds ?? []).filter((id) => own.has(id) && planned.has(id))
    : [];
  const stage = merged.teachingStage;
  const entry = stage ? context.flow[stage.flowIndex] : undefined;
  const visualRequired =
    stage !== undefined && entry !== undefined && entry.stage === stage.key
      ? scenePolicyFor(entry)?.visual !== undefined
      : false;
  const { suggestedImageIds: _ids, imagePlans: _plans, visualPlan: _plan, ...rest } = merged;
  const note = teachingNoteFrom({ title, keyPoints, description });
  return {
    ...rest,
    id: first ? merged.id : freshId(outlines, `${merged.id}-check-${unitId}`),
    type: 'slide',
    slideType: 'content',
    contentRole: 'check_understanding',
    title,
    keyPoints,
    description,
    sourceContentUnitIds: [unitId],
    ...(kept.length > 0
      ? {
          suggestedImageIds: kept,
          imagePlans: (merged.imagePlans ?? []).filter((plan) => kept.includes(plan.imageId)),
          visualPlan: { mode: 'image' },
        }
      : visualRequired
        ? { visualPlan: { mode: 'native', diagram: note } }
        : {}),
  } as SceneOutline;
}

/**
 * g5.v12 (W1.2), deterministic, no model call: a try-it that sets several checks becomes
 * one try-it per check, in book order, each setting its own check's lines as the book
 * prints them. A solution that solves several checks is taken out — ALWAYS, also when it
 * cites a book example beside the checks: its text still holds every check's answer, so
 * kept as "the example's slide" it would carry the answers to wherever the book prints
 * that example, ahead of the try-its, where no gate could see it (review 27 Nov 2026,
 * MEDIUM). Each check then gets its own solution slide from the insert planner
 * (`missing_solution`, never before its try-it), and the example a slide of its own from
 * its own text (`missing_teaching`). Lesson 227: slides 9 and 17, three and two checks
 * each. Returns the new list and what it did.
 */
export function splitMergedChecks(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
  context: BookCoverageRepairContext,
): { outlines: SceneOutline[]; split: number; removed: number } {
  const merged = new Map(
    mergedCheckSlides(outlines, book).map((group) => [group.index, group] as const),
  );
  const result: SceneOutline[] = [];
  let split = 0;
  let removed = 0;
  outlines.forEach((outline, index) => {
    const group = merged.get(index);
    if (!group) {
      result.push(outline);
      return;
    }
    // A slide that solves several checks.
    if (outline.contentRole !== 'check_understanding') {
      removed += 1;
      return;
    }
    group.units.forEach((check, at) => {
      if (at > 0) split += 1;
      result.push(tryItOfCheck(outline, check, at === 0, outlines, context));
    });
  });
  return {
    outlines: result.map((outline, at) => ({ ...outline, order: at + 1 })),
    split,
    removed,
  };
}

/**
 * g5.v12 ("one idea per slide"), deterministic: a slide teaching several ideas is taken
 * out, and the repair's rounds then plan one slide per idea from its own unit text
 * (lesson 227 slide 7: three concepts on one slide). Returns the new list and how many
 * slides it removed.
 */
export function unmergeIdeas(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; removed: number } {
  const drop = new Set(ideasMergedSlides(outlines, book).map((group) => group.index));
  return {
    outlines: outlines
      .filter((_outline, index) => !drop.has(index))
      .map((outline, at) => ({ ...outline, order: at + 1 })),
    removed: drop.size,
  };
}

/**
 * g5.v12 (EN-4, wave 1 review M2): the plan the book repair's own restructures would
 * leave — each merged check split, each slide of several ideas taken out, each
 * title-only transition dropped — with no model call. Only to decide whether the
 * planner must be asked again: a violation these fix is the repair's, not the
 * planner's. The repair itself still applies each one under its own roll-back rule.
 * The same list (re-numbered) when there is nothing to restructure, or off g5.v12.
 */
export function restructuredByBookParts(
  outlines: readonly SceneOutline[],
  context: BookCoverageRepairContext,
): SceneOutline[] {
  const book = context.book;
  if (book.bookPartPlacement !== true) return [...outlines];
  let next: SceneOutline[] = [...outlines];
  if (mergedCheckSlides(next, book).length > 0) {
    next = splitMergedChecks(next, book, context).outlines;
  }
  if (ideasMergedSlides(next, book).length > 0) next = unmergeIdeas(next, book).outlines;
  if (titleOnlyTransitions(next, book).length > 0) {
    next = dropTitleOnlyTransitions(next, book).outlines;
  }
  return next.map((outline, at) => ({ ...outline, order: at + 1 }));
}

/**
 * g5.v12 (decision D-2), deterministic: the transition slides that hold only a title and
 * one line are taken out; the first teaching slide of the part names it. Never every
 * slide of a plan. Returns the new list and how many it dropped.
 */
export function dropTitleOnlyTransitions(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): { outlines: SceneOutline[]; dropped: number } {
  const drop = new Set(titleOnlyTransitions(outlines, book));
  if (drop.size === 0 || drop.size === outlines.length) {
    return { outlines: [...outlines], dropped: 0 };
  }
  return {
    outlines: outlines
      .filter((_outline, index) => !drop.has(index))
      .map((outline, at) => ({ ...outline, order: at + 1 })),
    dropped: drop.size,
  };
}

export async function repairBookCoverageGaps(
  candidate: readonly SceneOutline[],
  blocking: readonly OutlineDiagnostic[],
  aiCall: AICallFn,
  context: BookCoverageRepairContext,
  /**
   * Lesson 2-5 (17 Nov 2026, g5.v11): `examples` plans ONLY the book examples with no
   * slide of their own before their check (`missingExampleGaps`), in ONE round, on a
   * plan that passed the gates; nothing else is restructured.
   */
  options: { examples?: boolean } = {},
): Promise<BookCoverageRepairResult> {
  let outlines = [...candidate];
  let open = [...blocking];
  let inserted = 0;
  let restructured = 0;
  // 21 Nov 2026: a check whose «جرّب» repeat was dropped gets its try-it in that place.
  const tryItAfter = new Map<string, string>();
  const exerciseIds = new Set(
    context.book.units
      .filter((unit) => unit.element === 'exercise')
      .map((unit) => String(unit.contentUnitId)),
  );
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
  // g5.v12 (critical items 27 Nov 2026): the book-part restructures, each the fix of
  // its own finding and each without a model call.
  const bookParts = context.book.bookPartPlacement === true;
  const partOpen = (code: string) => open.some((issue) => issue.code === code);
  // g5.v8: one solution slide per check and recall first are fixed without a
  // model call, before any slide is planned, then the candidate is re-diagnosed.
  if (
    options.examples !== true &&
    context.book.teacherParity === true &&
    open.some(
      (issue) =>
        issue.code === SOLUTION_SLIDES_DUPLICATED ||
        issue.code === RECALL_NOT_FIRST ||
        issue.code === EXAMPLE_TAUGHT_TWICE ||
        // g5.v10: an oversized exercises block is regrouped without a model call.
        (context.book.learnerFirst === true && issue.code === EXERCISE_CAP_EXCEEDED) ||
        // g5.v12: merged checks, several ideas on one slide, a title-only transition.
        (bookParts && BOOK_PART_RESTRUCTURES.has(issue.code)),
    )
  ) {
    // E-3: a step is kept only when it adds no new finding code outside the
    // g5.v8 set; otherwise the plan stays as it was and the step counts 0.
    // g5.v12 EXTENDS that set with the book-part codes (never swaps it): the v8
    // findings a restructure brings out stay expected there too, or the split of
    // merged checks would roll back on the very repeat it exposes (review 27 Nov
    // 2026, MEDIUM: `[K, E, try-merged, sol-merged]` → EXAMPLE_TAUGHT_TWICE).
    const before = new Set(blocking.map((issue) => issue.code));
    const expected = bookParts ? BOOK_PART_EXPECTED : TEACHER_PARITY_FINDINGS;
    const accept = (next: readonly SceneOutline[]) => {
      const diagnosed = context.diagnose(
        next.map((outline, index) => ({ ...outline, order: index + 1 })),
      );
      const added = diagnosed.blocking.some(
        (issue) => !before.has(issue.code) && !expected.has(issue.code),
      );
      if (added) return false;
      outlines = diagnosed.outlines;
      open = diagnosed.blocking;
      return true;
    };
    // g5.v12: each check on its own try-it slide, each idea on its own slide, and no
    // title-only transition. The slides a split adds are planned in the rounds below.
    const split =
      bookParts && partOpen(CHECKS_MERGED)
        ? splitMergedChecks(outlines, context.book, { ...context, units: [...unitsById.values()] })
        : null;
    const splitKept = split !== null && split.split + split.removed > 0 && accept(split.outlines);
    const unmerged =
      bookParts && partOpen(IDEAS_MERGED) ? unmergeIdeas(outlines, context.book) : null;
    const unmergeKept = unmerged !== null && unmerged.removed > 0 && accept(unmerged.outlines);
    const dropped =
      bookParts && partOpen(TITLE_ONLY_SLIDE)
        ? dropTitleOnlyTransitions(outlines, context.book)
        : null;
    const dropKept = dropped !== null && dropped.dropped > 0 && accept(dropped.outlines);
    if (split !== null || unmerged !== null || dropped !== null) {
      log.info(
        `book coverage repair (g5.v12): ${
          splitKept
            ? `${split.split} check(s) split onto their own try-it slide, ${split.removed} merged solution(s) taken out`
            : 'checks not split'
        }; ${unmergeKept ? `${unmerged.removed} slide(s) teaching several ideas taken out to be planned one per idea` : 'ideas not unmerged'}; ${dropKept ? `${dropped.dropped} title-only transition slide(s) dropped` : 'no title-only slide dropped'}`,
      );
    }
    // 21 Nov 2026: the repeats of an example taught twice go first — the merges below
    // then see the plan without them.
    const deduped = dropExamplesTaughtTwice(outlines, context.book);
    const dedupKept = deduped.dropped > 0 && accept(deduped.outlines);
    if (dedupKept) {
      for (const [checkId, anchorId] of deduped.tryItAfter) tryItAfter.set(checkId, anchorId);
    }
    if (deduped.dropped > 0) {
      log.info(
        `book coverage repair: ${dedupKept ? deduped.dropped : 0} slide(s) repeating an already-taught example dropped${dedupKept ? '' : ' (rolled back)'}`,
      );
    }
    const merged = mergeDuplicateSolutions(outlines, context.book);
    // Lesson 2-5: an example slide that only stopped citing the check is a change too.
    const mergeKept = merged.merged + merged.recited > 0 && accept(merged.outlines);
    const moved = moveRecallFirst(outlines, context.book);
    const moveKept = moved.moved && accept(moved.outlines);
    // g5.v10 only (`book.learnerFirst`): one exercise per slide → the engine's groups.
    const grouped = mergeExerciseSlides(outlines, context.book);
    const groupKept = grouped.merged > 0 && accept(grouped.outlines);
    if (grouped.merged > 0) {
      log.info(
        `book coverage repair: ${groupKept ? grouped.merged : 0} exercise slide(s) merged into the engine's exercises block${groupKept ? '' : ' (rolled back)'}`,
      );
    }
    restructured =
      (splitKept ? split.split + split.removed : 0) +
      (unmergeKept ? unmerged.removed : 0) +
      (dropKept ? dropped.dropped : 0) +
      (dedupKept ? deduped.dropped : 0) +
      (mergeKept ? merged.merged + merged.recited : 0) +
      (moveKept ? 1 : 0) +
      (groupKept ? grouped.merged : 0);
    if (merged.merged > 0 || moved.moved) {
      log.info(
        `book coverage repair: ${mergeKept ? merged.merged : 0} solution slide(s) merged${merged.merged > 0 && !mergeKept ? ' (rolled back)' : ''}, recall ${moveKept ? 'moved first' : moved.moved ? 'move rolled back' : 'unchanged'}, ${open.length} issue(s) open`,
      );
    }
  }

  const rounds = options.examples === true ? 1 : BOOK_COVERAGE_REPAIR_ROUNDS;
  for (let round = 1; round <= rounds; round += 1) {
    const placed =
      options.examples === true
        ? missingExampleGaps(outlines, context.book).filter((gap) => gap.anchorIndex !== undefined)
        : null;
    const found =
      options.examples === true
        ? placed!.length > 0
          ? placed
          : null
        : repairableGaps(outlines, open, context.book, context.flow);
    if (!found) break;
    // 21 Nov 2026 (review): the try-it of a check whose «جرّب» repeat was dropped goes in
    // that slide's place — right after the slide that preceded it — not after the last
    // slide citing the example (usually the check's own solution).
    const gaps: PlacedGap[] = found.map((gap) => {
      if (gap.kind !== 'missing_try_it') return gap;
      const anchorId = tryItAfter.get(gap.unit.contentUnitId);
      const at = anchorId === undefined ? -1 : outlines.findIndex((o) => o.id === anchorId);
      return at >= 0 ? { ...gap, anchorIndex: at, inRepeatPlace: true } : gap;
    });
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
      // so try-it → solution → per-item solutions fit the two rounds. A try-it planned in
      // a dropped «جرّب» repeat's place keeps the check's solution already after it —
      // counted as SOLUTION_SLIDES_DUPLICATED counts: an exercises slide citing the check
      // is never its solution.
      const solvedAfter =
        gap.inRepeatPlace === true &&
        outlines.slice(gap.anchorIndex! + 2).some((next) => {
          const ids = (next.sourceContentUnitIds ?? []).map(String);
          return (
            teaches(next) &&
            next.contentRole === 'worked_example' &&
            ids.includes(gap.unit.contentUnitId) &&
            !ids.some((id) => exerciseIds.has(id))
          );
        });
      if (context.book.teacherParity === true && gap.kind === 'missing_try_it' && !solvedAfter) {
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
      const check = (planned: SceneOutline): PlanCheck => {
        const messages: string[] = [];
        if (planned.contentRole !== role || planned.slideType !== 'content') {
          messages.push(`the slide must be a content slide with contentRole ${role}`);
        }
        // Owner, 22 Nov 2026: the unit's own textbook visual is known, so a slide that
        // leaves it out gets it from the server, with its teaching note, instead of
        // failing the slide (lesson 227: the planner left out the image twice).
        const selected = new Set(planned.suggestedImageIds ?? []);
        const outline =
          linked.length > 0 && !linked.some((visual) => selected.has(visual.id))
            ? withLinkedVisual(planned, linked[0]!)
            : planned;
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

/**
 * A planned book slide with the unit's own textbook visual attached (owner, 22 Nov
 * 2026): the image is selected, the visual mode is `image`, and the image gets its one
 * teaching note, from the visual's book description (what it shows) and the slide's
 * first key point or title (what the learner notices). Any other image plan is dropped,
 * so no note is left without its image.
 */
export function withLinkedVisual(
  outline: SceneOutline,
  visual: { id: string; description?: string | null },
): SceneOutline {
  const firstPoint = (outline.keyPoints ?? []).find(
    (point) => typeof point === 'string' && point.trim() !== '',
  );
  const title = typeof outline.title === 'string' ? outline.title.trim() : '';
  const shows = visual.description?.trim() || title || 'صورة الكتاب لهذا الجزء';
  const teachingPoint = firstPoint?.trim() || title || shows;
  return {
    ...outline,
    suggestedImageIds: [visual.id],
    visualPlan: { mode: 'image' },
    imagePlans: [{ imageId: visual.id, shows, teachingPoint }],
  } as SceneOutline;
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
