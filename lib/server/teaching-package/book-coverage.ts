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

import { exerciseQuestionText } from '@/lib/server/teaching-package/attempt-quizzes';
import {
  selectExercises,
  type ExerciseGuideStatuses,
} from '@/lib/server/teaching-package/exercise-selection';
import { resolveTeacherGuide } from '@/lib/server/teaching-package/guide-answers';
import {
  bookUnitFacts,
  exerciseQuestionNumbers,
  showsWorkingStep,
  type BookUnitFacts,
  type DetectedHiddenStepType,
} from '@/lib/server/teaching-package/hidden-step-types';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
  KafuoBookStructureUnit,
  KafuoTeacherGuide,
} from '@/lib/types/teaching-package';

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
/**
 * 21 Nov 2026 (owner, slide findings point 3): a worked example taught on more than one
 * slide — either more than one `worked_example` slide cites it, or a
 * `check_understanding` slide cites the example without its own check («جرّب» repeats).
 */
export const EXAMPLE_TAUGHT_TWICE = 'EXAMPLE_TAUGHT_TWICE';
/** g5.v8: the recall slide comes after the first teaching slide of part 1. */
export const RECALL_NOT_FIRST = 'RECALL_NOT_FIRST';
/**
 * g5.v12 (planner review W1.2): a try-it or solution slide cites two or more checks —
 * of one part, or of two (lesson 227 slide 17: a physical and a chemical check).
 */
export const CHECKS_MERGED = 'CHECKS_MERGED';
/**
 * g5.v12 (planner review F9, "one idea per slide"): a teaching slide cites two or more
 * ideas — key concepts, examples, or the kind-less text that continues them (lesson 227
 * slide 7: three concepts on one slide).
 */
export const IDEAS_MERGED = 'IDEAS_MERGED';
/**
 * g5.v12 (decision D-2): a transition slide that holds only a title and one line. The
 * first teaching slide of a part names it; the «تمارين» transition of the exercises
 * block is the flow's own and is never reported.
 */
export const TITLE_ONLY_SLIDE = 'TITLE_ONLY_SLIDE';

/** The Teaching Model whose requests get the teacher-parity gates. */
export const TEACHER_PARITY_TEACHING_MODEL = { key: 'g5', version: 'g5.v8' } as const;

/**
 * g5.v9 (subject-teaching-skills-v1 plan, 14 Nov 2026) is g5.v8 plus a subject Teaching
 * Skill in the objective position's Skill Policy. Its flow, book map and exercise
 * policy are v8's, so it gets the same teacher-parity gates.
 */
const TEACHER_PARITY_VERSIONS: ReadonlySet<string> = new Set([
  TEACHER_PARITY_TEACHING_MODEL.version,
  'g5.v9',
  // g5.v10 (learner-first, plan `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`)
  // is built on g5.v9. The v8 gates its attempt step would fail get a v10 variant in
  // the wave that adds that step (plan W1, "v8 gates on v10").
  'g5.v10',
  // g5.v11 (teacher-guide answer referee, plan
  // `docs/frds/teacher-guide-answer-referee-plan-2026-11-16.md`) is g5.v10 plus the
  // approved guide answers, so it keeps every v8/v9/v10 gate.
  'g5.v11',
  // g5.v12 (book section order plan `docs/frds/book-section-order-fix-plan-2026-11-25.md`)
  // is g5.v11 plus the engine placing every teaching slide by its book part.
  'g5.v12',
]);

/** The ONE g5.v8–g5.v12 teacher-parity switch: an explicit Teaching Model identity check. */
export function isTeacherParityModel(
  model: { key?: string | null; version?: string | null } | null | undefined,
): boolean {
  return (
    model?.key === TEACHER_PARITY_TEACHING_MODEL.key &&
    typeof model?.version === 'string' &&
    TEACHER_PARITY_VERSIONS.has(model.version)
  );
}

/**
 * g5.v10, the learner-first Teaching Model (owner decisions D-1..D-10, 15 Nov 2026):
 * every weak-student fix of its plan ships behind THIS switch only, never on g5.v1–v9
 * (D-9 B).
 */
export const LEARNER_FIRST_TEACHING_MODEL = { key: 'g5', version: 'g5.v10' } as const;

/**
 * g5.v11 (teacher-guide answer referee plan §2.8, owner 16 Nov 2026): g5.v10 plus the
 * approved teacher-guide answers. Its own behaviour ships behind {@link isGuideAnswerModel}
 * only; every learner-first behaviour of g5.v10 applies to it unchanged.
 */
export const GUIDE_ANSWER_TEACHING_MODEL = { key: 'g5', version: 'g5.v11' } as const;

/**
 * g5.v12 (book section order plan, owner 25 Nov 2026): g5.v11 plus the engine placing every
 * teaching slide by its book part, in book order, inside the objective block that owns that
 * part. Its own behaviour ships behind {@link isBookPartPlacementModel} only; every g5.v11
 * behaviour (learner first, guide answers, teacher parity) applies to it unchanged.
 */
export const BOOK_PART_PLACEMENT_TEACHING_MODEL = { key: 'g5', version: 'g5.v12' } as const;

/** The Teaching Model versions that get every g5.v10 learner-first behaviour. */
const LEARNER_FIRST_VERSIONS: ReadonlySet<string> = new Set([
  LEARNER_FIRST_TEACHING_MODEL.version,
  GUIDE_ANSWER_TEACHING_MODEL.version,
  BOOK_PART_PLACEMENT_TEACHING_MODEL.version,
]);

/** The Teaching Model versions that get every g5.v11 guide-answer behaviour. */
const GUIDE_ANSWER_VERSIONS: ReadonlySet<string> = new Set([
  GUIDE_ANSWER_TEACHING_MODEL.version,
  BOOK_PART_PLACEMENT_TEACHING_MODEL.version,
]);

/** The ONE g5.v10–g5.v12 learner-first switch: an explicit Teaching Model identity check. */
export function isLearnerFirstModel(
  model: { key?: string | null; version?: string | null } | null | undefined,
): boolean {
  return (
    model?.key === LEARNER_FIRST_TEACHING_MODEL.key &&
    typeof model?.version === 'string' &&
    LEARNER_FIRST_VERSIONS.has(model.version)
  );
}

/** The ONE g5.v11/g5.v12 switch (the approved teacher-guide answers): an explicit identity check. */
export function isGuideAnswerModel(
  model: { key?: string | null; version?: string | null } | null | undefined,
): boolean {
  return (
    model?.key === GUIDE_ANSWER_TEACHING_MODEL.key &&
    typeof model?.version === 'string' &&
    GUIDE_ANSWER_VERSIONS.has(model.version)
  );
}

/** The ONE g5.v12 switch (book-part placement): an explicit Teaching Model identity check. */
export function isBookPartPlacementModel(
  model: { key?: string | null; version?: string | null } | null | undefined,
): boolean {
  return (
    model?.key === BOOK_PART_PLACEMENT_TEACHING_MODEL.key &&
    model?.version === BOOK_PART_PLACEMENT_TEACHING_MODEL.version
  );
}

/**
 * g5.v10 quality plan W4: the outline checks' learner-first visual rules, with the
 * book's exercise units («تمارين»; never the checks): an exercise slide shows no
 * image of its exercise list.
 */
export function learnerFirstVisualsOf(
  book:
    | { units: ReadonlyArray<{ element?: string | null; contentUnitId: string | number }> }
    | null
    | undefined,
): { exerciseUnitIds: string[] } {
  return {
    exerciseUnitIds: (book?.units ?? [])
      .filter((unit) => unit.element === 'exercise')
      .map((unit) => String(unit.contentUnitId)),
  };
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
  /** g5.v10: the learner-first repairs apply (an oversized exercises block is merged). */
  learnerFirst?: true;
  /** g5.v8: per check / exercise unit, the facts its gates read (no text). */
  unitFacts?: Record<string, BookUnitFacts>;
  /**
   * g5.v11 only: the teacher-guide marks of the exercise questions, resolved from the
   * attempt's pinned `teacherGuide` and these unit facts, so every `selectExercises`
   * caller (planner text, gates, repair, attempts, correction) picks the same set.
   */
  exerciseGuide?: ExerciseGuideStatuses;
  /**
   * g5.v11 only (lesson 2-5, 17 Nov 2026): every book example keeps a slide of its own
   * before its check — a slide teaching another example is never merged into a check's
   * solution, and an example taught only on a check's slides is planned once
   * ({@link missingExampleGaps}).
   */
  examplesKept?: true;
  /**
   * g5.v12 only (critical items, 27 Nov 2026; planner review W1): the book-part rules.
   * Every check is gated, paired or not; every listed part unit is taught; one check and
   * one idea per slide; no title-only transition slide.
   */
  bookPartPlacement?: true;
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
  /**
   * Lesson 2-5 (17 Nov 2026, g5.v11 callers only): questions sharing a book line are
   * counted each («(25 … (26 …»). Off, every earlier model counts as the backend does.
   */
  options: { inlineQuestions?: boolean } = {},
): Record<string, BookUnitFacts> {
  const text = new Map(units.map((unit) => [String(unit.id), unit.text] as const));
  const facts: Record<string, BookUnitFacts> = {};
  for (const unit of book.units) {
    const body = text.get(unit.contentUnitId);
    if (!factUnit(unit) || body === undefined) continue;
    // 4 Nov 2026: a verse or hadith item is never an exercise or check item,
    // so it is not counted (and the engine never selects it).
    const items = isSacredExerciseElement(unit) ? withoutSacredItems(body) : body;
    const unitFacts = bookUnitFacts(items, options);
    // Lesson 2-5 (g5.v11): a question whose own text the attempt cannot read, or that
    // prints no given (a graph-only one), is never set as a try without its figure.
    const numbers = unitFacts.questionNumbers ?? [];
    const unaskable =
      options.inlineQuestions === true && unit.element === 'exercise' && numbers.length >= 2
        ? numbers.filter((number) => {
            const own = exerciseQuestionText(items, number, null, true);
            return own === null || !/[0-9٠-٩]/u.test(own);
          })
        : [];
    facts[unit.contentUnitId] = {
      ...unitFacts,
      ...(noItemsLeft(body, items) ? { noItemsLeft: true as const } : {}),
      ...(unaskable.length > 0 ? { unaskableQuestions: unaskable } : {}),
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
  /** g5.v11 only: the attempt's guide items; ignored on every other Teaching Model. */
  teacherGuide?: KafuoTeacherGuide | null,
): CoverageBookStructure | undefined {
  if (!book || !isTeacherParityModel(teachingModel)) return book;
  return {
    ...book,
    teacherParity: true,
    ...(isLearnerFirstModel(teachingModel) ? { learnerFirst: true as const } : {}),
    ...(unitFacts ? { unitFacts } : {}),
    ...(teacherGuide && isGuideAnswerModel(teachingModel)
      ? { exerciseGuide: resolveTeacherGuide(teacherGuide, book, unitFacts).exerciseStatuses }
      : {}),
    ...(isGuideAnswerModel(teachingModel) ? { examplesKept: true as const } : {}),
    ...(isBookPartPlacementModel(teachingModel) ? { bookPartPlacement: true as const } : {}),
  };
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

/** A teaching slide: a slide that is not a cover, contents, transition or end slide. */
export function teaches(outline: SceneOutline): boolean {
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
  | 'missing_exercises'
  // g5.v11 only (`missingExampleGaps`, never a diagnosis: planned once, else logged):
  | 'missing_example';

/**
 * g5.v12 (EN-6): the coverage gaps Submit re-checks on the live Stage — those the pinned
 * book alone can decide. The recall and the exercises blocks need the unit facts only a
 * checkpoint pinned, so they are not re-judged there.
 */
export const SUBMIT_RECHECKED_GAP_KINDS: ReadonlySet<BookCoverageGapKind> = new Set([
  'missing_teaching',
  'missing_try_it',
  'missing_solution',
  'solution_before_try_it',
]);

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

  // g5.v12: an idea — a key concept, an example, or the kind-less text that continues
  // them — is taught by a teaching slide of its own. Its citation on a slide that sets or
  // solves a check is no evidence it was taught (review 27 Nov 2026: 6758 cited only on a
  // solution slide passed "every listed unit is taught"). Nor is its citation on the
  // part's orientation or the closing summary (wave 1 review, M1: Submit's essential gate
  // never counts those, so the plan passed and Submit refused after every Scene was
  // paid). Every earlier model counts a citation on any teaching slide, exactly as before.
  const checkIds =
    book.bookPartPlacement === true
      ? new Set(
          book.units.filter((unit) => unit.element === 'try_it').map((unit) => unit.contentUnitId),
        )
      : null;
  // g5.v12 (m-A): a side note (`supporting`) cited only on the orientation, the closing
  // summary or a try-it slide is not taught either — unless it explains the very check
  // that try-it sets (its `attachesToUnitId`), where the book prints it.
  const sideNoteNotTaughtOn = (outline: SceneOutline, unit: KafuoBookStructureUnit): boolean =>
    outline.contentRole === 'orientation' ||
    outline.contentRole === 'summary' ||
    (outline.contentRole === 'check_understanding' &&
      !(unit.attachesToUnitId !== undefined && cites(outline, unit.attachesToUnitId)));
  const taughtOn = (outline: SceneOutline, unit: KafuoBookStructureUnit): boolean =>
    teaches(outline) &&
    cites(outline, unit.contentUnitId) &&
    !(
      checkIds !== null &&
      isIdeaUnit(unit) &&
      (outline.contentRole === 'orientation' ||
        outline.contentRole === 'summary' ||
        citedIds(outline).some((id) => checkIds.has(id)))
    ) &&
    !(checkIds !== null && unit.element === 'supporting' && sideNoteNotTaughtOn(outline, unit));

  book.units.forEach((unit, position) => {
    if (!unit.required) return;
    if (outlines.some((outline) => taughtOn(outline, unit))) return;
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

  for (const [position, unit] of book.units.entries()) {
    const example = unit.pairedExampleUnitId;
    // g5.v12 (W1.1): every check is gated. Before, a check the book prints after a
    // concept («ماذا قرأت؟»), which pairs with no example, was never asked for: its
    // try-it slide, its solution and their order went unchecked.
    if (unit.element !== 'try_it' || (example === undefined && book.bookPartPlacement !== true)) {
      continue;
    }
    const tryIt = outlines.findIndex(
      (outline) =>
        teaches(outline) &&
        outline.contentRole === 'check_understanding' &&
        cites(outline, unit.contentUnitId),
    );
    if (tryIt < 0) {
      gaps.push({
        kind: 'missing_try_it',
        unit,
        message:
          example !== undefined
            ? `${describe(unit)} (the check after example ${example}) has no try-it slide`
            : `${describe(unit)} has no try-it slide`,
        anchorIndex:
          example !== undefined
            ? lastIndexWhere(outlines, (outline) => teaches(outline) && cites(outline, example))
            : unpairedTryItAnchor(outlines, book, unit, position),
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

/**
 * g5.v12 (W1.1): where the try-it slide of a check that pairs with no example belongs —
 * right after the last teaching slide citing an earlier unit of its part, else after the
 * last one citing its part's key concept (else its first unit). `undefined` when no slide
 * of the plan places it; the repair may still place it before the part's first slide.
 */
function unpairedTryItAnchor(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
  unit: KafuoBookStructureUnit,
  position: number,
): number | undefined {
  if (unit.partIndex === undefined) return undefined;
  const part = book.units.filter((other) => other.partIndex === unit.partIndex);
  const earlier = new Set(
    book.units
      .slice(0, position)
      .filter((other) => other.partIndex === unit.partIndex)
      .map((other) => other.contentUnitId),
  );
  const afterEarlier =
    earlier.size > 0
      ? lastIndexWhere(
          outlines,
          (outline) =>
            teaches(outline) &&
            (outline.sourceContentUnitIds ?? []).some((id) => earlier.has(String(id))),
        )
      : undefined;
  if (afterEarlier !== undefined) return afterEarlier;
  const concept =
    part.find((other) => other.element === 'key_concept') ??
    book.units.find((other) => other.partIndex === unit.partIndex);
  return concept
    ? lastIndexWhere(
        outlines,
        (outline) => teaches(outline) && cites(outline, concept.contentUnitId),
      )
    : undefined;
}

/**
 * Lesson 2-5 (17 Nov 2026, g5.v11 books only, `examplesKept`): the book's required worked
 * examples that have no slide of their own before the check that follows them — cited
 * only by a check's try-it slide or a check's solution (item 214: Example 3 sat only on
 * check 2's solution and check 3's try, so check 3 was tried with no example). Each is
 * anchored right before that check's try-it slide (with no such try, after the last
 * slide of an earlier unit of its part). NOT a coverage diagnosis: the runner plans each
 * once after the outline gates, and only logs one it cannot place — never a pause.
 */
export function missingExampleGaps(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure | undefined,
): BookCoverageGap[] {
  if (!book?.examplesKept) return [];
  const checks = new Set(
    book.units.filter((unit) => unit.element === 'try_it').map((unit) => unit.contentUnitId),
  );
  const ownSlide = (outline: SceneOutline) =>
    teaches(outline) &&
    outline.contentRole !== 'check_understanding' &&
    !(outline.sourceContentUnitIds ?? []).some((id) => checks.has(String(id)));
  const gaps: BookCoverageGap[] = [];
  book.units.forEach((unit, position) => {
    if (unit.element !== 'worked_example' || !unit.required) return;
    const check = book.units.find(
      (other) => other.element === 'try_it' && other.pairedExampleUnitId === unit.contentUnitId,
    );
    const tryAt = check
      ? outlines.findIndex(
          (outline) =>
            teaches(outline) &&
            outline.contentRole === 'check_understanding' &&
            cites(outline, check.contentUnitId),
        )
      : -1;
    const before = tryAt >= 0 ? outlines.slice(0, tryAt) : outlines;
    if (before.some((outline) => ownSlide(outline) && cites(outline, unit.contentUnitId))) return;
    const earlier = new Set(
      book.units
        .slice(0, position)
        .filter((other) => other.partIndex !== undefined && other.partIndex === unit.partIndex)
        .map((other) => other.contentUnitId),
    );
    const anchorIndex =
      tryAt > 0
        ? tryAt - 1
        : earlier.size > 0
          ? lastIndexWhere(
              outlines,
              (outline) =>
                teaches(outline) &&
                (outline.sourceContentUnitIds ?? []).some((id) => earlier.has(String(id))),
            )
          : undefined;
    gaps.push({
      kind: 'missing_example',
      unit,
      message: `${describe(unit)} has no slide of its own before its check`,
      ...(anchorIndex !== undefined && anchorIndex >= 0 ? { anchorIndex } : {}),
    });
  });
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
/**
 * The worked examples taught on more than one slide (21 Nov 2026). For each book
 * `worked_example` unit, the slide indexes that only repeat its teaching:
 *
 * - every `worked_example` slide after the first that cites the example without citing
 *   any check (a solution slide cites a check — this example's or another's — so it never
 *   counts, review H3) and without citing any exercise unit;
 * - when the example HAS a check in the book map, every `check_understanding` slide that
 *   cites the example but no check — the «جرّب» slide that repeats the example instead of
 *   checking it. An example with no check keeps its "write one similar item" slide (the
 *   v8/v10 rule, review H4).
 *
 * `firstIndex` is the example's first teaching slide, when it has one (the message names
 * it by position and title). Dropped by the repair (`dropExamplesTaughtTwice`); the
 * check's own try-it slide is then planned in the dropped «جرّب» slide's place.
 */
export function examplesTaughtTwice(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure,
): Array<{ unitId: string; indexes: number[]; firstIndex?: number }> {
  const exerciseIds = new Set(
    book.units.filter((unit) => unit.element === 'exercise').map((unit) => unit.contentUnitId),
  );
  const checkIds = new Set(
    book.units.filter((unit) => unit.element === 'try_it').map((unit) => unit.contentUnitId),
  );
  const groups: Array<{ unitId: string; indexes: number[]; firstIndex?: number }> = [];
  for (const unit of book.units) {
    if (unit.element !== 'worked_example') continue;
    const exampleId = unit.contentUnitId;
    const checkId = book.units.find(
      (candidate) =>
        candidate.element === 'try_it' &&
        String(candidate.pairedExampleUnitId) === String(exampleId),
    )?.contentUnitId;
    const repeats: number[] = [];
    let firstIndex: number | undefined;
    outlines.forEach((outline, index) => {
      if (!teaches(outline) || !cites(outline, exampleId)) return;
      const citesAny = (ids: ReadonlySet<string>) =>
        (outline.sourceContentUnitIds ?? []).some((id) => ids.has(String(id)));
      if (citesAny(checkIds) || citesAny(exerciseIds)) return;
      if (outline.contentRole === 'check_understanding') {
        // The «جرّب» repeat: it teaches the example and checks nothing of its own.
        // Without a check in the book this is the "one similar item" slide: kept.
        if (checkId !== undefined) repeats.push(index);
        return;
      }
      if (outline.contentRole === 'worked_example') {
        if (firstIndex === undefined) firstIndex = index;
        else repeats.push(index);
      }
    });
    if (repeats.length > 0) {
      groups.push({
        unitId: exampleId,
        indexes: repeats,
        ...(firstIndex !== undefined ? { firstIndex } : {}),
      });
    }
  }
  return groups;
}

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

/** One slide that merges what the book prints apart: the slide and the units it merges, in book order. */
export interface MergedSlide {
  index: number;
  outline: SceneOutline;
  units: KafuoBookStructureUnit[];
}

const citedIds = (outline: SceneOutline): string[] =>
  (outline.sourceContentUnitIds ?? []).map(String);

/**
 * g5.v12 (W1.2): every try-it or solution slide citing two or more checks, with its
 * checks in book order. A slide that solves exercises is the exercises block's and is
 * never a merged check.
 */
export function mergedCheckSlides(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure,
): MergedSlide[] {
  const isCheck = (unit: KafuoBookStructureUnit) => unit.element === 'try_it';
  const exercises = new Set(
    book.units.filter((unit) => unit.element === 'exercise').map((unit) => unit.contentUnitId),
  );
  const merged: MergedSlide[] = [];
  outlines.forEach((outline, index) => {
    if (!teaches(outline)) return;
    const ids = citedIds(outline);
    if (ids.some((id) => exercises.has(id))) return;
    if (outline.contentRole !== 'check_understanding' && outline.contentRole !== 'worked_example') {
      return;
    }
    const checks = book.units.filter((unit) => isCheck(unit) && ids.includes(unit.contentUnitId));
    if (checks.length >= 2) merged.push({ index, outline, units: checks });
  });
  return merged;
}

/**
 * A unit that is an idea of its own: a key concept, an example, or the kind-less text
 * that continues a part's explanation (D-4). A side note is not: it stays on the slide
 * of the element it explains.
 */
export function isIdeaUnit(unit: Pick<KafuoBookStructureUnit, 'element' | 'partIndex'>): boolean {
  return (
    unit.element === 'key_concept' ||
    unit.element === 'worked_example' ||
    (unit.element === null && unit.partIndex !== undefined)
  );
}

/**
 * g5.v12 ("one idea per slide"): every teaching slide citing two or more ideas. A slide
 * that sets or solves a check, or solves exercises, follows the checks' rules instead
 * ({@link mergedCheckSlides}); the closing slide and an orientation cite several units
 * by design.
 */
export function ideasMergedSlides(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure,
): MergedSlide[] {
  const byRule = new Set(
    book.units
      .filter((unit) => unit.element === 'try_it' || unit.element === 'exercise')
      .map((unit) => unit.contentUnitId),
  );
  const merged: MergedSlide[] = [];
  outlines.forEach((outline, index) => {
    if (
      !teaches(outline) ||
      outline.contentRole === 'summary' ||
      outline.contentRole === 'orientation'
    ) {
      return;
    }
    const ids = citedIds(outline);
    if (ids.some((id) => byRule.has(id))) return;
    // Only an idea the plan must teach (required: listed, or the template's): taking a
    // slide out for a unit no gate requires would drop that unit with no gap to plan it
    // again (wave 1 review, L4).
    const ideas = book.units.filter(
      (unit) => unit.required && isIdeaUnit(unit) && ids.includes(unit.contentUnitId),
    );
    if (ideas.length >= 2) merged.push({ index, outline, units: ideas });
  });
  return merged;
}

/** A line beyond the title: one short paragraph at most. */
const TITLE_ONLY_MAX_CHARS = 160;

/** The exercises block's own transition title, «تمارين». */
const EXERCISES_TITLE = /^\s*[«"(]?\s*تمارين/u;

/**
 * g5.v12 (decision D-2): the transition slides that hold a title and one line at most.
 * The «تمارين» transition that opens the exercises block is the flow's own, a title by
 * design, and is never one of them. Neither is a transition that shows one of the book's
 * own visuals: it is a picture slide, and dropping it would drop the picture (review 27
 * Nov 2026, LOW).
 */
export function titleOnlyTransitions(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure,
): number[] {
  const exercises = new Set(
    book.units.filter((unit) => unit.element === 'exercise').map((unit) => unit.contentUnitId),
  );
  return outlines.flatMap((outline, index) => {
    if (outline.type !== 'slide' || outline.slideType !== 'transition') return [];
    if (citedIds(outlines[index + 1] ?? ({} as SceneOutline)).some((id) => exercises.has(id))) {
      return [];
    }
    // Wave 2: the «تمارين» transition is a title by design, wherever it sits (its next
    // slide may be an attempt or carry no exercise citation yet).
    if (EXERCISES_TITLE.test(outline.title ?? '')) return [];
    if ((outline.suggestedImageIds ?? []).length > 0) return [];
    const lines = [...(outline.keyPoints ?? []), outline.description ?? '']
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const tooLittle = lines.length < 2 && lines.join(' ').length <= TITLE_ONLY_MAX_CHARS;
    return tooLittle ? [index] : [];
  });
}

/**
 * g5.v12 findings of the book-part rules: merged checks (W1.2), several ideas on one
 * slide, and a title-only transition slide. All admin-correctable. The book's own order
 * is checked by `findBookOrderDiagnostics` (`book-part-placement.ts`), which needs the
 * lesson's parts.
 */
function bookPartPlacementDiagnostics(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure,
): OutlineDiagnostic[] {
  const diagnostics: OutlineDiagnostic[] = [];
  const label = (index: number) => `outline #${index + 1} «${outlines[index]!.title ?? ''}»`;
  const ids = (units: readonly KafuoBookStructureUnit[]) =>
    units.map((unit) => unit.contentUnitId).join(', ');
  for (const group of mergedCheckSlides(outlines, book)) {
    diagnostics.push({
      code: CHECKS_MERGED,
      disposition: 'admin_correctable',
      outlineIndex: group.index,
      ...(group.outline.id ? { outlineId: group.outline.id } : {}),
      field: 'sourceContentUnitIds',
      message: `${label(group.index)} sets or solves the checks ${ids(group.units)} on one slide; plan ONE try-it slide and ONE solution slide per check, each citing only its own check`,
    });
  }
  for (const group of ideasMergedSlides(outlines, book)) {
    diagnostics.push({
      code: IDEAS_MERGED,
      disposition: 'admin_correctable',
      outlineIndex: group.index,
      ...(group.outline.id ? { outlineId: group.outline.id } : {}),
      field: 'sourceContentUnitIds',
      message: `${label(group.index)} teaches the units ${ids(group.units)} on one slide; teach ONE of them per slide, in book order`,
    });
  }
  for (const index of titleOnlyTransitions(outlines, book)) {
    const outline = outlines[index]!;
    diagnostics.push({
      code: TITLE_ONLY_SLIDE,
      disposition: 'admin_correctable',
      outlineIndex: index,
      ...(outline.id ? { outlineId: outline.id } : {}),
      field: 'keyPoints',
      message: `${label(index)} is a transition slide holding only a title and one line; plan no such slide — the part's first teaching slide names the part`,
    });
  }
  return diagnostics;
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
  // 21 Nov 2026: an example taught on more than one slide. The message names each
  // repeat — and the slide that already teaches the example — by 1-based position and
  // title, as the owner reads them; never by unit id (review LOW).
  for (const group of examplesTaughtTwice(outlines, book)) {
    const first = group.firstIndex !== undefined ? outlines[group.firstIndex] : undefined;
    const taughtOn = first
      ? `على الشريحة ${group.firstIndex! + 1}: «${first.title ?? ''}»`
      : 'على شريحة أخرى';
    for (const index of group.indexes) {
      const outline = outlines[index]!;
      diagnostics.push({
        code: EXAMPLE_TAUGHT_TWICE,
        disposition: 'admin_correctable',
        outlineIndex: index,
        ...(outline.id ? { outlineId: outline.id } : {}),
        field: 'sourceContentUnitIds',
        message: `الشريحة ${index + 1}: «${outline.title ?? ''}» تُعيد شرح مثال مشروح أصلًا ${taughtOn}؛ احذف هذه الشريحة`,
      });
    }
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
/**
 * Lesson 2-5 (17 Nov 2026): the normalized content's practice subtypes, as the book
 * profile kinds they print («تأكد» = GUIDED_PRACTICE, «تدرب وحل المسائل» = PRACTICE).
 */
const PRACTICE_SUBTYPE_KIND: Readonly<Record<string, string>> = {
  GUIDED_PRACTICE: 'GUIDED_PRACTICE',
  INDEPENDENT_PRACTICE: 'PRACTICE',
};

/**
 * Lesson 2-5 (17 Nov 2026, g5.v11 callers only): a practice unit the book map left
 * untyped (`kind` and `element` null: a «تأكد» or a «تدرب» continuation printed without
 * its title, units 6419 and 6423) takes the kind its normalized subtype names, and the
 * element the map's OWN rules give that kind (`exercise`). Only a `PRACTICE_SET` unit,
 * only a subtype listed above, only when the rules make it an exercise; every other unit
 * (an `ignore`d test-prep or cumulative review among them) is left as the map sent it.
 * The SAME book when nothing changes.
 */
export function withTypedPracticeUnits<T extends KafuoBookStructure>(
  book: T | undefined,
  units: ReadonlyArray<{ id: string; role?: string | null; subtype?: string | null }>,
): T | undefined {
  if (!book) return book;
  const byId = new Map(units.map((unit) => [String(unit.id), unit] as const));
  let changed = false;
  const typed = book.units.map((unit) => {
    if (unit.element !== null || unit.kind !== null) return unit;
    const source = byId.get(String(unit.contentUnitId));
    if (source?.role?.toUpperCase() !== 'PRACTICE_SET') return unit;
    const kind = PRACTICE_SUBTYPE_KIND[source.subtype?.toUpperCase() ?? ''];
    if (!kind) return unit;
    const element = book.rules.find((rule) => rule.kind === kind)?.element;
    if (element !== 'exercise') return unit;
    changed = true;
    return { ...unit, kind, element };
  });
  return changed ? { ...book, units: typed } : book;
}

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

/**
 * g5.v12 (W1.6, critical items 27 Nov 2026): every unit the plan must teach is `required`
 * on the coverage book, so the plan is gated, repaired and reviewed for it as if the
 * Lesson Template required it — each unit listed in the lesson's parts (F11: 6763, 6765
 * and 6770 got no slide and no report) and each essential section Submit refuses an
 * untaught package for (F10: 6752, which only the cover cited). Only a unit the map
 * already carries is marked; the SAME book when nothing changes.
 */
export function requireTaughtUnits<T extends KafuoBookStructure>(
  book: T | undefined,
  unitIds: readonly string[] | null | undefined,
): T | undefined {
  if (!book || !unitIds?.length) return book;
  const taught = new Set(unitIds.map(String));
  return {
    ...book,
    units: book.units.map((unit) =>
      !unit.required && taught.has(unit.contentUnitId) ? { ...unit, required: true } : unit,
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
  if (!book?.teacherParity) return gaps;
  return [
    ...gaps,
    ...teacherParityDiagnostics(outlines, book),
    ...(book.bookPartPlacement === true ? bookPartPlacementDiagnostics(outlines, book) : []),
  ];
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
 * otherwise the g5.v7 text is returned byte for byte. `bookPartPlacement` (g5.v12)
 * gives the learner-first text its one-idea-per-slide rule in place of v10's.
 */
export function bookStructureRequirement(
  book: KafuoBookStructure | undefined,
  options: {
    teacherParity?: boolean;
    learnerFirst?: boolean;
    bookPartPlacement?: boolean;
    /**
     * g5.v12 only (Wave 2, MI-2 / W2.6): the routing subject code. The maths-only lines
     * (CLAIMS, DATA, CYCLES, the conjecture caution, the hidden-step catalogue) go to a
     * `MATH` lesson alone. Read only with `bookPartPlacement`.
     */
    subjectCode?: string | null;
  } = {},
): string {
  if (!book) return '';
  const rules = book.rules.map((rule) => `${rule.kind}=${rule.element}`).join(', ');
  if (options.teacherParity) {
    return teacherParityRequirement(
      book,
      rules,
      options.learnerFirst === true,
      options.bookPartPlacement === true,
      options.subjectCode ?? null,
    );
  }
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

/** The catalogue row g5.v10 rewrites (owner D-2.5, D-2.7); pinned by a test. */
export const AVERAGE_CHANGE_STEP =
  'Show the average change as a calculation, then the estimate, then whether it can be relied on';
const LEARNER_FIRST_ESTIMATE_STEP =
  'State what is expected next, reasoned with the method the book itself uses (never an average-change calculation the book does not use), then why the data support it, then whether it can be relied on';

/** g5.v10: the hidden-step catalogue without the invented average-change method. */
export function learnerFirstPlannerCatalogue(): string {
  const catalogue = hiddenStepCatalogue();
  return catalogue.includes(AVERAGE_CHANGE_STEP)
    ? catalogue.replace(AVERAGE_CHANGE_STEP, LEARNER_FIRST_ESTIMATE_STEP)
    : catalogue;
}

/** The g5.v10 planner text's definition rule, before its one-idea sentence. */
const DEFINITION_BOX_RULE =
  "- DEFINITIONS: the first slide that uses a term this lesson teaches shows a definition box with the term and the book's own definition sentence, verbatim (cite that concept unit).";
/** g5.v10 and g5.v11: a key-concept box and its first example share a slide. */
const SAME_IDEA_RULE =
  ' Never two consecutive slides that teach the same idea: a key-concept box and its own first example share one slide unless the box is long.';
/**
 * g5.v12 ("one idea per slide" wins, critical items 27 Nov 2026): v11's key-concept rule
 * already explains one idea per slide, so v10's shared slide is not asked for here.
 */
const ONE_IDEA_RULE =
  ' ONE IDEA PER SLIDE: a teaching slide teaches one unit of its part. Never two key concepts on one slide, and never a key-concept box together with an example (each book example has a slide of its own); a side note stays on the slide of the element it explains.';

/**
 * g5.v10 (learner-first plan W3, owner decisions D-1, D-2, D-4, D-5, D-8 of 15 Nov
 * 2026): the lines the planner gets on top of — or instead of — g5.v8's.
 * `oneIdea` (g5.v12) swaps v10's shared key-concept slide for one idea per slide.
 */
function learnerFirstLines(book: KafuoBookStructure, oneIdea = false, maths = true): string[] {
  const reading = book.units.some((unit) =>
    /MATH_READING|VOCABULARY_LINK/.test(String(unit.kind ?? '')),
  );
  return [
    `LEARNER-FIRST (${oneIdea ? 'g5.v12' : 'g5.v10'}), for a weak student:`,
    DEFINITION_BOX_RULE + (oneIdea ? ONE_IDEA_RULE : SAME_IDEA_RULE),
    ...(reading
      ? [
          '- Teach each kind=MATH_READING («قراءة الرياضيات») and kind=VOCABULARY_LINK («ربط المفردات») unit where the book prints it, on the slide that first uses its notation or term (cite it there).',
        ]
      : []),
    // g5.v12 (Wave 2, MI-2 / W2.6): the conjecture, data and cycle lines are maths rules;
    // another subject never gets them. Every earlier model: always, as before.
    ...(maths
      ? [
          '- CLAIMS: a slide that tests a conjecture or gives a counterexample states the conjecture itself first, verbatim from the book, in its key points.',
          '- DATA: a conjecture from data states what is expected next and why the data support it, with the method the book uses; never an average-change calculation the book does not use. To estimate a next value, add the last difference again (the latest rise: «آخر زيادة 4، إذن 41 + 4 = 45») and plan that working as key points.',
          // Quality plan W4 (item 208, 15 Nov 2026): no month list at check 1; the wrong pictures.
          '- CYCLES: an item on a fixed named cycle (the Hijri months, the days of the week) gives the whole cycle, numbered in order, as given data on its try-it slide and on its solution slide. Listing the cycle is the data of the item, never a hint.',
        ]
      : []),
    "- PICTURES: a unit's book picture is shown once, on the slide whose item it shows. A slide that only solves exercises shows no picture of the exercise list.",
    "- ATTEMPT: never plan a quiz for a check or an exercise; the engine adds the learner's attempt itself, right after each try-it slide and before each exercise slide.",
    ...(maths
      ? ['- Say the caution that examples do not prove a conjecture at most once per lesson part.']
      : []),
  ];
}

/** The g5.v8 planner guidance: recall, one solution per check, visible working, exercises. */
function teacherParityRequirement(
  book: KafuoBookStructure,
  rules: string,
  learnerFirst = false,
  bookPartPlacement = false,
  subjectCode: string | null = null,
): string {
  const policy = book.exercisePolicy;
  if (learnerFirst) return learnerFirstRequirement(book, rules, bookPartPlacement, subjectCode);
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
 * g5.v10 planner guidance: g5.v8's structure (one try-it slide and one solution slide
 * per check, visible working, the engine's exercises block), with no recall slide (the
 * opening boxes are excluded, as on g5.v9), every item stated verbatim and explained,
 * the learner's attempt added by the engine, and the learner-first rules.
 * `bookPartPlacement` (g5.v12) adds the book-part rules the v12 gates hold the plan to:
 * one check per slide (W2.2) and one idea per slide in place of v10's shared slide.
 */
function learnerFirstRequirement(
  book: KafuoBookStructure,
  rules: string,
  bookPartPlacement = false,
  subjectCode: string | null = null,
): string {
  const policy = book.exercisePolicy;
  // g5.v12 (Wave 2, MI-2 / W2.6): the maths-only lines go to a MATH lesson alone.
  const maths = !bookPartPlacement || subjectCode === 'MATH';
  return [
    '',
    `BOOK-STRUCTURED LESSON (${bookPartPlacement ? 'g5.v12' : 'g5.v10'}). Each [[CONTENT_UNIT]] marker shows the kind the book`,
    `printed it as and its lesson part. The lesson template maps kinds to elements: ${rules}.`,
    'Plan in the book order: every required unit gets its own instructional slide that cites it.',
    'CHECKS: every try_it unit gets ONE try-it slide (contentRole check_understanding) that states',
    "every one of the check's items (1A, 1B, …) verbatim, without answers and without solving.",
    "The engine adds the learner's attempt right after it. Then ONE solution slide (contentRole",
    "worked_example) PER CHECK that cites the check's unit and solves and explains EVERY item, in",
    "the book order, each to a final answer from the given data. Never split a check's solution",
    'across slides: each check has exactly one solution slide.',
    ...(bookPartPlacement
      ? [
          'ONE CHECK PER SLIDE: a try-it slide and its solution slide each cite ONE check unit.',
          'Never two checks on one slide, and never checks of two lesson parts.',
        ]
      : []),
    "Never solve a try_it unit before its try-it slide: an example's own slide cites only",
    'the example, not the check that follows it.',
    ...checkListLine(book),
    ...(maths
      ? [
          'VISIBLE WORKING: every solution plans each hidden step as its own key point, by type:',
          learnerFirstPlannerCatalogue(),
        ]
      : ['VISIBLE WORKING: every solution plans each step of its working as its own key point.']),
    ...(policy && !book.units.some(isUsableExercise)
      ? [
          'EXERCISES: no exercise unit of this lesson holds a usable item, so the lesson has no',
          'exercises block: plan no «تمارين» slide and cite no element=exercise unit.',
        ]
      : policy
        ? [
            'EXERCISES: element=exercise units are not taught one by one. Only in the last part,',
            'just before the closing summary slide, comes the exercises block: one transition slide',
            '«تمارين», a title only (a study tip is taught where the book prints it, in book order,',
            'never moved onto this slide), then the exercise slides (contentRole worked_example). The engine fixes',
            'which exercise units the block solves and on which slide (EXERCISES BLOCK below), easiest',
            "first, and adds the learner's attempt before each exercise slide. Plan EXACTLY the",
            'exercise slides the EXERCISES BLOCK lists, each citing exactly its listed units: one',
            'exercise slide carries several exercises (e.g. «تمرين ١» and «تمرين ٢» together);',
            'never one slide per exercise. Each exercise slide labels its items with the',
            'EXERCISE LABELS of the block (numbered once across the lesson, never restarting at',
            "«تمرين ١»), writes that label in each item's key point, puts the book's number only as a",
            'small grey tag such as «(س٣٥ في كتابك)», states each item and solves EVERY listed item with compact',
            'visible working. Never cite a unit marked exerciseUsable=false, except a',
            'reason=instructions_only unit, which is only the instruction line of the exercises',
            'paired with the same example.',
          ]
        : []),
    ...learnerFirstLines(book, bookPartPlacement, maths),
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
    ...(book.learnerFirst ? learnerFirstExerciseLabels(selection) : []),
  ].join('\n');
}

const INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const indic = (value: number) =>
  String(value).replace(/[0-9]/g, (digit) => INDIC_DIGITS[Number(digit)]!);

/**
 * Quality plan W5 (g5.v10): the engine numbers the exercises once, across the whole
 * block, in the selection order — item 208 labelled three different items «تمرين 1».
 * A unit with listed questions takes one label per question; any other unit, one label.
 */
function learnerFirstExerciseLabels(selection: NonNullable<ReturnType<typeof selectExercises>>) {
  let next = 1;
  const lines = selection.slides.map((ids, index) => {
    const questions = selection.slideQuestions?.[index] ?? {};
    const labels = ids.flatMap((id) => {
      const numbers = questions[id];
      if (!numbers?.length) return [`«تمرين ${indic(next++)}» = unit ${id}`];
      return numbers.map(
        (number) =>
          `«تمرين ${indic(next++)}» = unit ${id} question ${number} «(س${indic(number)} في كتابك)»`,
      );
    });
    const first = next - labels.length;
    const title =
      first === next - 1
        ? `حل التمرين ${indic(first)}`
        : `حل التمارين ${indic(first)}–${indic(next - 1)}`;
    return `- exercise slide ${index + 1} (title «${title}»): ${labels.join('; ')};`;
  });
  return [
    'EXERCISE LABELS (g5.v10, fixed by the engine): use exactly these labels, numbered once across',
    'the whole block — never restart at «تمرين ١» on the next slide, and never call a check',
    '(«تحقق من فهمك») item «تمرين»:',
    ...lines,
  ];
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

/** g5.v12 (EN-5): a rule the engine asks the planner for and reports, but never blocks on. */
export interface PlanWarning {
  code: string;
  outlineId?: string;
  message: string;
}

/** g5.v12 warning: the first slide using a key concept carries no definition box. */
export const DEFINITION_NOT_FIRST = 'DEFINITION_NOT_FIRST';
/** g5.v12 warning: the exercise slides are not in the engine's order (easiest first). */
export const EXERCISES_NOT_EASIEST_FIRST = 'EXERCISES_NOT_EASIEST_FIRST';
/** g5.v12 warning: the plan has no closing summary slide. */
export const NO_CLOSING_SUMMARY = 'NO_CLOSING_SUMMARY';

/**
 * g5.v12 (EN-5, critical items 27 Nov 2026): the three rules the owner chose to warn on
 * rather than gate — a definition box on first use, the exercises in the engine's
 * easiest-first order, and a closing summary. Read from the plan's title, roles and
 * citations only (never its Scenes), so each is a report for the reviewer, not a proof.
 * Empty on every other Teaching Model.
 */
export function bookPartPlacementWarnings(
  outlines: readonly SceneOutline[],
  book: CoverageBookStructure | undefined,
): PlanWarning[] {
  if (book?.bookPartPlacement !== true) return [];
  const warnings: PlanWarning[] = [];
  for (const unit of book.units) {
    if (unit.element !== 'key_concept') continue;
    const index = outlines.findIndex(
      (outline) => teaches(outline) && cites(outline, unit.contentUnitId),
    );
    const first = outlines[index];
    if (!first || first.contentRole !== 'explanation' || first.contentKind === 'definition') {
      continue;
    }
    warnings.push({
      code: DEFINITION_NOT_FIRST,
      ...(first.id ? { outlineId: first.id } : {}),
      message: `outline #${index + 1} «${first.title ?? ''}» first uses ${describe(unit)} with no definition box (contentKind definition)`,
    });
  }
  // "Easiest first" is the engine's own rule, and code cannot measure difficulty:
  // `selectExercises` picks the SET with an easiest-first bias, then orders the picks in
  // BOOK order into slides. So the rule, as code can check it, is that the plan's
  // exercise slides follow the engine's EXERCISES BLOCK — the same exercise items, in the
  // engine's order. (The first version compared unit sets per slide and so never saw a
  // reversed order: review 27 Nov 2026, MEDIUM.)
  const selection = selectExercises(book, book.unitFacts);
  if (selection) {
    const exerciseIds = new Set(
      book.units.filter((unit) => unit.element === 'exercise').map((unit) => unit.contentUnitId),
    );
    const questionsOf = (unitId: string) => book.unitFacts?.[unitId]?.questionNumbers ?? [];
    // The plan's exercise items in plan order: each exercise unit a slide cites, with the
    // numbered questions its title or key points show for it (a slide that shows none
    // solves the whole unit).
    const planned: string[] = [];
    for (const outline of outlines) {
      if (!teaches(outline)) continue;
      const ids = citedIds(outline).filter((id) => exerciseIds.has(id));
      if (ids.length === 0) continue;
      const shown = exerciseQuestionNumbers(visibleText(outline));
      for (const id of ids) {
        const questions = shown.filter((number) => questionsOf(id).includes(number));
        if (questions.length > 0) {
          for (const number of questions) planned.push(`${id}#${number}`);
        } else {
          planned.push(id);
        }
      }
    }
    // The engine's items: its slides in its order, each unit with the questions it gives them.
    const engine: string[] = [];
    selection.slides.forEach((ids, at) => {
      for (const id of ids) {
        const questions = selection.slideQuestions?.[at]?.[id] ?? [];
        if (questions.length > 0) {
          for (const number of questions) engine.push(`${id}#${number}`);
        } else {
          engine.push(id);
        }
      }
    });
    // A whole unit on one side is the questions the other side names for it.
    const expand = (sequence: readonly string[], other: readonly string[]): string[] =>
      sequence.flatMap((item) => {
        const id = item.split('#')[0]!;
        const named = other.filter((entry) => entry.startsWith(`${id}#`));
        return item.includes('#') || named.length === 0 ? [item] : named;
      });
    const [left, right] = [expand(planned, engine), expand(engine, planned)];
    // A different number of items is a coverage matter (the gates'), not an order one.
    if (left.length === right.length && left.some((item, at) => item !== right[at])) {
      warnings.push({
        code: EXERCISES_NOT_EASIEST_FIRST,
        message:
          'the exercise slides do not follow the order of the engine’s EXERCISES BLOCK (the engine’s easiest-first selection, in book order)',
      });
    }
  }
  if (!outlines.some((outline) => outline.contentRole === 'summary')) {
    warnings.push({
      code: NO_CLOSING_SUMMARY,
      message: 'the plan has no closing summary slide',
    });
  }
  return warnings;
}
