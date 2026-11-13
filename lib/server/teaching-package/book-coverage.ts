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
 * check (all its items together; owner, 4 Nov 2026), the exercises block with its caps and its minimum, and the visible working of the
 * detectable hidden-step types. A g5.v7 attempt — new, resumed or corrected —
 * never carries the mark, so it is checked exactly as before.
 */
import { hiddenStepCatalogue, type OutlineDiagnostic } from '@openmaic/generation';
import {
  isSacredExerciseScene,
  withoutSacredItems,
} from '@/lib/server/teaching-package/sacred-text';

import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import {
  bookUnitFacts,
  exerciseQuestionNumbers,
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
/** g5.v8: a «تأكد» check has more than one solution slide (owner, 4 Nov 2026: one per check). */
export const SOLUTION_SLIDES_DUPLICATED = 'SOLUTION_SLIDES_DUPLICATED';
/** g5.v8: the recall slide comes after the first teaching slide of part 1. */
export const RECALL_NOT_FIRST = 'RECALL_NOT_FIRST';

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
/** A book exercise or «تأكد» check unit: its verse and hadith items are dropped (4 Nov 2026). */
export function isSacredExerciseElement(unit: KafuoBookStructureUnit): boolean {
  return unit.element === 'exercise' || unit.element === 'try_it';
}

/**
 * H-2: the exercise and «تأكد» check unit ids of a g5.v8 run's book map, for
 * single-slide regeneration and insertion; `undefined` without a map or on any
 * earlier Teaching Model (the rule stays off there, as in the run).
 */
export function sacredExerciseUnitIdsOf(
  book: KafuoBookStructure | undefined,
  teachingModel: { key?: string | null; version?: string | null } | null | undefined,
): string[] | undefined {
  if (!book || !isTeacherParityModel(teachingModel)) return undefined;
  return book.units.filter(isSacredExerciseElement).map((unit) => String(unit.contentUnitId));
}

/** Where a single-slide route's exercise scope came from (F-7). */
export type SacredExerciseScopeSource = 'book' | 'outline' | 'role' | 'off';

/**
 * F-7: the exercise unit ids of a single-slide regeneration or insertion. A
 * g5.v8 version whose attempt or book map cannot be read never turns the rule
 * off: it falls back to the units the Stage's own outline cites on its
 * exercise and check outlines (contentRole or teaching stage), and otherwise
 * to `[]`, the role/stage scope, which needs no unit ids.
 */
export function resolveSacredExerciseUnitIds(
  book: KafuoBookStructure | undefined,
  teachingModel: { key?: string | null; version?: string | null } | null | undefined,
  outlines: readonly SceneOutline[] | undefined,
): { unitIds: string[] | undefined; source: SacredExerciseScopeSource } {
  if (!isTeacherParityModel(teachingModel)) return { unitIds: undefined, source: 'off' };
  const fromBook = sacredExerciseUnitIdsOf(book, teachingModel);
  if (fromBook) return { unitIds: fromBook, source: 'book' };
  const fromOutline = [
    ...new Set(
      (outlines ?? [])
        .filter((outline) =>
          isSacredExerciseScene(
            {
              id: outline.id,
              content: { contentRole: outline.contentRole },
              teachingStage: outline.teachingStage,
            } as Parameters<typeof isSacredExerciseScene>[0],
            {},
          ),
        )
        .flatMap((outline) => (outline.sourceContentUnitIds ?? []).map(String)),
    ),
  ];
  if (fromOutline.length > 0) return { unitIds: fromOutline, source: 'outline' };
  return { unitIds: [], source: 'role' };
}

/**
 * M-4: the strip removed items and no numbered item is left: the book's numbered
 * items were all verses or hadith, or an unnumbered unit kept one line at most
 * (its instruction).
 */
function noItemsLeft(body: string, stripped: string): boolean {
  if (stripped === body || exerciseQuestionNumbers(stripped).length > 0) return false;
  const lines = stripped.split('\n').filter((line) => line.trim() !== '').length;
  return exerciseQuestionNumbers(body).length > 0 || lines <= 1;
}

export function bookUnitFactsOf(
  book: KafuoBookStructure,
  units: ReadonlyArray<{ id: string; text: string }>,
): Record<string, BookUnitFacts> {
  const text = new Map(units.map((unit) => [String(unit.id), unit.text] as const));
  const facts: Record<string, BookUnitFacts> = {};
  for (const unit of book.units) {
    const body = text.get(unit.contentUnitId);
    if (!factUnit(unit) || body === undefined) continue;
    // 4 Nov 2026: a verse or hadith item is never an exercise or check item,
    // so it is not counted (and the engine never selects it).
    const items = isSacredExerciseElement(unit) ? withoutSacredItems(body) : body;
    facts[unit.contentUnitId] = {
      ...bookUnitFacts(items),
      ...(noItemsLeft(body, items) ? { noItemsLeft: true as const } : {}),
    };
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
   * g5.v8, `missing_recall`: the outline whose teaching stage the new slide
   * takes (part 1's first teaching slide), when it differs from the anchor.
   */
  stageFromIndex?: number;
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
    }
    // g5.v8 (owner, 4 Nov 2026): one solution slide per check, solving all its
    // items together: more than one is SOLUTION_SLIDES_DUPLICATED, merged by
    // the repair (`mergeDuplicateSolutions`).
  }
  if (book.teacherParity) gaps.push(...teacherParityGaps(outlines, book));
  return gaps;
}

function isSolutionOf(outline: SceneOutline, unitId: string): boolean {
  return teaches(outline) && outline.contentRole === 'worked_example' && cites(outline, unitId);
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

/** Elements that are never part 1's own teaching (recall, exercises, cover material). */
const NOT_BODY: ReadonlySet<string> = new Set([
  'prior_knowledge',
  'exercise',
  'objective_source',
  'ignore',
]);

/** The g5.v8 flow's opening stages: they come before part 1 and never hold its recall. */
const OPENING_STAGE = /^lesson_(opener|learning_map)$/;

/**
 * g5.v8 recall (I-1): where the recall slide and part 1's first teaching slide
 * sit, among the slides after the opening stages (lesson_opener,
 * lesson_learning_map: an opener citing a prior_knowledge unit is not the
 * recall, lessons 315 and 317). `recall` is the first slide citing a
 * prior_knowledge unit and nothing else but MATH_READING notes (E-1: a later
 * part's slide reusing the prior unit is never the recall, so it never moves);
 * `first` the first other slide teaching a part-1 body unit.
 */
export function recallPlacement(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure,
): { recall?: number; first?: number } {
  const ids = (element: (unit: KafuoBookStructureUnit) => boolean) =>
    new Set(book.units.filter(element).map((unit) => unit.contentUnitId));
  const priors = ids((unit) => unit.element === 'prior_knowledge');
  const recallIds = new Set([...priors, ...ids((unit) => unit.kind === 'MATH_READING')]);
  const body = ids((unit) => unit.partIndex === 1 && !NOT_BODY.has(String(unit.element)));
  const citesAny = (outline: SceneOutline, set: ReadonlySet<string>) =>
    (outline.sourceContentUnitIds ?? []).some((id) => set.has(String(id)));
  const citesOnly = (outline: SceneOutline, set: ReadonlySet<string>) =>
    (outline.sourceContentUnitIds ?? []).every((id) => set.has(String(id)));
  let recall: number | undefined;
  let first: number | undefined;
  outlines.forEach((outline, index) => {
    if (!teaches(outline) || OPENING_STAGE.test(outline.teachingStage?.key ?? '')) return;
    if (citesAny(outline, priors) && citesOnly(outline, recallIds)) recall ??= index;
    else if (citesAny(outline, body)) first ??= index;
  });
  return { ...(recall !== undefined ? { recall } : {}), ...(first !== undefined ? { first } : {}) };
}

/**
 * g5.v8 (owner, 4 Nov 2026): the solution slides of each «تأكد» check —
 * `worked_example` slides after its try-it (any, when it has none) citing it
 * and no exercise unit, so the exercises block is never counted. Only checks
 * with two or more are returned, each with its slides in plan order.
 */
export function duplicateSolutionSlides(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure,
): Array<{ unitId: string; indexes: number[] }> {
  const exerciseIds = new Set(
    book.units.filter((unit) => unit.element === 'exercise').map((unit) => unit.contentUnitId),
  );
  const groups: Array<{ unitId: string; indexes: number[] }> = [];
  for (const unit of book.units) {
    if (unit.element !== 'try_it') continue;
    const tryIt = outlines.findIndex(
      (outline) =>
        teaches(outline) &&
        outline.contentRole === 'check_understanding' &&
        cites(outline, unit.contentUnitId),
    );
    const indexes: number[] = [];
    outlines.forEach((outline, index) => {
      if (index <= tryIt || !isSolutionOf(outline, unit.contentUnitId)) return;
      if ((outline.sourceContentUnitIds ?? []).some((id) => exerciseIds.has(String(id)))) return;
      indexes.push(index);
    });
    if (indexes.length > 1) groups.push({ unitId: unit.contentUnitId, indexes });
  }
  return groups;
}

/** g5.v8: the recall slide (I-1, D-1 A) and the exercises block (I-3, D-3 C). */
function teacherParityGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): BookCoverageGap[] {
  const gaps: BookCoverageGap[] = [];
  const priors = book.units.filter((unit) => unit.element === 'prior_knowledge');
  const placement = recallPlacement(outlines, book);
  if (priors.length > 0 && placement.recall === undefined) {
    // The recall opens part 1: it goes right before part 1's first teaching
    // slide, in that slide's teaching stage. An opener or learning-map slide
    // citing a prior unit is not the recall slide (lessons 315, 317).
    const first = placement.first;
    const notes = book.units.filter((unit) => unit.kind === 'MATH_READING');
    gaps.push({
      kind: 'missing_recall',
      unit: priors[0]!,
      citeUnitIds: [...priors, ...notes].map((unit) => unit.contentUnitId),
      message: `the recall slide citing the prior_knowledge units ${priors
        .map((unit) => unit.contentUnitId)
        .join(', ')} is missing at the start of part 1`,
      ...(first !== undefined && first > 0
        ? {
            anchorIndex: first - 1,
            ...(sameStage(outlines[first - 1], outlines[first]) ? {} : { stageFromIndex: first }),
          }
        : {}),
    });
  }
  // M-4: a unit with no item left after the verse/hadith strip is not usable.
  const usable = book.units.filter(
    (unit) => isUsableExercise(unit) && book.unitFacts?.[unit.contentUnitId]?.noItemsLeft !== true,
  );
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

/** The numbered items a selection plans: a multi-question unit its questions, any other one. */
function selectionItemCount(selection: NonNullable<ReturnType<typeof selectExercises>>): number {
  return selection.slides.reduce(
    (sum, ids, index) =>
      sum +
      ids.reduce((inner, id) => inner + (selection.slideQuestions?.[index]?.[id]?.length || 1), 0),
    0,
  );
}

/**
 * The numbered exercise items the plan's exercise slides set: a selected unit
 * cited there counts one, or, when it holds several numbered questions, the
 * ones its slides' title or key points number. A unit whose slides number none
 * of them counts what the selection gives it (the plan cannot be read finer).
 */
function plannedExerciseItems(
  outlines: readonly SceneOutline[],
  exerciseSlides: readonly number[],
  selection: NonNullable<ReturnType<typeof selectExercises>>,
  facts: Record<string, BookUnitFacts> | undefined,
): number {
  let total = 0;
  for (const id of selection.unitIds) {
    const slides = exerciseSlides.map((index) => outlines[index]!).filter((o) => cites(o, id));
    if (slides.length === 0) continue;
    const numbers = facts?.[id]?.questionNumbers ?? [];
    if (numbers.length < 2) {
      total += 1;
      continue;
    }
    const shown = new Set(
      slides.flatMap((outline) => exerciseQuestionNumbers(visibleText(outline))),
    );
    const planned = numbers.filter((n) => shown.has(n)).length;
    total +=
      planned > 0
        ? planned
        : (selection.slideQuestions ?? []).reduce((sum, q) => sum + (q[id]?.length ?? 0), 0);
  }
  return total;
}

const WORKING_STEP_LABELS: Readonly<Record<DetectedHiddenStepType, string>> = {
  // Both cycles named: the diagnostic knows the step type, not which cycle the unit counts
  // along, and a Hijri-only example read as wrong on a weekday item (13 Nov 2026).
  ordered_named_set:
    'the numbered set (the whole cycle numbered, e.g. السبت = 1 … الجمعة = 7, or محرم = 1 … ذو الحجة = 12) before the step',
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
  // One solution slide per check (owner, 4 Nov 2026; lessons 312, 317). No
  // live count in the message: an ignore keys on it and must survive edits.
  for (const group of duplicateSolutionSlides(outlines, book)) {
    diagnostics.push({
      code: SOLUTION_SLIDES_DUPLICATED,
      disposition: 'admin_correctable',
      field: 'sourceContentUnitIds',
      message: `check ${group.unitId} has more than one solution slide; one solution slide solves all of its items`,
    });
  }
  // Recall first (lessons 307, 315, 317): the recall slide opens part 1.
  if (book.units.some((unit) => unit.element === 'prior_knowledge')) {
    const { recall, first } = recallPlacement(outlines, book);
    if (recall !== undefined && first !== undefined && recall > first) {
      const outline = outlines[recall]!;
      diagnostics.push({
        code: RECALL_NOT_FIRST,
        disposition: 'admin_correctable',
        outlineIndex: recall,
        ...(outline.id ? { outlineId: outline.id } : {}),
        field: 'order',
        message:
          'the recall slide comes after the first teaching slide of part 1, which it must open',
      });
    }
  }
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
  // The engine's selection (owner, 2 Nov 2026). When it exists, the units are
  // checked by set alone (below), so a unit-count cap or minimum never reports
  // the same deviation twice; only the slide counts are checked here.
  const selection = selectExercises(book, book.unitFacts);
  if (policy) {
    // An instruction line (`instructions_only`) is cited beside its items and
    // is not an exercise; only usable units count against the cap.
    const counted = exercises.filter(
      (unit) => cited.has(unit.contentUnitId) && unit.exerciseUsable !== false,
    ).length;
    if (!selection && counted > policy.maxExercises) {
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
      // With a selection, the floor counts the numbered items the exercise
      // slides plan (lesson 312: 5 of 6): min(minExercises, the selection's items).
      // A selected unit left uncited is EXERCISE_SELECTED_MISSING alone.
      if (selection && selection.unitIds.every((id) => cited.has(id))) {
        const floor = Math.min(policy.minExercises, selectionItemCount(selection));
        if (plannedExerciseItems(outlines, exerciseSlides, selection, book.unitFacts) < floor) {
          diagnostics.push({
            code: EXERCISE_TOO_FEW,
            disposition: 'admin_correctable',
            field: 'keyPoints',
            message: `the exercises block plans fewer than ${floor} numbered exercise items`,
          });
        }
      }
      if (!selection && counted < policy.minExercises) {
        diagnostics.push({
          code: EXERCISE_TOO_FEW,
          disposition: 'admin_correctable',
          field: 'sourceContentUnitIds',
          // No live count in the message: an ignore keys on it and must survive edits.
          message: `the exercises block cites fewer than ${policy.minExercises} usable exercise units`,
        });
      }
      // The engine may plan fewer slides than the minimum (fewer exercises than
      // it needs): a plan that follows the engine is never refused for it.
      if (
        policy.minExerciseSlides !== undefined &&
        exerciseSlides.length < policy.minExerciseSlides &&
        !(selection && selection.slides.length < policy.minExerciseSlides)
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
  // The block cites exactly the selected units. Checked by set only, and only
  // once an exercise slide exists (none at all is the `missing_exercises` gap).
  // The messages carry the unit id and no live count, so an ignore keyed on
  // them survives edits.
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

/**
 * g5.v8: every check that follows a worked example, by id — the planner
 * skipped «مسائل تدريبية» checks after examples (lessons 308, 314, 315, 318).
 */
function checkListLine(book: KafuoBookStructure): string[] {
  const checks = book.units.filter(
    (unit) => unit.element === 'try_it' && unit.pairedExampleUnitId !== undefined,
  );
  if (checks.length === 0) return [];
  return [
    `Each of these checks needs its try-it slide AND its solution slide(s) right after its example's slide: ${checks
      .map((unit) => `${unit.contentUnitId} (after example ${unit.pairedExampleUnitId})`)
      .join(', ')}.`,
  ];
}

/** The g5.v8 planner guidance: recall, one solution per check, visible working, exercises. */
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
    "(contentRole worked_example) PER CHECK that cites the check's unit and solves ALL of its",
    'items together, in the book order, each to a final answer from the given data; an item',
    'that asks to guess or predict gets a reasoned number, stated as an estimate. Never split',
    "a check's solution across slides: each check has exactly one solution slide.",
    "Never solve a try_it unit before its try-it slide: an example's own slide cites only",
    'the example, not the check that follows it.',
    ...checkListLine(book),
    'VISIBLE WORKING: every solution plans each hidden step as its own key point, by type:',
    hiddenStepCatalogue(),
    ...(policy && !book.units.some(isUsableExercise)
      ? [
          'EXERCISES: no exercise unit of this lesson holds a usable item, so the lesson has no',
          'exercises block: plan no «تمارين» slide and cite no element=exercise unit.',
        ]
      : policy
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
    ...selection.slides.map((ids, index) => {
      const questions = selection.slideQuestions?.[index] ?? {};
      const units = ids.map((id) => {
        const numbers = questions[id];
        return numbers?.length ? `${id} (questions ${questionRange(numbers)} only)` : id;
      });
      return `- exercise slide ${index + 1} solves the units ${units.join(', ')};`;
    }),
    'Each exercise slide cites exactly its units above (and may also cite the',
    'reason=instructions_only unit paired with the same example). Do not cite any other',
    'exercise unit anywhere in the lesson.',
    ...(selection.slideQuestions
      ? [
          'A unit listed with questions holds several numbered questions: that slide states and',
          'solves only those questions, and the same unit is cited again on the slide that solves',
          'its next questions.',
        ]
      : []),
  ].join('\n');
}

/** «1–4», or «1, 3, 5» when the numbers are not consecutive. */
function questionRange(numbers: readonly number[]): string {
  const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1);
  return consecutive && numbers.length > 1
    ? `${numbers[0]}–${numbers[numbers.length - 1]}`
    : numbers.join(', ');
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
