/**
 * The record of every automatic change the plan review makes to a plan before
 * any person sees it (package-planner-issue-resolve-plan-2026-11-22 §3b, owner
 * 22 Nov 2026; implementation prompt P1 item 3): what changed, why, and the
 * before-state an undo needs.
 *
 * - The free rule fixes (`plan-auto-fixes.ts`) return their own entries.
 * - The book repair (`repairBookCoverageGaps`) changes the plan as a whole, so
 *   its changes are read here as a difference between the plan before and after
 *   it: an added slide, a removed slide, and each changed field of a kept slide.
 *
 * The records live on the attempt snapshot (`planReview.fixes`, the current
 * run only, capped) and, when the attempt pauses, on the checkpoint's pause
 * entry (`planFixes`). Nothing here logs lesson text.
 */
import { randomUUID } from 'node:crypto';

import type { SceneOutline } from '@/lib/types/generation';
import type { PlanReviewFix } from '@/lib/types/teaching-package';

export const PLAN_REVIEWER_ACTOR = 'system:plan-reviewer' as const;

/** The most fixes one attempt snapshot keeps (prompt P1 item 3). */
export const MAX_PLAN_FIXES = 200;

/** A fix before it is recorded: no id, run or time yet. */
export type PlanFixDraft = Omit<PlanReviewFix, 'id' | 'generationRun' | 'at'>;

const BOOK_REPAIR_REASON = {
  insert: 'إضافة شريحة لجزء من الكتاب كان ناقص في الخطة',
  remove: 'حذف شريحة بتكرر جزء من الكتاب اتشرح قبل كده',
  move: 'نقل الشريحة لمكانها حسب ترتيب الكتاب',
  set: 'تعديل الشريحة علشان تغطي الكتاب من غير تكرار',
} as const;

/** Indexes into `sequence` of one longest strictly increasing run (the slides that kept their order). */
function longestIncreasingRun(sequence: readonly number[]): Set<number> {
  const length = sequence.map(() => 1);
  const previous = sequence.map(() => -1);
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (sequence[j]! < sequence[i]! && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1;
        previous[i] = j;
      }
    }
  }
  let end = -1;
  for (let i = 0; i < sequence.length; i += 1) {
    if (end === -1 || length[i]! > length[end]!) end = i;
  }
  const kept = new Set<number>();
  for (let i = end; i !== -1; i = previous[i]!) kept.add(i);
  return kept;
}

/** `order` is renumbered by every diagnosis, so it is never a change of its own. */
const IGNORED_FIELDS: ReadonlySet<string> = new Set(['order']);

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The book repair's changes as fix drafts (round 0), as steps that replay the
 * repair from the old plan to the new one. Every index is the slide's index in
 * the plan as it stands at that step, so an undo walked backwards (last entry
 * first) restores the old plan exactly:
 * 1. every outline it removed, highest old index first (kept in full with its
 *    index, so the backward walk re-inserts them lowest index first);
 * 2. every kept outline whose place among the kept ones changed (e.g. the g5.v8
 *    recall moved first), as a `move` within the kept slides; a slide that only
 *    shifted because others were added or removed is not a move;
 * 3. every outline it added, lowest new index first, at its new index;
 * 4. every top-level field of a kept outline whose value changed.
 */
export function bookRepairFixes(
  before: readonly SceneOutline[],
  after: readonly SceneOutline[],
): PlanFixDraft[] {
  const fixes: PlanFixDraft[] = [];
  const beforeById = new Map(before.map((outline, index) => [outline.id, { outline, index }]));
  const afterIds = new Set(after.map((outline) => outline.id));
  const removed = before
    .map((outline, index) => ({ outline, index }))
    .filter(({ outline }) => !afterIds.has(outline.id))
    .sort((a, b) => b.index - a.index);
  for (const { outline, index } of removed) {
    fixes.push({
      op: 'remove',
      outlineId: outline.id,
      from: { index, outline },
      reason: BOOK_REPAIR_REASON.remove,
      actor: PLAN_REVIEWER_ACTOR,
      round: 0,
    });
  }

  // The kept slides: in their old order (the plan once the removes are done) and
  // in their new order (the plan before the inserts). Those outside one longest
  // run already in order moved. Each is placed, in new-order sequence, right after
  // the slide that precedes it in the new order; that slide is already in its final
  // place among the slides placed so far, so the list ends in the new order.
  const current = before.filter((outline) => afterIds.has(outline.id)).map((o) => o.id);
  const target = after.filter((outline) => beforeById.has(outline.id)).map((o) => o.id);
  const oldIndexOf = new Map(current.map((id, index) => [id, index] as const));
  const inOrder = longestIncreasingRun(target.map((id) => oldIndexOf.get(id)!));
  target.forEach((id, position) => {
    if (inOrder.has(position)) return;
    const from = current.indexOf(id);
    current.splice(from, 1);
    const predecessor = position === 0 ? null : target[position - 1]!;
    const to = predecessor === null ? 0 : current.indexOf(predecessor) + 1;
    current.splice(to, 0, id);
    fixes.push({
      op: 'move',
      outlineId: id,
      from,
      to,
      reason: BOOK_REPAIR_REASON.move,
      actor: PLAN_REVIEWER_ACTOR,
      round: 0,
    });
  });

  after.forEach((outline, index) => {
    if (beforeById.has(outline.id)) return;
    fixes.push({
      op: 'insert_book_slide',
      outlineId: outline.id,
      to: index,
      reason: BOOK_REPAIR_REASON.insert,
      actor: PLAN_REVIEWER_ACTOR,
      round: 0,
    });
  });
  after.forEach((outline) => {
    const previous = beforeById.get(outline.id);
    if (!previous) return;
    const fields = new Set([...Object.keys(previous.outline), ...Object.keys(outline)]);
    for (const field of fields) {
      if (IGNORED_FIELDS.has(field)) continue;
      const from = (previous.outline as unknown as Record<string, unknown>)[field];
      const to = (outline as unknown as Record<string, unknown>)[field];
      if (sameValue(from, to)) continue;
      fixes.push({
        op: 'set',
        outlineId: outline.id,
        field,
        from,
        to,
        reason: BOOK_REPAIR_REASON.set,
        actor: PLAN_REVIEWER_ACTOR,
        round: 0,
      });
    }
  });
  return fixes;
}

/** Stamp drafts as records of `generationRun`, at `at`. */
export function recordedPlanFixes(
  drafts: readonly PlanFixDraft[],
  generationRun: number,
  at: number = Date.now(),
): PlanReviewFix[] {
  return drafts.map((draft) => ({
    id: `tpf-${randomUUID()}`,
    ...draft,
    generationRun,
    at,
  }));
}

/**
 * The snapshot's `planReview` after `fixes` of `generationRun`: a fix of an
 * earlier run (a discarded plan) is dropped, the newest `MAX_PLAN_FIXES` kept.
 */
export function withPlanFixes(
  existing: { fixes?: readonly PlanReviewFix[] } | undefined,
  fixes: readonly PlanReviewFix[],
  generationRun: number,
): { fixes: PlanReviewFix[] } {
  const kept = (existing?.fixes ?? []).filter((fix) => fix.generationRun === generationRun);
  return { fixes: [...kept, ...fixes].slice(-MAX_PLAN_FIXES) };
}

/**
 * A fix as a browser or the backend may see it: never its values (`from`, the
 * undo state, a whole removed slide included; `to`, which for a book-repair
 * `set` is the slide's new text). The op, the slide, the field and the reason say
 * what happened; the values stay on the server for an undo.
 */
export function withoutUndoState(fix: PlanReviewFix): Omit<PlanReviewFix, 'from' | 'to'> {
  const { from: _undoState, to: _newValue, ...visible } = fix;
  return visible;
}

// ---------------------------------------------------------------------------
// P3 (package-plan-review-p3-contract-2026-11-22): what a person sees of the
// fixes on a paused attempt, the automatic review of an attempt paused before
// the plan review existed, and the undo of one fix.
// ---------------------------------------------------------------------------

/** A `review_plan` still running after this long died with its process; it may run again. */
export const PLAN_REVIEW_STALE_MS = 15 * 60_000;

/** The minimal edit-log entry shape these readers need. */
interface PlanReviewLogEntry {
  event: string;
  at: number;
  planFixes?: readonly PlanReviewFix[];
  planReviewed?: boolean;
  planReview?: 'started' | 'finished';
  operations?: readonly unknown[];
}

export type PlanReviewStatus = 'not_reviewed' | 'reviewing' | 'reviewed';

/**
 * Whether the plan review has seen this paused plan: a pause by a runner with the
 * review (`planReviewed`) or a finished `review_plan` makes it `reviewed`; a started
 * one, younger than {@link PLAN_REVIEW_STALE_MS}, `reviewing`; anything else (a
 * checkpoint paused before the review existed) `not_reviewed`.
 */
export function planReviewStatusOf(
  editLog: readonly PlanReviewLogEntry[],
  now: number = Date.now(),
): PlanReviewStatus {
  let status: PlanReviewStatus = 'not_reviewed';
  for (const entry of editLog) {
    if (entry.planReviewed === true || entry.planReview === 'finished') status = 'reviewed';
    else if (entry.planReview === 'started' && status !== 'reviewed') {
      status = now - entry.at < PLAN_REVIEW_STALE_MS ? 'reviewing' : 'not_reviewed';
    }
  }
  return status;
}

/** Every fix recorded on a checkpoint's edit log, in order. */
export function planFixesOf(editLog: readonly PlanReviewLogEntry[]): PlanReviewFix[] {
  return editLog.flatMap((entry) => [...(entry.planFixes ?? [])]);
}

/** The fix ids a person undid (`revert_fix` operations in the edit log). */
export function revertedFixIds(editLog: readonly PlanReviewLogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of editLog) {
    for (const op of entry.operations ?? []) {
      const record = op && typeof op === 'object' ? (op as Record<string, unknown>) : null;
      if (record?.op === 'revert_fix' && typeof record.fixId === 'string') ids.add(record.fixId);
    }
  }
  return ids;
}

/** The correction view's list: each fix without its values, and whether it was undone. */
export function autoFixesOf(editLog: readonly PlanReviewLogEntry[]): Array<{
  id: string;
  op: PlanReviewFix['op'];
  outlineId: string;
  field?: string;
  reason: string;
  round: number;
  at: number;
  reverted: boolean;
}> {
  const reverted = revertedFixIds(editLog);
  return planFixesOf(editLog).map((fix) => ({
    id: fix.id,
    op: fix.op,
    outlineId: fix.outlineId,
    ...(fix.field !== undefined ? { field: fix.field } : {}),
    reason: fix.reason,
    round: fix.round,
    at: fix.at,
    reverted: reverted.has(fix.id),
  }));
}

function clamp(index: unknown, length: number): number {
  const value = typeof index === 'number' && Number.isInteger(index) ? index : length;
  return Math.max(0, Math.min(value, length));
}

/**
 * The plan with one fix undone (P3 «تراجع»): a `set` gets its old value back (an
 * absent one is removed), a `move` goes back to its old index, a removed slide is
 * re-inserted at its old index (clamped), and an added slide is removed. Returns
 * `null` when the plan no longer holds what the undo needs (the slide is gone, or a
 * removed slide is back already). Never mutates its input.
 */
export function revertPlanFix(
  outlines: readonly SceneOutline[],
  fix: Pick<PlanReviewFix, 'op' | 'outlineId' | 'field' | 'from'>,
): SceneOutline[] | null {
  const next = outlines.map((outline) => ({ ...outline }));
  const at = next.findIndex((outline) => outline.id === fix.outlineId);
  if (fix.op === 'remove') {
    const removed = (fix.from as { index?: unknown; outline?: SceneOutline } | undefined)?.outline;
    if (at !== -1 || !removed || typeof removed !== 'object') return null;
    next.splice(
      clamp((fix.from as { index?: unknown }).index, next.length),
      0,
      structuredClone(removed),
    );
    return next;
  }
  if (at === -1) return null;
  if (fix.op === 'insert_book_slide') {
    next.splice(at, 1);
    return next;
  }
  if (fix.op === 'move') {
    const [moved] = next.splice(at, 1);
    next.splice(clamp(fix.from, next.length), 0, moved!);
    return next;
  }
  if (!fix.field) return null;
  const outline = next[at] as unknown as Record<string, unknown>;
  if (fix.from === undefined) delete outline[fix.field];
  else outline[fix.field] = structuredClone(fix.from);
  return next;
}
