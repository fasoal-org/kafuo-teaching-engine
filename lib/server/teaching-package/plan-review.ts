/**
 * The plan review layer (package-planner-issue-resolve-plan-2026-11-22 §3b step 2,
 * owner decisions D-6 to D-9, 22 Nov 2026; implementation prompt P2): after the free
 * rule fixes and the book repair, an AI reviewer fixes what is still open with the
 * EXISTING correction operations only, before the attempt would pause for a person.
 *
 * - No model call when nothing is open (step 8), nor when every open issue is one no
 *   op can fix (`NO_OUTLINES`, `SCENE_CONFIG_INVALID`, a stage with too few slides).
 * - At most {@link PLAN_REVIEW_ROUNDS} rounds, ONE `aiCall` each (D-9). A call that
 *   throws ends the review rounds, and the result says `endedOnError: true`: nothing
 *   is rethrown, so the CALLER checks its route (`assertRouteAvailable` fails a routed
 *   run right after the review, so a routed run never keeps the step 7 fallback; a run
 *   without a route still gets it). An answer that cannot be read ends the rounds too,
 *   keeping the accepted rounds.
 * - Every op is shape-checked alone by `parseCorrectionOperations` and applied alone
 *   by `applyCorrectionOperations`, exactly like a person's edit; a refused op is
 *   dropped. `set keyPoints` is the reviewer's own field (D-8): append-only, only on a
 *   `WORKING_STEP_MISSING` solution slide, under the sacred-text guard, and kept only
 *   when that op alone lowers the `WORKING_STEP_MISSING` count. It is never a
 *   person-facing editable field.
 * - `remove` (D-7) only where an open issue's fix is a delete, at most
 *   {@link PLAN_REVIEW_MAX_REMOVES} per round. No op (a remove, or a `set` of the type,
 *   slide type, role or cited units) may leave a required unit without a teaching slide.
 * - A round is kept only when its re-diagnosis has fewer open issues, no new finding
 *   code and no more `BOOK_COVERAGE_INCOMPLETE`; otherwise none of it is recorded.
 * - After the last round a stage that still holds too many slides keeps its first one
 *   (step 7), under the same guards (no per-round cap), kept only when it clears that
 *   stage's `POSITION_CARDINALITY` and adds no code.
 *
 * Nothing here mutates its input or logs lesson text or model text: counts and codes.
 */
import {
  WIDGET_TYPE_PROHIBITED,
  type AICallFn,
  type OutlineDiagnostic,
} from '@openmaic/generation';

import { createLogger } from '@/lib/logger';
import {
  BOOK_COVERAGE_INCOMPLETE,
  EXAMPLE_TAUGHT_TWICE,
  SOLUTION_SLIDES_DUPLICATED,
  WORKING_STEP_MISSING,
  duplicateSolutionSlides,
  teaches,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import {
  OUTLINE_PHASE_EDITABLE_FIELDS,
  applyCorrectionOperations,
  insertableBookGaps,
  parseCorrectionOperations,
  type CorrectionEditContext,
  type CorrectionOperation,
} from '@/lib/server/teaching-package/outline-correction';
import { findUncoveredContentUnits } from '@/lib/server/teaching-package/outline-grounding';
import { applyPlanAutoFixes } from '@/lib/server/teaching-package/plan-auto-fixes';
import { untrustedText } from '@/lib/server/teaching-package/plan-inserted-slide';
import {
  PLAN_REVIEWER_ACTOR,
  type PlanFixDraft,
} from '@/lib/server/teaching-package/plan-fix-records';
import {
  buildPlanReviewSystemPrompt,
  buildPlanReviewUserPrompt,
  readPlanReviewOps,
  type PlanReviewTargets,
  type PlanReviewUnit,
  type PlanReviewUnitTextCaps,
} from '@/lib/server/teaching-package/plan-review-prompt';
import {
  detectSacredQuotes,
  findSacredSpans,
  sacredAddedTextFindings,
  type SacredQuote,
} from '@/lib/server/teaching-package/sacred-text';
import type { SacredPolicyMode } from '@/lib/server/teaching-package/sacred-text-policy';
import type { SceneOutline } from '@/lib/types/generation';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';

export type { PlanReviewUnit } from '@/lib/server/teaching-package/plan-review-prompt';
/** The prompt version, for the runner to record beside the fixes. */
export { PLAN_REVIEW_PROMPT_VERSION } from '@/lib/server/teaching-package/plan-review-prompt';
/** RV-3: the g5.v12 unit-text caps, for the runner's plan review context. */
export { PLAN_REVIEW_V12_UNIT_TEXT_CAPS } from '@/lib/server/teaching-package/plan-review-prompt';

const log = createLogger('PlanReview');

/** D-9: at most two rounds, one model call each. */
export const PLAN_REVIEW_ROUNDS = 2;
/** D-7 guard: at most three removes per round. */
export const PLAN_REVIEW_MAX_REMOVES = 3;

/**
 * The fields the reviewer may set: a person's outline-phase fields plus `keyPoints`
 * (D-8). Reviewer-only: never part of a correction view's `editableFields`.
 */
export const PLAN_REVIEWER_SET_FIELDS = [...OUTLINE_PHASE_EDITABLE_FIELDS, 'keyPoints'] as const;

/** Step 7: the reason recorded on every fallback removal. */
export const CARDINALITY_FALLBACK_REASON = 'حذف تلقائي للشرائح الزائدة';

const REVIEW_OPS = new Set(['set', 'remove', 'move', 'insert_book_slide']);
/** The most ops one answer may carry (the correction route's own cap). */
const MAX_REVIEW_OPS = 50;
const REASON_MAX = 300;
const MAX_ADDED_KEY_POINTS = 6;
const MAX_KEY_POINT_LENGTH = 400;
const POSITION_CARDINALITY = 'POSITION_CARDINALITY';
const FLOW_SEQUENCE_INVALID = 'FLOW_SEQUENCE_INVALID';
/** Codes no correction op can fix (a re-plan or a person can). */
const UNFIXABLE_CODES: ReadonlySet<string> = new Set(['NO_OUTLINES', 'SCENE_CONFIG_INVALID']);
/** Codes whose fix names one slide to delete (with its `outlineId`). */
const DELETE_FIX_CODES: ReadonlySet<string> = new Set([
  EXAMPLE_TAUGHT_TWICE,
  SOLUTION_SLIDES_DUPLICATED,
  WIDGET_TYPE_PROHIBITED,
]);

const FALLBACK_REASON = {
  set: 'تعديل في الشريحة علشان تطابق قواعد الخطة',
  remove: 'حذف شريحة مكررة أو غير مسموح بيها في الخطة',
  move: 'نقل الشريحة لمكانها الصحيح في الخطة',
  insert_book_slide: 'إضافة شريحة حل ناقصة من الكتاب',
} as const;

export interface PlanReviewContext {
  phase: 'outline';
  flow: readonly TeachingFlowEntry[];
  /**
   * Approved Content Units; `text` is already the prompt text the planner sees. The
   * review strips every verse and hadith line from it and caps it before the prompt.
   */
  units: readonly PlanReviewUnit[];
  /**
   * Book unit ids a slide must teach: no op may leave one of them without a teaching
   * slide (the last one is never removed, nor made to stop teaching or citing it).
   */
  requiredUnitIds: readonly string[];
  /**
   * The essential sections (the submit gate's `essentialContentUnitIds`), checked under
   * the section rule: only a slide that is not orientation, summary, check or practice
   * teaches one. Absent ⇒ `requiredUnitIds` are checked under both rules.
   */
  essentialUnitIds?: readonly string[];
  /** A short book-structure summary line set, or null. */
  bookSummary: string | null;
  language: string;
  languageDirective: string;
  /** Re-diagnose a candidate: the normalised outlines and every OPEN blocking diagnostic (ignored issues already filtered out). */
  diagnose: (candidate: SceneOutline[]) => {
    outlines: SceneOutline[];
    blocking: OutlineDiagnostic[];
  };
  /** For applyCorrectionOperations (outline phase, with real sourceRefs and the coverage book). */
  editContext: CorrectionEditContext;
  /**
   * The run's protected quotes (`sacredQuotesFromManifest`), for the keyPoints guard.
   * Absent: they are detected in the units' text (the older-backend rule).
   */
  sacredQuotes?: readonly SacredQuote[];
  /**
   * S-9 policy block of the prompt; absent → `full` (fail-safe). It only picks the
   * prompt's policy text: the keyPoints guard is `sacredQuotes` and the units' text.
   */
  sacredMode?: SacredPolicyMode;
  /**
   * Whether the reviewer may write a missing working step (`set keyPoints`, D-8); absent
   * → true. False for a caller with no unit text and no run quotes (the review of a
   * paused attempt, P3): a new step could not be grounded, nor its verses guarded. Then
   * no slide is offered under "keyPoints", a `set keyPoints` is dropped, and an open
   * `WORKING_STEP_MISSING` is not a reason for a model call (no other op writes a step).
   */
  allowKeyPoints?: boolean;
  /**
   * RV-3 (27 Nov 2026): how much unit text the reviewer reads. Absent → 400 per unit,
   * 12,000 in all, exactly as before. The g5.v12 run passes
   * `PLAN_REVIEW_V12_UNIT_TEXT_CAPS` (`isBookPartPlacementModel`), so a long unit is
   * judged whole; every other Teaching Model leaves it absent.
   */
  unitTextCaps?: PlanReviewUnitTextCaps;
}

export interface PlanReviewResult {
  outlines: SceneOutline[];
  blocking: OutlineDiagnostic[];
  /** The kept fixes, in the order they were applied (an undo walks them backwards). */
  fixes: PlanFixDraft[];
  /** Model calls made (a call that threw counts). The step 7 fallback is not a call. */
  rounds: number;
  /** Model rounds kept. */
  acceptedRounds: number;
  /**
   * A model call threw: the review ended there, without the step 7 fallback. The
   * caller checks its route (`assertRouteAvailable`); nothing was rethrown.
   */
  endedOnError: boolean;
}

// ---------------------------------------------------------------------------
// Which slides an open issue names
// ---------------------------------------------------------------------------

const cites = (outline: SceneOutline, unitId: string) =>
  (outline.sourceContentUnitIds ?? []).some((id) => String(id) === unitId);

/** The flow position a slide validly carries, or `null`. */
function validStage(outline: SceneOutline, flow: readonly TeachingFlowEntry[]): number | null {
  const position = outline.teachingStage;
  if (!position || !Number.isInteger(position.flowIndex)) return null;
  return flow[position.flowIndex]?.stage === position.key ? position.flowIndex : null;
}

function stageSlides(
  outlines: readonly SceneOutline[],
  flowIndex: number,
  flow: readonly TeachingFlowEntry[],
): SceneOutline[] {
  return outlines.filter((outline) => validStage(outline, flow) === flowIndex);
}

/**
 * The book unit a book-coverage message names. `SOLUTION_SLIDES_DUPLICATED` («check
 * <id> has …») and `WORKING_STEP_MISSING` («<kind> <id>[ in part N]: …») carry no
 * `outlineId`: the unit id is the message's second word. A message in another shape,
 * or a unit the book does not hold, names nothing (the guard then refuses: fail closed).
 */
function namedBookUnit(
  issue: OutlineDiagnostic,
  book: CoverageBookStructure | undefined,
): string | null {
  const token = issue.message
    .trim()
    .split(/\s+/)[1]
    ?.replace(/[:;,]+$/, '');
  if (!token || !book) return null;
  return book.units.some((unit) => String(unit.contentUnitId) === token) ? token : null;
}

/** The solution slides of a book unit: a check's worked examples after its try-it, or an exercise's slides. */
function solutionSlidesOf(
  outlines: readonly SceneOutline[],
  unitId: string,
  book: CoverageBookStructure,
): SceneOutline[] {
  const unit = book.units.find((candidate) => String(candidate.contentUnitId) === unitId);
  if (!unit) return [];
  if (unit.element === 'try_it') {
    const tryIt = outlines.findIndex(
      (outline) =>
        teaches(outline) && outline.contentRole === 'check_understanding' && cites(outline, unitId),
    );
    return outlines.filter(
      (outline, index) =>
        index > tryIt &&
        teaches(outline) &&
        outline.contentRole === 'worked_example' &&
        cites(outline, unitId),
    );
  }
  return outlines.filter((outline) => teaches(outline) && cites(outline, unitId));
}

/**
 * Why an open issue's fix is deleting this slide, on the plan as it is now (codes), or
 * none. A duplicate-solution check keeps one solution slide and a one-slide stage keeps
 * one slide: the extras are deletable only while there are more than that.
 */
function deleteBacking(
  working: readonly SceneOutline[],
  outlineId: string,
  open: readonly OutlineDiagnostic[],
  context: PlanReviewContext,
): string[] {
  const outline = working.find((candidate) => candidate.id === outlineId);
  if (!outline) return [];
  const book = context.editContext.bookStructure;
  const codes = new Set<string>();
  for (const issue of open) {
    if (DELETE_FIX_CODES.has(issue.code) && issue.outlineId === outlineId) {
      codes.add(issue.code);
      continue;
    }
    if (issue.code === SOLUTION_SLIDES_DUPLICATED && !issue.outlineId && book) {
      const unitId = namedBookUnit(issue, book);
      const group = unitId
        ? duplicateSolutionSlides(working, book).find((entry) => entry.unitId === unitId)
        : undefined;
      if (
        group &&
        group.indexes.length > 1 &&
        group.indexes.some((i) => working[i]?.id === outlineId)
      ) {
        codes.add(issue.code);
      }
      continue;
    }
    if (issue.code === POSITION_CARDINALITY && issue.flowIndex !== undefined) {
      if (
        validStage(outline, context.flow) === issue.flowIndex &&
        stageSlides(working, issue.flowIndex, context.flow).length > 1
      ) {
        codes.add(issue.code);
      }
    }
  }
  return [...codes];
}

/**
 * The required units `before` teaches and `after` no longer does, by the two coverage
 * rules the diagnosis uses: the book coverage (`teaches`: a slide, not a cover, contents,
 * transition or end slide, citing the unit) and the essential sections
 * (`findUncoveredContentUnits`: a slide whose role is not orientation, summary, check or
 * practice). Only teaching citers count, so removing a slide that never taught a unit,
 * or one whose unit another slide still teaches, loses nothing.
 */
function lostRequiredUnits(
  before: readonly SceneOutline[],
  after: readonly SceneOutline[],
  required: RequiredUnits,
): string[] {
  const { book, essential } = required;
  if (book.length === 0 && essential.length === 0) return [];
  const bookTaught = (outlines: readonly SceneOutline[]) =>
    new Set(
      book.filter((unitId) =>
        outlines.some((outline) => teaches(outline) && cites(outline, unitId)),
      ),
    );
  // Each rule on its own ids (follow-up review, 22 Nov 2026): the section rule (no
  // check or practice slide counts) only on the essential sections, so a correct role
  // change on a book check's slide is not refused by a rule its unit is not under.
  const sectionUntaught = (outlines: readonly SceneOutline[]) =>
    new Set(findUncoveredContentUnits(outlines, essential));
  const [bookBefore, bookAfter] = [bookTaught(before), bookTaught(after)];
  const [sectionBefore, sectionAfter] = [sectionUntaught(before), sectionUntaught(after)];
  return [...new Set([...book, ...essential])].filter(
    (unitId) =>
      (bookBefore.has(unitId) && !bookAfter.has(unitId)) ||
      (essential.includes(unitId) && !sectionBefore.has(unitId) && sectionAfter.has(unitId)),
  );
}

/** The units no op may leave untaught, each under its own coverage rule. */
interface RequiredUnits {
  /** Book-required units: taught by any teaching slide citing them (`teaches`). */
  book: readonly string[];
  /** Essential sections: taught only by a slide that is not orientation, summary, check or practice. */
  essential: readonly string[];
}

function requiredUnitsOf(context: PlanReviewContext): RequiredUnits {
  const book = context.requiredUnitIds.map(String);
  return {
    book,
    // Without a separate list, the required units are checked under both rules.
    essential: (context.essentialUnitIds ?? context.requiredUnitIds).map(String),
  };
}

/**
 * Whether some op could fix the issue: never `NO_OUTLINES` (a re-plan) or
 * `SCENE_CONFIG_INVALID`, nor a stage that holds fewer slides than it needs (there is
 * no generic insert).
 */
function modelCanFix(
  issue: OutlineDiagnostic,
  outlines: readonly SceneOutline[],
  flow: readonly TeachingFlowEntry[],
  allowKeyPoints: boolean,
): boolean {
  if (UNFIXABLE_CODES.has(issue.code)) return false;
  if (issue.code === WORKING_STEP_MISSING && !allowKeyPoints) return false;
  if (issue.code === POSITION_CARDINALITY && issue.flowIndex !== undefined) {
    return stageSlides(outlines, issue.flowIndex, flow).length >= 1;
  }
  return true;
}

/** The slides an open `WORKING_STEP_MISSING` is about: its `outlineId`, or the named unit's solution slides. */
function keyPointSlideIds(
  working: readonly SceneOutline[],
  open: readonly OutlineDiagnostic[],
  book: CoverageBookStructure | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const issue of open) {
    if (issue.code !== WORKING_STEP_MISSING) continue;
    if (issue.outlineId) {
      ids.add(issue.outlineId);
      continue;
    }
    const unitId = namedBookUnit(issue, book);
    if (!unitId || !book) continue;
    for (const outline of solutionSlidesOf(working, unitId, book)) ids.add(outline.id);
  }
  return ids;
}

function reviewTargets(
  working: readonly SceneOutline[],
  open: readonly OutlineDiagnostic[],
  context: PlanReviewContext,
): PlanReviewTargets {
  const book = context.editContext.bookStructure;
  const removable = working.flatMap((outline) => {
    const codes = deleteBacking(working, outline.id, open, context);
    return codes.length > 0 ? [{ outlineId: outline.id, codes }] : [];
  });
  const insertable = insertableBookGaps(working, book, context.flow).map((gap) => ({
    outlineId: working[gap.anchorIndex!]!.id,
    unitId: gap.unit.contentUnitId,
  }));
  const keyPointSlides =
    context.allowKeyPoints === false ? [] : [...keyPointSlideIds(working, open, book)];
  return { removable, keyPointSlides, insertable };
}

// ---------------------------------------------------------------------------
// The model's ops
// ---------------------------------------------------------------------------

type ShapedOp =
  | { kind: 'keyPoints'; outlineId: string; added: unknown; reason: string }
  | { kind: 'op'; op: SlideOperation; reason: string };

/** A correction op that names a slide (every op but `ignore_issue`, which the reviewer never sends). */
/** The ops the reviewer may return: never an ignore, a review or an undo (P3 ops). */
type SlideOperation = Exclude<
  CorrectionOperation,
  { op: 'ignore_issue' } | { op: 'review_plan' } | { op: 'revert_fix' }
>;

function hasSacredText(text: string): boolean {
  return /[﴾﴿]/.test(text) || findSacredSpans(text).spans.length > 0;
}

/** The model's reason, trimmed to 300 characters; the op's Arabic line when empty or quoting. */
function reasonOf(raw: unknown, op: keyof typeof FALLBACK_REASON): string {
  const text =
    typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX).trim() : '';
  return text && !hasSacredText(text) ? text : FALLBACK_REASON[op];
}

/**
 * One raw op as a correction operation (or the reviewer's `set keyPoints`), or `null`
 * when it is not one of the four ops, or its shape is refused. The fields the answer
 * schema does not name (`title`, …) are never passed on: the server writes them.
 */
function shapeOp(raw: unknown): ShapedOp | null {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!record || typeof record.op !== 'string' || !REVIEW_OPS.has(record.op)) return null;
  const op = record.op as keyof typeof FALLBACK_REASON;
  const reason = reasonOf(record.reason, op);
  if (op === 'set' && record.field === 'keyPoints') {
    if (typeof record.outlineId !== 'string' || record.outlineId.trim() === '') return null;
    return { kind: 'keyPoints', outlineId: record.outlineId, added: record.value, reason };
  }
  const candidate: Record<string, unknown> = { op, outlineId: record.outlineId };
  if (op === 'move') candidate.toIndex = record.toIndex;
  if (op === 'insert_book_slide') candidate.unitId = record.unitId;
  if (op === 'set') {
    candidate.field = record.field;
    if ('value' in record) candidate.value = setValue(record.field, record.value);
  }
  try {
    const [parsed] = parseCorrectionOperations([candidate]);
    return parsed &&
      parsed.op !== 'ignore_issue' &&
      parsed.op !== 'review_plan' &&
      parsed.op !== 'revert_fix'
      ? { kind: 'op', op: parsed, reason }
      : null;
  } catch {
    return null;
  }
}

/**
 * A `set` value as the reviewer may send it: a flow position given as `{flowIndex}` is
 * read as its index, and a visual plan never carries the model's own diagram note (the
 * server keeps the slide's note or writes one from the slide, as for a person's edit).
 */
function setValue(field: unknown, value: unknown): unknown {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (field === 'teachingStage' && record && Number.isInteger(record.flowIndex)) {
    return record.flowIndex;
  }
  if (field === 'visualPlan' && record) {
    const { diagram: _modelNote, ...plan } = record;
    return plan;
  }
  return value;
}

/**
 * The points a `set keyPoints` adds (D-8, append-only): `value` is the slide's existing
 * points word for word, in order, then the new ones. A value that changes, drops or
 * reorders an existing point is refused, so a reworded point never passes as a new one.
 * The echo may be the stored point or the exact form the prompt showed (trimmed, no
 * `<<<`/`>>>` run); the kept points are always the stored ones. A new point that repeats
 * an existing one is not added.
 */
function addedKeyPoints(existing: readonly string[], value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length <= existing.length) return null;
  const echoed = existing.every(
    (point, index) => value[index] === point || value[index] === untrustedText(point),
  );
  if (!echoed) return null;
  const normalized = new Set(existing.map((point) => point.replace(/\s+/g, ' ').trim()));
  const added: string[] = [];
  for (const point of value.slice(existing.length)) {
    if (typeof point !== 'string') return null;
    const text = point.trim();
    if (text === '' || text.length > MAX_KEY_POINT_LENGTH) return null;
    if (normalized.has(text.replace(/\s+/g, ' '))) continue;
    added.push(text);
  }
  return added.length > 0 && added.length <= MAX_ADDED_KEY_POINTS ? added : null;
}

/**
 * D-8's sacred-text guard on the added points: the same check the TE runs on text a
 * model ADDED beside book text (`sacredAddedTextFindings`: an altered, reworded,
 * unbracketed, cut or explained verse or hadith), and — stricter — no quote at all,
 * because these are solution slides of checks and exercises, which never show a verse
 * or hadith item (owner rule, 4 Nov 2026).
 */
function sacredSafe(
  outline: SceneOutline,
  added: readonly string[],
  quotes: readonly SacredQuote[],
): boolean {
  if (added.some(hasSacredText)) return false;
  const shown = [outline.title ?? '', ...(outline.keyPoints ?? [])];
  return sacredAddedTextFindings(shown, added, quotes).length === 0;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface RoundOps {
  outlines: SceneOutline[];
  fixes: PlanFixDraft[];
  dropped: number;
  /** Of `dropped`: the `set keyPoints` ops whose own re-diagnosis did not confirm the step (D-8). */
  unconfirmed: number;
  /**
   * For the next round's prompt: op names, the server's reasons, and slide ids only when
   * they name a slide of the plan (a model-made id is never echoed back).
   */
  notes: string[];
}

/**
 * D-8: the re-diagnosis confirms the step is now written. The `set keyPoints` alone, on
 * the plan the round started from, must lower the `WORKING_STEP_MISSING` count.
 */
function keyPointsConfirmed(
  start: readonly SceneOutline[],
  open: readonly OutlineDiagnostic[],
  outlineId: string,
  added: readonly string[],
  context: PlanReviewContext,
): boolean {
  const index = start.findIndex((outline) => outline.id === outlineId);
  if (index < 0) return false;
  const alone = start.map((outline, i) =>
    i === index ? { ...outline, keyPoints: [...(outline.keyPoints ?? []), ...added] } : outline,
  );
  return (
    countOf(context.diagnose(alone).blocking, WORKING_STEP_MISSING) <
    countOf(open, WORKING_STEP_MISSING)
  );
}

/** Apply one round's ops, one by one, each guarded on the plan as the ops before it left it. */
function applyReviewOps(
  start: readonly SceneOutline[],
  rawOps: readonly unknown[],
  open: readonly OutlineDiagnostic[],
  context: PlanReviewContext,
  round: number,
  quotes: readonly SacredQuote[],
): RoundOps {
  const required = requiredUnitsOf(context);
  const book = context.editContext.bookStructure;
  let working = [...start];
  const fixes: PlanFixDraft[] = [];
  const notes: string[] = [];
  let dropped = Math.max(0, rawOps.length - MAX_REVIEW_OPS);
  let unconfirmed = 0;
  let removes = 0;
  const refuse = (note: string) => {
    dropped += 1;
    notes.push(note);
  };
  /** A slide id as a note may repeat it: only an id of the plan. */
  const slide = (id: string) =>
    start.some((outline) => outline.id === id) || working.some((outline) => outline.id === id)
      ? id
      : 'a slide id that is not in the plan';
  const draft = (entry: Omit<PlanFixDraft, 'actor' | 'round'>): PlanFixDraft => ({
    ...entry,
    actor: PLAN_REVIEWER_ACTOR,
    round,
  });

  for (const raw of rawOps.slice(0, MAX_REVIEW_OPS)) {
    const shaped = shapeOp(raw);
    if (!shaped) {
      refuse(
        'an op that is not set, remove, move or insert_book_slide, or whose shape is invalid, was dropped',
      );
      continue;
    }
    const outlineId = shaped.kind === 'keyPoints' ? shaped.outlineId : shaped.op.outlineId;
    const index = working.findIndex((outline) => outline.id === outlineId);

    if (shaped.kind === 'keyPoints') {
      if (context.allowKeyPoints === false) {
        refuse(
          `set keyPoints on ${slide(outlineId)} was dropped: no keyPoints op is accepted on this review`,
        );
        continue;
      }
      const outline = working[index];
      if (!outline || !keyPointSlideIds(working, open, book).has(outlineId)) {
        refuse(
          `set keyPoints on ${slide(outlineId)} was dropped: no open WORKING_STEP_MISSING is about this slide`,
        );
        continue;
      }
      const existing = [...(outline.keyPoints ?? [])];
      const added = addedKeyPoints(existing, shaped.added);
      if (!added) {
        refuse(
          `set keyPoints on ${outlineId} was dropped: the value must be the existing keyPoints copied exactly, then 1 to ${MAX_ADDED_KEY_POINTS} new points`,
        );
        continue;
      }
      if (!sacredSafe(outline, added, quotes)) {
        refuse(
          `set keyPoints on ${outlineId} was dropped: a new point holds or changes a Quran verse or hadith`,
        );
        continue;
      }
      if (!keyPointsConfirmed(start, open, outlineId, added, context)) {
        unconfirmed += 1;
        refuse(
          `set keyPoints on ${outlineId} was dropped: the re-diagnosis did not find the missing working step written`,
        );
        continue;
      }
      const keyPoints = [...existing, ...added];
      working = working.map((candidate, i) =>
        i === index ? { ...candidate, keyPoints } : candidate,
      );
      fixes.push(
        draft({
          op: 'set',
          outlineId,
          field: 'keyPoints',
          from: existing,
          to: [...keyPoints],
          reason: shaped.reason,
        }),
      );
      continue;
    }

    const { op } = shaped;
    const name =
      op.op === 'set' ? `set ${op.field} on ${slide(outlineId)}` : `${op.op} ${slide(outlineId)}`;
    if (op.op === 'remove') {
      if (removes >= PLAN_REVIEW_MAX_REMOVES) {
        refuse(`${name} was dropped: at most ${PLAN_REVIEW_MAX_REMOVES} removes per round`);
        continue;
      }
      if (deleteBacking(working, outlineId, open, context).length === 0) {
        refuse(`${name} was dropped: no open issue asks to delete this slide`);
        continue;
      }
    }
    if (
      op.op === 'set' &&
      op.field === 'visualPlan' &&
      op.value &&
      typeof op.value === 'object' &&
      typeof (op.value as { omissionReason?: unknown }).omissionReason === 'string' &&
      hasSacredText((op.value as { omissionReason: string }).omissionReason)
    ) {
      refuse(`${name} was dropped: its omissionReason holds a Quran verse or hadith`);
      continue;
    }

    let next: SceneOutline[];
    try {
      next = applyCorrectionOperations(working, [op], context.editContext);
    } catch {
      refuse(`${name} was refused by the correction rules`);
      continue;
    }
    // D-7 guard, for every op: a remove, or a `set` of type, slideType, contentRole or
    // sourceContentUnitIds, never leaves a required unit without a teaching slide.
    if (lostRequiredUnits(working, next, required).length > 0) {
      refuse(
        `${name} was dropped: it would leave a required book unit with no teaching slide (this is its last teaching slide)`,
      );
      continue;
    }

    if (op.op === 'remove') {
      removes += 1;
      fixes.push(
        draft({
          op: 'remove',
          outlineId,
          from: { index, outline: clone(working[index]!) },
          reason: shaped.reason,
        }),
      );
    } else if (op.op === 'move') {
      const to = next.findIndex((outline) => outline.id === outlineId);
      if (to === index) {
        refuse(`${name} changed nothing`);
        continue;
      }
      fixes.push(draft({ op: 'move', outlineId, from: index, to, reason: shaped.reason }));
    } else if (op.op === 'insert_book_slide') {
      const known = new Set(working.map((outline) => outline.id));
      const to = next.findIndex((outline) => !known.has(outline.id));
      if (to < 0) {
        refuse(`${name} added nothing`);
        continue;
      }
      fixes.push(
        draft({ op: 'insert_book_slide', outlineId: next[to]!.id, to, reason: shaped.reason }),
      );
    } else {
      const field = op.field;
      const from = (working[index] as unknown as Record<string, unknown>)[field];
      const to = (next[index] as unknown as Record<string, unknown>)[field];
      if (sameValue(from, to)) {
        refuse(`${name} changed nothing`);
        continue;
      }
      fixes.push(
        draft({
          op: 'set',
          outlineId,
          field,
          from: clone(from),
          to: clone(to),
          reason: shaped.reason,
        }),
      );
    }
    working = next;
  }
  return { outlines: working, fixes, dropped, unconfirmed, notes };
}

// ---------------------------------------------------------------------------
// The round accept
// ---------------------------------------------------------------------------

const countOf = (issues: readonly OutlineDiagnostic[], code: string) =>
  issues.filter((issue) => issue.code === code).length;

/** A finding code that was not open before, or more `BOOK_COVERAGE_INCOMPLETE`. */
function worsened(before: readonly OutlineDiagnostic[], after: readonly OutlineDiagnostic[]) {
  const reasons: string[] = [];
  const known = new Set(before.map((issue) => issue.code));
  const added = [...new Set(after.map((issue) => issue.code).filter((code) => !known.has(code)))];
  if (added.length > 0) reasons.push(`new issue codes: ${added.join(', ')}`);
  if (countOf(after, BOOK_COVERAGE_INCOMPLETE) > countOf(before, BOOK_COVERAGE_INCOMPLETE)) {
    reasons.push(`${BOOK_COVERAGE_INCOMPLETE} rose`);
  }
  return reasons;
}

/** Why a round's candidate is not better than `before` (empty: keep it). */
function rejection(
  before: readonly OutlineDiagnostic[],
  after: readonly OutlineDiagnostic[],
): string[] {
  const reasons: string[] = [];
  if (after.length >= before.length) {
    reasons.push(`open issues did not drop (${before.length} → ${after.length})`);
  }
  return [...reasons, ...worsened(before, after)];
}

/**
 * Re-diagnose a round's candidate. When it shows an order issue (an op fixed a stage
 * and uncovered it, or made the old one fixable), the free rule fixes run on it first
 * and their moves become this round's.
 */
function diagnoseRound(
  candidate: SceneOutline[],
  fixes: readonly PlanFixDraft[],
  context: PlanReviewContext,
  round: number,
): { outlines: SceneOutline[]; blocking: OutlineDiagnostic[]; fixes: PlanFixDraft[] } {
  const diagnosed = context.diagnose(candidate);
  if (!diagnosed.blocking.some((issue) => issue.code === FLOW_SEQUENCE_INVALID)) {
    return { ...diagnosed, fixes: withDiagnosedValues(fixes, diagnosed.outlines) };
  }
  const auto = applyPlanAutoFixes(diagnosed.outlines, diagnosed.blocking, {
    flow: context.flow,
    diagnose: context.diagnose,
  });
  // No rule fix: keep the diagnosed list itself (the caller keys its repairs on it).
  if (auto.fixes.length === 0) {
    return { ...diagnosed, fixes: withDiagnosedValues(fixes, diagnosed.outlines) };
  }
  return {
    outlines: auto.outlines,
    blocking: auto.blocking,
    fixes: [
      ...withDiagnosedValues(fixes, auto.outlines),
      ...auto.fixes.map((fix) => ({ ...fix, round })),
    ],
  };
}

/**
 * Each `set` fix's `to` as the kept plan holds it: the diagnosis may normalise a field
 * an op set (slide semantics, structural roles, grounded visuals), and the P3 undo only
 * restores a value still equal to `to`, so `to` must be the stored value (P3 review).
 */
function withDiagnosedValues(
  fixes: readonly PlanFixDraft[],
  outlines: readonly SceneOutline[],
): PlanFixDraft[] {
  // Only the LAST set of a slide's field takes the diagnosed value: an earlier set of
  // the same field keeps the value it wrote, so its undo is refused (follow-up review).
  const last = new Map<string, number>();
  fixes.forEach((fix, index) => {
    if (fix.op === 'set' && fix.field) last.set(`${fix.outlineId}\u0000${fix.field}`, index);
  });
  return fixes.map((fix, index) => {
    if (fix.op !== 'set' || !fix.field) return fix;
    if (last.get(`${fix.outlineId}\u0000${fix.field}`) !== index) return fix;
    const outline = outlines.find((entry) => entry.id === fix.outlineId);
    if (!outline) return fix;
    return { ...fix, to: (outline as unknown as Record<string, unknown>)[fix.field] };
  });
}

// ---------------------------------------------------------------------------
// Step 7: the POSITION_CARDINALITY fallback
// ---------------------------------------------------------------------------

/**
 * Remove the extras of every stage that still holds too many slides, keeping its first
 * one. A stage is cleared whole or not at all: when one of its extras cannot go (it is
 * the last teaching slide of a required unit, or the correction rules refuse it), the
 * stage keeps every slide. `stages` are the flow positions it cleared.
 */
function cardinalityFallback(
  start: readonly SceneOutline[],
  open: readonly OutlineDiagnostic[],
  context: PlanReviewContext,
  round: number,
): { outlines: SceneOutline[]; fixes: PlanFixDraft[]; stages: number[] } | null {
  const required = requiredUnitsOf(context);
  const candidates = [
    ...new Set(
      open
        .filter((issue) => issue.code === POSITION_CARDINALITY && issue.flowIndex !== undefined)
        .map((issue) => issue.flowIndex!),
    ),
  ];
  let working = [...start];
  const fixes: PlanFixDraft[] = [];
  const stages: number[] = [];
  for (const flowIndex of candidates) {
    // Too few is a person's to fix: there is no generic insert.
    const extras = stageSlides(working, flowIndex, context.flow).slice(1);
    if (extras.length === 0) continue;
    let staged = working;
    const stageFixes: PlanFixDraft[] = [];
    for (const extra of extras) {
      const index = staged.findIndex((outline) => outline.id === extra.id);
      let next: SceneOutline[];
      try {
        next = applyCorrectionOperations(
          staged,
          [{ op: 'remove', outlineId: extra.id }],
          context.editContext,
        );
      } catch {
        break;
      }
      if (lostRequiredUnits(staged, next, required).length > 0) break;
      stageFixes.push({
        op: 'remove',
        outlineId: extra.id,
        from: { index, outline: clone(extra) },
        reason: CARDINALITY_FALLBACK_REASON,
        actor: PLAN_REVIEWER_ACTOR,
        round,
      });
      staged = next;
    }
    if (stageFixes.length !== extras.length) continue;
    working = staged;
    fixes.push(...stageFixes);
    stages.push(flowIndex);
  }
  return fixes.length > 0 ? { outlines: working, fixes, stages } : null;
}

/** Why the fallback is not kept (empty: keep it): it must clear the stages it targeted. */
function fallbackRejection(
  before: readonly OutlineDiagnostic[],
  after: readonly OutlineDiagnostic[],
  stages: readonly number[],
): string[] {
  const reasons: string[] = [];
  const stillFull = stages.filter((flowIndex) =>
    after.some((issue) => issue.code === POSITION_CARDINALITY && issue.flowIndex === flowIndex),
  );
  if (stillFull.length > 0) {
    reasons.push(`${POSITION_CARDINALITY} still open at flowIndex ${stillFull.join(', ')}`);
  }
  // Clearing a stage must lower the open count: an equal count means another issue of
  // a kind already open took its place (follow-up review, 22 Nov 2026).
  if (after.length >= before.length) {
    reasons.push(`open issues did not drop (${before.length} → ${after.length})`);
  }
  return [...reasons, ...worsened(before, after)];
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/**
 * Review a plan that is still blocking after the free rule fixes and the book repair.
 * Returns the input unchanged (copies, `fixes: []`, no call) when nothing is open or
 * the slide ids are not unique. Makes no call when no open issue is one an op can fix
 * (the step 7 fallback still runs). Never throws for a failed call: see `endedOnError`.
 */
export async function reviewPlan(
  outlines: readonly SceneOutline[],
  blocking: readonly OutlineDiagnostic[],
  aiCall: AICallFn,
  context: PlanReviewContext,
): Promise<PlanReviewResult> {
  let current: SceneOutline[] = [...outlines];
  let open: OutlineDiagnostic[] = [...blocking];
  const fixes: PlanFixDraft[] = [];
  let rounds = 0;
  let acceptedRounds = 0;
  let endedOnError = false;
  const result = (): PlanReviewResult => ({
    outlines: current,
    blocking: open,
    fixes,
    rounds,
    acceptedRounds,
    endedOnError,
  });
  if (open.length === 0) return result();
  // A fix is recorded, applied and undone by slide id: a plan without unique ids is left as it is.
  const ids = outlines.map((outline) => outline.id);
  if (ids.some((id) => typeof id !== 'string' || id === '') || new Set(ids).size !== ids.length) {
    log.warn('plan review: the plan has missing or repeated slide ids; not reviewed');
    return result();
  }

  const quotes =
    context.sacredQuotes ??
    context.units.flatMap((unit) => detectSacredQuotes({ id: unit.id, normalizedText: unit.text }));
  const system = buildPlanReviewSystemPrompt(context.sacredMode ?? 'full');
  let feedback: string[] = [];

  for (let round = 1; round <= PLAN_REVIEW_ROUNDS && open.length > 0; round += 1) {
    if (
      !open.some((issue) =>
        modelCanFix(issue, current, context.flow, context.allowKeyPoints !== false),
      )
    ) {
      log.info(`plan review: no open issue an op can fix (${open.length} open); no model call`);
      break;
    }
    rounds = round;
    const user = buildPlanReviewUserPrompt({
      outlines: current,
      blocking: open,
      flow: context.flow,
      units: context.units,
      bookSummary: context.bookSummary,
      language: context.language,
      languageDirective: context.languageDirective,
      round,
      rounds: PLAN_REVIEW_ROUNDS,
      targets: reviewTargets(current, open, context),
      feedback,
      ...(context.unitTextCaps ? { unitTextCaps: context.unitTextCaps } : {}),
    });
    let answer: string;
    try {
      answer = await aiCall(system, user);
    } catch {
      // The route is the caller's to check (`assertRouteAvailable` fails a routed run
      // right after the review, so its fallback is never used). A run without a route
      // still gets the free fallback below (follow-up review, 22 Nov 2026).
      log.warn(`plan review: round ${round} call failed; review ended`);
      endedOnError = true;
      break;
    }
    const rawOps = readPlanReviewOps(answer);
    if (!rawOps) {
      log.warn(`plan review: round ${round} answer could not be read; review ended`);
      break;
    }
    if (rawOps.length === 0) {
      log.info(`plan review: round ${round} proposed no op; review ended`);
      break;
    }
    const applied = applyReviewOps(current, rawOps, open, context, round, quotes);
    if (applied.dropped > 0) {
      log.info(`plan review: round ${round} dropped ${applied.dropped} of ${rawOps.length} op(s)`);
    }
    if (applied.unconfirmed > 0) {
      log.info(
        `plan review: round ${round} dropped ${applied.unconfirmed} keyPoints op(s) the re-diagnosis did not confirm`,
      );
    }
    if (applied.fixes.length === 0) {
      log.info(`plan review: round ${round} applied no op`);
      feedback = applied.notes;
      continue;
    }
    const diagnosed = diagnoseRound(applied.outlines, applied.fixes, context, round);
    const reasons = rejection(open, diagnosed.blocking);
    if (reasons.length > 0) {
      log.info(
        `plan review: round ${round} rolled back (${applied.fixes.length} fix(es); ${reasons.join('; ')})`,
      );
      feedback = [...applied.notes, `the whole round was undone: ${reasons.join('; ')}`];
      continue;
    }
    current = diagnosed.outlines;
    open = diagnosed.blocking;
    fixes.push(...diagnosed.fixes);
    acceptedRounds += 1;
    feedback = applied.notes;
    log.info(
      `plan review: round ${round} kept ${diagnosed.fixes.length} fix(es), ${open.length} issue(s) open`,
    );
  }

  // Step 7: part of the last round that ran (round 2 when two ran).
  const fallback = cardinalityFallback(current, open, context, Math.max(rounds, 1));
  if (fallback) {
    const diagnosed = context.diagnose(fallback.outlines);
    const reasons = fallbackRejection(open, diagnosed.blocking, fallback.stages);
    if (reasons.length > 0) {
      log.info(
        `plan review: cardinality fallback rolled back (${fallback.fixes.length} removal(s); ${reasons.join('; ')})`,
      );
    } else {
      current = diagnosed.outlines;
      open = diagnosed.blocking;
      fixes.push(...fallback.fixes);
      log.info(
        `plan review: cardinality fallback kept ${fallback.fixes.length} removal(s), ${open.length} issue(s) open`,
      );
    }
  }
  return result();
}
