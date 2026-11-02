/**
 * The g5.v7 book-coverage gate (book-structured planner plan P-6, Wave 4).
 *
 * Runs on the planned outlines BEFORE any scene is generated, and only when the
 * request carried a `bookStructure` (g5.v7). Every unit the Lesson Template
 * marks required must be cited by an instructional slide — a structural slide
 * (cover, contents, transition, end) citing a unit never counts as teaching it —
 * and every book check paired with an example must have a try-it slide
 * (`check_understanding`) and, after it, a solution slide (`worked_example`)
 * citing it, and no solution slide may come before that try-it. A gap is returned as an admin-correctable diagnostic that names
 * the missing element. A gap the plan can place is first re-planned
 * (`book-coverage-repair.ts`, at most twice); what is left pauses the attempt on
 * the existing correction path and never finishes as a green "succeeded".
 * v6 and earlier requests carry no `bookStructure` and are untouched.
 *
 * g5.v8 (teacher-parity plan, 2 Nov 2026) adds, ONLY when the attempt's
 * Teaching Model is `g5@g5.v8` ({@link isTeacherParityModel}, marked on the
 * coverage book as `teacherParity`): the recall slide, one solution slide per
 * check item, the exercises block with its caps and its minimum, and the visible working of the
 * detectable hidden-step types. A g5.v7 attempt — new, resumed or corrected —
 * never carries the mark, so it is checked exactly as before.
 */
import { hiddenStepCatalogue, type OutlineDiagnostic } from '@openmaic/generation';

import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import {
  bookUnitFacts,
  showsWorkingStep,
  type BookUnitFacts,
  type DetectedHiddenStepType,
} from '@/lib/server/teaching-package/hidden-step-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure, KafuoBookStructureUnit } from '@/lib/types/teaching-package';

export const BOOK_COVERAGE_INCOMPLETE = 'BOOK_COVERAGE_INCOMPLETE';
/** g5.v8: more exercise units or exercise slides than `exercisePolicy` allows. */
export const EXERCISE_CAP_EXCEEDED = 'EXERCISE_CAP_EXCEEDED';
/** g5.v8: fewer exercise units or exercise slides than `exercisePolicy`'s minimum. */
export const EXERCISE_TOO_FEW = 'EXERCISE_TOO_FEW';
/** g5.v8: a slide cites an exercise unit whose item did not survive the parse. */
export const EXERCISE_UNUSABLE_CITED = 'EXERCISE_UNUSABLE_CITED';
/** g5.v8: an exercise slide outside the end of the last part (before its summary). */
export const EXERCISES_MISPLACED = 'EXERCISES_MISPLACED';
/** g5.v8: a solution lacks the visible working its hidden-step type needs. */
export const WORKING_STEP_MISSING = 'WORKING_STEP_MISSING';
/** g5.v8: an exercise unit the engine selected for the block is not cited. */
export const EXERCISE_SELECTED_MISSING = 'EXERCISE_SELECTED_MISSING';
/** g5.v8: a usable exercise unit the engine did not select is cited. */
export const EXERCISE_UNSELECTED_CITED = 'EXERCISE_UNSELECTED_CITED';

/** The Teaching Model whose requests get the teacher-parity gates. */
export const TEACHER_PARITY_TEACHING_MODEL = { key: 'g5', version: 'g5.v8' } as const;

/** The ONE g5.v8 switch: an explicit Teaching Model identity check. */
export function isTeacherParityModel(
  model: { key?: string | null; version?: string | null } | null | undefined,
): boolean {
  return (
    model?.key === TEACHER_PARITY_TEACHING_MODEL.key &&
    model?.version === TEACHER_PARITY_TEACHING_MODEL.version
  );
}

/**
 * The book map as the coverage gate reads it. The two extra fields are
 * TE-derived — never on the wire, never in the request digest, never pinned in
 * the input snapshot: they are rebuilt from the attempt's Teaching Model and
 * the checkpoint's pinned unit facts each time a diagnosis runs.
 */
export interface CoverageBookStructure extends KafuoBookStructure {
  /** The attempt's Teaching Model is g5.v8. */
  teacherParity?: true;
  /** g5.v8: per check / exercise unit, the facts its gates read (no text). */
  unitFacts?: Record<string, BookUnitFacts>;
}

/** The units whose text the g5.v8 gates read: checks and exercises. */
function factUnit(unit: KafuoBookStructureUnit): boolean {
  return unit.element === 'try_it' || unit.element === 'exercise';
}

/**
 * The g5.v8 facts of a book map's checks and exercises, from the approved unit
 * texts. Pinned on the checkpoint (`sourceRefs.bookUnitFacts`) so a correction
 * re-check reads the same facts without the text.
 */
export function bookUnitFactsOf(
  book: KafuoBookStructure,
  units: ReadonlyArray<{ id: string; text: string }>,
): Record<string, BookUnitFacts> {
  const text = new Map(units.map((unit) => [String(unit.id), unit.text] as const));
  const facts: Record<string, BookUnitFacts> = {};
  for (const unit of book.units) {
    const body = text.get(unit.contentUnitId);
    if (!factUnit(unit) || body === undefined) continue;
    facts[unit.contentUnitId] = bookUnitFacts(body);
  }
  return facts;
}

/**
 * Mark the coverage book of a g5.v8 attempt. Any other Teaching Model gets the
 * book back unchanged (same object), so every earlier version is untouched.
 */
export function teacherParityBook(
  book: KafuoBookStructure | undefined,
  teachingModel: { key?: string | null; version?: string | null } | null | undefined,
  unitFacts?: Record<string, BookUnitFacts> | null,
): CoverageBookStructure | undefined {
  if (!book || !isTeacherParityModel(teachingModel)) return book;
  return { ...book, teacherParity: true, ...(unitFacts ? { unitFacts } : {}) };
}

const STRUCTURAL_SLIDE_TYPES: ReadonlySet<string> = new Set([
  'cover',
  'contents',
  'transition',
  'end',
]);

function cites(outline: SceneOutline, unitId: string): boolean {
  return (outline.sourceContentUnitIds ?? []).some((id) => String(id) === unitId);
}

function teaches(outline: SceneOutline): boolean {
  return outline.type === 'slide' && !STRUCTURAL_SLIDE_TYPES.has(String(outline.slideType ?? ''));
}

function describe(unit: { contentUnitId: string; kind: string | null; partIndex?: number }) {
  const part = unit.partIndex !== undefined ? ` in part ${unit.partIndex}` : '';
  return `${unit.kind ?? 'unit'} ${unit.contentUnitId}${part}`;
}

/** What a book element is missing, and where its slide belongs. */
export type BookCoverageGapKind =
  | 'missing_teaching'
  | 'missing_try_it'
  | 'missing_solution'
  | 'solution_before_try_it'
  // g5.v8 only:
  | 'missing_recall'
  | 'missing_exercises';

export interface BookCoverageGap {
  kind: BookCoverageGapKind;
  unit: KafuoBookStructureUnit;
  message: string;
  /**
   * g5.v8, `missing_solution`: the check item (1B, 1C…) that still needs its
   * own solution slide. Absent ⇒ the check has no solution slide at all.
   */
  itemLabel?: string;
  /** g5.v8, `missing_recall`: every unit the recall slide cites. */
  citeUnitIds?: string[];
  /**
   * The outline the missing slide goes right after, or `undefined` when no
   * slide of the plan places it (then only a person can):
   * - a solution goes after the check's try-it slide;
   * - a try-it goes after the last slide teaching its paired example;
   * - a teaching slide goes after the last slide citing an earlier unit of its part.
   */
  anchorIndex?: number;
}

function lastIndexWhere(
  outlines: readonly SceneOutline[],
  predicate: (outline: SceneOutline) => boolean,
): number | undefined {
  for (let index = outlines.length - 1; index >= 0; index -= 1) {
    if (predicate(outlines[index]!)) return index;
  }
  return undefined;
}

/** Every book element the plan misses, in book order, with where its slide belongs. */
export function findBookCoverageGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure | undefined,
): BookCoverageGap[] {
  if (!book) return [];
  const gaps: BookCoverageGap[] = [];

  book.units.forEach((unit, position) => {
    if (!unit.required) return;
    if (outlines.some((outline) => teaches(outline) && cites(outline, unit.contentUnitId))) return;
    const earlier = new Set(
      book.units
        .slice(0, position)
        .filter((other) => other.partIndex !== undefined && other.partIndex === unit.partIndex)
        .map((other) => other.contentUnitId),
    );
    gaps.push({
      kind: 'missing_teaching',
      unit,
      message: `${describe(unit)} has no teaching slide`,
      anchorIndex:
        earlier.size > 0
          ? lastIndexWhere(
              outlines,
              (outline) =>
                teaches(outline) &&
                (outline.sourceContentUnitIds ?? []).some((id) => earlier.has(String(id))),
            )
          : undefined,
    });
  });

  for (const unit of book.units) {
    if (unit.element !== 'try_it' || unit.pairedExampleUnitId === undefined) continue;
    const tryIt = outlines.findIndex(
      (outline) =>
        teaches(outline) &&
        outline.contentRole === 'check_understanding' &&
        cites(outline, unit.contentUnitId),
    );
    if (tryIt < 0) {
      const example = unit.pairedExampleUnitId;
      gaps.push({
        kind: 'missing_try_it',
        unit,
        message: `${describe(unit)} (the check after example ${example}) has no try-it slide`,
        anchorIndex: lastIndexWhere(
          outlines,
          (outline) => teaches(outline) && cites(outline, example),
        ),
      });
      continue;
    }
    // A check worked before the learner tries it gives the answer away; moving
    // or splitting that slide is a person's call, so it has no anchor.
    const early = outlines
      .slice(0, tryIt)
      .some(
        (outline) =>
          teaches(outline) &&
          outline.contentRole === 'worked_example' &&
          cites(outline, unit.contentUnitId),
      );
    if (early) {
      gaps.push({
        kind: 'solution_before_try_it',
        unit,
        message: `${describe(unit)} is solved on a slide before its try-it slide`,
      });
    }
    const solved = outlines
      .slice(tryIt + 1)
      .some(
        (outline) =>
          teaches(outline) &&
          outline.contentRole === 'worked_example' &&
          cites(outline, unit.contentUnitId),
      );
    if (!solved) {
      gaps.push({
        kind: 'missing_solution',
        unit,
        message: `${describe(unit)} has a try-it slide but no solution slide after it`,
        anchorIndex: tryIt,
      });
    } else if (book.teacherParity) {
      gaps.push(...missingItemSolutions(outlines, book, unit, tryIt));
    }
  }
  if (book.teacherParity) gaps.push(...teacherParityGaps(outlines, book));
  return gaps;
}

function isSolutionOf(outline: SceneOutline, unitId: string): boolean {
  return teaches(outline) && outline.contentRole === 'worked_example' && cites(outline, unitId);
}

/**
 * g5.v8 (D-2 B): one solution slide per check item. The items are the labels
 * the check's text prints (1A, 1B…); slides are not matched to items (a slide
 * names its item only in free text), so the gate counts: fewer solution slides
 * after the try-it than labelled items leaves the last items without theirs.
 * A check whose text labels fewer than two items needs one solution, as before.
 */
function missingItemSolutions(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
  unit: KafuoBookStructureUnit,
  tryIt: number,
): BookCoverageGap[] {
  const labels = book.unitFacts?.[unit.contentUnitId]?.itemLabels ?? [];
  if (labels.length < 2) return [];
  const solutions: number[] = [];
  outlines.forEach((outline, index) => {
    if (index > tryIt && isSolutionOf(outline, unit.contentUnitId)) solutions.push(index);
  });
  return labels.slice(solutions.length).map((label) => ({
    kind: 'missing_solution' as const,
    unit,
    itemLabel: label,
    message: `${describe(unit)} item ${label} has no solution slide of its own (one solution slide per check item)`,
    anchorIndex: solutions[solutions.length - 1],
  }));
}

function sameStage(a: SceneOutline | undefined, b: SceneOutline | undefined): boolean {
  return (
    a?.teachingStage?.flowIndex === b?.teachingStage?.flowIndex &&
    a?.teachingStage?.key === b?.teachingStage?.key
  );
}

const PLACED_BY_RULE: ReadonlySet<string> = new Set(['prior_knowledge', 'exercise']);

/** A usable exercise: an `exercise` unit not marked unusable. */
function isUsableExercise(unit: KafuoBookStructureUnit): boolean {
  return unit.element === 'exercise' && unit.exerciseUsable !== false;
}

/** g5.v8: the recall slide (I-1, D-1 A) and the exercises block (I-3, D-3 C). */
function teacherParityGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): BookCoverageGap[] {
  const gaps: BookCoverageGap[] = [];
  const priors = book.units.filter((unit) => unit.element === 'prior_knowledge');
  if (
    priors.length > 0 &&
    !outlines.some(
      (outline) => teaches(outline) && priors.some((unit) => cites(outline, unit.contentUnitId)),
    )
  ) {
    // The recall opens part 1: it goes after the slide right before part 1's
    // first teaching slide (its transition), when both sit at one flow position.
    const partOne = new Set(
      book.units
        .filter((unit) => unit.partIndex === 1 && !PLACED_BY_RULE.has(String(unit.element)))
        .map((unit) => unit.contentUnitId),
    );
    const first = outlines.findIndex(
      (outline) =>
        teaches(outline) &&
        (outline.sourceContentUnitIds ?? []).some((id) => partOne.has(String(id))),
    );
    const notes = book.units.filter((unit) => unit.kind === 'MATH_READING');
    gaps.push({
      kind: 'missing_recall',
      unit: priors[0]!,
      citeUnitIds: [...priors, ...notes].map((unit) => unit.contentUnitId),
      message: `the recall slide citing the prior_knowledge units ${priors
        .map((unit) => unit.contentUnitId)
        .join(', ')} is missing at the start of part 1`,
      anchorIndex:
        first > 0 && sameStage(outlines[first - 1], outlines[first]) ? first - 1 : undefined,
    });
  }
  const usable = book.units.filter(isUsableExercise);
  if (
    book.exercisePolicy &&
    usable.length > 0 &&
    !outlines.some(
      (outline) =>
        teaches(outline) &&
        book.units.some(
          (unit) => unit.element === 'exercise' && cites(outline, unit.contentUnitId),
        ),
    )
  ) {
    // Choosing the items is the planner's or a person's call: no anchor.
    gaps.push({
      kind: 'missing_exercises',
      unit: usable[0]!,
      message: 'the exercises block is missing: no slide solves an exercise unit',
    });
  }
  return gaps;
}

const WORKING_STEP_LABELS: Readonly<Record<DetectedHiddenStepType, string>> = {
  ordered_named_set:
    'the numbered set (the whole cycle numbered, e.g. محرم = 1 … ذو الحجة = 12) before the step',
  clock_time: 'the time worked step by step in minutes, crossing noon explicitly',
};

/** The learner-visible text an outline plans: its title and key points. */
function visibleText(outline: SceneOutline): string {
  return [outline.title ?? '', ...(outline.keyPoints ?? [])].join('\n');
}

/**
 * g5.v8 findings that are not a missing slide: the exercise caps, an unusable
 * exercise cited, exercises out of place, and a solution without the visible
 * working of a detectable hidden-step type. All admin-correctable and ignorable.
 */
function teacherParityDiagnostics(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): OutlineDiagnostic[] {
  const diagnostics: OutlineDiagnostic[] = [];
  const exercises = book.units.filter((unit) => unit.element === 'exercise');
  const exerciseIds = new Set(exercises.map((unit) => unit.contentUnitId));
  const exerciseSlides: number[] = [];
  const cited = new Set<string>();
  outlines.forEach((outline, index) => {
    if (!teaches(outline)) return;
    const ids = (outline.sourceContentUnitIds ?? [])
      .map(String)
      .filter((id) => exerciseIds.has(id));
    if (ids.length === 0) return;
    exerciseSlides.push(index);
    ids.forEach((id) => cited.add(id));
  });

  const policy = book.exercisePolicy;
  if (policy) {
    // An instruction line (`instructions_only`) is cited beside its items and
    // is not an exercise; only usable units count against the cap.
    const counted = exercises.filter(
      (unit) => cited.has(unit.contentUnitId) && unit.exerciseUsable !== false,
    ).length;
    if (counted > policy.maxExercises) {
      diagnostics.push({
        code: EXERCISE_CAP_EXCEEDED,
        disposition: 'admin_correctable',
        field: 'sourceContentUnitIds',
        message: `the exercises block cites more than ${policy.maxExercises} exercise units`,
      });
    }
    if (exerciseSlides.length > policy.maxExerciseSlides) {
      diagnostics.push({
        code: EXERCISE_CAP_EXCEEDED,
        disposition: 'admin_correctable',
        field: 'sourceContentUnitIds',
        message: `the exercises block has more than ${policy.maxExerciseSlides} exercise slides`,
      });
    }
    // The minimum (owner, 2 Nov 2026). A plan with no exercise slide at all is
    // already the `missing_exercises` coverage gap, so it is not reported twice.
    if (exerciseSlides.length > 0 && policy.minExercises !== undefined) {
      if (counted < policy.minExercises) {
        diagnostics.push({
          code: EXERCISE_TOO_FEW,
          disposition: 'admin_correctable',
          field: 'sourceContentUnitIds',
          // No live count in the message: an ignore keys on it and must survive edits.
          message: `the exercises block cites fewer than ${policy.minExercises} usable exercise units`,
        });
      }
      if (
        policy.minExerciseSlides !== undefined &&
        exerciseSlides.length < policy.minExerciseSlides
      ) {
        diagnostics.push({
          code: EXERCISE_TOO_FEW,
          disposition: 'admin_correctable',
          field: 'sourceContentUnitIds',
          message: `the exercises block has fewer than ${policy.minExerciseSlides} exercise slides`,
        });
      }
    }
  }
  // The engine's selection (owner, 2 Nov 2026): the block cites exactly the
  // selected units. Checked by set only, and only once an exercise slide exists
  // (none at all is the `missing_exercises` gap). The messages carry the unit
  // id and no live count, so an ignore keyed on them survives edits.
  const selection = selectExercises(book, book.unitFacts);
  if (selection && exerciseSlides.length > 0) {
    const selected = new Set(selection.unitIds);
    for (const id of selection.unitIds) {
      if (cited.has(id)) continue;
      diagnostics.push({
        code: EXERCISE_SELECTED_MISSING,
        disposition: 'admin_correctable',
        field: 'sourceContentUnitIds',
        message: `exercise unit ${id} is selected for the exercises block but no exercise slide cites it`,
      });
    }
    for (const unit of exercises) {
      if (!cited.has(unit.contentUnitId) || !isUsableExercise(unit)) continue;
      if (selected.has(unit.contentUnitId)) continue;
      diagnostics.push({
        code: EXERCISE_UNSELECTED_CITED,
        disposition: 'admin_correctable',
        field: 'sourceContentUnitIds',
        message: `exercise unit ${unit.contentUnitId} is cited but is not selected for the exercises block`,
      });
    }
  }
  for (const unit of exercises) {
    if (
      cited.has(unit.contentUnitId) &&
      unit.exerciseUsable === false &&
      unit.exerciseUnusableReason !== 'instructions_only'
    ) {
      diagnostics.push({
        code: EXERCISE_UNUSABLE_CITED,
        disposition: 'admin_correctable',
        field: 'sourceContentUnitIds',
        message: `exercise unit ${unit.contentUnitId} is cited but its item did not survive the parse (${unit.exerciseUnusableReason})`,
      });
    }
  }

  // The block closes the lesson: after every slide teaching a book part, and
  // before the closing summary slide.
  const lastTaught = lastIndexWhere(
    outlines,
    (outline) =>
      teaches(outline) &&
      outline.contentRole !== 'summary' &&
      !(outline.sourceContentUnitIds ?? []).some((id) => exerciseIds.has(String(id))) &&
      book.units.some(
        (unit) =>
          unit.partIndex !== undefined &&
          !PLACED_BY_RULE.has(String(unit.element)) &&
          cites(outline, unit.contentUnitId),
      ),
  );
  const summary = lastIndexWhere(outlines, (outline) => outline.contentRole === 'summary');
  for (const index of exerciseSlides) {
    const early = lastTaught !== undefined && index < lastTaught;
    const late = summary !== undefined && index > summary;
    if (!early && !late) continue;
    const outline = outlines[index]!;
    diagnostics.push({
      code: EXERCISES_MISPLACED,
      disposition: 'admin_correctable',
      outlineIndex: index,
      ...(outline.id ? { outlineId: outline.id } : {}),
      field: 'sourceContentUnitIds',
      message: `outline #${index + 1} solves exercises outside the exercises block, which closes the last part before its summary slide`,
    });
  }

  // Visible working (I-2): the detectable hidden steps of a check or a cited
  // exercise must be written on its solution slides' title or key points.
  for (const unit of book.units) {
    const steps = book.unitFacts?.[unit.contentUnitId]?.hiddenSteps ?? [];
    if (steps.length === 0) continue;
    let solutions: SceneOutline[] = [];
    if (unit.element === 'try_it') {
      const tryIt = outlines.findIndex(
        (outline) =>
          teaches(outline) &&
          outline.contentRole === 'check_understanding' &&
          cites(outline, unit.contentUnitId),
      );
      solutions = outlines.filter(
        (outline, index) => index > tryIt && isSolutionOf(outline, unit.contentUnitId),
      );
    } else if (isUsableExercise(unit)) {
      solutions = outlines.filter(
        (outline) => teaches(outline) && cites(outline, unit.contentUnitId),
      );
    }
    // No solution slide at all is a coverage gap (or an exercise not picked).
    if (solutions.length === 0) continue;
    const visible = solutions.map(visibleText).join('\n');
    for (const step of steps) {
      if (showsWorkingStep(step, visible)) continue;
      diagnostics.push({
        code: WORKING_STEP_MISSING,
        disposition: 'admin_correctable',
        field: 'keyPoints',
        message: `${describe(unit)}: its solution does not write ${WORKING_STEP_LABELS[step]} (${step})`,
      });
    }
  }
  return diagnostics;
}

/**
 * The book map as the coverage gate reads it: a unit inside a part that the
 * template could not name (no kind, or a kind it does not map) is required when
 * its own role makes it an essential section (`essentialContentUnitIds`). Without
 * this the planner could drop it unnoticed and Submit alone would refuse the
 * package (`ESSENTIAL_SECTION_UNCOVERED`), after every scene was paid for.
 */
export function requireEssentialUntypedUnits<T extends KafuoBookStructure>(
  book: T | undefined,
  essentialIds: readonly string[] | null | undefined,
): T | undefined {
  if (!book || !essentialIds?.length) return book;
  const essential = new Set(essentialIds.map(String));
  return {
    ...book,
    units: book.units.map((unit) =>
      !unit.required &&
      unit.element === null &&
      unit.partIndex !== undefined &&
      essential.has(unit.contentUnitId)
        ? { ...unit, required: true }
        : unit,
    ),
  };
}

export function findBookCoverageDiagnostics(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure | undefined,
): OutlineDiagnostic[] {
  const gaps: OutlineDiagnostic[] = findBookCoverageGaps(outlines, book).map((gap) => ({
    code: BOOK_COVERAGE_INCOMPLETE,
    disposition: 'admin_correctable',
    field: 'sourceContentUnitIds',
    message: gap.message,
  }));
  return book?.teacherParity ? [...gaps, ...teacherParityDiagnostics(outlines, book)] : gaps;
}

/**
 * Add each unit's book kind and part to its `[[CONTENT_UNIT ...]]` marker
 * (`kind=WORKED_EXAMPLE part=2`). Text and ids are unchanged, so grounding and
 * citation work exactly as before. Without a book map the text is returned as is.
 */
export function annotateBookMarkers(text: string, book: KafuoBookStructure | undefined): string {
  if (!book) return text;
  const byId = new Map(book.units.map((unit) => [unit.contentUnitId, unit] as const));
  return text.replace(
    /\[\[CONTENT_UNIT id=([^\s\]]+)([^\]]*)\]\]/g,
    (marker, id: string, rest: string) => {
      const unit = byId.get(id);
      if (!unit) return marker;
      const kind = unit.kind ? ` kind=${unit.kind}` : '';
      const part = unit.partIndex !== undefined ? ` part=${unit.partIndex}` : '';
      const element = unit.element ? ` element=${unit.element}` : '';
      return `[[CONTENT_UNIT id=${id}${rest}${kind}${element}${part}${exerciseMarker(unit)}]]`;
    },
  );
}

/**
 * g5.v8: an exercise unit's «المثال N» and, when unusable, why. Only `exercise`
 * units carry it, and no earlier map has one, so every g5.v7 marker is unchanged.
 */
function exerciseMarker(unit: KafuoBookStructureUnit): string {
  if (unit.element !== 'exercise') return '';
  const paired = unit.pairedExampleUnitId ? ` paired=${unit.pairedExampleUnitId}` : '';
  const unusable =
    unit.exerciseUsable === false
      ? ` exerciseUsable=false reason=${unit.exerciseUnusableReason}`
      : '';
  return `${paired}${unusable}`;
}

/**
 * The planner guidance a book-structured request adds to the requirement.
 * `teacherParity` (the request's Teaching Model is g5.v8) selects the v8 text;
 * otherwise the g5.v7 text is returned byte for byte.
 */
export function bookStructureRequirement(
  book: KafuoBookStructure | undefined,
  options: { teacherParity?: boolean } = {},
): string {
  if (!book) return '';
  const rules = book.rules.map((rule) => `${rule.kind}=${rule.element}`).join(', ');
  if (options.teacherParity) return teacherParityRequirement(book, rules);
  return [
    '',
    'BOOK-STRUCTURED LESSON (g5.v7). Each [[CONTENT_UNIT]] marker shows the kind the book',
    `printed it as and its lesson part. The lesson template maps kinds to elements: ${rules}.`,
    'Plan in the book order: every required unit gets its own instructional slide that cites',
    'it; every try_it unit gets a try-it slide (contentRole check_understanding) without the',
    'answer, followed by a solution slide (contentRole worked_example) that cites it too.',
    "Never solve a try_it unit before its try-it slide: an example's own slide cites only",
    'the example, not the check that follows it.',
    'The book prints no answer to a check: its solution slide works every item to a final',
    'answer from the given data; an item that asks to guess or predict gets a reasoned number',
    '(for example from the average change), stated as an estimate.',
    'Transition slides never count as teaching a unit.',
  ].join('\n');
}

/** The g5.v8 planner guidance: recall, one solution per item, visible working, exercises. */
function teacherParityRequirement(book: KafuoBookStructure, rules: string): string {
  const policy = book.exercisePolicy;
  return [
    '',
    'BOOK-STRUCTURED LESSON (g5.v8). Each [[CONTENT_UNIT]] marker shows the kind the book',
    `printed it as and its lesson part. The lesson template maps kinds to elements: ${rules}.`,
    'Plan in the book order: every required unit gets its own instructional slide that cites it.',
    ...(book.units.some((unit) => unit.element === 'prior_knowledge')
      ? [
          'RECALL: part 1 opens, right after its transition slide, with ONE recall slide',
          '(contentRole explanation, contentKind definition) that cites every element=prior_knowledge',
          'unit and every kind=MATH_READING unit: the prior facts this lesson uses but does not',
          'teach, each in one line with a one-line example.',
        ]
      : []),
    'CHECKS: every try_it unit gets ONE try-it slide (contentRole check_understanding) that sets',
    "all of the check's items (1A, 1B, …) without their answers, then ONE solution slide",
    '(contentRole worked_example) PER ITEM, in the book order. Each solution slide cites the',
    "check's unit and works exactly one item to a final answer from the given data; an item",
    'that asks to guess or predict gets a reasoned number, stated as an estimate.',
    "Never solve a try_it unit before its try-it slide: an example's own slide cites only",
    'the example, not the check that follows it.',
    'VISIBLE WORKING: every solution plans each hidden step as its own key point, by type:',
    hiddenStepCatalogue(),
    ...(policy
      ? [
          'EXERCISES: element=exercise units are not taught one by one. Only in the last part,',
          'just before the closing summary slide, comes the exercises block: one transition slide',
          '«تمارين», then the exercise slides (contentRole worked_example). The engine fixes which',
          'exercise units the block solves and on which slide (EXERCISES BLOCK below). Each',
          'exercise slide states each of its items and solves it with compact visible working.',
          'Never cite a unit marked exerciseUsable=false, except a reason=instructions_only unit,',
          'which is only the instruction line of the exercises paired with the same example.',
        ]
      : []),
    'Transition slides never count as teaching a unit.',
  ].join('\n');
}

/**
 * g5.v8: the exercises block the engine selected ({@link selectExercises}),
 * as the planner must plan it. Built from the coverage book (map + pinned unit
 * facts), so the planner is told exactly the set the gate checks. Empty for
 * any other Teaching Model, without an `exercisePolicy`, or with no usable
 * exercise.
 */
export function exerciseBlockRequirement(book: CoverageBookStructure | undefined): string {
  if (!book?.teacherParity) return '';
  const selection = selectExercises(book, book.unitFacts);
  if (!selection) return '';
  const count = selection.slides.length;
  return [
    '',
    '',
    `EXERCISES BLOCK (fixed by the engine): one «تمارين» transition slide, then exactly ${count}`,
    `exercise slide${count === 1 ? '' : 's'} (contentRole worked_example), in this order:`,
    ...selection.slides.map(
      (ids, index) => `- exercise slide ${index + 1} solves the units ${ids.join(', ')};`,
    ),
    'Each exercise slide cites exactly its units above (and may also cite the',
    'reason=instructions_only unit paired with the same example). Do not cite any other',
    'exercise unit anywhere in the lesson.',
  ].join('\n');
}

/** Elements never taught one slide each: cover/ignored material and rule-placed blocks. */
const NOT_ONE_SLIDE_EACH: ReadonlySet<string> = new Set([
  'ignore',
  'objective_source',
  'prior_knowledge',
  'exercise',
]);

/**
 * Lesson 306 (F-2): the required book units the outline planner could SEE —
 * the denominator of the "cites fewer than half" broken-answer rule. A unit
 * counts only when it is required, is not recall / exercise / cover material,
 * and its `[[CONTENT_UNIT id=…]]` marker lies inside the source text the
 * prompt actually carries (`plannerText`, already cut to the prompt's limit).
 * A unit without retainable text has no marker, so it never counts either.
 */
export function plannerVisibleRequiredUnitIds(
  book: KafuoBookStructure | undefined,
  plannerText: string,
): string[] {
  if (!book) return [];
  const seen = new Set<string>();
  for (const match of plannerText.matchAll(/\[\[CONTENT_UNIT id=([^\s\]]+)/g)) {
    seen.add(match[1]!);
  }
  return book.units
    .filter(
      (unit) =>
        unit.required &&
        !NOT_ONE_SLIDE_EACH.has(String(unit.element ?? '')) &&
        seen.has(String(unit.contentUnitId)),
    )
    .map((unit) => String(unit.contentUnitId));
}
