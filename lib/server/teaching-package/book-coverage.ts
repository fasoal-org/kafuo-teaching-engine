/**
 * The g5.v7 book-coverage gate (book-structured planner plan P-6, Wave 4).
 *
 * Runs on the planned outlines BEFORE any scene is generated, and only when the
 * request carried a `bookStructure` (g5.v7). Every unit the Lesson Template
 * marks required must be cited by an instructional slide — a structural slide
 * (cover, contents, transition, end) citing a unit never counts as teaching it —
 * and every book check paired with an example must have a try-it slide
 * (`check_understanding`) and, after it, a solution slide (`worked_example`)
 * citing it. A gap is returned as an admin-correctable diagnostic that names
 * the missing element, so the attempt pauses on the existing correction path
 * (the reviewer can add the slide) and never finishes as a green "succeeded".
 * v6 and earlier requests carry no `bookStructure` and are untouched.
 */
import type { OutlineDiagnostic } from '@openmaic/generation';

import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';

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

export function findBookCoverageDiagnostics(
  outlines: readonly SceneOutline[],
  book: KafuoBookStructure | undefined,
): OutlineDiagnostic[] {
  if (!book) return [];
  const diagnostics: OutlineDiagnostic[] = [];
  const gap = (message: string): OutlineDiagnostic => ({
    code: BOOK_COVERAGE_INCOMPLETE,
    disposition: 'admin_correctable',
    field: 'sourceContentUnitIds',
    message,
  });

  for (const unit of book.units) {
    if (!unit.required) continue;
    if (!outlines.some((outline) => teaches(outline) && cites(outline, unit.contentUnitId))) {
      diagnostics.push(gap(`${describe(unit)} has no teaching slide`));
    }
  }

  for (const unit of book.units) {
    if (unit.element !== 'try_it' || unit.pairedExampleUnitId === undefined) continue;
    const tryIt = outlines.findIndex(
      (outline) =>
        teaches(outline) &&
        outline.contentRole === 'check_understanding' &&
        cites(outline, unit.contentUnitId),
    );
    if (tryIt < 0) {
      diagnostics.push(
        gap(
          `${describe(unit)} (the check after example ${unit.pairedExampleUnitId}) has no try-it slide`,
        ),
      );
      continue;
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
      diagnostics.push(gap(`${describe(unit)} has a try-it slide but no solution slide after it`));
    }
  }
  return diagnostics;
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
    /\[\[CONTENT_UNIT id=(\S+)([^\]]*)\]\]/g,
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
    'Transition slides never count as teaching a unit.',
  ].join('\n');
}
