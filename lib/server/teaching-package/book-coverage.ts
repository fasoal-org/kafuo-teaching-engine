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
 */
import type { OutlineDiagnostic } from '@openmaic/generation';

import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure, KafuoBookStructureUnit } from '@/lib/types/teaching-package';

export const BOOK_COVERAGE_INCOMPLETE = 'BOOK_COVERAGE_INCOMPLETE';

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
  | 'solution_before_try_it';

export interface BookCoverageGap {
  kind: BookCoverageGapKind;
  unit: KafuoBookStructureUnit;
  message: string;
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
  book: KafuoBookStructure | undefined,
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
  }
  return gaps;
}

/**
 * The book map as the coverage gate reads it: a unit inside a part that the
 * template could not name (no kind, or a kind it does not map) is required when
 * its own role makes it an essential section (`essentialContentUnitIds`). Without
 * this the planner could drop it unnoticed and Submit alone would refuse the
 * package (`ESSENTIAL_SECTION_UNCOVERED`), after every scene was paid for.
 */
export function requireEssentialUntypedUnits(
  book: KafuoBookStructure | undefined,
  essentialIds: readonly string[] | null | undefined,
): KafuoBookStructure | undefined {
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
  book: KafuoBookStructure | undefined,
): OutlineDiagnostic[] {
  return findBookCoverageGaps(outlines, book).map((gap) => ({
    code: BOOK_COVERAGE_INCOMPLETE,
    disposition: 'admin_correctable',
    field: 'sourceContentUnitIds',
    message: gap.message,
  }));
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
      return `[[CONTENT_UNIT id=${id}${rest}${kind}${element}${part}]]`;
    },
  );
}

/** The planner guidance a g5.v7 request adds to the requirement. */
export function bookStructureRequirement(book: KafuoBookStructure | undefined): string {
  if (!book) return '';
  const rules = book.rules.map((rule) => `${rule.kind}=${rule.element}`).join(', ');
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
